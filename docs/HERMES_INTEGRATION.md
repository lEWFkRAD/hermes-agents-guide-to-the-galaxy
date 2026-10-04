# Hermes integration compatibility pin

The merge-gating adapter tests use this exact reviewed Hermes Agent commit:

| Field | Value |
| --- | --- |
| Repository | `NousResearch/hermes-agent` |
| Commit | `03fa32c92dd445eb64c7f67434dd91b32c40701d` |
| Upstream branch at review | `main` |
| Reviewed | 2026-08-10 |

This is a compatibility pin, not a floating branch or a release claim. The
commit contains the current profile secret-scope and platform-plugin contracts
used by the Kindle adapter. CI checks out the 40-character commit directly so
an upstream push cannot silently change a pull request's test environment.

## Install the reviewed test source

From the repository root:

```text
git clone --no-checkout https://github.com/NousResearch/hermes-agent.git .hermes-agent
git -C .hermes-agent checkout --detach 03fa32c92dd445eb64c7f67434dd91b32c40701d
python -m pip install --upgrade pip==26.2.1
python -m pip install --requirement requirements-dev.txt
python -m pip install -e .hermes-agent
```

The checkout is local test infrastructure and is excluded from release
archives. Verify `git -C .hermes-agent rev-parse HEAD` before using it.

## Updating the pin

Update it only in a dedicated pull request:

1. Review the upstream diff from the old commit to the proposed commit,
   concentrating on plugin manifests, `gateway.config`, platform adapter base
   classes, profile secret scopes, and scoped credential locks.
2. Update the literal SHA in both CI workflows and this document. Never use a
   branch name or moving tag in a merge-gating job.
3. Align direct pins in `requirements-dev.txt` with the reviewed upstream
   dependency metadata.
4. Run Node 20/22 validation, the Python adapter suite, dependency audits, and
   both release-archive smoke tests.
5. Record the tested commit and material compatibility findings in the pull
   request. Device/browser UX changes require a physical-device check before a
   release; desktop-simulated runtime changes must state when that check was not
   performed.

Review the pin when Hermes changes its plugin/profile contracts, when the
current commit is affected by a security advisory, and before each release.

## Temporary CI-only audit exception

The reviewed Hermes commit pins `cryptography==48.0.1` for its broader test
environment. That upstream-only test-host dependency currently has three known
advisories:

| pip-audit ID | Aliases | Severity | Affected operation | Fixed in |
| --- | --- | --- | --- | --- |
| `PYSEC-2026-3552` | [`CVE-2026-69247` / `GHSA-g6cj-pr64-35w5`](https://github.com/advisories/GHSA-g6cj-pr64-35w5) | High (8.2) | PKCS#7 `EnvelopedData` decryption can expose a Bleichenbacher oracle through distinguishable errors and timing. | `cryptography` 50.0.0 |
| `PYSEC-2026-3553` | [`CVE-2026-69249` / `GHSA-jwv3-5hgf-82ww`](https://github.com/advisories/GHSA-jwv3-5hgf-82ww) | High (8.7) | Duplicate self-signed intermediates can cause exponential X.509 path-building and resource exhaustion. | `cryptography` 49.0.0 |
| `PYSEC-2026-3554` | [`CVE-2026-69248` / `GHSA-m2h6-j472-rp4c`](https://github.com/advisories/GHSA-m2h6-j472-rp4c) | Moderate (6.9) | Wildcard DNS names can escape an intermediate CA's `permittedSubtrees` constraint and make the X.509 verifier accept an invalid chain. | `cryptography` 49.0.0 |

The Kindle adapter and its integration tests do not call PKCS#7 decryption or
the `cryptography` X.509 verifier. Merge-gating CI therefore has a narrow
exception for exactly these three IDs while continuing to audit every other
auditable installed dependency. The exception expires at 2026-09-10 00:00 UTC and the
audit fails closed on or after that instant.

This exception does **not** declare the affected dependency safe for
production. The Release workflow applies no ignores and must pass a complete
installed-environment audit, so publishing remains blocked until a reviewed
Hermes pin resolves all three advisories.
