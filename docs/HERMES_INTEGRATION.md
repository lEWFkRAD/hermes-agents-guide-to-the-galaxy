# Hermes integration compatibility pin

The merge-gating adapter tests use this exact reviewed Hermes Agent commit:

| Field | Value |
| --- | --- |
| Repository | `NousResearch/hermes-agent` |
| Commit | `fdcae6debac4ad33adc449a4263433b389b563ef` |
| Upstream branch at review | `main` |
| Reviewed | 2026-10-04 |

This is a compatibility pin, not a floating branch or a release claim. The
commit contains the current profile secret-scope and platform-plugin contracts
used by the Kindle adapter. CI checks out the 40-character commit directly so
an upstream push cannot silently change a pull request's test environment.

## Install the reviewed test source

From the repository root:

```text
git clone --no-checkout https://github.com/NousResearch/hermes-agent.git .hermes-agent
git -C .hermes-agent checkout --detach fdcae6debac4ad33adc449a4263433b389b563ef
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

## Test-host dependency override

The reviewed Hermes commit pins `PyJWT[crypto]==2.13.0`, which has known
advisories fixed in 2.14.0 and 2.15.0 (PYSEC-2026-4140 through 4152). The
Kindle adapter does not use PyJWT. CI installs `PyJWT[crypto]==2.15.0` after
Hermes, so the installed environment audits clean without any ignore list. pip
reports the version conflict with the Hermes pin; that is expected. Drop the
override when a reviewed Hermes pin ships PyJWT 2.14.0 or newer.

The former CI-only `cryptography` exceptions (PYSEC-2026-3552/3553/3554)
expired on 2026-09-10 and are retired: this Hermes commit ships
`cryptography` 50.0.1. Neither CI nor Release ignores any advisory.
