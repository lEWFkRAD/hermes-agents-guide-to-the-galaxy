#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { verifyReleaseMetadata } from "./verify-release-metadata.mjs";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : process.argv[index + 1] || "";
}

function git(root, args, options = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: options.encoding || "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
  });
}

function checksum(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function writeChecksum(file) {
  const digest = checksum(file);
  fs.writeFileSync(`${file}.sha256`, `${digest}  ${path.basename(file)}\n`, "ascii");
}

export function buildReleaseArtifacts({
  root = process.cwd(),
  outputDir = "dist",
  treeish = "HEAD",
  version = "",
} = {}) {
  const resolvedRoot = path.resolve(root);
  const metadataVersion = verifyReleaseMetadata({ root: resolvedRoot }).version;
  const releaseVersion = version || metadataVersion;
  if (!SEMVER.test(releaseVersion)) throw new Error(`Invalid release version: ${releaseVersion}`);
  if (releaseVersion !== metadataVersion) {
    throw new Error(
      `Requested release version ${releaseVersion} does not match metadata version ${metadataVersion}`,
    );
  }

  git(resolvedRoot, ["rev-parse", `${treeish}^{tree}`]);
  const resolvedOutput = path.resolve(resolvedRoot, outputDir);
  fs.mkdirSync(resolvedOutput, { recursive: true });

  const productName = `hermes-notebook-v${releaseVersion}.zip`;
  const pluginName = `kindle-scribe-plugin-v${releaseVersion}.zip`;
  const productPath = path.join(resolvedOutput, productName);
  const pluginPath = path.join(resolvedOutput, pluginName);
  for (const file of [productPath, pluginPath, `${productPath}.sha256`, `${pluginPath}.sha256`]) {
    fs.rmSync(file, { force: true });
  }

  git(
    resolvedRoot,
    [
      "archive",
      "--format=zip",
      `--prefix=hermes-notebook-v${releaseVersion}/`,
      `--output=${productPath}`,
      treeish,
    ],
    { stdio: "inherit" },
  );

  const license = git(resolvedRoot, ["show", `${treeish}:LICENSE`]);
  git(
    resolvedRoot,
    [
      "archive",
      "--format=zip",
      `--add-virtual-file=LICENSE:${license}`,
      `--output=${pluginPath}`,
      `${treeish}:kindle-plugin`,
    ],
    { stdio: "inherit" },
  );

  writeChecksum(productPath);
  writeChecksum(pluginPath);
  return { productPath, pluginPath, version: releaseVersion, treeish };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const result = buildReleaseArtifacts({
      outputDir: argument("--output-dir") || "dist",
      treeish: argument("--tree") || process.env.RELEASE_TREEISH || "HEAD",
      version: argument("--version"),
    });
    process.stdout.write(
      `Built ${path.basename(result.productPath)} and ${path.basename(result.pluginPath)} from ${result.treeish}\n`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Release artifact build failed");
    process.exit(1);
  }
}
