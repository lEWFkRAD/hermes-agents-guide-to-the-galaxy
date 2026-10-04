# AGENTS.md

Instructions for human and AI contributors working in this repository.

## Architecture and boundaries

- `server.mjs` is the browser-facing diary bridge.
- `public/` is the Kindle-optimized client. Preserve stock Kindle Scribe browser compatibility and e-ink interaction constraints.
- `kindle-plugin/` is the installable Hermes platform adapter.
- Native Android/BOOX client work is coordinated with the upstream Notebook
  adapter in Hermes PR #61687; do not imply that this repository's browser
  bundle is the native APK or that iPadOS is already shipped.
- `test/` contains Node and Python tests.
- The bridge may be LAN-facing. The Hermes adapter must remain bound to localhost; never expose port `8793` publicly.

## Required behavior

- Never commit `data/`, tokens, environment files, diary content, handwriting, client data, or unsanitized logs.
- Keep secrets server-side. The Kindle must not receive Hermes API or adapter credentials beyond an explicitly configured diary access key.
- New diary entries get new Hermes thread IDs; reopened entries retain theirs.
- Host-side success claims must be supported by successful tool evidence.
- Large touch targets, low animation cost, and older browser syntax are product requirements.

## Change discipline

- Read surrounding code and tests first. Preserve unrelated user work.
- Keep changes focused and add regression coverage for changed behavior.
- Update README configuration tables when environment variables change.
- Do not add dependencies without explaining their benefit and security cost.
- Distinguish real-device verification from desktop or simulated checks.
- Review and understand AI-generated changes; never claim tests not performed.

## Validation

```text
npm ci --ignore-scripts
npm run validate
python -m pip install --upgrade pip==26.2.1
python -m pip install --requirement requirements-dev.txt
python -m pip install -e .hermes-agent
python -m pip install "PyJWT[crypto]==2.15.0"
python -m pytest test/kindle-plugin test/ci -q
node --check server.mjs
node --check public/live.js
python -m compileall -q kindle-plugin
npm audit --omit=dev --audit-level=high
python -m pip_audit --requirement requirements-dev.txt
python scripts/audit_hermes_environment.py
```

If AI materially generated or transformed a change, disclose that in the pull
request and list the checks actually run. Never invent validation or claim a
physical-device check that was not performed.
