import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export const DATA_ROOT_LOCK_KIND = "hermes-notebook-data-root-owner";
export const DATA_ROOT_LOCK_VERSION = 2;
export const DATA_ROOT_LOCK_OWNER_FILE = "owner.json";
export const DATA_ROOT_LOCK_DIRECTORY = ".hermes-notebook-owner";
export const LINUX_PID_NAMESPACE_PATH = "/proc/self/ns/pid";

const MAX_RECEIPT_BYTES = 16 * 1024;
const MAX_PATH_CHARS = 4096;
const PROCESS_IDENTITY_RE = /^[\x21-\x7e]{1,1024}$/;
const MACHINE_BOOT_IDENTITY_RE = /^(?:darwin|linux|win32):[0-9a-f]{64}$/;
const NONCE_RE = /^[0-9a-f]{64}$/;

export class DataRootLockError extends Error {
  constructor(message = "Notebook data is already in use by another bridge") {
    super(message);
    this.name = "DataRootLockError";
  }
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function normalizedPath(value) {
  const resolved = path.normalize(path.resolve(value));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

async function canonicalDataRoot(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_CHARS || !path.isAbsolute(value)) {
    throw new DataRootLockError("Notebook data root must be a bounded absolute path");
  }
  const resolved = path.resolve(value);
  let existing = resolved;
  const missing = [];
  for (;;) {
    try {
      const physical = await fs.realpath(existing);
      return path.resolve(physical, ...missing);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new DataRootLockError("Notebook data root could not be resolved safely");
      }
    }
    const parent = path.dirname(existing);
    if (parent === existing) {
      throw new DataRootLockError("Notebook data root could not be resolved safely");
    }
    missing.unshift(path.basename(existing));
    existing = parent;
  }
}

function lockKey(dataRoot) {
  return crypto.createHash("sha256").update(normalizedPath(dataRoot), "utf8").digest("hex");
}

export async function dataRootLockPath(dataRoot) {
  const canonical = await canonicalDataRoot(dataRoot);
  return path.join(canonical, DATA_ROOT_LOCK_DIRECTORY);
}

export function isDataRootLockArtifactName(name) {
  const value = String(name || "").toLowerCase();
  return value === DATA_ROOT_LOCK_DIRECTORY || value.startsWith(`${DATA_ROOT_LOCK_DIRECTORY}.`) ||
    /^\.hermes-notebook-(?:released|stale)-[0-9a-f-]{36}$/.test(value);
}

function runFile(file, args, missingExitCodes) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024,
      timeout: 5000,
      windowsHide: true
    }, (error, stdout) => {
      if (error) {
        if (missingExitCodes.includes(error.code)) {
          resolve(null);
          return;
        }
        reject(error);
        return;
      }
      resolve(String(stdout || "").trim());
    });
  });
}

async function readBoundedText(file, maximum = 4096) {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maximum) {
      throw new Error("machine identity source is not a bounded file");
    }
    return (await handle.readFile("utf8")).trim();
  } finally {
    await handle.close();
  }
}

function machineBootDigest(platform, parts) {
  const digest = crypto.createHash("sha256")
    .update([platform, ...parts].join("\0"), "utf8")
    .digest("hex");
  return `${platform}:${digest}`;
}

export function linuxMachineBootFingerprint({ machineId, bootId, pidNamespace }) {
  const normalizedMachine = String(machineId || "").trim().toLowerCase();
  const normalizedBoot = String(bootId || "").trim().toLowerCase();
  const normalizedNamespace = String(pidNamespace || "").trim();
  if (!/^[0-9a-f]{32}$/.test(normalizedMachine) || !/^[0-9a-f-]{36}$/.test(normalizedBoot) ||
      !/^pid:\[[0-9]{1,20}\]$/.test(normalizedNamespace)) {
    throw new Error("invalid Linux machine, boot, or PID namespace identity");
  }
  return machineBootDigest("linux", [normalizedMachine, normalizedBoot, normalizedNamespace]);
}

async function linuxMachineBootIdentity() {
  let machineId = "";
  for (const candidate of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      machineId = await readBoundedText(candidate, 256);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const [bootId, pidNamespace] = await Promise.all([
    readBoundedText("/proc/sys/kernel/random/boot_id", 256),
    fs.readlink(LINUX_PID_NAMESPACE_PATH, "utf8")
  ]);
  return linuxMachineBootFingerprint({ machineId, bootId, pidNamespace });
}

async function windowsMachineBootIdentity() {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const powershell = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const command = [
    "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
    "$m=(Get-ItemProperty -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid -ErrorAction Stop).MachineGuid",
    "$b=(Get-ItemProperty -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters' -Name BootId -ErrorAction SilentlyContinue).BootId",
    "$o=Get-CimInstance Win32_OperatingSystem -ErrorAction Stop",
    "$v=[ordered]@{machine=[string]$m;bootId=[string]$b;bootTicks=$o.LastBootUpTime.ToUniversalTime().Ticks.ToString()}",
    "$v | ConvertTo-Json -Compress"
  ].join("; ");
  const output = await runFile(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    []
  );
  const parsed = JSON.parse(String(output || "").replace(/^\uFEFF/, ""));
  const machine = String(parsed?.machine || "").trim().toLowerCase();
  const bootId = String(parsed?.bootId || "").trim();
  const bootTicks = String(parsed?.bootTicks || "").trim();
  if (!/^[0-9a-f-]{32,64}$/.test(machine) || bootId.length > 32 ||
      !/^[0-9]{10,20}$/.test(bootTicks)) {
    throw new Error("invalid Windows machine or boot identity");
  }
  return machineBootDigest("win32", [machine, bootId, bootTicks]);
}

async function darwinMachineBootIdentity() {
  const [platformOutput, bootOutput] = await Promise.all([
    runFile("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], [1]),
    runFile("sysctl", ["-n", "kern.boottime"], [1])
  ]);
  const platformUuid = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(String(platformOutput || ""))?.[1]
    ?.trim().toLowerCase();
  const bootSeconds = /\bsec\s*=\s*([0-9]+)/.exec(String(bootOutput || ""))?.[1];
  if (!/^[0-9a-f-]{32,64}$/.test(platformUuid || "") || !/^[0-9]{1,20}$/.test(bootSeconds || "")) {
    throw new Error("invalid Darwin machine or boot identity");
  }
  return machineBootDigest("darwin", [platformUuid, bootSeconds]);
}

let machineBootIdentityPromise;
async function currentMachineBootIdentity() {
  if (!machineBootIdentityPromise) {
    machineBootIdentityPromise = (async () => {
      if (process.platform === "linux") return linuxMachineBootIdentity();
      if (process.platform === "win32") return windowsMachineBootIdentity();
      if (process.platform === "darwin") return darwinMachineBootIdentity();
      throw new Error("unsupported platform for machine ownership identity");
    })();
  }
  return machineBootIdentityPromise;
}

async function linuxProcessIdentity(pid) {
  try {
    const [stat, bootId] = await Promise.all([
      fs.readFile(`/proc/${pid}/stat`, "utf8"),
      fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")
    ]);
    const close = stat.lastIndexOf(")");
    if (close < 0) throw new Error("invalid proc stat");
    const fields = stat.slice(close + 1).trim().split(/\s+/);
    const startedAtTick = fields[19];
    const boot = bootId.trim().toLowerCase();
    if (!/^[0-9]+$/.test(startedAtTick || "") || !/^[0-9a-f-]{36}$/.test(boot)) {
      throw new Error("invalid proc identity");
    }
    return `linux:${boot}:${startedAtTick}`;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") {
      if (pidIsDefinitelyAbsent(pid)) return null;
      throw new Error("live Linux process identity is not visible");
    }
    throw error;
  }
}

export function pidIsDefinitelyAbsent(pid, signalProbe = process.kill) {
  if (!Number.isSafeInteger(pid) || pid < 1 || typeof signalProbe !== "function") {
    throw new Error("invalid process absence probe");
  }
  try {
    signalProbe(pid, 0);
    return false;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    if (error?.code === "EPERM") return false;
    throw error;
  }
}

async function windowsProcessIdentity(pid) {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const powershell = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const command = [
    "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
    `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    "if ($null -eq $p) { exit 3 }",
    "$v=[ordered]@{ticks=$p.StartTime.ToUniversalTime().Ticks.ToString();executable=[string]$p.Path}",
    "$v | ConvertTo-Json -Compress"
  ].join("; ");
  const output = await runFile(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    [3]
  );
  if (output === null) return null;
  const parsed = JSON.parse(output.replace(/^\uFEFF/, ""));
  return windowsProcessFingerprint(parsed);
}

export function windowsProcessFingerprint({ ticks, executable } = {}) {
  const normalizedTicks = String(ticks || "").trim();
  const rawExecutable = typeof executable === "string" ? executable : "";
  if (!/^[0-9]{10,20}$/.test(normalizedTicks) || !rawExecutable ||
      rawExecutable !== rawExecutable.trim() || rawExecutable.length > MAX_PATH_CHARS ||
      !path.win32.isAbsolute(rawExecutable)) {
    throw new Error("Windows process identity requires start ticks and a bounded absolute executable path");
  }
  const normalizedExecutable = path.win32.normalize(rawExecutable).toLowerCase();
  const executableDigest = crypto.createHash("sha256")
    .update(normalizedExecutable, "utf8")
    .digest("hex");
  return `win32:${normalizedTicks}:${executableDigest}`;
}

async function portableProcessIdentity(pid) {
  const output = await runFile("ps", ["-p", String(pid), "-o", "lstart=", "-o", "comm="], [1]);
  if (output === null || !output) return null;
  return `${process.platform}:${crypto.createHash("sha256").update(output, "utf8").digest("hex")}`;
}

async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  if (process.platform === "linux") return linuxProcessIdentity(pid);
  if (process.platform === "win32") return windowsProcessIdentity(pid);
  return portableProcessIdentity(pid);
}

function validReceipt(value) {
  const expectedKeys = [
    "createdAt", "dataRoot", "kind", "lockKey", "machineBootIdentity", "nonce", "pid",
    "processIdentity", "version"
  ];
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === expectedKeys.join("\0") &&
    value.kind === DATA_ROOT_LOCK_KIND && value.version === DATA_ROOT_LOCK_VERSION &&
    Number.isSafeInteger(value.pid) && value.pid > 0 &&
    typeof value.nonce === "string" && NONCE_RE.test(value.nonce) &&
    typeof value.processIdentity === "string" && PROCESS_IDENTITY_RE.test(value.processIdentity) &&
    typeof value.dataRoot === "string" && value.dataRoot.length > 0 && value.dataRoot.length <= MAX_PATH_CHARS &&
    path.isAbsolute(value.dataRoot) && typeof value.lockKey === "string" && /^[0-9a-f]{64}$/.test(value.lockKey) &&
    typeof value.machineBootIdentity === "string" &&
    MACHINE_BOOT_IDENTITY_RE.test(value.machineBootIdentity) &&
    typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt));
}

function exactReceipt(left, right) {
  return Boolean(validReceipt(left) && validReceipt(right)) &&
    left.kind === right.kind && left.version === right.version && left.pid === right.pid &&
    left.nonce === right.nonce && left.processIdentity === right.processIdentity &&
    left.machineBootIdentity === right.machineBootIdentity &&
    samePath(left.dataRoot, right.dataRoot) && left.lockKey === right.lockKey &&
    left.createdAt === right.createdAt;
}

function constantTimeTextEqual(left, right) {
  const digest = value => crypto.createHash("sha256").update(String(value), "utf8").digest();
  return crypto.timingSafeEqual(digest(left), digest(right));
}

async function readReceipt(folder) {
  const receiptPath = path.join(folder, DATA_ROOT_LOCK_OWNER_FILE);
  const stat = await fs.stat(receiptPath);
  if (!stat.isFile() || stat.size < 2 || stat.size > MAX_RECEIPT_BYTES) {
    throw new DataRootLockError("Notebook data ownership receipt is invalid");
  }
  const parsed = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  if (!validReceipt(parsed)) throw new DataRootLockError("Notebook data ownership receipt is invalid");
  return parsed;
}

async function writeReceipt(folder, receipt) {
  const receiptPath = path.join(folder, DATA_ROOT_LOCK_OWNER_FILE);
  const handle = await fs.open(receiptPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function lockExists(lockPath) {
  try {
    return (await fs.stat(lockPath)).isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function inspectOwner(lockPath, canonicalRoot, localMachineBootIdentity) {
  let receipt;
  try {
    receipt = await readReceipt(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "retry" };
    return { state: "invalid", error };
  }

  if (!constantTimeTextEqual(receipt.machineBootIdentity, localMachineBootIdentity)) {
    return { state: "foreign", receipt };
  }
  if (!samePath(receipt.dataRoot, canonicalRoot) || receipt.lockKey !== lockKey(canonicalRoot)) {
    return { state: "misanchored", receipt };
  }

  let actualIdentity;
  try {
    actualIdentity = await processIdentity(receipt.pid);
  } catch {
    return { state: "uncertain" };
  }
  if (actualIdentity === null) {
    try {
      if (!pidIsDefinitelyAbsent(receipt.pid)) return { state: "uncertain", receipt };
    } catch {
      return { state: "uncertain", receipt };
    }
    return { state: "stale", receipt };
  }
  if (actualIdentity && constantTimeTextEqual(actualIdentity, receipt.processIdentity)) {
    return { state: "live", receipt };
  }
  return { state: "stale", receipt };
}

async function quarantineStaleOwner(lockPath, observed) {
  if (!validReceipt(observed)) {
    throw new DataRootLockError("Notebook data ownership receipt is invalid");
  }
  let current;
  try {
    current = await readReceipt(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new DataRootLockError("Notebook data ownership changed during recovery");
  }
  if (!exactReceipt(current, observed)) return false;

  const quarantine = path.join(path.dirname(lockPath), `.hermes-notebook-stale-${crypto.randomUUID()}`);
  try {
    await fs.rename(lockPath, quarantine);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EEXIST" || error?.code === "ENOTEMPTY") return false;
    throw new DataRootLockError("Notebook data ownership could not be recovered safely");
  }

  try {
    const moved = await readReceipt(quarantine);
    if (!exactReceipt(moved, observed)) {
      if (!(await lockExists(lockPath))) await fs.rename(quarantine, lockPath);
      throw new DataRootLockError("Notebook data ownership changed during recovery");
    }
    await fs.rm(quarantine, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error instanceof DataRootLockError) throw error;
    await fs.rm(quarantine, { recursive: true, force: true });
    return true;
  }
}

function recoveryGuardName(lockPath, staleNonce) {
  return `${lockPath}.recovery-${staleNonce}`;
}

async function recoveryGuards(lockPath) {
  const parent = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.recovery-`;
  const entries = await fs.readdir(parent, { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith(prefix) &&
      NONCE_RE.test(entry.name.slice(prefix.length)))
    .map(entry => path.join(parent, entry.name));
}

async function retireExact(folder, receipt, label) {
  const current = await readReceipt(folder).catch(() => null);
  if (!exactReceipt(current, receipt)) {
    throw new DataRootLockError(`Notebook data ownership changed before ${label}`);
  }
  const retired = path.join(
    path.dirname(folder),
    `.hermes-notebook-${label}-${crypto.randomUUID()}`
  );
  await fs.rename(folder, retired);
  const moved = await readReceipt(retired).catch(() => null);
  if (!exactReceipt(moved, receipt)) {
    if (!(await lockExists(folder))) await fs.rename(retired, folder);
    throw new DataRootLockError(`Notebook data ownership changed during ${label}`);
  }
  await fs.rm(retired, { recursive: true, force: true });
}

async function publishRecoveryGuard(lockPath, staleReceipt, ownerReceipt, claimSettleMs) {
  const guard = recoveryGuardName(lockPath, staleReceipt.nonce);
  const candidate = await fs.mkdtemp(`${lockPath}.recovery-candidate-${process.pid}-`);
  let published = false;
  try {
    await writeReceipt(candidate, ownerReceipt);
    if (await lockExists(guard)) {
      throw new DataRootLockError("Notebook data ownership recovery is already in progress");
    }
    try {
      await fs.rename(candidate, guard);
      published = true;
    } catch (error) {
      if (["EEXIST", "ENOTEMPTY", "EPERM"].includes(error?.code) && await lockExists(guard)) {
        throw new DataRootLockError("Notebook data ownership recovery is already in progress");
      }
      throw error;
    }
    await delay(claimSettleMs);
    const settled = await readReceipt(guard).catch(() => null);
    if (!exactReceipt(settled, ownerReceipt)) {
      throw new DataRootLockError("Notebook data ownership recovery guard changed during acquisition");
    }
    return {
      path: guard,
      async release() {
        await retireExact(guard, ownerReceipt, "released");
      }
    };
  } finally {
    if (!published) await fs.rm(candidate, { recursive: true, force: true });
  }
}

class DataRootLock {
  constructor(lockPath, receipt) {
    this.lockPath = lockPath;
    this.receipt = Object.freeze({ ...receipt });
    this.released = false;
  }

  async release() {
    if (this.released) return;
    await retireExact(this.lockPath, this.receipt, "released");
    this.released = true;
  }
}

export async function acquireDataRootLock(dataRoot, {
  claimSettleMs = 50,
  afterStaleObserved = async () => {}
} = {}) {
  const canonicalRoot = await canonicalDataRoot(dataRoot);
  const localMachineBootIdentity = await currentMachineBootIdentity().catch(() => null);
  if (!localMachineBootIdentity || !MACHINE_BOOT_IDENTITY_RE.test(localMachineBootIdentity)) {
    throw new DataRootLockError("Notebook data ownership could not verify this machine and boot");
  }
  const ownerIdentity = await processIdentity(process.pid).catch(() => null);
  if (!ownerIdentity || !PROCESS_IDENTITY_RE.test(ownerIdentity)) {
    throw new DataRootLockError("Notebook data ownership could not verify this process");
  }
  await fs.mkdir(canonicalRoot, { recursive: true });
  const target = await dataRootLockPath(canonicalRoot);
  const nonce = crypto.randomBytes(32).toString("hex");
  const receipt = {
    kind: DATA_ROOT_LOCK_KIND,
    version: DATA_ROOT_LOCK_VERSION,
    pid: process.pid,
    nonce,
    processIdentity: ownerIdentity,
    machineBootIdentity: localMachineBootIdentity,
    dataRoot: canonicalRoot,
    lockKey: lockKey(canonicalRoot),
    createdAt: new Date().toISOString()
  };
  const candidate = await fs.mkdtemp(`${target}.candidate-${process.pid}-`);
  let claimed = false;
  try {
    await writeReceipt(candidate, receipt);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await recoveryGuards(target)).length > 0) {
        throw new DataRootLockError("Notebook data ownership recovery is incomplete");
      }
      if (await lockExists(target)) {
        try {
          await readReceipt(target);
        } catch {
          throw new DataRootLockError("Notebook data ownership receipt is invalid");
        }
      }
      try {
        await fs.rename(candidate, target);
        claimed = true;
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error?.code) || !(await lockExists(target))) {
          throw error;
        }
        const owner = await inspectOwner(target, canonicalRoot, localMachineBootIdentity);
        if (["live", "uncertain", "foreign", "misanchored"].includes(owner.state)) {
          throw new DataRootLockError();
        }
        if (owner.state === "invalid") {
          throw new DataRootLockError("Notebook data ownership receipt is invalid");
        }
        if (owner.state === "stale") {
          await afterStaleObserved(Object.freeze({ ...owner.receipt }));
          const guard = await publishRecoveryGuard(target, owner.receipt, receipt, claimSettleMs);
          try {
            const finalOwner = await readReceipt(target).catch(() => null);
            if (!exactReceipt(finalOwner, owner.receipt)) continue;
            const finalState = await inspectOwner(target, canonicalRoot, localMachineBootIdentity);
            if (finalState.state !== "stale" || !exactReceipt(finalState.receipt, owner.receipt)) {
              throw new DataRootLockError();
            }
            if (!(await quarantineStaleOwner(target, owner.receipt))) continue;

            for (let recoveryAttempt = 0; recoveryAttempt < 20; recoveryAttempt += 1) {
              try {
                await fs.rename(candidate, target);
                claimed = true;
                break;
              } catch (claimError) {
                if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(claimError?.code) ||
                    !(await lockExists(target))) {
                  throw claimError;
                }
                await delay(5 + recoveryAttempt * 2);
              }
            }
            if (!claimed) throw new DataRootLockError("Notebook data ownership remained contended");
            await delay(claimSettleMs);
            const recovered = await readReceipt(target).catch(() => null);
            if (!exactReceipt(recovered, receipt)) {
              throw new DataRootLockError("Notebook data ownership changed during recovery");
            }
          } finally {
            await guard.release();
          }
          const recovered = await readReceipt(target).catch(() => null);
          if (!exactReceipt(recovered, receipt)) {
            throw new DataRootLockError("Notebook data ownership changed after recovery");
          }
          return new DataRootLock(target, receipt);
        }
        await delay(5 + attempt * 2);
        continue;
      }

      await delay(claimSettleMs);
      const settled = await readReceipt(target).catch(() => null);
      if (!exactReceipt(settled, receipt)) {
        throw new DataRootLockError("Notebook data ownership changed during acquisition");
      }
      if ((await recoveryGuards(target)).length > 0) {
        await retireExact(target, receipt, "released");
        claimed = false;
        throw new DataRootLockError("Notebook data ownership recovery raced with acquisition");
      }
      return new DataRootLock(target, receipt);
    }
    throw new DataRootLockError("Notebook data ownership remained contended");
  } finally {
    if (!claimed) await fs.rm(candidate, { recursive: true, force: true });
  }
}
