#!/usr/bin/env python3
"""Audit the installed Hermes CI environment. No advisory exceptions.

The former CI-only cryptography exceptions expired on 2026-09-10 and were
retired with the move to Hermes commit fdcae6de. Any advisory now fails CI.
"""

from __future__ import annotations

import subprocess
import sys


def audit_command() -> list[str]:
    """Return the CI audit command; it never ignores an advisory."""
    return [sys.executable, "-m", "pip_audit", "--progress-spinner", "off"]


def main() -> int:
    return subprocess.run(audit_command(), check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
