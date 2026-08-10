import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  NOTEBOOK_SERVICE,
  NOTEBOOK_VERSION,
  resolveAdapterRuntime,
  resolveNotebookRuntime
} from "../lib/runtime-profile.mjs";
import { dataRootLockPath } from "../lib/data-root-lock.mjs";

async function listen(server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function waitFor(url, diagnostics = () => "") {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const detail = String(diagnostics() || "").slice(-4096);
  throw new Error(`diary server did not start${detail ? `: ${detail}` : ""}`);
}

function requestStatus(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: pathname, headers }, res => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

test("HTTP boundaries protect data and avoid phantom sessions", async () => {
  let adapterStatus = 200;
  let adapterMode = "json";
  let adapterCalls = 0;
  let adapterBody = "";
  let adapterIdentity;
  let rotateOwnerAfterHealth = false;
  let presentedOwner = "";
  const adapter = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      assert.equal(req.headers["x-kindle-token"], "test-kindle-ingest-token");
      const attestedIdentity = adapterIdentity;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(attestedIdentity));
      if (rotateOwnerAfterHealth) {
        rotateOwnerAfterHealth = false;
        adapterIdentity = {
          ...attestedIdentity,
          profile: "wrong-profile",
          owner_fingerprint: "f".repeat(64)
        };
      }
      return;
    }
    presentedOwner = String(req.headers["x-kindle-owner"] || "");
    if (presentedOwner !== adapterIdentity.owner_fingerprint) {
      req.resume();
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "request rejected" }));
      return;
    }
    adapterCalls += 1;
    adapterBody = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { adapterBody += chunk; });
    req.on("end", () => {
      if (adapterMode === "non-json") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("sensitive-token C:\\private-profile\\config.yaml");
        return;
      }
      if (adapterMode === "oversized") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(`{"reply":"${"x".repeat(70_000)}"}`);
        return;
      }
      res.writeHead(adapterStatus, { "content-type": "application/json" });
      res.end(adapterStatus === 200 ? JSON.stringify({ reply: "grounded reply" }) : JSON.stringify({ error: "upstream failed" }));
    });
  });
  const adapterPort = await listen(adapter);
  const probe = http.createServer();
  const diaryPort = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  const createdDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-diary-http-"));
  const dataDir = await fs.realpath(createdDataDir);
  await fs.mkdir(path.join(dataDir, "images"), { recursive: true });
  await fs.writeFile(path.join(dataDir, "images", "private.jpg"), "private-image");
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const childEnv = {
    ...process.env,
    HERMES_HOME: "",
    HERMES_PROFILE_NAME: "",
    HERMES_CONFIG: "",
    LOCALAPPDATA: path.join(dataDir, "local-app-data"),
    DIARY_HOST: "127.0.0.1",
    DIARY_PORT: String(diaryPort),
    DIARY_DATA_DIR: dataDir,
    DIARY_BACKUP_DIR: "",
    DIARY_DEV_ALLOW_PROFILE_PATH_OVERRIDE: "",
    DIARY_AUTH_TOKEN: "local-secret",
    DIARY_REMOTE_KEY: "remote-secret",
    KINDLE_ADAPTER_URL: `http://127.0.0.1:${adapterPort}`,
    KINDLE_INGEST_HOST: "127.0.0.1",
    KINDLE_INGEST_PORT: String(adapterPort),
    KINDLE_INGEST_TOKEN: "test-kindle-ingest-token",
    KINDLE_INSECURE: "false",
    KINDLE_USER: "kindle",
    KINDLE_REPLY_TIMEOUT: "240"
  };
  const profileRuntime = resolveNotebookRuntime({ environ: childEnv, repoRoot });
  const adapterRuntime = resolveAdapterRuntime(profileRuntime, childEnv);
  adapterIdentity = {
    status: "ok",
    service: NOTEBOOK_SERVICE,
    version: NOTEBOOK_VERSION,
    profile: profileRuntime.profileName,
    owner_fingerprint: adapterRuntime.ownerFingerprint,
    host: adapterRuntime.host,
    port: adapterRuntime.port,
    pending: 0
  };
  let childErrors = "";
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: repoRoot,
    env: childEnv,
    stdio: ["ignore", "ignore", "pipe"]
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => {
    childErrors = `${childErrors}${chunk}`.slice(-4096);
  });
  const base = `http://127.0.0.1:${diaryPort}`;
  const auth = { "x-diary-auth": "local-secret", "content-type": "application/json" };
  try {
    await waitFor(base, () => childErrors);
    assert.equal((await fetch(`${base}/api/config`)).status, 401);
    assert.equal((await fetch(`${base}/api/config`, { headers: auth })).status, 200);
    assert.equal((await fetch(`${base}/api/sessions`)).status, 401);
    assert.equal((await fetch(`${base}/api/sessions`, { headers: auth })).status, 200);
    assert.equal(await requestStatus(diaryPort, "/api/sessions", { host: "device.ts.net" }), 401);
    assert.equal(await requestStatus(diaryPort, "/api/sessions", { host: "device.ts.net." }), 401);
    assert.equal(await requestStatus(diaryPort, "/api/sessions", {
      host: "forged.invalid",
      "x-forwarded-host": "device.ts.net",
      "x-forwarded-for": "127.0.0.1"
    }), 401);
    assert.equal(await requestStatus(diaryPort, "/api/sessions", {
      host: "forged.invalid",
      "x-diary-remote-key": "remote-secret"
    }), 200);
    assert.equal(await requestStatus(diaryPort, "/api/config", {
      host: "localhost",
      "x-diary-remote-key": "remote-secret"
    }), 200);
    assert.equal(await requestStatus(diaryPort, "/remote/wrong/live", {
      host: "device.ts.net"
    }), 401);
    assert.equal(await requestStatus(diaryPort, "/remote/remote-secret/live", {
      host: "arbitrary.example."
    }), 200);
    assert.equal((await fetch(`${base}/img/private.jpg`)).status, 401);
    assert.equal((await fetch(`${base}/img/private.jpg`, { headers: auth })).status, 200);
    assert.equal(await requestStatus(diaryPort, "/img/private.jpg", { host: "device.ts.net" }), 401);
    assert.equal(await requestStatus(diaryPort, "/img/private.jpg", {
      host: "localhost",
      "x-diary-remote-key": "remote-secret"
    }), 200);

    const send = body => fetch(`${base}/api/send`, { method: "POST", headers: auth, body: JSON.stringify(body) });
    const firstSend = await send({ target: "hermes", text: "hello" });
    assert.equal(firstSend.status, 200);
    const firstReply = await firstSend.json();
    const sentBody = JSON.parse(adapterBody);
    assert.equal(presentedOwner, adapterRuntime.ownerFingerprint);
    assert.equal(sentBody.text.match(/\[Kindle Scribe environment\]/g)?.length, 1);
    const alreadyScoped = [
      "[Kindle Scribe environment]",
      "Existing bounded Kindle context.",
      "[/Kindle Scribe environment]",
      "",
      "hello again"
    ].join("\n");
    assert.equal((await send({
      target: "hermes",
      sessionId: firstReply.sessionId,
      text: alreadyScoped
    })).status, 200);
    assert.equal(JSON.parse(adapterBody).text.match(/\[Kindle Scribe environment\]/g)?.length, 1);
    let sessions = await (await fetch(`${base}/api/sessions`, { headers: auth })).json();
    assert.equal(sessions.sessions.length, 1);

    const verifiedIdentity = adapterIdentity;
    const callsBeforeMismatch = adapterCalls;
    adapterIdentity = {
      ...verifiedIdentity,
      owner_fingerprint: "0".repeat(64),
      debug: "sensitive-token C:\\private-profile\\config.yaml"
    };
    const mismatch = await send({ target: "hermes", text: "must not cross profiles" });
    assert.equal(mismatch.status, 502);
    assert.equal(adapterCalls, callsBeforeMismatch);
    assert.doesNotMatch(await mismatch.text(), /sensitive-token|private-profile|config\.yaml|000000000000/);
    adapterIdentity = verifiedIdentity;

    const callsBeforeRace = adapterCalls;
    rotateOwnerAfterHealth = true;
    const swappedListener = await send({
      target: "hermes",
      text: "must not reach the swapped profile"
    });
    assert.equal(swappedListener.status, 502);
    assert.equal(presentedOwner, verifiedIdentity.owner_fingerprint);
    assert.equal(adapterCalls, callsBeforeRace);
    assert.doesNotMatch(await swappedListener.text(), /wrong-profile|ffffffffff/);
    adapterIdentity = verifiedIdentity;

    adapterStatus = 500;
    assert.equal((await send({ target: "hermes", text: "fail" })).status, 502);
    adapterStatus = 200;
    adapterMode = "non-json";
    const nonJson = await send({ target: "hermes", text: "hostile non-json" });
    assert.equal(nonJson.status, 502);
    assert.doesNotMatch(await nonJson.text(), /sensitive-token|private-profile|config\.yaml/);
    adapterMode = "oversized";
    const oversizedAdapter = await send({ target: "hermes", text: "hostile oversized" });
    assert.equal(oversizedAdapter.status, 502);
    assert.doesNotMatch(await oversizedAdapter.text(), /x{100}/);
    adapterMode = "json";
    sessions = await (await fetch(`${base}/api/sessions`, { headers: auth })).json();
    assert.equal(sessions.sessions.length, 1);

    const oversized = await fetch(`${base}/api/send`, { method: "POST", headers: auth, body: "x".repeat(12_000_001) });
    assert.equal(oversized.status, 413);
  } finally {
    child.kill();
    await new Promise(resolve => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", resolve);
    });
    adapter.closeAllConnections();
    await new Promise(resolve => adapter.close(resolve));
    await fs.rm(await dataRootLockPath(dataDir), { recursive: true, force: true });
    await fs.rm(createdDataDir, { recursive: true, force: true });
  }
});
