import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireDataRootLock,
  DATA_ROOT_LOCK_DIRECTORY,
  DATA_ROOT_LOCK_OWNER_FILE
} from "../lib/data-root-lock.mjs";
import { RuntimeConfigurationError, resolveNotebookRuntime } from "../lib/runtime-profile.mjs";
import { migrateProfileData } from "../scripts/migrate-profile-data.mjs";

async function withTemp(callback) {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "notebook-migration-"));
  const root = await fs.realpath(created);
  try {
    await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function selectedEnvironment(root, profileHome) {
  return {
    LOCALAPPDATA: path.join(root, "Local"),
    HERMES_HOME: profileHome,
    HERMES_PROFILE_NAME: "research"
  };
}

test("selected-profile startup refuses to hide legacy checkout state", async () => {
  await withTemp(async root => {
    const repoRoot = path.join(root, "checkout");
    const profileHome = path.join(root, "Local", "hermes", "profiles", "research");
    await fs.mkdir(path.join(repoRoot, "data"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "data", "sessions.json"), "[]", "utf8");

    assert.throws(
      () => resolveNotebookRuntime({
        environ: selectedEnvironment(root, profileHome),
        repoRoot
      }),
      error => error instanceof RuntimeConfigurationError && /migrate:profile/.test(error.message)
    );
  });
});

test("selected-profile startup refuses a populated target without a matching receipt", async () => {
  await withTemp(async root => {
    const repoRoot = path.join(root, "checkout");
    const profileHome = path.join(root, "Local", "hermes", "profiles", "research");
    await fs.mkdir(path.join(repoRoot, "data"), { recursive: true });
    await fs.mkdir(path.join(profileHome, "notebook", "data"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "data", "legacy.json"), "[]", "utf8");
    await fs.writeFile(path.join(profileHome, "notebook", "data", "new.json"), "[]", "utf8");

    assert.throws(
      () => resolveNotebookRuntime({
        environ: selectedEnvironment(root, profileHome),
        repoRoot
      }),
      error => error instanceof RuntimeConfigurationError && /conflicts with a populated/.test(error.message)
    );
  });
});

test("profile migration copies and verifies state without deleting the legacy source", async () => {
  await withTemp(async root => {
    const repoRoot = path.join(root, "checkout");
    const profileHome = path.join(root, "Local", "hermes", "profiles", "research");
    const legacyData = path.join(repoRoot, "data");
    const legacyBackups = path.join(repoRoot, "backups");
    await fs.mkdir(path.join(legacyData, "images"), { recursive: true });
    await fs.mkdir(legacyBackups, { recursive: true });
    await fs.writeFile(path.join(legacyData, "sessions.json"), "[{\"id\":\"old\"}]", "utf8");
    await fs.writeFile(path.join(legacyData, "images", "ink.bin"), "ink", "utf8");
    await fs.writeFile(path.join(legacyBackups, "old.txt"), "backup", "utf8");
    const environ = selectedEnvironment(root, profileHome);

    const first = await migrateProfileData({
      environ,
      repoRoot,
      now: new Date("2026-08-10T12:34:56.789Z")
    });
    assert.equal(first.profile, "research");
    assert.deepEqual(first.results.map(result => result.status), ["migrated", "migrated"]);

    const runtime = resolveNotebookRuntime({ environ, repoRoot });
    assert.equal(
      await fs.readFile(path.join(runtime.dataDir, "sessions.json"), "utf8"),
      "[{\"id\":\"old\"}]"
    );
    assert.equal(await fs.readFile(path.join(runtime.backupDir, "old.txt"), "utf8"), "backup");
    assert.equal(await fs.readFile(path.join(legacyData, "images", "ink.bin"), "utf8"), "ink");
    assert.equal(await fs.readFile(path.join(legacyBackups, "old.txt"), "utf8"), "backup");

    const receipt = JSON.parse(await fs.readFile(
      path.join(runtime.dataDir, ".profile-migration.json"),
      "utf8"
    ));
    assert.equal(receipt.kind, "hermes-notebook-profile-migration");
    assert.equal(receipt.files.length, 2);
    assert.match(receipt.manifestSha256, /^[0-9a-f]{64}$/);

    const second = await migrateProfileData({ environ, repoRoot });
    assert.deepEqual(
      second.results.map(result => result.status),
      ["already-migrated", "already-migrated"]
    );
  });
});

test("migration refuses a source that changes after copying and leaves no target", async () => {
  await withTemp(async root => {
    const repoRoot = path.join(root, "checkout");
    const profileHome = path.join(root, "Local", "hermes", "profiles", "research");
    const legacyData = path.join(repoRoot, "data");
    const targetData = path.join(profileHome, "notebook", "data");
    await fs.mkdir(legacyData, { recursive: true });
    await fs.writeFile(path.join(legacyData, "sessions.json"), "before", "utf8");

    await assert.rejects(
      migrateProfileData({
        environ: selectedEnvironment(root, profileHome),
        repoRoot,
        beforeCommit: async ({ label }) => {
          if (label === "data") {
            await fs.writeFile(path.join(legacyData, "sessions.json"), "after", "utf8");
            await fs.writeFile(path.join(legacyData, "late.json"), "late", "utf8");
          }
        }
      }),
      /legacy state changed during migration/
    );
    assert.equal(await fs.readFile(path.join(legacyData, "sessions.json"), "utf8"), "after");
    await assert.rejects(fs.stat(targetData), /ENOENT/);
  });
});

test("an existing receipt is accepted only while both migration manifests match", async () => {
  await withTemp(async root => {
    const repoRoot = path.join(root, "checkout");
    const profileHome = path.join(root, "Local", "hermes", "profiles", "research");
    const legacyData = path.join(repoRoot, "data");
    const targetData = path.join(profileHome, "notebook", "data");
    await fs.mkdir(legacyData, { recursive: true });
    await fs.writeFile(path.join(legacyData, "sessions.json"), "original", "utf8");
    const options = { environ: selectedEnvironment(root, profileHome), repoRoot };

    await migrateProfileData(options);
    await fs.writeFile(path.join(targetData, "sessions.json"), "corrupt", "utf8");

    await assert.rejects(
      migrateProfileData(options),
      /receipt no longer matches the source and destination manifests/
    );
    assert.equal(await fs.readFile(path.join(legacyData, "sessions.json"), "utf8"), "original");
    assert.equal(await fs.readFile(path.join(targetData, "sessions.json"), "utf8"), "corrupt");
  });
});

test("startup rejects legacy writes made after a completed migration", async () => {
  await withTemp(async root => {
    const repoRoot = path.join(root, "checkout");
    const profileHome = path.join(root, "Local", "hermes", "profiles", "research");
    const legacyData = path.join(repoRoot, "data");
    await fs.mkdir(legacyData, { recursive: true });
    await fs.writeFile(path.join(legacyData, "sessions.json"), "original", "utf8");
    const options = { environ: selectedEnvironment(root, profileHome), repoRoot };

    await migrateProfileData(options);
    await fs.writeFile(path.join(legacyData, "sessions.json"), "new legacy write", "utf8");
    await fs.writeFile(path.join(legacyData, "late.json"), "late", "utf8");

    assert.throws(
      () => resolveNotebookRuntime(options),
      error => error instanceof RuntimeConfigurationError && /no valid migration receipt/.test(error.message)
    );
  });
});

test("migration refuses a populated target without an ownership receipt", async () => {
  await withTemp(async root => {
    const repoRoot = path.join(root, "checkout");
    const profileHome = path.join(root, "Local", "hermes", "profiles", "research");
    const legacyData = path.join(repoRoot, "data");
    const targetData = path.join(profileHome, "notebook", "data");
    await fs.mkdir(legacyData, { recursive: true });
    await fs.mkdir(targetData, { recursive: true });
    await fs.writeFile(path.join(legacyData, "old.txt"), "old", "utf8");
    await fs.writeFile(path.join(targetData, "new.txt"), "new", "utf8");

    await assert.rejects(
      migrateProfileData({ environ: selectedEnvironment(root, profileHome), repoRoot }),
      /target is not empty and has no matching migration receipt/
    );
    assert.equal(await fs.readFile(path.join(legacyData, "old.txt"), "utf8"), "old");
    assert.equal(await fs.readFile(path.join(targetData, "new.txt"), "utf8"), "new");
  });
});

test("migration refuses runtime ownership artifacts in either source or target", async () => {
  await withTemp(async root => {
    const repoRoot = path.join(root, "checkout");
    const profileHome = path.join(root, "Local", "hermes", "profiles", "research");
    const legacyData = path.join(repoRoot, "data");
    const targetData = path.join(profileHome, "notebook", "data");
    const environ = selectedEnvironment(root, profileHome);
    await fs.mkdir(legacyData, { recursive: true });
    await fs.writeFile(path.join(legacyData, "sessions.json"), "[]", "utf8");

    const sourceLock = path.join(legacyData, DATA_ROOT_LOCK_DIRECTORY);
    await fs.mkdir(sourceLock);
    await fs.writeFile(path.join(sourceLock, DATA_ROOT_LOCK_OWNER_FILE), "{}", "utf8");
    await assert.rejects(
      migrateProfileData({ environ, repoRoot }),
      /legacy source contains Notebook runtime ownership artifact.*stop every bridge/
    );
    await fs.rm(sourceLock, { recursive: true, force: true });

    const targetGuard = path.join(targetData, `${DATA_ROOT_LOCK_DIRECTORY}.recovery-${"a".repeat(64)}`);
    await fs.mkdir(targetGuard, { recursive: true });
    await fs.writeFile(path.join(targetGuard, DATA_ROOT_LOCK_OWNER_FILE), "{}", "utf8");
    await assert.rejects(
      migrateProfileData({ environ, repoRoot }),
      /target contains Notebook runtime ownership artifact.*stop every bridge/
    );
    assert.equal(await fs.readFile(path.join(legacyData, "sessions.json"), "utf8"), "[]");
  });
});

test("migrated-profile startup defers lock artifacts to the ownership layer", async () => {
  await withTemp(async root => {
    const repoRoot = path.join(root, "checkout");
    const profileHome = path.join(root, "Local", "hermes", "profiles", "research");
    const legacyData = path.join(repoRoot, "data");
    const environ = selectedEnvironment(root, profileHome);
    await fs.mkdir(legacyData, { recursive: true });
    await fs.writeFile(path.join(legacyData, "sessions.json"), "[]", "utf8");
    await migrateProfileData({ environ, repoRoot });
    const runtime = resolveNotebookRuntime({ environ, repoRoot });

    const seed = await acquireDataRootLock(runtime.dataDir, { claimSettleMs: 1 });
    const stale = { ...seed.receipt };
    const lockPath = seed.lockPath;
    await seed.release();

    const candidate = `${lockPath}.candidate-dead-process`;
    await fs.mkdir(candidate);
    await fs.writeFile(path.join(candidate, DATA_ROOT_LOCK_OWNER_FILE), "{}", "utf8");
    assert.equal(resolveNotebookRuntime({ environ, repoRoot }).dataDir, runtime.dataDir);
    await fs.rm(candidate, { recursive: true, force: true });

    const guard = `${lockPath}.recovery-${"b".repeat(64)}`;
    await fs.mkdir(guard);
    await fs.writeFile(path.join(guard, DATA_ROOT_LOCK_OWNER_FILE), "{}", "utf8");
    assert.equal(resolveNotebookRuntime({ environ, repoRoot }).dataDir, runtime.dataDir);
    await assert.rejects(
      acquireDataRootLock(runtime.dataDir, { claimSettleMs: 1 }),
      /ownership recovery is incomplete/
    );
    await fs.rm(guard, { recursive: true, force: true });

    stale.processIdentity = `${stale.processIdentity.slice(0, -1)}` +
      `${stale.processIdentity.endsWith("0") ? "1" : "0"}`;
    stale.createdAt = new Date(Date.now() - 60_000).toISOString();
    await fs.mkdir(lockPath);
    await fs.writeFile(
      path.join(lockPath, DATA_ROOT_LOCK_OWNER_FILE),
      `${JSON.stringify(stale, null, 2)}\n`,
      "utf8"
    );
    assert.equal(resolveNotebookRuntime({ environ, repoRoot }).dataDir, runtime.dataDir);
    const recovered = await acquireDataRootLock(runtime.dataDir, { claimSettleMs: 1 });
    assert.notEqual(recovered.receipt.nonce, stale.nonce);
    await recovered.release();
  });
});
