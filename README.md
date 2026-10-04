# Hermes Agents Guide to the Galaxy

![Hermes Notebook across handwriting-first tablets](docs/assets/hermes-notebook-hero.png)

> **New to the project?** Start with the [Hermes Notebook user guide](docs/USER_GUIDE.md). It explains everyday Kindle use first and keeps installation, security, architecture, and maintenance in a technical section at the back.

Hermes Notebook is a handwriting-first companion for
[Hermes Agent](https://github.com/NousResearch/hermes-agent). Write naturally
on a Kindle Scribe, BOOX, or Android stylus tablet; keep the page offline-safe;
and send the recognized note into the same Hermes sessions, memory, skills,
tools, and personality used by its other channels.

The stock Kindle Scribe uses a browser surface because it cannot sideload native
apps. BOOX and Android stylus tablets use the native tester client being built in
[Hermes PR #61687](https://github.com/NousResearch/hermes-agent/pull/61687).

[![CI](https://github.com/lEWFkRAD/hermes-agents-guide-to-the-galaxy/actions/workflows/ci.yml/badge.svg)](https://github.com/lEWFkRAD/hermes-agents-guide-to-the-galaxy/actions/workflows/ci.yml)

Community contributions, including reviewed AI-assisted contributions, are
welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).
This project is available under the [MIT License](LICENSE).
Release history is tracked in [CHANGELOG.md](CHANGELOG.md); maintainers follow
the tag-gated process in [RELEASING.md](RELEASING.md).

Run `npm run lint` and `npm test` before contributing. Security-sensitive bugs
must be reported privately as described in [SECURITY.md](SECURITY.md).

## Platform status

| Surface | Status | Client |
| --- | --- | --- |
| Kindle Scribe | **Live** | Stock browser notebook, Live Page, Redline, and Journey |
| BOOX | **Tester build** | Native Android APK with pen/eraser capture and offline persistence |
| Android stylus tablets | **Tester build** | Native APK with on-device ML Kit handwriting recognition |
| iPadOS + Apple Pencil | **Planned** | Supported by the gateway metadata contract; native client not yet shipped |
| Desktop browser | **Development and review** | Useful for setup and smoke tests; not a substitute for e-ink QA |

## How it works

```
Kindle browser / BOOX / Android stylus tablet
        → private Notebook bridge
        → Kindle/Notebook adapter (:8793)
        → Hermes Gateway, sessions, memory, and tools
```

The device never sees a Hermes model credential. The bridge or native client
captures handwriting, preserves the page locally, and submits recognized text
through an authenticated private boundary. The localhost-only Notebook adapter
then creates a normal Hermes message event and returns the completed,
tool-assisted reply.

## Supported setup

The currently supported host baseline is intentionally conservative:

- **Node.js:** 20 or 22, matching CI. The diary has no npm runtime dependencies.
- **Host:** Windows 11 is the real-device reference environment. The Node server
  and tests also run on Linux; the included Task Scheduler, `.cmd`, PowerShell,
  and VBScript helpers are Windows-only and optional.
- **Hermes Agent:** compatibility is merge-gated against exact upstream commit
  `fdcae6debac4ad33adc449a4263433b389b563ef`. See
  [the pin and update policy](docs/HERMES_INTEGRATION.md). Configure the Gateway
  and enable the installed `kindle-scribe` plugin.
- **Devices:** a stock Kindle Scribe using its built-in browser is the validated
  production surface. BOOX and Android stylus tablets use the debug APK from
  PR #61687 and still require physical-device QA. Desktop browsers are useful
  for smoke tests but do not prove pen latency, palm rejection, or e-ink quality.

From a fresh clone, validate before configuring a device:

```powershell
npm ci --ignore-scripts
npm run lint
npm test
$env:DIARY_AUTH_TOKEN = [Guid]::NewGuid().ToString('N')
npm start
Invoke-RestMethod http://127.0.0.1:8791/api/config -Headers @{ "X-Diary-Auth" = $env:DIARY_AUTH_TOKEN }
```

The default notebook, local history, Live Page annotations,
Journey, Redline suggestions, and Kindle plugin are present on `main`.
Native Android/BOOX code currently lives with the upstream gateway
work in [Hermes PR #61687](https://github.com/NousResearch/hermes-agent/pull/61687).
Remote access is optional; read the
[deployment threat model](SECURITY.md#deployment-threat-model) first.

## Run it

First install and enable the optional Hermes platform plugin. It lives in
Hermes's persistent user-plugin directory—not inside the Hermes source tree—so
normal Hermes updates do not delete it:

```powershell
hermes plugins install lEWFkRAD/hermes-agents-guide-to-the-galaxy/kindle-plugin --enable
hermes gateway restart
$headers = @{ "X-Kindle-Token" = $env:KINDLE_INGEST_TOKEN }
Invoke-RestMethod http://127.0.0.1:8793/health -Headers $headers
```

The installer prompts for `KINDLE_INGEST_TOKEN` and saves it in Hermes's local
environment file. Set `KINDLE_ALLOWED_USERS` to the stable identity used by the
bridge (for example, `jeff`). Keep `KINDLE_ALLOW_ALL_USERS` unset. The health
endpoint intentionally requires the same token and attests the selected profile,
listener, and non-secret owner fingerprint before the bridge sends a note.

Generate a browser credential, then start the diary bridge. Persist the same
value in the service account's environment when using the scheduled launcher:

```powershell
$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
$env:DIARY_AUTH_TOKEN = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
```

```
npm start          # node server.mjs — listens on 0.0.0.0:8791
```

Then open `http://<this-machine-lan-ip>:8791/?k=<DIARY_AUTH_TOKEN>` once in the
Scribe's browser and bookmark it after pairing. Configuration is via environment
variables; either `DIARY_AUTH_TOKEN` or `DIARY_REMOTE_KEY` is required:

| Var | Default | Purpose |
| --- | --- | --- |
| `DIARY_PORT` | `8791` | Port the bridge listens on |
| `DIARY_HOST` | `0.0.0.0` | Bind address |
| `HERMES_HOME` | *(unset)* | Selected Hermes profile home. When set, Notebook data and backups default under this profile; when unset, the historical checkout-local layout is retained. |
| `HERMES_PROFILE_NAME` | *(inferred)* | Optional assertion for the selected profile (`default` or the named profile ID). Startup fails if it disagrees with `HERMES_HOME`. |
| `HERMES_CONFIG` | `<HERMES_HOME>/config.yaml` | Explicit config path. With a selected profile it must be that profile's exact config unless the development override below is enabled. |
| `DIARY_DATA_DIR` | profile `notebook/data` or checkout `data` | Active notebook state. Selected-profile paths cannot escape through `..`, a symlink, or a junction. |
| `DIARY_BACKUP_DIR` | profile `notebook/backups` or checkout `backups` | Backup destination; it must not overlap the active data directory. |
| `DIARY_DEV_ALLOW_PROFILE_PATH_OVERRIDE` | `false` | Development-only escape hatch for external data/config paths. Rejected when `NODE_ENV=production`. |
| `HERMES_ENDPOINT` | `http://127.0.0.1:8642/v1/chat/completions` | Upstream gateway |
| `DIARY_TEXT_MODEL` | `hermes-agent` | Model requested upstream |
| `DIARY_VISION_ENDPOINT` | `http://127.0.0.1:8005/v1/chat/completions` | Vision model used for handwriting OCR |
| `DIARY_VISION_MODEL` | `qwen3vl-8b` | Vision model name |
| `DIARY_OCR_CLEANUP_ENDPOINT` | `http://127.0.0.1:8020/v1/chat/completions` | Text model used to normalize uncertain OCR |
| `DIARY_OCR_CLEANUP_MODEL` | `qwen3.6-27b-nvfp4` | OCR cleanup model name |
| `KINDLE_ADAPTER_URL` | `http://127.0.0.1:8793/ingest` | Hermes Kindle platform ingest endpoint |
| `KINDLE_INGEST_HOST` | `127.0.0.1` | Adapter listener host. It must be a literal IPv4/IPv6 loopback address. |
| `KINDLE_INGEST_PORT` | `8793` | Adapter listener port. Give concurrently enabled profiles distinct ports. |
| `KINDLE_INGEST_TOKEN` | *(required)* | Profile-scoped shared secret for authenticated health and ingest. Set the same value in the bridge process and selected Hermes profile. |
| `KINDLE_INSECURE` | `false` | Explicit tokenless loopback development mode; never permits a non-loopback adapter bind. |
| `KINDLE_USER` | `kindle` | Stable Hermes user identity for the device |
| `KINDLE_REPLY_TIMEOUT` | `240` | Plain-decimal seconds (`0.01`–`300`, at most three fractional digits) used in the cross-runtime owner identity. |
| `DIARY_CHAT_TIMEOUT_MS` | `120000` | Timeout for ordinary model and OCR requests |
| `DIARY_STREAM_TIMEOUT_MS` | `300000` | Timeout for streaming model responses |
| `DIARY_ADAPTER_TIMEOUT_MS` | `KINDLE_REPLY_TIMEOUT * 1000 + 5000` (`245000` with defaults) | Integer outer timeout for Kindle adapter requests. An explicit value must be at least 5,000 ms greater than the reply timeout and no more than 600,000 ms. |
| `DIARY_WARM_TIMEOUT_MS` | `15000` | Timeout for background warm-up requests |
| `DIARY_AUTH_TOKEN` | *(required unless remote key is set)* | LAN browser credential for every `/api/*` and `/img/*` request. Open the diary once with `?k=<token>` so the browser can pair. |
| `DIARY_REMOTE_KEY` | *(required unless LAN token is set)* | Permanent bearer key for Funnel or remote-key-only deployments. Every protected request needs this key or `DIARY_AUTH_TOKEN`, regardless of peer IP, `Host`, `Origin`, or proxy headers. Bookmark `/remote/<key>`. |
| `DIARY_LIVE_WRITE_TOKEN` | *(generated locally)* | Optional override for the Live Page publisher secret. With no override, the bridge creates `live-page-write.token` in the active data directory. |

### Multiple Hermes profiles

The plugin resolves profile identity and secrets at adapter-construction time,
then revalidates the selected profile's `.env` before dispatch and before
returning a reply. Caller-supplied `user` or `profile` fields cannot select a
different Hermes profile.

For each concurrently enabled profile, install/enable the plugin under that
profile, assign a distinct `KINDLE_INGEST_PORT`, and launch a separate companion
bridge with matching `HERMES_HOME`, token, user, adapter host/port, and
`KINDLE_ADAPTER_URL`. Give each bridge a distinct `DIARY_PORT`. Its default data,
backups, and Hermes config then remain under that profile home. A listener-port
collision or health-identity mismatch fails closed instead of borrowing another
profile's adapter.

Before state initialization, each bridge acquires the fixed reserved
`.hermes-notebook-owner` claim inside its canonical data root, so alternate
local mount paths still converge on the same storage-relative lock. A live root
has one process owner. Valid stale claims recover only within the same machine,
boot, and PID namespace after OS process-start identity and nonce-barrier
checks; foreign or malformed claims fail closed.
Shutdown releases ownership only after requests and persistence queues quiesce.

For example, prefix profile-scoped plugin/config commands with
`hermes -p research` for a named `research` profile, then restart the gateway
after configuring the intended profiles. Export that profile's values only into
its companion process; do not rely on one machine-wide token for several
profiles.

#### Upgrading checkout-local state

Version 0.1 ignored `HERMES_HOME` and stored state under checkout `data/` and
`backups/`. Version 0.2 refuses to start a selected profile with unresolved
empty or populated targets while either legacy directory contains state. A
matching migration receipt is required, so a successful upgrade cannot silently
present an empty or unrelated notebook.

Stop every bridge using the checkout, make an independent backup, export the
destination profile's `HERMES_HOME` (and optional `HERMES_PROFILE_NAME`), then
run `npm run migrate:profile`. The command rejects symlinks and populated,
unowned targets; copies and hashes each file through a same-filesystem staging
directory; atomically installs each verified profile tree; and writes migration
receipts. It never deletes the legacy source. Start the bridge only after
inspecting the reported destination and verifying the copied notebook. While
the preserved legacy tree exists, startup rehashes it against the receipt and
refuses to hide any write made later by an older checkout.

## Features

- **Multiple handwriting surfaces** — a stock-browser Kindle experience plus
  a native Android/BOOX tester client connected through the same Notebook
  gateway and Hermes session model.
- **Pen input** tuned for e-ink — batched strokes, coalesced points, undo.
- **Multi-read handwriting OCR** — tightly cropped, lossless ink is read twice,
  then reconciled for spacing, likely wording, alternatives, and calibrated
  confidence before Hermes sees it. Raw and cleaned transcriptions are retained
  with the diary entry.
- **Uncertainty-aware handwriting** — raw and cleaned readings remain visible
  to Hermes. Names, dates, amounts, commands, and unfamiliar search terms should
  be clarified before broad or consequential tool work.
- **Native offline ink foundation** — the Android/BOOX tester build captures
  pressure, tilt, orientation, historical samples, eraser and palm-cancel input,
  then atomically saves the page before network delivery matters.
- **Full Hermes tools** — the first-class Kindle platform uses normal gateway
  sessions and configured platform toolsets. Firm/person questions are grounded
  with client tools instead of answered from model memory.
- **Two display modes** (toggle in Options):
  - **Split** — writing on top, Hermes's latest reply in a pane below.
  - **Riddle** — your ink dissolves and Hermes's words form on the page itself.
- **Reliable reply delivery** — Hermes completes its tool-assisted turn, then the
  bridge sends the full reply in Kindle-safe chunks without adding replay delays.
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
- **Hermes Live Page** — tap **Live** to open one living HTML document. Hermes
  can reshape the same page as the conversation develops: a table, visual map,
  client brief, working canvas, or any other self-contained HTML/CSS layout.

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
| `GET /api/live-page` | Read the current revisioned Live Page; supports `If-None-Match` / `304` |
| `GET /api/live-page/content` | Render the current sanitized HTML document inside the sandboxed Live Page |
| `PUT /api/live-page` | Publish from loopback with the private `x-diary-live-write` token |

## Hermes Live Page

The Live Page lives at `/live` and is linked from the notebook header. It is
not a status tracker or a fixed set of templates. It is one mutable HTML file
that Hermes reads, edits, and republishes as the work changes. On a remote
Kindle bookmark the app preserves the secret path as `/remote/<key>/live`, and
**Notebook** returns to `/remote/<key>`.

The Kindle channel tells Hermes to maintain `live-page-source.html` in the
active data directory and publish it before replying whenever the user asks to
build or change the Live
Page. The source may use self-contained HTML and CSS. The publisher removes
scripts, forms, event handlers, embedded frames, and external URLs; the result
then renders inside a scriptless iframe with a restrictive content security
policy. The Kindle receives the evolving document but never the publisher
credential.

Publish a living HTML file manually after the bridge is running:

```powershell
node scripts/publish-live-page.mjs examples/live-page.example.html
```

The server creates a private publisher token under the active data directory on
first start. Publishing requires that token over a loopback socket; the remote
bookmark key alone never authorizes a write. A Kindle, LAN browser, or public
Funnel request can read the authenticated page but cannot replace it. The shell
checks every 10 seconds and loads a new
HTML revision only when Hermes has actually changed the document. Identical
publishes keep the same SHA-256 revision and do not repaint the e-ink page.

## Always-on setup (Windows)

- `run-diary.cmd` — auto-restart wrapper for the bridge.
- `launch-hidden.vbs` — launches the wrapper with no console window.
- Startup shortcut (no elevation): create a `.lnk` in
  `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup` pointing
  `wscript.exe` at `launch-hidden.vbs`.
- `Hermes-Diary.task.xml` / `Hermes-Diary-Archive.task.xml` — Task Scheduler
  templates (need an elevated `schtasks /create /xml`). Before importing,
  replace `__INSTALL_DIR__` with the folder you cloned into and `__USER__`
  with your `DOMAIN\user` (e.g. from `whoami`). These are single-profile
  convenience templates: do not reuse their fixed task names for concurrent
  profiles. Use distinct launchers/tasks with profile-specific environment and
  never place adapter tokens in task arguments or XML.

## Away from the LAN with Tailscale Funnel

Read the [deployment threat model](SECURITY.md#deployment-threat-model) before
enabling public access. Funnel uses a bearer bookmark, not per-user identity.

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
   - `/api/config`, `/api/sessions`, and `/img/*` without either configured
     credential return `401`, even with a forged, missing, or trailing-dot Host.
   - A wrong key returns `401`.
   - LAN clients use the same remote bookmark/key, or `DIARY_AUTH_TOKEN` when
     that separate token is configured.

To disable public exposure without changing the diary configuration:

```powershell
tailscale funnel --https=443 off
```

Treat the complete bookmark as a password. Rotate `DIARY_REMOTE_KEY` immediately
if it is copied into chat, logs, screenshots, or any system you do not trust.

## Backups

Run `npm run backup` to create a verified, timestamped snapshot. With a selected
`HERMES_HOME`, snapshots default to that profile's `notebook/backups`; legacy
checkout mode uses `backups/`. Each generation includes a SHA-256 manifest, and
the newest 14 generations are retained by default. Set `DIARY_BACKUP_DIR` to a
canonical, non-overlapping destination and `DIARY_BACKUP_KEEP` to change
retention. Each run uses a process-unique stage and UUID-suffixed generation,
then publishes atomically only when complete path/type/size/SHA-256 manifests
match before and after the copy. Concurrent mutation or a same-timestamp run
cannot publish or overwrite a generation. The included archive task performs
image-retention maintenance; it is not a substitute for scheduling and
verifying `npm run backup` separately.

## Data & privacy

- Entries and handwriting images live under the selected profile's
  `notebook/data` (or checkout `data/` in legacy mode). Both layouts are outside
  release artifacts, and checkout data is **git-ignored**.
- The bridge refuses to start without `DIARY_AUTH_TOKEN` or `DIARY_REMOTE_KEY`.
  Every `/api/*` and `/img/*` request needs one of those explicit credentials;
  peer IP, `Host`, `Origin`, and forwarding headers never authorize access.
- For away-from-LAN Kindle access, configure `DIARY_REMOTE_KEY` before enabling
  Tailscale Funnel. The bridge does not trust client-controlled `Host` or
  forwarding headers: every protected request without that key or
  `DIARY_AUTH_TOKEN` receives `401`, including
  `/api/config`, session history, and stored handwriting images. The key is
  carried in the permanent `/remote/<key>` Kindle bookmark rather than cookies,
  query-string persistence, or local storage.

## Delivery recovery and device revocation

Live Page sends are persisted as uncertain before dispatch. A timeout or bridge
restart never silently releases them for replay, even with a new send ID or
resend flag. Completed replies still replay from the cache. Ink remains visible;
check Hermes history before explicitly beginning new work after an uncertain
delivery. This protects Live Page sends; older notebook send paths do not yet
provide the same durable delivery contract.

`DIARY_DEVICE_KEYS` is an optional private JSON array of `{id,key,revoked}` entries
(maximum 32). Generate independent random keys of at least 32 characters. Use
`/remote/<device-key>` bookmarks. Set one entry's `revoked` to true and restart
the owned bridge to revoke that device without rotating the others. Device keys
must differ from each other and from legacy credentials. Legacy shared keys
remain valid until separately removed. All device keys grant the same notebook
access; none grants the private Live Page publisher capability. Never commit keys.

Physical acceptance remains pending: stock Kindle sleep/wake, airplane-mode
reconnect, browser reload, lost server response, and ink restoration. Desktop
synthetic tests do not certify Kindle storage or e-ink behavior.
