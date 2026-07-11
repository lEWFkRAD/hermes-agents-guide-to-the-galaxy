import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function listen(server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function waitFor(url) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("diary server did not start");
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
  const adapter = http.createServer((req, res) => {
    req.resume();
    res.writeHead(adapterStatus, { "content-type": "application/json" });
    res.end(adapterStatus === 200 ? JSON.stringify({ reply: "grounded reply" }) : JSON.stringify({ error: "upstream failed" }));
  });
  const adapterPort = await listen(adapter);
  const probe = http.createServer();
  const diaryPort = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-diary-http-"));
  await fs.mkdir(path.join(dataDir, "images"), { recursive: true });
  await fs.writeFile(path.join(dataDir, "images", "private.jpg"), "private-image");
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      DIARY_HOST: "127.0.0.1",
      DIARY_PORT: String(diaryPort),
      DIARY_DATA_DIR: dataDir,
      DIARY_AUTH_TOKEN: "local-secret",
      DIARY_REMOTE_KEY: "remote-secret",
      KINDLE_ADAPTER_URL: `http://127.0.0.1:${adapterPort}`
    },
    stdio: "ignore"
  });
  const base = `http://127.0.0.1:${diaryPort}`;
  const auth = { "x-diary-auth": "local-secret", "content-type": "application/json" };
  try {
    await waitFor(`${base}/api/config`);
    assert.equal((await fetch(`${base}/api/sessions`)).status, 401);
    assert.equal((await fetch(`${base}/api/sessions`, { headers: auth })).status, 200);
    assert.equal(await requestStatus(diaryPort, "/api/sessions", { host: "device.ts.net" }), 401);
    assert.equal(await requestStatus(diaryPort, "/api/sessions", { host: "device.ts.net", "x-diary-remote-key": "remote-secret" }), 200);
    assert.equal((await fetch(`${base}/img/private.jpg`)).status, 401);
    assert.equal((await fetch(`${base}/img/private.jpg`, { headers: auth })).status, 200);
    assert.equal(await requestStatus(diaryPort, "/img/private.jpg", { host: "device.ts.net" }), 401);

    const send = body => fetch(`${base}/api/send`, { method: "POST", headers: auth, body: JSON.stringify(body) });
    assert.equal((await send({ target: "hermes", text: "hello" })).status, 200);
    let sessions = await (await fetch(`${base}/api/sessions`, { headers: auth })).json();
    assert.equal(sessions.sessions.length, 1);
    adapterStatus = 500;
    assert.equal((await send({ target: "hermes", text: "fail" })).status, 502);
    sessions = await (await fetch(`${base}/api/sessions`, { headers: auth })).json();
    assert.equal(sessions.sessions.length, 1);

    const oversized = await fetch(`${base}/api/send`, { method: "POST", headers: auth, body: "x".repeat(12_000_001) });
    assert.equal(oversized.status, 413);
  } finally {
    child.kill();
    adapter.closeAllConnections();
    await new Promise(resolve => adapter.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
