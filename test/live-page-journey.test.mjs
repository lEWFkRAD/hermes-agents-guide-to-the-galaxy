import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function journeySources() {
  return {
    html: await fs.readFile(path.join(repoRoot, "public", "live.html"), "utf8"),
    css: await fs.readFile(path.join(repoRoot, "public", "live-journey.css"), "utf8"),
    source: await fs.readFile(path.join(repoRoot, "public", "live-journey.js"), "utf8")
  };
}

test("Journey is loaded beside the live page and adds its button to the pencil palette", async () => {
  const { html, source } = await journeySources();
  assert.match(html, /live-journey\.css\?v=3/);
  assert.match(html, /live-journey\.js\?v=4/);
  assert.match(source, /journeyBtn\.id = "journeyBtn"/);
  assert.match(source, /backBtn\.parentNode\.insertBefore\(journeyBtn, backBtn\)/);
  assert.match(source, /aria-haspopup", "dialog"/);
  assert.match(source, /aria-label", "Journey"/);
  assert.match(source, /setText\(journeyBtn, "\\u25b6"\)/);
});

test("Journey uses lightweight metadata and revision content endpoints with existing auth", async () => {
  const { source } = await journeySources();
  assert.match(source, /xhr\.open\("GET", "\/api\/live-page\/journey", true\)/);
  assert.match(source, /"\/api\/live-page\/journey\/content\?"/);
  assert.match(source, /revision=" \+ encodeURIComponent\(revision\)/);
  assert.match(source, /theme=" \+ \(darkMode \? "dark" : "light"\)/);
  assert.match(source, /setAuth\(xhr\)/);
  assert.doesNotMatch(source, /page\.html|srcdoc/);
});

test("Journey opens at Now and supports restart, pause, resume, and snapping scrubber", async () => {
  const { source } = await journeySources();
  assert.match(source, /showStep\(totalSteps - 1\)/);
  assert.match(source, /if \(currentStep >= totalSteps - 1\) showStep\(0\)/);
  assert.match(source, /setText\(playBtn, playing \? "Pause" : "Play"\)/);
  assert.match(source, /function scrubJourney\(\) \{\s*stopPlayback\(\)/);
  assert.match(source, /add\(progressEl, "input", scrubJourney\)/);
  assert.match(source, /setText\(nowBtn|journeyNowBtn/);
});

test("Journey reveals timed points at a Kindle-safe cadence and smooths partial paths", async () => {
  const { source } = await journeySources();
  assert.match(source, /var TICK_MS = 83/);
  assert.match(source, /typeof point\.t === "number"/);
  assert.match(source, /return pointIndex \* LEGACY_POINT_MS/);
  assert.match(source, /points = smoothedJourneyPoints\(points\.slice\(0, limit\)\)/);
  assert.match(source, /points\[i - 1\]\.x \+ \(2 \* points\[i\]\.x\) \+ points\[i \+ 1\]\.x/);
  assert.match(source, /path\.push\("Q"/);
});

test("Journey swaps revision iframes without painting ink over stale HTML", async () => {
  const { source } = await journeySources();
  const opener = source.slice(
    source.indexOf("function openJourneyFrame"),
    source.indexOf("function pointTime")
  );
  assert.match(opener, /while \(inkEl\.firstChild\) inkEl\.removeChild/);
  assert.match(opener, /viewportEl\.replaceChild\(nextFrame, frameEl\)/);
  assert.match(opener, /generation !== frameGeneration \|\| nextFrame !== frameEl/);
  assert.match(opener, /frameLoaded = true;[\s\S]*redrawInk\(activeFrameState\)/);
  assert.match(opener, /else if \(frameLoaded\) redrawInk\(state\)/);
});

test("Journey bounds Kindle memory use and keeps an accessible dark-mode overlay", async () => {
  const { css, source } = await journeySources();
  assert.match(source, /var MAX_FRAMES = 120/);
  assert.match(source, /var MAX_TOTAL_POINTS = 30000/);
  assert.match(source, /source\.length - MAX_FRAMES/);
  assert.match(source, /var remainingPoints = MAX_TOTAL_POINTS/);
  assert.match(source, /for \(var i = source\.length - 1; i >= start; i -= 1\)/);
  assert.match(source, /if \(remainingPoints < 1\)/);
  assert.match(source, /var strokeStart = Math\.max\(0, rawStrokes\.length - 500\)/);
  assert.match(source, /if \(stroke\.points\.length > remainingPoints\)/);
  assert.match(source, /remainingPoints -= stroke\.points\.length/);
  assert.doesNotMatch(source, /Journey history is too large for this device/);
  assert.match(css, /\.journeyOverlay\s*\{[\s\S]*background:\s*var\(--paper\)/);
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /@media \(max-width: 470px\)/);
  assert.doesNotMatch(source, /\b(?:const|let)\b|=>/);
});

test("Journey preserves the capture viewport and scales archived HTML with its ink", async () => {
  const { css, source } = await journeySources();
  assert.match(source, /surfaceWidth: isFinite\(surfaceWidth\)/);
  assert.match(source, /surfaceHeight: isFinite\(surfaceHeight\)/);
  assert.match(source, /function frameViewportSize\(/);
  assert.match(source, /sizes\[key\]\.weight \+= Math\.max\(1, frameStrokes\[i\]\.points\.length\)/);
  assert.match(source, /viewportEl\.style\.width = size\.width \+ "px"/);
  assert.match(source, /viewportEl\.style\.height = size\.height \+ "px"/);
  assert.match(source, /viewportEl\.style\.transform = "translate\("/);
  assert.match(source, /inkEl\.setAttribute\("viewBox", "0 0 " \+ size\.width \+ " " \+ size\.height\)/);
  assert.match(css, /\.journeyViewport\s*\{[\s\S]*transform-origin:\s*0 0/);
  assert.match(css, /\.journeyStage\s*\{[\s\S]*top:\s*0;[\s\S]*bottom:\s*0/);
  assert.match(css, /\.journeyControls\s*\{[\s\S]*position:\s*absolute/);
});
