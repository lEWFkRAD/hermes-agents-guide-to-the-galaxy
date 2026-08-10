## Summary

## Why

Closes #

## Testing

- [ ] `npm ci --ignore-scripts`
- [ ] `npm run validate`
- [ ] `python -m pytest test/kindle-plugin test/ci -q`
- [ ] `npm audit --omit=dev --audit-level=high`
- [ ] `python -m pip_audit --requirement requirements-dev.txt`
- [ ] `python scripts/audit_hermes_environment.py` after installing the exact Hermes pin
- [ ] Physical Kindle Scribe (only check if performed)

## Safety and compatibility

- [ ] No secrets, diary content, handwriting, client data, or unsanitized logs
- [ ] Localhost adapter boundary remains intact
- [ ] Session continuity and new-entry isolation remain intact
- [ ] README/configuration updated where needed
- [ ] Release versions and archive contract remain synchronized
- [ ] Every commit has a matching `Signed-off-by` trailer
- [ ] I reviewed and understand all submitted code

## AI assistance

Describe any AI-assisted work and the human review performed.

## Device verification

State exactly what was tested on a physical device versus desktop/simulated.
