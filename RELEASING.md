# Releasing Hermes Notebook

Releases publish two independently usable ZIP archives from the same reviewed
Git tree:

- `hermes-notebook-vX.Y.Z.zip` contains the complete tracked product under one
  versioned top-level directory.
- `kindle-scribe-plugin-vX.Y.Z.zip` contains the installable Hermes plugin at
  the archive root plus the repository license.

Each ZIP has a sibling `.sha256` file. GitHub also records build-provenance
attestations for both ZIPs.

## Prepare

1. Work through a pull request based on current `main`.
2. Set the same SemVer in `package.json`, the root entries in
   `package-lock.json`, `kindle-plugin/plugin.yaml`,
   `kindle-plugin/adapter.py` (`PLUGIN_VERSION`), and
   `lib/runtime-profile.mjs` (`NOTEBOOK_VERSION`).
3. Rename the matching `CHANGELOG.md` heading from `Unreleased` to the UTC
   release date (`YYYY-MM-DD`). Do not edit prior released sections.
4. Review and, if necessary, update the exact Hermes integration pin following
   `docs/HERMES_INTEGRATION.md`.
   Do not tag while its CI-only advisory exception remains active: the Release
   workflow intentionally audits the installed Hermes environment with no
   ignored vulnerabilities.
5. Run:

   ```text
   npm ci --ignore-scripts
   npm run validate
   python -m pip install --requirement requirements-dev.txt
   python -m pytest test/kindle-plugin test/ci -q
   npm audit --omit=dev --audit-level=high
   python -m pip_audit --requirement requirements-dev.txt
   python -m pip_audit
   ```

6. Let hosted CI build and smoke-test both archives. Merge only after the
   `Required PR checks` context succeeds and review conversations are resolved.

## Publish

1. Confirm the release commit is on `main` and the hosted main build is green.
2. Create an annotated `vX.Y.Z` tag on that exact commit and push only the tag.
3. The Release workflow verifies tag/version/changelog agreement and proves
   the tagged commit is reachable from `origin/main` before building anything.
   It also matches the annotated local tag object and peeled commit to the
   current remote tag before building and again immediately before publishing.
4. Inspect the generated GitHub Release: both ZIPs, both checksum files, and
   both provenance attestations must be present. Verify one checksum and a
   clean plugin install before announcing the release.

Never retag, overwrite release assets, or publish from a side branch. Correct a
bad release with a new patch version.
