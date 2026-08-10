#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function verifyReleaseAncestry(tag, mainRef, runGit = git) {
  if (!tag || !mainRef) throw new Error("Both --tag and --main-ref are required");

  const tagCommit = runGit(["rev-parse", `${tag}^{}`]);
  if (!tagCommit) throw new Error(`Could not resolve release tag ${tag} to a commit`);

  try {
    runGit(["merge-base", "--is-ancestor", tagCommit, mainRef]);
  } catch {
    throw new Error(
      `Release tag ${tag} resolves to ${tagCommit}, which is not reachable from ${mainRef}`,
    );
  }
  return tagCommit;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : process.argv[index + 1] || "";
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const tag = argument("--tag");
    const mainRef = argument("--main-ref");
    const commit = verifyReleaseAncestry(tag, mainRef);
    process.stdout.write(`${tag} is releasable from ${mainRef} at ${commit}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Release ancestry validation failed");
    process.exit(1);
  }
}
