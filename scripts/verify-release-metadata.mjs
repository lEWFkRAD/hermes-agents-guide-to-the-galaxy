#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function fail(message) {
  throw new Error(message);
}

function read(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

export function verifyReleaseMetadata({ root = process.cwd(), tag = "" } = {}) {
  const packageMetadata = JSON.parse(read(root, "package.json"));
  const packageVersion = packageMetadata.version;
  if (!SEMVER.test(packageVersion)) {
    fail(`package.json has an invalid SemVer version: ${packageVersion}`);
  }

  const lockMetadata = JSON.parse(read(root, "package-lock.json"));
  const lockVersion = lockMetadata.version;
  const lockRootVersion = lockMetadata.packages?.[""]?.version;

  const manifest = read(root, "kindle-plugin/plugin.yaml");
  const manifestVersion = manifest.match(/^version:\s*(\S+)\s*$/m)?.[1];
  if (!manifestVersion) fail("kindle-plugin/plugin.yaml does not declare a version");

  const adapter = read(root, "kindle-plugin/adapter.py");
  const runtimeVersion = adapter.match(
    /^PLUGIN_VERSION\s*=\s*["']([^"']+)["']\s*$/m,
  )?.[1];
  if (!runtimeVersion) fail("kindle-plugin/adapter.py does not declare PLUGIN_VERSION");

  const runtimeProfile = read(root, "lib/runtime-profile.mjs");
  const notebookVersion = runtimeProfile.match(
    /^export const NOTEBOOK_VERSION\s*=\s*["']([^"']+)["'];?\s*$/m,
  )?.[1];
  if (!notebookVersion) fail("lib/runtime-profile.mjs does not declare NOTEBOOK_VERSION");

  const versions = {
    "package.json": packageVersion,
    "package-lock.json": lockVersion,
    "package-lock.json root package": lockRootVersion,
    "kindle-plugin/plugin.yaml": manifestVersion,
    "kindle-plugin/adapter.py": runtimeVersion,
    "lib/runtime-profile.mjs": notebookVersion,
  };
  const mismatches = Object.entries(versions)
    .filter(([, version]) => version !== packageVersion)
    .map(([source, version]) => `${source}=${version}`);
  if (mismatches.length) {
    fail(`Release version mismatch: package.json=${packageVersion}; ${mismatches.join("; ")}`);
  }

  const changelog = read(root, "CHANGELOG.md");
  const escapedVersion = packageVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const releaseHeading = changelog.match(
    new RegExp(`^## \\[${escapedVersion}\\] - (Unreleased|\\d{4}-\\d{2}-\\d{2})$`, "m"),
  );
  if (!releaseHeading) {
    fail(`CHANGELOG.md must contain "## [${packageVersion}] - Unreleased" or a dated release heading`);
  }

  if (tag) {
    if (tag !== `v${packageVersion}`) {
      fail(`Tag ${tag} does not match release version v${packageVersion}`);
    }
    if (releaseHeading[1] === "Unreleased") {
      fail(`CHANGELOG.md must date the ${packageVersion} section before tag ${tag} can be released`);
    }
  }

  return { version: packageVersion, changelogState: releaseHeading[1] };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : process.argv[index + 1] || "";
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const result = verifyReleaseMetadata({ tag: argument("--tag") });
    process.stdout.write(`${result.version}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Release metadata validation failed");
    process.exit(1);
  }
}
