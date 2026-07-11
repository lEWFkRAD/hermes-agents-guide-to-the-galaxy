# Contributing to Hermes Agents Guide to the Galaxy

Thank you for helping improve the Kindle Scribe companion for Hermes Agent.

## Development setup

Requirements: Node.js 22+, Python 3.11+, and Git.

```text
git clone https://github.com/lEWFkRAD/hermes-agents-guide-to-the-galaxy.git
cd hermes-agents-guide-to-the-galaxy
npm install
python -m pip install pytest aiohttp
```

See the README for optional Hermes adapter and runtime configuration. Never commit diary data, handwriting, tokens, client information, or logs.

## Architecture and tests

`server.mjs` serves the diary and connects it to Hermes. `public/` contains the Kindle browser client. `kindle-plugin/` contains the installable localhost-only Hermes platform adapter. Tests live under `test/`.

Run every validation command in `AGENTS.md` before submitting. State clearly which checks ran and whether a physical Kindle was used.

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
