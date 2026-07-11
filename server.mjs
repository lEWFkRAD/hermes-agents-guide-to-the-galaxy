import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceStore } from "./lib/workspaces.mjs";
import { fetchWithTimeout, OUTBOUND_TIMEOUTS } from "./lib/outbound.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const dataDir = process.env.DIARY_DATA_DIR || path.join(__dirname, "data");
const sessionsFile = path.join(dataDir, "sessions.json");
const imagesDir = path.join(dataDir, "images");
const archiveDir = path.join(dataDir, "archive");
const workspaceStore = new WorkspaceStore(dataDir);

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
const ocrCleanupEndpoint = process.env.DIARY_OCR_CLEANUP_ENDPOINT || "http://127.0.0.1:8020/v1/chat/completions";
const ocrCleanupModel = process.env.DIARY_OCR_CLEANUP_MODEL || "qwen3.6-27b-nvfp4";
const hermesEndpoint = process.env.HERMES_ENDPOINT || "http://127.0.0.1:8642/v1/chat/completions";
const localTextEndpoint = process.env.DIARY_LOCAL_TEXT_ENDPOINT || "http://127.0.0.1:8004/v1/chat/completions";
const localTextModel = process.env.DIARY_LOCAL_TEXT_MODEL || "gpt-oss-20b";
let hermesToken = "";

// Firm-agent CHANNEL: the "Hermes firm agent" target routes here — to the Kindle
// gateway platform adapter (the real agent with MoA + tools), not a bare
// completion. Only reachable once the Hermes gateway with the `kindle` platform
// is running (interactive dev session). Token/URL from env; nothing secret in git.
const kindleAdapterUrl = process.env.KINDLE_ADAPTER_URL || "http://127.0.0.1:8793/ingest";
const kindleIngestToken = process.env.KINDLE_INGEST_TOKEN || "";
const kindleUser = process.env.KINDLE_USER || "kindle";

// Optional shared secret. If DIARY_AUTH_TOKEN is set, /api/* requires it (via the
// x-diary-auth header or a ?k= query param). Unset = open, exactly as before.
// The page is served openly; only the API (which reaches models + your data) is gated.
const authToken = process.env.DIARY_AUTH_TOKEN || "";
const remoteAccessKey = process.env.DIARY_REMOTE_KEY || "";
const trustedIps = new Set(String(process.env.DIARY_TRUSTED_IPS || "")
  .split(",")
  .map(value => value.trim())
  .filter(Boolean));

function remoteIp(req) {
  return String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
}

function isRemoteHost(req) {
  const host = String(req.headers.host || "").split(":")[0].toLowerCase();
  return host.endsWith(".ts.net");
}

function remoteKeyOk(req) {
  if (!remoteAccessKey) return false;
  if ((req.headers["x-diary-remote-key"] || "") === remoteAccessKey) return true;
  try {
    const url = new URL(req.url, "http://diary.local");
    if (url.searchParams.get("rk") === remoteAccessKey) return true;
    const match = url.pathname.match(/^\/remote\/([^/]+)\/?$/);
    return Boolean(match && decodeURIComponent(match[1]) === remoteAccessKey);
  } catch {
    return false;
  }
}

function authOk(req) {
  if (isRemoteHost(req)) return remoteKeyOk(req);
  if (!authToken) return true;
  if (trustedIps.has(remoteIp(req))) return true;
  if ((req.headers["x-diary-auth"] || "") === authToken) return true;
  const cookies = String(req.headers.cookie || "").split(";");
  for (const cookie of cookies) {
    const [name, ...value] = cookie.trim().split("=");
    try {
      if (name === "diary_auth" && decodeURIComponent(value.join("=")) === authToken) return true;
    } catch {}
  }
  try {
    const u = new URL(req.url, "http://diary.local");
    if (u.searchParams.get("k") === authToken) return true;
  } catch {}
  return false;
}

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
    "access-control-allow-headers": "content-type,authorization,x-diary-auth,x-diary-remote-key"
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
    "You are Hermes, a thinking partner inside a Kindle Scribe notebook.",
    "IMPORTANT: In this notebook you are a plain language model with NO tools.",
    "You have NO database, NO file access, NO web, NO MCP, and NO ability to look",
    "anything up or run any tool here. Do not claim otherwise.",
    "If asked to pull, look up, verify, fetch, search, or extract real data (records,",
    "files, numbers, accounts), do NOT pretend to search and do NOT invent results.",
    "In one or two sentences, say the notebook can't access data and the task needs a",
    "tool-enabled agent, then offer to help reason it through from what the user tells you.",
    "NEVER fabricate names, IDs, amounts, or 'verified' lists. If you don't know, say so.",
    "Answer the user directly as Hermes. Never mention 'reference responses', other models,",
    "drafts, or your internal process — the user only sees your final answer.",
    "Be concise and formatted for an e-ink screen. Use simple Markdown, no giant code blocks.",
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
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: chatHeaders(token, sessionKey),
    body: JSON.stringify({
      model,
      temperature: 0.35,
      max_tokens: 900,
      messages: buildMessages({ text, imageDataUrl, history })
    })
  }, OUTBOUND_TIMEOUTS.chat, "model request");

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

async function cleanHandwritingTranscription(rawText) {
  const response = await fetchWithTimeout(ocrCleanupEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: ocrCleanupModel,
      temperature: 0,
      max_tokens: 180,
      messages: [
        {
          role: "system",
          content: [
            "You correct OCR from a Kindle Scribe for a CPA firm notebook.",
            "Return only the corrected transcription, with no preface or quotation marks.",
            "Make the smallest defensible corrections to spacing, capitalization, and likely proper names.",
            "Do not answer the note and do not add facts. If uncertain, preserve the original wording.",
            "Firm vocabulary includes Bearden, Hermes, Onyx, Jameson Bearden, client, engagement, tax, and audit."
          ].join(" ")
        },
        { role: "user", content: rawText }
      ]
    })
  }, OUTBOUND_TIMEOUTS.chat, "OCR cleanup");
  const raw = await response.text();
  let json;
  try { json = JSON.parse(raw); } catch { throw new Error("OCR cleanup returned invalid JSON"); }
  if (!response.ok) throw new Error(json?.error?.message || `OCR cleanup returned ${response.status}`);
  return choiceText(json).replace(/^['"]|['"]$/g, "").trim();
}

// Streaming variant: parses the gateway's OpenAI SSE and fires onToken(delta)
// as each fragment arrives. Returns the full accumulated text at the end.
async function callChatStream({ endpoint, model, token, text, imageDataUrl, history = [], sessionKey = "kindle-scribe-diary", onToken }) {
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: chatHeaders(token, sessionKey),
    body: JSON.stringify({
      model,
      temperature: 0.35,
      max_tokens: 900,
      stream: true,
      messages: buildMessages({ text, imageDataUrl, history })
    })
  }, OUTBOUND_TIMEOUTS.stream, "streaming model request");

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

// Firm-agent CHANNEL call: hand the note to the Kindle gateway platform adapter,
// which runs the real agent (MoA + tools) and returns its reply. Non-streaming v1.
async function callKindleChannel({ text, chatId, rawText = false }) {
  const channelInstruction = [
    "[Kindle Scribe channel: The following text was transcribed from handwriting and may contain",
    "spacing or proper-name errors. Treat likely firm names and people contextually. For any",
    "question about a person, client, engagement, or the Bearden firm, use the bearden-clients",
    "tools to look it up before answering. Never guess, fabricate, or expose MoA/reference-model",
    "discussion. Give only the concise, grounded final answer suitable for an e-ink screen.]"
  ].join(" ");
  let response;
  try {
    response = await fetchWithTimeout(kindleAdapterUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(kindleIngestToken ? { "x-kindle-token": kindleIngestToken } : {})
      },
      body: JSON.stringify({ text: rawText ? text : `${channelInstruction}\n\n${text}`, user: kindleUser, chat_id: chatId })
    }, OUTBOUND_TIMEOUTS.adapter, "Kindle adapter");
  } catch (error) {
    if (error?.message?.includes("timed out")) throw error;
    throw new Error(
      "Firm agent channel isn't running. Start the Hermes gateway with the kindle " +
      "platform, then try the firm agent again."
    );
  }
  const raw = await response.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`Channel returned ${response.status}: ${raw.slice(0, 300)}`);
  }
  if (!response.ok) throw new Error(json?.error || `Channel error ${response.status}`);
  return { text: json.reply || "" };
}

function proposalPrompt(workspace, proposal, artifactSource) {
  const annotations = workspace.annotations
    .filter(item => item.artifactId === proposal.artifactId)
    .map(item => ({
      id: item.id,
      intent: item.intent,
      transcription: item.transcription,
      anchor: item.anchor
    }));
  return [
    "You are reviewing an annotated artifact from a Kindle Scribe workspace.",
    "Analyze the user's instruction and annotations. Do not modify files or take external actions.",
    "Return JSON only with this shape:",
    '{"summary":"short review","changes":[{"kind":"comment|html-edit|task","target":"anchor or selector","description":"specific proposed change","replacement":"optional replacement text"}]}',
    `Workspace mode: ${workspace.mode}`,
    `Artifact: ${proposal.artifactId}`,
    `Instruction: ${proposal.instruction}`,
    `Annotations: ${JSON.stringify(annotations)}`,
    artifactSource ? `Artifact source:\n${artifactSource.slice(0, 30000)}` : "The artifact is an image; rely on the annotation text and anchors provided."
  ].join("\n\n");
}

function parseProposalReply(text) {
  const raw = String(text || "").trim();
  const unfenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const candidates = [unfenced];
  const firstBrace = unfenced.indexOf("{");
  const lastBrace = unfenced.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(unfenced.slice(firstBrace, lastBrace + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      return {
        summary: String(parsed.summary || "Proposal ready"),
        changes: Array.isArray(parsed.changes) ? parsed.changes : []
      };
    } catch {
      /* try the next candidate */
    }
  }
  return { summary: raw || "Hermes returned an empty proposal", changes: [] };
}

async function handleWorkspaceApi(req, res) {
  try {
    const url = new URL(req.url, "http://diary.local");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 2) {
      if (req.method === "GET") {
        send(res, 200, JSON.stringify({ ok: true, workspaces: workspaceStore.list() }));
        return;
      }
      if (req.method === "POST") {
        const workspace = await workspaceStore.create(JSON.parse(await readBody(req) || "{}"));
        send(res, 201, JSON.stringify({ ok: true, workspace }));
        return;
      }
    }

    const workspaceId = parts[2];
    const workspace = workspaceStore.get(workspaceId);
    if (!workspace) {
      send(res, 404, JSON.stringify({ ok: false, error: "Workspace not found" }));
      return;
    }
    if (parts.length === 3 && req.method === "GET") {
      send(res, 200, JSON.stringify({ ok: true, workspace }));
      return;
    }

    const action = parts[3];
    const body = req.method === "POST" ? JSON.parse(await readBody(req) || "{}") : {};
    if (action === "artifacts" && req.method === "POST") {
      const artifact = await workspaceStore.addArtifact(workspaceId, body);
      send(res, 201, JSON.stringify({ ok: true, artifact, workspace: workspaceStore.get(workspaceId) }));
      return;
    }
    if (action === "annotations" && req.method === "POST") {
      const annotation = await workspaceStore.addAnnotation(workspaceId, body);
      send(res, 201, JSON.stringify({ ok: true, annotation, workspace: workspaceStore.get(workspaceId) }));
      return;
    }
    if (action === "proposals" && parts.length === 4 && req.method === "POST") {
      const proposal = await workspaceStore.createProposal(workspaceId, body);
      send(res, 201, JSON.stringify({ ok: true, proposal, workspace: workspaceStore.get(workspaceId) }));
      return;
    }
    if (action === "proposals" && parts[5] === "analyze" && req.method === "POST") {
      const proposalId = parts[4];
      const rawWorkspace = workspaceStore.raw(workspaceId);
      const proposal = rawWorkspace.proposals.find(item => item.id === proposalId);
      if (!proposal) throw new Error("Proposal not found");
      const found = workspaceStore.findArtifact(proposal.artifactId);
      let artifactSource = "";
      if (found?.artifact.type === "html") {
        artifactSource = (await fs.readFile(found.artifact.storagePath, "utf8"));
      }
      try {
        const result = await callKindleChannel({
          text: proposalPrompt(rawWorkspace, proposal, artifactSource),
          chatId: `workspace-${workspaceId}-${proposalId}`
        });
        const completed = await workspaceStore.completeProposal(workspaceId, proposalId, parseProposalReply(result.text));
        send(res, 200, JSON.stringify({ ok: true, proposal: completed, workspace: workspaceStore.get(workspaceId) }));
      } catch (error) {
        const failed = await workspaceStore.completeProposal(workspaceId, proposalId, { error: error.message });
        send(res, 502, JSON.stringify({ ok: false, error: error.message, proposal: failed }));
      }
      return;
    }
    send(res, 404, JSON.stringify({ ok: false, error: "Workspace route not found" }));
  } catch (error) {
    send(res, 400, JSON.stringify({ ok: false, error: error.message }));
  }
}

async function serveArtifact(req, res) {
  const url = new URL(req.url, "http://diary.local");
  const match = /^\/api\/artifacts\/([^/]+)\/content$/.exec(url.pathname);
  if (!match) {
    send(res, 404, JSON.stringify({ ok: false, error: "Artifact not found" }));
    return;
  }
  const result = await workspaceStore.readArtifact(match[1]);
  if (!result) {
    send(res, 404, JSON.stringify({ ok: false, error: "Artifact not found" }));
    return;
  }
  res.writeHead(200, {
    "content-type": result.artifact.contentType,
    "cache-control": "no-store",
    "content-security-policy": result.artifact.type === "html"
      ? "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"
      : "default-src 'none'",
    "x-content-type-options": "nosniff"
  });
  res.end(result.buffer);
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
      if (target === "hermes") {
        // Explicit opt-in to the firm MoA agent persona.
        endpoint = hermesEndpoint;
        token ||= hermesToken;
        model ||= defaultTextModel;
        mode = "hermes";
      } else {
        // Default: a plain assistant. Text goes to the local text model, ink to
        // the local vision model. No firm-agent persona, no tool delusions.
        endpoint = hasInk ? defaultVisionEndpoint : localTextEndpoint;
        model ||= hasInk ? defaultVisionModel : localTextModel;
        mode = hasInk ? "vision" : "plain";
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
    const requestedHermesThreadId = typeof body.hermesThreadId === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(body.hermesThreadId)
      ? body.hermesThreadId
      : "";
    if (!session.channelThreadId) session.channelThreadId = requestedHermesThreadId || session.id;

    const history = session.messages.slice(-12).map(m => ({
      role: m.role,
      content: m.role === "user"
        ? (m.text || "[handwritten diary entry — see your transcription in the next reply]")
        : m.text
    }));

    function commitSession(replyText, transcription = "", rawTranscription = "") {
      if (isNewSession) sessions.unshift(session);
      const now = new Date().toISOString();
      const inkRefPromise = hasInk ? writeInkFile(session.id, body.imageDataUrl) : Promise.resolve("");
      return inkRefPromise.then(async (inkRef) => {
        session.messages.push({
          role: "user",
          text: body.text || "",
          transcription,
          rawTranscription,
          ink: inkRef,
          time: now
        });
        session.messages.push({ role: "assistant", text: replyText, time: now });
        if (!session.title) {
          const wrote = replyText.match(/^You wrote:\s*"([^"\n]{1,60})/i);
          session.title = (body.text || (wrote && wrote[1]) || "Handwritten entry").slice(0, 60);
        }
        session.updatedAt = now;
        await saveSessions();
      });
    }

    // ---- Firm-agent CHANNEL: route to the real Hermes agent via the adapter --
    if (target === "hermes") {
      const startedCh = Date.now();
      // The channel takes text; transcribe handwriting via the vision model first.
      let noteText = body.text || "";
      let rawTranscription = "";
      if (hasInk) {
        try {
          const vis = await callChat({
            endpoint: defaultVisionEndpoint,
            model: defaultVisionModel,
            token: "",
            text: "Transcribe the handwriting exactly. Output only the transcription. Preserve proper names; Bearden is a likely firm surname and must not be split into 'Bear den'.",
            imageDataUrl: body.imageDataUrl,
            mode: "vision"
          });
          const visionOutput = (vis.text || "").trim();
          const quotedTranscription = visionOutput.match(/^You wrote:\s*["“]([^"”\n]+)["”]/i);
          rawTranscription = (quotedTranscription?.[1] || visionOutput).trim();
          let cleaned = rawTranscription;
          if (rawTranscription) {
            try { cleaned = await cleanHandwritingTranscription(rawTranscription); } catch {}
          }
          noteText = (noteText ? noteText + "\n\n" : "") + cleaned;
        } catch {
          /* fall through with whatever text we have */
        }
      }

      const wantStream = !!body.stream;
      if (wantStream) {
        res.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "access-control-allow-origin": "*"
        });
        res.write(JSON.stringify({ sessionId: session.id, hermesThreadId: session.channelThreadId }) + "\n");
      }

      let result;
      try {
        result = await callKindleChannel({ text: noteText, chatId: session.channelThreadId });
      } catch (error) {
        logSend({ kind: "error", target: "hermes", channel: true, error: error.message });
        if (wantStream) {
          res.write(RS + JSON.stringify({ error: error.message }));
          res.end();
        } else {
          send(res, 502, JSON.stringify({ ok: false, error: error.message }));
        }
        return;
      }

      if (!result.text || !result.text.trim()) {
        const emsg = "The firm agent returned an empty reply. Tap Send to try again.";
        if (wantStream) { res.write(RS + JSON.stringify({ error: emsg })); res.end(); }
        else send(res, 502, JSON.stringify({ ok: false, error: emsg }));
        return;
      }

      await commitSession(result.text, noteText, rawTranscription);
      logSend({
        kind: "send", target: "hermes", channel: true, sessionId: session.id,
        textChars: noteText.length, imageBytes, responseChars: result.text.length,
        durationMs: Date.now() - startedCh
      });
      if (wantStream) {
        res.write(result.text);
        res.write(RS + JSON.stringify({ title: session.title }));
        res.end();
      } else {
        send(res, 200, JSON.stringify({ ok: true, text: result.text, sessionId: session.id, hermesThreadId: session.channelThreadId, title: session.title }));
      }
      return;
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
      res.write(JSON.stringify({ sessionId: session.id, hermesThreadId: session.channelThreadId }) + "\n");

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

      // An empty reply (transient gateway hiccup) must not be committed or
      // shown as a blank page — surface it as a retryable error instead.
      if (!result.text || !result.text.trim()) {
        logSend({ kind: "error", streaming: true, error: "empty reply", durationMs: Date.now() - startedStream });
        res.write(RS + JSON.stringify({ error: "Hermes returned an empty reply. Tap Send to try again." }));
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

    // Don't commit or return an empty reply — surface it as retryable.
    if (!result.text || !result.text.trim()) {
      logSend({ kind: "error", error: "empty reply", durationMs: Date.now() - startedAt });
      send(res, 502, JSON.stringify({ ok: false, error: "Hermes returned an empty reply. Tap Send to try again." }));
      return;
    }

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
  if (isRemoteHost(req) && /^\/remote\/[^/]+\/?$/.test(rel)) {
    if (!remoteKeyOk(req)) {
      send(res, 401, "Unauthorized", "text/plain; charset=utf-8");
      return;
    }
    rel = "/index.html";
  }
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
  // Pair from the secure link, then remove its secret from the address bar.
  // Kindle retains first-party cookies more reliably than localStorage.
  if (authToken && req.method === "GET") {
    const requestUrl = new URL(req.url, "http://diary.local");
    if (requestUrl.searchParams.get("k") === authToken) {
      requestUrl.searchParams.delete("k");
      const location = requestUrl.pathname + requestUrl.search;
      res.writeHead(302, {
        location: location || "/",
        "set-cookie": `diary_auth=${encodeURIComponent(authToken)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`,
        "cache-control": "no-store"
      });
      res.end();
      return;
    }
  }
  // Funnel is public internet: every API call and stored handwriting image
  // requires the permanent remote bookmark key. LAN behavior remains unchanged.
  const requestPath = new URL(req.url, "http://diary.local").pathname;
  const protectedRemotePath = requestPath.startsWith("/api/") || requestPath.startsWith("/img/");
  const localProtectedApi = requestPath.startsWith("/api/") && requestPath !== "/api/config";
  if (((isRemoteHost(req) && protectedRemotePath) || (!isRemoteHost(req) && localProtectedApi)) && !authOk(req)) {
    send(res, 401, JSON.stringify({ ok: false, error: "unauthorized — use the permanent remote diary bookmark" }));
    return;
  }
  if (requestPath === "/api/config") {
    send(res, 200, JSON.stringify({
      defaultTextEndpoint,
      defaultVisionEndpoint,
      defaultTextModel,
      defaultVisionModel,
      localTextEndpoint,
      localTextModel,
      hermesEndpoint,
      hasHermesToken: Boolean(hermesToken),
      authRequired: Boolean(authToken)
    }));
    return;
  }
  if (req.method === "POST" && req.url === "/api/warm") {
    // Wake the model in the background so a real send doesn't pay cold start.
    // Respond immediately; the warm-up runs fire-and-forget.
    (async () => {
      try {
        await fetchWithTimeout(hermesEndpoint, {
          method: "POST",
          headers: chatHeaders(hermesToken, "kindle-scribe-diary-warm"),
          body: JSON.stringify({
            model: defaultTextModel,
            max_tokens: 1,
            messages: [{ role: "user", content: "hi" }]
          })
        }, OUTBOUND_TIMEOUTS.warm, "warm-up request");
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
  if (req.method === "POST" && req.url === "/api/channel/reset") {
    try {
      const body = JSON.parse(await readBody(req));
      const chatId = typeof body.chatId === "string" ? body.chatId.trim() : "";
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(chatId)) {
        send(res, 400, JSON.stringify({ ok: false, error: "Invalid channel thread" }));
        return;
      }
      const result = await callKindleChannel({ text: "/new", chatId, rawText: true });
      logSend({ kind: "channel-reset", chatId });
      send(res, 200, JSON.stringify({ ok: true, text: result.text }));
    } catch (error) {
      logSend({ kind: "channel-reset-error", error: error.message });
      send(res, 502, JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }
  if (req.url.startsWith("/api/workspaces")) {
    await handleWorkspaceApi(req, res);
    return;
  }
  if (req.url.startsWith("/api/artifacts/")) {
    await serveArtifact(req, res);
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
await workspaceStore.init();

server.listen(port, host, () => {
  console.log(`Hermes Agents Guide to the Galaxy listening on http://${host}:${port}`);
  console.log(`Hermes endpoint: ${hermesEndpoint} (${hermesToken ? "token loaded" : "no token"})`);
});
