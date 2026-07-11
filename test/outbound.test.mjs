import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { fetchWithTimeout } from "../lib/outbound.mjs";

test("a non-responsive upstream fails with a controlled timeout", async () => {
  const server = http.createServer(() => {});
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await assert.rejects(
      fetchWithTimeout(`http://127.0.0.1:${port}/hang`, {}, 30, "test upstream"),
      /test upstream timed out after 30 ms/
    );
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
