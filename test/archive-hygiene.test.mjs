import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { assertArchiveHygiene } from "../scripts/smoke-release-artifacts.mjs";

const FORBIDDEN = [
  { kind: "environment file", pattern: /(^|\/)\.env(?:\.[^/]*)?$/i },
  {
    kind: "runtime directory",
    pattern: /(^|\/)(?:data|backups|node_modules|dist|\.hermes-agent|\.venv|venv|__pycache__|\.pytest_cache|\.hermes-notebook-[^/]+)(?:\/|$)/i,
  },
  { kind: "pytest temporary directory", pattern: /(^|\/)pytest-cache-files-[^/]+(?:\/|$)/i },
  {
    kind: "token file",
    pattern: /(^|\/)(?:\.?(?:api|auth|access|refresh|ingest)[-_.]?token|\.?tokens?)(?:\.[^/]*)?$/i,
  },
  { kind: "secret or runtime file", pattern: /\.(?:log|pyc|pyo|pid|sock|key|pem|pfx|p12|jks)$/i },
];

function violationsFor(paths) {
  return paths.flatMap((entry) =>
    FORBIDDEN.filter(({ pattern }) => pattern.test(entry)).map(({ kind }) => `${kind}: ${entry}`),
  );
}

test("data-root ownership receipts and recovery residue are forbidden", () => {
  const digest = "a".repeat(64);
  const paths = [
    `.hermes-notebook-${digest}.owner/owner.json`,
    `.hermes-notebook-${digest}.owner.candidate-123-abc/owner.json`,
    `.hermes-notebook-${digest}.owner.recovery-${"b".repeat(64)}/owner.json`,
    `.hermes-notebook-${digest}.owner.stale-123/owner.json`,
    `.hermes-notebook-${digest}.owner.released-123/owner.json`,
  ];
  assert.equal(violationsFor(paths).length, paths.length);
});

test("release ZIP smoke rejects every sibling lock and recovery directory", () => {
  const digest = "c".repeat(64);
  const entries = [
    `.hermes-notebook-${digest}.owner.lock/lock.json`,
    `.hermes-notebook-${digest}.owner.candidate-123/owner.json`,
    `.hermes-notebook-${digest}.owner.recovery-${"d".repeat(64)}/owner.json`,
    `.hermes-notebook-${digest}.owner.quarantine-123/owner.json`,
  ];
  for (const entry of entries) {
    assert.throws(
      () => assertArchiveHygiene([`hermes-notebook-v0.2.0/${entry}`]),
      /Forbidden release paths/,
    );
  }
});

test("the tracked release tree excludes secrets and runtime artifacts", (context) => {
  let tracked;
  try {
    tracked = execFileSync("git", ["ls-files", "-z"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = error?.stderr?.toString() || "";
    if (/not a git repository/i.test(stderr)) {
      context.skip("archive extraction has no Git metadata");
      return;
    }
    throw error;
  }
  const paths = tracked.split("\0").filter(Boolean).map((entry) => entry.replaceAll("\\", "/"));
  const violations = violationsFor(paths);
  assert.deepEqual(violations, [], `Forbidden paths would enter a release archive:\n${violations.join("\n")}`);
});
