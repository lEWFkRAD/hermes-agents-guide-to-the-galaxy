import crypto from "node:crypto";

const MAX_SECRET_CHARS = 4096;
const REMOTE_BOOKMARK = /^\/remote\/([^/]+)(?:\/live)?\/?$/;

function configuredSecret(value, name) {
  const secret = String(value || "");
  if (secret.length > MAX_SECRET_CHARS) throw new Error(`${name} is too long`);
  return secret;
}

function requestUrl(req) {
  try {
    return new URL(String(req.url || "/"), "http://diary.local");
  } catch {
    return new URL("http://diary.local/");
  }
}

function sameSecret(actual, expected) {
  if (!expected) return false;
  const digest = value => crypto.createHash("sha256").update(String(value || ""), "utf8").digest();
  return crypto.timingSafeEqual(digest(actual), digest(expected));
}

export function requestRemoteIp(req) {
  return String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
}

export function isRemoteBookmarkRequest(req) {
  return REMOTE_BOOKMARK.test(requestUrl(req).pathname);
}

export function parseDeviceKeys(raw) {
  try { return JSON.parse(raw || "[]"); }
  catch { throw new Error("DIARY_DEVICE_KEYS must contain valid JSON"); }
}

export function createRequestAuthPolicy({
  authToken = "",
  remoteAccessKey = "",
  deviceKeys = []
} = {}) {
  const diarySecret = configuredSecret(authToken, "DIARY_AUTH_TOKEN");
  const remoteSecret = configuredSecret(remoteAccessKey, "DIARY_REMOTE_KEY");
  if (!Array.isArray(deviceKeys) || deviceKeys.length > 32) throw new Error("DIARY_DEVICE_KEYS must contain at most 32 devices");
  const deviceIds = new Set(), deviceSecrets = new Set();
  const activeDeviceSecrets = [];
  for (const device of deviceKeys) {
    if (!device || !/^[A-Za-z0-9_-]{1,64}$/.test(device.id || "") || deviceIds.has(device.id) ||
        typeof device.key !== "string" || device.key.length < 32 || device.key.length > MAX_SECRET_CHARS ||
        deviceSecrets.has(device.key) || device.key === diarySecret || device.key === remoteSecret || (device.revoked !== undefined && typeof device.revoked !== "boolean")) {
      throw new Error("DIARY_DEVICE_KEYS has an invalid or duplicate device");
    }
    deviceIds.add(device.id); deviceSecrets.add(device.key);
    if (!device.revoked) activeDeviceSecrets.push(device.key);
  }
  const remoteSecrets = [...(remoteSecret ? [remoteSecret] : []), ...activeDeviceSecrets];
  if (!diarySecret && !remoteSecrets.length) {
    throw new Error("DIARY_AUTH_TOKEN or DIARY_REMOTE_KEY is required");
  }

  function remoteCredentialOk(req) {
    const matches = value => remoteSecrets.reduce((ok, key) => sameSecret(value, key) || ok, false);
    if (matches(req.headers?.["x-diary-remote-key"])) return true;
    const url = requestUrl(req);
    if (matches(url.searchParams.get("rk"))) return true;
    const match = REMOTE_BOOKMARK.exec(url.pathname);
    if (!match) return false;
    try {
      return matches(decodeURIComponent(match[1]));
    } catch {
      return false;
    }
  }

  function diaryCredentialOk(req) {
    if (!diarySecret) return false;
    if (sameSecret(req.headers?.["x-diary-auth"], diarySecret)) return true;
    for (const cookie of String(req.headers?.cookie || "").split(";")) {
      const [name, ...value] = cookie.trim().split("=");
      try {
        if (name === "diary_auth" && sameSecret(decodeURIComponent(value.join("=")), diarySecret)) {
          return true;
        }
      } catch {}
    }
    return sameSecret(requestUrl(req).searchParams.get("k"), diarySecret);
  }

  function diaryPairingOk(req) {
    return sameSecret(requestUrl(req).searchParams.get("k"), diarySecret);
  }

  function protectedRequestOk(req) {
    // A local reverse proxy can represent public traffic as loopback. Every
    // browser-facing API therefore requires an explicit capability regardless
    // of peer IP, Host, Origin, or forwarding headers.
    return remoteCredentialOk(req) || diaryCredentialOk(req);
  }

  function livePublisherOk(req, liveWriteToken) {
    const pathname = requestUrl(req).pathname;
    const ip = requestRemoteIp(req);
    const loopback = ip === "127.0.0.1" || ip === "::1";
    return req.method === "PUT" && pathname === "/api/live-page" && loopback &&
      sameSecret(req.headers?.["x-diary-live-write"], liveWriteToken);
  }

  return Object.freeze({
    authRequired: true,
    remoteMode: remoteSecrets.length > 0,
    diaryCredentialOk,
    diaryPairingOk,
    livePublisherOk,
    protectedRequestOk,
    remoteCredentialOk
  });
}
