import fs from "node:fs/promises";
import path from "node:path";

const MAX_FRAMES = 120;
const MAX_STROKES_PER_FRAME = 500;
const MAX_TOTAL_POINTS = 100000;
const MAX_POINTS_PER_STROKE = 1200;
const MAX_POINT_T = 600000;
const MAX_ANCHORS_PER_STROKE = 6;
const MAX_HTML_BYTES = 750000;
const REVISION_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function cleanRevision(value) {
  const revision = String(value || "");
  if (!REVISION_PATTERN.test(revision)) fail("Journey revision is invalid");
  return revision;
}

function cleanText(value, max) {
  return String(value == null ? "" : value).replace(/\u0000/g, "").slice(0, max);
}

function cleanPoint(raw) {
  const x = Number(raw && raw.x);
  const y = Number(raw && raw.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
    fail("Journey stroke point is invalid");
  }
  const point = {
    x: Math.round(x * 1000000) / 1000000,
    y: Math.round(y * 1000000) / 1000000
  };
  if (raw && raw.t !== undefined) {
    const t = Number(raw.t);
    if (!Number.isFinite(t) || t < 0 || t > MAX_POINT_T) fail("Journey stroke point timing is invalid");
    point.t = Math.round(t);
  }
  return point;
}

function cleanAnchorUnit(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) fail("Journey DOM anchor rectangle is invalid");
  return Math.round(number * 1000000) / 1000000;
}

function cleanAnchors(value) {
  const source = value === undefined ? [] : value;
  if (!Array.isArray(source) || source.length > MAX_ANCHORS_PER_STROKE) fail("Journey DOM anchors are invalid");
  return source.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("Journey DOM anchor is invalid");
    const selector = cleanText(raw.selector || "", 400).replace(/[\u0000-\u001f]/g, "");
    if (!selector) fail("Journey DOM anchor selector is required");
    const tag = String(raw.tag || "").toLowerCase();
    if (tag && !/^[a-z0-9_-]{1,32}$/.test(tag)) fail("Journey DOM anchor tag is invalid");
    const rect = raw.rect && typeof raw.rect === "object" && !Array.isArray(raw.rect) ? raw.rect : {};
    return {
      selector,
      tag,
      text: cleanText(raw.text || "", 240).replace(/\s+/g, " ").trim(),
      rect: {
        x: cleanAnchorUnit(rect.x),
        y: cleanAnchorUnit(rect.y),
        width: cleanAnchorUnit(rect.width),
        height: cleanAnchorUnit(rect.height)
      },
      hitCount: Math.max(1, Math.min(1000, Math.round(Number(raw.hitCount) || 1))),
      centered: Boolean(raw.centered)
    };
  });
}

function cleanStroke(raw, fallbackRevision = "", fallbackOrder = 0) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("Journey stroke is invalid");
  const id = String(raw.id || "");
  if (!ID_PATTERN.test(id)) fail("Journey stroke id is invalid");
  const clientId = String(raw.clientId || "journey");
  if (!ID_PATTERN.test(clientId)) fail("Journey stroke client id is invalid");
  const baseRevision = cleanRevision(raw.baseRevision || fallbackRevision);
  if (!Array.isArray(raw.points) || !raw.points.length) fail("Journey stroke points are required");
  if (raw.points.length > MAX_POINTS_PER_STROKE) fail("Journey stroke has too many points", 413);
  const createdAt = Number(raw.createdAt || 0);
  const surfaceWidth = Number(raw.surfaceWidth || 0);
  const surfaceHeight = Number(raw.surfaceHeight || 0);
  const order = Number(raw.order || fallbackOrder || 0);
  return {
    id,
    clientId,
    baseRevision,
    createdAt: Number.isFinite(createdAt) && createdAt >= 0 ? Math.round(createdAt) : 0,
    surfaceWidth: Number.isFinite(surfaceWidth) && surfaceWidth >= 0 ? Math.round(surfaceWidth) : 0,
    surfaceHeight: Number.isFinite(surfaceHeight) && surfaceHeight >= 0 ? Math.round(surfaceHeight) : 0,
    order: Number.isFinite(order) && order > 0 ? Math.round(order) : Math.max(1, fallbackOrder),
    sent: Boolean(raw.sent),
    anchors: cleanAnchors(raw.anchors),
    points: raw.points.map(cleanPoint)
  };
}

function cleanPage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("Journey page is invalid");
  return {
    version: Number(raw.version) || 2,
    title: cleanText(raw.title || "HTML", 240) || "HTML",
    revision: cleanRevision(raw.revision),
    updatedAt: cleanText(raw.updatedAt || "", 80) || null
  };
}

function defaultState() {
  return { version: 1, sequence: 0, updatedAt: null, truncated: false, frames: [] };
}

function normalizeState(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.version !== 1 || !Array.isArray(raw.frames)) {
    fail("Stored Journey state is invalid", 500);
  }
  const state = defaultState();
  state.sequence = Number.isSafeInteger(raw.sequence) && raw.sequence >= 0 ? raw.sequence : 0;
  state.updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : null;
  state.truncated = Boolean(raw.truncated);
  const revisions = new Set();
  const strokeIds = new Set();
  state.frames = raw.frames.map(frame => {
    const page = cleanPage(frame && frame.page);
    if (revisions.has(page.revision)) fail("Stored Journey has duplicate revisions", 500);
    revisions.add(page.revision);
    const source = Array.isArray(frame.strokes) ? frame.strokes : [];
    if (source.length > MAX_STROKES_PER_FRAME) fail("Stored Journey frame has too many strokes", 500);
    const strokes = source.map((stroke, index) => {
      const clean = cleanStroke(stroke, page.revision, index + 1);
      if (strokeIds.has(clean.id)) fail("Stored Journey has duplicate stroke ids", 500);
      strokeIds.add(clean.id);
      return clean;
    });
    strokes.sort((left, right) => left.order - right.order || left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    return { page, inkTrimmed: Boolean(frame && frame.inkTrimmed), strokes };
  });
  return state;
}

function contentName(revision) {
  return revision.slice("sha256:".length) + ".html";
}

function pointCount(state) {
  return state.frames.reduce((total, frame) => total + frame.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0), 0);
}

export class LivePageJourneyStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, "live-page-journey.json");
    this.contentDir = path.join(dataDir, "live-page-history");
    this.state = defaultState();
    this.writeQueue = Promise.resolve();
    this.tempSequence = 0;
  }

  async init() {
    try {
      this.state = normalizeState(JSON.parse(await fs.readFile(this.file, "utf8")));
    } catch (error) {
      if (error && error.code === "ENOENT") this.state = defaultState();
      else {
        const detail = error instanceof SyntaxError ? "stored Journey state is not valid JSON" : error.message;
        throw new Error("Cannot load Live Page Journey: " + detail);
      }
    }
    return this.snapshot();
  }

  enqueue(task) {
    const run = this.writeQueue.then(task);
    this.writeQueue = run.catch(() => {});
    return run;
  }

  snapshot() {
    return {
      version: 1,
      revision: "journey:" + this.state.sequence,
      updatedAt: this.state.updatedAt,
      truncated: Boolean(this.state.truncated),
      frames: clone(this.state.frames)
    };
  }

  async content(rawRevision) {
    const revision = cleanRevision(rawRevision);
    if (!this.state.frames.some(frame => frame.page.revision === revision)) return null;
    try {
      return await fs.readFile(path.join(this.contentDir, contentName(revision)), "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  recordPage(input) {
    return this.enqueue(() => this.recordPageInner(input));
  }

  async recordPageInner(input) {
    const page = cleanPage(input && input.page);
    const html = String(input && input.html || "");
    if (!html.trim()) fail("Journey HTML is empty");
    if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) fail("Journey HTML exceeds 750 KB", 413);
    await this.writeContent(page.revision, html);
    if (this.state.frames.some(frame => frame.page.revision === page.revision)) return this.snapshot();
    const next = clone(this.state);
    next.frames.push({ page, inkTrimmed: false, strokes: [] });
    const removed = this.trim(next);
    next.sequence += 1;
    next.updatedAt = new Date().toISOString();
    await this.save(next);
    this.state = next;
    await this.removeContent(removed);
    return this.snapshot();
  }

  recordStrokes(rawStrokes, fallbackRevision) {
    return this.enqueue(() => this.recordStrokesInner(rawStrokes, fallbackRevision));
  }

  async recordStrokesInner(rawStrokes, fallbackRevision) {
    const source = Array.isArray(rawStrokes) ? rawStrokes : [];
    if (!source.length) return this.snapshot();
    const fallback = fallbackRevision ? cleanRevision(fallbackRevision) : "";
    const next = clone(this.state);
    const knownIds = new Set(next.frames.flatMap(frame => frame.strokes.map(stroke => stroke.id)));
    let changed = false;
    for (const raw of source) {
      const revision = raw && raw.baseRevision ? cleanRevision(raw.baseRevision) : fallback;
      if (!revision) continue;
      const frame = next.frames.find(item => item.page.revision === revision);
      if (!frame || knownIds.has(String(raw && raw.id || ""))) continue;
      const nextOrder = frame.strokes.reduce((highest, stroke) => Math.max(highest, stroke.order || 0), 0) + 1;
      const stroke = cleanStroke(raw, revision, nextOrder);
      frame.strokes.push(stroke);
      while (frame.strokes.length > MAX_STROKES_PER_FRAME) {
        frame.strokes.shift();
        frame.inkTrimmed = true;
        next.truncated = true;
      }
      knownIds.add(stroke.id);
      changed = true;
    }
    if (!changed) return this.snapshot();
    for (const frame of next.frames) {
      frame.strokes.sort((left, right) => left.order - right.order || left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    }
    const removed = this.trim(next);
    next.sequence += 1;
    next.updatedAt = new Date().toISOString();
    await this.save(next);
    this.state = next;
    await this.removeContent(removed);
    return this.snapshot();
  }

  trim(state) {
    const removed = [];
    while (state.frames.length > MAX_FRAMES || (state.frames.length > 1 && pointCount(state) > MAX_TOTAL_POINTS)) {
      removed.push(state.frames.shift().page.revision);
      state.truncated = true;
    }
    if (state.frames.length === 1) {
      const frame = state.frames[0];
      while (frame.strokes.length && pointCount(state) > MAX_TOTAL_POINTS) {
        frame.strokes.shift();
        frame.inkTrimmed = true;
        state.truncated = true;
      }
    }
    return removed;
  }

  async writeContent(revision, html) {
    await fs.mkdir(this.contentDir, { recursive: true });
    const file = path.join(this.contentDir, contentName(revision));
    let handle;
    try {
      handle = await fs.open(file, "wx", 0o600);
      await handle.writeFile(html, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (!error || error.code !== "EEXIST") {
        await fs.unlink(file).catch(() => {});
        throw error;
      }
      const existing = await fs.readFile(file, "utf8");
      if (existing !== html) fail("Journey revision content changed", 409);
    }
  }

  async verifyContents() {
    for (const frame of this.state.frames) {
      const file = path.join(this.contentDir, contentName(frame.page.revision));
      let stat;
      try {
        stat = await fs.stat(file);
      } catch (error) {
        if (error && error.code === "ENOENT") throw new Error("Journey content is missing for " + frame.page.revision);
        throw error;
      }
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_HTML_BYTES) {
        throw new Error("Journey content is invalid for " + frame.page.revision);
      }
    }
  }

  async removeContent(revisions) {
    for (const revision of revisions) {
      await fs.unlink(path.join(this.contentDir, contentName(revision))).catch(() => {});
    }
  }

  async save(state) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    this.tempSequence += 1;
    const temp = this.file + "." + process.pid + "." + this.tempSequence + ".tmp";
    let handle;
    try {
      handle = await fs.open(temp, "wx", 0o600);
      await handle.writeFile(JSON.stringify(state, null, 2), "utf8");
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
