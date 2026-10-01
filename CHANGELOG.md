# Changelog

All notable changes to Hermes Notebook and its Kindle Scribe plugin are
documented here. The project follows Semantic Versioning for repository tags.

## [0.2.0] - Unreleased

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

### Added

- Locked Node validation plus exact direct Python tooling and a reviewed Hermes source pin.
- Merge-gating DCO, dependency-audit, package, and aggregate CI checks.
- Whole-product and root-layout plugin release archives with checksums and provenance attestations.
- Multi-profile ownership, profile-scoped companion paths, and authenticated
  cross-runtime health attestation for the Kindle adapter.
- A verified, non-destructive migration command for v0.1 checkout-local data
  and backups, with startup refusal before an unresolved path transition or a
  post-migration write to the preserved legacy tree.
- Cross-process data-root ownership plus mutation-detecting, uniquely staged
  backup generations for profile-safe bridge operations.

### Changed

- Aligned repository, plugin manifest, and runtime version metadata at `0.2.0`.
- Migrated the plugin's credential prompt to Hermes's `password: true` manifest contract.

### Security

- Hardened archive hygiene and the release path against mutable dependencies and unreviewed tags.
- Removed shared HKCU credential reloading from the Windows bridge wrapper so
  one profile cannot overwrite another profile's adapter identity.
- Restricted retention deletion to bounded counts of receipt-owned backup
  generations, preserving unrelated directories under custom backup roots.
- Required an explicit browser credential for every API/image request and
  removed peer IP, Host, Origin, and forwarding headers from authorization.

## [0.1.0] - 2026-07-11

- First public Kindle Scribe notebook bridge and Hermes platform-plugin baseline.

[0.2.0]: https://github.com/lEWFkRAD/hermes-agents-guide-to-the-galaxy/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lEWFkRAD/hermes-agents-guide-to-the-galaxy/releases/tag/v0.1.0
