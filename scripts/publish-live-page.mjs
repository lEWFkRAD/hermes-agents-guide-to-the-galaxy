#!/usr/bin/env node
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const inputPath = process.argv[2];

if (!inputPath) {
  console.error("Usage: node scripts/publish-live-page.mjs <page.html|page.json|->");
  process.exit(2);
}

const source = inputPath === "-"
  ? await fs.readFile(0, "utf8")
  : await fs.readFile(path.resolve(inputPath), "utf8");

let page;
const extension = inputPath === "-" ? "" : path.extname(inputPath).toLowerCase();
if (extension === ".html" || extension === ".htm" || (!extension && /^\s*(?:<!doctype|<html|<body|<main|<section|<div)/i.test(source))) {
  page = { html: source };
} else {
  try {
    page = JSON.parse(source);
  } catch (error) {
    console.error(`Input is neither HTML nor valid JSON: ${error.message}`);
    process.exit(2);
  }
  if (!page || typeof page.html !== "string") {
    console.error("JSON input must contain an html string.");
    process.exit(2);
  }
}

const dataDir = process.env.DIARY_DATA_DIR || path.join(repoRoot, "data");
let token = String(process.env.DIARY_LIVE_WRITE_TOKEN || "").trim();
if (!token) {
  try {
    token = (await fs.readFile(path.join(dataDir, "live-page-write.token"), "utf8")).trim();
  } catch {
    console.error("Live Page publisher token is missing. Start the diary once, then retry.");
    process.exit(2);
  }
}

const body = JSON.stringify(page);
const port = Number(process.env.DIARY_PORT || 8791);

const result = await new Promise((resolve, reject) => {
  const request = http.request({
    hostname: "127.0.0.1",
    port,
    path: "/api/live-page",
    method: "PUT",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "x-diary-live-write": token
    }
  }, response => {
    let responseBody = "";
    response.setEncoding("utf8");
    response.on("data", chunk => { responseBody += chunk; });
    response.on("end", () => resolve({ status: response.statusCode || 0, body: responseBody }));
  });
  request.on("error", reject);
  request.end(body);
});

let parsed;
try { parsed = JSON.parse(result.body); }
catch { parsed = { error: result.body || `HTTP ${result.status}` }; }

if (result.status < 200 || result.status >= 300 || !parsed.ok) {
  console.error(parsed.error || `Publish failed with HTTP ${result.status}`);
  process.exit(1);
}

// Keep one private, editable source file for Hermes to evolve on the next turn.
// The server stores and serves a separately sanitized copy.
await fs.mkdir(dataDir, { recursive: true });
await fs.writeFile(path.join(dataDir, "live-page-source.html"), page.html, "utf8");

console.log(JSON.stringify({
  ok: true,
  revision: parsed.page.revision,
  updatedAt: parsed.page.updatedAt,
  title: parsed.page.title
}, null, 2));
