# Hermes Notebook User Guide

This guide explains how to use the Hermes Notebook companion in everyday language. The complete browser experience currently runs on Kindle Scribe. Native BOOX and Android stylus clients are in physical-device testing, and iPadOS is a planned target. Installation, security, architecture, and maintenance are collected in the technical section at the back.

## What this gives you

The companion turns a handwriting tablet into a writing and review surface for Hermes. You can write naturally, mark a page, send the work to Hermes, and read the answer on the same device.

You can use it to:

- ask questions in handwriting;
- circle, underline, or point at exact parts of a Live Page;
- turn notes into tasks, email drafts, summaries, or workpaper notes;
- ask Hermes to create or update a visual Live Page;
- request a Redline suggestion without changing the original page; and
- revisit earlier page and ink revisions through Journey.

The Kindle is the writing and display surface. The computer running the bridge and Hermes does the processing.

## Before you begin

Someone must install and start the bridge on a computer before the Kindle can use it. If that has already been done, you only need:

1. The permanent Kindle bookmark supplied by the person who installed it.
2. A connection to the same network, or the protected remote bookmark if remote access was configured.
3. The computer, diary bridge, and Hermes Gateway running.

Treat a protected bookmark like a password. Do not share it or include it in screenshots.

## Your first note

1. On Kindle, open the saved Hermes bookmark. On Android or BOOX, open the native Notebook app.
2. Tap **New** if you want a fresh conversation.
3. Write your question or instruction with the Scribe pen.
4. Tap **Send**.
5. Leave the page open while Hermes reads the handwriting and completes the request.
6. Read the response card at the bottom of the screen.

Your ink stays visible after a successful send. This makes it clear what Hermes received and prevents a brief network problem from making your work appear lost.

## Writing instructions Hermes can understand

Short, direct instructions work best. For example:

- “Summarize this in five bullets.”
- “Turn the circled items into tasks.”
- “Draft an email to the client. Do not send it.”
- “Build a one-page status dashboard.”
- “What does this number mean?”

Hermes receives the handwriting image, the current page, and the exact page elements touched by your marks. If a name, date, amount, or instruction is hard to read, Hermes should identify the uncertainty instead of silently guessing.

## Marking a Live Page

A Live Page is an HTML document displayed beneath the writing layer. It can contain a report, checklist, table, dashboard, workpaper, or other structured output.

To comment on a specific part of the page:

1. Open **Pen**.
2. Circle, underline, cross out, or point at the relevant content.
3. Add a short handwritten instruction if needed.
4. Tap **Send** or choose **Redline**.

The bridge records which text and page element the ink touches. Hermes uses that connection together with the visible mark, so it does not have to guess which paragraph or number you meant.

### Drawing controls

The Pen menu provides controls for:

- drawing and erasing;
- undoing the latest ink;
- selecting ink with the lasso;
- moving, rotating, copying, or deleting a selection;
- asking Hermes about selected ink; and
- clearing all ink after confirmation.

Controls may be compacted on smaller screens, but they keep large touch targets for the Kindle browser.

## Live Page changes

Hermes can create a new Live Page or update the current one when the request calls for it. A successful change becomes a new revision.

The system keeps the page and its ink together. It does not clear the visible ink merely because a request was sent. Ink is rolled over only when a genuinely new page revision is safely available.

If an update fails, the last valid page remains in place.

## Redline suggestions

Use **Redline** when you want editorial advice without allowing the page to be changed.

1. Mark the sentence, number, or section you want reviewed.
2. Tap **Redline**.
3. Hermes returns one concise proposed replacement.
4. If replacement is inappropriate, Hermes returns one concise explanation instead.

The suggestion appears in a separate Redline response card. Redline does not apply the suggestion, publish HTML, erase the ink, or overwrite the original page. You decide what happens next.

## Journey and history

**History** reopens previous Hermes conversations. A reopened conversation keeps its Hermes thread, while **New** starts a separate thread.

**Journey** shows how the Live Page and handwriting developed across revisions. You can:

- begin at the latest state;
- play or pause the sequence;
- move through the timeline;
- revisit earlier page revisions; and
- see ink in the context where it was originally written.

Journey is a review and recovery aid. It does not rewrite the current page.

## What happens when you tap Send

In plain English:

1. The Kindle finishes syncing the visible pen strokes.
2. The bridge gives the send a unique identity.
3. The server claims that identity before Hermes performs the work.
4. Handwriting is transcribed and combined with the page and marked targets.
5. Hermes completes the request and returns the result.
6. The send is recorded as complete and the exact strokes are marked as processed.
7. If the response was lost in transit, retrying returns the saved result instead of repeating the work.

## Everyday troubleshooting

### The page will not open

- Confirm that the host computer is awake.
- Confirm that the diary bridge and Hermes Gateway are running.
- If you are at the office or home, confirm the Kindle is on the expected network.
- If you are away, use the protected remote bookmark supplied by the installer.
- Do not replace or shorten the protected bookmark.

### Send says it is finishing ink sync

Wait a moment and tap **Send** again. The bridge will not send while the latest pen strokes are still being synchronized.

### Hermes could not send the annotation

Your ink should remain visible. Check the connection and retry. The unique send identity prevents the same completed request from running twice.

### The page looks old after an update

Close and reopen the permanent bookmark. If the old interface remains, the installer may need to restart the bridge or verify the current browser asset version.

### Handwriting was misunderstood

Write the important name, amount, or date again with more spacing. Add a short printed clarification beside it, then resend. Never rely on an uncertain transcription for a critical amount or instruction without checking it.

### A Live Page update failed

The previous valid page should remain available. Retry only after checking the connection. If the problem continues, give the installer the time of the failure and a description that does not expose private client information.

## Privacy habits for everyday users

- Treat the Kindle bookmark as private when it contains an access key.
- Lock the Kindle when it is unattended.
- Do not photograph or share pages containing client or personal information.
- Confirm important names, dates, and amounts in Hermes’s response.
- Use Redline when you want advice without changing the source page.
- Report suspected exposure privately, not in a public GitHub issue.

---

# Technical section

The remaining sections are for the person installing, maintaining, auditing, or contributing to the system.

## System requirements

The reference deployment uses:

- Windows 11 on the host computer;
- Node.js 20 or 22;
- Python 3.11 or later;
- a stock Kindle Scribe browser;
- Hermes Agent with the Kindle plugin enabled; and
- local handwriting vision and cleanup endpoints when those features are used.

The Node bridge is intentionally reachable by the Kindle. The Hermes Kindle adapter must remain bound to localhost and must never be exposed publicly.

## Install the repository

```text
git clone https://github.com/lEWFkRAD/hermes-agents-guide-to-the-galaxy.git
cd hermes-agents-guide-to-the-galaxy
npm ci --ignore-scripts
python -m pip install --requirement requirements-dev.txt
```

Install and enable the Hermes platform plugin:

```text
hermes plugins install lEWFkRAD/hermes-agents-guide-to-the-galaxy/kindle-plugin --enable
hermes gateway restart
```

The plugin installer prompts for `KINDLE_INGEST_TOKEN`. Configure
`KINDLE_ALLOWED_USERS` with the stable user identity accepted by the adapter.
The companion bridge must receive the same token in its own process environment;
the adapter health endpoint is authenticated and must match the bridge's selected
profile, listener, and owner fingerprint before any note is dispatched.

Before starting the bridge, set at least one high-entropy browser credential.
Use `DIARY_AUTH_TOKEN` for a LAN bookmark or `DIARY_REMOTE_KEY` for the
host-independent `/remote/<key>` bookmark. The bridge refuses to start without
one of them.

Start the bridge:

```text
npm start
```

By default, the diary listens on `0.0.0.0:8791`. The Hermes adapter remains localhost-only on its separately configured endpoint.

### Multiple Hermes profiles

Launch each profile's bridge with its selected `HERMES_HOME`. A named profile
uses `<Hermes root>/profiles/<name>`; `HERMES_PROFILE_NAME` may be set as an
additional assertion. Assign every concurrently enabled profile a distinct
`KINDLE_INGEST_PORT` and every browser bridge a distinct `DIARY_PORT`, then keep
`KINDLE_ADAPTER_URL`, `KINDLE_USER`, and `KINDLE_INGEST_TOKEN` consistent with
that profile. The default data and backups become
`<HERMES_HOME>/notebook/data` and `<HERMES_HOME>/notebook/backups`.

Profile and user fields in a browser request are not routing authority. The
adapter binds them server-side, refreshes the selected profile's secret scope,
and refuses listener collisions or identity changes. Do not put one profile's
token in a machine-wide environment variable used by another profile.

If upgrading a v0.1 checkout that already has `data/` or `backups/`, stop the
bridge before selecting `HERMES_HOME`. Set the destination profile environment,
make an independent backup, and run `npm run migrate:profile`. The migration
copies and verifies state into that profile, writes an ownership receipt, and
leaves the legacy source untouched. Normal startup refuses an empty or populated
profile target without a matching receipt while legacy state remains, so it
cannot silently show a blank or unrelated notebook.

Each bridge also holds an exclusive ownership claim for its canonical data
root. A second process cannot open the same notebook, and shutdown retains the
claim until active requests and persistence queues have quiesced. Receipts from
another machine, boot, or PID namespace require operator review and are never
reclaimed automatically. Backups exclude this runtime claim; the migration
command refuses to run while any ownership artifact remains.

## Authentication and bookmarks

For local-network authentication, set `DIARY_AUTH_TOKEN`, restart the bridge, and open the diary once with `?k=<token>`. The browser stores the token and sends it with later API requests.

For remote Kindle access, configure `DIARY_REMOTE_KEY` before enabling Tailscale Funnel. Bookmark `/remote/<key>` on the Kindle. The complete URL is a bearer credential: anyone holding it can access protected diary content and invoke its authenticated APIs. All protected requests require it or an explicit `DIARY_AUTH_TOKEN`; peer IP, `Host`, `Origin`, and forwarding headers are never authorization inputs.

Rotate either secret by changing the corresponding environment variable, restarting the diary, and replacing affected bookmarks.

See [Security Policy](../SECURITY.md) for the complete threat model and private vulnerability-reporting process.

## Architecture

The end-to-end paths are:

```text
Kindle browser
  -> authenticated diary bridge (server.mjs)
  -> tightly cropped ink and two handwriting readings
  -> OCR reconciliation, alternatives, and confidence gate
  -> localhost-only Hermes Kindle adapter
  -> tool-enabled Hermes Agent
  -> response and optional sanitized Live Page
  -> Kindle browser

BOOX / Android stylus app
  -> atomic offline page save and on-device ML Kit recognition
  -> private authenticated HTTPS route
  -> localhost-only Hermes Kindle/Notebook adapter
  -> tool-enabled Hermes Agent
  -> completed reply in the native app
```

Important components:

- `public/` contains the Kindle-compatible notebook and Live Page clients.
- `server.mjs` authenticates browser requests, manages sessions, coordinates OCR, and routes work to Hermes.
- `kindle-plugin/` contains the installable Hermes platform adapter.
- The Android/BOOX tester client currently lives in
  [Hermes PR #61687](https://github.com/NousResearch/hermes-agent/pull/61687)
  under `apps/notebook-android` and requires that PR's Notebook adapter.
- `lib/live-page.mjs` manages revisioned and sanitized Live Page content.
- `lib/live-page-ink.mjs` manages shared ink, operations, tombstones, and send claims.
- `lib/live-page-journey.mjs` manages the revision and ink replay history.
- `test/` contains the Node and Python regression suites.

## Security boundaries

- Generated Live Page HTML is sanitized before storage and display.
- The Live Page iframe does not receive script permission.
- External requests from generated content are blocked.
- Publisher writes require the separate local write token over a loopback socket; the remote bookmark key alone never authorizes publishing.
- Browser credentials remain separate from Hermes adapter credentials.
- The localhost Hermes adapter is not a public network service.
- Redline is a suggestion-only intent and explicitly forbids applying or publishing changes.

These controls reduce risk; they do not make any Notebook device appropriate
for unrestricted exposure or careless handling of sensitive data.

Low-confidence handwriting is stopped before the tool-enabled agent and returned
as a clarification. A failed vision request preserves the ink for retry instead
of forwarding a blank request or displaying a false successful completion.

## Reliability model

Every annotation send has a durable `liveInkSendId` and a set of stroke IDs. The server claims the send before invoking Hermes. A concurrent duplicate is rejected, while a retry after completion receives the cached response.

Ink operations are revision-aware. Tombstones prevent delayed device operations from resurrecting cleared ink, and page rollover preserves active send claims. Live Page publishing is transactional so a failed transition cannot expose new HTML with old ink.

Journey stores immutable page revisions and the ink geometry associated with them. Retention is bounded to protect Kindle and host memory.

## Configuration reference

The full environment-variable table remains in the [README](../README.md#run-it). The most important deployment controls are:

| Variable | Purpose |
| --- | --- |
| `DIARY_HOST` / `DIARY_PORT` | Browser-facing bridge bind address and port |
| `HERMES_HOME` / `HERMES_PROFILE_NAME` | Selected profile home and optional identity assertion |
| `DIARY_DATA_DIR` / `DIARY_BACKUP_DIR` | Canonical, non-overlapping state paths; selected-profile defaults stay under `<HERMES_HOME>/notebook` |
| `HERMES_CONFIG` | Selected profile's exact `config.yaml` path |
| `DIARY_AUTH_TOKEN` | Required LAN API and handwriting credential unless `DIARY_REMOTE_KEY` is set |
| `DIARY_REMOTE_KEY` | Required bearer key for remote-key-only deployments unless `DIARY_AUTH_TOKEN` is set; one of the two credentials protects every API/image request regardless of peer IP, Host, Origin, or proxy headers |
| `DIARY_LIVE_WRITE_TOKEN` | Optional override for the local Live Page publisher secret |
| `KINDLE_ADAPTER_URL` | Local bridge destination for the Hermes Kindle adapter |
| `KINDLE_INGEST_TOKEN` | Shared authentication secret for adapter ingestion |
| `KINDLE_INGEST_HOST` / `KINDLE_INGEST_PORT` | Literal loopback listener and profile-unique port |
| `KINDLE_USER` / `KINDLE_REPLY_TIMEOUT` | Server-bound user and plain-decimal reply timeout used in owner attestation |
| `DIARY_ADAPTER_TIMEOUT_MS` | Integer bridge timeout; defaults to the reply timeout plus a fixed 5,000 ms margin and must retain at least that margin when explicitly set |
| `DIARY_VISION_ENDPOINT` / `DIARY_VISION_MODEL` | Handwriting vision service |
| `DIARY_OCR_CLEANUP_ENDPOINT` / `DIARY_OCR_CLEANUP_MODEL` | Optional transcription cleanup service |

## Operations and backups

The repository includes Windows helpers for an always-on deployment:

- `run-diary.cmd` restarts the bridge after an unexpected exit;
- `Hermes-Diary.task.xml` defines a scheduled startup task;
- `archive-run.cmd` creates a data archive; and
- `Hermes-Diary-Archive.task.xml` defines scheduled archive execution.

The included task templates are single-profile examples. Their task names are
fixed, and stopping a Task Scheduler entry is not a multi-profile ownership
protocol. For concurrent profiles, use separately named launchers and tasks,
pass profile-specific environment without placing secrets in task XML or command
arguments, and verify the old listener/bridge process is stopped before reusing
its ports.

Use `npm run backup` for a manual backup. Each run publishes a unique generation
only after the source-before, staged, and source-after manifests match; a
concurrent write commits nothing. Store backup copies somewhere protected and
separate from the active data directory. Backups can contain diary content and
handwriting and must be handled as sensitive data.

## Validation and contribution

Run the repository checks before proposing a change:

```text
npm ci --ignore-scripts
npm run lint
npm test
python -m pytest test/kindle-plugin test/ci -q
node --check server.mjs
node --check public/live.js
python -m compileall -q kindle-plugin
npm audit --omit=dev --audit-level=high
python -m pip_audit --requirement requirements-dev.txt
```

Do not claim a physical Kindle test unless one was actually performed. All changes to `main` go through a pull request, required CI, and resolved review conversations. Follow [CONTRIBUTING.md](../CONTRIBUTING.md) and [AGENTS.md](../AGENTS.md).

## Getting help

For ordinary defects or feature ideas, search the repository’s existing issues before opening a new one. Include sanitized reproduction steps, expected behavior, actual behavior, and the relevant environment.

For credentials, private content, authentication bypasses, or other security problems, use GitHub private vulnerability reporting instead of a public issue.
