from __future__ import annotations

from pathlib import Path

import yaml


PLUGIN_DIR = Path(__file__).resolve().parents[2] / "kindle-plugin"


def test_plugin_package_has_required_files() -> None:
    assert {"__init__.py", "adapter.py", "plugin.yaml", "after-install.md"} <= {
        path.name for path in PLUGIN_DIR.iterdir() if path.is_file()
    }


def test_manifest_is_installer_ready_and_collision_free() -> None:
    raw = (PLUGIN_DIR / "plugin.yaml").read_bytes()
    assert not raw.startswith(b"\xef\xbb\xbf")

    manifest = yaml.safe_load(raw.decode("utf-8"))
    assert manifest["manifest_version"] == 1
    assert manifest["name"] == "kindle-scribe"
    assert manifest["kind"] == "platform"
    assert manifest["name"] != "kindle-platform"
    assert any(
        entry.get("name") == "KINDLE_INGEST_TOKEN" and entry.get("secret") is True
        for entry in manifest["requires_env"]
    )


def test_install_guidance_uses_persistent_plugin_installer() -> None:
    readme = (PLUGIN_DIR.parents[0] / "README.md").read_text(encoding="utf-8")
    assert (
        "hermes plugins install "
        "lEWFkRAD/hermes-agents-guide-to-the-galaxy/kindle-plugin --enable"
    ) in readme
    assert "hermes-agent/plugins/platforms/kindle" not in readme
