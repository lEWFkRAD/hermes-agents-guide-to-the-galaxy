import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ADAPTER_TIMEOUT_MARGIN_MS,
  notebookOwnerCanonicalJson,
  notebookOwnerFingerprint,
  RuntimeConfigurationError,
  resolveAdapterRuntime,
  resolveNotebookRuntime
} from "../lib/runtime-profile.mjs";

async function withTemp(label, callback) {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), label));
  const root = await fs.realpath(created);
  try {
    await callback(root);
  } finally {
    await fs.rm(created, { recursive: true, force: true });
  }
}

function environment(localAppData, extra = {}) {
  return { LOCALAPPDATA: localAppData, ...extra };
}

test("legacy mode keeps checkout-local state only when HERMES_HOME is absent", async () => {
  await withTemp("notebook-legacy-", async root => {
    const repoRoot = path.join(root, "checkout");
    const localAppData = path.join(root, "Local App Data");
    const runtime = resolveNotebookRuntime({ environ: environment(localAppData), repoRoot });

    assert.equal(runtime.profileSelected, false);
    assert.equal(runtime.profileName, "default");
    assert.equal(runtime.profileHome, path.join(localAppData, "hermes"));
    assert.equal(runtime.dataDir, path.join(repoRoot, "data"));
    assert.equal(runtime.backupDir, path.join(repoRoot, "backups"));
    assert.equal(runtime.configPath, path.join(localAppData, "hermes", "config.yaml"));
  });
});

test("default and named profiles own Notebook state and exact config", async () => {
  await withTemp("notebook-profile-", async root => {
    const localAppData = path.join(root, "Local");
    const defaultHome = path.join(localAppData, "hermes");
    const namedHome = path.join(defaultHome, "profiles", "research");

    const selectedDefault = resolveNotebookRuntime({
      environ: environment(localAppData, { HERMES_HOME: defaultHome }),
      repoRoot: path.join(root, "checkout")
    });
    assert.equal(selectedDefault.profileName, "default");
    assert.equal(selectedDefault.dataDir, path.join(defaultHome, "notebook", "data"));
    assert.equal(selectedDefault.backupDir, path.join(defaultHome, "notebook", "backups"));
    assert.equal(selectedDefault.configPath, path.join(defaultHome, "config.yaml"));

    const named = resolveNotebookRuntime({
      environ: environment(localAppData, {
        HERMES_HOME: namedHome,
        HERMES_PROFILE_NAME: "research"
      }),
      repoRoot: path.join(root, "checkout")
    });
    assert.equal(named.profileName, "research");
    assert.equal(named.dataDir, path.join(namedHome, "notebook", "data"));
    assert.equal(named.configPath, path.join(namedHome, "config.yaml"));
    assert.notEqual(named.dataDir, selectedDefault.dataDir);
  });
});

test("custom profile homes and Unicode paths retain canonical ownership", async () => {
  await withTemp("notebook-unicode-", async root => {
    const localAppData = path.join(root, "Local");
    const customHome = path.join(root, "Hermes Profiles", "Études 東京");
    const dataDir = path.join(customHome, "notebook", "données manuscrites");
    const backupDir = path.join(customHome, "notebook", "copies 東京");
    const runtime = resolveNotebookRuntime({
      environ: environment(localAppData, {
        HERMES_HOME: customHome,
        HERMES_PROFILE_NAME: "default",
        DIARY_DATA_DIR: dataDir,
        DIARY_BACKUP_DIR: backupDir,
        HERMES_CONFIG: path.join(customHome, "config.yaml")
      }),
      repoRoot: path.join(root, "checkout with spaces")
    });

    assert.equal(runtime.profileName, "default");
    assert.equal(runtime.profileHome, customHome);
    assert.equal(runtime.dataDir, dataDir);
    assert.equal(runtime.backupDir, backupDir);
  });
});

test("selected profiles reject escaping, ambiguous, and non-canonical roots", async () => {
  await withTemp("notebook-escape-", async root => {
    const localAppData = path.join(root, "Local");
    const home = path.join(localAppData, "hermes", "profiles", "alpha");
    const repoRoot = path.join(root, "checkout");
    const base = environment(localAppData, { HERMES_HOME: home });

    assert.throws(() => resolveNotebookRuntime({
      environ: { ...base, DIARY_DATA_DIR: path.join(root, "shared-data") }, repoRoot
    }), RuntimeConfigurationError);
    assert.throws(() => resolveNotebookRuntime({
      environ: { ...base, HERMES_CONFIG: path.join(localAppData, "hermes", "config.yaml") }, repoRoot
    }), RuntimeConfigurationError);
    assert.throws(() => resolveNotebookRuntime({
      environ: {
        ...base,
        DIARY_DATA_DIR: path.join(home, "notebook", "state"),
        DIARY_BACKUP_DIR: path.join(home, "notebook", "state", "backups")
      },
      repoRoot
    }), RuntimeConfigurationError);
    assert.throws(() => resolveNotebookRuntime({
      environ: { ...base, DIARY_DATA_DIR: `${home}${path.sep}notebook${path.sep}..${path.sep}data` }, repoRoot
    }), RuntimeConfigurationError);
    assert.throws(() => resolveNotebookRuntime({
      environ: { ...base, HERMES_PROFILE_NAME: "beta" }, repoRoot
    }), RuntimeConfigurationError);
  });
});

test("selected profile defaults reject a symlink or junction escape", async t => {
  await withTemp("notebook-link-escape-", async root => {
    const localAppData = path.join(root, "Local");
    const home = path.join(localAppData, "hermes", "profiles", "alpha");
    const notebook = path.join(home, "notebook");
    const external = path.join(root, "other-profile-data");
    await fs.mkdir(notebook, { recursive: true });
    await fs.mkdir(external, { recursive: true });
    try {
      await fs.symlink(external, path.join(notebook, "data"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        t.skip("host does not permit creating a test symlink/junction");
        return;
      }
      throw error;
    }

    assert.throws(() => resolveNotebookRuntime({
      environ: environment(localAppData, { HERMES_HOME: home }),
      repoRoot: path.join(root, "checkout")
    }), RuntimeConfigurationError);
  });
});

test("the explicit development override permits isolated external roots but never production or overlap", async () => {
  await withTemp("notebook-override-", async root => {
    const localAppData = path.join(root, "Local");
    const home = path.join(localAppData, "hermes", "profiles", "alpha");
    const externalData = path.join(root, "external", "data");
    const externalBackups = path.join(root, "external", "backups");
    const externalConfig = path.join(root, "external", "config.yaml");
    const base = environment(localAppData, {
      HERMES_HOME: home,
      DIARY_DATA_DIR: externalData,
      DIARY_BACKUP_DIR: externalBackups,
      HERMES_CONFIG: externalConfig,
      DIARY_DEV_ALLOW_PROFILE_PATH_OVERRIDE: "true"
    });

    const runtime = resolveNotebookRuntime({ environ: base, repoRoot: path.join(root, "checkout") });
    assert.equal(runtime.developmentOverride, true);
    assert.equal(runtime.dataDir, externalData);
    assert.equal(runtime.configPath, externalConfig);

    assert.throws(() => resolveNotebookRuntime({
      environ: { ...base, NODE_ENV: "production" }, repoRoot: path.join(root, "checkout")
    }), RuntimeConfigurationError);
    assert.throws(() => resolveNotebookRuntime({
      environ: { ...base, DIARY_BACKUP_DIR: path.join(externalData, "backups") },
      repoRoot: path.join(root, "checkout")
    }), RuntimeConfigurationError);
  });
});

test("a named selection never falls back to native-default profile paths", async () => {
  await withTemp("notebook-no-fallback-", async root => {
    const localAppData = path.join(root, "Local");
    const nativeHome = path.join(localAppData, "hermes");
    const selectedHome = path.join(nativeHome, "profiles", "beta");
    const runtime = resolveNotebookRuntime({
      environ: environment(localAppData, { HERMES_HOME: selectedHome }),
      repoRoot: path.join(root, "checkout")
    });

    for (const resolved of [runtime.dataDir, runtime.backupDir, runtime.configPath]) {
      assert.equal(resolved.startsWith(selectedHome + path.sep), true);
      assert.equal(resolved.startsWith(nativeHome + path.sep) && !resolved.startsWith(selectedHome + path.sep), false);
    }
  });
});

test("Node owner identity matches the adapter-owned UTF-8 canonical fixture", async () => {
  const fixture = JSON.parse(await fs.readFile(
    new URL("./fixtures/kindle-owner-fingerprint.json", import.meta.url),
    "utf8"
  ));
  const identity = {
    profileName: fixture.input.profile_name,
    profileHome: fixture.input.profile_home,
    host: fixture.input.host,
    port: fixture.input.port,
    token: fixture.input.token,
    insecure: fixture.input.insecure,
    user: fixture.input.user_id,
    replyTimeoutMs: fixture.input.reply_timeout_ms
  };

  assert.equal(notebookOwnerCanonicalJson(identity), fixture.canonical_json);
  assert.equal(notebookOwnerFingerprint(identity), fixture.expected_sha256);
  assert.match(fixture.canonical_json, /hermès\/配置/);
});

test("adapter resolution brackets IPv6 and rejects listener drift or sub-millisecond timeout", async () => {
  await withTemp("notebook-adapter-", async root => {
    const localAppData = path.join(root, "Local");
    const profile = resolveNotebookRuntime({
      environ: environment(localAppData),
      repoRoot: path.join(root, "checkout")
    });
    const ipv6 = resolveAdapterRuntime(profile, environment(localAppData, {
      KINDLE_INGEST_HOST: "::1",
      KINDLE_INGEST_PORT: "8793",
      KINDLE_INGEST_TOKEN: "fixture-token"
    }));
    assert.equal(ipv6.ingestUrl, "http://[::1]:8793/ingest");
    assert.equal(ipv6.healthUrl, "http://[::1]:8793/health");
    assert.equal(
      ipv6.adapterTimeoutMs,
      ipv6.replyTimeoutMs + ADAPTER_TIMEOUT_MARGIN_MS
    );

    const exactMilliseconds = resolveAdapterRuntime(profile, environment(localAppData, {
      KINDLE_REPLY_TIMEOUT: "1.001"
    }));
    assert.equal(exactMilliseconds.replyTimeoutMs, 1001);
    assert.equal(exactMilliseconds.adapterTimeoutMs, 6001);

    assert.throws(() => resolveAdapterRuntime(profile, environment(localAppData, {
      KINDLE_INGEST_PORT: "8793",
      KINDLE_ADAPTER_URL: "http://127.0.0.1:8794/ingest"
    })), RuntimeConfigurationError);
    assert.throws(() => resolveAdapterRuntime(profile, environment(localAppData, {
      KINDLE_REPLY_TIMEOUT: "0.0101"
    })), RuntimeConfigurationError);
    assert.throws(() => resolveAdapterRuntime(profile, environment(localAppData, {
      KINDLE_REPLY_TIMEOUT: "1e2"
    })), RuntimeConfigurationError);
    assert.throws(() => resolveAdapterRuntime(profile, environment(localAppData, {
      KINDLE_REPLY_TIMEOUT: "300.001"
    })), RuntimeConfigurationError);
  });
});

test("adapter outbound timeout is an integer with a fixed reply margin", async () => {
  await withTemp("notebook-adapter-timeout-", async root => {
    const localAppData = path.join(root, "Local");
    const profile = resolveNotebookRuntime({
      environ: environment(localAppData),
      repoRoot: path.join(root, "checkout")
    });

    const defaults = resolveAdapterRuntime(profile, environment(localAppData));
    assert.equal(defaults.replyTimeoutMs, 240000);
    assert.equal(defaults.adapterTimeoutMs, 245000);

    const exactMargin = resolveAdapterRuntime(profile, environment(localAppData, {
      KINDLE_REPLY_TIMEOUT: "1.001",
      DIARY_ADAPTER_TIMEOUT_MS: "6001"
    }));
    assert.equal(exactMargin.replyTimeoutMs, 1001);
    assert.equal(exactMargin.adapterTimeoutMs, 6001);

    for (const invalid of ["1000", "1001", "6000", "6001.0", "600001"]) {
      assert.throws(() => resolveAdapterRuntime(profile, environment(localAppData, {
        KINDLE_REPLY_TIMEOUT: "1.001",
        DIARY_ADAPTER_TIMEOUT_MS: invalid
      })), RuntimeConfigurationError);
    }
  });
});
