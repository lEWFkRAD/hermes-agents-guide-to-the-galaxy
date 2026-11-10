# Kindle Scribe platform plugin for Hermes

`kindle-scribe` is the Hermes half of
[Hermes Agents Guide to the Galaxy](https://github.com/lEWFkRAD/hermes-agents-guide-to-the-galaxy).
It registers a gateway platform so handwritten notes from a Kindle Scribe reach
the full agent, its tools, and its memory, and the agent's reply goes back to
the notebook page.

The plugin does nothing useful on its own. It is the receiving end for the
companion diary bridge (a Node service in the same repository) that serves the
notebook page to the Kindle browser and forwards each note to this adapter.

## Install

```bash
hermes plugins install kindle-scribe --enable
hermes gateway restart
```

The installer prompts for `KINDLE_INGEST_TOKEN`. Then follow
[after-install.md](after-install.md) and the repository
[README](https://github.com/lEWFkRAD/hermes-agents-guide-to-the-galaxy#run-it)
to start the diary bridge with the same token.

## Settings

| Name | Required | Purpose |
| --- | --- | --- |
| `KINDLE_INGEST_TOKEN` | yes | Shared secret between the diary bridge and this adapter |
| `KINDLE_USER` | no | Stable profile-scoped user identity (default `kindle`) |
| `KINDLE_ALLOWED_USERS` | no | Comma-separated user IDs allowed to use the channel |
| `KINDLE_HOME_CHANNEL` | no | Notebook chat ID used for cron and home delivery |
| `KINDLE_INGEST_HOST` | no | Ingest bind address (default `127.0.0.1`) |
| `KINDLE_INGEST_PORT` | no | Ingest port (default `8793`) |
| `KINDLE_REPLY_TIMEOUT` | no | Seconds to wait for a completed reply (default `240`) |
| `KINDLE_INSECURE`, `KINDLE_ALLOW_ALL_USERS` | no | Localhost development only; leave unset |

All of these are read through Hermes's profile secret scope, so each profile
uses its own values.

## Disclosure

- **Long-running listener.** While the gateway runs, the adapter keeps an
  `aiohttp` HTTP server open on `127.0.0.1:8793` (`/health` and `/ingest`). Both
  routes require the `X-Kindle-Token` header, and the adapter refuses any bind
  address that is not a literal loopback address.
- **Runs in the gateway process.** Like every platform adapter, it runs
  in-process on the gateway's event loop rather than in the plugin host.
- **Network calls.** None outbound. The adapter only answers the diary bridge.
- **Stored credentials.** `KINDLE_INGEST_TOKEN` is saved by Hermes in the
  active profile's environment; the plugin does not read `.env` files or any
  other credential store itself.
- **Shell commands, telemetry, self-update.** None.
- **Companion bridge.** The separate diary bridge is what the Kindle talks to
  over the LAN (or Tailscale Funnel, if you turn that on). It is not installed
  by this plugin; its exposure and credentials are covered in the repository's
  [SECURITY.md](https://github.com/lEWFkRAD/hermes-agents-guide-to-the-galaxy/blob/main/SECURITY.md#deployment-threat-model).

## Requirements

Hermes Agent 0.23 or newer. `aiohttp` (already a Hermes dependency).
