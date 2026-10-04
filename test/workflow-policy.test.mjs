import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const HERMES_SHA = "fdcae6debac4ad33adc449a4263433b389b563ef";

async function workflow(name) {
  return (await fs.readFile(`.github/workflows/${name}`, "utf8")).replace(/\r\n?/g, "\n");
}

test("every third-party GitHub Action is pinned by full commit SHA", async () => {
  for (const name of ["ci.yml", "release.yml"]) {
    const source = await workflow(name);
    const actions = [...source.matchAll(/^\s*- uses:\s+([^\s@]+)@([^\s#]+).*$/gm)];
    assert.ok(actions.length > 0, `${name} must use pinned Actions`);
    for (const [, action, ref] of actions) {
      assert.match(ref, /^[0-9a-f]{40}$/, `${name}: ${action} is not SHA-pinned`);
    }
    const checkouts = actions.filter(([, action]) => action === "actions/checkout").length;
    const noCredentials = (source.match(/^\s+persist-credentials:\s+false\s*$/gm) || []).length;
    assert.equal(noCredentials, checkouts, `${name}: every checkout must remove persisted credentials`);
  }
});

test("CI and release use the documented reviewed Hermes commit", async () => {
  const docs = await fs.readFile("docs/HERMES_INTEGRATION.md", "utf8");
  assert.match(docs, new RegExp(HERMES_SHA));
  for (const name of ["ci.yml", "release.yml"]) {
    const source = await workflow(name);
    assert.match(source, /repository: NousResearch\/hermes-agent/);
    const expectedPins = name === "ci.yml" ? 3 : 1;
    assert.equal((source.match(new RegExp(HERMES_SHA, "g")) || []).length, expectedPins);
    assert.doesNotMatch(source, /ref:\s+(?:main|master|feat\/|v\d)/);
  }
});

test("CI preserves the transition check and emits a PR-only aggregate", async () => {
  const source = await workflow("ci.yml");
  assert.match(source, /^\s+name: test$/m);
  assert.match(source, /node-version: \[20\.x, 22\.x\]/);
  assert.match(source, /runs-on: windows-latest[\s\S]*Run adapter and CI policy tests on Windows/);
  assert.match(source, /'Required PR checks' \|\| 'CI summary'/);
  assert.match(source, /needs: \[node, python, package, dco, audit\]/);
  assert.match(source, /--actor "\$\{\{ github\.actor \}\}"/);
  assert.match(source, /for name in \("node", "python", "package", "audit"\)/);
  assert.match(source, /if results\[name\] != "success"/);
  assert.match(
    source,
    /expected_dco = "success" if os\.environ\["EVENT_NAME"\] == "pull_request" else "skipped"/,
  );
  assert.doesNotMatch(source, /\{"success", "skipped"\}/);
});

test("workflows bound concurrency, runtime, and token exposure", async () => {
  const ci = await workflow("ci.yml");
  const release = await workflow("release.yml");
  assert.doesNotMatch(ci, /^\s*pull_request_target\s*:/m);
  assert.match(ci, /^permissions:\s*\n\s+contents: read$/m);
  assert.match(ci, /^concurrency:\s*\n\s+group: .+\n\s+cancel-in-progress: true$/m);
  assert.equal((ci.match(/^\s+timeout-minutes:/gm) || []).length, 6);

  assert.match(release, /^\s+contents: write$/m);
  assert.match(release, /^\s+id-token: write$/m);
  assert.match(release, /^\s+attestations: write$/m);
  assert.match(release, /^concurrency:\s*\n\s+group: .+\n\s+cancel-in-progress: false$/m);
  assert.equal((release.match(/^\s+timeout-minutes:/gm) || []).length, 1);
});

test("CI audits the installed Hermes environment and no workflow ignores advisories", async () => {
  const ci = await workflow("ci.yml");
  const release = await workflow("release.yml");
  assert.equal((ci.match(/python scripts\/audit_hermes_environment\.py/g) || []).length, 2);
  assert.match(ci, /python -m pip_audit --requirement requirements-dev\.txt/);
  assert.match(ci, /--upgrade pip==26\.2\.1/);

  assert.match(release, /python -m pip_audit --requirement requirements-dev\.txt/);
  assert.match(release, /^\s*- run: python -m pip_audit\s*$/m);
  assert.match(release, /--upgrade pip==26\.2\.1/);
  assert.doesNotMatch(release, /audit_hermes_environment|--ignore-vuln/);
  assert.doesNotMatch(ci, /--ignore-vuln/);
  for (const source of [ci, release]) {
    assert.match(source, /-e \.hermes-agent\s*\n\s*- run: python -m pip install --disable-pip-version-check "PyJWT\[crypto\]==2\.15\.0"/);
  }
});

test("release publishes both checked and attested archive layouts", async () => {
  const source = await workflow("release.yml");
  assert.match(source, /tags:\s*\n\s+- "v\*\.\*\.\*"/);
  assert.match(source, /verify-release-ancestry\.mjs/);
  assert.equal((source.match(/verify-release-tag\.mjs/g) || []).length, 2);
  assert.match(source, /attest-build-provenance@[0-9a-f]{40}/);
  const builder = await fs.readFile("scripts/build-release-artifacts.mjs", "utf8");
  assert.match(builder, /hermes-notebook-v\$\{releaseVersion\}\.zip/);
  assert.match(builder, /kindle-scribe-plugin-v\$\{releaseVersion\}\.zip/);
});
