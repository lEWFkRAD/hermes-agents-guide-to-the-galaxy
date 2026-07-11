import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_STROKES = 500;
const MAX_POINTS_PER_STROKE = 1200;
const MAX_TOTAL_POINTS = 100000;
const MAX_OPS = 200;
const MAX_IDS_PER_OP = 500;
const MAX_ACTIVE_TOMBSTONES = 100000;
const MAX_RECENT_OPS = 5000;
const MAX_SENDS = 100;
const SEND_CLAIM_TTL_MS = 10 * 60 * 1000;
const MAX_POINT_T = 600000;
const MAX_ANCHORS_PER_STROKE = 6;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const PAGE_REVISION_PATTERN = /^sha256:[a-f0-9]{64}$/;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function cleanId(value, label) {
  const text = String(value || "");
  if (!ID_PATTERN.test(text)) fail(label + " is invalid");
  return text;
}

function cleanPageRevision(value) {
  const text = String(value || "");
  if (!text) return "";
  if (!PAGE_REVISION_PATTERN.test(text)) fail("stroke baseRevision is invalid");
  return text;
}

function cleanCoordinate(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) fail("stroke coordinates must be finite numbers between 0 and 1");
  return Math.round(number * 1000000) / 1000000;
}

function cleanDimension(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number < 0 || number > 20000) fail("stroke surface dimensions are invalid");
  return Math.round(number);
}

function cleanCreatedAt(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number < 0 || number > 9007199254740991) fail("stroke createdAt is invalid");
  return Math.round(number);
}

function normalizePoints(value) {
  if (!Array.isArray(value) || value.length < 1) fail("stroke points are required");
  if (value.length > MAX_POINTS_PER_STROKE) fail("stroke has too many points", 413);
  return value.map(point => {
    if (!point || typeof point !== "object" || Array.isArray(point)) fail("stroke point is invalid");
    const normalized = { x: cleanCoordinate(point.x), y: cleanCoordinate(point.y) };
    if (point.t !== undefined) {
      const timing = Number(point.t);
      if (!Number.isFinite(timing) || timing < 0 || timing > MAX_POINT_T) fail("stroke point timing is invalid");
      normalized.t = Math.round(timing);
    }
    return normalized;
  });
}

function cleanAnchorUnit(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) fail("DOM anchor rectangle is invalid");
  return Math.round(number * 1000000) / 1000000;
}

function normalizeAnchors(value) {
  const source = value === undefined ? [] : value;
  if (!Array.isArray(source) || source.length > MAX_ANCHORS_PER_STROKE) fail("DOM anchors are invalid");
  return source.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("DOM anchor is invalid");
    const selector = String(raw.selector || "").replace(/[\u0000-\u001f]/g, "").slice(0, 400);
    if (!selector) fail("DOM anchor selector is required");
    const tag = String(raw.tag || "").toLowerCase();
    if (tag && !/^[a-z0-9_-]{1,32}$/.test(tag)) fail("DOM anchor tag is invalid");
    const rect = raw.rect && typeof raw.rect === "object" && !Array.isArray(raw.rect) ? raw.rect : {};
    return {
      selector,
      tag,
      text: String(raw.text || "").replace(/\s+/g, " ").trim().slice(0, 240),
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

function normalizeStroke(value, batchClientId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("stroke is invalid");
  const clientId = cleanId(value.clientId || batchClientId, "stroke clientId");
  return {
    id: cleanId(value.id, "stroke id"),
    clientId,
    baseRevision: cleanPageRevision(value.baseRevision),
    createdAt: cleanCreatedAt(value.createdAt),
    surfaceWidth: cleanDimension(value.surfaceWidth),
    surfaceHeight: cleanDimension(value.surfaceHeight),
    sent: Boolean(value.sent),
    anchors: normalizeAnchors(value.anchors),
    points: normalizePoints(value.points)
  };
}

function uniqueIds(value) {
  if (!Array.isArray(value) || value.length < 1) fail("operation ids are required");
  if (value.length > MAX_IDS_PER_OP) fail("operation has too many ids", 413);
  const ids = [];
  const seen = new Set();
  for (const raw of value) {
    const id = cleanId(raw, "stroke id");
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  ids.sort();
  return ids;
}

function normalizeOperation(value, batchClientId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("ink operation is invalid");
  const operation = {
    id: cleanId(value.id, "operation id"),
    type: String(value.type || "")
  };
  if (operation.type === "add") {
    operation.stroke = normalizeStroke(value.stroke, batchClientId);
  } else if (operation.type === "delete" || operation.type === "mark-sent") {
    operation.ids = uniqueIds(value.ids);
  } else {
    fail("unknown ink operation");
  }
  return operation;
}

function operationDigest(operation) {
  return crypto.createHash("sha256").update(JSON.stringify(operation)).digest("hex");
}

function sameStroke(left, right) {
  const comparable = stroke => ({
    id: stroke.id,
    clientId: stroke.clientId,
    baseRevision: stroke.baseRevision,
    createdAt: stroke.createdAt,
    surfaceWidth: stroke.surfaceWidth,
    surfaceHeight: stroke.surfaceHeight,
    anchors: stroke.anchors,
    points: stroke.points
  });
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

function sameIds(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function idsOverlap(left, right) {
  const values = new Set(left);
  return right.some(id => values.has(id));
}

function normalizeSendResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("send result is invalid", 500);
  return {
    ok: true,
    text: String(value.text || "").slice(0, 500000),
    sessionId: String(value.sessionId || "").slice(0, 160),
    hermesThreadId: String(value.hermesThreadId || "").slice(0, 160),
    title: String(value.title || "").slice(0, 200)
  };
}

function defaultState() {
  return {
    version: 1,
    sequence: 0,
    nextOrder: 0,
    activeRevision: "",
    updatedAt: null,
    strokes: [],
    deleted: [],
    recentOps: [],
    sends: []
  };
}

function normalizeStoredState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("stored ink state is invalid", 500);
  if (value.version !== 1) fail("stored ink state version is unsupported", 500);
  const state = defaultState();
  state.sequence = Number.isSafeInteger(value.sequence) && value.sequence >= 0 ? value.sequence : 0;
  state.nextOrder = Number.isSafeInteger(value.nextOrder) && value.nextOrder >= 0 ? value.nextOrder : 0;
  state.activeRevision = cleanPageRevision(value.activeRevision || "");
  state.updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : null;
  if (!Array.isArray(value.strokes) || !Array.isArray(value.deleted) || !Array.isArray(value.recentOps)) {
    fail("stored ink state is incomplete", 500);
  }
  const strokeIds = new Set();
  let totalPoints = 0;
  state.strokes = value.strokes.map(raw => {
    const stroke = normalizeStroke(raw, raw && raw.clientId);
    if (strokeIds.has(stroke.id)) fail("stored ink contains duplicate strokes", 500);
    strokeIds.add(stroke.id);
    totalPoints += stroke.points.length;
    const order = Number.isSafeInteger(raw.order) && raw.order > 0 ? raw.order : state.nextOrder + 1;
    state.nextOrder = Math.max(state.nextOrder, order);
    return { ...stroke, order };
  });
  if (state.strokes.length > MAX_STROKES || totalPoints > MAX_TOTAL_POINTS) fail("stored ink exceeds limits", 500);
  const deletedIds = new Set();
  if (value.deleted.length > MAX_ACTIVE_TOMBSTONES) fail("stored ink has too many active-revision tombstones", 500);
  state.deleted = value.deleted.map(raw => {
    const id = cleanId(raw && raw.id, "deleted stroke id");
    if (deletedIds.has(id)) fail("stored ink contains duplicate tombstones", 500);
    if (strokeIds.has(id)) fail("stored ink contains an active deleted stroke", 500);
    deletedIds.add(id);
    return { id, deletedAt: typeof raw.deletedAt === "string" ? raw.deletedAt : "" };
  });
  const operationIds = new Set();
  state.recentOps = value.recentOps.slice(-MAX_RECENT_OPS).map(raw => {
    const id = cleanId(raw && raw.id, "stored operation id");
    const digest = String(raw && raw.digest || "");
    if (!/^[a-f0-9]{64}$/.test(digest) || operationIds.has(id)) fail("stored operation record is invalid", 500);
    operationIds.add(id);
    return { id, digest };
  });
  const storedSends = Array.isArray(value.sends) ? value.sends : [];
  const sendIds = new Set();
  state.sends = storedSends.slice(-MAX_SENDS * 2).map(raw => {
    const id = cleanId(raw && raw.id, "stored send id");
    if (sendIds.has(id)) fail("stored ink contains duplicate send ids", 500);
    sendIds.add(id);
    const strokeIds = uniqueIds(raw && raw.strokeIds);
    const status = raw && (raw.status === "pending" || raw.status === "complete") ? raw.status : "";
    if (!status) fail("stored send status is invalid", 500);
    const startedAt = Number(raw.startedAt);
    const completedAt = Number(raw.completedAt || 0);
    if (!Number.isFinite(startedAt) || startedAt < 0 || !Number.isFinite(completedAt) || completedAt < 0) fail("stored send timestamps are invalid", 500);
    return {
      id,
      strokeIds,
      status,
      startedAt,
      completedAt,
      result: status === "complete" ? normalizeSendResult(raw.result) : null
    };
  });

  return state;
}

function snapshotFor(state) {
  return {
    version: 1,
    revision: "ink:" + state.sequence,
    activeRevision: state.activeRevision,
    updatedAt: state.updatedAt,
    strokes: clone(state.strokes)
  };
}

export class LiveInkStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, "live-page-ink.json");
    this.state = defaultState();
    this.writeQueue = Promise.resolve();
    this.tempSequence = 0;
  }

  async init() {
    try {
      const stored = JSON.parse(await fs.readFile(this.file, "utf8"));
      this.state = normalizeStoredState(stored);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        this.state = defaultState();
      } else {
        const detail = error instanceof SyntaxError ? "stored ink state is not valid JSON" : error.message;
        throw new Error("Cannot load live ink: " + detail);
      }
    }
    return this.snapshot();
  }

  snapshot() {
    return snapshotFor(this.state);
  }

  enqueue(task) {
    const run = this.writeQueue.then(task);
    this.writeQueue = run.catch(() => {});
    return run;
  }

  applyBatch(input) {
    return this.enqueue(() => this.applyBatchInner(input, false));
  }

  applyBatchDetailed(input) {
    return this.enqueue(() => this.applyBatchInner(input, true));
  }

  async applyBatchInner(input, detailed = false) {
    if (!input || typeof input !== "object" || Array.isArray(input)) fail("ink operation payload must be an object");
    const clientId = cleanId(input.clientId, "clientId");
    if (!Array.isArray(input.ops) || input.ops.length < 1) fail("ink operations are required");
    if (input.ops.length > MAX_OPS) fail("too many ink operations", 413);
    const operations = input.ops.map(value => normalizeOperation(value, clientId));
    const observedStrokes = operations.filter(operation => operation.type === "add").map(operation => clone(operation.stroke));
    const next = clone(this.state);
    const recent = new Map(next.recentOps.map(item => [item.id, item.digest]));
    const deleted = new Map(next.deleted.map(item => [item.id, item]));
    const strokes = new Map(next.strokes.map(item => [item.id, item]));
    const accepted = [];
    const now = new Date().toISOString();

    for (const operation of operations) {
      const digest = operationDigest(operation);
      if (recent.has(operation.id)) {
        if (recent.get(operation.id) !== digest) fail("operation id was reused with different content", 409);
        continue;
      }
      if (operation.type === "add") {
        const stroke = operation.stroke;
        if (next.activeRevision && stroke.baseRevision !== next.activeRevision) {
          strokes.delete(stroke.id);
          if (!deleted.has(stroke.id)) deleted.set(stroke.id, { id: stroke.id, deletedAt: now });
        } else if (!deleted.has(stroke.id)) {
          const existing = strokes.get(stroke.id);
          if (existing && !sameStroke(existing, stroke)) fail("stroke id was reused with different content", 409);
          if (existing) {
            if (stroke.sent && !existing.sent) strokes.set(stroke.id, { ...existing, sent: true });
          } else {
            next.nextOrder += 1;
            strokes.set(stroke.id, { ...stroke, order: next.nextOrder });
          }
        }
      } else if (operation.type === "delete") {
        for (const id of operation.ids) {
          strokes.delete(id);
          if (!deleted.has(id)) deleted.set(id, { id, deletedAt: now });
        }
      } else if (operation.type === "mark-sent") {
        for (const id of operation.ids) {
          const stroke = strokes.get(id);
          if (stroke && !stroke.sent) strokes.set(id, { ...stroke, sent: true });
        }
      }
      recent.set(operation.id, digest);
      accepted.push({ id: operation.id, digest });
    }

    if (!accepted.length) {
      const ink = this.snapshot();
      return detailed ? { ink, observedStrokes } : ink;
    }
    next.strokes = [...strokes.values()].sort((left, right) => left.order - right.order);
    if (next.strokes.length > MAX_STROKES) fail("too many active strokes", 413);
    const totalPoints = next.strokes.reduce((total, stroke) => total + stroke.points.length, 0);
    if (totalPoints > MAX_TOTAL_POINTS) fail("too many active ink points", 413);
    if (deleted.size > MAX_ACTIVE_TOMBSTONES) fail("too many deleted annotations on this HTML revision", 413);
    next.deleted = [...deleted.values()];
    next.recentOps = [...next.recentOps, ...accepted].slice(-MAX_RECENT_OPS);
    next.sequence += accepted.length;
    next.updatedAt = now;
    await this.save(next);
    this.state = next;
    const ink = this.snapshot();
    return detailed ? { ink, observedStrokes } : ink;
  }

  rolloverRevision(rawRevision) {
    return this.enqueue(() => this.rolloverRevisionInner(rawRevision));
  }

  async rolloverRevisionInner(rawRevision) {
    const revision = cleanPageRevision(rawRevision);
    if (!revision) fail("active page revision is required");
    const next = clone(this.state);
    const now = new Date().toISOString();
    const clearedStrokes = [];
    const kept = [];

    for (const rawStroke of next.strokes) {
      const stroke = !next.activeRevision && !rawStroke.baseRevision
        ? { ...rawStroke, baseRevision: revision }
        : rawStroke;
      if (stroke.baseRevision === revision) {
        kept.push(stroke);
      } else {
        clearedStrokes.push(clone(stroke));
      }
    }

    const changed = next.activeRevision !== revision || clearedStrokes.length > 0 || kept.some((stroke, index) => stroke !== next.strokes[index]);
    if (!changed) return { ink: this.snapshot(), clearedStrokes: [] };
    next.activeRevision = revision;
    next.strokes = kept;
    next.deleted = [];
    next.sequence += 1;
    next.updatedAt = now;
    await this.save(next);
    this.state = next;
    return { ink: this.snapshot(), clearedStrokes };
  }

  claimSend(input) {
    return this.enqueue(() => this.claimSendInner(input));
  }

  async claimSendInner(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) fail("send claim payload must be an object");
    const sendId = cleanId(input.sendId, "send id");
    const strokeIds = uniqueIds(input.strokeIds);
    const resend = input.resend === true;
    const next = clone(this.state);
    const now = Date.now();
    next.sends = (next.sends || []).filter(record => record.status === "complete" || now - record.startedAt < SEND_CLAIM_TTL_MS);
    const sameSend = next.sends.find(record => record.id === sendId);
    if (sameSend) {
      if (!sameIds(sameSend.strokeIds, strokeIds)) fail("send id was reused with different strokes", 409);
      if (sameSend.status === "complete") return { status: "complete", result: clone(sameSend.result) };
      fail("these annotations are already being sent", 409);
    }
    const completed = next.sends.find(record => record.status === "complete" && sameIds(record.strokeIds, strokeIds));
    if (completed && !resend) return { status: "complete", result: clone(completed.result) };
    const pending = next.sends.find(record => record.status === "pending" && idsOverlap(record.strokeIds, strokeIds));
    if (pending) fail("these annotations are already being sent", 409);
    const active = new Map(next.strokes.map(stroke => [stroke.id, stroke]));
    for (const id of strokeIds) {
      const stroke = active.get(id);
      if (!stroke) fail("annotation is no longer available", 409);
      if (stroke.sent && !resend) fail("annotation was already sent", 409);
    }
    next.sends.push({ id: sendId, strokeIds, status: "pending", startedAt: now, completedAt: 0, result: null });
    const open = next.sends.filter(record => record.status === "pending");
    const done = next.sends.filter(record => record.status === "complete").slice(-MAX_SENDS);
    next.sends = [...open, ...done];
    await this.save(next);
    this.state = next;
    return { status: "claimed" };
  }

  completeSend(sendId, result) {
    return this.enqueue(() => this.completeSendInner(sendId, result));
  }

  async completeSendInner(rawSendId, rawResult) {
    const sendId = cleanId(rawSendId, "send id");
    const result = normalizeSendResult(rawResult);
    const next = clone(this.state);
    const index = (next.sends || []).findIndex(record => record.id === sendId);
    if (index < 0) fail("send claim was not found", 409);
    const record = next.sends[index];
    if (record.status === "complete") return { snapshot: this.snapshot(), result: clone(record.result) };
    const ids = new Set(record.strokeIds);
    next.strokes = next.strokes.map(stroke => ids.has(stroke.id) ? { ...stroke, sent: true } : stroke);
    next.sends[index] = { ...record, status: "complete", completedAt: Date.now(), result };
    const open = next.sends.filter(item => item.status === "pending");
    const done = next.sends.filter(item => item.status === "complete").slice(-MAX_SENDS);
    next.sends = [...open, ...done];
    next.sequence += 1;
    next.updatedAt = new Date().toISOString();
    await this.save(next);
    this.state = next;
    return { snapshot: this.snapshot(), result: clone(result) };
  }

  releaseSend(sendId) {
    return this.enqueue(() => this.releaseSendInner(sendId));
  }

  async releaseSendInner(rawSendId) {
    const sendId = cleanId(rawSendId, "send id");
    const next = clone(this.state);
    const existing = (next.sends || []).find(record => record.id === sendId);
    if (!existing || existing.status === "complete") return false;
    next.sends = next.sends.filter(record => record.id !== sendId);
    await this.save(next);
    this.state = next;
    return true;
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
