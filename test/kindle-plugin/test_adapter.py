from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import socket
import sys
from contextlib import contextmanager
from pathlib import Path

import pytest

pytest.importorskip("aiohttp")
from aiohttp import ClientSession, web
from aiohttp.test_utils import TestClient, TestServer

from agent.secret_scope import (
    reset_secret_scope,
    set_multiplex_active,
    set_secret_scope,
)
from gateway.config import Platform, PlatformConfig
from gateway.platform_registry import PlatformEntry, platform_registry

PLUGIN_DIR = Path(__file__).resolve().parents[2] / "kindle-plugin"
SPEC = importlib.util.spec_from_file_location(
    "kindle_scribe",
    PLUGIN_DIR / "__init__.py",
    submodule_search_locations=[str(PLUGIN_DIR)],
)
assert SPEC is not None and SPEC.loader is not None
PLUGIN_MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = PLUGIN_MODULE
SPEC.loader.exec_module(PLUGIN_MODULE)

from kindle_scribe import adapter as adapter_module  # noqa: E402
from kindle_scribe.adapter import (  # noqa: E402
    KindleAdapter,
    KindleConfigurationError,
)


PROFILE_ENV_NAMES = {
    "KINDLE_INGEST_HOST",
    "KINDLE_INGEST_PORT",
    "KINDLE_INGEST_TOKEN",
    "KINDLE_INSECURE",
    "KINDLE_REPLY_TIMEOUT",
    "KINDLE_USER",
}


class _RegistryContext:
    """Exercise the same public registry seam used by plugin discovery."""

    def register_platform(self, **kwargs) -> None:
        platform_registry.register(
            PlatformEntry(
                source="plugin",
                plugin_name="kindle-scribe-test",
                **kwargs,
            )
        )


@pytest.fixture(autouse=True)
def _reset_profile_runtime() -> None:
    existing_entry = platform_registry.get("kindle")
    cached_member = Platform._value2member_map_.get("kindle")
    cached_named_member = Platform._member_map_.get("KINDLE")
    adapter_module.register(_RegistryContext())
    scope_token = set_secret_scope(None)
    set_multiplex_active(False)
    with adapter_module._LISTENER_OWNERS_LOCK:
        adapter_module._LISTENER_OWNERS.clear()
    try:
        yield
    finally:
        with adapter_module._LISTENER_OWNERS_LOCK:
            adapter_module._LISTENER_OWNERS.clear()
        set_multiplex_active(False)
        reset_secret_scope(scope_token)
        platform_registry.unregister("kindle")
        if existing_entry is not None:
            platform_registry.register(existing_entry)
        if cached_member is None:
            Platform._value2member_map_.pop("kindle", None)
        else:
            Platform._value2member_map_["kindle"] = cached_member
        if cached_named_member is None:
            Platform._member_map_.pop("KINDLE", None)
        else:
            Platform._member_map_["KINDLE"] = cached_named_member


@contextmanager
def _profile_secret_scope(secrets: dict[str, str], *, multiplex: bool = True):
    set_multiplex_active(multiplex)
    token = set_secret_scope(secrets)
    try:
        yield secrets
    finally:
        reset_secret_scope(token)
        set_multiplex_active(False)


def _set_profile(
    monkeypatch: pytest.MonkeyPatch,
    home: Path,
    name: str = "default",
) -> None:
    import hermes_cli.profiles
    import hermes_constants

    home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(hermes_cli.profiles, "get_active_profile_name", lambda: name)
    monkeypatch.setattr(hermes_constants, "get_hermes_home", lambda: home)


def _set_env(monkeypatch: pytest.MonkeyPatch, **values: str | None) -> None:
    for name in PROFILE_ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    defaults: dict[str, str | None] = {
        "KINDLE_INGEST_TOKEN": "test-token",
        "KINDLE_REPLY_TIMEOUT": "1",
        "KINDLE_INSECURE": None,
        "KINDLE_USER": "kindle",
    }
    defaults.update(values)
    for name, value in defaults.items():
        if value is not None:
            monkeypatch.setenv(name, value)


def _write_profile_env(home: Path, secrets: dict[str, str]) -> Path:
    env_path = home / ".env"
    env_path.write_text(
        "".join(f"{name}={value}\n" for name, value in sorted(secrets.items())),
        encoding="utf-8",
    )
    return env_path


def _replace_profile_env(home: Path, secrets: dict[str, str]) -> None:
    replacement = home / ".env.next"
    replacement.write_text(
        "".join(f"{name}={value}\n" for name, value in sorted(secrets.items())),
        encoding="utf-8",
    )
    replacement.replace(home / ".env")


def _adapter(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    *,
    profile: str = "default",
    timeout: float = 1.0,
    user: str = "kindle",
) -> KindleAdapter:
    _set_profile(monkeypatch, tmp_path / profile, profile)
    _set_env(
        monkeypatch,
        KINDLE_INGEST_TOKEN="test-token",
        KINDLE_REPLY_TIMEOUT=str(timeout),
        KINDLE_USER=user,
    )
    return KindleAdapter(PlatformConfig(enabled=True, token="", extra={}))


def _scoped_adapter(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    *,
    profile: str,
    secrets: dict[str, str],
) -> KindleAdapter:
    profile_home = tmp_path / profile
    _set_profile(monkeypatch, profile_home, profile)
    _write_profile_env(profile_home, secrets)
    with _profile_secret_scope(secrets):
        return KindleAdapter(PlatformConfig(enabled=True, token="", extra={}))


def _client(adapter: KindleAdapter) -> TestClient:
    app = web.Application(client_max_size=adapter_module.MAX_REQUEST_BYTES)
    app.router.add_post("/ingest", adapter._handle_ingest)
    app.router.add_get("/health", adapter._handle_health)
    return TestClient(TestServer(app))


def _headers(token: str = "test-token") -> dict[str, str]:
    return {"X-Kindle-Token": token}


def _ingest_headers(
    adapter: KindleAdapter,
    token: str | None = "test-token",
    owner: str | None = None,
) -> dict[str, str]:
    headers = {"X-Kindle-Owner": owner or adapter._owner_fingerprint}
    if token is not None:
        headers["X-Kindle-Token"] = token
    return headers


def _payload(chat_id: str = "scribe-1", text: str = "hello") -> dict[str, str]:
    return {"chat_id": chat_id, "user": "caller-controlled", "text": text}


async def _wait_for_pending(adapter: KindleAdapter, raw_chat_id: str) -> str:
    chat_id = adapter._namespace(raw_chat_id)
    for _ in range(100):
        if chat_id in adapter._pending:
            return chat_id
        await asyncio.sleep(0)
    raise AssertionError(f"waiter for {chat_id!r} was not registered")


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def test_owner_fingerprint_matches_shared_node_utf8_fixture() -> None:
    fixture_path = (
        Path(__file__).resolve().parents[1]
        / "fixtures"
        / "kindle-owner-fingerprint.json"
    )
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    values = fixture["input"]
    settings = adapter_module._AdapterSettings(
        profile_name=values["profile_name"],
        profile_home=Path(values["profile_home"]),
        host=values["host"],
        port=values["port"],
        token=values["token"],
        insecure=values["insecure"],
        user_id=values["user_id"],
        reply_timeout_ms=values["reply_timeout_ms"],
    )

    assert settings.owner_payload == fixture["canonical_payload"]
    assert settings.owner_canonical_json == fixture["canonical_json"]
    assert "hermès/配置" in settings.owner_canonical_json
    assert settings.owner_fingerprint == fixture["expected_sha256"]


def test_plugin_registration_enables_dynamic_platform_member() -> None:
    entry = platform_registry.get("kindle")
    assert entry is not None
    assert entry.adapter_factory is adapter_module._build_adapter
    assert Platform("kindle").value == "kindle"


@pytest.mark.parametrize(
    ("raw", "expected_ms"),
    [
        ("0.01", 10),
        ("1.001", 1001),
        ("240.0", 240000),
        ("300", 300000),
    ],
)
def test_timeout_plain_decimal_parser_matches_bridge(
    raw: str,
    expected_ms: int,
) -> None:
    assert adapter_module._parse_timeout_ms(raw) == expected_ms


@pytest.mark.parametrize("raw", ["1e2", "+1", ".5", "01", "1.0000"])
def test_timeout_plain_decimal_parser_rejects_noncanonical_values(raw: str) -> None:
    with pytest.raises(KindleConfigurationError):
        adapter_module._parse_timeout_ms(raw)


def test_ingest_rejects_invalid_token(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    async def case() -> None:
        adapter = _adapter(monkeypatch, tmp_path)
        async with _client(adapter) as client:
            response = await client.post("/ingest", json=_payload())
            body = await response.json()
        assert response.status == 401
        assert body == {"error": "unauthorized"}
        assert adapter._pending == {}

    asyncio.run(case())


def test_ingest_requires_bounded_owner_attestation_before_dispatch(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    async def case() -> None:
        adapter = _adapter(monkeypatch, tmp_path)
        dispatched = []

        async def accept(event) -> None:
            dispatched.append(event)

        monkeypatch.setattr(adapter, "handle_message", accept)
        async with _client(adapter) as client:
            for headers in (
                _headers(),
                _ingest_headers(adapter, owner="0" * 64),
                _ingest_headers(adapter, owner="a" * 65),
            ):
                response = await client.post(
                    "/ingest",
                    json=_payload(),
                    headers=headers,
                )
                assert response.status == 409
                assert await response.json() == {"error": "request rejected"}

        assert dispatched == []

    asyncio.run(case())


def test_final_notify_delivers_reply_not_preview(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    async def case() -> None:
        adapter = _adapter(monkeypatch, tmp_path)

        async def accept(_event) -> None:
            return None

        monkeypatch.setattr(adapter, "handle_message", accept)
        async with _client(adapter) as client:
            request = asyncio.create_task(
                client.post(
                    "/ingest",
                    json=_payload(),
                    headers=_ingest_headers(adapter),
                )
            )
            chat_id = await _wait_for_pending(adapter, "scribe-1")

            preview = await adapter.send(
                chat_id, "working", metadata={"notify": False}
            )
            await asyncio.sleep(0)
            assert preview.success is False
            assert preview.message_id is None
            assert preview.error == "streaming preview not supported"
            assert request.done() is False

            delivered = await adapter.send(
                chat_id, "finished", metadata={"notify": True}
            )
            response = await request
            body = await response.json()

        assert delivered.success is True
        assert response.status == 200
        assert body == {"reply": "finished"}
        assert adapter._pending == {}

    asyncio.run(case())


def test_timeout_removes_waiter_and_dispatch_task(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    async def case() -> None:
        adapter = _adapter(monkeypatch, tmp_path, timeout=0.01)

        async def accept(_event) -> None:
            await asyncio.Event().wait()

        monkeypatch.setattr(adapter, "handle_message", accept)
        async with _client(adapter) as client:
            response = await client.post(
                "/ingest", json=_payload(), headers=_ingest_headers(adapter)
            )
            body = await response.json()

        assert response.status == 504
        assert body == {"error": "agent timed out"}
        assert adapter._pending == {}
        assert adapter._pending_tasks == {}

    asyncio.run(case())


def test_disconnect_cancels_request_and_releases_pending_state(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    async def case() -> None:
        adapter = _adapter(monkeypatch, tmp_path)

        async def accept(_event) -> None:
            await asyncio.Event().wait()

        monkeypatch.setattr(adapter, "handle_message", accept)
        async with _client(adapter) as client:
            request = asyncio.create_task(
                client.post(
                    "/ingest",
                    json=_payload(),
                    headers=_ingest_headers(adapter),
                )
            )
            await _wait_for_pending(adapter, "scribe-1")
            await adapter.disconnect()
            response = await request
            body = await response.json()

        assert response.status == 503
        assert body == {"error": "cancelled"}
        assert adapter._pending == {}
        assert adapter._pending_tasks == {}

    asyncio.run(case())


def test_overlapping_same_chat_request_is_rejected_without_stealing_waiter(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    async def case() -> None:
        adapter = _adapter(monkeypatch, tmp_path)
        dispatched: list[str] = []

        async def accept(event) -> None:
            dispatched.append(event.text)

        monkeypatch.setattr(adapter, "handle_message", accept)
        async with _client(adapter) as client:
            first = asyncio.create_task(
                client.post(
                    "/ingest",
                    json=_payload(text="turn A"),
                    headers=_ingest_headers(adapter),
                )
            )
            chat_id = await _wait_for_pending(adapter, "scribe-1")

            second = await client.post(
                "/ingest",
                json=_payload(text="turn B"),
                headers=_ingest_headers(adapter),
            )
            assert second.status == 409
            assert await second.json() == {
                "error": "a request for this chat is already in progress"
            }

            sent = await adapter.send(
                chat_id, "reply A", metadata={"notify": True}
            )
            first_response = await first
            first_body = await first_response.json()

        assert sent.success is True
        assert first_response.status == 200
        assert first_body == {"reply": "reply A"}
        assert dispatched == ["turn A"]
        assert adapter._pending == {}

    asyncio.run(case())


def test_profile_scope_wins_over_primary_process_environment(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    profile_home = tmp_path / "finance"
    _set_profile(monkeypatch, profile_home, "finance")
    _set_env(monkeypatch, KINDLE_INGEST_TOKEN="primary-A")
    scoped = {
        "KINDLE_INGEST_TOKEN": "scoped-B",
        "KINDLE_INSECURE": "false",
        "KINDLE_USER": "finance-scribe",
    }
    _write_profile_env(profile_home, scoped)
    with _profile_secret_scope(scoped):
        assert adapter_module._is_connected(PlatformConfig(enabled=True)) is True
        adapter = KindleAdapter(PlatformConfig(enabled=True, token="", extra={}))

    assert adapter._token == "scoped-B"
    assert adapter._token != os.environ["KINDLE_INGEST_TOKEN"]
    assert adapter._profile_name == "finance"
    assert adapter._profile_home == (tmp_path / "finance").resolve()
    assert adapter._user_id == "finance-scribe"


def test_missing_multiplex_scope_never_falls_back_to_primary_env(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _set_profile(monkeypatch, tmp_path / "finance", "finance")
    _set_env(monkeypatch, KINDLE_INGEST_TOKEN="primary-A")
    set_multiplex_active(True)

    assert adapter_module._is_connected(PlatformConfig(enabled=True)) is False
    with pytest.raises(KindleConfigurationError, match="without a profile secret scope"):
        KindleAdapter(PlatformConfig(enabled=True, token="", extra={}))


def test_missing_scoped_token_and_false_insecure_are_not_ready(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    profile_home = tmp_path / "finance"
    _set_profile(monkeypatch, profile_home, "finance")
    _set_env(monkeypatch, KINDLE_INGEST_TOKEN="primary-A")
    scoped = {"KINDLE_INSECURE": "false", "KINDLE_USER": "finance-scribe"}
    _write_profile_env(profile_home, scoped)

    with _profile_secret_scope(scoped):
        assert adapter_module._is_connected(PlatformConfig(enabled=True)) is False
        adapter = KindleAdapter(PlatformConfig(enabled=True, token="", extra={}))

    assert adapter._token == ""
    assert adapter._insecure is False
    assert asyncio.run(adapter.connect()) is False


def test_literal_false_in_single_profile_does_not_auto_enable(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _set_profile(monkeypatch, tmp_path / "default", "default")
    _set_env(
        monkeypatch,
        KINDLE_INGEST_TOKEN=None,
        KINDLE_INSECURE="false",
    )
    assert adapter_module._is_connected(PlatformConfig(enabled=True)) is False


def test_forged_user_and_profile_are_ignored_and_ids_are_namespaced(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    async def case() -> None:
        adapter = _adapter(
            monkeypatch,
            tmp_path,
            profile="finance",
            user="finance-scribe",
        )
        observed = []

        async def accept(event) -> None:
            observed.append(event)
            await adapter.send(
                event.source.chat_id,
                "bound reply",
                metadata={"notify": True},
            )

        monkeypatch.setattr(adapter, "handle_message", accept)
        payload = {
            "text": "hello",
            "image_text": "OCR hint",
            "chat_id": "entry-7",
            "message_id": "turn-9",
            "user": "attacker",
            "profile": "legal",
        }
        async with _client(adapter) as client:
            response = await client.post(
                "/ingest", json=payload, headers=_ingest_headers(adapter)
            )
            body = await response.json()

        assert response.status == 200
        assert body == {"reply": "bound reply"}
        assert len(observed) == 1
        event = observed[0]
        assert event.source.user_id == "finance-scribe"
        assert event.source.profile == "finance"
        assert event.source.chat_id == "kindle:finance:entry-7"
        assert event.message_id == "kindle:finance:turn-9"
        assert event.raw_message["user"] == "finance-scribe"
        assert event.raw_message["profile"] == "finance"
        assert "attacker" not in json.dumps(event.raw_message)
        assert "legal" not in json.dumps(event.raw_message)
        assert set(event.raw_message) == {
            "text",
            "image_text",
            "user",
            "profile",
            "chat_id",
            "message_id",
        }

    asyncio.run(case())


def test_gateway_task_inherits_validated_profile_home_and_secret_scope(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    async def case() -> None:
        import hermes_cli.profiles
        from agent.secret_scope import current_secret_scope, get_secret
        from hermes_constants import (
            get_hermes_home,
            reset_hermes_home_override,
            set_hermes_home_override,
        )

        profile_home = (tmp_path / "finance").resolve()
        profile_home.mkdir(parents=True)
        scoped = {
            "KINDLE_INGEST_TOKEN": "scoped-token",
            "KINDLE_INSECURE": "false",
            "KINDLE_USER": "finance-scribe",
            "KINDLE_ALLOWED_USERS": "finance-scribe",
            "PROFILE_SENTINEL": "finance-only",
        }
        _write_profile_env(profile_home, scoped)
        _set_env(monkeypatch, KINDLE_INGEST_TOKEN="primary-token")
        monkeypatch.setenv("KINDLE_ALLOWED_USERS", "primary-user")
        monkeypatch.setenv("PROFILE_SENTINEL", "primary-leak")
        monkeypatch.setattr(
            hermes_cli.profiles,
            "get_active_profile_name",
            lambda: "finance",
        )

        home_token = set_hermes_home_override(str(profile_home))
        try:
            with _profile_secret_scope(scoped):
                adapter = KindleAdapter(
                    PlatformConfig(enabled=True, token="", extra={})
                )
        finally:
            reset_hermes_home_override(home_token)

        observed = {}

        async def accept(event) -> None:
            scope = current_secret_scope()
            observed["scope"] = dict(scope) if scope is not None else None
            observed["sentinel"] = get_secret("PROFILE_SENTINEL")
            observed["home"] = get_hermes_home().resolve()
            await adapter.send(
                event.source.chat_id,
                "profile-bound",
                metadata={"notify": True},
            )

        monkeypatch.setattr(adapter, "handle_message", accept)
        async with _client(adapter) as client:
            response = await client.post(
                "/ingest",
                json=_payload(),
                headers=_ingest_headers(adapter, "scoped-token"),
            )
            assert response.status == 200
            assert await response.json() == {"reply": "profile-bound"}

        assert observed["sentinel"] == "finance-only"
        assert observed["scope"]["KINDLE_ALLOWED_USERS"] == "finance-scribe"
        assert observed["scope"]["KINDLE_INGEST_TOKEN"] == "scoped-token"
        assert observed["home"] == profile_home
        assert current_secret_scope() is None

    asyncio.run(case())


def test_valid_health_then_listener_owner_swap_cannot_dispatch_wrong_profile(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    async def case() -> None:
        shared_token = "shared-race-token"
        alpha = _scoped_adapter(
            monkeypatch,
            tmp_path,
            profile="alpha",
            secrets={
                "KINDLE_INGEST_TOKEN": shared_token,
                "KINDLE_USER": "alpha-scribe",
            },
        )
        beta = _scoped_adapter(
            monkeypatch,
            tmp_path,
            profile="beta",
            secrets={
                "KINDLE_INGEST_TOKEN": shared_token,
                "KINDLE_USER": "beta-scribe",
            },
        )
        dispatched = []

        async def wrong_profile_dispatch(event) -> None:
            dispatched.append(event)

        monkeypatch.setattr(beta, "handle_message", wrong_profile_dispatch)

        async with _client(alpha) as alpha_client:
            health_response = await alpha_client.get(
                "/health",
                headers=_headers(shared_token),
            )
            health = await health_response.json()
            assert health_response.status == 200
            expected_owner = health["owner_fingerprint"]
            assert expected_owner == alpha._owner_fingerprint

        # The listener is now beta, but the caller carries the owner attested
        # by alpha's valid health response. A shared token alone is insufficient.
        async with _client(beta) as beta_client:
            response = await beta_client.post(
                "/ingest",
                json=_payload(),
                headers=_ingest_headers(
                    beta,
                    token=shared_token,
                    owner=expected_owner,
                ),
            )
            assert response.status == 409
            assert await response.json() == {"error": "request rejected"}

        assert dispatched == []
        assert alpha._owner_fingerprint != beta._owner_fingerprint

    asyncio.run(case())


@pytest.mark.parametrize(
    "updates",
    [
        {"KINDLE_INGEST_HOST": "0.0.0.0"},
        {"KINDLE_INGEST_HOST": "example.com"},
        {"KINDLE_INGEST_PORT": "0"},
        {"KINDLE_INGEST_PORT": "65536"},
        {"KINDLE_INGEST_PORT": "not-a-port"},
        {"KINDLE_REPLY_TIMEOUT": "0"},
        {"KINDLE_REPLY_TIMEOUT": "0.0101"},
        {"KINDLE_REPLY_TIMEOUT": "1e2"},
        {"KINDLE_REPLY_TIMEOUT": "301"},
        {"KINDLE_REPLY_TIMEOUT": "nan"},
        {"KINDLE_INSECURE": "sometimes"},
        {"KINDLE_USER": "../../other-profile"},
        {"KINDLE_INGEST_TOKEN": "x" * (adapter_module.MAX_TOKEN_LENGTH + 1)},
    ],
)
def test_invalid_profile_configuration_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    updates: dict[str, str],
) -> None:
    _set_profile(monkeypatch, tmp_path / "default", "default")
    _set_env(monkeypatch, **updates)
    with pytest.raises(KindleConfigurationError):
        KindleAdapter(PlatformConfig(enabled=True, token="", extra={}))


def test_insecure_mode_is_allowed_only_on_loopback(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    async def case() -> None:
        _set_profile(monkeypatch, tmp_path / "default", "default")
        _set_env(
            monkeypatch,
            KINDLE_INGEST_TOKEN=None,
            KINDLE_INSECURE="true",
            KINDLE_INGEST_HOST="127.0.0.1",
        )
        assert adapter_module._is_connected(PlatformConfig(enabled=True)) is True
        adapter = KindleAdapter(PlatformConfig(enabled=True, token="", extra={}))

        async def accept(event) -> None:
            await adapter.send(
                event.source.chat_id,
                "dev reply",
                metadata={"notify": True},
            )

        monkeypatch.setattr(adapter, "handle_message", accept)
        async with _client(adapter) as client:
            response = await client.post(
                "/ingest",
                json=_payload(),
                headers=_ingest_headers(adapter, token=None),
            )
            assert response.status == 200
            assert await response.json() == {"reply": "dev reply"}

    asyncio.run(case())


def test_input_and_concurrency_bounds_fail_before_dispatch(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    async def case() -> None:
        adapter = _adapter(monkeypatch, tmp_path)
        dispatched = []

        async def accept(event) -> None:
            dispatched.append(event)

        monkeypatch.setattr(adapter, "handle_message", accept)
        async with _client(adapter) as client:
            array_body = await client.post(
                "/ingest",
                json=["not", "an", "object"],
                headers=_ingest_headers(adapter),
            )
            assert array_body.status == 400

            wrong_type = await client.post(
                "/ingest",
                json={"text": 7},
                headers=_ingest_headers(adapter),
            )
            assert wrong_type.status == 400

            oversized_text = await client.post(
                "/ingest",
                json={"text": "x" * (adapter_module.MAX_KINDLE_LENGTH + 1)},
                headers=_ingest_headers(adapter),
            )
            assert oversized_text.status == 413

            oversized_ocr = await client.post(
                "/ingest",
                json={
                    "text": "ok",
                    "image_text": "x" * (adapter_module.MAX_OCR_LENGTH + 1),
                },
                headers=_ingest_headers(adapter),
            )
            assert oversized_ocr.status == 413

            invalid_chat = await client.post(
                "/ingest",
                json={"text": "ok", "chat_id": "safe/../../finance"},
                headers=_ingest_headers(adapter),
            )
            assert invalid_chat.status == 400

            invalid_message = await client.post(
                "/ingest",
                json={"text": "ok", "message_id": "../turn"},
                headers=_ingest_headers(adapter),
            )
            assert invalid_message.status == 400

            huge_request = await client.post(
                "/ingest",
                data=b"{" + b" " * adapter_module.MAX_REQUEST_BYTES + b"}",
                headers={
                    **_ingest_headers(adapter),
                    "Content-Type": "application/json",
                },
            )
            assert huge_request.status == 413

            loop = asyncio.get_running_loop()
            for index in range(adapter_module.MAX_PENDING_REQUESTS):
                adapter._pending[f"occupied-{index}"] = loop.create_future()
            saturated = await client.post(
                "/ingest",
                json={"text": "ok", "chat_id": "new-entry"},
                headers=_ingest_headers(adapter),
            )
            assert saturated.status == 429
            for future in adapter._pending.values():
                future.cancel()
            adapter._pending.clear()

        assert dispatched == []

    asyncio.run(case())


def test_health_requires_auth_and_attests_actual_profile_owner_and_version(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    async def case() -> None:
        port = _free_port()
        _set_profile(monkeypatch, tmp_path / "finance", "finance")
        _set_env(
            monkeypatch,
            KINDLE_INGEST_TOKEN="health-token",
            KINDLE_INGEST_PORT=str(port),
            KINDLE_USER="finance-scribe",
        )
        adapter = KindleAdapter(PlatformConfig(enabled=True, token="", extra={}))
        assert await adapter.connect() is True
        try:
            async with ClientSession() as session:
                unauthorized = await session.get(f"http://127.0.0.1:{port}/health")
                assert unauthorized.status == 401
                assert await unauthorized.json() == {"error": "unauthorized"}

                response = await session.get(
                    f"http://127.0.0.1:{port}/health",
                    headers=_headers("health-token"),
                )
                body = await response.json()
                assert response.status == 200
                assert body == {
                    "status": "ok",
                    "service": "kindle-scribe",
                    "version": "0.2.0",
                    "profile": "finance",
                    "owner_fingerprint": adapter._owner_fingerprint,
                    "host": "127.0.0.1",
                    "port": port,
                    "pending": 0,
                }
                assert len(body["owner_fingerprint"]) == 64
        finally:
            await adapter.disconnect()

    asyncio.run(case())


def test_atomic_profile_env_swap_during_inflight_turn_fails_before_reply_return(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    async def case() -> None:
        scoped = {
            "KINDLE_INGEST_TOKEN": "original-token",
            "KINDLE_INSECURE": "false",
            "KINDLE_USER": "finance-scribe",
            "KINDLE_REPLY_TIMEOUT": "1",
        }
        adapter = _scoped_adapter(
            monkeypatch,
            tmp_path,
            profile="finance",
            secrets=scoped,
        )

        async def accept(_event) -> None:
            return None

        monkeypatch.setattr(adapter, "handle_message", accept)
        async with _client(adapter) as client:
            request = asyncio.create_task(
                client.post(
                    "/ingest",
                    json=_payload(),
                    headers=_ingest_headers(adapter, "original-token"),
                )
            )
            chat_id = await _wait_for_pending(adapter, "scribe-1")
            _replace_profile_env(
                adapter._profile_home,
                {
                    **scoped,
                    "KINDLE_INGEST_TOKEN": "replacement-token",
                    "KINDLE_USER": "replacement-owner",
                },
            )

            sent = await adapter.send(
                chat_id, "must not escape", metadata={"notify": True}
            )
            response = await request
            body = await response.json()

            assert sent.success is False
            assert sent.error == "Kindle owner changed"
            assert response.status == 409
            assert body == {"error": "owner changed"}
            assert adapter._pending == {}

            stale_health = await client.get(
                "/health", headers=_headers("original-token")
            )
            assert stale_health.status == 409
            assert await stale_health.json() == {"error": "owner changed"}

    asyncio.run(case())


def test_cross_profile_same_listener_is_refused_then_released(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    async def case() -> None:
        port = _free_port()
        alpha = _scoped_adapter(
            monkeypatch,
            tmp_path,
            profile="alpha",
            secrets={
                "KINDLE_INGEST_TOKEN": "alpha-token",
                "KINDLE_INGEST_PORT": str(port),
                "KINDLE_USER": "alpha-scribe",
            },
        )
        beta = _scoped_adapter(
            monkeypatch,
            tmp_path,
            profile="beta",
            secrets={
                "KINDLE_INGEST_TOKEN": "beta-token",
                "KINDLE_INGEST_PORT": str(port),
                "KINDLE_USER": "beta-scribe",
            },
        )

        assert await alpha.connect() is True
        try:
            assert await beta.connect() is False
            assert beta._running is False
            with adapter_module._LISTENER_OWNERS_LOCK:
                owner = adapter_module._LISTENER_OWNERS[("127.0.0.1", port)]
            assert owner.profile_name == "alpha"
            assert owner.owner_fingerprint == alpha._owner_fingerprint
        finally:
            await alpha.disconnect()

        with adapter_module._LISTENER_OWNERS_LOCK:
            assert ("127.0.0.1", port) not in adapter_module._LISTENER_OWNERS

        assert await beta.connect() is True
        try:
            assert beta._running is True
            assert beta._actual_port == port
        finally:
            await beta.disconnect()

        with adapter_module._LISTENER_OWNERS_LOCK:
            assert ("127.0.0.1", port) not in adapter_module._LISTENER_OWNERS

    asyncio.run(case())


def test_cleanup_failure_retains_listener_claim_and_blocks_reclaim(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    class FailingCleanupRunner:
        async def cleanup(self) -> None:
            raise RuntimeError("injected cleanup failure")

    async def case() -> None:
        port = _free_port()
        alpha = _scoped_adapter(
            monkeypatch,
            tmp_path,
            profile="alpha",
            secrets={
                "KINDLE_INGEST_TOKEN": "alpha-token",
                "KINDLE_INGEST_PORT": str(port),
                "KINDLE_USER": "alpha-scribe",
            },
        )
        beta = _scoped_adapter(
            monkeypatch,
            tmp_path,
            profile="beta",
            secrets={
                "KINDLE_INGEST_TOKEN": "beta-token",
                "KINDLE_INGEST_PORT": str(port),
                "KINDLE_USER": "beta-scribe",
            },
        )

        assert await alpha.connect() is True
        real_runner = alpha._runner
        alpha._runner = FailingCleanupRunner()

        await alpha.disconnect()
        assert alpha._listener_claim_id is not None
        assert alpha._runner is not None
        with adapter_module._LISTENER_OWNERS_LOCK:
            retained = adapter_module._LISTENER_OWNERS[("127.0.0.1", port)]
        assert retained.profile_name == "alpha"
        assert await beta.connect() is False

        async with ClientSession() as session:
            orphan_health = await session.get(
                f"http://127.0.0.1:{port}/health",
                headers=_headers("alpha-token"),
            )
            assert orphan_health.status == 503
            assert await orphan_health.json() == {"error": "listener unavailable"}

        alpha._runner = real_runner
        await alpha.disconnect()
        assert alpha._listener_claim_id is None
        assert alpha._runner is None

        assert await beta.connect() is True
        await beta.disconnect()

    asyncio.run(case())


def test_stubborn_dispatch_task_keeps_listener_fail_closed_until_quiescent(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    async def case() -> None:
        port = _free_port()
        _set_profile(monkeypatch, tmp_path / "default", "default")
        _set_env(
            monkeypatch,
            KINDLE_INGEST_TOKEN="test-token",
            KINDLE_INGEST_PORT=str(port),
        )
        adapter = KindleAdapter(PlatformConfig(enabled=True, token="", extra={}))
        release = asyncio.Event()
        started = asyncio.Event()

        async def resist_cancellation(_event) -> None:
            started.set()
            while not release.is_set():
                try:
                    await release.wait()
                except asyncio.CancelledError:
                    continue

        monkeypatch.setattr(adapter, "handle_message", resist_cancellation)
        monkeypatch.setattr(adapter_module, "PENDING_CLEANUP_TIMEOUT", 0.01)
        assert await adapter.connect() is True

        async with ClientSession() as session:
            request = asyncio.create_task(
                session.post(
                    f"http://127.0.0.1:{port}/ingest",
                    json=_payload(),
                    headers=_ingest_headers(adapter),
                )
            )
            await _wait_for_pending(adapter, "scribe-1")
            await started.wait()
            await adapter.disconnect()

            assert adapter._listener_claim_id is not None
            assert adapter._runner is not None
            assert adapter._accepting_requests is False
            assert adapter.fatal_error_code == "kindle_pending_cleanup_failed"

            release.set()
            response = await request
            assert response.status == 503
            assert await response.json() == {"error": "cancelled"}

        await adapter.disconnect()
        assert adapter._listener_claim_id is None
        assert adapter._runner is None

    asyncio.run(case())


def test_timed_out_request_bounds_stubborn_task_cleanup_and_retains_listener(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    async def case() -> None:
        port = _free_port()
        _set_profile(monkeypatch, tmp_path / "default", "default")
        _set_env(
            monkeypatch,
            KINDLE_INGEST_TOKEN="test-token",
            KINDLE_INGEST_PORT=str(port),
            KINDLE_REPLY_TIMEOUT="0.01",
        )
        adapter = KindleAdapter(PlatformConfig(enabled=True, token="", extra={}))
        release = asyncio.Event()
        started = asyncio.Event()

        async def resist_cancellation(_event) -> None:
            started.set()
            while not release.is_set():
                try:
                    await release.wait()
                except asyncio.CancelledError:
                    continue

        monkeypatch.setattr(adapter, "handle_message", resist_cancellation)
        monkeypatch.setattr(adapter_module, "PENDING_CLEANUP_TIMEOUT", 0.01)
        assert await adapter.connect() is True
        claim_id = adapter._listener_claim_id
        retained_task = None

        try:
            async with ClientSession() as session:
                request = asyncio.create_task(
                    session.post(
                        f"http://127.0.0.1:{port}/ingest",
                        json=_payload(),
                        headers=_ingest_headers(adapter),
                    )
                )
                await started.wait()
                response = await asyncio.wait_for(request, timeout=0.5)
                assert response.status == 504
                assert await response.json() == {"error": "agent timed out"}

                chat_id = adapter._namespace("scribe-1")
                retained_task = adapter._pending_tasks[chat_id]
                assert retained_task.done() is False
                assert retained_task in adapter._background_tasks
                assert adapter._pending == {}
                assert adapter._accepting_requests is False
                assert adapter._running is False
                assert adapter.fatal_error_code == "kindle_pending_cleanup_failed"
                assert adapter._listener_claim_id == claim_id

                health = await session.get(
                    f"http://127.0.0.1:{port}/health",
                    headers=_headers(),
                )
                assert health.status == 503
                assert await health.json() == {"error": "listener unavailable"}

                assert await asyncio.wait_for(adapter.connect(), timeout=0.5) is False
                assert adapter._listener_claim_id == claim_id
                assert adapter._runner is not None
                assert adapter._pending_tasks[chat_id] is retained_task
                with adapter_module._LISTENER_OWNERS_LOCK:
                    owner = adapter_module._LISTENER_OWNERS[("127.0.0.1", port)]
                assert owner.claim_id == claim_id

            release.set()
            for _ in range(100):
                if not adapter._pending_tasks:
                    break
                await asyncio.sleep(0)
            assert adapter._pending_tasks == {}
            assert retained_task not in adapter._background_tasks

            await adapter.disconnect()
            assert adapter._listener_claim_id is None
            assert adapter._runner is None

            assert await adapter.connect() is True
        finally:
            release.set()
            if retained_task is not None and not retained_task.done():
                await asyncio.wait({retained_task}, timeout=0.5)
            await adapter.disconnect()

    asyncio.run(case())
