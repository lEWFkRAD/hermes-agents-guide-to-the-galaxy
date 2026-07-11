import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(process.env.DIARY_DATA_DIR || path.join(root, "data"));
const backupRoot = path.resolve(process.env.DIARY_BACKUP_DIR || path.join(root, "backups"));
const keep = Math.max(2, Number(process.env.DIARY_BACKUP_KEEP || 14));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const pending = path.join(backupRoot, `.${stamp}.pending`);
const destination = path.join(backupRoot, stamp);

async function filesUnder(folder, base = folder) {
  const result = [];
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(full, base));
    else if (entry.isFile()) result.push(path.relative(base, full));
  }
  return result.sort();
}

async function hash(file) {
  return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

await fs.mkdir(backupRoot, { recursive: true });
await fs.cp(source, pending, { recursive: true, errorOnExist: true });
const manifest = [];
for (const relative of await filesUnder(pending)) manifest.push({ path: relative, sha256: await hash(path.join(pending, relative)) });
await fs.writeFile(path.join(pending, "backup-manifest.json"), JSON.stringify({ version: 1, createdAt: new Date().toISOString(), source, files: manifest }, null, 2), "utf8");
for (const item of manifest) if (item.sha256 !== await hash(path.join(pending, item.path))) throw new Error(`Backup verification failed: ${item.path}`);
await fs.rename(pending, destination);

const generations = (await fs.readdir(backupRoot, { withFileTypes: true }))
  .filter(entry => entry.isDirectory() && !entry.name.startsWith("."))
  .map(entry => entry.name).sort().reverse();
for (const old of generations.slice(keep)) await fs.rm(path.join(backupRoot, old), { recursive: true, force: true });
console.log(JSON.stringify({ ok: true, destination, files: manifest.length }));
