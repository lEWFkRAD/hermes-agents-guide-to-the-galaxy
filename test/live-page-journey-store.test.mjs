import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LivePageJourneyStore } from "../lib/live-page-journey.mjs";
import { LiveInkStore } from "../lib/live-page-ink.mjs";

const revisionA = "sha256:" + "a".repeat(64);
const revisionB = "sha256:" + "b".repeat(64);

function page(revision, title) {
  return { version: 2, title, revision, updatedAt: "2026-07-10T20:00:00.000Z" };
}

function stroke(id, revision, createdAt = 1000) {
  return {
    id,
    clientId: "device-a",
    baseRevision: revision,
    createdAt,
    surfaceWidth: 600,
    surfaceHeight: 800,
    sent: false,
    anchors: [{ selector: "h1:nth-of-type(1)", tag: "h1", text: "One", rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 }, hitCount: 3, centered: true }],
    points: [{ x: 0.1, y: 0.2, t: 0 }, { x: 0.2, y: 0.3, t: 42 }]
  };
}

test("Journey persists immutable page content and deleted stroke geometry", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "live-journey-store-"));
  try {
    const journey = new LivePageJourneyStore(dataDir);
    await journey.init();
    await journey.recordPage({ page: page(revisionA, "First"), html: "<!doctype html><title>First</title><h1>One</h1>" });
    await journey.recordStrokes([stroke("stroke-a", revisionA)], revisionA);
    await journey.recordStrokes([stroke("stroke-a", revisionA)], revisionA);
    await journey.recordPage({ page: page(revisionB, "Second"), html: "<!doctype html><title>Second</title><h1>Two</h1>" });

    const snapshot = journey.snapshot();
    assert.equal(snapshot.frames.length, 2);
    assert.equal(snapshot.frames[0].strokes.length, 1);
    assert.equal(snapshot.frames[0].strokes[0].points[1].t, 42);
    assert.equal(snapshot.frames[0].strokes[0].anchors[0].selector, "h1:nth-of-type(1)");
    assert.match(await journey.content(revisionA), /<h1>One<\/h1>/);

    const reopened = new LivePageJourneyStore(dataDir);
    await reopened.init();
    assert.deepEqual(reopened.snapshot(), snapshot);
    assert.match(await reopened.content(revisionB), /<h1>Two<\/h1>/);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("Journey keeps the newest 500 strokes on one revision and persists truncation", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "live-journey-retention-"));
  try {
    const journey = new LivePageJourneyStore(dataDir);
    await journey.init();
    await journey.recordPage({
      page: page(revisionA, "Unchanged"),
      html: "<!doctype html><title>Unchanged</title><h1>One revision</h1>"
    });

    const strokes = Array.from({ length: 501 }, (_, index) =>
      stroke("stroke-" + String(index + 1).padStart(3, "0"), revisionA, 1000 + index)
    );
    const snapshot = await journey.recordStrokes(strokes, revisionA);

    assert.equal(snapshot.frames.length, 1);
    assert.equal(snapshot.frames[0].strokes.length, 500);
    assert.equal(snapshot.frames[0].strokes.some(item => item.id === "stroke-001"), false);
    assert.equal(snapshot.frames[0].strokes.at(-1).id, "stroke-501");
    assert.equal(snapshot.frames[0].inkTrimmed, true);
    assert.equal(snapshot.truncated, true);

    const reopened = new LivePageJourneyStore(dataDir);
    const persisted = await reopened.init();
    assert.deepEqual(persisted, snapshot);
    assert.equal(persisted.frames[0].strokes.at(-1).id, "stroke-501");
    assert.equal(persisted.frames[0].inkTrimmed, true);
    assert.equal(persisted.truncated, true);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("ink rollover clears only old-revision strokes and preserves send claims", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "live-journey-ink-"));
  try {
    const ink = new LiveInkStore(dataDir);
    await ink.init();
    await ink.rolloverRevision(revisionA);
    const added = await ink.applyBatchDetailed({
      clientId: "device-a",
      ops: [{ id: "op-add-a", type: "add", stroke: stroke("stroke-a", revisionA) }]
    });
    assert.equal(added.ink.strokes.length, 1);
    assert.equal(added.observedStrokes[0].points[1].t, 42);
    await ink.claimSend({ sendId: "send-a", strokeIds: ["stroke-a"] });

    const rolled = await ink.rolloverRevision(revisionB);
    assert.equal(rolled.ink.activeRevision, revisionB);
    assert.deepEqual(rolled.ink.strokes, []);
    assert.equal(rolled.clearedStrokes[0].id, "stroke-a");
    const completed = await ink.completeSend("send-a", { ok: true, text: "done" });
    assert.equal(completed.result.text, "done");

    const stale = await ink.applyBatchDetailed({
      clientId: "device-a",
      ops: [{ id: "op-stale", type: "add", stroke: stroke("stroke-stale", revisionA, 2000) }]
    });
    assert.deepEqual(stale.ink.strokes, []);
    assert.equal(stale.observedStrokes[0].id, "stroke-stale");

    const current = await ink.applyBatch({
      clientId: "device-a",
      ops: [{ id: "op-current", type: "add", stroke: stroke("stroke-current", revisionB, 3000) }]
    });
    assert.deepEqual(current.strokes.map(item => item.id), ["stroke-current"]);
    const noOp = await ink.rolloverRevision(revisionB);
    assert.deepEqual(noOp.ink.strokes.map(item => item.id), ["stroke-current"]);
    assert.deepEqual(noOp.clearedStrokes, []);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
