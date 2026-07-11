# Security Policy

This app can expose private diary entries, handwriting images, local network
details, remote bookmark keys, and Hermes tool responses. Handle security
reports privately.

## Reporting

Use GitHub private vulnerability reporting. If it is unavailable, contact the
maintainer privately before posting details. Do not open a public issue for:

- credential, token, or bookmark-key exposure;
- authentication bypasses for `/api/*`, `/img/*`, `/remote/<key>`, or Live Page;
- exposure of diary data, handwriting, Hermes responses, or host details; or
- remote-access configurations that could disclose private data.

Maintainers should acknowledge reports, reproduce privately, patch without
publishing exploit details, and ship clear upgrade or mitigation instructions.

## Deployment threat model

The diary is a personal-data application, not a hardened multi-tenant service.
The host, its local user account, Hermes Agent, and configured model endpoints
are trusted. Other LAN devices, public internet clients, browser history,
screenshots, logs, and physical access to an unlocked Kindle are not trusted.

### LAN access

`DIARY_AUTH_TOKEN` protects local `/api/*` and `/img/*` routes. The initial
`?k=<token>` link exchanges the token for an HTTP-only cookie, but that link can
remain in browser history or screenshots. Use a high-entropy value, avoid shared
devices, and rotate it by changing the environment variable and restarting the
diary. Leaving the token unset is supported only on a trusted private LAN.

### Tailscale Funnel

`DIARY_REMOTE_KEY` is a bearer secret embedded in the permanent
`/remote/<key>` bookmark. Anyone who obtains the complete bookmark can read
history, stored handwriting, and invoke authenticated diary APIs. Funnel does
not turn this application into an identity-aware service. Disable exposure with
`tailscale funnel --https=443 off`; revoke a leaked bookmark by changing
`DIARY_REMOTE_KEY`, restarting the diary, and replacing the Kindle bookmark.

Never expose the diary publicly without `DIARY_REMOTE_KEY`, and never expose
the localhost-only Kindle adapter port `8793` through Funnel, port forwarding,
or a public reverse proxy.

### Browser and physical-device risks

The Kindle bookmark, browser history, cached pages, photographs, and screenshots
can disclose secrets or diary content. Use the device lock, remove obsolete
bookmarks after rotation, and treat loss of an unlocked device as credential
compromise.

### Outlook integration

The optional Outlook PST bridge runs locally and its token must remain outside
the repository. Read access exposes mailbox content to the configured agent.
Mutation operations require explicit confirmation; do not weaken that boundary
or expose the bridge publicly. Revoke access by stopping the bridge and rotating
or deleting its local token.
