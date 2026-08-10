#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDataRootLockArtifactName } from "../lib/data-root-lock.mjs";

import {
  PROFILE_MIGRATION_RECEIPT_KIND,
  PROFILE_MIGRATION_RECEIPT_NAME,
  PROFILE_MIGRATION_RECEIPT_VERSION,
  profileMigrationManifestDigest,
  resolveNotebookRuntime,
  validateProfileMigrationReceipt
} from "../lib/runtime-profile.mjs";

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function hash(file) {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

async function treeFiles(root, folder = root, { ignoreReceipt = false } = {}) {
  const result = [];
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    if (folder === root && isDataRootLockArtifactName(entry.name)) {
      throw new Error(
        `Legacy state contains Notebook runtime ownership artifact ${entry.name}; ` +
        "stop every bridge and recover or remove the lock before migration"
      );
    }
    if (ignoreReceipt && folder === root && entry.name === PROFILE_MIGRATION_RECEIPT_NAME) continue;
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) result.push(...await treeFiles(root, full, { ignoreReceipt }));
    else if (entry.isFile()) result.push(path.relative(root, full));
    else throw new Error(`Legacy state contains an unsupported entry: ${path.relative(root, full)}`);
  }
  return result.sort();
}

async function snapshotTree(root, { ignoreReceipt = false } = {}) {
  const files = await treeFiles(root, root, { ignoreReceipt });
  if (!ignoreReceipt && files.some(relative => relative.replaceAll("\\", "/") === PROFILE_MIGRATION_RECEIPT_NAME)) {
    throw new Error(`Legacy state contains the reserved ${PROFILE_MIGRATION_RECEIPT_NAME} path`);
  }
  const manifest = [];
  for (const relative of files) {
    manifest.push({
      path: relative.replaceAll("\\", "/"),
      sha256: await hash(path.join(root, relative))
    });
  }
  return manifest;
}

function sameManifest(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function requireUnchangedSnapshot(source, expected, label) {
  const current = await snapshotTree(source);
  if (!sameManifest(current, expected)) {
    throw new Error(`${label} legacy state changed during migration; stop the bridge and retry`);
  }
}

async function directoryEntries(folder) {
  try {
    return await fs.readdir(folder);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function requireNoRuntimeOwnership(folder, label) {
  const artifact = (await directoryEntries(folder)).find(isDataRootLockArtifactName);
  if (artifact) {
    throw new Error(
      `${label} contains Notebook runtime ownership artifact ${artifact}; ` +
      "stop every bridge and recover or remove the lock before migration"
    );
  }
}

async function existingReceipt(target, source) {
  try {
    const receiptPath = path.join(target, PROFILE_MIGRATION_RECEIPT_NAME);
    const stat = await fs.stat(receiptPath);
    if (!stat.isFile() || stat.size < 2 || stat.size > 1024 * 1024) {
      throw new Error("migration receipt is not a bounded regular file");
    }
    const raw = await fs.readFile(receiptPath, "utf8");
    const receipt = JSON.parse(raw);
    if (!validateProfileMigrationReceipt(receipt, { source, destination: target })) {
      throw new Error("migration receipt metadata is invalid");
    }
    const [sourceManifest, targetManifest] = await Promise.all([
      snapshotTree(source),
      snapshotTree(target, { ignoreReceipt: true })
    ]);
    if (!sameManifest(sourceManifest, receipt.files) || !sameManifest(targetManifest, receipt.files)) {
      throw new Error("migration receipt no longer matches the source and destination manifests");
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new Error(`Existing profile migration state is invalid: ${error.message}`);
  }
}

async function migrateTree(source, target, label, migratedAt, beforeCommit) {
  await requireNoRuntimeOwnership(source, `${label} legacy source`);
  await requireNoRuntimeOwnership(target, `${label} target`);
  const sourceEntries = await directoryEntries(source);
  if (sourceEntries.length === 0) return { label, status: "no-legacy-state" };
  if (await existingReceipt(target, source)) return { label, status: "already-migrated" };

  const targetEntries = await directoryEntries(target);
  if (targetEntries.length > 0) {
    throw new Error(`${label} target is not empty and has no matching migration receipt`);
  }

  const parent = path.dirname(target);
  const stage = path.join(parent, `.${path.basename(target)}.migrating-${randomUUID()}`);
  const manifest = await snapshotTree(source);
  await fs.mkdir(parent, { recursive: true });
  let committed = false;
  try {
    await fs.mkdir(stage);
    for (const entry of manifest) {
      const relative = entry.path.split("/").join(path.sep);
      const input = path.join(source, relative);
      const output = path.join(stage, relative);
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.copyFile(input, output, fs.constants.COPYFILE_EXCL);
      const destinationHash = await hash(output);
      if (entry.sha256 !== destinationHash) {
        throw new Error(`${label} migration verification failed: ${entry.path}`);
      }
    }
    if (beforeCommit) await beforeCommit({ label, source, target, stage });
    await requireUnchangedSnapshot(source, manifest, label);
    const stagedManifest = await snapshotTree(stage);
    if (!sameManifest(stagedManifest, manifest)) {
      throw new Error(`${label} staged state changed during migration`);
    }
    const receipt = {
      kind: PROFILE_MIGRATION_RECEIPT_KIND,
      version: PROFILE_MIGRATION_RECEIPT_VERSION,
      migratedAt,
      source,
      destination: target,
      files: manifest,
      manifestSha256: profileMigrationManifestDigest(manifest)
    };
    await fs.writeFile(
      path.join(stage, PROFILE_MIGRATION_RECEIPT_NAME),
      JSON.stringify(receipt, null, 2),
      "utf8"
    );

    // This is deliberately the final awaited source operation before the
    // same-filesystem rename. Users must still stop the bridge because no
    // portable filesystem API can lock an entire directory tree.
    await requireUnchangedSnapshot(source, manifest, label);

    await requireNoRuntimeOwnership(target, `${label} target`);
    if ((await directoryEntries(target)).length === 0) {
      await fs.rmdir(target).catch(error => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
    await fs.rename(stage, target);
    committed = true;
    return { label, status: "migrated", files: manifest.length, source, target };
  } finally {
    if (!committed) await fs.rm(stage, { recursive: true, force: true });
  }
}

export async function migrateProfileData({
  environ = process.env,
  now = new Date(),
  repoRoot = moduleRoot,
  beforeCommit
} = {}) {
  const root = path.resolve(repoRoot);
  const runtime = resolveNotebookRuntime({
    environ,
    repoRoot: root,
    allowLegacyMigration: true
  });
  if (!runtime.profileSelected) {
    throw new Error("HERMES_HOME must select the destination profile before migration");
  }

  const migratedAt = now.toISOString();
  const results = [];
  results.push(await migrateTree(
    path.join(root, "data"),
    runtime.dataDir,
    "data",
    migratedAt,
    beforeCommit
  ));
  results.push(await migrateTree(
    path.join(root, "backups"),
    runtime.backupDir,
    "backups",
    migratedAt,
    beforeCommit
  ));
  if (results.every(result => result.status === "no-legacy-state")) {
    throw new Error("No legacy checkout data or backups were found to migrate");
  }
  return { profile: runtime.profileName, profileHome: runtime.profileHome, results };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    console.log(JSON.stringify(await migrateProfileData(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Profile migration failed");
    process.exitCode = 1;
  }
}
