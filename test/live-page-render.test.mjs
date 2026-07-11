import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("live ink uses the same smooth curve for display and Hermes export", async () => {
  const source = await fs.readFile(path.join(repoRoot, "public", "live.js"), "utf8");
  const pathRenderer = source.slice(
    source.indexOf("function strokePathData"),
    source.indexOf("function drawStroke")
  );
  const exporter = source.slice(
    source.indexOf("function exportInk"),
    source.indexOf("function resizeCanvas")
  );

  assert.match(pathRenderer, /points = smoothedStrokePoints\(points\)/);
  assert.match(pathRenderer, /path\.push\(\s*"Q"/);
  assert.match(exporter, /smoothedStrokePoints\(selected\[i\]\.points/);
  assert.match(exporter, /outInk\.quadraticCurveTo\(/);
  assert.doesNotMatch(pathRenderer, /for \([^)]*\)[^{]*path\.push\("L"/);
});

test("live shell cache-busts the current renderer and Journey assets", async () => {
  const html = await fs.readFile(path.join(repoRoot, "public", "live.html"), "utf8");
  assert.match(html, /live\.css\?v=12/);
  assert.match(html, /live\.js\?v=20/);
  assert.match(html, /id="hermesToggleBtn"/);
  assert.match(html, /id="moreToggleBtn"/);
  assert.doesNotMatch(html, /data-intent=/);
  assert.match(html, /live-journey\.css\?v=2/);
  assert.match(html, /live-journey\.js\?v=3/);
});

test("live annotations capture exact DOM targets without enabling iframe scripts", async () => {
  const html = await fs.readFile(path.join(repoRoot, "public", "live.html"), "utf8");
  const source = await fs.readFile(path.join(repoRoot, "public", "live.js"), "utf8");
  assert.match(html, /sandbox="allow-same-origin"/);
  assert.doesNotMatch(html, /allow-scripts/);
  assert.match(source, /function captureStrokeAnchors\(stroke\)/);
  assert.match(source, /doc\.elementFromPoint\(x \* width, y \* height\)/);
  assert.match(source, /completed\.anchors = captureStrokeAnchors\(completed\)/);
  assert.match(source, /data-live-region/);
  assert.match(source, /return result\.slice\(0, 6\)/);
});

test("annotation tools default to a compact Kindle-friendly reading mode", async () => {
  const html = await fs.readFile(path.join(repoRoot, "public", "live.html"), "utf8");
  const css = await fs.readFile(path.join(repoRoot, "public", "live.css"), "utf8");
  const source = await fs.readFile(path.join(repoRoot, "public", "live.js"), "utf8");

  assert.match(html, /<body class="livePage viewMode toolsCollapsed">/);
  assert.match(html, /id="annotationToggleBtn"/);
  assert.match(html, /id="annotationTools"[^>]*hidden/);
  assert.match(html, /class="toolActions"/);
  assert.match(html, /id="liveSendBtn"/);
  assert.match(html, /id="hermesTools"[^>]*hidden/);
  assert.match(html, /id="moreTools"[^>]*hidden/);
  assert.match(html, /class="selectionAction"/);
  assert.doesNotMatch(html, /data-intent=/);
  assert.match(css, /\.liveBar\s*\{[^}]*position:\s*absolute/s);
  assert.match(css, /\.toolActions button\s*\{[^}]*width:\s*44px/s);
  assert.match(css, /\.toolActions svg\s*\{[^}]*stroke:\s*currentColor/s);
  assert.match(source, /setToolsOpen\(false\);/);
  assert.match(source, /pointInPolygon/);
  assert.match(source, /requestClear/);
});

test("main Kindle notebook defaults to the tool-enabled Hermes channel", async () => {
  const html = await fs.readFile(path.join(repoRoot, "public", "index.html"), "utf8");
  const source = await fs.readFile(path.join(repoRoot, "public", "app.js"), "utf8");
  const server = await fs.readFile(path.join(repoRoot, "server.mjs"), "utf8");

  assert.match(html, /<option value="hermes" selected>Hermes agent \(tools enabled\)<\/option>/);
  assert.doesNotMatch(html, /Plain assistant/);
  assert.doesNotMatch(html, /Local models/);
  assert.doesNotMatch(html, /Custom OpenAI-compatible endpoint/);
  assert.match(source, /savedTarget !== "hermes"/);
  assert.match(server, /const target = "hermes";/);
});

test("successful Send marks exact ink processed but keeps it visible until HTML changes", async () => {
  const source = await fs.readFile(path.join(repoRoot, "public", "live.js"), "utf8");
  const successHandler = source.slice(
    source.indexOf("if (!result.ok) throw"),
    source.indexOf("xhr.onerror", source.indexOf("if (!result.ok) throw"))
  );

  assert.match(successHandler, /strokes\[i\]\.id === pendingIds\[sentIndex\]/);
  assert.match(successHandler, /queueInkOperation\("mark-sent", \{ ids: pendingIds \}\)/);
  assert.doesNotMatch(successHandler, /queueInkOperation\("delete"/);
  assert.doesNotMatch(successHandler, /setToolsOpen\(false\)/);
  assert.doesNotMatch(source, /queueSentInkCleanup/);
});

test("only a genuinely changed HTML revision clears visible ink and closes UI", async () => {
  const source = await fs.readFile(path.join(repoRoot, "public", "live.js"), "utf8");
  const opener = source.slice(
    source.indexOf("function openRevision"),
    source.indexOf("function schedulePoll")
  );

  assert.match(opener, /var changedRevision = !!revision && page\.revision !== revision/);
  assert.match(opener, /if \(changedRevision \|\| staleInitialInk\) \{[\s\S]*setToolsOpen\(false\)[\s\S]*hideReply\(\)[\s\S]*strokes = \[\]/);
  assert.match(source, /strokes = matchingRevisionStrokes\(applyPendingOperations\(serverInkStrokes, storedInkOperations\(\)\), revision\)/);
  assert.match(opener, /serverInkStrokes = \[\]/);
  assert.match(opener, /pendingInkSnapshot = null/);
  assert.doesNotMatch(opener, /queueInkOperation\("delete"/);
  assert.match(opener, /staleActiveInk = !revision && inkActiveRevision && inkActiveRevision !== page\.revision/);
  assert.match(source, /if \(revision && snapshotActiveRevision && snapshotActiveRevision !== revision\) \{[\s\S]*scheduleInkPoll\(500\);[\s\S]*return;/);
});

test("live drawing keeps coalesced samples, final points, and bounded relative timing", async () => {
  const source = await fs.readFile(path.join(repoRoot, "public", "live.js"), "utf8");
  assert.match(source, /event\.getCoalescedEvents\(\)/);
  assert.match(source, /event\.changedTouches && event\.changedTouches\[0\]/);
  assert.match(source, /appendInkPoint\(event\);/);
  assert.match(source, /firstPoint\.t = 0/);
  assert.match(source, /point\.t = Math\.max\(0, Math\.min\(MAX_POINT_T/);
  assert.match(source, /pointTime <= MAX_POINT_T\) point\.t = Math\.round\(pointTime\)/);
});

test("lost send responses reuse the persisted claim without deleting visible ink", async () => {
  const source = await fs.readFile(path.join(repoRoot, "public", "live.js"), "utf8");
  const sender = source.slice(
    source.indexOf("function sendInkToHermes"),
    source.indexOf("bindInkEvents(canvasEl)")
  );

  assert.match(source, /livePageInkPendingSendV1/);
  assert.match(sender, /liveInkSendId = pendingInkSend\.id/);
  assert.match(sender, /keepPendingInkSend\(\{ id: liveInkSendId, strokeIds: pendingIds \}\)/);
  assert.match(sender, /clearPendingInkSend\(liveInkSendId\)/);
  assert.doesNotMatch(sender, /queueInkOperation\("delete", \{ ids: pendingIds \}\)/);
});
