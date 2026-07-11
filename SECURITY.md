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
