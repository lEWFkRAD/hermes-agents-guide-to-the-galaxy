import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  LivePageStore,
  createLivePageTemplate,
  renderLivingDocument,
  sanitizeLivingHtml
} from "../lib/live-page.mjs";

async function withStore(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-live-page-"));
  try {
    const store = new LivePageStore(root);
    await store.init();
    await run(store, root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function livingHtml(text = "First version") {
  return `<!doctype html><html><head><title>Working Thought</title><style>body{background:#fff;color:#111}</style></head><body><main><h1>${text}</h1></main></body></html>`;
}

test("creates one default living HTML document and exposes metadata separately", async () => {
  await withStore(async store => {
    const metadata = store.metadata();
    assert.equal(metadata.version, 2);
    assert.equal(metadata.title, "Blank page");
    assert.equal(metadata.updatedAt, null);
    assert.equal(Object.hasOwn(metadata, "html"), false);
    assert.match(metadata.revision, /^sha256:[a-f0-9]{64}$/);
    assert.match(store.document(), /data-live-region="page"/);
  });
});

test("creates simple drawable templates and rejects unknown template names", () => {
  const blank = createLivePageTemplate("blank");
  const brainstorm = createLivePageTemplate("brainstorm");
  const flow = createLivePageTemplate("flow");
  const grid = createLivePageTemplate("grid");

  assert.equal(blank.title, "Blank page");
  assert.match(brainstorm.html, /data-live-region="idea-4"/);
  assert.match(flow.html, /data-live-region="step-3"/);
  assert.match(grid.html, /data-live-region="space-4"/);
  assert.throws(() => createLivePageTemplate("invoice"), /Unknown Live Page template/);
});

test("injects the selected viewer theme without changing stored HTML", () => {
  const source = createLivePageTemplate("brainstorm").html;
  const dark = renderLivingDocument(source, "dark");
  const light = renderLivingDocument(source, "light");

  assert.match(dark, /--live-paper:#15140f!important/);
  assert.match(dark, /color-scheme:dark/);
  assert.match(light, /--live-paper:#fbfaf4!important/);
  assert.doesNotMatch(source, /live-viewer-theme/);
});

test("persists evolving HTML and keeps the revision stable until the document changes", async () => {
  await withStore(async (store, root) => {
    const first = await store.replace({ html: livingHtml() });
    const identical = await store.replace({ html: livingHtml() });
    const changed = await store.replace({ html: livingHtml("Second version") });

    assert.equal(identical.revision, first.revision);
    assert.equal(identical.updatedAt, first.updatedAt);
    assert.notEqual(changed.revision, first.revision);

    const reopened = new LivePageStore(root);
    await reopened.init();
    assert.equal(reopened.metadata().revision, changed.revision);
    assert.match(reopened.document(), /Second version/);
  });
});

test("sanitizes active content and external requests while preserving expressive HTML and CSS", () => {
  const hostile = `<!doctype html><html><head><title>Safe idea</title>
    <link rel="stylesheet" href="https://example.com/x.css">
    <style>@import url(https://example.com/x.css); .card{background:url(https://example.com/x.png);color:#111}</style>
    </head><body onload="steal()"><h1 style="color:red;background:url(https://example.com/y.png)">Keep me</h1>
    <script>alert(1)</script><iframe src="https://example.com">bad</iframe>
    <form action="https://example.com"><input value="secret"><button>Send</button></form>
    <a href="javascript:alert(2)">Link text</a></body></html>`;
  const safe = sanitizeLivingHtml(hostile);

  assert.match(safe, /Keep me/);
  assert.match(safe, /Link text/);
  assert.match(safe, /Content-Security-Policy/);
  assert.doesNotMatch(safe, /<script|<iframe|<form|<input|<button|<link/i);
  assert.doesNotMatch(safe, /onload|javascript:|https:\/\/example\.com|@import/i);
});

test("rejects an invalid publish without replacing the previous document", async () => {
  await withStore(async store => {
    const published = await store.replace({ html: livingHtml() });
    await assert.rejects(store.replace({ html: "" }), /empty/);
    assert.equal(store.metadata().revision, published.revision);
    assert.match(store.document(), /First version/);
  });
});
