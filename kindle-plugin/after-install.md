# Kindle Scribe platform installed

Hermes installed this plugin in its persistent user-plugin directory, so normal
Hermes updates will not replace it.

1. Set `KINDLE_ALLOWED_USERS` to the stable identity used by the diary bridge
   (for example, `jeff`). Do not set `KINDLE_ALLOW_ALL_USERS` in production.
2. Set the same `KINDLE_INGEST_TOKEN` for both Hermes and the diary bridge.
3. Start or restart the Hermes gateway.
4. Verify `http://127.0.0.1:8793/health` returns `ok`.
5. Start the diary bridge and select **Hermes firm agent** on the Scribe.

The bridge defaults to `http://127.0.0.1:8793/ingest`. Keep this adapter bound
to localhost; only the diary web application should be exposed to the LAN.

Companion diary:
https://github.com/lEWFkRAD/hermes-agents-guide-to-the-galaxy
