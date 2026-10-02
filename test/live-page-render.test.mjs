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
  assert.match(exporter, /var minX = 1, minY = 1, maxX = 0, maxY = 0/);
  assert.match(exporter, /Math\.min\(4, Math\.max\(2, 1800/);
  assert.match(exporter, /toDataURL\("image\/png"\)/);
  assert.doesNotMatch(exporter, /image\/jpeg/);
  assert.doesNotMatch(pathRenderer, /for \([^)]*\)[^{]*path\.push\("L"/);
});

test("live shell cache-busts the current renderer and Journey assets", async () => {
  const html = await fs.readFile(path.join(repoRoot, "public", "live.html"), "utf8");
  assert.match(html, /live\.css\?v=18/);
  assert.match(html, /live\.js\?v=35/);
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

test("Send always uses the tool-enabled Hermes channel; clients cannot pick endpoints", async () => {
  const server = await fs.readFile(path.join(repoRoot, "server.mjs"), "utf8");

  assert.match(server, /const target = "hermes";/);
  assert.doesNotMatch(server, /body\.endpoint/);
  assert.doesNotMatch(server, /body\.token/);
  assert.doesNotMatch(server, /localTextEndpoint/);
  await assert.rejects(fs.access(path.join(repoRoot, "public", "app.js")));
});

test("an unconfirmed Send never locks the pen", async () => {
  const source = await fs.readFile(path.join(repoRoot, "public", "live.js"), "utf8");
  const startInk = source.slice(source.indexOf("function startInk"), source.indexOf("function appendInkPoint"));

  assert.match(startInk, /if \(!drawMode \|\| sendBusy\) return true;/);
  assert.doesNotMatch(startInk, /pendingInkSend/);
  assert.match(source, /drawModeBtn\.disabled = sendBusy;/);
  assert.match(source, /Tap Clear to start over; Pen still works\./);
});

test("an open Kindle tab reloads itself when the bridge serves new client code", async () => {
  const source = await fs.readFile(path.join(repoRoot, "public", "live.js"), "utf8");
  const server = await fs.readFile(path.join(repoRoot, "server.mjs"), "utf8");

  assert.match(server, /"x-live-client-build": await liveClientBuild\(\)/);
  assert.match(source, /getResponseHeader\("x-live-client-build"\)/);
  assert.match(source, /if \(drawing \|\| sendBusy \|\| panning/);
  assert.match(source, /hasPendingAddOperations\(\)\) return;\s*clientBuildStale = false;\s*window\.location\.reload\(\);/);
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
    server.indexOf("// Find an existing session, but do NOT register")
  );

  assert.match(claimGate, /liveInkSendId && liveInkStrokeIds\.length/);
  assert.doesNotMatch(claimGate, /!body\.stream/);
  assert.match(claimGate, /liveInkStore\.claimSend/);
});

test("handwritten sends fail closed when OCR is unavailable", async () => {
  const serverSource = await fs.readFile(path.join(repoRoot, "server.mjs"), "utf8");

  assert.match(serverSource, /kind:\s*"ocr_error"/);
  assert.match(serverSource, /kind:\s*"ocr_blocked_send"/);
  assert.match(serverSource, /liveInkStore\.releaseSend\(liveInkClaimId\)/);
  assert.match(serverSource, /vision service is unavailable/);
  assert.match(serverSource, /inkPreserved:\s*true/);
});

test("live page surfaces streamed error trailers instead of reporting success", async () => {
  const liveSource = await fs.readFile(path.join(repoRoot, "public", "live.js"), "utf8");

  assert.match(liveSource, /ok:\s*!\(streamTrailer\s*&&\s*streamTrailer\.error\)/);
  assert.match(liveSource, /error:\s*streamTrailer\s*&&\s*streamTrailer\.error/);
  assert.match(liveSource, /inkPreserved:\s*!!\(streamTrailer\s*&&\s*streamTrailer\.inkPreserved\)/);
});

test("live-page handwriting is cleaned and game shorthand is normalized", async () => {
  const serverSource = await fs.readFile(path.join(repoRoot, "server.mjs"), "utf8");

  assert.match(serverSource, /if \(rawTranscription\) \{/);
  assert.match(serverSource, /normalizeKindleTranscription\(cleaned\)/);
  assert.match(serverSource, /D\\s\*T\\s\*D/);
  assert.match(serverSource, /Dungeons & Dragons/);
  assert.match(serverSource, /reconcileHandwritingReadings\(readings\)/);
  assert.match(serverSource, /kind:\s*"ocr_result"/);
  assert.match(serverSource, /Before a broad file, session, database, or web search/);
  assert.match(serverSource, /function calibrateHandwritingResult/);
  assert.match(serverSource, /Math\.min\(0\.82/);
  assert.match(serverSource, /D\[B6T\]D/);
  assert.match(serverSource, /confidence = Math\.min\(confidence, 0\.55\)/);
  assert.match(serverSource, /ocrConfidence < 0\.65 && ocrAlternatives\.length > 0/);
  assert.match(serverSource, /ocrNeedsClarification \? \{ text: clarificationText \} : await callKindleChannel/);
  assert.match(serverSource, /kind:\s*"ocr_clarification"/);
});

test("Kindle view: one-tap clear with undo, hand tool, zoom and four-way pan", async () => {
  const html = await fs.readFile(path.join(repoRoot, "public", "live.html"), "utf8");
  const css = await fs.readFile(path.join(repoRoot, "public", "live.css"), "utf8");
  const source = await fs.readFile(path.join(repoRoot, "public", "live.js"), "utf8");
  // Fast clear lives on the main bar, one tap, with a timed undo instead of a confirm.
  assert.match(html, /<div class="liveActions">[\s\S]*id="quickClearBtn"[\s\S]*id="liveSendBtn"/);
  assert.match(source, /function requestClear\(\)\{if\(clearUndo\)\{restoreClearedInk\(\);return;\}/);
  assert.doesNotMatch(source, /Tap again to clear/);
  const restore = source.slice(source.indexOf("function restoreClearedInk"), source.indexOf("function clearInk"));
  assert.match(restore, /queueInkOperation\("add", \{ stroke: saved\[i\] \}\)/);
  // Page, ink display and ink canvas move together under one transform.
  assert.match(html, /id="liveStage"[\s\S]*id="liveFrame"[\s\S]*id="liveInkDisplay"[\s\S]*id="liveInk"[\s\S]*<\/div>\s*<div id="viewDock"/);
  for (const dir of ["up", "down", "left", "right"]) assert.match(html, new RegExp(`data-pan="${dir}"`));
  assert.match(html, /id="zoomInBtn"/);
  assert.match(html, /id="zoomOutBtn"/);
  assert.match(html, /id="handToggleBtn"[^>]*aria-pressed="false"/);
  assert.match(css, /\.liveStage \{[^}]*transform-origin: 0 0/);
  assert.match(css, /body\.handMode #liveInk \{ pointer-events: auto/);
  assert.match(css, /\.viewDock button \{[^}]*height: 56px/);
  assert.doesNotMatch(css.slice(css.indexOf(".liveStage")), /transition|animation/);
  // Hand mode pans instead of inking; ink coordinates still come from the transformed canvas rect.
  assert.match(source, /function startInk\(event\) \{\s*if \(handMode\) return startPan\(event\);/);
  assert.match(source, /function moveInk\(event\) \{\s*if \(panning\) return movePan\(event\);/);
  assert.match(source, /function endInk\(event\) \{\s*if \(panning\) return endPan\(event\);/);
  assert.match(source, /var rect = canvasEl\.getBoundingClientRect\(\);/);
  assert.match(source, /var ZOOM_STEPS = \[0\.5, 0\.75, 1, 1\.5, 2, 3\]/);
  // Regression (2026-10-02): the top-bar Pen must take the pen back from Hand mode.
  const penHandler = source.slice(source.indexOf('add(annotationToggleBtn, "click"'), source.indexOf('add(hermesToggleBtn, "click"'));
  assert.match(penHandler, /if \(handMode\) \{ setHandMode\(false\); setDrawMode\(true\); return; \}/);
});
