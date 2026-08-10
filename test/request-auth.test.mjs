import assert from "node:assert/strict";
import test from "node:test";

import {
  createRequestAuthPolicy,
  isRemoteBookmarkRequest
} from "../lib/request-auth.mjs";

function request({
  url = "/api/config",
  method = "GET",
  remoteAddress = "127.0.0.1",
  headers = {}
} = {}) {
  return {
    url,
    method,
    socket: { remoteAddress },
    headers: Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
    )
  };
}

test("remote-key mode ignores Host, forwarding, trusted-IP, and open-LAN fallbacks", () => {
  const policy = createRequestAuthPolicy({
    authToken: "",
    remoteAccessKey: "remote-secret"
  });
  for (const host of ["localhost", "device.ts.net", "device.ts.net.", "attacker.invalid", ""]) {
    assert.equal(policy.protectedRequestOk(request({
      headers: {
        host,
        "x-forwarded-host": "device.ts.net",
        "x-forwarded-for": "127.0.0.1",
        forwarded: "for=127.0.0.1;host=device.ts.net"
      }
    })), false);
  }
  assert.equal(policy.authRequired, true);
  assert.equal(policy.remoteMode, true);
});

test("remote-key mode accepts only an explicit remote or diary credential", () => {
  const policy = createRequestAuthPolicy({
    authToken: "lan-secret",
    remoteAccessKey: "remote-secret"
  });
  assert.equal(policy.protectedRequestOk(request({
    headers: { "x-diary-remote-key": "remote-secret", host: "forged.invalid" }
  })), true);
  assert.equal(policy.protectedRequestOk(request({
    url: "/api/config?rk=remote-secret",
    headers: { host: "device.ts.net." }
  })), true);
  assert.equal(policy.protectedRequestOk(request({
    headers: { "x-diary-auth": "lan-secret", host: "device.ts.net" }
  })), true);
  assert.equal(policy.protectedRequestOk(request({
    headers: { cookie: "diary_auth=lan-secret" }
  })), true);
  assert.equal(policy.protectedRequestOk(request({
    headers: { "x-diary-remote-key": "wrong", "x-diary-auth": "wrong" }
  })), false);
  assert.equal(policy.diaryPairingOk(request({
    url: "/?k=wrong",
    headers: { "x-diary-auth": "lan-secret" }
  })), false);
  assert.equal(policy.diaryPairingOk(request({ url: "/?k=lan-secret" })), true);
});

test("remote bookmark authentication is host-independent and exact", () => {
  const policy = createRequestAuthPolicy({ remoteAccessKey: "remote-secret" });
  for (const url of ["/remote/remote-secret", "/remote/remote-secret/", "/remote/remote-secret/live", "/remote/remote-secret/live/"]) {
    const req = request({ url, headers: { host: "arbitrary.example." } });
    assert.equal(isRemoteBookmarkRequest(req), true);
    assert.equal(policy.remoteCredentialOk(req), true);
  }
  const wrong = request({ url: "/remote/wrong/live", headers: { host: "device.ts.net" } });
  assert.equal(isRemoteBookmarkRequest(wrong), true);
  assert.equal(policy.remoteCredentialOk(wrong), false);
  assert.equal(isRemoteBookmarkRequest(request({ url: "/remote/key/extra" })), false);
});

test("startup requires a credential and LAN mode accepts only the diary secret", () => {
  assert.throws(() => createRequestAuthPolicy(), /DIARY_AUTH_TOKEN or DIARY_REMOTE_KEY is required/);

  const protectedLan = createRequestAuthPolicy({ authToken: "lan-secret" });
  assert.equal(protectedLan.protectedRequestOk(request({ remoteAddress: "192.0.2.10" })), false);
  assert.equal(protectedLan.protectedRequestOk(request({
    remoteAddress: "192.0.2.10",
    url: "/api/config?k=lan-secret"
  })), true);
  assert.equal(protectedLan.protectedRequestOk(request({
    remoteAddress: "192.0.2.11",
    headers: { origin: "https://evil.example", host: "evil.example", "x-diary-auth": "lan-secret" }
  })), true);
});

test("Live Page publishing requires its exact loopback method, path, and capability", () => {
  const policy = createRequestAuthPolicy({ remoteAccessKey: "remote-secret" });
  const valid = request({
    method: "PUT",
    url: "/api/live-page",
    headers: { "x-diary-live-write": "publisher-secret" }
  });
  assert.equal(policy.livePublisherOk(valid, "publisher-secret"), true);
  assert.equal(policy.livePublisherOk(request({
    method: "PUT",
    url: "/api/live-page",
    headers: { "x-diary-remote-key": "remote-secret" }
  }), "publisher-secret"), false);
  assert.equal(policy.livePublisherOk({ ...valid, method: "POST" }, "publisher-secret"), false);
  assert.equal(policy.livePublisherOk({ ...valid, url: "/api/live-page/content" }, "publisher-secret"), false);
  assert.equal(policy.livePublisherOk({ ...valid, socket: { remoteAddress: "192.0.2.10" } }, "publisher-secret"), false);
});
