# Contributing to Hermes Agents Guide to the Galaxy

Thank you for helping improve Hermes Notebook, the handwriting-first Kindle,
BOOX, and Android stylus companion for Hermes Agent.

## Development setup

Requirements: Node.js 20 or 22, Python 3.11 through 3.13, and Git.

```text
git clone https://github.com/lEWFkRAD/hermes-agents-guide-to-the-galaxy.git
cd hermes-agents-guide-to-the-galaxy
npm ci
python -m pip install --requirement requirements-dev.txt
```

Before running adapter tests, install the exact reviewed Hermes source using
the commands in [`docs/HERMES_INTEGRATION.md`](docs/HERMES_INTEGRATION.md).
The CI-equivalent installed-environment audit is
`python scripts/audit_hermes_environment.py`; its narrow, expiring test-host
exceptions do not apply to a release.

See the README for optional Hermes adapter and runtime configuration. Never commit diary data, handwriting, tokens, client information, or logs.

## Architecture and tests

`server.mjs` serves the browser diary and connects it to Hermes. `public/`
contains the Kindle-compatible browser client. `kindle-plugin/` contains the
installable localhost-only Hermes platform adapter. The native Android/BOOX
tester client is developed with the upstream Notebook adapter in Hermes PR
#61687. Tests live under `test/`.

Run every validation command in `AGENTS.md` before submitting, including
`python -m pytest test/kindle-plugin test/ci -q`. State clearly which checks
ran and whether a physical Kindle was used.

The adapter integration tests run against the exact reviewed Hermes commit
recorded in [`docs/HERMES_INTEGRATION.md`](docs/HERMES_INTEGRATION.md). Do not
silently replace that pin with a branch name or moving tag.

All changes to `main` go through a pull request. Required CI must pass and all
review conversations must be resolved before squash or rebase merge.

## Issues and security

Search existing issues and pull requests first. Bug reports need reproduction steps, expected and actual behavior, and a sanitized environment description. Feature requests should lead with the problem.

Do not publicly report vulnerabilities, credentials, or private content. Use GitHub private vulnerability reporting for the repository.

## Pull requests

1. Branch from `main` using `fix/`, `feat/`, `docs/`, `test/`, or `ci/`.
2. Keep one logical change per pull request and add tests for behavior changes.
3. Use Conventional Commits, such as `fix: preserve Kindle session identity`.
4. Certify commits under the Developer Certificate of Origin with `git commit -s`.
5. Fill out the PR template, disclose AI assistance, and wait for CI to pass.
6. Do not force-push after review has started.

Contributions are licensed under this repository's MIT License.

Maintainers publish releases using [`RELEASING.md`](RELEASING.md). Pull
requests must not create release tags or edit a released changelog section.
