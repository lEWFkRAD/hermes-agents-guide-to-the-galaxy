import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceStore, atomicWriteFile } from "../lib/workspaces.mjs";

async function withStore(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-diary-workspace-"));
  try {
    const store = new WorkspaceStore(root);
    await store.init();
    await run(store);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("atomic index writes sync before rename and clean up after failure", async () => {
  const calls = [];
  const failure = new Error("simulated disk failure");
  const operations = {
    async open(temp, flags) {
      calls.push(["open", temp, flags]);
      return {
        async writeFile() { calls.push(["write"]); },
        async sync() { calls.push(["sync"]); throw failure; },
        async close() { calls.push(["close"]); }
      };
    },
    async rename() { calls.push(["rename"]); },
    async unlink(temp) { calls.push(["unlink", temp]); }
  };

  await assert.rejects(atomicWriteFile("index.json", "[]", operations), failure);
  assert.deepEqual(calls.map(([name]) => name), ["open", "write", "sync", "close", "unlink"]);
  assert.equal(calls[0][2], "wx");
  assert.equal(calls.some(([name]) => name === "rename"), false);
});

test("persists a revisioned artifact, vector annotation, and proposal", async () => {
  await withStore(async store => {
    const workspace = await store.create({ title: "Design review", mode: "design" });
    const artifact = await store.addArtifact(workspace.id, {
      type: "html",
      name: "dashboard.html",
      content: "<main><h1>Dashboard</h1></main>"
    });
    const annotation = await store.addAnnotation(workspace.id, {
      artifactId: artifact.id,
      strokes: [{ id: "s1", width: 3, points: [{ x: 0.1, y: 0.2, t: 1 }] }],
      anchor: { kind: "viewport", x: 0, y: 0, width: 1, height: 1 },
      transcription: "Make this heading clearer",
      intent: "edit"
    });
    const proposal = await store.createProposal(workspace.id, {
      artifactId: artifact.id,
      annotationIds: [annotation.id],
      instruction: "Propose a clearer title"
    });
    const completed = await store.completeProposal(workspace.id, proposal.id, {
      summary: "Rename the title",
      changes: [{ kind: "html-edit", target: "h1", description: "Use a specific title" }]
    });

    assert.equal(completed.status, "proposed");
    assert.equal(completed.changes.length, 1);
    assert.match(artifact.revision, /^sha256:[a-f0-9]{64}$/);
    assert.equal(store.get(workspace.id).annotations[0].artifactRevision, artifact.revision);
    assert.equal(store.list()[0].proposalCount, 1);
  });
});

test("sanitizes active HTML content before storage", async () => {
  await withStore(async store => {
    const workspace = await store.create({ title: "Unsafe import" });
    const artifact = await store.addArtifact(workspace.id, {
      type: "html",
      name: "unsafe.html",
      content: '<h1 onclick="alert(1)">Hello</h1><script>alert(2)</script><a href="javascript:alert(3)">x</a>'
    });
    const stored = (await store.readArtifact(artifact.id)).buffer.toString("utf8");
    assert.doesNotMatch(stored, /<script|onclick|javascript:/i);
    assert.match(stored, /Hello/);
  });
});
