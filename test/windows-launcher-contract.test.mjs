import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("Windows bridge wrapper preserves profile-scoped credentials and logs", async () => {
  const source = await fs.readFile("run-diary.cmd", "utf8");
  assert.doesNotMatch(source, /reg\s+query\s+HKCU\\Environment/i);
  assert.doesNotMatch(source, /KINDLE_INGEST_TOKEN/i);
  assert.match(source, /if defined HERMES_HOME/i);
  assert.match(source, /%HERMES_HOME%\\notebook\\logs/i);
  assert.match(source, /%HERMES_NOTEBOOK_LOG_DIR%\\server\.log/i);
});

test("Windows retention helper follows the selected bridge port and auth", async () => {
  const source = await fs.readFile("archive-run.cmd", "utf8");
  assert.match(source, /process\.env\.DIARY_PORT/);
  assert.match(source, /process\.env\.DIARY_AUTH_TOKEN/);
  assert.match(source, /process\.env\.DIARY_REMOTE_KEY/);
  assert.match(source, /'x-diary-auth':diary/);
  assert.match(source, /'x-diary-remote-key':remote/);
  assert.match(source, /DIARY_AUTH_TOKEN or DIARY_REMOTE_KEY is required/);
  assert.match(source, /%HERMES_HOME%\\notebook\\logs/i);
});

test("always-on documentation does not claim fixed tasks are multi-profile ownership", async () => {
  const readme = await fs.readFile("README.md", "utf8");
  const guide = await fs.readFile("docs/USER_GUIDE.md", "utf8");
  assert.match(readme, /single-profile\s+convenience templates/i);
  assert.match(guide, /task templates are single-profile examples/i);
  assert.match(guide, /without placing secrets in task XML or command\s+arguments/i);
});
