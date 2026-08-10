#!/usr/bin/env python3
"""Smoke-test the root-layout Kindle plugin ZIP without extracting it."""

from __future__ import annotations

import argparse
import re
import zipfile
from pathlib import Path


def smoke(archive_path: Path, expected_version: str) -> None:
    with zipfile.ZipFile(archive_path) as archive:
        names = {name.replace("\\", "/") for name in archive.namelist() if not name.endswith("/")}
        required = {"LICENSE", "__init__.py", "adapter.py", "after-install.md", "plugin.yaml"}
        missing = required - names
        if missing:
            raise ValueError(f"plugin ZIP is missing: {', '.join(sorted(missing))}")
        if any("/" in name for name in names):
            raise ValueError("plugin ZIP is not rooted directly at the plugin files")

        for name in sorted(entry for entry in names if entry.endswith(".py")):
            source = archive.read(name).decode("utf-8")
            compile(source, name, "exec")

        manifest = archive.read("plugin.yaml").decode("utf-8")
        version = re.search(r"^version:\s*(\S+)\s*$", manifest, re.MULTILINE)
        if not version or version.group(1) != expected_version:
            raise ValueError("plugin manifest version does not match the release")
        if not re.search(r"^\s+password:\s+true\s*$", manifest, re.MULTILINE):
            raise ValueError("plugin manifest is missing the password credential contract")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()
    smoke(args.archive, args.version)
    print(f"Plugin archive smoke test passed: {args.archive.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
