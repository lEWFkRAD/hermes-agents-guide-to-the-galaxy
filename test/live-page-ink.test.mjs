import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LiveInkStore } from "../lib/live-page-ink.mjs";

const pageRevision = "sha256:" + "a".repeat(64);

function makeStroke(id, clientId = "device-a", offset = 0) {
  return {
    id,
    clientId,
    baseRevision: pageRevision,
    createdAt: 1000 + offset,
    surfaceWidth: 600,
    surfaceHeight: 720,
    sent: false,
    anchors: [{
      selector: '[data-live-region="client-total"]',
      tag: "section",
      text: "Client total",
      rect: { x: 0.1, y: 0.15, width: 0.4, height: 0.2 },
      hitCount: 4,
      centered: true
    }],
    points: [
      { x: 0.1 + offset / 1000, y: 0.2 },
      { x: 0.2 + offset / 1000, y: 0.3 }
    ]
  };
}

async function withStore(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-live-ink-"));
  try {
    const store = new LiveInkStore(directory);
    await store.init();
    await run(store, directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("persists shared ink and sent state across restarts", async () => {
  await withStore(async (store, directory) => {
    const added = await store.applyBatch({
      clientId: "device-a",
      ops: [{ id: "op-add-a", type: "add", stroke: makeStroke("stroke-a") }]
    });
    assert.equal(added.revision, "ink:1");
    assert.equal(added.strokes.length, 1);
    assert.equal(added.strokes[0].sent, false);

    await store.applyBatch({
      clientId: "device-a",
      ops: [{ id: "op-sent-a", type: "mark-sent", ids: ["stroke-a"] }]
    });

    const reopened = new LiveInkStore(directory);
    const snapshot = await reopened.init();
    assert.equal(snapshot.revision, "ink:2");
    assert.equal(snapshot.strokes.length, 1);
    assert.equal(snapshot.strokes[0].sent, true);
    assert.deepEqual(snapshot.strokes[0].points, makeStroke("stroke-a").points);
    assert.deepEqual(snapshot.strokes[0].anchors, makeStroke("stroke-a").anchors);
  });
});

test("deduplicates retries and rejects reused operation or stroke ids", async () => {
  await withStore(async store => {
    const payload = {
      clientId: "device-a",
      ops: [{ id: "op-add-a", type: "add", stroke: makeStroke("stroke-a") }]
    };
    const first = await store.applyBatch(payload);
    const replay = await store.applyBatch(payload);
    assert.equal(replay.revision, first.revision);
    assert.equal(replay.strokes.length, 1);

    await assert.rejects(
      store.applyBatch({
        clientId: "device-a",
        ops: [{ id: "op-add-a", type: "add", stroke: makeStroke("stroke-b") }]
      }),
      error => error.status === 409
    );
    await assert.rejects(
      store.applyBatch({
        clientId: "device-a",
        ops: [{ id: "op-add-b", type: "add", stroke: makeStroke("stroke-a", "device-a", 5) }]
      }),
      error => error.status === 409
    );
    await store.applyBatch({
      clientId: "device-a",
      ops: [{ id: "op-sent-a", type: "mark-sent", ids: ["stroke-a"] }]
    });
    const staleRetry = await store.applyBatch({
      clientId: "device-a",
      ops: [{
        id: "op-stale-add-a",
        type: "add",
        stroke: makeStroke("stroke-a")
      }]
    });
    assert.equal(staleRetry.strokes[0].sent, true);
    assert.equal(store.snapshot().strokes.length, 1);
  });
});

test("tombstones prevent delayed adds from resurrecting cleared ink", async () => {
  await withStore(async store => {
    await store.applyBatch({
      clientId: "device-a",
      ops: [{ id: "op-delete-a", type: "delete", ids: ["stroke-a"] }]
    });
    const delayed = await store.applyBatch({
      clientId: "device-a",
      ops: [{ id: "op-add-a", type: "add", stroke: makeStroke("stroke-a") }]
    });
    assert.equal(delayed.strokes.length, 0);

    const other = await store.applyBatch({
      clientId: "device-b",
      ops: [{ id: "op-add-b", type: "add", stroke: makeStroke("stroke-b", "device-b") }]
    });
    assert.deepEqual(other.strokes.map(stroke => stroke.id), ["stroke-b"]);
  });
});

test("same-revision tombstones outlive operation retention and reset on revision rollover", async () => {
  await withStore(async (store, directory) => {
    const nextRevision = "sha256:" + "b".repeat(64);
    await store.rolloverRevision(pageRevision);
    await store.applyBatch({
      clientId: "device-a",
      ops: [{ id: "op-delete-target", type: "delete", ids: ["stroke-target"] }]
    });

    const laterIds = Array.from({ length: 5001 }, (_, index) => "later-stroke-" + index);
    const laterDeletes = [];
    for (let index = 0; index < laterIds.length; index += 500) {
      laterDeletes.push({
        id: "op-delete-later-" + index,
        type: "delete",
        ids: laterIds.slice(index, index + 500)
      });
    }
    await store.applyBatch({ clientId: "device-a", ops: laterDeletes });

    const delayed = await store.applyBatch({
      clientId: "device-a",
      ops: [{ id: "op-delayed-target", type: "add", stroke: makeStroke("stroke-target") }]
    });
    assert.equal(delayed.strokes.some(item => item.id === "stroke-target"), false);

    await store.rolloverRevision(nextRevision);
    const persistedAfterRollover = JSON.parse(await fs.readFile(path.join(directory, "live-page-ink.json"), "utf8"));
    assert.deepEqual(persistedAfterRollover.deleted, []);

    const currentStroke = makeStroke("stroke-target");
    currentStroke.baseRevision = nextRevision;
    const current = await store.applyBatch({
      clientId: "device-a",
      ops: [{ id: "op-current-target", type: "add", stroke: currentStroke }]
    });
    assert.deepEqual(current.strokes.map(item => item.id), ["stroke-target"]);
  });
});

test("serializes concurrent device additions without losing strokes", async () => {
  await withStore(async store => {
    await Promise.all(Array.from({ length: 30 }, (_, index) => store.applyBatch({
      clientId: "device-" + index,
      ops: [{
        id: "op-add-" + index,
        type: "add",
        stroke: makeStroke("stroke-" + index, "device-" + index, index)
      }]
    })));
    const snapshot = store.snapshot();
    assert.equal(snapshot.strokes.length, 30);
    assert.equal(new Set(snapshot.strokes.map(stroke => stroke.id)).size, 30);
    assert.equal(snapshot.revision, "ink:30");
  });
});

test("rejects an invalid batch without partially changing stored ink", async () => {
  await withStore(async store => {
    await store.applyBatch({
      clientId: "device-a",
      ops: [{ id: "op-add-a", type: "add", stroke: makeStroke("stroke-a") }]
    });
    const before = store.snapshot();
    const invalid = makeStroke("stroke-b");
    invalid.points[0].x = 2;
    await assert.rejects(store.applyBatch({
      clientId: "device-a",
      ops: [
        { id: "op-add-b", type: "add", stroke: makeStroke("stroke-b") },
        { id: "op-add-c", type: "add", stroke: invalid }
      ]
    }));
    assert.deepEqual(store.snapshot(), before);
  });
});

test("does not silently replace corrupt persisted ink with an empty page", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-live-ink-corrupt-"));
  try {
    await fs.writeFile(path.join(directory, "live-page-ink.json"), "{broken", "utf8");
    const store = new LiveInkStore(directory);
    await assert.rejects(store.init(), /Cannot load live ink/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("claims a synced annotation once and replays its completed result", async () => {
  await withStore(async store => {
    await store.applyBatch({
      clientId: "device-a",
      ops: [{ id: "op-add-claim", type: "add", stroke: makeStroke("stroke-claim") }]
    });
    const firstClaim = await store.claimSend({
      sendId: "send-a",
      strokeIds: ["stroke-claim"]
    });
    assert.equal(firstClaim.status, "claimed");
    await assert.rejects(
      store.claimSend({ sendId: "send-b", strokeIds: ["stroke-claim"] }),
      error => error.status === 409
    );
    const response = {
      ok: true,
      text: "Finished once",
      sessionId: "session-a",
      hermesThreadId: "thread-a",
      title: "Annotation"
    };
    const completed = await store.completeSend("send-a", response);
    assert.equal(completed.snapshot.strokes[0].sent, true);
    assert.deepEqual(completed.result, response);

    const replay = await store.claimSend({
      sendId: "send-new-retry",
      strokeIds: ["stroke-claim"]
    });
    assert.equal(replay.status, "complete");
    assert.deepEqual(replay.result, response);

    const reopened = new LiveInkStore(store.file.replace(/live-page-ink\.json$/, ""));
    await reopened.init();
    const persistedReplay = await reopened.claimSend({
      sendId: "send-after-restart",
      strokeIds: ["stroke-claim"]
    });
    assert.equal(persistedReplay.status, "complete");
    assert.deepEqual(persistedReplay.result, response);
  });
});
