"""Profile-owned Kindle Scribe platform adapter for Hermes Agent.

The companion diary bridge runs on the LAN.  This adapter is its authenticated,
localhost-only boundary into the Hermes gateway.  Every adapter instance is
bound at construction time to one Hermes profile and one configured Kindle user.
Request payloads cannot select either identity.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import re
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Mapping, Optional

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)

logger = logging.getLogger(__name__)

PLUGIN_VERSION = "0.2.0"
SERVICE_NAME = "kindle-scribe"
DEFAULT_INGEST_HOST = "127.0.0.1"
DEFAULT_INGEST_PORT = 8793
DEFAULT_REPLY_TIMEOUT = 240.0
MAX_REPLY_TIMEOUT = 300.0
MIN_REPLY_TIMEOUT = 0.01
MAX_KINDLE_LENGTH = 8000
MAX_OCR_LENGTH = 4000
MAX_REQUEST_BYTES = 64 * 1024
MAX_PENDING_REQUESTS = 8
PENDING_CLEANUP_TIMEOUT = 1.0
MAX_CHAT_ID_LENGTH = 160
MAX_MESSAGE_ID_LENGTH = 160
MAX_USER_ID_LENGTH = 128
MAX_TOKEN_LENGTH = 4096
OWNER_FINGERPRINT_LENGTH = 64
OWNER_HEADER = "X-Kindle-Owner"

_PROFILE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_USER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$")
_CHAT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$")
_MESSAGE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$")
_TIMEOUT_RE = re.compile(r"^(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,3})?$")
_TRUE_VALUES = frozenset({"1", "true", "yes", "on"})
_FALSE_VALUES = frozenset({"", "0", "false", "no", "off"})


class KindleConfigurationError(ValueError):
    """The active profile's Kindle configuration is invalid."""


class KindleOwnershipChanged(RuntimeError):
    """The adapter's profile/config/listener ownership changed while running."""


class KindleRequestError(ValueError):
    """A bounded ingest request failed validation."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


class KindleDispatchError(RuntimeError):
    """The gateway message task failed before it delivered a reply."""


@dataclass(frozen=True)
class _RuntimeContext:
    profile_name: str
    profile_home: Path
    secrets: "_ProfileSecrets"


@dataclass(frozen=True)
class _AdapterSettings:
    profile_name: str
    profile_home: Path
    host: str
    port: int
    token: str
    insecure: bool
    user_id: str
    reply_timeout_ms: int

    @property
    def reply_timeout(self) -> float:
        return self.reply_timeout_ms / 1000.0

    @property
    def owner_payload(self) -> dict[str, Any]:
        """Return the cross-runtime canonical owner identity payload."""

        token_fingerprint = (
            hashlib.sha256(self.token.encode("utf-8")).hexdigest()
            if self.token
            else "insecure-loopback"
        )
        return {
            "service": SERVICE_NAME,
            "version": PLUGIN_VERSION,
            "profile_name": self.profile_name,
            "profile_home": os.path.normcase(str(self.profile_home)).replace("\\", "/"),
            "host": self.host,
            "port": self.port,
            "user_id": self.user_id,
            "insecure": self.insecure,
            "reply_timeout_ms": self.reply_timeout_ms,
            "token_fingerprint": token_fingerprint,
        }

    @property
    def owner_canonical_json(self) -> str:
        return json.dumps(
            self.owner_payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )

    @property
    def owner_fingerprint(self) -> str:
        encoded = self.owner_canonical_json.encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()


@dataclass(frozen=True)
class _ListenerOwner:
    claim_id: str
    owner_fingerprint: str
    profile_name: str


_LISTENER_OWNERS: dict[tuple[str, int], _ListenerOwner] = {}
_LISTENER_OWNERS_LOCK = threading.RLock()


class _ProfileSecrets:
    """Read and refresh one profile scope without cross-profile fallback.

    The construction-time scope is authoritative for adapter creation. During
    multiplexed request handling, refreshes rebuild a fresh mapping from the
    captured profile home. That detects atomic ``.env`` rotations after the
    gateway's temporary construction scope exits and never consults another
    profile's process environment.
    """

    def __init__(
        self,
        scope: Optional[Mapping[str, str]],
        multiplex_active: bool,
        profile_home: Path,
    ):
        if multiplex_active and scope is None:
            raise KindleConfigurationError(
                "Kindle configuration was resolved without a profile secret scope "
                "while gateway multiplexing is active"
            )
        self._scope = scope
        self._multiplex_active = multiplex_active
        self._profile_home = profile_home

    def get(self, name: str, default: str = "") -> str:
        if self._scope is not None:
            value = self._scope.get(name)
            return default if value is None else str(value)

        # This is deliberately Hermes' fail-closed resolver, not os.getenv.
        # If multiplexing becomes active after construction it raises instead
        # of borrowing whichever profile happens to own process os.environ.
        from agent.secret_scope import get_secret

        value = get_secret(name, default)
        return default if value is None else str(value)

    def refreshed(self) -> "_ProfileSecrets":
        if not self._multiplex_active:
            return self

        from agent.secret_scope import build_profile_secret_scope

        return _ProfileSecrets(
            build_profile_secret_scope(self._profile_home),
            True,
            self._profile_home,
        )

    def dispatch_scope(self) -> Optional[dict[str, str]]:
        """Return an isolated mapping for the gateway task's contextvars."""
        if self._scope is None:
            return None
        return {str(name): str(value) for name, value in self._scope.items()}


def _capture_runtime_context() -> _RuntimeContext:
    from agent.secret_scope import current_secret_scope, is_multiplex_active
    from hermes_cli.profiles import get_active_profile_name
    from hermes_constants import get_hermes_home

    profile_name = str(get_active_profile_name() or "default").strip().lower()
    if not _PROFILE_RE.fullmatch(profile_name):
        raise KindleConfigurationError("active Hermes profile name is invalid")

    profile_home = Path(get_hermes_home()).expanduser().resolve(strict=False)
    if not profile_home.is_absolute():
        raise KindleConfigurationError("active Hermes profile home must be absolute")

    return _RuntimeContext(
        profile_name=profile_name,
        profile_home=profile_home,
        secrets=_ProfileSecrets(
            current_secret_scope(),
            is_multiplex_active(),
            profile_home,
        ),
    )


def _refresh_runtime_context(context: _RuntimeContext) -> _RuntimeContext:
    return _RuntimeContext(
        profile_name=context.profile_name,
        profile_home=context.profile_home,
        secrets=context.secrets.refreshed(),
    )


def _parse_bool(name: str, raw: str) -> bool:
    normalized = raw.strip().lower()
    if len(normalized) > 8:
        raise KindleConfigurationError(f"{name} must be true or false")
    if normalized in _TRUE_VALUES:
        return True
    if normalized in _FALSE_VALUES:
        return False
    raise KindleConfigurationError(f"{name} must be true or false")


def _parse_loopback_host(raw: str) -> str:
    host = raw.strip().lower()
    if host == "localhost":
        host = DEFAULT_INGEST_HOST
    if len(host) > 64:
        raise KindleConfigurationError("KINDLE_INGEST_HOST is too long")
    try:
        address = ipaddress.ip_address(host)
    except ValueError as exc:
        raise KindleConfigurationError(
            "KINDLE_INGEST_HOST must be a literal loopback address"
        ) from exc
    if not address.is_loopback:
        raise KindleConfigurationError("KINDLE_INGEST_HOST must remain loopback-only")
    return address.compressed


def _parse_port(raw: str) -> int:
    normalized = raw.strip()
    if not normalized or len(normalized) > 5 or not normalized.isascii():
        raise KindleConfigurationError("KINDLE_INGEST_PORT must be an integer")
    try:
        port = int(normalized, 10)
    except (TypeError, ValueError) as exc:
        raise KindleConfigurationError("KINDLE_INGEST_PORT must be an integer") from exc
    if not 1 <= port <= 65535:
        raise KindleConfigurationError("KINDLE_INGEST_PORT must be between 1 and 65535")
    return port


def _parse_timeout_ms(raw: str) -> int:
    normalized = raw.strip()
    if not _TIMEOUT_RE.fullmatch(normalized):
        raise KindleConfigurationError(
            "KINDLE_REPLY_TIMEOUT must be a plain decimal with up to three "
            "fractional digits"
        )
    whole, dot, fractional = normalized.partition(".")
    timeout_ms_int = int(whole, 10) * 1000
    if dot:
        timeout_ms_int += int(fractional.ljust(3, "0"), 10)
    if not int(MIN_REPLY_TIMEOUT * 1000) <= timeout_ms_int <= int(MAX_REPLY_TIMEOUT * 1000):
        raise KindleConfigurationError(
            f"KINDLE_REPLY_TIMEOUT must be between {MIN_REPLY_TIMEOUT} and "
            f"{MAX_REPLY_TIMEOUT:g} seconds"
        )
    return timeout_ms_int


def _resolve_settings(context: _RuntimeContext) -> _AdapterSettings:
    secrets = context.secrets
    host = _parse_loopback_host(
        secrets.get("KINDLE_INGEST_HOST", DEFAULT_INGEST_HOST)
    )
    port = _parse_port(secrets.get("KINDLE_INGEST_PORT", str(DEFAULT_INGEST_PORT)))
    timeout_ms = _parse_timeout_ms(
        secrets.get("KINDLE_REPLY_TIMEOUT", str(DEFAULT_REPLY_TIMEOUT))
    )
    insecure = _parse_bool("KINDLE_INSECURE", secrets.get("KINDLE_INSECURE", ""))
    token = secrets.get("KINDLE_INGEST_TOKEN", "").strip()
    if len(token) > MAX_TOKEN_LENGTH:
        raise KindleConfigurationError("KINDLE_INGEST_TOKEN is too long")

    # Insecure mode is supported only as an explicit loopback development mode.
    # The host validator above rejects every non-loopback value regardless.
    if insecure and not ipaddress.ip_address(host).is_loopback:
        raise KindleConfigurationError("KINDLE_INSECURE requires a loopback host")

    user_id = secrets.get("KINDLE_USER", "kindle").strip()
    if len(user_id) > MAX_USER_ID_LENGTH or not _USER_RE.fullmatch(user_id):
        raise KindleConfigurationError("KINDLE_USER is invalid")

    return _AdapterSettings(
        profile_name=context.profile_name,
        profile_home=context.profile_home,
        host=host,
        port=port,
        token=token,
        insecure=insecure,
        user_id=user_id,
        reply_timeout_ms=timeout_ms,
    )


def _constant_time_token_match(actual: str, expected: str) -> bool:
    if not expected or len(actual) > MAX_TOKEN_LENGTH:
        return False
    actual_digest = hashlib.sha256(actual.encode("utf-8")).digest()
    expected_digest = hashlib.sha256(expected.encode("utf-8")).digest()
    return hmac.compare_digest(actual_digest, expected_digest)


def _constant_time_owner_match(actual: str, expected: str) -> bool:
    """Compare a bounded lowercase SHA-256 owner attestation in constant time."""
    bounded = isinstance(actual, str) and len(actual) == OWNER_FINGERPRINT_LENGTH
    canonical = bounded and all(character in "0123456789abcdef" for character in actual)
    actual_value = (
        actual[: OWNER_FINGERPRINT_LENGTH + 1]
        if isinstance(actual, str)
        else ""
    )
    actual_digest = hashlib.sha256(actual_value.encode("utf-8")).digest()
    expected_digest = hashlib.sha256(expected.encode("utf-8")).digest()
    matched = hmac.compare_digest(actual_digest, expected_digest)
    return bool(canonical and matched)


async def _open_listener_quiescence_probe(
    host: str,
    port: int,
) -> Optional["asyncio.AbstractServer"]:
    """Exclusively bind a stopped probe server only when the port is free.

    The caller holds this probe until after releasing the in-process ownership
    claim, closing the race where another profile could be authorized while an
    orphaned aiohttp listener still owns the socket.
    """

    def _reject_probe(_reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        writer.close()

    try:
        return await asyncio.start_server(
            _reject_probe,
            host=host,
            port=port,
            start_serving=False,
            reuse_address=False,
            reuse_port=False,
        )
    except (OSError, ValueError):
        return None


def _request_is_loopback(request: Any) -> bool:
    try:
        peer = request.transport.get_extra_info("peername")
        address = peer[0] if isinstance(peer, tuple) and peer else ""
        return ipaddress.ip_address(str(address)).is_loopback
    except (AttributeError, TypeError, ValueError):
        return False


def _bounded_identifier(
    value: Any,
    *,
    field: str,
    default: str = "",
    maximum: int,
    pattern: re.Pattern[str],
) -> str:
    if value is None or value == "":
        value = default
    if not isinstance(value, str):
        raise KindleRequestError(f"{field} must be a string")
    result = value.strip()
    if not result or len(result) > maximum or not pattern.fullmatch(result):
        raise KindleRequestError(f"{field} is invalid")
    return result


def _bounded_text(value: Any, *, field: str, maximum: int, allow_empty: bool) -> str:
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise KindleRequestError(f"{field} must be a string")
    result = value.strip()
    if not allow_empty and not result:
        raise KindleRequestError("empty note")
    if len(result) > maximum:
        raise KindleRequestError(f"{field} exceeds {maximum} characters", status=413)
    return result


async def _read_bounded_json(request: Any) -> dict[str, Any]:
    content_length = request.content_length
    if content_length is not None and content_length > MAX_REQUEST_BYTES:
        raise KindleRequestError("request too large", status=413)

    payload = bytearray()
    async for chunk in request.content.iter_chunked(8192):
        payload.extend(chunk)
        if len(payload) > MAX_REQUEST_BYTES:
            raise KindleRequestError("request too large", status=413)
    try:
        decoded = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise KindleRequestError("bad json") from exc
    if not isinstance(decoded, dict):
        raise KindleRequestError("json body must be an object")
    return decoded


def check_kindle_requirements() -> bool:
    """The adapter needs aiohttp for its local ingest server."""
    try:
        import aiohttp  # noqa: F401
    except ImportError:
        return False
    return True


class KindleAdapter(BasePlatformAdapter):
    """One profile-owned Kindle Scribe <-> Hermes gateway adapter."""

    MAX_MESSAGE_LENGTH = MAX_KINDLE_LENGTH

    def __init__(self, config: PlatformConfig):
        platform = Platform("kindle")
        super().__init__(config=config, platform=platform)
        self._runtime_context = _capture_runtime_context()
        self._settings = _resolve_settings(self._runtime_context)
        self._host = self._settings.host
        self._port = self._settings.port
        self._token = self._settings.token
        self._insecure = self._settings.insecure
        self._reply_timeout = self._settings.reply_timeout
        self._profile_name = self._settings.profile_name
        self._profile_home = self._settings.profile_home
        self._user_id = self._settings.user_id
        self._owner_fingerprint = self._settings.owner_fingerprint
        self._runner = None
        self._site = None
        self._actual_port: Optional[int] = None
        self._listener_key: Optional[tuple[str, int]] = None
        self._listener_claim_id: Optional[str] = None
        # Direct handler tests do not expose a socket before connect. Real
        # listeners flip this off during startup/teardown and on any failure.
        self._accepting_requests = True
        self._pending: Dict[str, "asyncio.Future[str]"] = {}
        self._pending_tasks: Dict[str, "asyncio.Task[None]"] = {}

    def _namespace(self, value: str) -> str:
        return f"kindle:{self._profile_name}:{value}"

    def _assert_active_binding(
        self,
        *,
        require_listener: bool = False,
    ) -> _RuntimeContext:
        try:
            current_context = _refresh_runtime_context(self._runtime_context)
            current = _resolve_settings(current_context)
        except Exception as exc:
            raise KindleOwnershipChanged("Kindle owner configuration is unavailable") from exc
        if not hmac.compare_digest(current.owner_fingerprint, self._owner_fingerprint):
            raise KindleOwnershipChanged("Kindle owner configuration changed")

        if require_listener:
            if self._listener_key is None or self._listener_claim_id is None:
                raise KindleOwnershipChanged("Kindle listener ownership is missing")
            with _LISTENER_OWNERS_LOCK:
                owner = _LISTENER_OWNERS.get(self._listener_key)
            if (
                owner is None
                or owner.claim_id != self._listener_claim_id
                or not hmac.compare_digest(
                    owner.owner_fingerprint, self._owner_fingerprint
                )
            ):
                raise KindleOwnershipChanged("Kindle listener ownership changed")
        return current_context

    def _claim_listener(self) -> bool:
        key = (self._host, self._port)
        claim = _ListenerOwner(
            claim_id=uuid.uuid4().hex,
            owner_fingerprint=self._owner_fingerprint,
            profile_name=self._profile_name,
        )
        with _LISTENER_OWNERS_LOCK:
            if key in _LISTENER_OWNERS:
                return False
            _LISTENER_OWNERS[key] = claim
        self._listener_key = key
        self._listener_claim_id = claim.claim_id
        return True

    def _release_listener(self) -> None:
        key = self._listener_key
        claim_id = self._listener_claim_id
        if key is not None and claim_id is not None:
            with _LISTENER_OWNERS_LOCK:
                owner = _LISTENER_OWNERS.get(key)
                if owner is not None and owner.claim_id == claim_id:
                    _LISTENER_OWNERS.pop(key, None)
        self._listener_key = None
        self._listener_claim_id = None

    def _authorized(self, request: Any) -> bool:
        if self._insecure:
            return _request_is_loopback(request)
        supplied = request.headers.get("X-Kindle-Token", "")
        return _constant_time_token_match(supplied, self._token)

    def _request_owner_matches(
        self,
        request: Any,
        context: _RuntimeContext,
    ) -> bool:
        supplied = request.headers.get(OWNER_HEADER, "")
        current_owner = _resolve_settings(context).owner_fingerprint
        captured_match = _constant_time_owner_match(
            supplied,
            self._owner_fingerprint,
        )
        current_match = _constant_time_owner_match(supplied, current_owner)
        return captured_match and current_match

    def _create_profile_dispatch_task(
        self,
        event: MessageEvent,
        context: _RuntimeContext,
    ) -> "asyncio.Task[None]":
        """Create the gateway task inside the validated profile context.

        ``asyncio.create_task`` copies contextvars at creation. Installing the
        captured home and freshly rebuilt profile scope here keeps Base auth,
        the agent turn, tools, and subprocess credential reads on the same
        profile as the authenticated listener request.
        """
        from agent.secret_scope import reset_secret_scope, set_secret_scope
        from hermes_constants import (
            reset_hermes_home_override,
            set_hermes_home_override,
        )

        home_token = set_hermes_home_override(str(context.profile_home))
        secret_token = None
        try:
            dispatch_scope = context.secrets.dispatch_scope()
            if dispatch_scope is not None:
                secret_token = set_secret_scope(dispatch_scope)
            return asyncio.create_task(self.handle_message(event))
        finally:
            if secret_token is not None:
                reset_secret_scope(secret_token)
            reset_hermes_home_override(home_token)

    async def _cleanup_owned_listener(self) -> bool:
        """Clean up and release ownership only after proving the port is free."""
        runner = self._runner
        if runner is not None:
            try:
                await runner.cleanup()
            except Exception:
                logger.warning("[kindle] listener cleanup failed", exc_info=True)
                self._set_fatal_error(
                    "kindle_listener_cleanup_failed",
                    "Kindle listener cleanup failed; ownership retained",
                    retryable=False,
                )
                return False

        probe: Optional["asyncio.AbstractServer"] = None
        if self._listener_key is not None:
            probe = await _open_listener_quiescence_probe(self._host, self._port)
            if probe is None:
                logger.error(
                    "[kindle] listener port %s:%d is not quiescent; ownership retained",
                    self._host,
                    self._port,
                )
                self._set_fatal_error(
                    "kindle_listener_not_quiescent",
                    "Kindle listener port is still active; ownership retained",
                    retryable=False,
                )
                return False

        try:
            self._runner = None
            self._site = None
            self._actual_port = None
            self._release_listener()
        finally:
            if probe is not None:
                probe.close()
                await probe.wait_closed()
        return True

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        from aiohttp import web

        if self._runner is not None or self._listener_claim_id is not None:
            if self._running:
                try:
                    self._assert_active_binding(require_listener=True)
                    return True
                except KindleOwnershipChanged:
                    pass
            await self.disconnect()
            if self._runner is not None or self._listener_claim_id is not None:
                return False

        self._accepting_requests = False

        try:
            self._assert_active_binding()
        except KindleOwnershipChanged as exc:
            self._set_fatal_error("kindle_owner_changed", str(exc), retryable=False)
            return False

        if not self._token and not self._insecure:
            msg = "[kindle] Refusing to start: KINDLE_INGEST_TOKEN is not set."
            logger.error(msg)
            self._set_fatal_error("kindle_missing_token", msg, retryable=False)
            return False

        if not self._claim_listener():
            msg = (
                f"[kindle] Refusing profile {self._profile_name!r}: "
                f"{self._host}:{self._port} is already owned by another adapter."
            )
            logger.error(msg)
            self._set_fatal_error("kindle_listener_owned", msg, retryable=False)
            return False

        runner = web.AppRunner(
            web.Application(client_max_size=MAX_REQUEST_BYTES)
        )
        runner.app.router.add_post("/ingest", self._handle_ingest)
        runner.app.router.add_get("/health", self._handle_health)
        self._runner = runner

        try:
            await runner.setup()
            self._site = web.TCPSite(runner, self._host, self._port)
            await self._site.start()
            sockets = getattr(getattr(self._site, "_server", None), "sockets", None) or []
            self._actual_port = int(sockets[0].getsockname()[1]) if sockets else self._port
            self._assert_active_binding(require_listener=True)
        except Exception as exc:
            logger.error(
                "[kindle] Failed to start profile-owned listener on %s:%d: %s",
                self._host,
                self._port,
                exc,
            )
            if not await self._cleanup_owned_listener():
                return False
            self._set_fatal_error(
                "kindle_listener_start_failed",
                "Kindle listener could not start",
                retryable=True,
            )
            return False

        self._running = True
        self._accepting_requests = True
        self._fatal_error_code = None
        self._fatal_error_message = None
        self._fatal_error_retryable = True
        logger.info(
            "[kindle] profile %s listening on %s:%d",
            self._profile_name,
            self._host,
            self._actual_port,
        )
        return True

    async def disconnect(self) -> None:
        self._running = False
        self._accepting_requests = False

        for future in list(self._pending.values()):
            if not future.done():
                future.cancel()

        current_task = asyncio.current_task()
        tasks = [
            task
            for task in list(self._pending_tasks.values())
            if task is not current_task and not task.done()
        ]
        for task in tasks:
            task.cancel()
        if tasks:
            done, still_pending = await asyncio.wait(
                tasks,
                timeout=PENDING_CLEANUP_TIMEOUT,
            )
            if done:
                await asyncio.gather(*done, return_exceptions=True)
            if still_pending:
                self._pending.clear()
                for chat_id, task in list(self._pending_tasks.items()):
                    if task.done():
                        self._pending_tasks.pop(chat_id, None)
                self._set_fatal_error(
                    "kindle_pending_cleanup_failed",
                    "Kindle request tasks did not stop; listener ownership retained",
                    retryable=False,
                )
                return

        self._pending.clear()
        self._pending_tasks.clear()

        if not await self._cleanup_owned_listener():
            return

        logger.info("[kindle] profile %s disconnected", self._profile_name)

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        """Deliver only a final, still-owned reply to its pending request."""
        future = self._pending.get(chat_id)
        if future is not None and not future.done():
            if not (metadata and metadata.get("notify") is True):
                return SendResult(success=False, error="streaming preview not supported")
            try:
                self._assert_active_binding(require_listener=self._listener_claim_id is not None)
            except KindleOwnershipChanged as exc:
                future.set_exception(exc)
                return SendResult(success=False, error="Kindle owner changed")
            future.set_result(content)
            return SendResult(success=True, message_id=chat_id)

        logger.warning("[kindle] send() for %s had no pending request", chat_id)
        return SendResult(success=False, error="no pending Kindle request")

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": chat_id, "type": "dm", "profile": self._profile_name}

    async def _handle_health(self, request: Any) -> "aiohttp.web.Response":
        from aiohttp import web

        if not self._authorized(request):
            return web.json_response({"error": "unauthorized"}, status=401)
        if not self._accepting_requests:
            return web.json_response({"error": "listener unavailable"}, status=503)
        try:
            self._assert_active_binding(require_listener=self._listener_claim_id is not None)
        except KindleOwnershipChanged:
            return web.json_response({"error": "owner changed"}, status=409)
        return web.json_response(
            {
                "status": "ok",
                "service": SERVICE_NAME,
                "version": PLUGIN_VERSION,
                "profile": self._profile_name,
                "owner_fingerprint": self._owner_fingerprint,
                "host": self._host,
                "port": self._actual_port or self._port,
                "pending": len(self._pending),
            }
        )

    async def _handle_ingest(self, request: Any) -> "aiohttp.web.Response":
        from aiohttp import web

        if not self._authorized(request):
            return web.json_response({"error": "unauthorized"}, status=401)
        if not self._accepting_requests:
            return web.json_response({"error": "listener unavailable"}, status=503)
        try:
            request_context = self._assert_active_binding(
                require_listener=self._listener_claim_id is not None
            )
            if not self._request_owner_matches(request, request_context):
                return web.json_response({"error": "request rejected"}, status=409)
            body = await _read_bounded_json(request)

            text = _bounded_text(
                body.get("text"), field="text", maximum=MAX_KINDLE_LENGTH, allow_empty=True
            )
            image_text = _bounded_text(
                body.get("image_text"),
                field="image_text",
                maximum=MAX_OCR_LENGTH,
                allow_empty=True,
            )
            if image_text and image_text not in text:
                combined = (text + "\n\n" + image_text).strip() if text else image_text
                if len(combined) > MAX_KINDLE_LENGTH:
                    raise KindleRequestError(
                        f"combined text exceeds {MAX_KINDLE_LENGTH} characters",
                        status=413,
                    )
                text = combined
            if not text:
                raise KindleRequestError("empty note")

            raw_chat_id = _bounded_identifier(
                body.get("chat_id"),
                field="chat_id",
                default=self._user_id,
                maximum=MAX_CHAT_ID_LENGTH,
                pattern=_CHAT_RE,
            )
            chat_id = self._namespace(raw_chat_id)
            raw_message_id = body.get("message_id")
            message_id = ""
            if raw_message_id not in (None, ""):
                message_id = self._namespace(
                    _bounded_identifier(
                        raw_message_id,
                        field="message_id",
                        maximum=MAX_MESSAGE_ID_LENGTH,
                        pattern=_MESSAGE_RE,
                    )
                )

            pending = self._pending.get(chat_id)
            if pending is not None and not pending.done():
                return web.json_response(
                    {"error": "a request for this chat is already in progress"},
                    status=409,
                )
            if len(self._pending) >= MAX_PENDING_REQUESTS:
                return web.json_response({"error": "too many pending requests"}, status=429)

            source = self.build_source(
                chat_id=chat_id,
                chat_name="Kindle Scribe",
                chat_type="dm",
                user_id=self._user_id,
                user_name=self._user_id,
                message_id=message_id or None,
            )
            # Profile/user are authenticated server-side. Profile routing or
            # caller-supplied body fields may not overwrite this owner binding.
            source.profile = self._profile_name
            sanitized_raw = {
                "text": text,
                "image_text": image_text,
                "user": self._user_id,
                "profile": self._profile_name,
                "chat_id": chat_id,
                "message_id": message_id,
            }
            event = MessageEvent(
                text=text,
                message_type=MessageType.TEXT,
                source=source,
                raw_message=sanitized_raw,
                message_id=message_id,
            )

            # Revalidate after reading/validating the body and immediately before
            # handing a tool-capable message to the gateway.
            dispatch_context = self._assert_active_binding(
                require_listener=self._listener_claim_id is not None
            )
            if not self._request_owner_matches(request, dispatch_context):
                return web.json_response({"error": "request rejected"}, status=409)
        except KindleRequestError as exc:
            return web.json_response({"error": str(exc)}, status=exc.status)
        except KindleOwnershipChanged:
            return web.json_response({"error": "owner changed"}, status=409)

        loop = asyncio.get_running_loop()
        future: "asyncio.Future[str]" = loop.create_future()
        self._pending[chat_id] = future

        task = self._create_profile_dispatch_task(event, dispatch_context)
        self._pending_tasks[chat_id] = task
        self._background_tasks.add(task)

        def _dispatch_done(done: "asyncio.Task[None]") -> None:
            self._background_tasks.discard(done)
            if self._pending_tasks.get(chat_id) is done:
                self._pending_tasks.pop(chat_id, None)
            if done.cancelled() or future.done():
                return
            try:
                error = done.exception()
            except asyncio.CancelledError:
                return
            if error is not None:
                future.set_exception(KindleDispatchError("gateway dispatch failed"))

        task.add_done_callback(_dispatch_done)
        completed = False
        try:
            reply = await asyncio.wait_for(future, timeout=self._reply_timeout)
            self._assert_active_binding(require_listener=self._listener_claim_id is not None)
            completed = True
            return web.json_response({"reply": reply})
        except asyncio.TimeoutError:
            return web.json_response({"error": "agent timed out"}, status=504)
        except KindleOwnershipChanged:
            return web.json_response({"error": "owner changed"}, status=409)
        except KindleDispatchError:
            return web.json_response({"error": "gateway dispatch failed"}, status=502)
        except asyncio.CancelledError:
            return web.json_response({"error": "cancelled"}, status=503)
        finally:
            if self._pending.get(chat_id) is future:
                self._pending.pop(chat_id, None)
            if not completed and not task.done():
                task.cancel()
                done, still_pending = await asyncio.wait(
                    {task},
                    timeout=PENDING_CLEANUP_TIMEOUT,
                )
                if done:
                    await asyncio.gather(*done, return_exceptions=True)
                if still_pending:
                    self._accepting_requests = False
                    self._set_fatal_error(
                        "kindle_pending_cleanup_failed",
                        "Kindle request task did not stop; listener ownership retained",
                        retryable=False,
                    )
            # A cancellation-resistant task stays tracked until its done
            # callback fires. Disconnect/reconnect sees it and retains the
            # listener claim instead of authorizing another profile or turn.
            if task.done() and self._pending_tasks.get(chat_id) is task:
                self._pending_tasks.pop(chat_id, None)


def _is_connected(config: PlatformConfig) -> bool:
    """Return profile-scoped readiness without cross-profile env fallback."""
    try:
        settings = _resolve_settings(_capture_runtime_context())
    except Exception:
        return False
    return bool(settings.token or settings.insecure)


def _build_adapter(config: PlatformConfig) -> KindleAdapter:
    return KindleAdapter(config)


def register(ctx) -> None:
    """Plugin entry point called by the Hermes plugin system."""
    ctx.register_platform(
        name="kindle",
        label="Kindle Scribe",
        adapter_factory=_build_adapter,
        check_fn=check_kindle_requirements,
        is_connected=_is_connected,
        required_env=[],  # Runtime permits explicit loopback-only insecure development.
        install_hint="pip install aiohttp",
        allowed_users_env="KINDLE_ALLOWED_USERS",
        allow_all_env="KINDLE_ALLOW_ALL_USERS",
        cron_deliver_env_var="KINDLE_HOME_CHANNEL",
        max_message_length=MAX_KINDLE_LENGTH,
        pii_safe=False,
        emoji="✍️",
        allow_update_command=True,
    )
