#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function verifyReleaseTag(tag, eventSha, runGit = git) {
  if (!tag || !eventSha) throw new Error("Both --tag and --event-sha are required");

  const tagRef = `refs/tags/${tag}`;
  if (runGit(["cat-file", "-t", tagRef]) !== "tag") {
    throw new Error(`Release tag ${tag} must be an annotated tag`);
  }

  const tagObject = runGit(["rev-parse", tagRef]);
  const commit = runGit(["rev-parse", `${tagRef}^{}`]);
  const eventCommit = runGit(["rev-parse", `${eventSha}^{}`]);
  if (eventCommit !== commit) {
    throw new Error(`Release event resolves to ${eventCommit}, not tagged commit ${commit}`);
  }

  const remoteOutput = runGit([
    "ls-remote",
    "--tags",
    "origin",
    tagRef,
    `${tagRef}^{}`,
  ]);
  const remoteRefs = new Map(
    remoteOutput
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.split(/\s+/, 2).reverse()),
  );
  const remoteTagObject = remoteRefs.get(tagRef);
  const remoteCommit = remoteRefs.get(`${tagRef}^{}`);
  if (!remoteTagObject || !remoteCommit) {
    throw new Error(`Remote release tag ${tag} is missing or is not annotated`);
  }
  if (remoteTagObject !== tagObject) {
    throw new Error(`The remote tag object changed for ${tag}`);
  }
  if (remoteCommit !== commit) {
    throw new Error(`The remote tag ${tag} now resolves to ${remoteCommit}, not ${commit}`);
  }

  return { commit, tagObject };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : process.argv[index + 1] || "";
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const tag = argument("--tag");
    const result = verifyReleaseTag(tag, argument("--event-sha"));
    process.stdout.write(`${tag} is immutable at ${result.commit}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Release tag validation failed");
    process.exit(1);
  }
}
