from __future__ import annotations

import importlib.util
import sys
from datetime import date
from pathlib import Path

import pytest


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "audit_hermes_environment.py"
SPEC = importlib.util.spec_from_file_location("audit_hermes_environment", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
AUDIT = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = AUDIT
SPEC.loader.exec_module(AUDIT)


def test_exception_scope_and_expiry_are_exact() -> None:
    assert AUDIT.EXCEPTION_EXPIRES == date(2026, 9, 10)
    assert AUDIT.IGNORED_VULNERABILITIES == (
        "PYSEC-2026-3552",
        "PYSEC-2026-3553",
        "PYSEC-2026-3554",
    )


def test_ci_audit_ignores_only_reviewed_ids_before_expiry() -> None:
    command = AUDIT.audit_command(date(2026, 9, 9))
    ignored = [command[index + 1] for index, item in enumerate(command) if item == "--ignore-vuln"]
    assert ignored == list(AUDIT.IGNORED_VULNERABILITIES)
    assert command[:3] == [sys.executable, "-m", "pip_audit"]


def test_ci_audit_fails_closed_on_expiry_date() -> None:
    with pytest.raises(RuntimeError, match="expired on 2026-09-10"):
        AUDIT.audit_command(date(2026, 9, 10))
