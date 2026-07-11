import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizeLivingPage } from "../lib/live-page.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function preparedPage(input, updatedAt = new Date().toISOString()) {
  const content = normalizeLivingPage(input);
  const revision = `sha256:${crypto.createHash("sha256").update(JSON.stringify(content)).digest("hex")}`;
  return { ...content, revision, updatedAt };
}

function request(port, pathname, { method = "GET", headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: pathname, method, headers }, res => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { responseBody += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: responseBody }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function startServer(options = {}) {
  const dataDir = options.dataDir || await fs.mkdtemp(path.join(os.tmpdir(), "hermes-live-api-"));
  const child = spawn(process.execPath, [path.join(repoRoot, "server.mjs")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DIARY_DATA_DIR: dataDir,
      DIARY_HOST: "127.0.0.1",
      DIARY_PORT: "0",
      DIARY_AUTH_TOKEN: "local-secret",
      DIARY_REMOTE_KEY: "remote-secret",
      ...(options.kindleAdapterUrl ? { KINDLE_ADAPTER_URL: options.kindleAdapterUrl } : {})
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { errors += chunk; });

  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server startup timed out\n${output}\n${errors}`)), 10000);
    child.stdout.on("data", () => {
      const match = output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(Number(match[1]));
    });
    child.once("exit", code => {
      clearTimeout(timeout);
      reject(new Error(`Server exited with ${code}\n${output}\n${errors}`));
    });
  });

  const liveToken = (await fs.readFile(path.join(dataDir, "live-page-write.token"), "utf8")).trim();
  return {
    port,
    liveToken,
    dataDir,
    async close({ cleanup = true } = {}) {
      child.kill();
      await new Promise(resolve => {
        const timeout = setTimeout(resolve, 3000);
        child.once("exit", () => { clearTimeout(timeout); resolve(); });
      });
      if (cleanup) await fs.rm(dataDir, { recursive: true, force: true });
    }
  };
}

test("Living HTML API enforces boundaries and serves only sanitized sandbox content", async () => {
  const server = await startServer();
  try {
    assert.equal((await request(server.port, "/api/live-page")).status, 401);

    const initial = await request(server.port, "/api/live-page", {
      headers: { "x-diary-auth": "local-secret" }
    });
    assert.equal(initial.status, 200);
    const initialJson = JSON.parse(initial.body);
    assert.equal(Object.hasOwn(initialJson.page, "html"), false);
    assert.match(initialJson.page.revision, /^sha256:[a-f0-9]{64}$/);

    const html = "<!doctype html><html><head><title>Evolving idea</title></head><body><h1 onclick=\"bad()\">Version two</h1><script>bad()</script></body></html>";
    const payload = JSON.stringify({ html });
    const missingPublishToken = await request(server.port, "/api/live-page", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-diary-auth": "local-secret" },
      body: payload
    });
    assert.equal(missingPublishToken.status, 403);

    const published = await request(server.port, "/api/live-page", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-diary-live-write": server.liveToken },
      body: payload
    });
    assert.equal(published.status, 200);
    const publishedPage = JSON.parse(published.body).page;
    assert.equal(publishedPage.title, "Evolving idea");
    assert.equal(Object.hasOwn(publishedPage, "html"), false);

    const content = await request(server.port, "/api/live-page/content", {
      headers: { "x-diary-auth": "local-secret" }
    });
    assert.equal(content.status, 200);
    assert.match(content.headers["content-security-policy"], /script-src 'none'/);
    assert.match(content.body, /Version two/);
    assert.doesNotMatch(content.body, /onclick|<script/i);

    const unchanged = await request(server.port, "/api/live-page", {
      headers: { "x-diary-auth": "local-secret", "if-none-match": `"${publishedPage.revision}"` }
    });
    assert.equal(unchanged.status, 304);

    const remoteShell = await request(server.port, "/remote/remote-secret/live", {
      headers: { host: "test-node.ts.net" }
    });
    assert.equal(remoteShell.status, 200);
    assert.match(remoteShell.body, /sandbox="allow-same-origin"/);

    const remoteContent = await request(server.port, "/api/live-page/content?rk=remote-secret", {
      headers: { host: "test-node.ts.net" }
    });
    assert.equal(remoteContent.status, 200);
    assert.match(remoteContent.body, /Version two/);

    const localAuthCannotBypassRemote = await request(server.port, "/api/live-page/content", {
      headers: { host: "test-node.ts.net", "x-diary-auth": "local-secret" }
    });
    assert.equal(localAuthCannotBypassRemote.status, 401);

    const missingTemplateConfirmation = await request(server.port, "/api/live-page/template", {
      method: "POST",
      headers: { "content-type": "application/json", "x-diary-auth": "local-secret" },
      body: JSON.stringify({ template: "brainstorm", baseRevision: publishedPage.revision })
    });
    assert.equal(missingTemplateConfirmation.status, 400);

    const templatePayload = JSON.stringify({ template: "brainstorm", baseRevision: publishedPage.revision, confirm: "replace" });
    const selectedTemplate = await request(server.port, "/api/live-page/template", {
      method: "POST",
      headers: { "content-type": "application/json", "x-diary-auth": "local-secret" },
      body: templatePayload
    });
    assert.equal(selectedTemplate.status, 201);
    const selectedTemplatePage = JSON.parse(selectedTemplate.body).page;
    assert.equal(selectedTemplatePage.title, "Brainstorm");

    const darkTemplate = await request(server.port, "/api/live-page/content?theme=dark", {
      headers: { "x-diary-auth": "local-secret" }
    });
    assert.equal(darkTemplate.status, 200);
    assert.match(darkTemplate.body, /data-live-region="brainstorm"/);
    assert.match(darkTemplate.body, /--live-paper:#15140f!important/);

    const unknownTemplate = await request(server.port, "/api/live-page/template", {
      method: "POST",
      headers: { "content-type": "application/json", "x-diary-auth": "local-secret" },
      body: JSON.stringify({ template: "accounting-dashboard", baseRevision: selectedTemplatePage.revision, confirm: "replace" })
    });
    assert.equal(unknownTemplate.status, 400);

    const remoteTemplate = await request(server.port, "/api/live-page/template", {
      method: "POST",
      headers: {
        host: "test-node.ts.net",
        "content-type": "application/json",
        "x-diary-remote-key": "remote-secret"
      },
      body: JSON.stringify({ template: "grid", baseRevision: selectedTemplatePage.revision, confirm: "replace" })
    });
    assert.equal(remoteTemplate.status, 201);

    const remoteCannotPublish = await request(server.port, "/api/live-page", {
      method: "PUT",
      headers: {
        host: "test-node.ts.net",
        "content-type": "application/json",
        "x-diary-remote-key": "remote-secret",
        "x-diary-live-write": server.liveToken
      },
      body: payload
    });
    assert.equal(remoteCannotPublish.status, 403);
  } finally {
    await server.close();
  }
});

test("shared ink API merges devices, archives ink, and clears it on changed HTML", async () => {
  const server = await startServer();
  try {
    assert.equal((await request(server.port, "/api/live-page/ink")).status, 401);

    const initialPageResponse = await request(server.port, "/api/live-page", {
      headers: { "x-diary-auth": "local-secret" }
    });
    const pageRevision = JSON.parse(initialPageResponse.body).page.revision;
    const initialInk = await request(server.port, "/api/live-page/ink", {
      headers: { "x-diary-auth": "local-secret" }
    });
    assert.equal(initialInk.status, 200);
    assert.match(JSON.parse(initialInk.body).ink.revision, /^ink:\d+$/);
    assert.equal(JSON.parse(initialInk.body).ink.activeRevision, pageRevision);
    assert.deepEqual(JSON.parse(initialInk.body).ink.strokes, []);

    const unchanged = await request(server.port, "/api/live-page/ink", {
      headers: {
        "x-diary-auth": "local-secret",
        "if-none-match": initialInk.headers.etag
      }
    });
    assert.equal(unchanged.status, 304);

    const hostileOrigin = await request(server.port, "/api/live-page/ink", {
      headers: {
        "x-diary-auth": "local-secret",
        origin: "https://evil.example"
      }
    });
    assert.equal(hostileOrigin.status, 403);

    const stroke = (id, clientId, x) => ({
      id,
      clientId,
      baseRevision: pageRevision,
      createdAt: 1000,
      surfaceWidth: 600,
      surfaceHeight: 720,
      sent: false,
      points: [{ x, y: 0.2 }, { x: x + 0.05, y: 0.3 }]
    });
    const postOps = (clientId, ops, headers = { "x-diary-auth": "local-secret" }) => request(server.port, "/api/live-page/ink", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ clientId, ops })
    });

    const [deviceA, deviceB] = await Promise.all([
      postOps("device-a", [{ id: "op-add-a", type: "add", stroke: stroke("stroke-a", "device-a", 0.1) }]),
      postOps("device-b", [{ id: "op-add-b", type: "add", stroke: stroke("stroke-b", "device-b", 0.4) }])
    ]);
    assert.equal(deviceA.status, 200);
    assert.equal(deviceB.status, 200);

    const remoteRead = await request(server.port, "/api/live-page/ink", {
      headers: {
        host: "test-node.ts.net",
        "x-diary-remote-key": "remote-secret"
      }
    });
    assert.equal(remoteRead.status, 200);
    assert.deepEqual(JSON.parse(remoteRead.body).ink.strokes.map(item => item.id).sort(), ["stroke-a", "stroke-b"]);

    const deleted = await postOps("device-a", [{ id: "op-delete-a", type: "delete", ids: ["stroke-a"] }]);
    assert.equal(deleted.status, 200);
    assert.deepEqual(JSON.parse(deleted.body).ink.strokes.map(item => item.id), ["stroke-b"]);

    const marked = await postOps("device-b", [{ id: "op-sent-b", type: "mark-sent", ids: ["stroke-b"] }]);
    assert.equal(marked.status, 200);
    assert.equal(JSON.parse(marked.body).ink.strokes[0].sent, true);

    const published = await request(server.port, "/api/live-page", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-diary-live-write": server.liveToken
      },
      body: JSON.stringify({ html: "<!doctype html><html><head><title>New HTML</title></head><body><h1>Changed beneath the ink</h1></body></html>" })
    });
    assert.equal(published.status, 200);
    const publishedPage = JSON.parse(published.body).page;
    const afterPublish = await request(server.port, "/api/live-page/ink", {
      headers: { "x-diary-auth": "local-secret" }
    });
    assert.equal(JSON.parse(afterPublish.body).ink.activeRevision, publishedPage.revision);
    assert.deepEqual(JSON.parse(afterPublish.body).ink.strokes, []);

    const journey = await request(server.port, "/api/live-page/journey", {
      headers: { "x-diary-auth": "local-secret" }
    });
    assert.equal(journey.status, 200);
    const frames = JSON.parse(journey.body).frames;
    const originalFrame = frames.find(frame => frame.page.revision === pageRevision);
    assert.deepEqual(originalFrame.strokes.map(item => item.id).sort(), ["stroke-a", "stroke-b"]);
    const archivedContent = await request(server.port, `/api/live-page/journey/content?revision=${encodeURIComponent(pageRevision)}&theme=dark`, {
      headers: { "x-diary-auth": "local-secret" }
    });
    assert.equal(archivedContent.status, 200);
    assert.match(archivedContent.body, /--live-paper:#15140f!important/);

    const staleStroke = stroke("stroke-stale", "device-a", 0.2);
    const stale = await postOps("device-a", [{ id: "op-stale", type: "add", stroke: staleStroke }]);
    assert.equal(stale.status, 200);
    assert.deepEqual(JSON.parse(stale.body).ink.strokes, []);

    const invalidStroke = stroke("stroke-bad", "device-a", 0.1);
    invalidStroke.points[0].x = 2;
    const beforeInvalid = JSON.parse(stale.body).ink;
    const invalid = await postOps("device-a", [{ id: "op-invalid", type: "add", stroke: invalidStroke }]);
    assert.equal(invalid.status, 400);
    const afterInvalid = await request(server.port, "/api/live-page/ink", {
      headers: { "x-diary-auth": "local-secret" }
    });
    assert.deepEqual(JSON.parse(afterInvalid.body).ink, beforeInvalid);

    const remoteUnauthorized = await request(server.port, "/api/live-page/ink", {
      headers: { host: "test-node.ts.net" }
    });
    assert.equal(remoteUnauthorized.status, 401);
  } finally {
    await server.close();
  }
});

test("live annotation send is claimed once and retries return the cached reply", async () => {
  let adapterCalls = 0;
  let adapterBody = "";
  const adapter = http.createServer((req, res) => {
    adapterCalls += 1;
    req.setEncoding("utf8");
    req.on("data", chunk => { adapterBody += chunk; });
    req.on("end", () => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ reply: "Changed the HTML once." }));
      }, 60);
    });
  });
  await new Promise((resolve, reject) => {
    adapter.once("error", reject);
    adapter.listen(0, "127.0.0.1", resolve);
  });
  const adapterPort = adapter.address().port;
  const server = await startServer({ kindleAdapterUrl: `http://127.0.0.1:${adapterPort}/ingest` });
  try {
    const pageResponse = await request(server.port, "/api/live-page", {
      headers: { "x-diary-auth": "local-secret" }
    });
    const pageRevision = JSON.parse(pageResponse.body).page.revision;
    const stroke = {
      id: "stroke-send-once",
      clientId: "device-a",
      baseRevision: pageRevision,
      createdAt: 1000,
      surfaceWidth: 600,
      surfaceHeight: 720,
      sent: false,
      anchors: [{
        selector: '[data-live-region="client-total"]',
        tag: "section",
        text: "Top client total",
        rect: { x: 0.1, y: 0.2, width: 0.5, height: 0.2 },
        hitCount: 5,
        centered: true
      }],
      points: [{ x: 0.1, y: 0.2 }, { x: 0.2, y: 0.3 }]
    };
    const added = await request(server.port, "/api/live-page/ink", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-diary-auth": "local-secret"
      },
      body: JSON.stringify({
        clientId: "device-a",
        ops: [{ id: "op-add-send-once", type: "add", stroke }]
      })
    });
    assert.equal(added.status, 200);

    const sendPayload = sendId => JSON.stringify({
      target: "hermes",
      text: "#client Use this annotation.",
      intent: "redline",
      source: "live-page",
      livePageRevision: pageRevision,
      liveInkSendId: sendId,
      liveInkStrokeIds: ["stroke-send-once"],
      hermesThreadId: "thread-send-once"
    });
    const sendRequest = sendId => request(server.port, "/api/send", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-diary-auth": "local-secret"
      },
      body: sendPayload(sendId)
    });

    const concurrent = await Promise.all([sendRequest("send-first"), sendRequest("send-second")]);
    assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 409]);
    const completed = concurrent.find(response => response.status === 200);
    const completedJson = JSON.parse(completed.body);
    assert.equal(completedJson.text, "Changed the HTML once.");
    assert.equal(completedJson.intent, "redline");
    assert.deepEqual(completedJson.tags, ["client"]);
    assert.equal(adapterCalls, 1);
    const sentToAdapter = JSON.parse(adapterBody);
    assert.match(sentToAdapter.text, /\[Kindle Scribe environment\]/);
    assert.match(sentToAdapter.text, /Kindle is only the user's input and display surface/);
    assert.match(sentToAdapter.text, /Do real work normally when asked/);
    assert.match(sentToAdapter.text, /no tool or workflow is required/);
    assert.match(sentToAdapter.text, /Intent: redline/);
    assert.match(sentToAdapter.text, /exactly one concise, non-destructive proposed replacement/);
    assert.match(sentToAdapter.text, /one concise rationale instead/);
    assert.match(sentToAdapter.text, /Anchor the suggestion in the marked DOM target and page text/);
    assert.match(sentToAdapter.text, /Do not apply, publish, edit, or otherwise modify the page/);
    assert.match(sentToAdapter.text, /Notebook tags: #client/);
    assert.match(sentToAdapter.text, /DOM annotation targets/);
    assert.match(sentToAdapter.text, /\[Current Live Page\]/);
    assert.match(sentToAdapter.text, /The annotation was made directly over this page/);
    assert.match(sentToAdapter.text, /do not ask the user to provide the HTML/);
    assert.match(sentToAdapter.text, /\[data-live-region=\\"client-total\\"\]/);
    assert.match(sentToAdapter.text, /Top client total/);
    assert.match(sentToAdapter.text, /mark encloses\/centers on element/);
    assert.doesNotMatch(sentToAdapter.text, /bearden-clients|live_page_|Fallback source|live-page-source\.html/);

    const retry = await sendRequest("send-retry-after-complete");
    assert.equal(retry.status, 200);
    assert.equal(JSON.parse(retry.body).text, "Changed the HTML once.");
    assert.equal(adapterCalls, 1);

    const ink = await request(server.port, "/api/live-page/ink", {
      headers: { "x-diary-auth": "local-secret" }
    });
    assert.equal(JSON.parse(ink.body).ink.strokes[0].sent, true);
  } finally {
    await server.close();
    await new Promise(resolve => adapter.close(resolve));
  }
});

test("a failed Journey preflight cannot expose new HTML with old ink", async () => {
  const server = await startServer();
  try {
    const auth = { "x-diary-auth": "local-secret" };
    const initial = JSON.parse((await request(server.port, "/api/live-page", { headers: auth })).body).page;
    const stroke = {
      id: "stroke-atomic-preflight",
      clientId: "device-atomic-preflight",
      baseRevision: initial.revision,
      createdAt: 3000,
      surfaceWidth: 600,
      surfaceHeight: 800,
      sent: false,
      points: [{ x: 0.2, y: 0.3, t: 0 }, { x: 0.3, y: 0.4, t: 30 }]
    };
    const added = await request(server.port, "/api/live-page/ink", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        clientId: stroke.clientId,
        ops: [{ id: "op-add-atomic-preflight", type: "add", stroke }]
      })
    });
    assert.equal(added.status, 200);

    const nextInput = {
      html: "<!doctype html><html><head><title>Must not leak</title></head><body><h1>Destination B</h1></body></html>"
    };
    const next = preparedPage(nextInput);
    const blocker = path.join(server.dataDir, "live-page-history", next.revision.slice("sha256:".length) + ".html");
    await fs.mkdir(blocker, { recursive: true });

    const failed = await request(server.port, "/api/live-page", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-diary-live-write": server.liveToken },
      body: JSON.stringify(nextInput)
    });
    assert.equal(failed.status, 503);

    const pageAfter = JSON.parse((await request(server.port, "/api/live-page", { headers: auth })).body).page;
    const inkAfter = JSON.parse((await request(server.port, "/api/live-page/ink", { headers: auth })).body).ink;
    assert.equal(pageAfter.revision, initial.revision);
    assert.equal(inkAfter.activeRevision, initial.revision);
    assert.deepEqual(inkAfter.strokes.map(item => item.id), [stroke.id]);
    await assert.rejects(fs.stat(path.join(server.dataDir, "live-page-transition.json")), error => error && error.code === "ENOENT");
  } finally {
    await server.close();
  }
});

test("startup rolls an interrupted Live Page transition forward exactly once", async () => {
  let server = await startServer();
  const dataDir = server.dataDir;
  try {
    const auth = { "x-diary-auth": "local-secret" };
    const initial = JSON.parse((await request(server.port, "/api/live-page", { headers: auth })).body).page;
    const stroke = {
      id: "stroke-transition-recovery",
      clientId: "device-transition-recovery",
      baseRevision: initial.revision,
      createdAt: 4000,
      surfaceWidth: 600,
      surfaceHeight: 800,
      sent: false,
      points: [{ x: 0.4, y: 0.5, t: 0 }, { x: 0.5, y: 0.6, t: 30 }]
    };
    assert.equal((await request(server.port, "/api/live-page/ink", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        clientId: stroke.clientId,
        ops: [{ id: "op-add-transition-recovery", type: "add", stroke }]
      })
    })).status, 200);

    const next = preparedPage({
      html: "<!doctype html><html><head><title>Recovered B</title></head><body><h1>Recovered destination</h1></body></html>"
    });
    await server.close({ cleanup: false });
    server = null;
    await fs.writeFile(path.join(dataDir, "live-page-transition.json"), JSON.stringify({
      version: 1,
      fromRevision: initial.revision,
      toPage: next,
      createdAt: new Date().toISOString()
    }, null, 2), "utf8");

    server = await startServer({ dataDir });
    const pageAfter = JSON.parse((await request(server.port, "/api/live-page", { headers: auth })).body).page;
    const inkAfter = JSON.parse((await request(server.port, "/api/live-page/ink", { headers: auth })).body).ink;
    const journeyAfter = JSON.parse((await request(server.port, "/api/live-page/journey", { headers: auth })).body);
    assert.equal(pageAfter.revision, next.revision);
    assert.equal(inkAfter.activeRevision, next.revision);
    assert.deepEqual(inkAfter.strokes, []);
    assert.deepEqual(
      journeyAfter.frames.find(frame => frame.page.revision === initial.revision).strokes.map(item => item.id),
      [stroke.id]
    );
    assert.equal(journeyAfter.frames.filter(frame => frame.page.revision === next.revision).length, 1);
    await assert.rejects(fs.stat(path.join(dataDir, "live-page-transition.json")), error => error && error.code === "ENOENT");
  } finally {
    if (server) await server.close();
    else await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("Journey survives identical publishes, in-flight rollover, and a server restart", async () => {
  let adapterCalls = 0;
  let releaseAdapter = null;
  let adapterStartedResolve;
  const adapterStarted = new Promise(resolve => { adapterStartedResolve = resolve; });
  const adapter = http.createServer((req, res) => {
    adapterCalls += 1;
    req.resume();
    req.on("end", () => {
      releaseAdapter = () => {
        if (res.writableEnded) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ reply: "Updated while the ink was in flight." }));
      };
      adapterStartedResolve();
    });
  });
  await new Promise((resolve, reject) => {
    adapter.once("error", reject);
    adapter.listen(0, "127.0.0.1", resolve);
  });

  const adapterPort = adapter.address().port;
  let server = await startServer({ kindleAdapterUrl: `http://127.0.0.1:${adapterPort}/ingest` });
  let dataDir = server.dataDir;
  let sendPromise = null;
  try {
    assert.equal((await request(server.port, "/api/live-page/journey")).status, 401);
    assert.equal((await request(server.port, "/api/live-page/journey/content")).status, 401);

    const initialPageResponse = await request(server.port, "/api/live-page", {
      headers: { "x-diary-auth": "local-secret" }
    });
    const initialRevision = JSON.parse(initialPageResponse.body).page.revision;
    const stroke = {
      id: "stroke-rollover-e2e",
      clientId: "device-rollover-e2e",
      baseRevision: initialRevision,
      createdAt: 1000,
      surfaceWidth: 600,
      surfaceHeight: 720,
      sent: false,
      points: [{ x: 0.1, y: 0.2, t: 0 }, { x: 0.2, y: 0.3, t: 40 }]
    };
    const added = await request(server.port, "/api/live-page/ink", {
      method: "POST",
      headers: { "content-type": "application/json", "x-diary-auth": "local-secret" },
      body: JSON.stringify({
        clientId: stroke.clientId,
        ops: [{ id: "op-add-rollover-e2e", type: "add", stroke }]
      })
    });
    assert.equal(added.status, 200);

    const sendBody = JSON.stringify({
      target: "hermes",
      text: "Apply this annotation.",
      source: "live-page",
      livePageRevision: initialRevision,
      liveInkSendId: "send-rollover-e2e",
      liveInkStrokeIds: [stroke.id],
      hermesThreadId: "thread-rollover-e2e"
    });
    const sendRequest = () => request(server.port, "/api/send", {
      method: "POST",
      headers: { "content-type": "application/json", "x-diary-auth": "local-secret" },
      body: sendBody
    });
    sendPromise = sendRequest();
    await adapterStarted;

    const changedHtml = "<!doctype html><html><head><title>Journey changed</title></head><body><h1>Changed while sending</h1></body></html>";
    const publishPayload = JSON.stringify({ html: changedHtml });
    const changed = await request(server.port, "/api/live-page", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-diary-live-write": server.liveToken },
      body: publishPayload
    });
    assert.equal(changed.status, 200);
    const changedRevision = JSON.parse(changed.body).page.revision;
    assert.notEqual(changedRevision, initialRevision);

    const rolledInk = await request(server.port, "/api/live-page/ink", {
      headers: { "x-diary-auth": "local-secret" }
    });
    assert.equal(rolledInk.status, 200);
    assert.equal(JSON.parse(rolledInk.body).ink.activeRevision, changedRevision);
    assert.deepEqual(JSON.parse(rolledInk.body).ink.strokes, []);

    const journeyResponse = await request(server.port, "/api/live-page/journey", {
      headers: { "x-diary-auth": "local-secret" }
    });
    assert.equal(journeyResponse.status, 200);
    const journeyAfterChange = JSON.parse(journeyResponse.body);
    const initialFrame = journeyAfterChange.frames.find(frame => frame.page.revision === initialRevision);
    assert.deepEqual(initialFrame.strokes.map(item => item.id), [stroke.id]);

    const darkHistory = await request(
      server.port,
      `/api/live-page/journey/content?revision=${encodeURIComponent(initialRevision)}&theme=dark`,
      { headers: { "x-diary-auth": "local-secret" } }
    );
    assert.equal(darkHistory.status, 200);
    assert.match(darkHistory.headers["content-security-policy"], /script-src 'none'/);
    assert.match(darkHistory.body, /--live-paper:#15140f!important/);

    releaseAdapter();
    const sent = await sendPromise;
    assert.equal(sent.status, 200);
    const sentJson = JSON.parse(sent.body);
    assert.equal(sentJson.text, "Updated while the ink was in flight.");
    assert.equal(sentJson.pageChanged, true);
    assert.equal(sentJson.page.revision, changedRevision);
    assert.equal(adapterCalls, 1);

    const currentStroke = {
      ...stroke,
      id: "stroke-identical-e2e",
      baseRevision: changedRevision,
      createdAt: 2000
    };
    const currentAdded = await request(server.port, "/api/live-page/ink", {
      method: "POST",
      headers: { "content-type": "application/json", "x-diary-auth": "local-secret" },
      body: JSON.stringify({
        clientId: currentStroke.clientId,
        ops: [{ id: "op-add-identical-e2e", type: "add", stroke: currentStroke }]
      })
    });
    assert.equal(currentAdded.status, 200);

    const beforeIdentical = JSON.parse((await request(server.port, "/api/live-page/journey", {
      headers: { "x-diary-auth": "local-secret" }
    })).body);
    const identical = await request(server.port, "/api/live-page", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-diary-live-write": server.liveToken },
      body: publishPayload
    });
    assert.equal(identical.status, 200);
    assert.equal(JSON.parse(identical.body).page.revision, changedRevision);

    const afterIdentical = JSON.parse((await request(server.port, "/api/live-page/journey", {
      headers: { "x-diary-auth": "local-secret" }
    })).body);
    assert.deepEqual(afterIdentical, beforeIdentical);
    const inkAfterIdentical = JSON.parse((await request(server.port, "/api/live-page/ink", {
      headers: { "x-diary-auth": "local-secret" }
    })).body).ink;
    assert.deepEqual(inkAfterIdentical.strokes.map(item => item.id), [currentStroke.id]);

    await server.close({ cleanup: false });
    server = null;
    const reopened = await startServer({
      dataDir,
      kindleAdapterUrl: `http://127.0.0.1:${adapterPort}/ingest`
    });
    server = reopened;
    const afterRestart = JSON.parse((await request(server.port, "/api/live-page/journey", {
      headers: { "x-diary-auth": "local-secret" }
    })).body);
    assert.deepEqual(afterRestart, beforeIdentical);
    const restartedInk = JSON.parse((await request(server.port, "/api/live-page/ink", {
      headers: { "x-diary-auth": "local-secret" }
    })).body).ink;
    assert.deepEqual(restartedInk.strokes.map(item => item.id), [currentStroke.id]);

    const replay = await request(server.port, "/api/send", {
      method: "POST",
      headers: { "content-type": "application/json", "x-diary-auth": "local-secret" },
      body: sendBody
    });
    assert.equal(replay.status, 200);
    assert.equal(JSON.parse(replay.body).text, "Updated while the ink was in flight.");
    assert.equal(adapterCalls, 1);
  } finally {
    if (releaseAdapter) releaseAdapter();
    if (server) await server.close();
    else await fs.rm(dataDir, { recursive: true, force: true });
    await new Promise(resolve => adapter.close(resolve));
  }
});
