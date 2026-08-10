import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildReleaseArtifacts } from "../scripts/build-release-artifacts.mjs";
import { verifyReleaseAncestry } from "../scripts/verify-release-ancestry.mjs";
import { verifyReleaseMetadata } from "../scripts/verify-release-metadata.mjs";
import { verifyReleaseTag } from "../scripts/verify-release-tag.mjs";

test("release metadata keeps every shipped version source synchronized", () => {
  const result = verifyReleaseMetadata();
  assert.match(result.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  assert.match(result.changelogState, /^(?:Unreleased|\d{4}-\d{2}-\d{2})$/);
});

test("npm lockfile root metadata matches the release version", async () => {
  const packageMetadata = JSON.parse(await fs.readFile("package.json", "utf8"));
  const lockMetadata = JSON.parse(await fs.readFile("package-lock.json", "utf8"));
  assert.equal(lockMetadata.version, packageMetadata.version);
  assert.equal(lockMetadata.packages[""].version, packageMetadata.version);
});

test("release metadata rejects Node runtime version drift", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kindle-release-metadata-"));
  try {
    await fs.mkdir(path.join(root, "kindle-plugin"), { recursive: true });
    await fs.mkdir(path.join(root, "lib"), { recursive: true });
    for (const relative of [
      "package.json",
      "package-lock.json",
      "CHANGELOG.md",
      "kindle-plugin/plugin.yaml",
      "kindle-plugin/adapter.py",
      "lib/runtime-profile.mjs",
    ]) {
      await fs.copyFile(relative, path.join(root, relative));
    }
    const runtimePath = path.join(root, "lib/runtime-profile.mjs");
    const runtime = await fs.readFile(runtimePath, "utf8");
    await fs.writeFile(
      runtimePath,
      runtime.replace(
        /(NOTEBOOK_VERSION\s*=\s*)["'][^"']+["']/,
        '$1"9.9.9"',
      ),
      "utf8",
    );
    assert.throws(
      () => verifyReleaseMetadata({ root }),
      /lib\/runtime-profile\.mjs=9\.9\.9/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("release builder rejects a caller-supplied metadata mismatch", () => {
  assert.throws(
    () => buildReleaseArtifacts({ version: "99.99.99" }),
    /does not match metadata version/,
  );
});

test("plugin manifest uses the current Hermes password-field contract", async () => {
  const manifest = await fs.readFile("kindle-plugin/plugin.yaml", "utf8");
  assert.match(manifest, /^name: kindle-scribe$/m);
  assert.match(manifest, /^kind: platform$/m);
  assert.match(manifest, /^\s+password:\s+true\s*$/m);
  assert.doesNotMatch(manifest, /^\s+secret:\s+true\s*$/m);
  assert.match(manifest, /^\s+- name: KINDLE_USER$/m);
  assert.match(manifest, /^\s+- name: KINDLE_HOME_CHANNEL$/m);
});

test("direct Python development requirements are exact pins", async () => {
  const requirements = (await fs.readFile("requirements-dev.txt", "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  assert.ok(requirements.length >= 5);
  for (const requirement of requirements) {
    assert.match(requirement, /^[A-Za-z0-9_.-]+==[^\s;]+(?:;.+)?$/);
  }
  for (const required of ["aiohttp", "pip", "pip-audit", "pytest", "pytest-asyncio", "pyyaml"]) {
    assert.ok(
      requirements.some((entry) => entry.toLowerCase().startsWith(`${required}==`)),
      `requirements-dev.txt must pin ${required}`,
    );
  }
  assert.ok(requirements.includes("pip==26.1.2"), "CI bootstrap pip pin must be reviewed explicitly");
});

test("release ancestry dereferences a tag and accepts a main ancestor", () => {
  const calls = [];
  const runGit = (args) => {
    calls.push(args);
    if (args[0] === "rev-parse") return "abc123";
    if (args[0] === "merge-base") return "";
    throw new Error(`unexpected git command: ${args.join(" ")}`);
  };
  assert.equal(verifyReleaseAncestry("v0.2.0", "origin/main", runGit), "abc123");
  assert.deepEqual(calls, [
    ["rev-parse", "v0.2.0^{}"],
    ["merge-base", "--is-ancestor", "abc123", "origin/main"],
  ]);
});

test("release ancestry rejects a tag outside main", () => {
  const runGit = (args) => {
    if (args[0] === "rev-parse") return "def456";
    throw new Error("not an ancestor");
  };
  assert.throws(
    () => verifyReleaseAncestry("v0.2.0", "origin/main", runGit),
    /not reachable from origin\/main/,
  );
});

test("release tag identity matches annotated local, event, and remote refs", () => {
  const runGit = (args) => {
    const command = args.join(" ");
    if (command === "cat-file -t refs/tags/v0.2.0") return "tag";
    if (command === "rev-parse refs/tags/v0.2.0") return "tag-object";
    if (command === "rev-parse refs/tags/v0.2.0^{}") return "release-commit";
    if (command === "rev-parse event-sha^{}") return "release-commit";
    if (command.startsWith("ls-remote --tags origin")) {
      return [
        "tag-object\trefs/tags/v0.2.0",
        "release-commit\trefs/tags/v0.2.0^{}",
      ].join("\n");
    }
    throw new Error(`unexpected git command: ${command}`);
  };
  assert.deepEqual(verifyReleaseTag("v0.2.0", "event-sha", runGit), {
    commit: "release-commit",
    tagObject: "tag-object",
  });
});

test("release tag identity rejects a moved remote tag", () => {
  const runGit = (args) => {
    const command = args.join(" ");
    if (command.startsWith("cat-file")) return "tag";
    if (command === "rev-parse refs/tags/v0.2.0") return "tag-object";
    if (command.startsWith("rev-parse")) return "release-commit";
    if (command.startsWith("ls-remote")) {
      return [
        "other-tag-object\trefs/tags/v0.2.0",
        "other-commit\trefs/tags/v0.2.0^{}",
      ].join("\n");
    }
    throw new Error(`unexpected git command: ${command}`);
  };
  assert.throws(
    () => verifyReleaseTag("v0.2.0", "event-sha", runGit),
    /remote tag object changed/,
  );
});
