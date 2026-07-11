import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const IGNORE_DIRS = new Set([".git", "backups", "data", "node_modules"]);
const TEXT_EXTENSIONS = new Set([
  ".cmd", ".css", ".html", ".js", ".json", ".md", ".mjs", ".ps1",
  ".vbs", ".xml", ".yml", ".yaml"
]);
const failures = [];

function relative(file) {
  return path.relative(ROOT, file).replace(/\\/g, "/");
}

async function walk(dir, files = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) await walk(path.join(dir, entry.name), files);
    } else if (entry.isFile()) files.push(path.join(dir, entry.name));
  }
  return files;
}

function checkText(file, content) {
  if (!content.endsWith("\n")) failures.push(`${relative(file)}: missing final newline`);
  content.split(/\r?\n/).forEach((line, index) => {
    if (/[ \t]+$/.test(line)) failures.push(`${relative(file)}:${index + 1}: trailing whitespace`);
  });
}

function checkSyntax(file) {
  const result = spawnSync(process.execPath, ["--check", file], { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) failures.push(
    `${relative(file)}: JavaScript syntax check failed\n${result.stderr || result.stdout}`
  );
}

async function main() {
  const files = await walk(ROOT);
  for (const file of files) {
    const extension = path.extname(file).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension)) continue;
    const content = await fs.readFile(file, "utf8");
    checkText(file, content);
    if (extension === ".json") {
      try { JSON.parse(content); } catch (error) {
        failures.push(`${relative(file)}: invalid JSON: ${error.message}`);
      }
    }
    if (extension === ".js" || extension === ".mjs") checkSyntax(file);
  }
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else console.log(`Style check passed for ${files.length} files.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
