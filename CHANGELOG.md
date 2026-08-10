# Changelog

All notable changes to Hermes Notebook and its Kindle Scribe plugin are
documented here. The project follows Semantic Versioning for repository tags.

## [0.2.0] - Unreleased

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
