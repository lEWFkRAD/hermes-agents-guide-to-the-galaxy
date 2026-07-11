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
  assert.match(html, /live\.css\?v=15/);
  assert.match(html, /live\.js\?v=32/);
  assert.match(html, /class="labeledTool"/);
  assert.match(html, /id="hermesToggleBtn"/);
  assert.match(html, /id="moreToggleBtn"/);
  assert.match(html, /data-intent="redline"[^>]*aria-label="Suggest a redline/);
  assert.match(html, /live-journey\.css\?v=3/);
  assert.match(html, /live-journey\.js\?v=4/);
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
  assert.match(html, /id="moveSelectionBtn"/);
  assert.match(html, /id="askSelectionBtn"/);
  assert.match(css, /\.labeledTool::after/);
  assert.match(html, /data-intent="redline"/);
  assert.match(css, /\.liveReply\.redlineReply/);
  assert.match(source, /showReply\(result\.text, requestedIntent\)/);
  assert.match(css, /\.liveBar\s*\{[^}]*position:\s*absolute/s);
  assert.match(css, /\.toolActions button\s*\{[^}]*width:\s*44px/s);
  assert.match(css, /\.toolActions svg\s*\{[^}]*stroke:\s*currentColor/s);
  assert.match(source, /setToolsOpen\(false\);/);
  assert.match(source, /if \(!drawMode\) setDrawMode\(true\);/);
  assert.match(source, /pointInPolygon/);
  assert.match(source, /requestClear/);
  assert.doesNotMatch(source, /removeStorage\(/);
  assert.match(source, /requestFrame\(renderMovePreview\)/);
  assert.match(source, /streamPaintTimer/);
  assert.match(source, /Retire the old Hermes lane only after the replacement page exists/);
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
  assert.match(source, /if \(drawing && currentStroke\) commitCurrentStroke\(\)/);
  assert.match(source, /add\(document, "pointerup", endInk\)/);
  assert.doesNotMatch(source, /add\(element, "pointerleave", endInk\)/);
});

test("ordinary drawing does not rebuild every older stroke", async () => {
  const source = await fs.readFile(path.join(repoRoot, "public", "live.js"), "utf8");
  const start = source.slice(source.indexOf("function startInk"), source.indexOf("function appendInkPoint"));
  const commit = source.slice(source.indexOf("function commitCurrentStroke"), source.indexOf("function endInk"));
  const unchangedPoll = source.slice(source.indexOf("if (xhr.status === 304)"), source.indexOf("if (xhr.status >= 200", source.indexOf("if (xhr.status === 304)")));

  const ordinaryStart = start.slice(start.indexOf("var startedAt"));
  assert.match(ordinaryStart, /currentDisplayEl = drawStroke\(currentStroke\)/);
  assert.doesNotMatch(ordinaryStart, /redrawInk\(\)/);
  assert.doesNotMatch(commit, /redrawInk\(\)/);
  assert.doesNotMatch(commit, /rematerializeInk\(\)/);
  assert.doesNotMatch(unchangedPoll, /rematerializeInk\(\)/);
});

test("large handwritten sends collapse duplicate DOM targets", async () => {
  const server = await fs.readFile(path.join(repoRoot, "server.mjs"), "utf8");
  const collector = server.slice(server.indexOf("function collectLiveDomAnchors"), server.indexOf("function livePageReadableText"));
  assert.match(collector, /const grouped = new Map\(\)/);
  assert.match(collector, /existing\.strokeCount \+= 1/);
  assert.match(collector, /anchor\.strokeCount > 1/);
  assert.doesNotMatch(collector, /if \(result\.length >= 24\)/);
});

test("Send can explicitly retry a page whose visible ink was already processed", async () => {
  const source = await fs.readFile(path.join(repoRoot, "public", "live.js"), "utf8");
  const sender = source.slice(source.indexOf("function sendInkToHermes"), source.indexOf("bindInkEvents(canvasEl)"));
  assert.match(sender, /if \(!pending\.length\) pending = strokes\.slice\(0\)/);
  assert.match(sender, /resend: !retrying && unsentStrokes\(\)\.length === 0/);
});

test("blank-page hint stays dismissed after writing or a Hermes response", async () => {
  const source = await fs.readFile(path.join(repoRoot, "public", "live.js"), "utf8");
  assert.match(source, /var emptyHintDismissed = !!sessionId/);
  assert.match(source, /emptyHintEl\.hidden = emptyHintDismissed \|\| strokes\.length > 0/);
  assert.match(source, /function showReply\(text, intent\) \{[\s\S]*emptyHintDismissed = true/);
  assert.match(source, /if \(page\.title !== "Blank page"\) emptyHintDismissed = true/);
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

test("new page preserves active work until the replacement page succeeds", async () => {
  const source = await fs.readFile(path.join(repoRoot, "public", "live.js"), "utf8");
  const newPage = source.slice(
    source.indexOf("function newPage"),
    source.indexOf("function toggleTheme")
  );
  const requestIndex = newPage.indexOf('requestJson("POST", "/api/live-page/template"');
  const clearIndex = newPage.indexOf("clearInk()");
  const threadIndex = newPage.indexOf('hermesThreadId=newHermesThreadId()');

  assert.ok(requestIndex >= 0);
  assert.ok(clearIndex > requestIndex);
  assert.ok(threadIndex > requestIndex);
  assert.match(newPage, /if \(error\) \{ setText\(stateEl, "Could not open blank page"\); return; \}/);
});

test("streamed live annotations are claimed before Hermes runs", async () => {
  const server = await fs.readFile(path.join(repoRoot, "server.mjs"), "utf8");
  const claimGate = server.slice(
    server.indexOf("if (isLivePageSource && target"),
    server.indexOf("let endpoint = body.endpoint")
  );

  assert.match(claimGate, /liveInkSendId && liveInkStrokeIds\.length/);
  assert.doesNotMatch(claimGate, /!body\.stream/);
  assert.match(claimGate, /liveInkStore\.claimSend/);
});
