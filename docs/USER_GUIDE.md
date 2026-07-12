# Kindle Scribe + Hermes User Guide

This guide explains how to use the Kindle Scribe companion for Hermes in everyday language. The first part is for anyone using the notebook. Installation, security, architecture, and maintenance are collected in the technical section at the back.

## What this gives you

The companion turns a Kindle Scribe into a writing and review surface for Hermes. You can write naturally, mark a page, send the work to Hermes, and read the answer on the Kindle.

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

1. Open the saved Hermes bookmark in the Kindle browser.
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
- Node.js 22 or later;
- Python 3.11 or later;
- a stock Kindle Scribe browser;
- Hermes Agent with the Kindle plugin enabled; and
- local handwriting vision and cleanup endpoints when those features are used.

The Node bridge is intentionally reachable by the Kindle. The Hermes Kindle adapter must remain bound to localhost and must never be exposed publicly.

## Install the repository

```text
git clone https://github.com/lEWFkRAD/hermes-agents-guide-to-the-galaxy.git
cd hermes-agents-guide-to-the-galaxy
npm install
python -m pip install pytest aiohttp
```

Install and enable the Hermes platform plugin:

```text
hermes plugins install lEWFkRAD/hermes-agents-guide-to-the-galaxy/kindle-plugin --enable
hermes gateway restart
```

The plugin installer prompts for `KINDLE_INGEST_TOKEN`. Configure `KINDLE_ALLOWED_USERS` with the stable user identity accepted by the adapter.

Start the bridge:

```text
npm start
```

By default, the diary listens on `0.0.0.0:8791`. The Hermes adapter remains localhost-only on its separately configured endpoint.

## Authentication and bookmarks

For local-network authentication, set `DIARY_AUTH_TOKEN`, restart the bridge, and open the diary once with `?k=<token>`. The browser stores the token and sends it with later API requests.

For remote Kindle access, configure `DIARY_REMOTE_KEY` before enabling Tailscale Funnel. Bookmark `/remote/<key>` on the Kindle. The complete URL is a bearer credential: anyone holding it can access protected diary content and invoke its authenticated APIs.

Rotate either secret by changing the corresponding environment variable, restarting the diary, and replacing affected bookmarks.

See [Security Policy](../SECURITY.md) for the complete threat model and private vulnerability-reporting process.

## Architecture

The end-to-end path is:

```text
Kindle browser
  -> authenticated diary bridge (server.mjs)
  -> handwriting vision and optional OCR cleanup
  -> localhost-only Hermes Kindle adapter
  -> tool-enabled Hermes Agent
  -> response and optional sanitized Live Page
  -> Kindle browser
```

Important components:

- `public/` contains the Kindle-compatible notebook and Live Page clients.
- `server.mjs` authenticates browser requests, manages sessions, coordinates OCR, and routes work to Hermes.
- `kindle-plugin/` contains the installable Hermes platform adapter.
- `lib/live-page.mjs` manages revisioned and sanitized Live Page content.
- `lib/live-page-ink.mjs` manages shared ink, operations, tombstones, and send claims.
- `lib/live-page-journey.mjs` manages the revision and ink replay history.
- `test/` contains the Node and Python regression suites.

## Security boundaries

- Generated Live Page HTML is sanitized before storage and display.
- The Live Page iframe does not receive script permission.
- External requests from generated content are blocked.
- Publisher writes require the local write token and a loopback, non-Funnel request.
- Browser credentials remain separate from Hermes adapter credentials.
- The localhost Hermes adapter is not a public network service.
- Redline is a suggestion-only intent and explicitly forbids applying or publishing changes.

These controls reduce risk; they do not make the Kindle appropriate for unrestricted exposure or careless handling of sensitive data.

## Reliability model

Every annotation send has a durable `liveInkSendId` and a set of stroke IDs. The server claims the send before invoking Hermes. A concurrent duplicate is rejected, while a retry after completion receives the cached response.

Ink operations are revision-aware. Tombstones prevent delayed device operations from resurrecting cleared ink, and page rollover preserves active send claims. Live Page publishing is transactional so a failed transition cannot expose new HTML with old ink.

Journey stores immutable page revisions and the ink geometry associated with them. Retention is bounded to protect Kindle and host memory.

## Configuration reference

The full environment-variable table remains in the [README](../README.md#run-it). The most important deployment controls are:

| Variable | Purpose |
| --- | --- |
| `DIARY_HOST` / `DIARY_PORT` | Browser-facing bridge bind address and port |
| `DIARY_AUTH_TOKEN` | Optional LAN API and handwriting access token |
| `DIARY_REMOTE_KEY` | Required bearer key for public Funnel access |
| `DIARY_LIVE_WRITE_TOKEN` | Optional override for the local Live Page publisher secret |
| `KINDLE_ADAPTER_URL` | Local bridge destination for the Hermes Kindle adapter |
| `KINDLE_INGEST_TOKEN` | Shared authentication secret for adapter ingestion |
| `DIARY_VISION_ENDPOINT` / `DIARY_VISION_MODEL` | Handwriting vision service |
| `DIARY_OCR_CLEANUP_ENDPOINT` / `DIARY_OCR_CLEANUP_MODEL` | Optional transcription cleanup service |

## Operations and backups

The repository includes Windows helpers for an always-on deployment:

- `run-diary.cmd` restarts the bridge after an unexpected exit;
- `Hermes-Diary.task.xml` defines a scheduled startup task;
- `archive-run.cmd` creates a data archive; and
- `Hermes-Diary-Archive.task.xml` defines scheduled archive execution.

Use `npm run backup` for a manual backup. Store backup copies somewhere protected and separate from the active data directory. Backups can contain diary content and handwriting and must be handled as sensitive data.

## Validation and contribution

Run the repository checks before proposing a change:

```text
npm test
npm run lint
python -m pytest test/kindle-plugin -q
node --check server.mjs
node --check public/app.js
python -m compileall -q kindle-plugin
```

Do not claim a physical Kindle test unless one was actually performed. All changes to `main` go through a pull request, required CI, and resolved review conversations. Follow [CONTRIBUTING.md](../CONTRIBUTING.md) and [AGENTS.md](../AGENTS.md).

## Getting help

For ordinary defects or feature ideas, search the repository’s existing issues before opening a new one. Include sanitized reproduction steps, expected behavior, actual behavior, and the relevant environment.

For credentials, private content, authentication bypasses, or other security problems, use GitHub private vulnerability reporting instead of a public issue.
