# AGENTS.md

This repository is a Kindle Scribe-first web notebook for Hermes. Contributions
should preserve the app's core job: fast, private handwriting capture on an
e-ink browser, routed through a local Hermes bridge without leaking personal
diary content, credentials, or client data.

## First read

- `README.md` explains the runtime model, environment variables, and security
  boundaries.
- `CONTRIBUTING.md` explains the human contribution workflow.
- `.gitignore` identifies local-only data and secrets. Do not override it.

## Local checks

Run these before opening a pull request:

```powershell
npm.cmd run lint
npm.cmd test
```

On non-Windows shells, `npm run lint` and `npm test` are equivalent.

## Agent contribution rules

- Keep changes focused. Do not combine UI rewrites, security changes, and
  runtime behavior changes in one pull request unless the issue explicitly
  requires it.
- Add or update tests for behavior changes. Prefer Node's built-in test runner
  in `test/*.test.mjs`.
- Do not add production dependencies without explaining why the existing
  standard-library approach is insufficient.
- Do not commit files under `data/`, `backups/`, `kindle-plugin/`, `SPEC-*.md`,
  `.kindle-token`, or `kindle-env.ps1`.
- Never paste real diary entries, handwriting images, client data, access
  tokens, hostnames with secrets, or private Hermes responses into issues,
  commits, tests, screenshots, or logs.
- Preserve Kindle constraints: low repaint cost, large touch targets, graceful
  operation in the Scribe browser, and readable e-ink contrast.
- Treat the bridge boundary as security-sensitive. Remote access, auth tokens,
  Tailscale Funnel paths, stored images, and Hermes adapter calls need tests or
  a clear manual validation note.
- If an AI assistant generated or materially transformed the change, say so in
  the pull request and list the exact validation commands that passed.
- Do not invent validation. If a check was not run, state that plainly in the
  pull request.

## Code style

- Use ESM modules and the existing plain JavaScript style.
- Keep browser code dependency-free unless there is a strong reason to change
  that constraint.
- Keep comments sparse and useful. Add comments where the Kindle/Hermes
  boundary or state machine would otherwise be hard to follow.
- Keep persisted data formats backward compatible, or include migration and
  rollback behavior with tests.

## Review expectations

Maintainers should be able to answer these questions from the pull request:

- What user-visible Kindle behavior changed?
- What data, auth, or Hermes boundary could be affected?
- What tests or manual checks prove the change?
- Was any code or prose AI-generated, and did a human review it?
