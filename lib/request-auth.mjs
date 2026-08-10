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

export function createRequestAuthPolicy({
  authToken = "",
  remoteAccessKey = ""
} = {}) {
  const diarySecret = configuredSecret(authToken, "DIARY_AUTH_TOKEN");
  const remoteSecret = configuredSecret(remoteAccessKey, "DIARY_REMOTE_KEY");
  if (!diarySecret && !remoteSecret) {
    throw new Error("DIARY_AUTH_TOKEN or DIARY_REMOTE_KEY is required");
  }

  function remoteCredentialOk(req) {
    if (!remoteSecret) return false;
    if (sameSecret(req.headers?.["x-diary-remote-key"], remoteSecret)) return true;
    const url = requestUrl(req);
    if (sameSecret(url.searchParams.get("rk"), remoteSecret)) return true;
    const match = REMOTE_BOOKMARK.exec(url.pathname);
    if (!match) return false;
    try {
      return sameSecret(decodeURIComponent(match[1]), remoteSecret);
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
    remoteMode: Boolean(remoteSecret),
    diaryCredentialOk,
    diaryPairingOk,
    livePublisherOk,
    protectedRequestOk,
    remoteCredentialOk
  });
}
