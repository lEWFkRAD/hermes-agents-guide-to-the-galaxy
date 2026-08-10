import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDataRootLockArtifactName } from "../lib/data-root-lock.mjs";
import { resolveNotebookRuntime } from "../lib/runtime-profile.mjs";

const BACKUP_KIND = "hermes-notebook-backup";
const BACKUP_VERSION = 2;
const DEFAULT_KEEP = 14;
const MAX_KEEP = 1000;
const GENERATION_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?$/;

export function parseBackupKeep(raw = "") {
  const normalized = String(raw).trim() || String(DEFAULT_KEEP);
  if (!/^[0-9]{1,4}$/.test(normalized)) {
    throw new Error("DIARY_BACKUP_KEEP must be an integer between 2 and 1000");
  }
  const keep = Number(normalized);
  if (!Number.isSafeInteger(keep) || keep < 2 || keep > MAX_KEEP) {
    throw new Error("DIARY_BACKUP_KEEP must be an integer between 2 and 1000");
  }
  return keep;
}

function portableRelative(base, full) {
  return path.relative(base, full).split(path.sep).join("/");
}

async function fileManifest(full, relative) {
  const handle = await fs.open(full, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`Backup source contains an unsupported entry: ${relative}`);
    const content = await handle.readFile();
    const after = await handle.stat();
    if (!after.isFile() || before.size !== after.size || content.length !== after.size) {
      throw new Error(`Backup source changed while reading: ${relative}`);
    }
    return {
      path: relative,
      type: "file",
      size: content.length,
      sha256: crypto.createHash("sha256").update(content).digest("hex")
    };
  } finally {
    await handle.close();
  }
}

async function treeManifest(folder, {
  exclude = new Set(),
  excludeDataRootLockArtifacts = false
} = {}) {
  const result = [];
  async function visit(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      if (excludeDataRootLockArtifacts && current === folder && isDataRootLockArtifactName(entry.name)) {
        continue;
      }
      const full = path.join(current, entry.name);
      const relative = portableRelative(folder, full);
      if (exclude.has(relative)) continue;
      const stat = await fs.lstat(full);
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
        throw new Error(`Backup source contains an unsupported entry: ${relative}`);
      }
      if (entry.isDirectory() && stat.isDirectory()) {
        result.push({ path: relative, type: "directory" });
        await visit(full);
      } else if (entry.isFile() && stat.isFile()) {
        result.push(await fileManifest(full, relative));
      } else {
        throw new Error(`Backup source contains an unsupported entry: ${relative}`);
      }
    }
  }
  await visit(folder);
  return result;
}

function manifestBytes(manifest) {
  return JSON.stringify(manifest);
}

function manifestDigest(manifest) {
  return crypto.createHash("sha256").update(manifestBytes(manifest), "utf8").digest("hex");
}

function requireSameManifest(expected, actual, message) {
  const left = Buffer.from(manifestDigest(expected), "hex");
  const right = Buffer.from(manifestDigest(actual), "hex");
  if (!crypto.timingSafeEqual(left, right) || manifestBytes(expected) !== manifestBytes(actual)) {
    throw new Error(message);
  }
}

async function reserveGeneration(backupRoot, stamp) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const generation = `${stamp}-${crypto.randomUUID()}`;
    const destination = path.join(backupRoot, generation);
    const reservation = path.join(backupRoot, `.${generation}.reserve`);
    let handle;
    try {
      handle = await fs.open(reservation, "wx", 0o600);
      try {
        await fs.lstat(destination);
        await handle.close();
        await fs.rm(reservation, { force: true });
        continue;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      return { generation, destination, reservation, handle };
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
        await fs.rm(reservation, { force: true }).catch(() => {});
      }
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not reserve a unique backup generation");
}

export async function isOwnedBackupGeneration(backupRoot, entry) {
  if (!entry.isDirectory() || !GENERATION_RE.test(entry.name)) return false;
  const manifestPath = path.join(backupRoot, entry.name, "backup-manifest.json");
  try {
    const stat = await fs.stat(manifestPath);
    if (!stat.isFile() || stat.size > 1024 * 1024) return false;
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    return manifest?.kind === BACKUP_KIND &&
      manifest?.version === BACKUP_VERSION &&
      manifest?.generation === entry.name &&
      Array.isArray(manifest?.files);
  } catch {
    return false;
  }
}

export async function runBackup({
  environ = process.env,
  now = new Date(),
  beforeSourceRecheck = async () => {}
} = {}) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const runtime = resolveNotebookRuntime({ environ, repoRoot: root });
  const source = runtime.dataDir;
  const backupRoot = runtime.backupDir;
  const keep = parseBackupKeep(environ.DIARY_BACKUP_KEEP);
  const createdAt = now.toISOString();
  const stamp = createdAt.replace(/[:.]/g, "-");

  await fs.mkdir(backupRoot, { recursive: true });
  const sourceBefore = await treeManifest(source, { excludeDataRootLockArtifacts: true });
  if (sourceBefore.some(item => item.path === "backup-manifest.json")) {
    throw new Error("Backup source contains the reserved backup-manifest.json path");
  }
  let pendingRoot = "";
  let pending = "";
  let reservation = null;
  let committed = false;
  try {
    pendingRoot = await fs.mkdtemp(path.join(backupRoot, `.${stamp}.${process.pid}.pending-`));
    pending = path.join(pendingRoot, "payload");
    reservation = await reserveGeneration(backupRoot, stamp);
    const copyFilter = sourcePath => {
      const relative = path.relative(source, sourcePath);
      if (!relative) return true;
      const [rootName] = relative.split(path.sep);
      return !isDataRootLockArtifactName(rootName);
    };
    await fs.cp(source, pending, {
      recursive: true,
      errorOnExist: true,
      force: false,
      dereference: false,
      filter: copyFilter
    });
    const staged = await treeManifest(pending);
    requireSameManifest(sourceBefore, staged, "Backup copy does not match the source manifest");
    await beforeSourceRecheck({ source, pending, generation: reservation.generation });
    const files = staged.filter(item => item.type === "file");
    const receipt = {
      kind: BACKUP_KIND,
      version: BACKUP_VERSION,
      generation: reservation.generation,
      createdAt,
      source,
      manifestSha256: manifestDigest(staged),
      entries: staged,
      files
    };
    await fs.writeFile(
      path.join(pending, "backup-manifest.json"),
      JSON.stringify(receipt, null, 2),
      { encoding: "utf8", flag: "wx", mode: 0o600 }
    );
    const stagedFinal = await treeManifest(pending, { exclude: new Set(["backup-manifest.json"]) });
    requireSameManifest(staged, stagedFinal, "Backup staging changed before publication");
    const sourceAfter = await treeManifest(source, { excludeDataRootLockArtifacts: true });
    requireSameManifest(sourceBefore, sourceAfter, "Backup source changed during snapshot");
    try {
      await fs.lstat(reservation.destination);
      throw new Error("Reserved backup destination already exists");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await fs.rename(pending, reservation.destination);
    committed = true;
  } finally {
    if (pendingRoot) await fs.rm(pendingRoot, { recursive: true, force: true });
    if (reservation) await reservation.handle.close().catch(() => {});
    if (reservation) await fs.rm(reservation.reservation, { force: true });
  }

  const entries = await fs.readdir(backupRoot, { withFileTypes: true });
  const generations = [];
  for (const entry of entries) {
    if (await isOwnedBackupGeneration(backupRoot, entry)) generations.push(entry.name);
  }
  generations.sort().reverse();
  for (const old of generations.slice(keep)) {
    await fs.rm(path.join(backupRoot, old), { recursive: true, force: true });
  }
  return {
    ok: true,
    destination: reservation.destination,
    files: sourceBefore.filter(item => item.type === "file").length
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    console.log(JSON.stringify(await runBackup()));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Backup failed");
    process.exitCode = 1;
  }
}
