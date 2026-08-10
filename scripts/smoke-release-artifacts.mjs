#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { verifyReleaseMetadata } from "./verify-release-metadata.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : process.argv[index + 1] || "";
}

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function listZip(file) {
  return execFileSync("tar", ["-tf", file], { encoding: "utf8" })
    .split(/\r?\n/)
    .map((entry) => entry.replaceAll("\\", "/").replace(/^\.\//, ""))
    .filter((entry) => entry && !entry.endsWith("/"));
}

function archiveText(file, entry) {
  return execFileSync("tar", ["-xOf", file, entry], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
}

function verifyChecksum(file) {
  const expected = fs.readFileSync(`${file}.sha256`, "ascii").trim();
  const digest = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  assert.equal(expected, `${digest}  ${path.basename(file)}`);
}

const FORBIDDEN_ARCHIVE_PATHS = [
  /(^|\/)\.env(?:\.[^/]*)?$/i,
  /(^|\/)(?:data|backups|node_modules|dist|\.hermes-agent|\.venv|venv|__pycache__|\.pytest_cache|\.hermes-notebook-[^/]+)(?:\/|$)/i,
  /(^|\/)pytest-cache-files-[^/]+(?:\/|$)/i,
  /(^|\/)(?:\.?(?:api|auth|access|refresh|ingest)[-_.]?token|\.?tokens?)(?:\.[^/]*)?$/i,
  /\.(?:log|pyc|pyo|pid|sock|key|pem|pfx|p12|jks)$/i,
];

export function assertArchiveHygiene(entries) {
  const violations = entries.filter((entry) =>
    FORBIDDEN_ARCHIVE_PATHS.some((pattern) => pattern.test(entry)),
  );
  assert.deepEqual(violations, [], `Forbidden release paths:\n${violations.join("\n")}`);
}

export function smokeReleaseArtifacts({
  root = process.cwd(),
  outputDir = "dist",
  treeish = "HEAD",
  version = "",
} = {}) {
  const resolvedRoot = path.resolve(root);
  const metadataVersion = verifyReleaseMetadata({ root: resolvedRoot }).version;
  const releaseVersion = version || metadataVersion;
  assert.equal(
    releaseVersion,
    metadataVersion,
    "Requested artifact version must match synchronized release metadata",
  );
  const resolvedOutput = path.resolve(resolvedRoot, outputDir);
  const productPath = path.join(resolvedOutput, `hermes-notebook-v${releaseVersion}.zip`);
  const pluginPath = path.join(resolvedOutput, `kindle-scribe-plugin-v${releaseVersion}.zip`);
  for (const file of [productPath, pluginPath, `${productPath}.sha256`, `${pluginPath}.sha256`]) {
    assert.ok(fs.existsSync(file), `Missing release artifact: ${file}`);
  }
  verifyChecksum(productPath);
  verifyChecksum(pluginPath);

  const tracked = git(resolvedRoot, ["ls-tree", "-r", "--name-only", treeish])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((entry) => entry.replaceAll("\\", "/"));
  const productPrefix = `hermes-notebook-v${releaseVersion}/`;
  const expectedProduct = tracked.map((entry) => `${productPrefix}${entry}`).sort();
  const productEntries = listZip(productPath).sort();
  assert.deepEqual(productEntries, expectedProduct, "Whole-product ZIP must match the tracked Git tree exactly");

  const pluginTracked = git(resolvedRoot, [
    "ls-tree",
    "-r",
    "--name-only",
    `${treeish}:kindle-plugin`,
  ])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((entry) => entry.replaceAll("\\", "/"));
  const expectedPlugin = [...pluginTracked, "LICENSE"].sort();
  const pluginEntries = listZip(pluginPath).sort();
  assert.deepEqual(pluginEntries, expectedPlugin, "Plugin ZIP must use the plugin directory as archive root");
  for (const required of ["__init__.py", "adapter.py", "after-install.md", "plugin.yaml", "LICENSE"]) {
    assert.ok(pluginEntries.includes(required), `Plugin archive is missing ${required}`);
  }

  assertArchiveHygiene(productEntries);
  assertArchiveHygiene(pluginEntries);

  const productPackage = JSON.parse(archiveText(productPath, `${productPrefix}package.json`));
  assert.equal(productPackage.version, releaseVersion);
  const runtimeProfile = archiveText(productPath, `${productPrefix}lib/runtime-profile.mjs`);
  assert.match(
    runtimeProfile,
    new RegExp(
      `^export const NOTEBOOK_VERSION\\s*=\\s*["']${releaseVersion.replaceAll(".", "\\.")}["'];?\\s*$`,
      "m",
    ),
  );
  const pluginManifest = archiveText(pluginPath, "plugin.yaml");
  assert.match(pluginManifest, new RegExp(`^version:\\s*${releaseVersion.replaceAll(".", "\\.")}\\s*$`, "m"));
  assert.match(pluginManifest, /^\s+password:\s+true\s*$/m);
  assert.doesNotMatch(pluginManifest, /^\s+secret:\s+true\s*$/m);
  assert.match(pluginManifest, /^\s+- name: KINDLE_USER$/m);
  assert.match(pluginManifest, /^\s+- name: KINDLE_HOME_CHANNEL$/m);
  const adapter = archiveText(pluginPath, "adapter.py");
  assert.match(
    adapter,
    new RegExp(`^PLUGIN_VERSION\\s*=\\s*["']${releaseVersion.replaceAll(".", "\\.")}["']\\s*$`, "m"),
  );

  return { productPath, pluginPath, version: releaseVersion, treeish };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const result = smokeReleaseArtifacts({
      outputDir: argument("--output-dir") || "dist",
      treeish: argument("--tree") || process.env.RELEASE_TREEISH || "HEAD",
      version: argument("--version"),
    });
    process.stdout.write(
      `Verified ${path.basename(result.productPath)} and ${path.basename(result.pluginPath)} against ${result.treeish}\n`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Release artifact smoke test failed");
    process.exit(1);
  }
}
