import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDataRootLockArtifactName } from "./data-root-lock.mjs";

export const NOTEBOOK_SERVICE = "kindle-scribe";
export const NOTEBOOK_VERSION = "0.2.0";
export const DEFAULT_ADAPTER_HOST = "127.0.0.1";
export const DEFAULT_ADAPTER_PORT = 8793;
export const DEFAULT_REPLY_TIMEOUT = 240;
export const PROFILE_MIGRATION_RECEIPT_NAME = ".profile-migration.json";
export const PROFILE_MIGRATION_RECEIPT_KIND = "hermes-notebook-profile-migration";
export const PROFILE_MIGRATION_RECEIPT_VERSION = 1;
export const ADAPTER_TIMEOUT_MARGIN_MS = 5000;
export const MAX_ADAPTER_TIMEOUT_MS = 600000;

const MAX_PATH_CHARS = 4096;
const MAX_TOKEN_CHARS = 4096;
const MAX_URL_CHARS = 2048;
const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const USER_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["", "0", "false", "no", "off"]);
const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export class RuntimeConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "RuntimeConfigurationError";
  }
}

function boundedEnvironmentValue(environ, name, maximum) {
  const value = String(environ[name] ?? "");
  if (value.length > maximum) throw new RuntimeConfigurationError(`${name} is too long`);
  return value;
}

function samePath(left, right) {
  const normalize = value => process.platform === "win32"
    ? path.normalize(value).toLowerCase()
    : path.normalize(value);
  return normalize(left) === normalize(right);
}

function sameCanonicalSpelling(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function resolvePhysicalPath(value) {
  let existing = value;
  const missing = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  let physical = existing;
  try { physical = fs.realpathSync.native(existing); } catch {}
  return path.resolve(physical, ...missing);
}

function canonicalHome(raw, name) {
  if (!raw || raw !== raw.trim()) {
    throw new RuntimeConfigurationError(`${name} must be a non-empty absolute path`);
  }
  if (raw.length > MAX_PATH_CHARS || !path.isAbsolute(raw)) {
    throw new RuntimeConfigurationError(`${name} must be a bounded absolute path`);
  }
  return resolvePhysicalPath(path.resolve(raw));
}

function explicitCanonicalPath(environ, name) {
  const raw = boundedEnvironmentValue(environ, name, MAX_PATH_CHARS);
  if (!raw) return "";
  if (raw !== raw.trim() || !path.isAbsolute(raw)) {
    throw new RuntimeConfigurationError(`${name} must be an absolute canonical path`);
  }
  const resolved = path.resolve(raw);
  if (!sameCanonicalSpelling(raw, resolved)) {
    throw new RuntimeConfigurationError(`${name} must not contain redundant path segments`);
  }
  const physical = resolvePhysicalPath(resolved);
  if (!samePath(resolved, physical)) {
    throw new RuntimeConfigurationError(`${name} must not traverse a symbolic link or junction`);
  }
  return physical;
}

function isStrictDescendant(candidate, root) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function pathsOverlap(left, right) {
  return samePath(left, right) || isStrictDescendant(left, right) || isStrictDescendant(right, left);
}

function directoryHasEntries(value) {
  try {
    return fs.statSync(value).isDirectory() && fs.readdirSync(value).length > 0;
  } catch {
    return false;
  }
}

function canonicalMigrationFile(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const relative = entry.path;
  const digest = entry.sha256;
  if (typeof relative !== "string" || relative.length === 0 || relative.length > MAX_PATH_CHARS ||
      relative.includes("\\") || relative.includes("\0") || path.posix.isAbsolute(relative) ||
      path.posix.normalize(relative) !== relative || relative === ".." || relative.startsWith("../") ||
      relative === PROFILE_MIGRATION_RECEIPT_NAME || !/^[0-9a-f]{64}$/.test(digest || "")) {
    return null;
  }
  return { path: relative, sha256: digest };
}

export function profileMigrationManifestDigest(files) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(files), "utf8")
    .digest("hex");
}

export function validateProfileMigrationReceipt(receipt, { source, destination } = {}) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) ||
      receipt.kind !== PROFILE_MIGRATION_RECEIPT_KIND ||
      receipt.version !== PROFILE_MIGRATION_RECEIPT_VERSION ||
      typeof receipt.migratedAt !== "string" || !Number.isFinite(Date.parse(receipt.migratedAt)) ||
      typeof receipt.source !== "string" || typeof receipt.destination !== "string" ||
      !path.isAbsolute(receipt.source) || !path.isAbsolute(receipt.destination) ||
      !Array.isArray(receipt.files) || !/^[0-9a-f]{64}$/.test(receipt.manifestSha256 || "")) {
    return false;
  }
  if ((source && !samePath(path.resolve(receipt.source), path.resolve(source))) ||
      (destination && !samePath(path.resolve(receipt.destination), path.resolve(destination)))) {
    return false;
  }
  const files = receipt.files.map(canonicalMigrationFile);
  if (files.some(entry => entry === null)) return false;
  const paths = files.map(entry => entry.path);
  if (new Set(paths).size !== paths.length || paths.some((value, index) => index > 0 && paths[index - 1] >= value)) {
    return false;
  }
  return profileMigrationManifestDigest(files) === receipt.manifestSha256;
}

function hasMatchingMigrationReceipt(source, destination) {
  try {
    const receiptPath = path.join(destination, PROFILE_MIGRATION_RECEIPT_NAME);
    const stat = fs.statSync(receiptPath);
    if (!stat.isFile() || stat.size < 2 || stat.size > 1024 * 1024) return false;
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    if (!validateProfileMigrationReceipt(receipt, { source, destination })) return false;
    const sourceFiles = [];
    const visit = folder => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) {
          if (!visit(full)) return false;
        }
        else if (entry.isFile()) {
          const relative = path.relative(source, full).replaceAll("\\", "/");
          if (relative === PROFILE_MIGRATION_RECEIPT_NAME) return false;
          sourceFiles.push({
            path: relative,
            sha256: crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex")
          });
        } else {
          throw new Error("legacy migration source contains an unsupported entry");
        }
      }
      return true;
    };
    if (!visit(source)) return false;
    sourceFiles.sort((left, right) => left.path < right.path ? -1 : (left.path > right.path ? 1 : 0));
    if (JSON.stringify(sourceFiles) !== JSON.stringify(receipt.files)) return false;
    if (receipt.files.length > 0) {
      const activeEntries = fs.readdirSync(destination)
        .filter(name => name !== PROFILE_MIGRATION_RECEIPT_NAME &&
          !isDataRootLockArtifactName(name));
      if (activeEntries.length === 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function parseBoolean(environ, name, fallback = false) {
  const normalized = boundedEnvironmentValue(environ, name, 16).trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  if (!normalized) return fallback;
  throw new RuntimeConfigurationError(`${name} must be true or false`);
}

function defaultHermesHome(environ) {
  if (process.platform === "win32") {
    const localAppData = boundedEnvironmentValue(environ, "LOCALAPPDATA", MAX_PATH_CHARS).trim();
    return localAppData
      ? resolvePhysicalPath(path.join(canonicalHome(localAppData, "LOCALAPPDATA"), "hermes"))
      : resolvePhysicalPath(path.resolve(os.homedir(), "AppData", "Local", "hermes"));
  }
  return resolvePhysicalPath(path.resolve(os.homedir(), ".hermes"));
}

function inferProfileName(profileHome, nativeDefaultHome) {
  if (samePath(profileHome, nativeDefaultHome)) return "default";
  if (path.basename(path.dirname(profileHome)).toLowerCase() === "profiles") {
    const name = path.basename(profileHome).toLowerCase();
    if (!PROFILE_RE.test(name)) {
      throw new RuntimeConfigurationError("HERMES_HOME contains an invalid profile name");
    }
    return name;
  }
  // Hermes treats a custom HERMES_HOME as the deployment's built-in default
  // root. get_active_profile_name() therefore returns "default" unless the
  // home has the explicit <root>/profiles/<name> shape above.
  return "default";
}

/**
 * Resolve Notebook paths from the environment at call time.
 *
 * A selected Hermes profile owns `<HERMES_HOME>/notebook/**` and its exact
 * `<HERMES_HOME>/config.yaml`. Explicit paths remain supported, but cannot
 * escape or overlap that profile scope unless the conspicuous development-only
 * `DIARY_DEV_ALLOW_PROFILE_PATH_OVERRIDE=true` switch is set outside production.
 * With no HERMES_HOME, the historical checkout-local data/backups layout is
 * retained and only then may config use the native default Hermes home.
 */
export function resolveNotebookRuntime({
  environ = process.env,
  repoRoot = moduleRoot,
  allowLegacyMigration = false
} = {}) {
  const root = path.resolve(repoRoot);
  const nativeDefaultHome = defaultHermesHome(environ);
  const rawHermesHome = boundedEnvironmentValue(environ, "HERMES_HOME", MAX_PATH_CHARS).trim();
  const profileSelected = Boolean(rawHermesHome);
  const profileHome = profileSelected
    ? canonicalHome(rawHermesHome, "HERMES_HOME")
    : nativeDefaultHome;
  const profileName = inferProfileName(profileHome, nativeDefaultHome);

  const assertedName = boundedEnvironmentValue(environ, "HERMES_PROFILE_NAME", 64).trim().toLowerCase();
  if (assertedName && (!PROFILE_RE.test(assertedName) || assertedName !== profileName)) {
    throw new RuntimeConfigurationError("HERMES_PROFILE_NAME does not match HERMES_HOME");
  }

  const developmentOverride = parseBoolean(environ, "DIARY_DEV_ALLOW_PROFILE_PATH_OVERRIDE");
  if (developmentOverride && String(environ.NODE_ENV || "").trim().toLowerCase() === "production") {
    throw new RuntimeConfigurationError("profile path override is disabled in production");
  }

  const notebookRoot = path.join(profileHome, "notebook");
  const explicitData = explicitCanonicalPath(environ, "DIARY_DATA_DIR");
  const explicitBackup = explicitCanonicalPath(environ, "DIARY_BACKUP_DIR");
  const explicitConfig = explicitCanonicalPath(environ, "HERMES_CONFIG");
  const dataDir = explicitData || resolvePhysicalPath(
    profileSelected ? path.join(notebookRoot, "data") : path.join(root, "data")
  );
  const backupDir = explicitBackup || resolvePhysicalPath(
    profileSelected ? path.join(notebookRoot, "backups") : path.join(root, "backups")
  );
  const configPath = explicitConfig || resolvePhysicalPath(path.join(profileHome, "config.yaml"));

  if (profileSelected && !developmentOverride) {
    if (!isStrictDescendant(dataDir, notebookRoot)) {
      throw new RuntimeConfigurationError("DIARY_DATA_DIR is outside the selected profile Notebook scope");
    }
    if (!isStrictDescendant(backupDir, notebookRoot)) {
      throw new RuntimeConfigurationError("DIARY_BACKUP_DIR is outside the selected profile Notebook scope");
    }
    if (!samePath(configPath, path.join(profileHome, "config.yaml"))) {
      throw new RuntimeConfigurationError("HERMES_CONFIG is outside the selected profile config scope");
    }
  }
  if (pathsOverlap(dataDir, backupDir)) {
    throw new RuntimeConfigurationError("DIARY_DATA_DIR and DIARY_BACKUP_DIR must not overlap");
  }

  if (profileSelected && !allowLegacyMigration) {
    const legacyData = path.join(root, "data");
    const legacyBackups = path.join(root, "backups");
    const dataHasLegacyState = !samePath(dataDir, legacyData) && directoryHasEntries(legacyData);
    const backupsHaveLegacyState = !samePath(backupDir, legacyBackups) && directoryHasEntries(legacyBackups);
    const dataNeedsMigration = dataHasLegacyState && !hasMatchingMigrationReceipt(legacyData, dataDir);
    const backupsNeedMigration = backupsHaveLegacyState &&
      !hasMatchingMigrationReceipt(legacyBackups, backupDir);
    if (dataNeedsMigration || backupsNeedMigration) {
      const targetConflict = (dataNeedsMigration && directoryHasEntries(dataDir)) ||
        (backupsNeedMigration && directoryHasEntries(backupDir));
      throw new RuntimeConfigurationError(
        targetConflict
          ? "Legacy checkout Notebook state conflicts with a populated profile target that has no valid " +
            "migration receipt; stop the bridge and reconcile the state manually before starting this version"
          : "Legacy checkout Notebook state exists while the selected profile target is empty; " +
            "stop the bridge and run `npm run migrate:profile` before starting this version"
      );
    }
  }

  return Object.freeze({
    profileSelected,
    profileName,
    profileHome,
    notebookRoot,
    dataDir,
    backupDir,
    configPath,
    developmentOverride
  });
}

function parseLoopbackHost(raw) {
  let host = String(raw || "").trim().toLowerCase();
  if (host === "localhost") host = DEFAULT_ADAPTER_HOST;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const family = net.isIP(host);
  if ((family === 4 && !host.startsWith("127.")) || (family === 6 && host !== "::1") || family === 0) {
    throw new RuntimeConfigurationError("Kindle adapter host must be a literal loopback address");
  }
  return host;
}

function parsePort(raw, name) {
  if (!/^[0-9]{1,5}$/.test(String(raw || "").trim())) {
    throw new RuntimeConfigurationError(`${name} must be an integer port`);
  }
  const value = Number(raw);
  if (value < 1 || value > 65535) throw new RuntimeConfigurationError(`${name} is outside the valid port range`);
  return value;
}

function parseReplyTimeout(environ) {
  const raw = boundedEnvironmentValue(environ, "KINDLE_REPLY_TIMEOUT", 32).trim() || String(DEFAULT_REPLY_TIMEOUT);
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,3}))?$/.exec(raw);
  if (!match) {
    throw new RuntimeConfigurationError("KINDLE_REPLY_TIMEOUT must be between 0.01 and 300 seconds");
  }
  const milliseconds = BigInt(match[1]) * 1000n + BigInt((match[2] || "").padEnd(3, "0") || "0");
  if (milliseconds < 10n || milliseconds > 300000n) {
    throw new RuntimeConfigurationError("KINDLE_REPLY_TIMEOUT must be between 0.01 and 300 seconds");
  }
  return Number(milliseconds);
}

function parseAdapterTimeout(environ, replyTimeoutMs) {
  const minimum = replyTimeoutMs + ADAPTER_TIMEOUT_MARGIN_MS;
  const raw = boundedEnvironmentValue(
    environ,
    "DIARY_ADAPTER_TIMEOUT_MS",
    10
  ).trim();
  if (!raw) return minimum;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new RuntimeConfigurationError(
      "DIARY_ADAPTER_TIMEOUT_MS must be a bounded integer number of milliseconds"
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > MAX_ADAPTER_TIMEOUT_MS) {
    throw new RuntimeConfigurationError(
      `DIARY_ADAPTER_TIMEOUT_MS must be between ${minimum} and ` +
      `${MAX_ADAPTER_TIMEOUT_MS} milliseconds (KINDLE_REPLY_TIMEOUT plus the ` +
      `${ADAPTER_TIMEOUT_MARGIN_MS} ms bridge margin)`
    );
  }
  return value;
}

function compactSortedUtf8Json(payload) {
  return `{${Object.keys(payload).sort().map(key => {
    const value = payload[key];
    return `${JSON.stringify(key)}:${JSON.stringify(value)}`;
  }).join(",")}}`;
}

function pythonNormalizedProfileHome(profileHome) {
  const normalized = process.platform === "win32"
    ? path.win32.normalize(profileHome).toLowerCase()
    : path.normalize(profileHome);
  return normalized.replace(/\\/g, "/");
}

/**
 * Reproduce kindle-plugin/adapter.py's owner fingerprint byte-for-byte.
 * Python uses sorted compact UTF-8 JSON (ensure_ascii=False),
 * normcase(profile_home), integer reply_timeout_ms, and a SHA-256 token digest
 * (never the token). test/fixtures/kindle-owner-fingerprint.json is the shared
 * Python/Node byte-contract fixture.
 */
export function notebookOwnerCanonicalJson({
  profileName,
  profileHome,
  host,
  port,
  user,
  insecure,
  replyTimeoutMs,
  token
}) {
  const payload = {
    service: NOTEBOOK_SERVICE,
    version: NOTEBOOK_VERSION,
    profile_name: profileName,
    profile_home: pythonNormalizedProfileHome(profileHome),
    host,
    port,
    user_id: user,
    insecure,
    reply_timeout_ms: replyTimeoutMs,
    token_fingerprint: token
      ? crypto.createHash("sha256").update(token, "utf8").digest("hex")
      : "insecure-loopback"
  };
  return compactSortedUtf8Json(payload);
}

export function notebookOwnerFingerprint(identity) {
  return crypto.createHash("sha256")
    .update(notebookOwnerCanonicalJson(identity), "utf8")
    .digest("hex");
}

export function resolveAdapterRuntime(runtime, environ = process.env) {
  const configuredHost = parseLoopbackHost(
    boundedEnvironmentValue(environ, "KINDLE_INGEST_HOST", 64).trim() || DEFAULT_ADAPTER_HOST
  );
  const configuredPort = parsePort(
    boundedEnvironmentValue(environ, "KINDLE_INGEST_PORT", 8).trim() || String(DEFAULT_ADAPTER_PORT),
    "KINDLE_INGEST_PORT"
  );
  const rawUrl = boundedEnvironmentValue(environ, "KINDLE_ADAPTER_URL", MAX_URL_CHARS).trim();
  const urlLiteralHost = configuredHost.includes(":") ? `[${configuredHost}]` : configuredHost;
  const ingestUrl = new URL(rawUrl || `http://${urlLiteralHost}:${configuredPort}/ingest`);
  if (ingestUrl.protocol !== "http:" || ingestUrl.username || ingestUrl.password || ingestUrl.search || ingestUrl.hash) {
    throw new RuntimeConfigurationError("KINDLE_ADAPTER_URL must be a plain loopback HTTP URL");
  }
  const urlHost = parseLoopbackHost(ingestUrl.hostname);
  const urlPort = parsePort(ingestUrl.port || "80", "KINDLE_ADAPTER_URL port");
  if (urlHost !== configuredHost || urlPort !== configuredPort) {
    throw new RuntimeConfigurationError("KINDLE_ADAPTER_URL does not match the configured adapter listener");
  }

  const token = boundedEnvironmentValue(environ, "KINDLE_INGEST_TOKEN", MAX_TOKEN_CHARS).trim();
  const insecure = parseBoolean(environ, "KINDLE_INSECURE");
  const user = boundedEnvironmentValue(environ, "KINDLE_USER", 128).trim() || "kindle";
  if (!USER_RE.test(user)) throw new RuntimeConfigurationError("KINDLE_USER is invalid");
  const replyTimeoutMs = parseReplyTimeout(environ);
  const adapterTimeoutMs = parseAdapterTimeout(environ, replyTimeoutMs);
  const ownerFingerprint = notebookOwnerFingerprint({
    profileName: runtime.profileName,
    profileHome: runtime.profileHome,
    host: configuredHost,
    port: configuredPort,
    user,
    insecure,
    replyTimeoutMs,
    token
  });
  const healthUrl = new URL("/health", ingestUrl);

  return Object.freeze({
    ingestUrl: ingestUrl.href,
    healthUrl: healthUrl.href,
    host: configuredHost,
    port: configuredPort,
    token,
    insecure,
    user,
    replyTimeoutMs,
    adapterTimeoutMs,
    ownerFingerprint
  });
}
