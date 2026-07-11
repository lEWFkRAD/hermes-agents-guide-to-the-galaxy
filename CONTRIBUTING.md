# Contributing

Thanks for helping improve Hermes Agents Guide to the Galaxy. This project is a
local-first Kindle Scribe notebook bridge, so contributions need to respect both
the e-ink user experience and the privacy boundary around local diary data.

## Workflow

1. Open or comment on an issue before starting large behavior changes.
2. Keep pull requests small enough to review in one pass.
3. Run the local checks before opening a pull request:

   ```powershell
   npm.cmd run lint
   npm.cmd test
   ```

4. In the pull request, include a short summary, validation commands, and any
   data/auth risk created by the change.

## Good first contributions

- Focused Kindle browser UI fixes.
- Tests for existing edge cases.
- Documentation that clarifies setup, security boundaries, or recovery steps.
- Small reliability improvements with clear before/after behavior.

## Safety and privacy

- Do not commit `data/`, `backups/`, local tokens, private environment files,
  diary entries, handwriting images, or Hermes responses from real use.
- Do not include screenshots that reveal secrets, private notes, client data, or
  remote bookmark keys.
- Treat auth, Tailscale Funnel, image retention, and Hermes adapter behavior as
  security-sensitive.

## AI-assisted submissions

AI-assisted contributions are welcome when they are reviewable.

- State in the pull request whether an AI assistant generated or transformed
  code, tests, documentation, or issue text.
- Keep generated changes scoped and readable.
- Verify generated code locally. Do not submit code that was only eyeballed.
- Do not use AI tools to fabricate test results, issue reproduction details, or
  maintainer decisions.

By submitting a contribution, you agree that it is licensed under the Apache
License, Version 2.0.
