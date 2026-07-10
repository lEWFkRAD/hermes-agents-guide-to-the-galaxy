# Hermes Agents Guide to the Galaxy

A handwriting-first notebook for the Kindle Scribe that talks to a local
[Hermes](https://127.0.0.1:8642) agent. You write with the pen (or type),
Hermes answers, and the reply forms on the page or in a side pane. Runs as a
tiny local web app because a stock Scribe can't sideload native apps — the
browser is the only channel, so the app is built to feel like one.

## How it works

```
Kindle Scribe browser  ──►  bridge (this app, :8791)  ──►  Hermes gateway (:8642)
```

The Kindle never sees the Hermes API token — the bridge loads it server-side
(from `API_SERVER_KEY` in `%LOCALAPPDATA%\hermes\config.yaml`, or the
`HERMES_TOKEN` / `HERMES_API_KEY` / `API_SERVER_KEY` env vars) and adds it to
the upstream request.

## Run it

```
npm start          # node server.mjs — listens on 0.0.0.0:8791
```

Then open `http://<this-machine-lan-ip>:8791/` in the Scribe's browser and
bookmark it. Config is via env vars (all optional):

| Var | Default | Purpose |
| --- | --- | --- |
| `DIARY_PORT` | `8791` | Port the bridge listens on |
| `DIARY_HOST` | `0.0.0.0` | Bind address |
| `HERMES_ENDPOINT` | `http://127.0.0.1:8642/v1/chat/completions` | Upstream gateway |
| `DIARY_TEXT_MODEL` | `hermes-agent` | Model requested upstream |
| `DIARY_AUTH_TOKEN` | *(unset)* | If set, `/api/*` requires this secret. Open the diary once with `?k=<token>` — it's saved and sent on every call. Unset = open (LAN default). |

## Features

- **Pen input** tuned for e-ink — batched strokes, coalesced points, undo.
- **Two display modes** (toggle in Options):
  - **Split** — writing on top, Hermes's latest reply in a pane below.
  - **Riddle** — your ink dissolves and Hermes's words form on the page itself.
- **Live streaming** — the reply appears token-by-token as Hermes generates it
  (falls back to wait-then-reveal if the browser can't stream; toggle in Options).
- **Landscape mode** — rotates the whole UI for a wider writing surface.
- **Sessions / History** — every entry is a conversation with full context;
  browse, reopen, continue, or delete past entries in the History popup.
- **Explicit session boundaries** — tapping **New** immediately assigns a fresh
  Kindle/Hermes thread identity. Reopening an entry restores its original agent
  thread, so context never leaks between notebook entries.
- **Pre-warm** — a warm-up ping fires on page open and pen-down so the model is
  hot by the time you hit Send, avoiding cold-start latency.
- **Image retention** — handwriting is stored as files (not inline), and an
  optional nightly job archives images older than 7 days.
- **Artifact workspaces (foundation release)** — import an image or sanitized
  HTML page, draw vector annotations over it, label the annotation intent, and
  ask the real Hermes Kindle channel for a structured change proposal. Workspace
  state, artifact revisions, annotations, proposals, and audit events persist
  locally under `data/workspaces/`.

## Endpoints

| Route | Purpose |
| --- | --- |
| `POST /api/send` | Send a note; supports `stream: true` for live streaming |
| `GET /api/sessions` | List entries |
| `GET /api/sessions/:id` | Fetch one entry's full thread |
| `POST /api/sessions/:id/delete` | Delete an entry |
| `POST /api/warm` | Wake the model (fire-and-forget) |
| `POST /api/maintenance/archive?days=N` | Archive images older than N days |
| `GET /img/:name` | Serve a stored handwriting image (hot dir, then archive) |
| `GET/POST /api/workspaces` | List or create artifact workspaces |
| `GET /api/workspaces/:id` | Load a workspace with artifacts and proposals |
| `POST /api/workspaces/:id/artifacts` | Import a sanitized HTML or image artifact |
| `POST /api/workspaces/:id/annotations` | Save normalized vector ink and its intent |
| `POST /api/workspaces/:id/proposals` | Create a revision-bound proposal |
| `POST /api/workspaces/:id/proposals/:proposalId/analyze` | Ask Hermes for structured proposed changes |
| `GET /api/artifacts/:id/content` | Render artifact content with restrictive security headers |

## Always-on setup (Windows)

- `run-diary.cmd` — auto-restart wrapper for the bridge.
- `launch-hidden.vbs` — launches the wrapper with no console window.
- Startup shortcut (no elevation): create a `.lnk` in
  `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup` pointing
  `wscript.exe` at `launch-hidden.vbs`.
- `Hermes-Diary.task.xml` / `Hermes-Diary-Archive.task.xml` — Task Scheduler
  templates (need an elevated `schtasks /create /xml`). Before importing,
  replace `__INSTALL_DIR__` with the folder you cloned into and `__USER__`
  with your `DOMAIN\user` (e.g. from `whoami`).

## Data & privacy

- Entries and handwriting images live under `data/` and are **git-ignored** —
  personal content never enters the repo.
- The bridge listens on the LAN with no auth by default. Fine for a home network.
  To lock it down, set `DIARY_AUTH_TOKEN` and open the diary with `?k=<token>` —
  the API then rejects anything without the secret (401). Required before exposing
  it beyond the LAN or before wiring it to tool-enabled agents that reach real data.
