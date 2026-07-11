import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LivePageStore, createLivePageTemplate, renderLivingDocument } from "./lib/live-page.mjs";
import { LiveInkStore } from "./lib/live-page-ink.mjs";
import { LivePageJourneyStore } from "./lib/live-page-journey.mjs";
import { WorkspaceStore } from "./lib/workspaces.mjs";
import { fetchWithTimeout, OUTBOUND_TIMEOUTS } from "./lib/outbound.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const dataDir = process.env.DIARY_DATA_DIR || path.join(__dirname, "data");
const sessionsFile = path.join(dataDir, "sessions.json");
const imagesDir = path.join(dataDir, "images");
const archiveDir = path.join(dataDir, "archive");
const workspaceStore = new WorkspaceStore(dataDir);
const livePageStore = new LivePageStore(dataDir);
const liveInkStore = new LiveInkStore(dataDir);
const liveJourneyStore = new LivePageJourneyStore(dataDir);
const liveWriteTokenFile = path.join(dataDir, "live-page-write.token");
const liveSourceFile = path.join(dataDir, "live-page-source.html");
const liveTransitionFile = path.join(dataDir, "live-page-transition.json");
const livePublisherScript = path.join(__dirname, "scripts", "publish-live-page.mjs");

let sessions = [];
let sessionsSaveQueue = Promise.resolve();
let imageSeq = 0;
let liveStateQueue = Promise.resolve();
let livePendingTransition = null;
let liveTransitionSequence = 0;

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
    const loaded = JSON.parse(await fs.readFile(sessionsFile, "utf8"));
    if (!Array.isArray(loaded)) throw new Error("session history must be a JSON array");
    sessions = loaded;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      sessions = [];
      return;
    }
    const detail = error instanceof SyntaxError ? "session history is not valid JSON" : error.message;
    throw new Error(`Cannot load session history without risking data loss: ${detail}`);
  }
}

async function saveSessionsInner() {
  await fs.mkdir(dataDir, { recursive: true });
  const tmp = `${sessionsFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const backup = sessionsFile + ".bak";
  let handle;
  try {
    handle = await fs.open(tmp, "wx", 0o600);
    await handle.writeFile(JSON.stringify(sessions), "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await fs.copyFile(sessionsFile, backup);
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
    await fs.rename(tmp, sessionsFile);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(tmp).catch(() => {});
    throw error;
  }
}

function saveSessions() {
  const run = sessionsSaveQueue.then(() => saveSessionsInner());
  sessionsSaveQueue = run.catch(() => {});
  return run;
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
let liveWriteToken = "";
const trustedIps = new Set(String(process.env.DIARY_TRUSTED_IPS || "")
  .split(",")
  .map(value => value.trim())
  .filter(Boolean));

function remoteIp(req) {
  return String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
}

function isLoopback(req) {
  const ip = remoteIp(req);
  return ip === "127.0.0.1" || ip === "::1";
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
    const match = url.pathname.match(/^\/remote\/([^/]+)(?:\/live\/?)?$/);
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

async function loadLiveWriteToken() {
  const configured = String(process.env.DIARY_LIVE_WRITE_TOKEN || "").trim();
  if (configured) return configured;
  try {
    const stored = (await fs.readFile(liveWriteTokenFile, "utf8")).trim();
    if (stored) return stored;
  } catch {}
  await fs.mkdir(dataDir, { recursive: true });
  const generated = crypto.randomBytes(32).toString("base64url");
  try {
    await fs.writeFile(liveWriteTokenFile, generated, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return generated;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return (await fs.readFile(liveWriteTokenFile, "utf8")).trim();
  }
}

function sameSecret(actual, expected) {
  const left = Buffer.from(String(actual || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function livePageWriteOk(req) {
  // Funnel terminates on this machine, so its socket may appear local. The
  // public Host boundary is therefore checked as well as the peer address.
  if (isRemoteHost(req) || !isLoopback(req)) return false;
  return sameSecret(req.headers["x-diary-live-write"], liveWriteToken);
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

function send(res, status, body, type = "application/json; charset=utf-8", extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,x-diary-auth,x-diary-remote-key",
    ...extraHeaders
  });
  res.end(body);
}

function readBody(req, maxChars = 12_000_000) {
  return new Promise((resolve, reject) => {
    let data = "";
    let rejected = false;
    req.setEncoding("utf8");
    req.on("data", chunk => {
      if (rejected) return;
      data += chunk;
      if (data.length > maxChars) {
        rejected = true;
        data = "";
        const error = new Error("Request too large");
        error.statusCode = 413;
        reject(error);
      }
    });
    req.on("end", () => { if (!rejected) resolve(data); });
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

function reconcileLivePageReply(text, pageChanged, page) {
  const reply = String(text || "").trim();
  if (!pageChanged) return reply;
  const title = page?.title ? ` “${page.title}”` : "";
  const deniesPublish = /\b(?:cannot|can't|could not|couldn't|unable to)\b[^.\n]{0,100}\b(?:generate|create|make|publish|display|edit|update|write)\b[^.\n]{0,80}\b(?:html|live page|page)\b/i.test(reply)
    || /\b(?:cannot|can't|could not|couldn't|unable to)\b[^.\n]{0,100}\b(?:directly to|on)\b[^.\n]{0,50}\bkindle\b/i.test(reply);
  if (deniesPublish) return `Done — I updated the page${title}.`;
  if (/\b(?:done|updated|published|created|made)\b/i.test(reply)) return reply;
  return `Done — I updated the page${title}.\n\n${reply}`;
}

const KINDLE_INTENTS = new Map([
  ["summarize", "Summarize the current page or note. Start with the answer in one short paragraph, then add only the most useful detail."],
  ["tasks", "Extract tasks. Group them by owner, due date, and uncertainty. If a task is inferred from handwriting, label it inferred."],
  ["email", "Draft a concise email from the note or marked page. Do not send it. Put the draft first, then a short note about assumptions."],
  ["workpaper", "Create a workpaper-ready note: facts, evidence, open items, risks, and next action. Keep amounts, dates, and names exact."],
  ["redline", "Return exactly one concise, non-destructive proposed replacement for the marked page content. If replacement is inappropriate, return exactly one concise rationale instead. Anchor the suggestion in the marked DOM target and page text. Do not apply, publish, edit, or otherwise modify the page or its original HTML and ink."]
]);

function normalizeKindleIntent(value) {
  const key = String(value || "").trim().toLowerCase();
  return KINDLE_INTENTS.has(key) ? key : "";
}

function extractNotebookTags(text) {
  const tags = [];
  const seen = new Set();
  for (const match of String(text || "").matchAll(/(^|[\s([{])#([A-Za-z][A-Za-z0-9_-]{1,31})\b/g)) {
    const tag = match[2].toLowerCase();
    if (!seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags.slice(0, 12);
}

function stripNotebookTags(text) {
  return String(text || "").replace(/(^|[\s([{])#([A-Za-z][A-Za-z0-9_-]{1,31})\b/g, "$1").replace(/[ \t]{2,}/g, " ").trim();
}

function formatKindleContext({ intent = "", tags = [], rawTranscription = "", cleanedTranscription = "", source = "" } = {}) {
  const lines = [];
  if (intent && KINDLE_INTENTS.has(intent)) lines.push(`Intent: ${intent}. ${KINDLE_INTENTS.get(intent)}`);
  if (tags.length) lines.push(`Notebook tags: ${tags.map(tag => "#" + tag).join(", ")}.`);
  if (source === "live-page") lines.push("Source: this message was handwritten over the current Live Page.");
  if (rawTranscription && cleanedTranscription && rawTranscription !== cleanedTranscription) {
    lines.push(`OCR uncertainty: raw transcription was ${JSON.stringify(rawTranscription)}; cleaned transcription was ${JSON.stringify(cleanedTranscription)}. If a name, date, dollar amount, or command depends on this difference, say what is uncertain and give the likely alternative.`);
  }
  return lines.length ? `[Kindle note context]\n${lines.join("\n")}\n[/Kindle note context]\n\n` : "";
}

function collectLiveDomAnchors(ink, strokeIds) {
  const wanted = new Set(Array.isArray(strokeIds) ? strokeIds : []);
  const grouped = new Map();
  for (const stroke of ink?.strokes || []) {
    if (!wanted.has(stroke.id)) continue;
    for (const anchor of stroke.anchors || []) {
      const key = JSON.stringify([anchor.selector || "", anchor.tag || "", anchor.text || "", anchor.rect || null]);
      const existing = grouped.get(key);
      if (existing) {
        existing.strokeCount += 1;
        existing.hitCount = Math.max(existing.hitCount || 0, anchor.hitCount || 0);
        existing.centered ||= Boolean(anchor.centered);
      } else if (grouped.size < 12) {
        grouped.set(key, { strokeId: stroke.id, strokeCount: 1, baseRevision: stroke.baseRevision, ...anchor });
      }
    }
  }
  return [...grouped.values()];
}

function formatLiveDomAnchors(anchors) {
  if (!Array.isArray(anchors) || !anchors.length) return "";
  const lines = anchors.map(anchor => {
    const flags = [anchor.centered ? "mark encloses/centers on element" : "stroke touches element", `hits=${anchor.hitCount}`].join(", ");
    const text = anchor.text ? `; text=${JSON.stringify(anchor.text)}` : "";
    const strokes = anchor.strokeCount > 1 ? `${anchor.strokeCount} strokes` : `stroke ${anchor.strokeId}`;
    return `- ${strokes}: selector=${JSON.stringify(anchor.selector)}; element=<${anchor.tag || "unknown"}>${text}; ${flags}; normalizedRect=${JSON.stringify(anchor.rect)}`;
  });
  return `[DOM annotation targets for revision ${anchors[0].baseRevision || "unknown"}]\nThese targets identify what the ink touches or surrounds. Use the ink image to decide whether the gesture means circle, cross-out, underline, arrow, or handwriting. Prefer these selectors and text snippets over guessing by screen position.\n${lines.join("\n")}\n[/DOM annotation targets]\n\n`;
}

function livePageReadableText(html) {
  return String(html || "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<(?:br|\/p|\/div|\/section|\/article|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim()
    .slice(0, 12000);
}

function formatLivePageSnapshot(page, html) {
  if (!page || !html) return "";
  const readable = livePageReadableText(html);
  return `[Current Live Page]\nTitle: ${page.title || "Untitled"}\nRevision: ${page.revision || "unknown"}\nThe annotation was made directly over this page. Treat this snapshot and the DOM targets as available context; do not ask the user to provide the HTML or identify the page again.\n\n${readable}\n[/Current Live Page]\n\n`;
}

function buildMessages({ text, imageDataUrl, history = [], intent = "" }) {
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
    "Use a short-first structure: direct answer first, details second. If handwriting is ambiguous",
    "around a name, date, dollar amount, or instruction, say the uncertainty and the likely alternatives.",
    intent && KINDLE_INTENTS.has(intent) ? KINDLE_INTENTS.get(intent) : "",
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

async function callChat({ endpoint, model, token, text, imageDataUrl, mode, history = [], sessionKey = "kindle-scribe-diary", intent = "" }) {
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: chatHeaders(token, sessionKey),
    body: JSON.stringify({
      model,
      temperature: 0.35,
      max_tokens: 900,
      messages: buildMessages({ text, imageDataUrl, history, intent })
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
            "Do not answer the note and do not add facts. If a name, date, dollar amount, or command is uncertain, preserve the original wording and add bracketed alternatives inline, for example [possibly: ...].",
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
async function callChatStream({ endpoint, model, token, text, imageDataUrl, history = [], sessionKey = "kindle-scribe-diary", intent = "", onToken }) {
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: chatHeaders(token, sessionKey),
    body: JSON.stringify({
      model,
      temperature: 0.35,
      max_tokens: 900,
      stream: true,
      messages: buildMessages({ text, imageDataUrl, history, intent })
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
  const environment = [
    "[Kindle Scribe environment]",
    "You are Hermes, the same agent and personality used in the user's other channels.",
    "The Kindle is only the user's input and display surface. You are still running on this machine with your normal access to its tools, files, services, connected systems, and permissions.",
    "Do real work normally when asked. Do not claim that being on Kindle prevents tool use, file access, publishing HTML, messaging, lookups, or other machine capabilities; report an inability only when the actual attempted capability fails.",
    "The message may have been transcribed from handwriting.",
    "Reply normally and completely; your response will appear on the Kindle.",
    "A Live Page is available when rich HTML would be useful or the user asks for it.",
    "When DOM annotation metadata is present, it identifies the HTML elements marked by the user's ink.",
    "Use your normal capabilities and tools when helpful; no tool or workflow is required.",
    "[/Kindle Scribe environment]"
  ].join("\n");
  let response;
  try {
    response = await fetchWithTimeout(kindleAdapterUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(kindleIngestToken ? { "x-kindle-token": kindleIngestToken } : {})
      },
      body: JSON.stringify({ text: rawText ? text : `${environment}\n\n${text}`, user: kindleUser, chat_id: chatId })
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

function requestOriginOk(req) {
  const origin = String(req.headers.origin || "").trim();
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === String(req.headers.host || "").toLowerCase();
  } catch {
    return false;
  }
}

function fullPageMetadata(fullPage) {
  const { html: _html, ...metadata } = fullPage;
  return metadata;
}

function validLiveRevision(value) {
  return /^sha256:[a-f0-9]{64}$/.test(String(value || ""));
}

function validateLiveTransition(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.version !== 1) {
    throw new Error("Stored Live Page transition is invalid");
  }
  const fromRevision = String(raw.fromRevision || "");
  if (!validLiveRevision(fromRevision)) throw new Error("Stored Live Page transition source is invalid");
  const toPage = livePageStore.validatePrepared(raw.toPage);
  if (toPage.revision === fromRevision) throw new Error("Stored Live Page transition does not change the page");
  return {
    version: 1,
    fromRevision,
    toPage,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString()
  };
}

async function writeLiveTransition(raw) {
  const transition = validateLiveTransition(raw);
  await fs.mkdir(dataDir, { recursive: true });
  liveTransitionSequence += 1;
  const temp = `${liveTransitionFile}.${process.pid}.${liveTransitionSequence}.tmp`;
  let handle;
  try {
    handle = await fs.open(temp, "wx", 0o600);
    await handle.writeFile(JSON.stringify(transition, null, 2), "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temp, liveTransitionFile);
    livePendingTransition = transition;
    return transition;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

async function loadLiveTransition() {
  try {
    livePendingTransition = validateLiveTransition(JSON.parse(await fs.readFile(liveTransitionFile, "utf8")));
  } catch (error) {
    if (error && error.code === "ENOENT") livePendingTransition = null;
    else {
      const detail = error instanceof SyntaxError ? "stored transition is not valid JSON" : error.message;
      throw new Error("Cannot load Live Page transition: " + detail);
    }
  }
}

async function clearLiveTransition() {
  try {
    await fs.unlink(liveTransitionFile);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  livePendingTransition = null;
}

async function finishLiveTransition() {
  if (!livePendingTransition) return livePageStore.metadata();
  const transition = livePendingTransition;
  const currentRevision = livePageStore.metadata().revision;
  const inkRevision = liveInkStore.snapshot().activeRevision;
  if (currentRevision !== transition.fromRevision && currentRevision !== transition.toPage.revision) {
    throw new Error("Live Page transition cannot recover from the current page revision");
  }
  if (inkRevision && inkRevision !== transition.fromRevision && inkRevision !== transition.toPage.revision) {
    throw new Error("Live Page transition cannot recover from the current ink revision");
  }
  await liveJourneyStore.recordPage({ page: fullPageMetadata(transition.toPage), html: transition.toPage.html });
  await livePageStore.commitPrepared(transition.toPage);
  await liveInkStore.rolloverRevision(transition.toPage.revision);
  await clearLiveTransition();
  return livePageStore.metadata();
}

function withLiveState(task) {
  const run = liveStateQueue.then(async () => {
    try {
      await finishLiveTransition();
    } catch (error) {
      error.status = 503;
      throw error;
    }
    return task();
  });
  liveStateQueue = run.catch(() => {});
  return run;
}

function publishLivePage(input, options = {}) {
  return withLiveState(async () => {
    const beforeFullPage = livePageStore.fullSnapshot();
    const beforePage = fullPageMetadata(beforeFullPage);
    const beforeInk = liveInkStore.snapshot();
    if (Object.prototype.hasOwnProperty.call(options, "expectedRevision") && options.expectedRevision !== beforePage.revision) {
      const error = new Error("The Live Page changed; reopen New page before replacing it");
      error.status = 409;
      throw error;
    }
    let nextFullPage;
    try {
      nextFullPage = livePageStore.prepare(input);
    } catch (error) {
      error.status = Number(error.status) || 400;
      throw error;
    }
    await liveJourneyStore.recordPage({ page: beforePage, html: beforeFullPage.html });
    await liveJourneyStore.recordStrokes(beforeInk.strokes, beforePage.revision);

    if (nextFullPage.revision !== beforePage.revision) {
      const transition = await writeLiveTransition({
        version: 1,
        fromRevision: beforePage.revision,
        toPage: nextFullPage,
        createdAt: new Date().toISOString()
      });
      try {
        await liveJourneyStore.recordPage({ page: fullPageMetadata(transition.toPage), html: transition.toPage.html });
      } catch (error) {
        await clearLiveTransition().catch(() => {});
        error.status = 503;
        throw error;
      }
      try {
        await finishLiveTransition();
      } catch (error) {
        error.status = 503;
        throw error;
      }
    }

    if (typeof options.sourceHtml === "string") {
      try {
        await fs.mkdir(dataDir, { recursive: true });
        await fs.writeFile(liveSourceFile, options.sourceHtml, "utf8");
      } catch (error) {
        logSend({ kind: "live-page-source-write", ok: false, error: error.message });
      }
    }
    return livePageStore.metadata();
  });
}

async function handleLivePageInkApi(req, res) {
  if (!requestOriginOk(req)) {
    send(res, 403, JSON.stringify({ ok: false, error: "Cross-origin ink access is not allowed" }));
    return;
  }
  if (req.method === "GET") {
    try {
      const ink = await withLiveState(() => liveInkStore.snapshot());
      const etag = '"' + ink.revision + '"';
      if (req.headers["if-none-match"] === etag) {
        send(res, 304, "", "application/json; charset=utf-8", { etag });
        return;
      }
      send(res, 200, JSON.stringify({ ok: true, ink }), "application/json; charset=utf-8", { etag });
    } catch (error) {
      send(res, 503, JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }
  if (req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req, 2_000_000) || "{}");
      const ink = await withLiveState(async () => {
        const pageRevision = livePageStore.metadata().revision;
        const beforeInk = liveInkStore.snapshot();
        await liveJourneyStore.recordStrokes(beforeInk.strokes, pageRevision);
        const applied = await liveInkStore.applyBatchDetailed(body);
        await liveJourneyStore.recordStrokes(applied.observedStrokes, pageRevision);
        return applied.ink;
      });
      logSend({
        kind: "live-ink-sync",
        operations: Array.isArray(body.ops) ? body.ops.length : 0,
        strokes: ink.strokes.length,
        revision: ink.revision
      });
      send(res, 200, JSON.stringify({ ok: true, ink }), "application/json; charset=utf-8", {
        etag: '"' + ink.revision + '"'
      });
    } catch (error) {
      const status = Number(error.status) || (error.message === "Request too large" ? 413 : (error instanceof SyntaxError ? 400 : 500));
      if (status >= 500) logSend({ kind: "live-ink-sync", ok: false, error: error.message });
      send(res, status, JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }
  send(res, 405, JSON.stringify({ ok: false, error: "Method not allowed" }), "application/json; charset=utf-8", {
    allow: "GET, POST"
  });
}

async function handleLivePageJourneyApi(req, res) {
  if (!requestOriginOk(req)) {
    send(res, 403, JSON.stringify({ ok: false, error: "Cross-origin Journey access is not allowed" }));
    return;
  }
  const url = new URL(req.url, "http://diary.local");
  if (req.method !== "GET") {
    send(res, 405, JSON.stringify({ ok: false, error: "Method not allowed" }), "application/json; charset=utf-8", { allow: "GET" });
    return;
  }
  if (url.pathname === "/api/live-page/journey/content") {
    try {
      const revision = url.searchParams.get("revision") || "";
      const html = await withLiveState(() => liveJourneyStore.content(revision));
      if (html === null) {
        send(res, 404, "Journey revision not found", "text/plain; charset=utf-8");
        return;
      }
      const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
      const etag = `"${revision}:${theme}"`;
      if (req.headers["if-none-match"] === etag) {
        send(res, 304, "", "text/html; charset=utf-8", { etag });
        return;
      }
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        etag
      });
      res.end(renderLivingDocument(html, theme));
    } catch (error) {
      send(res, Number(error.status) || 400, String(error.message || "Journey revision could not be read"), "text/plain; charset=utf-8");
    }
    return;
  }

  try {
    const journey = await withLiveState(() => liveJourneyStore.snapshot());
    const etag = `"${journey.revision}"`;
    if (req.headers["if-none-match"] === etag) {
      send(res, 304, "", "application/json; charset=utf-8", { etag });
      return;
    }
    send(res, 200, JSON.stringify({ ok: true, ...journey }), "application/json; charset=utf-8", { etag });
  } catch (error) {
    send(res, Number(error.status) || 503, JSON.stringify({ ok: false, error: error.message }));
  }
}

async function handleLivePageApi(req, res) {
  const url = new URL(req.url, "http://diary.local");
  if (url.pathname === "/api/live-page/template") {
    if (req.method !== "POST") {
      send(res, 405, JSON.stringify({ ok: false, error: "Method not allowed" }), "application/json; charset=utf-8", { allow: "POST" });
      return;
    }
    try {
      const body = JSON.parse(await readBody(req, 20_000) || "{}");
      if (body.confirm !== "replace") {
        send(res, 400, JSON.stringify({ ok: false, error: "Starting a new page requires explicit confirmation" }), "application/json; charset=utf-8");
        return;
      }
      const input = createLivePageTemplate(body.template);
      const page = await publishLivePage(input, { expectedRevision: body.baseRevision, sourceHtml: input.html });
      logSend({ kind: "live-page-template", template: body.template, revision: page.revision });
      send(res, 201, JSON.stringify({ ok: true, page }), "application/json; charset=utf-8", {
        etag: `"${page.revision}"`
      });
    } catch (error) {
      send(res, Number(error.status) || 400, JSON.stringify({ ok: false, error: error.message }), "application/json; charset=utf-8");
    }
    return;
  }

  if (url.pathname === "/api/live-page/content") {
    if (req.method !== "GET") {
      send(res, 405, "Method not allowed", "text/plain; charset=utf-8", { allow: "GET" });
      return;
    }
    let snapshot;
    try {
      snapshot = await withLiveState(() => ({ page: livePageStore.metadata(), html: livePageStore.document() }));
    } catch (error) {
      send(res, Number(error.status) || 503, String(error.message || "Live Page is unavailable"), "text/plain; charset=utf-8");
      return;
    }
    const page = snapshot.page;
    const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
    const etag = `"${page.revision}:${theme}"`;
    if (req.headers["if-none-match"] === etag) {
      send(res, 304, "", "text/html; charset=utf-8", { etag });
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      etag
    });
    res.end(renderLivingDocument(snapshot.html, theme));
    return;
  }

  if (req.method === "GET") {
    let page;
    try {
      page = await withLiveState(() => livePageStore.metadata());
    } catch (error) {
      const status = Number(error.status) || (error instanceof SyntaxError ? 400 : 503);
      send(res, status, JSON.stringify({ ok: false, error: error.message }));
      return;
    }
    const etag = `"${page.revision}"`;
    if (req.headers["if-none-match"] === etag) {
      send(res, 304, "", "application/json; charset=utf-8", { etag });
      return;
    }
    send(res, 200, JSON.stringify({ ok: true, page }), "application/json; charset=utf-8", { etag });
    return;
  }

  if (req.method === "PUT") {
    if (!livePageWriteOk(req)) {
      send(res, 403, JSON.stringify({ ok: false, error: "Live Page publishing is local-only" }));
      return;
    }
    try {
      const body = JSON.parse(await readBody(req, 1_000_000) || "{}");
      const input = body.page && typeof body.page === "object" ? body.page : body;
      const page = await publishLivePage(input);
      logSend({ kind: "live-page-publish", revision: page.revision, title: page.title });
      send(res, 200, JSON.stringify({ ok: true, page }), "application/json; charset=utf-8", {
        etag: `"${page.revision}"`
      });
    } catch (error) {
      const status = Number(error.status) || (error instanceof SyntaxError ? 400 : 503);
      send(res, status, JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }

  send(res, 405, JSON.stringify({ ok: false, error: "Method not allowed" }), "application/json; charset=utf-8", {
    allow: "GET, PUT"
  });
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
  let liveInkClaimId = "";
  let liveDomAnchors = [];
  let livePageContext = "";
  try {
    const body = JSON.parse(await readBody(req));
    const target = "hermes";
    const hasInk = typeof body.imageDataUrl === "string" && body.imageDataUrl.startsWith("data:image/");
    const imageBytes = hasInk ? imageBytesFromDataUrl(body.imageDataUrl) : 0;
    const isLivePageSource = body.source === "live-page";
    const intent = normalizeKindleIntent(body.intent);
    const livePageRevision = typeof body.livePageRevision === "string" && /^sha256:[a-f0-9]{64}$/.test(body.livePageRevision)
      ? body.livePageRevision : "";
    const liveInkSendId = typeof body.liveInkSendId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(body.liveInkSendId)
      ? body.liveInkSendId : "";
    const liveInkStrokeIds = Array.isArray(body.liveInkStrokeIds) ? body.liveInkStrokeIds : [];
    if (isLivePageSource && target === "hermes" && liveInkSendId && liveInkStrokeIds.length) {
      try {
        const claimed = await withLiveState(async () => {
          const claim = await liveInkStore.claimSend({ sendId: liveInkSendId, strokeIds: liveInkStrokeIds, resend: body.resend === true });
          return {
            claim,
            anchors: claim.status === "claimed" ? collectLiveDomAnchors(liveInkStore.snapshot(), liveInkStrokeIds) : [],
            page: livePageStore.metadata(),
            html: livePageStore.document()
          };
        });
        const claim = claimed.claim;
        if (claim.status === "complete") {
          send(res, 200, JSON.stringify(claim.result));
          return;
        }
        liveDomAnchors = claimed.anchors;
        livePageContext = formatLivePageSnapshot(claimed.page, claimed.html);
        liveInkClaimId = liveInkSendId;
      } catch (error) {
        send(res, Number(error.status) || 409, JSON.stringify({ ok: false, error: error.message }));
        return;
      }
    }

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

    function commitSession(replyText, transcription = "", rawTranscription = "", tags = []) {
      if (isNewSession) sessions.unshift(session);
      const now = new Date().toISOString();
      const inkRefPromise = hasInk ? writeInkFile(session.id, body.imageDataUrl) : Promise.resolve("");
      return inkRefPromise.then(async (inkRef) => {
        session.messages.push({
          role: "user",
          text: body.text || "",
          transcription,
          rawTranscription,
          tags,
          intent,
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
      let cleanedTranscription = "";
      if (hasInk) {
        try {
          const vis = await callChat({
            endpoint: defaultVisionEndpoint,
            model: defaultVisionModel,
            token: "",
            text: isLivePageSource
              ? "This ink was written over a Live Page. Transcribe all handwriting exactly, then briefly describe any arrows, circles, underlines, or connectors and their approximate position. Output only the transcription and mark descriptions."
              : "Transcribe the handwriting exactly. Output only the transcription. Preserve proper names; Bearden is a likely firm surname and must not be split into 'Bear den'.",
            imageDataUrl: body.imageDataUrl,
            mode: "vision"
          });
          const visionOutput = (vis.text || "").trim();
          const quotedTranscription = visionOutput.match(/^You wrote:\s*["“]([^"”\n]+)["”]/i);
          rawTranscription = (quotedTranscription?.[1] || visionOutput).trim();
          let cleaned = rawTranscription;
          if (rawTranscription && !isLivePageSource) {
            try { cleaned = await cleanHandwritingTranscription(rawTranscription); } catch {}
          }
          cleanedTranscription = cleaned;
          noteText = (noteText ? noteText + "\n\n" : "") + cleaned;
        } catch {
          /* fall through with whatever text we have */
        }
      }
      const tags = extractNotebookTags(noteText);
      noteText = stripNotebookTags(noteText);
      noteText = formatKindleContext({
        intent,
        tags,
        rawTranscription,
        cleanedTranscription,
        source: isLivePageSource ? "live-page" : ""
      }) + livePageContext + formatLiveDomAnchors(liveDomAnchors) + noteText;

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
      // Snapshot every Kindle request, including older notebook clients. Tools
      // may publish while Hermes is answering even when the client did not
      // identify itself as the Live Page.
      const beforeLiveRevision = await withLiveState(() => livePageStore.metadata().revision);
      try {
        result = await callKindleChannel({
          text: noteText,
          chatId: session.channelThreadId,
          source: isLivePageSource ? "live-page" : "",
          baseRevision: livePageRevision,
          currentRevision: beforeLiveRevision
        });
      } catch (error) {
        if (liveInkClaimId) await withLiveState(() => liveInkStore.releaseSend(liveInkClaimId)).catch(() => {});
        logSend({ kind: "error", target: "hermes", channel: true, error: error.message });
        if (wantStream) {
          res.write(RS + JSON.stringify({ error: error.message }));
          res.end();
        } else {
          send(res, 502, JSON.stringify({ ok: false, error: error.message }));
        }
        return;
      }
      const afterLivePage = await withLiveState(() => livePageStore.metadata());
      const afterLiveRevision = afterLivePage ? afterLivePage.revision : "";
      const pageChanged = !!beforeLiveRevision && !!afterLiveRevision && beforeLiveRevision !== afterLiveRevision;
      result.text = reconcileLivePageReply(result.text, pageChanged, afterLivePage);

      if (!result.text || !result.text.trim()) {
        if (liveInkClaimId) await withLiveState(() => liveInkStore.releaseSend(liveInkClaimId)).catch(() => {});
        const emsg = "The firm agent returned an empty reply. Tap Send to try again.";
        if (wantStream) { res.write(RS + JSON.stringify({ error: emsg })); res.end(); }
        else send(res, 502, JSON.stringify({ ok: false, error: emsg }));
        return;
      }

      if (!session.title) {
        const wrote = result.text.match(/^You wrote:\s*"([^"\n]{1,60})/i);
        session.title = (body.text || (wrote && wrote[1]) || "Handwritten entry").slice(0, 60);
      }
      const hermesResponse = {
        ok: true,
        text: result.text,
        sessionId: session.id,
        hermesThreadId: session.channelThreadId,
        title: session.title,
        tags,
        intent,
        pageChanged,
        page: pageChanged ? afterLivePage : undefined
      };
      if (liveInkClaimId) await withLiveState(() => liveInkStore.completeSend(liveInkClaimId, hermesResponse));
      await commitSession(result.text, noteText, rawTranscription, tags);
      logSend({
        kind: "send", target: "hermes", channel: true, sessionId: session.id,
        textChars: noteText.length, imageBytes, responseChars: result.text.length,
        durationMs: Date.now() - startedCh, intent, tags, pageChanged
      });
      if (wantStream) {
        // The platform adapter returns a completed turn. Deliver it in bounded
        // writes so old Kindle WebKit receives the entire response reliably,
        // without adding theatrical delays that look like model streaming.
        const chunks = result.text.match(/[\s\S]{1,320}/g) || [];
        for (const chunk of chunks) res.write(chunk);
        res.write(RS + JSON.stringify({ title: session.title, pageChanged, page: pageChanged ? afterLivePage : undefined }));
        res.end();
      } else {
        send(res, 200, JSON.stringify(hermesResponse));
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
          intent,
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

      const tags = extractNotebookTags(body.text || "");
      await commitSession(result.text, "", "", tags);
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
        durationMs: Date.now() - startedStream,
        intent,
        tags
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
      sessionKey: "kindle-scribe-diary-" + session.id,
      intent
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
    const tags = extractNotebookTags(body.text || "");
    session.messages.push({
      role: "user",
      text: body.text || "",
      tags,
      intent,
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
      durationMs: Date.now() - startedAt,
      intent,
      tags
    });
    send(res, 200, JSON.stringify({
      ok: true,
      ...result,
      sessionId: session.id,
      title: session.title,
      tags,
      intent
    }));
  } catch (error) {
    if (liveInkClaimId) await withLiveState(() => liveInkStore.releaseSend(liveInkClaimId)).catch(() => {});
    logSend({ kind: "error", error: error.message });
    send(res, error.statusCode || 500, JSON.stringify({ ok: false, error: error.message }));
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
  let name;
  try { name = path.basename(decodeURIComponent(url.pathname).replace(/^\/img\//, "")); }
  catch { send(res, 400, "Malformed URL", "text/plain; charset=utf-8"); return; }
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
  let rel;
  try { rel = decodeURIComponent(url.pathname); }
  catch { send(res, 400, "Malformed URL", "text/plain; charset=utf-8"); return; }
  if (isRemoteHost(req) && /^\/remote\/[^/]+(?:\/live\/?)?$/.test(rel)) {
    if (!remoteKeyOk(req)) {
      send(res, 401, "Unauthorized", "text/plain; charset=utf-8");
      return;
    }
    rel = "/live.html";
  }
  if (rel === "/" || rel === "/index.html") rel = "/live.html";
  if (rel === "/live" || rel === "/live/") rel = "/live.html";
  const file = path.normalize(path.join(publicDir, rel));
  const relative = path.relative(publicDir, file);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
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
  const localProtectedPath = (requestPath.startsWith("/api/") && requestPath !== "/api/config") || requestPath.startsWith("/img/");
  const localLivePublish = requestPath === "/api/live-page" && req.method === "PUT" && livePageWriteOk(req);
  if (((isRemoteHost(req) && protectedRemotePath) || (!isRemoteHost(req) && localProtectedPath)) && !authOk(req) && !localLivePublish) {
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
  if (requestPath === "/api/live-page/ink") {
    await handleLivePageInkApi(req, res);
    return;
  }
  if (requestPath === "/api/live-page/journey" || requestPath === "/api/live-page/journey/content") {
    await handleLivePageJourneyApi(req, res);
    return;
  }
  if (requestPath === "/api/live-page" || requestPath === "/api/live-page/content" || requestPath === "/api/live-page/template") {
    await handleLivePageApi(req, res);
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
await livePageStore.init();
await liveInkStore.init();
await liveJourneyStore.init();
await loadLiveTransition();
await finishLiveTransition();
await liveJourneyStore.recordPage({ page: livePageStore.metadata(), html: livePageStore.document() });
await liveJourneyStore.recordStrokes(liveInkStore.snapshot().strokes, livePageStore.metadata().revision);
{
  const startupRollover = await liveInkStore.rolloverRevision(livePageStore.metadata().revision);
  await liveJourneyStore.recordStrokes(startupRollover.clearedStrokes, livePageStore.metadata().revision);
}
await liveJourneyStore.verifyContents();
liveWriteToken = await loadLiveWriteToken();

server.listen(port, host, () => {
  const address = server.address();
  const listeningPort = address && typeof address === "object" ? address.port : port;
  console.log(`Hermes Agents Guide to the Galaxy listening on http://${host}:${listeningPort}`);
  console.log(`Hermes endpoint: ${hermesEndpoint} (${hermesToken ? "token loaded" : "no token"})`);
  console.log("Live Page publisher ready");
});
