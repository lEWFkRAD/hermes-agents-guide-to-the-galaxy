#!/usr/bin/env python3
"""Audit the installed Hermes CI environment with narrow expiring exceptions."""

from __future__ import annotations

import subprocess
import sys
from datetime import date, datetime, timezone


EXCEPTION_EXPIRES = date(2026, 9, 10)
IGNORED_VULNERABILITIES = (
    "PYSEC-2026-3552",
    "PYSEC-2026-3553",
    "PYSEC-2026-3554",
)


def audit_command(today: date | None = None) -> list[str]:
    """Return the CI audit command, failing closed once the exception expires."""
    audit_date = today or datetime.now(timezone.utc).date()
    if audit_date >= EXCEPTION_EXPIRES:
        raise RuntimeError(
            "Hermes cryptography audit exceptions expired on "
            f"{EXCEPTION_EXPIRES.isoformat()}; update the reviewed Hermes pin"
        )

    command = [sys.executable, "-m", "pip_audit", "--progress-spinner", "off"]
    for vulnerability_id in IGNORED_VULNERABILITIES:
        command.extend(("--ignore-vuln", vulnerability_id))
    return command


def main() -> int:
    try:
        command = audit_command()
    except RuntimeError as error:
        print(error, file=sys.stderr)
        return 1

    print(
        "CI-only Hermes test-host exceptions (release ignores none): "
        + ", ".join(IGNORED_VULNERABILITIES),
        flush=True,
    )
    return subprocess.run(command, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
