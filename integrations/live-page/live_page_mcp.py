#!/usr/bin/env python3
"""First-class Hermes tools for reading and evolving the Kindle Live Page."""
from __future__ import annotations

import json
import os
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP


def _watch_gateway_ancestors() -> None:
    """Exit when the Windows gateway process tree disappears."""
    if sys.platform != "win32":
        return
    import ctypes

    def watch(ppid: int) -> None:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        ntdll = ctypes.WinDLL("ntdll")
        kernel32.OpenProcess.restype = ctypes.c_void_p
        synchronize = 0x00100000
        query_limited = 0x1000
        handles = []
        parent = kernel32.OpenProcess(synchronize | query_limited, False, ppid)
        if not parent:
            return
        handles.append(parent)

        class ProcessBasicInfo(ctypes.Structure):
            _fields_ = [
                ("Reserved1", ctypes.c_void_p),
                ("PebBaseAddress", ctypes.c_void_p),
                ("Reserved2", ctypes.c_void_p * 2),
                ("UniqueProcessId", ctypes.c_void_p),
                ("InheritedFromUniqueProcessId", ctypes.c_void_p),
            ]

        info = ProcessBasicInfo()
        if ntdll.NtQueryInformationProcess(
            ctypes.c_void_p(parent), 0, ctypes.byref(info), ctypes.sizeof(info), None
        ) == 0 and info.InheritedFromUniqueProcessId:
            grandparent = kernel32.OpenProcess(synchronize, False, int(info.InheritedFromUniqueProcessId))
            if grandparent:
                handles.append(grandparent)

        array = (ctypes.c_void_p * len(handles))(*handles)
        kernel32.WaitForMultipleObjects(len(handles), array, False, 0xFFFFFFFF)
        os._exit(0)

    threading.Thread(target=watch, args=(os.getppid(),), daemon=True).start()


_watch_gateway_ancestors()

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.environ.get("DIARY_DATA_DIR") or REPO_ROOT / "data")
SOURCE_FILE = DATA_DIR / "live-page-source.html"
TOKEN_FILE = DATA_DIR / "live-page-write.token"
PORT = int(os.environ.get("DIARY_PORT") or "8791")
BASE_URL = f"http://127.0.0.1:{PORT}"

mcp = FastMCP("live-page")


def _request(path: str, *, method: str = "GET", body: dict[str, Any] | None = None) -> dict[str, Any]:
    headers = {"accept": "application/json"}
    payload = None
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        headers["content-type"] = "application/json; charset=utf-8"
    if method == "PUT":
        token = os.environ.get("DIARY_LIVE_WRITE_TOKEN", "").strip()
        if not token:
            token = TOKEN_FILE.read_text(encoding="utf-8").strip()
        headers["x-diary-live-write"] = token
    request = urllib.request.Request(BASE_URL + path, data=payload, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        try:
            message = json.loads(detail).get("error", detail)
        except json.JSONDecodeError:
            message = detail
        raise RuntimeError(f"Live Page returned HTTP {error.code}: {message}") from error


def _publish(html: str) -> dict[str, Any]:
    if not isinstance(html, str) or not html.strip():
        raise ValueError("html must be a non-empty string")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    temp = SOURCE_FILE.with_suffix(".html.tmp")
    temp.write_text(html, encoding="utf-8")
    try:
        result = _request("/api/live-page", method="PUT", body={"html": html})
        os.replace(temp, SOURCE_FILE)
    finally:
        if temp.exists():
            temp.unlink(missing_ok=True)
    page = result["page"]
    return {
        "ok": True,
        "title": page["title"],
        "revision": page["revision"],
        "updated_at": page["updatedAt"],
        "message": "The living HTML page was published and will appear on the Kindle automatically.",
    }


@mcp.tool()
def live_page_read() -> dict[str, Any]:
    """Read the current editable Live Page HTML before evolving it."""
    metadata = _request("/api/live-page")
    html = SOURCE_FILE.read_text(encoding="utf-8") if SOURCE_FILE.exists() else ""
    return {"page": metadata.get("page", {}), "html": html}


@mcp.tool()
def live_page_publish(html: str) -> dict[str, Any]:
    """Publish a complete self-contained HTML/CSS document to the Kindle Live Page.

    Use this when creating the page or substantially changing its structure. Self-contained
    scripts, forms, controls, and event handlers are preserved for isolated Interact mode.
    Embedded frames and external network URLs are stripped by the server. The editable
    source is retained so later turns can evolve the same page.
    """
    return _publish(html)


@mcp.tool()
def live_page_patch(find: str, replace: str, count: int = 1) -> dict[str, Any]:
    """Evolve the existing Live Page by replacing exact source text and republishing.

    Read the source first. Use a specific `find` string. With the default count of 1,
    the string must occur exactly once so an ambiguous edit cannot damage the page.
    """
    if not SOURCE_FILE.exists():
        raise FileNotFoundError("No editable Live Page source exists; use live_page_publish first")
    if not isinstance(find, str) or not find:
        raise ValueError("find must be a non-empty string")
    if not isinstance(replace, str):
        raise ValueError("replace must be a string")
    if not isinstance(count, int) or count < 1 or count > 50:
        raise ValueError("count must be between 1 and 50")
    html = SOURCE_FILE.read_text(encoding="utf-8")
    occurrences = html.count(find)
    if occurrences < count:
        raise ValueError(f"find text occurs {occurrences} times, fewer than requested count {count}")
    if count == 1 and occurrences != 1:
        raise ValueError(f"find text occurs {occurrences} times; make it more specific")
    return _publish(html.replace(find, replace, count))


@mcp.tool()
def live_page_status() -> dict[str, Any]:
    """Return the current Live Page title, revision, and update time without its HTML."""
    return _request("/api/live-page").get("page", {})


if __name__ == "__main__":
    mcp.run(transport="stdio")
