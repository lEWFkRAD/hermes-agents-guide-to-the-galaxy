from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "audit_hermes_environment.py"
SPEC = importlib.util.spec_from_file_location("audit_hermes_environment", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
AUDIT = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = AUDIT
SPEC.loader.exec_module(AUDIT)


def test_ci_audit_runs_pip_audit_on_the_installed_environment() -> None:
    assert AUDIT.audit_command()[:3] == [sys.executable, "-m", "pip_audit"]


def test_ci_audit_ignores_no_advisories() -> None:
    assert "--ignore-vuln" not in AUDIT.audit_command()
