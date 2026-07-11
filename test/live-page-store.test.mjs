import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LivePageStore } from "../lib/live-page.mjs";

test("Live Page init fails closed without replacing corrupt persisted content", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "live-page-store-corrupt-"));
  const file = path.join(dataDir, "live-page.json");
  try {
    await fs.writeFile(file, "{broken", "utf8");
    const store = new LivePageStore(dataDir);

    await assert.rejects(
      store.init(),
      /Cannot load Live Page: stored Live Page is not valid JSON/
    );
    assert.equal(await fs.readFile(file, "utf8"), "{broken");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
