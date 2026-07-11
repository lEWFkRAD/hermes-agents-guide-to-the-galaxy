# Hermes Agents Guide to the Galaxy

A handwriting-first notebook for the Kindle Scribe that talks to a local
[Hermes](https://127.0.0.1:8642) agent. You write with the pen (or type),
Hermes answers, and the reply forms on the page or in a side pane. Runs as a
tiny local web app because a stock Scribe can't sideload native apps — the
browser is the only channel, so the app is built to feel like one.

[![CI](https://github.com/lEWFkRAD/hermes-agents-guide-to-the-galaxy/actions/workflows/ci.yml/badge.svg)](https://github.com/lEWFkRAD/hermes-agents-guide-to-the-galaxy/actions/workflows/ci.yml)

Community contributions, including reviewed AI-assisted contributions, are
welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).
This project is available under the [MIT License](LICENSE).

Run `npm run lint` and `npm test` before contributing. Security-sensitive bugs
must be reported privately as described in [SECURITY.md](SECURITY.md).

## How it works

```
Kindle browser → diary bridge (:8791) → Kindle adapter (:8793) → Hermes Gateway
```

The Kindle never sees the Hermes API or adapter tokens. The bridge transcribes
the handwriting locally, submits text to Hermes's authenticated localhost-only
Kindle platform adapter, and receives the completed tool-assisted agent reply.

## Run it

First install and enable the optional Hermes platform plugin. It lives in
Hermes's persistent user-plugin directory—not inside the Hermes source tree—so
normal Hermes updates do not delete it:

```powershell
hermes plugins install lEWFkRAD/hermes-agents-guide-to-the-galaxy/kindle-plugin --enable
hermes gateway restart
Invoke-RestMethod http://127.0.0.1:8793/health
```

The installer prompts for `KINDLE_INGEST_TOKEN` and saves it in Hermes's local
environment file. Set `KINDLE_ALLOWED_USERS` to the stable identity used by the
bridge (for example, `jeff`). Keep `KINDLE_ALLOW_ALL_USERS` unset.

Then start the diary bridge:

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
| `DIARY_VISION_ENDPOINT` | `http://127.0.0.1:8005/v1/chat/completions` | Vision model used for handwriting OCR |
| `DIARY_VISION_MODEL` | `qwen3vl-8b` | Vision model name |
| `DIARY_OCR_CLEANUP_ENDPOINT` | `http://127.0.0.1:8020/v1/chat/completions` | Text model used to normalize uncertain OCR |
| `DIARY_OCR_CLEANUP_MODEL` | `qwen3.6-27b-nvfp4` | OCR cleanup model name |
| `KINDLE_ADAPTER_URL` | `http://127.0.0.1:8793/ingest` | Hermes Kindle platform ingest endpoint |
| `KINDLE_USER` | `kindle` | Stable Hermes user identity for the device |
| `DIARY_AUTH_TOKEN` | *(unset)* | If set, `/api/*` requires this secret. Open the diary once with `?k=<token>` — it's saved and sent on every call. Unset = open (LAN default). |
| `DIARY_REMOTE_KEY` | *(unset)* | Permanent key required for API and handwriting access through a public `*.ts.net` Funnel hostname. Bookmark `/remote/<key>`; LAN access remains unchanged. |

## Features

- **Pen input** tuned for e-ink — batched strokes, coalesced points, undo.
- **Two-stage handwriting OCR** — a vision model reads the ink, then Qwen3.6
  minimally corrects spacing and likely proper names before Hermes sees it. Raw
  and corrected transcriptions are retained with the diary entry.
- **Full Hermes tools** — the first-class Kindle platform uses normal gateway
  sessions and configured platform toolsets. Firm/person questions are grounded
  with client tools instead of answered from model memory.
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
| `POST /api/channel/reset` | Rotate the active Hermes channel session when New is pressed |
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

## Away from the LAN with Tailscale Funnel

A stock Kindle Scribe cannot install Tailscale. Tailscale Funnel gives it a
public HTTPS URL while `DIARY_REMOTE_KEY` provides a permanent, bookmark-carried
device secret. This does not depend on Kindle cookies or local storage.

1. Generate and persist a high-entropy key on the diary host:

   ```powershell
   $bytes = New-Object byte[] 18
   $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
   $rng.GetBytes($bytes)
   $rng.Dispose()
   $key = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
   [Environment]::SetEnvironmentVariable('DIARY_REMOTE_KEY', $key, 'User')
   ```

2. Restart the diary so it loads the saved key.

3. Enable HTTPS Funnel from an administrator shell:

   ```powershell
   tailscale funnel --yes --bg --https=443 http://127.0.0.1:8791
   ```

   If Tailscale prints a policy-approval URL, approve this node and rerun the
   command. Existing Serve/Funnel routes on other ports are preserved.

4. Print the permanent Kindle bookmark:

   ```powershell
   $key = [Environment]::GetEnvironmentVariable('DIARY_REMOTE_KEY', 'User')
   $dns = ((tailscale status --json | ConvertFrom-Json).Self.DNSName).TrimEnd('.')
   "https://$dns/remote/$key"
   ```

5. Verify the boundary before using it:

   - The full bookmark loads the diary and its sessions.
   - The same `*.ts.net/api/sessions` URL without `rk` returns `401`.
   - A wrong key returns `401`.
   - The office-LAN URL keeps its existing authentication behavior.

To disable public exposure without changing the diary configuration:

```powershell
tailscale funnel --https=443 off
```

Treat the complete bookmark as a password. Rotate `DIARY_REMOTE_KEY` immediately
if it is copied into chat, logs, screenshots, or any system you do not trust.

## Data & privacy

- Entries and handwriting images live under `data/` and are **git-ignored** —
  personal content never enters the repo.
- The bridge listens on the LAN with no auth by default. Fine for a home network.
  To lock it down, set `DIARY_AUTH_TOKEN` and open the diary with `?k=<token>` —
  the API then rejects anything without the secret (401). Required before exposing
  it beyond the LAN or before wiring it to tool-enabled agents that reach real data.
- For away-from-LAN Kindle access, configure `DIARY_REMOTE_KEY` before enabling
  Tailscale Funnel. Remote `*.ts.net` requests without the key receive `401`,
  including `/api/config`, session history, and stored handwriting images. The
  key is carried in the permanent `/remote/<key>` Kindle bookmark rather than
  cookies, query-string persistence, or local storage.
