import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DATA_ROOT_LOCK_DIRECTORY, isDataRootLockArtifactName } from "../lib/data-root-lock.mjs";

import {
  isOwnedBackupGeneration,
  parseBackupKeep,
  runBackup
} from "../scripts/backup-data.mjs";

async function withTemp(callback) {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "notebook-backup-"));
  const root = await fs.realpath(created);
  try {
    await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writeReceipt(root, generation, overrides = {}) {
  const folder = path.join(root, generation);
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, "backup-manifest.json"), JSON.stringify({
    kind: "hermes-notebook-backup",
    version: 2,
    generation,
    files: [],
    ...overrides
  }), "utf8");
  return folder;
}

test("backup retention accepts only a bounded integer", () => {
  assert.equal(parseBackupKeep(), 14);
  assert.equal(parseBackupKeep(" 2 "), 2);
  assert.equal(parseBackupKeep("1000"), 1000);
  for (const value of ["1", "1001", "2.5", "NaN", "Infinity", "1e2", "-2"]) {
    assert.throws(() => parseBackupKeep(value), /integer between 2 and 1000/);
  }
});

test("only exact generated directories with owned receipts qualify for pruning", async () => {
  await withTemp(async root => {
    const generation = "2026-08-10T12-34-56-789Z";
    const uniqueGeneration = `${generation}-123e4567-e89b-42d3-a456-426614174000`;
    await writeReceipt(root, generation);
    await writeReceipt(root, uniqueGeneration);
    await fs.mkdir(path.join(root, "2026-08-09T12-34-56-789Z"));
    await writeReceipt(root, "2026-08-08T12-34-56-789Z", { version: 1 });
    await writeReceipt(root, "family-photos");

    const entries = await fs.readdir(root, { withFileTypes: true });
    const owned = [];
    for (const entry of entries) {
      if (await isOwnedBackupGeneration(root, entry)) owned.push(entry.name);
    }
    assert.deepEqual(owned.sort(), [generation, uniqueGeneration]);
  });
});

test("backup refuses a moving source and publishes no partial generation", async () => {
  await withTemp(async root => {
    const dataDir = path.join(root, "data");
    const backupDir = path.join(root, "backups");
    await fs.mkdir(path.join(dataDir, "nested"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "nested", "entry.txt"), "before", "utf8");

    await assert.rejects(runBackup({
      environ: {
        DIARY_DATA_DIR: dataDir,
        DIARY_BACKUP_DIR: backupDir,
        DIARY_BACKUP_KEEP: "14",
        LOCALAPPDATA: path.join(root, "Local")
      },
      now: new Date("2026-08-10T12:34:56.789Z"),
      beforeSourceRecheck: async () => {
        await fs.writeFile(path.join(dataDir, "nested", "entry.txt"), "after", "utf8");
        await fs.mkdir(path.join(dataDir, "new-empty-directory"));
      }
    }), /Backup source changed during snapshot/);

    assert.deepEqual(await fs.readdir(backupDir), []);
  });
});

test("same-timestamp concurrent backups use exclusive stages and never overwrite", async () => {
  await withTemp(async root => {
    const dataDir = path.join(root, "data");
    const backupDir = path.join(root, "backups");
    await fs.mkdir(path.join(dataDir, "empty"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "entry.txt"), "stable", "utf8");
    const environ = {
      DIARY_DATA_DIR: dataDir,
      DIARY_BACKUP_DIR: backupDir,
      DIARY_BACKUP_KEEP: "14",
      LOCALAPPDATA: path.join(root, "Local")
    };
    const now = new Date("2026-08-10T12:34:56.789Z");

    const [first, second] = await Promise.all([
      runBackup({ environ, now }),
      runBackup({ environ, now })
    ]);

    assert.notEqual(first.destination, second.destination);
    const expected = /^2026-08-10T12-34-56-789Z-[0-9a-f-]{36}$/;
    assert.match(path.basename(first.destination), expected);
    assert.match(path.basename(second.destination), expected);
    for (const result of [first, second]) {
      assert.equal(await fs.readFile(path.join(result.destination, "entry.txt"), "utf8"), "stable");
      const receipt = JSON.parse(await fs.readFile(
        path.join(result.destination, "backup-manifest.json"),
        "utf8"
      ));
      assert.equal(receipt.generation, path.basename(result.destination));
      assert.match(receipt.manifestSha256, /^[0-9a-f]{64}$/);
      assert.ok(receipt.entries.some(item => item.path === "empty" && item.type === "directory"));
    }
    assert.equal((await fs.readdir(backupDir)).some(name => name.startsWith(".")), false);
  });
});

test("backup excludes every reserved root-level data ownership artifact", async () => {
  await withTemp(async root => {
    const dataDir = path.join(root, "data");
    const backupDir = path.join(root, "backups");
    await fs.mkdir(dataDir);
    await fs.writeFile(path.join(dataDir, "entry.txt"), "notebook data", "utf8");
    const artifacts = [
      DATA_ROOT_LOCK_DIRECTORY,
      `${DATA_ROOT_LOCK_DIRECTORY}.candidate-123-abc`,
      `${DATA_ROOT_LOCK_DIRECTORY}.recovery-${"a".repeat(64)}`,
      ".hermes-notebook-stale-123e4567-e89b-42d3-a456-426614174000",
      ".hermes-notebook-released-123e4567-e89b-42d3-a456-426614174000"
    ];
    for (const artifact of artifacts) {
      await fs.mkdir(path.join(dataDir, artifact));
      await fs.writeFile(path.join(dataDir, artifact, "owner.json"), "host-private-owner", "utf8");
    }

    const result = await runBackup({
      environ: {
        DIARY_DATA_DIR: dataDir,
        DIARY_BACKUP_DIR: backupDir,
        DIARY_BACKUP_KEEP: "14",
        LOCALAPPDATA: path.join(root, "Local")
      },
      now: new Date("2026-08-10T12:34:56.789Z")
    });

    assert.equal(await fs.readFile(path.join(result.destination, "entry.txt"), "utf8"), "notebook data");
    const rootEntries = await fs.readdir(result.destination);
    assert.equal(rootEntries.some(isDataRootLockArtifactName), false);
    const receipt = JSON.parse(await fs.readFile(
      path.join(result.destination, "backup-manifest.json"),
      "utf8"
    ));
    assert.equal(receipt.entries.some(item => isDataRootLockArtifactName(item.path.split("/")[0])), false);
    assert.doesNotMatch(JSON.stringify(receipt), /host-private-owner|owner\.json/);
  });
});

test("backup pruning preserves unrelated and malformed directories", async () => {
  await withTemp(async root => {
    const dataDir = path.join(root, "data");
    const backupDir = path.join(root, "backups");
    await fs.mkdir(dataDir);
    await fs.mkdir(backupDir);
    await fs.writeFile(path.join(dataDir, "entry.txt"), "private notebook entry", "utf8");

    for (const generation of [
      "2025-01-01T00-00-00-000Z",
      "2025-02-01T00-00-00-000Z",
      "2025-03-01T00-00-00-000Z"
    ]) {
      await writeReceipt(backupDir, generation);
    }
    const unrelatedTimestamp = "2024-01-01T00-00-00-000Z";
    await fs.mkdir(path.join(backupDir, unrelatedTimestamp));
    await fs.mkdir(path.join(backupDir, "family-photos"));

    const result = await runBackup({
      environ: {
        DIARY_DATA_DIR: dataDir,
        DIARY_BACKUP_DIR: backupDir,
        DIARY_BACKUP_KEEP: "2",
        LOCALAPPDATA: path.join(root, "Local")
      },
      now: new Date("2026-08-10T12:34:56.789Z")
    });

    assert.equal(result.files, 1);
    assert.equal(await fs.readFile(path.join(result.destination, "entry.txt"), "utf8"), "private notebook entry");
    const receipt = JSON.parse(await fs.readFile(
      path.join(result.destination, "backup-manifest.json"),
      "utf8"
    ));
    assert.equal(receipt.kind, "hermes-notebook-backup");
    assert.equal(receipt.generation, path.basename(result.destination));

    assert.equal(await fs.stat(path.join(backupDir, "2025-03-01T00-00-00-000Z")).then(() => true), true);
    await assert.rejects(fs.stat(path.join(backupDir, "2025-02-01T00-00-00-000Z")), /ENOENT/);
    await assert.rejects(fs.stat(path.join(backupDir, "2025-01-01T00-00-00-000Z")), /ENOENT/);
    assert.equal(await fs.stat(path.join(backupDir, unrelatedTimestamp)).then(() => true), true);
    assert.equal(await fs.stat(path.join(backupDir, "family-photos")).then(() => true), true);
  });
});
