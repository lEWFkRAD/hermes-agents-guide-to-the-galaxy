import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_HTML_BYTES = 750_000;
const CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'";
const INTERACTIVE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'";

const TEMPLATE_NAMES = Object.freeze({
  blank: "Blank page",
  brainstorm: "Brainstorm",
  flow: "Flow",
  grid: "Grid"
});

function templateShapes(template) {
  if (template === "brainstorm") {
    return `<main class="board mindMap" data-live-region="brainstorm">
      <i class="link linkOne"></i><i class="link linkTwo"></i><i class="link linkThree"></i><i class="link linkFour"></i>
      <div class="node nodeCenter" data-live-region="center"></div>
      <div class="node nodeOne" data-live-region="idea-1"></div>
      <div class="node nodeTwo" data-live-region="idea-2"></div>
      <div class="node nodeThree" data-live-region="idea-3"></div>
      <div class="node nodeFour" data-live-region="idea-4"></div>
    </main>`;
  }
  if (template === "flow") {
    return `<main class="board flow" data-live-region="flow">
      <i class="flowLine"></i>
      <div class="flowBox flowOne" data-live-region="step-1"></div>
      <div class="flowBox flowTwo" data-live-region="step-2"></div>
      <div class="flowBox flowThree" data-live-region="step-3"></div>
    </main>`;
  }
  if (template === "grid") {
    return `<main class="board grid" data-live-region="grid">
      <div data-live-region="space-1"></div><div data-live-region="space-2"></div>
      <div data-live-region="space-3"></div><div data-live-region="space-4"></div>
    </main>`;
  }
  return `<main class="board blank" data-live-region="page"></main>`;
}

export function createLivePageTemplate(template = "blank") {
  const id = String(template || "blank").toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(TEMPLATE_NAMES, id)) {
    throw new Error("Unknown Live Page template");
  }
  const title = TEMPLATE_NAMES[id];
  return {
    title,
    html: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <style>
      :root { --live-paper: #fbfaf4; --live-ink: #111; --live-line: #aaa395; --live-soft: #eee9dc; }
      * { box-sizing: border-box; }
      html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
      body { background: var(--live-paper); color: var(--live-ink); font-family: Georgia, "Times New Roman", serif; }
      .board { position: relative; width: 100%; height: 100vh; min-height: 100%; overflow: hidden; }
      .node, .flowBox, .grid > div { position: absolute; border: 2px solid var(--live-line); background: var(--live-paper); }
      .node { width: 16%; height: 16%; min-width: 72px; min-height: 72px; border-radius: 50%; }
      .nodeCenter { left: 42%; top: 42%; border-color: var(--live-ink); }
      .nodeOne { left: 10%; top: 10%; }
      .nodeTwo { right: 10%; top: 10%; }
      .nodeThree { left: 10%; bottom: 10%; }
      .nodeFour { right: 10%; bottom: 10%; }
      .link { position: absolute; left: 50%; top: 50%; width: 42%; border-top: 2px solid var(--live-line); transform-origin: 0 50%; }
      .linkOne { transform: rotate(-140deg); }
      .linkTwo { transform: rotate(-40deg); }
      .linkThree { transform: rotate(140deg); }
      .linkFour { transform: rotate(40deg); }
      .flowLine { position: absolute; left: 12%; right: 12%; top: 50%; border-top: 2px solid var(--live-line); }
      .flowBox { top: 37%; width: 22%; height: 26%; border-radius: 12px; }
      .flowOne { left: 6%; }
      .flowTwo { left: 39%; border-color: var(--live-ink); }
      .flowThree { right: 6%; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4%; padding: 6%; }
      .grid > div { position: static; min-width: 0; min-height: 0; }
      @media (max-width: 560px) {
        .node { width: 19%; height: 13%; min-width: 58px; min-height: 58px; }
        .nodeCenter { left: 40.5%; top: 43.5%; }
        .flowBox { width: 25%; }
        .flowOne { left: 4%; }
        .flowTwo { left: 37.5%; }
        .flowThree { right: 4%; }
      }
    </style>
  </head>
  <body>${templateShapes(id)}</body>
</html>`
  };
}

export function renderLivingDocument(source, theme = "light") {
  const dark = theme === "dark";
  const palette = dark
    ? { paper: "#15140f", ink: "#e9e7e0", line: "#625d52", soft: "#23211a" }
    : { paper: "#fbfaf4", ink: "#111", line: "#aaa395", soft: "#eee9dc" };
  const bridge = `<style id="live-viewer-theme">:root{--live-paper:${palette.paper}!important;--live-ink:${palette.ink}!important;--live-line:${palette.line}!important;--live-soft:${palette.soft}!important;color-scheme:${dark ? "dark" : "light"};height:100%!important;overflow:auto!important}html{height:100%!important;overflow:auto!important}body{height:auto!important;min-height:100%!important;overflow:visible!important;background:var(--live-paper)!important;color:var(--live-ink)!important}</style>`;
  const html = String(source || "");
  if (/<\/head\s*>/i.test(html)) return html.replace(/<\/head\s*>/i, `${bridge}</head>`);
  return `${bridge}${html}`;
}

const DEFAULT_HTML = createLivePageTemplate("blank").html;

function cleanText(value, max = 240) {
  return String(value == null ? "" : value).replace(/\u0000/g, "").slice(0, max);
}

function safeTitle(html, explicitTitle = "") {
  if (explicitTitle) return cleanText(explicitTitle.replace(/<[^>]*>/g, ""), 240) || "Living Page";
  const match = String(html || "").match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  return cleanText((match?.[1] || "Living Page").replace(/<[^>]*>/g, "").trim(), 240) || "Living Page";
}

function sanitizeCss(source) {
  return String(source || "")
    .replace(/@import\s+[^;]+;?/gi, "")
    .replace(/url\s*\([^)]*\)/gi, "none")
    .replace(/expression\s*\([^)]*\)/gi, "")
    .replace(/(?:behavior|-moz-binding)\s*:[^;]+;?/gi, "");
}

function sanitizeUrlAttributes(html) {
  return html.replace(/\s(href|src|action|formaction)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (full, rawName, doubleQuoted, singleQuoted, bare) => {
      const name = rawName.toLowerCase();
      const value = String(doubleQuoted ?? singleQuoted ?? bare ?? "").trim();
      if (name === "src" && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(value)) {
        return ` src="${value}"`;
      }
      if (name === "href" && /^#[A-Za-z0-9_.:-]*$/.test(value)) return ` href="${value}"`;
      return "";
    });
}

export function sanitizeLivingHtml(source, { interactive = false } = {}) {
  let html = String(source == null ? "" : source).replace(/\u0000/g, "");
  if (!html.trim()) throw new Error("Living HTML is empty");
  if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) throw new Error("Living HTML exceeds 750 KB");

  if (!interactive) {
    html = html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
      .replace(/<\/?form\b[^>]*>/gi, "")
      .replace(/<(?:input|textarea|select|option|button)\b[^>]*>[\s\S]*?<\/(?:textarea|select|option|button)\s*>/gi, "")
      .replace(/<(?:input|textarea|select|option|button)\b[^>]*\/?\s*>/gi, "")
      .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  }

  html = html
    .replace(/<(?:iframe|object|embed|frame|frameset)\b[^>]*>[\s\S]*?<\/(?:iframe|object|embed|frame|frameset)\s*>/gi, "")
    .replace(/<(?:iframe|object|embed|frame|frameset)\b[^>]*\/?\s*>/gi, "")
    .replace(/<link\b[^>]*>/gi, "")
    .replace(/<base\b[^>]*>/gi, "")
    .replace(/<meta\b[^>]*http-equiv\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>/gi, "")
    .replace(/<meta\b[^>]*name\s*=\s*(?:"referrer"|'referrer'|referrer)[^>]*>/gi, "");

  html = sanitizeUrlAttributes(html);
  html = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi,
    (_full, css) => `<style>${sanitizeCss(css)}</style>`);
  html = html.replace(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
    (_full, doubleQuoted, singleQuoted) => ` style="${sanitizeCss(doubleQuoted ?? singleQuoted ?? "").replace(/"/g, "&quot;")}"`);

  const guard = `<meta http-equiv="Content-Security-Policy" content="${interactive ? INTERACTIVE_CSP : CSP}"><meta name="referrer" content="no-referrer">`;
  if (/<html\b/i.test(html)) {
    if (/<head\b[^>]*>/i.test(html)) {
      html = html.replace(/<head\b([^>]*)>/i, `<head$1>${guard}`);
    } else {
      html = html.replace(/<html\b([^>]*)>/i, `<html$1><head>${guard}</head>`);
    }
    return html;
  }

  return `<!doctype html><html lang="en"><head>${guard}<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Living Page</title><style>html,body{margin:0;min-height:100%;}body{background:#fbfaf4;color:#111;font-family:Georgia,"Times New Roman",serif;}</style></head><body>${html}</body></html>`;
}

export function normalizeLivingPage(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Living Page publish payload must be a JSON object");
  }
  const rawHtml = typeof input.html === "string" ? input.html : "";
  const interactive = input.interactive === true;
  const html = sanitizeLivingHtml(rawHtml, { interactive });
  const content = { version: interactive ? 3 : 2, title: safeTitle(rawHtml, input.title), html };
  if (interactive) content.interactive = true;
  return content;
}

function revisionFor(content) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(content)).digest("hex")}`;
}

function withMetadata(content, updatedAt = null) {
  return { ...content, revision: revisionFor(content), updatedAt };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class LivePageStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, "live-page.json");
    this.page = withMetadata(normalizeLivingPage({ html: DEFAULT_HTML }), null);
    this.tempSequence = 0;
  }

  async init() {
    try {
      const stored = JSON.parse(await fs.readFile(this.file, "utf8"));
      this.page = withMetadata(normalizeLivingPage(stored), cleanText(stored.updatedAt, 80) || null);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        this.page = withMetadata(normalizeLivingPage({ html: DEFAULT_HTML }), null);
      } else {
        const detail = error instanceof SyntaxError ? "stored Live Page is not valid JSON" : error.message;
        throw new Error("Cannot load Live Page: " + detail);
      }
    }
    return this.metadata();
  }

  metadata() {
    const { html: _html, ...metadata } = this.page;
    return clone(metadata);
  }

  document() {
    return this.page.html;
  }

  fullSnapshot() {
    return clone(this.page);
  }

  prepare(input) {
    const content = normalizeLivingPage(input);
    const revision = revisionFor(content);
    if (revision === this.page.revision) return this.fullSnapshot();
    return { ...content, revision, updatedAt: new Date().toISOString() };
  }

  validatePrepared(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Prepared Live Page is invalid");
    const content = normalizeLivingPage({ title: raw.title, html: raw.html, interactive: raw.interactive === true });
    const revision = revisionFor(content);
    if (raw.revision !== revision) throw new Error("Prepared Live Page revision does not match its content");
    return { ...content, revision, updatedAt: cleanText(raw.updatedAt, 80) || null };
  }

  async commitPrepared(raw) {
    const next = this.validatePrepared(raw);
    if (next.revision === this.page.revision && next.updatedAt === this.page.updatedAt) return this.metadata();
    await this.save(next);
    this.page = next;
    return this.metadata();
  }

  async replace(input) {
    return this.commitPrepared(this.prepare(input));
  }

  async save(page = this.page) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    this.tempSequence += 1;
    const temp = `${this.file}.${process.pid}.${this.tempSequence}.tmp`;
    let handle;
    try {
      handle = await fs.open(temp, "wx", 0o600);
      await handle.writeFile(JSON.stringify(page, null, 2), "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temp, this.file);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temp).catch(() => {});
      throw error;
    }
  }
}
