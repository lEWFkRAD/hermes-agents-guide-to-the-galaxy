# Security Policy

This app can expose private diary entries, handwriting images, local network
details, remote bookmark keys, and Hermes tool responses. Please handle security
reports privately.

## Reporting

Use GitHub private vulnerability reporting if it is enabled for this repository.
If it is not enabled, contact a maintainer directly before posting details.

Do not open a public issue for:

- Credential, token, or bookmark-key exposure.
- Auth bypasses for `/api/*`, `/img/*`, `/remote/<key>`, or Live Page publishing.
- Bugs that expose diary data, handwriting images, Hermes responses, or local
  host details.
- Tailscale Funnel or remote-access misconfiguration that could disclose data.

## Maintainer response

Maintainers should acknowledge reports, reproduce privately, patch on a private
branch when possible, and publish a fix with a clear upgrade or mitigation note.
