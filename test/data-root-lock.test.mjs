import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireDataRootLock,
  dataRootLockPath,
  DATA_ROOT_LOCK_DIRECTORY,
  DATA_ROOT_LOCK_OWNER_FILE,
  isDataRootLockArtifactName,
  LINUX_PID_NAMESPACE_PATH,
  linuxMachineBootFingerprint,
  pidIsDefinitelyAbsent,
  readBoundedText,
  windowsProcessFingerprint,
  WINDOWS_IDENTITY_PROBE_TIMEOUT_MS
} from "../lib/data-root-lock.mjs";
import {
  NOTEBOOK_SERVICE,
  NOTEBOOK_VERSION,
  resolveAdapterRuntime,
  resolveNotebookRuntime
} from "../lib/runtime-profile.mjs";

const holderSource = String.raw`
  const { acquireDataRootLock } = await import(process.env.NOTEBOOK_LOCK_MODULE);
  try {
    const lock = await acquireDataRootLock(process.env.NOTEBOOK_DATA_ROOT, { claimSettleMs: 5 });
    process.send({ type: "ready", lockPath: lock.lockPath });
    process.on("message", async message => {
      if (message?.type !== "release") return;
      try {
        await lock.release();
        process.send({ type: "released" });
        process.exit(0);
      } catch (error) {
        process.send({ type: "release-error", message: error?.message });
        process.exit(24);
      }
    });
  } catch (error) {
    process.send({ type: "refused", name: error?.name, message: error?.message });
    process.exit(23);
  }
`;

async function withTemp(callback) {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "notebook-owner-lock-"));
  const root = await fs.realpath(created);
  try {
    await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function spawnHolder(dataRoot) {
  return spawn(process.execPath, ["--input-type=module", "--eval", holderSource], {
    env: {
      ...process.env,
      NOTEBOOK_DATA_ROOT: dataRoot,
      NOTEBOOK_LOCK_MODULE: new URL("../lib/data-root-lock.mjs", import.meta.url).href
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"]
  });
}

function nextMessage(child, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => finish(new Error(`lock child timed out: ${stderr}`)), timeoutMs);
    const onData = chunk => { stderr += chunk; };
    const onMessage = message => finish(null, message);
    const onExit = code => finish(new Error(`lock child exited ${code}: ${stderr}`));
    function finish(error, value) {
      clearTimeout(timer);
      child.stderr?.off("data", onData);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(value);
    }
    child.stderr?.on("data", onData);
    child.once("message", onMessage);
    child.once("exit", onExit);
  });
}

function waitForExit(child, timeoutMs = 60_000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("lock child did not exit")), timeoutMs);
    child.once("exit", code => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function releaseHolder(child) {
  const released = nextMessage(child);
  child.send({ type: "release" });
  assert.deepEqual(await released, { type: "released" });
  assert.equal(await waitForExit(child), 0);
}

async function seedOwnerReceipt(dataRoot) {
  const seed = await acquireDataRootLock(dataRoot, { claimSettleMs: 1 });
  const result = { lockPath: seed.lockPath, receipt: { ...seed.receipt } };
  await seed.release();
  return result;
}

async function installSyntheticOwner(lockPath, receipt) {
  await fs.mkdir(lockPath);
  await fs.writeFile(
    path.join(lockPath, DATA_ROOT_LOCK_OWNER_FILE),
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8"
  );
}

async function freePort() {
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

function spawnNotebook(repoRoot, environ) {
  return spawn(process.execPath, [path.join(repoRoot, "server.mjs")], {
    cwd: repoRoot,
    env: environ,
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
}

function waitForNotebookReady(child, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    const timer = setTimeout(() => finish(new Error(`notebook server timed out: ${errors}`)), timeoutMs);
    const onOutput = chunk => {
      output += chunk;
      if (/listening on http:\/\//.test(output)) finish();
    };
    const onError = chunk => { errors += chunk; };
    const onExit = code => finish(new Error(`notebook server exited ${code}: ${errors}`));
    function finish(error) {
      clearTimeout(timer);
      child.stdout?.off("data", onOutput);
      child.stderr?.off("data", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    }
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onError);
    child.once("exit", onExit);
  });
}

function waitForExitDetails(child, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => finish(new Error(`notebook child did not exit: ${stderr}`)), timeoutMs);
    const onError = chunk => { stderr += chunk; };
    const onExit = code => finish(null, { code, stderr });
    function finish(error, result) {
      clearTimeout(timer);
      child.stderr?.off("data", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(result);
    }
    child.stderr?.on("data", onError);
    child.once("exit", onExit);
  });
}

test("a real second process is refused and teardown permits reacquisition", async () => {
  await withTemp(async root => {
    const dataRoot = path.join(root, "data");
    const first = spawnHolder(dataRoot);
    const firstMessage = await nextMessage(first);
    assert.equal(firstMessage.type, "ready", `unexpected first lock-holder message: ${JSON.stringify(firstMessage)}`);

    const second = spawnHolder(dataRoot);
    const refusal = await nextMessage(second);
    assert.equal(refusal.type, "refused");
    assert.equal(refusal.name, "DataRootLockError");
    assert.equal(await waitForExit(second), 23);

    await releaseHolder(first);
    const replacement = spawnHolder(dataRoot);
    assert.equal((await nextMessage(replacement)).type, "ready");
    await releaseHolder(replacement);
  });
});

test("the atomic lock has one fixed storage-relative location", async () => {
  await withTemp(async root => {
    const backing = path.join(root, "shared-storage", "notebook", "data");
    const alias = path.join(root, "different-mount-prefix");
    await fs.mkdir(backing, { recursive: true });
    await fs.symlink(backing, alias, process.platform === "win32" ? "junction" : "dir");
    const directLock = await dataRootLockPath(backing);
    const aliasedLock = await dataRootLockPath(alias);
    assert.equal(path.relative(backing, directLock), DATA_ROOT_LOCK_DIRECTORY);
    assert.equal(aliasedLock, directLock);
    const moduleSource = await fs.readFile(new URL("../lib/data-root-lock.mjs", import.meta.url), "utf8");
    assert.match(moduleSource, /return path\.join\(canonical, DATA_ROOT_LOCK_DIRECTORY\)/);
    for (const name of [
      DATA_ROOT_LOCK_DIRECTORY,
      `${DATA_ROOT_LOCK_DIRECTORY}.candidate-123-abc`,
      `${DATA_ROOT_LOCK_DIRECTORY}.recovery-${"a".repeat(64)}`,
      `.hermes-notebook-stale-123e4567-e89b-42d3-a456-426614174000`,
      `.hermes-notebook-released-123e4567-e89b-42d3-a456-426614174000`
    ]) {
      assert.equal(isDataRootLockArtifactName(name), true);
      assert.equal(isDataRootLockArtifactName(name.toUpperCase()), true);
    }
    assert.equal(isDataRootLockArtifactName("ordinary-notebook-entry"), false);
  });
});

test("Linux machine ownership binds the exact bounded PID namespace source", async () => {
  assert.equal(LINUX_PID_NAMESPACE_PATH, "/proc/self/ns/pid");
  const moduleSource = await fs.readFile(new URL("../lib/data-root-lock.mjs", import.meta.url), "utf8");
  assert.match(moduleSource, /fs\.readlink\(LINUX_PID_NAMESPACE_PATH, "utf8"\)/);
  const identity = {
    machineId: "a".repeat(32),
    bootId: "12345678-1234-1234-1234-123456789abc",
    pidNamespace: "pid:[4026531836]"
  };
  const first = linuxMachineBootFingerprint(identity);
  const second = linuxMachineBootFingerprint({ ...identity, pidNamespace: "pid:[4026532999]" });
  assert.match(first, /^linux:[0-9a-f]{64}$/);
  assert.notEqual(first, second);
  for (const pidNamespace of ["", "pid:4026531836", "mnt:[4026531836]", `pid:[${"1".repeat(21)}]`]) {
    assert.throws(
      () => linuxMachineBootFingerprint({ ...identity, pidNamespace }),
      /PID namespace identity/
    );
  }
});

test("bounded identity reads accept procfs-style zero sizes but reject excess bytes", async () => {
  function virtualFile(value) {
    const content = Buffer.from(value, "utf8");
    let cursor = 0;
    return {
      async stat() {
        return { isFile: () => true, size: 0 };
      },
      async read(buffer, offset, length) {
        const bytesRead = Math.min(length, content.length - cursor);
        if (bytesRead > 0) content.copy(buffer, offset, cursor, cursor + bytesRead);
        cursor += bytesRead;
        return { bytesRead, buffer };
      },
      async close() {}
    };
  }

  assert.equal(
    await readBoundedText("virtual-boot-id", 64, async () => virtualFile("boot-id\n")),
    "boot-id"
  );
  await assert.rejects(
    readBoundedText("virtual-oversize", 4, async () => virtualFile("12345")),
    /not a bounded file/
  );
});

test("Windows process identity fails closed when executable Path is unreadable", () => {
  assert.equal(WINDOWS_IDENTITY_PROBE_TIMEOUT_MS, 15_000);
  const ticks = "639219824074844279";
  const first = windowsProcessFingerprint({ ticks, executable: "C:\\Program Files\\nodejs\\node.exe" });
  const same = windowsProcessFingerprint({ ticks, executable: "c:\\program files\\nodejs\\NODE.exe" });
  assert.equal(first, same);
  assert.match(first, /^win32:[0-9]{10,20}:[0-9a-f]{64}$/);
  for (const executable of [
    "",
    "node.exe",
    " C:\\Program Files\\nodejs\\node.exe",
    `C:\\${"x".repeat(4096)}`
  ]) {
    assert.throws(
      () => windowsProcessFingerprint({ ticks, executable }),
      /bounded absolute executable path/
    );
  }
});

test("cross-user PID visibility never masquerades as a stale process on any platform", () => {
  const errorWith = code => Object.assign(new Error(code), { code });
  assert.equal(pidIsDefinitelyAbsent(123, () => {}), false);
  assert.equal(pidIsDefinitelyAbsent(123, () => { throw errorWith("EPERM"); }), false);
  assert.equal(pidIsDefinitelyAbsent(123, () => { throw errorWith("ESRCH"); }), true);
  assert.throws(
    () => pidIsDefinitelyAbsent(123, () => { throw errorWith("EACCES"); }),
    /EACCES/
  );
});

test("a foreign machine, boot, or PID namespace receipt is never reclaimed as stale", async () => {
  await withTemp(async root => {
    const dataRoot = path.join(root, "data");
    const { lockPath, receipt } = await seedOwnerReceipt(dataRoot);
    receipt.machineBootIdentity = `${receipt.machineBootIdentity.slice(0, -1)}` +
      `${receipt.machineBootIdentity.endsWith("0") ? "1" : "0"}`;
    receipt.processIdentity = `${receipt.processIdentity.slice(0, -1)}` +
      `${receipt.processIdentity.endsWith("0") ? "1" : "0"}`;
    await installSyntheticOwner(lockPath, receipt);

    await assert.rejects(acquireDataRootLock(dataRoot, { claimSettleMs: 1 }), /already in use/);
    const retained = JSON.parse(await fs.readFile(
      path.join(lockPath, DATA_ROOT_LOCK_OWNER_FILE),
      "utf8"
    ));
    assert.equal(retained.nonce, receipt.nonce);
    assert.equal(retained.machineBootIdentity, receipt.machineBootIdentity);
  });
});

test("prior-schema and malformed machine receipts fail closed", async () => {
  await withTemp(async root => {
    const dataRoot = path.join(root, "data");
    const { lockPath, receipt } = await seedOwnerReceipt(dataRoot);
    const malformed = [
      value => { delete value.machineBootIdentity; },
      value => { value.version = 1; },
      value => { value.machineBootIdentity = "foreign-machine"; }
    ];
    for (const mutate of malformed) {
      const candidate = { ...receipt };
      mutate(candidate);
      await installSyntheticOwner(lockPath, candidate);
      await assert.rejects(
        acquireDataRootLock(dataRoot, { claimSettleMs: 1 }),
        /ownership receipt is invalid/
      );
      assert.equal((await fs.stat(lockPath)).isDirectory(), true);
      await fs.rm(lockPath, { recursive: true, force: true });
    }
  });
});

test("a receipt anchored to another canonical root or lock key fails closed", async () => {
  await withTemp(async root => {
    const dataRoot = path.join(root, "data");
    const { lockPath, receipt } = await seedOwnerReceipt(dataRoot);
    const mismatches = [
      value => { value.dataRoot = path.join(root, "different-data-root"); },
      value => { value.lockKey = "f".repeat(64); }
    ];
    for (const mutate of mismatches) {
      const candidate = { ...receipt };
      candidate.processIdentity = `${candidate.processIdentity.slice(0, -1)}` +
        `${candidate.processIdentity.endsWith("0") ? "1" : "0"}`;
      mutate(candidate);
      await installSyntheticOwner(lockPath, candidate);
      await assert.rejects(acquireDataRootLock(dataRoot, { claimSettleMs: 1 }), /already in use/);
      const retained = JSON.parse(await fs.readFile(
        path.join(lockPath, DATA_ROOT_LOCK_OWNER_FILE),
        "utf8"
      ));
      assert.equal(retained.nonce, candidate.nonce);
      await fs.rm(lockPath, { recursive: true, force: true });
    }
  });
});

test("a delayed stale reclaimer cannot move a newer live claim", async () => {
  await withTemp(async root => {
    const dataRoot = path.join(root, "data");
    const { lockPath, receipt } = await seedOwnerReceipt(dataRoot);
    const stale = { ...receipt };

    stale.processIdentity = `${stale.processIdentity.slice(0, -1)}${stale.processIdentity.endsWith("0") ? "1" : "0"}`;
    stale.createdAt = new Date(Date.now() - 60_000).toISOString();
    await installSyntheticOwner(lockPath, stale);

    let reportObserved;
    let resumeDelayed;
    const observed = new Promise(resolve => { reportObserved = resolve; });
    const resume = new Promise(resolve => { resumeDelayed = resolve; });
    const delayed = acquireDataRootLock(dataRoot, {
      claimSettleMs: 1,
      afterStaleObserved: async receipt => {
        reportObserved(receipt);
        await resume;
      }
    });
    assert.equal((await observed).nonce, stale.nonce);

    const firstReclaimer = await acquireDataRootLock(dataRoot, { claimSettleMs: 1 });
    await firstReclaimer.release();
    const live = await acquireDataRootLock(dataRoot, { claimSettleMs: 1 });
    resumeDelayed();
    await assert.rejects(delayed, /already in use|changed|contended/);

    const stillOwned = JSON.parse(await fs.readFile(
      path.join(lockPath, DATA_ROOT_LOCK_OWNER_FILE),
      "utf8"
    ));
    assert.equal(stillOwned.nonce, live.receipt.nonce);
    await assert.rejects(acquireDataRootLock(dataRoot, { claimSettleMs: 1 }), /already in use/);
    await live.release();
  });
});

test("an orphaned or malformed recovery guard fails closed", async () => {
  await withTemp(async root => {
    const dataRoot = path.join(root, "data");
    const seed = await acquireDataRootLock(dataRoot, { claimSettleMs: 1 });
    const lockPath = seed.lockPath;
    await seed.release();
    const guard = `${lockPath}.recovery-${"a".repeat(64)}`;
    await fs.mkdir(guard);
    await fs.writeFile(path.join(guard, DATA_ROOT_LOCK_OWNER_FILE), "{}\n", "utf8");

    await assert.rejects(
      acquireDataRootLock(dataRoot, { claimSettleMs: 1 }),
      /recovery is incomplete/
    );
    assert.equal((await fs.stat(guard)).isDirectory(), true);
  });
});

test("shutdown retains ownership while a cancellation-resistant request is active", { timeout: 40_000 }, async () => {
  await withTemp(async root => {
    let adapterIdentity;
    let reportIngest;
    const ingestStarted = new Promise(resolve => { reportIngest = resolve; });
    const heldResponses = new Set();
    const adapter = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(adapterIdentity));
        return;
      }
      req.resume();
      req.on("end", () => {
        heldResponses.add(res);
        reportIngest();
      });
    });
    await new Promise(resolve => adapter.listen(0, "127.0.0.1", resolve));
    const adapterPort = adapter.address().port;
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const dataRoot = path.join(root, "data");
    const backupRoot = path.join(root, "backups");
    const baseEnvironment = {
      ...process.env,
      NODE_ENV: "test",
      HERMES_HOME: "",
      HERMES_PROFILE_NAME: "",
      HERMES_CONFIG: "",
      LOCALAPPDATA: path.join(root, "Local"),
      DIARY_HOST: "127.0.0.1",
      DIARY_DATA_DIR: dataRoot,
      DIARY_BACKUP_DIR: backupRoot,
      DIARY_DEV_ALLOW_PROFILE_PATH_OVERRIDE: "",
      DIARY_AUTH_TOKEN: "local-secret",
      DIARY_REMOTE_KEY: "remote-secret",
      KINDLE_ADAPTER_URL: `http://127.0.0.1:${adapterPort}`,
      KINDLE_INGEST_HOST: "127.0.0.1",
      KINDLE_INGEST_PORT: String(adapterPort),
      KINDLE_INGEST_TOKEN: "test-kindle-ingest-token",
      KINDLE_INSECURE: "false",
      KINDLE_USER: "kindle",
      KINDLE_REPLY_TIMEOUT: "10",
      DIARY_ADAPTER_TIMEOUT_MS: "15000"
    };
    const runtime = resolveNotebookRuntime({ environ: baseEnvironment, repoRoot });
    const adapterRuntime = resolveAdapterRuntime(runtime, baseEnvironment);
    adapterIdentity = {
      status: "ok",
      service: NOTEBOOK_SERVICE,
      version: NOTEBOOK_VERSION,
      profile: runtime.profileName,
      owner_fingerprint: adapterRuntime.ownerFingerprint,
      host: adapterRuntime.host,
      port: adapterRuntime.port,
      pending: 0
    };

    const children = [];
    try {
      const firstPort = await freePort();
      const first = spawnNotebook(repoRoot, { ...baseEnvironment, DIARY_PORT: String(firstPort) });
      children.push(first);
      await waitForNotebookReady(first);
      const sendRequest = fetch(`http://127.0.0.1:${firstPort}/api/send`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-diary-auth": "local-secret" },
        body: JSON.stringify({ target: "hermes", text: "hold this request" })
      }).catch(() => null);
      await ingestStarted;

      const shutdownStartedAt = Date.now();
      const firstExit = waitForExitDetails(first);
      first.send({ type: "notebook-test-shutdown" });

      const refusedPort = await freePort();
      const refused = spawnNotebook(repoRoot, { ...baseEnvironment, DIARY_PORT: String(refusedPort) });
      children.push(refused);
      const refusal = await waitForExitDetails(refused);
      assert.notEqual(refusal.code, 0);
      assert.match(refusal.stderr, /already in use by another bridge/);

      const stopped = await firstExit;
      assert.equal(stopped.code, 1);
      assert.ok(Date.now() - shutdownStartedAt >= 1800);
      assert.ok(Date.now() - shutdownStartedAt < 10_000);
      await sendRequest;

      const replacementPort = await freePort();
      const replacement = spawnNotebook(repoRoot, {
        ...baseEnvironment,
        DIARY_PORT: String(replacementPort)
      });
      children.push(replacement);
      await waitForNotebookReady(replacement);
      const replacementExit = waitForExitDetails(replacement);
      replacement.send({ type: "notebook-test-shutdown" });
      assert.equal((await replacementExit).code, 0);
    } finally {
      for (const child of children) {
        if (child.exitCode === null) child.kill();
      }
      for (const response of heldResponses) response.destroy();
      adapter.closeAllConnections?.();
      await new Promise(resolve => adapter.close(resolve));
    }
  });
});
