import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const sessionsFile = path.join(dataDir, "sessions.json");
const imagesDir = path.join(dataDir, "images");
const archiveDir = path.join(dataDir, "archive");

let sessions = [];
let imageSeq = 0;

// Record separator: marks the boundary between streamed reply text and the
// trailing JSON metadata line. Never appears in normal model output.
const RS = "";

// Handwriting images live as files on disk, not inline in sessions.json —
// that keeps the session index tiny and quick to rewrite on every send.
async function writeInkFile(sessionId, dataUrl) {
  const match = /^data:image\/(png|jpeg|jpg);base64,(.+)$/s.exec(dataUrl || "");
  if (!match) return "";
  const ext = match[1] === "png" ? "png" : "jpg";
  const buffer = Buffer.from(match[2], "base64");
  await fs.mkdir(imagesDir, { recursive: true });
  imageSeq += 1;
  const name = `${sessionId}-${Date.now().toString(36)}-${imageSeq}.${ext}`;
  await fs.writeFile(path.join(imagesDir, name), buffer);
  return "/img/" + name;
}

// One-time upgrade: pull any base64 images still embedded in old entries out
// to files so the whole store benefits, not just new entries.
async function migrateInlineImages() {
  let changed = false;
  for (const session of sessions) {
    for (const message of session.messages || []) {
      if (typeof message.ink === "string" && message.ink.startsWith("data:image/")) {
        const ref = await writeInkFile(session.id, message.ink);
        message.ink = ref;
        changed = true;
      }
    }
  }
  if (changed) await saveSessions();
}

// Retention: move image files older than `days` out of the hot images dir
// into archive/. URLs still resolve (the /img route checks both), so old
// thumbnails keep working; archive/ can be pruned or backed up separately.
async function archiveOldImages(days) {
  const cutoff = Date.now() - days * 86400000;
  let moved = 0;
  let files;
  try {
    files = await fs.readdir(imagesDir);
  } catch {
    return { moved: 0 };
  }
  await fs.mkdir(archiveDir, { recursive: true });
  for (const name of files) {
    const src = path.join(imagesDir, name);
    let stat;
    try {
      stat = await fs.stat(src);
    } catch {
      continue;
    }
    if (stat.mtimeMs < cutoff) {
      try {
        await fs.rename(src, path.join(archiveDir, name));
        moved += 1;
      } catch {
        /* skip files we can't move */
      }
    }
  }
  return { moved };
}

async function loadSessions() {
  try {
    sessions = JSON.parse(await fs.readFile(sessionsFile, "utf8"));
    if (!Array.isArray(sessions)) sessions = [];
  } catch {
    sessions = [];
  }
}

async function saveSessions() {
  await fs.mkdir(dataDir, { recursive: true });
  const tmp = sessionsFile + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(sessions));
  await fs.rename(tmp, sessionsFile);
}

function newSessionId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function sessionSummary(s) {
  const lastUser = [...s.messages].reverse().find(m => m.role === "user");
  return {
    id: s.id,
    title: s.title || "Untitled entry",
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    count: s.messages.length,
    preview: (lastUser?.text || lastUser?.transcription || "handwritten entry").slice(0, 90)
  };
}

const host = process.env.DIARY_HOST || "0.0.0.0";
const port = Number(process.env.DIARY_PORT || 8791);
const defaultTextEndpoint = process.env.DIARY_TEXT_ENDPOINT || "http://127.0.0.1:8642/v1/chat/completions";
const defaultVisionEndpoint = process.env.DIARY_VISION_ENDPOINT || "http://127.0.0.1:8005/v1/chat/completions";
const defaultTextModel = process.env.DIARY_TEXT_MODEL || "hermes-agent";
const defaultVisionModel = process.env.DIARY_VISION_MODEL || "qwen3vl-8b";
const hermesEndpoint = process.env.HERMES_ENDPOINT || "http://127.0.0.1:8642/v1/chat/completions";
const localTextEndpoint = process.env.DIARY_LOCAL_TEXT_ENDPOINT || "http://127.0.0.1:8004/v1/chat/completions";
const localTextModel = process.env.DIARY_LOCAL_TEXT_MODEL || "gpt-oss-20b";
let hermesToken = "";

async function loadHermesToken() {
  if (process.env.HERMES_TOKEN || process.env.HERMES_API_KEY || process.env.API_SERVER_KEY) {
    return process.env.HERMES_TOKEN || process.env.HERMES_API_KEY || process.env.API_SERVER_KEY;
  }

  const configPath = process.env.HERMES_CONFIG || path.join(
    process.env.LOCALAPPDATA || "",
    "hermes",
    "config.yaml"
  );
  try {
    const configText = await fs.readFile(configPath, "utf8");
    const match = configText.match(/^\s*API_SERVER_KEY:\s*['"]?([^'"\r\n#]+)['"]?\s*$/m);
    return match ? match[1].trim() : "";
  } catch {
    return "";
  }
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml"
};

function imageBytesFromDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") return 0;
  const comma = dataUrl.indexOf(",");
  const payload = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Math.floor(payload.length * 0.75);
}

function logSend(event) {
  const line = JSON.stringify({ time: new Date().toISOString(), ...event });
  console.log(line);
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 12_000_000) {
        reject(new Error("Request too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function choiceText(json) {
  const msg = json?.choices?.[0]?.message?.content;
  if (Array.isArray(msg)) {
    return msg.map(part => part.text || part.content || "").join("\n").trim();
  }
  if (typeof msg === "string") return msg.trim();
  if (typeof json?.choices?.[0]?.text === "string") return json.choices[0].text.trim();
  return JSON.stringify(json, null, 2);
}

function buildMessages({ text, imageDataUrl, history = [] }) {
  const system = [
    "You are Hermes inside a Kindle Scribe diary.",
    "Be concise, useful, and formatted for an e-ink screen.",
    "Use simple Markdown. No giant code blocks unless asked.",
    "When the user sends a handwritten image, begin your reply with one line:",
    "You wrote: \"<short transcription of the handwriting>\"",
    "then respond on the following lines."
  ].join(" ");

  const prompt = text?.trim()
    ? text.trim()
    : "Read the handwriting in this image and respond to it as a helpful work notebook assistant.";

  const userContent = imageDataUrl
    ? [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: imageDataUrl } }
      ]
    : prompt;

  return [
    { role: "system", content: system },
    ...history,
    { role: "user", content: userContent }
  ];
}

function chatHeaders(token, sessionKey) {
  return {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    "x-hermes-session-key": sessionKey
  };
}

async function callChat({ endpoint, model, token, text, imageDataUrl, mode, history = [], sessionKey = "kindle-scribe-diary" }) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: chatHeaders(token, sessionKey),
    body: JSON.stringify({
      model,
      temperature: 0.35,
      max_tokens: 900,
      messages: buildMessages({ text, imageDataUrl, history })
    })
  });

  const raw = await response.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`Model returned ${response.status}: ${raw.slice(0, 600)}`);
  }
  if (!response.ok) {
    throw new Error(json?.error?.message || `Model returned ${response.status}: ${raw.slice(0, 600)}`);
  }
  return { text: choiceText(json), endpoint, model, mode };
}

// Streaming variant: parses the gateway's OpenAI SSE and fires onToken(delta)
// as each fragment arrives. Returns the full accumulated text at the end.
async function callChatStream({ endpoint, model, token, text, imageDataUrl, history = [], sessionKey = "kindle-scribe-diary", onToken }) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: chatHeaders(token, sessionKey),
    body: JSON.stringify({
      model,
      temperature: 0.35,
      max_tokens: 900,
      stream: true,
      messages: buildMessages({ text, imageDataUrl, history })
    })
  });

  if (!response.ok || !response.body) {
    const raw = await response.text().catch(() => "");
    let msg;
    try {
      msg = JSON.parse(raw)?.error?.message;
    } catch {
      msg = "";
    }
    throw new Error(msg || `Model returned ${response.status}: ${raw.slice(0, 400)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  let stop = false;

  while (!stop) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        stop = true;
        break;
      }
      try {
        const obj = JSON.parse(payload);
        const delta = obj?.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onToken(delta);
        }
      } catch {
        /* ignore keep-alives / partial JSON */
      }
    }
  }
  return { text: full };
}

async function handleSend(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    const target = body.target || "auto";
    const hasInk = typeof body.imageDataUrl === "string" && body.imageDataUrl.startsWith("data:image/");
    const imageBytes = hasInk ? imageBytesFromDataUrl(body.imageDataUrl) : 0;

    let endpoint = body.endpoint?.trim();
    let model = body.model?.trim();
    let token = body.token?.trim() || "";
    let mode = target;

    if (!endpoint) {
      if (target === "local") {
        endpoint = hasInk ? defaultVisionEndpoint : localTextEndpoint;
        model ||= hasInk ? defaultVisionModel : localTextModel;
        mode = hasInk ? "local-vision" : "local-text";
      } else if (target === "hermes" || target === "auto") {
        endpoint = hermesEndpoint;
        token ||= hermesToken;
        model ||= defaultTextModel;
        mode = "hermes";
      } else {
        endpoint = hermesEndpoint;
        token ||= hermesToken;
        model ||= defaultTextModel;
        mode = "hermes";
      }
    }

    // Find an existing session, but do NOT register a new one yet — if the
    // Hermes call fails, we must not leave a phantom empty entry in History.
    let session = body.sessionId ? sessions.find(s => s.id === body.sessionId) : null;
    const isNewSession = !session;
    if (!session) {
      session = {
        id: newSessionId(),
        title: "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: []
      };
    }

    const history = session.messages.slice(-12).map(m => ({
      role: m.role,
      content: m.role === "user"
        ? (m.text || "[handwritten diary entry — see your transcription in the next reply]")
        : m.text
    }));

    function commitSession(replyText) {
      if (isNewSession) sessions.unshift(session);
      const now = new Date().toISOString();
      const inkRefPromise = hasInk ? writeInkFile(session.id, body.imageDataUrl) : Promise.resolve("");
      return inkRefPromise.then(async (inkRef) => {
        session.messages.push({ role: "user", text: body.text || "", ink: inkRef, time: now });
        session.messages.push({ role: "assistant", text: replyText, time: now });
        if (!session.title) {
          const wrote = replyText.match(/^You wrote:\s*"([^"\n]{1,60})/i);
          session.title = (body.text || (wrote && wrote[1]) || "Handwritten entry").slice(0, 60);
        }
        session.updatedAt = now;
        await saveSessions();
      });
    }

    // ---- Streaming path: relay tokens live to the client -------------------
    if (body.stream) {
      const startedStream = Date.now();
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
        "access-control-allow-origin": "*"
      });
      // First line = metadata the client needs immediately (session id).
      res.write(JSON.stringify({ sessionId: session.id }) + "\n");

      let result;
      try {
        result = await callChatStream({
          endpoint,
          model,
          token,
          text: body.text || "",
          imageDataUrl: hasInk ? body.imageDataUrl : "",
          history,
          sessionKey: "kindle-scribe-diary-" + session.id,
          onToken: (t) => res.write(t)
        });
      } catch (error) {
        logSend({ kind: "error", streaming: true, error: error.message });
        res.write("" + JSON.stringify({ error: error.message }));
        res.end();
        return;
      }

      await commitSession(result.text);
      logSend({
        kind: "send",
        streaming: true,
        target,
        model,
        sessionId: session.id,
        historyTurns: history.length,
        textChars: (body.text || "").length,
        imageBytes,
        responseChars: result.text.length,
        durationMs: Date.now() - startedStream
      });
      // Trailer (after a record-separator) carries the final title.
      res.write("" + JSON.stringify({ title: session.title }));
      res.end();
      return;
    }
    // ---- Non-streaming path (unchanged) ------------------------------------

    const startedAt = Date.now();
    const result = await callChat({
      endpoint,
      model,
      token,
      text: body.text || "",
      imageDataUrl: hasInk ? body.imageDataUrl : "",
      mode,
      history,
      sessionKey: "kindle-scribe-diary-" + session.id
    });

    // The call succeeded — now it's safe to register a brand-new session.
    if (isNewSession) sessions.unshift(session);

    // Persist the handwriting as a file and store only its URL in the session.
    const inkRef = hasInk ? await writeInkFile(session.id, body.imageDataUrl) : "";

    const now = new Date().toISOString();
    session.messages.push({
      role: "user",
      text: body.text || "",
      ink: inkRef,
      time: now
    });
    session.messages.push({ role: "assistant", text: result.text, time: now });
    if (!session.title) {
      const wrote = result.text.match(/^You wrote:\s*"([^"\n]{1,60})/i);
      session.title = (body.text || (wrote && wrote[1]) || "Handwritten entry").slice(0, 60);
    }
    session.updatedAt = now;
    await saveSessions();

    logSend({
      kind: "send",
      target,
      mode: result.mode,
      model: result.model,
      endpoint: result.endpoint,
      sessionId: session.id,
      historyTurns: history.length,
      textChars: (body.text || "").length,
      imageBytes,
      responseChars: result.text.length,
      durationMs: Date.now() - startedAt
    });
    send(res, 200, JSON.stringify({
      ok: true,
      ...result,
      sessionId: session.id,
      title: session.title
    }));
  } catch (error) {
    logSend({ kind: "error", error: error.message });
    send(res, 500, JSON.stringify({ ok: false, error: error.message }));
  }
}

async function handleSessions(req, res) {
  try {
    const url = new URL(req.url, "http://diary.local");
    const parts = url.pathname.split("/").filter(Boolean); // ["api","sessions",...]

    if (req.method === "GET" && parts.length === 2) {
      send(res, 200, JSON.stringify({ ok: true, sessions: sessions.map(sessionSummary) }));
      return;
    }
    if (req.method === "GET" && parts.length === 3) {
      const session = sessions.find(s => s.id === parts[2]);
      if (!session) {
        send(res, 404, JSON.stringify({ ok: false, error: "Session not found" }));
        return;
      }
      send(res, 200, JSON.stringify({ ok: true, session }));
      return;
    }
    if (req.method === "POST" && parts.length === 4 && parts[3] === "delete") {
      const index = sessions.findIndex(s => s.id === parts[2]);
      if (index >= 0) {
        sessions.splice(index, 1);
        await saveSessions();
      }
      send(res, 200, JSON.stringify({ ok: true }));
      return;
    }
    send(res, 404, JSON.stringify({ ok: false, error: "Unknown sessions route" }));
  } catch (error) {
    send(res, 500, JSON.stringify({ ok: false, error: error.message }));
  }
}

// Serve a stored handwriting image by name, checking the hot dir then archive.
async function serveImage(req, res) {
  const url = new URL(req.url, "http://diary.local");
  const name = path.basename(decodeURIComponent(url.pathname).replace(/^\/img\//, ""));
  if (!name || name.indexOf("..") >= 0) {
    send(res, 400, "Bad request", "text/plain; charset=utf-8");
    return;
  }
  for (const dir of [imagesDir, archiveDir]) {
    try {
      const data = await fs.readFile(path.join(dir, name));
      send(res, 200, data, mime[path.extname(name)] || "application/octet-stream");
      return;
    } catch {
      /* try next dir */
    }
  }
  send(res, 404, "Not found", "text/plain; charset=utf-8");
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://diary.local");
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(publicDir, rel));
  if (!file.startsWith(publicDir)) {
    send(res, 403, "Forbidden", "text/plain; charset=utf-8");
    return;
  }
  try {
    const data = await fs.readFile(file);
    send(res, 200, data, mime[path.extname(file)] || "application/octet-stream");
  } catch {
    send(res, 404, "Not found", "text/plain; charset=utf-8");
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    send(res, 204, "");
    return;
  }
  if (req.url === "/api/config") {
    send(res, 200, JSON.stringify({
      defaultTextEndpoint,
      defaultVisionEndpoint,
      defaultTextModel,
      defaultVisionModel,
      localTextEndpoint,
      localTextModel,
      hermesEndpoint,
      hasHermesToken: Boolean(hermesToken)
    }));
    return;
  }
  if (req.method === "POST" && req.url === "/api/warm") {
    // Wake the model in the background so a real send doesn't pay cold start.
    // Respond immediately; the warm-up runs fire-and-forget.
    (async () => {
      try {
        await fetch(hermesEndpoint, {
          method: "POST",
          headers: chatHeaders(hermesToken, "kindle-scribe-diary-warm"),
          body: JSON.stringify({
            model: defaultTextModel,
            max_tokens: 1,
            messages: [{ role: "user", content: "hi" }]
          })
        });
        logSend({ kind: "warm", ok: true });
      } catch (error) {
        logSend({ kind: "warm", ok: false, error: error.message });
      }
    })();
    send(res, 200, JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "POST" && req.url === "/api/clientlog") {
    try {
      const body = JSON.parse(await readBody(req));
      logSend({ kind: "clientlog", where: body.where, message: body.message, ua: body.ua });
    } catch {
      /* ignore malformed client logs */
    }
    send(res, 200, JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "POST" && req.url === "/api/send") {
    await handleSend(req, res);
    return;
  }
  if (req.url.startsWith("/api/sessions")) {
    await handleSessions(req, res);
    return;
  }
  if (req.method === "POST" && req.url.startsWith("/api/maintenance/archive")) {
    try {
      const u = new URL(req.url, "http://diary.local");
      const raw = u.searchParams.get("days");
      const parsed = raw === null ? 7 : Number(raw);
      const days = Number.isFinite(parsed) ? Math.max(0, parsed) : 7;
      const result = await archiveOldImages(days);
      logSend({ kind: "archive", days, moved: result.moved });
      send(res, 200, JSON.stringify({ ok: true, days, ...result }));
    } catch (error) {
      send(res, 500, JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }
  if (req.url.startsWith("/img/")) {
    await serveImage(req, res);
    return;
  }
  await serveStatic(req, res);
});

hermesToken = await loadHermesToken();
await loadSessions();
await migrateInlineImages();

server.listen(port, host, () => {
  console.log(`Hermes Agents Guide to the Galaxy listening on http://${host}:${port}`);
  console.log(`Hermes endpoint: ${hermesEndpoint} (${hermesToken ? "token loaded" : "no token"})`);
});
