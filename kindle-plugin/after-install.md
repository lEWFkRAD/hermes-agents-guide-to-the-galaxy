# Kindle Scribe platform installed

Hermes installed this plugin in its persistent user-plugin directory, so normal
Hermes updates will not replace it.

1. Set `KINDLE_ALLOWED_USERS` to the stable, profile-scoped `KINDLE_USER` used
   by the diary bridge (for example, `jeff`). Do not set
   `KINDLE_ALLOW_ALL_USERS` in production.
2. Set the same profile-scoped `KINDLE_INGEST_TOKEN` for Hermes and the diary
   bridge. Do not put profiles' tokens in one shared machine-wide environment.
3. If more than one Hermes profile is enabled concurrently, give each profile a
   distinct `KINDLE_INGEST_PORT` and give each companion bridge a distinct
   `DIARY_PORT`.
4. Launch the bridge with the matching `HERMES_HOME`, `KINDLE_USER`, token,
   adapter host/port, and `KINDLE_ADAPTER_URL`, then start or restart the Hermes
   gateway.
5. Authenticate `GET http://127.0.0.1:<port>/health` with the
   `X-Kindle-Token` header. It must return `status: ok` and the expected profile,
   host, port, version, and non-secret owner fingerprint.
6. Set a high-entropy `DIARY_AUTH_TOKEN` for LAN use or `DIARY_REMOTE_KEY` for
   the permanent remote bookmark. The diary bridge refuses to start without one
   of these browser credentials.
7. Start the diary bridge and select **Hermes firm agent** on the Scribe.

The bridge defaults to `http://127.0.0.1:8793/ingest`. Keep this adapter bound
to a literal loopback address; only the diary web application should be exposed
to the LAN. A listener collision, rotated profile secret, or health-identity
mismatch is a hard failure and must not be bypassed with another profile's token.

Companion diary:
https://github.com/lEWFkRAD/hermes-agents-guide-to-the-galaxy
