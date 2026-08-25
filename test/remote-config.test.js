// Tests for materializing the S3 remote in kache's watched config file.
// The daemon does not inherit KACHE_S3_* (kunobi-ninja/kache#706), so the
// action writes an action-owned TOML and selects it via KACHE_CONFIG.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  tomlString,
  renderRemoteConfigToml,
  remoteConfigPath,
  writeRemoteConfig,
  expectedRemoteDescription,
  daemonRemoteFromStats,
} = require("../src/utils");

test("tomlString escapes quotes, backslashes, and control characters", () => {
  assert.equal(tomlString("plain"), '"plain"');
  assert.equal(tomlString('has "quotes"'), '"has \\"quotes\\""');
  assert.equal(tomlString("back\\slash"), '"back\\\\slash"');
  assert.equal(tomlString("new\nline"), '"new\\nline"');
});

test("renderRemoteConfigToml emits the full remote with endpoint", () => {
  const toml = renderRemoteConfigToml({
    bucket: "sccache",
    region: "auto",
    prefix: "kache",
    endpoint: "https://s3.example.com",
    readonly: false,
  });
  assert.match(toml, /^\[cache\.remote\]$/m);
  assert.match(toml, /^type = "s3"$/m);
  assert.match(toml, /^bucket = "sccache"$/m);
  assert.match(toml, /^region = "auto"$/m);
  assert.match(toml, /^prefix = "kache"$/m);
  assert.match(toml, /^endpoint = "https:\/\/s3\.example\.com"$/m);
  assert.doesNotMatch(toml, /remote_readonly/);
});

test("renderRemoteConfigToml omits endpoint when not provided", () => {
  const toml = renderRemoteConfigToml({
    bucket: "b",
    region: "us-east-1",
    prefix: "artifacts",
    endpoint: undefined,
    readonly: false,
  });
  assert.doesNotMatch(toml, /endpoint/);
});

test("save-cache: false maps to [cache] remote_readonly = true", () => {
  const toml = renderRemoteConfigToml({
    bucket: "b",
    region: "r",
    prefix: "p",
    readonly: true,
  });
  assert.match(toml, /^\[cache\]$/m);
  assert.match(toml, /^remote_readonly = true$/m);
  // [cache] must precede [cache.remote] so the remote table is not swallowed.
  assert.ok(toml.indexOf("[cache]") < toml.indexOf("[cache.remote]"));
});

test("credentials never appear in the rendered config", () => {
  const toml = renderRemoteConfigToml({
    bucket: "b",
    region: "r",
    prefix: "p",
    endpoint: "https://e",
    readonly: true,
  });
  const configLines = toml
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n")
    .toLowerCase();
  for (const needle of ["access", "secret", "key", "credential", "token"]) {
    assert.ok(
      !configLines.includes(needle),
      `rendered config must not carry "${needle}"`,
    );
  }
});

test("remoteConfigPath is deterministic and tied to the cache dir", () => {
  assert.equal(
    remoteConfigPath("/runner/_temp/kache"),
    path.join("/runner/_temp/kache", "kache-action.toml"),
  );
  assert.equal(remoteConfigPath("/a"), remoteConfigPath("/a"));
});

test("writeRemoteConfig creates the cache dir and lands atomically", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kache-remote-config-"));
  try {
    const cacheDir = path.join(dir, "nested", "kache");
    const target = writeRemoteConfig(cacheDir, {
      bucket: "sccache",
      region: "auto",
      prefix: "kache",
      endpoint: "https://s3.example.com",
      readonly: false,
    });
    assert.equal(target, remoteConfigPath(cacheDir));
    const written = fs.readFileSync(target, "utf8");
    assert.match(written, /bucket = "sccache"/);
    // No leftover temp file from the write-then-rename.
    const leftovers = fs
      .readdirSync(cacheDir)
      .filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeRemoteConfig leaves an identical existing file untouched", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kache-remote-config-"));
  try {
    const remote = { bucket: "b", region: "r", prefix: "p", readonly: false };
    const target = writeRemoteConfig(dir, remote);
    const before = fs.statSync(target);
    writeRemoteConfig(dir, remote);
    const after = fs.statSync(target);
    assert.equal(before.ino, after.ino);
    assert.equal(before.mtimeMs, after.mtimeMs);
    // A changed remote must still land.
    writeRemoteConfig(dir, { ...remote, bucket: "other" });
    assert.match(fs.readFileSync(target, "utf8"), /bucket = "other"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("expectedRemoteDescription matches kache's describe() rendering", () => {
  assert.equal(
    expectedRemoteDescription({ bucket: "sccache", prefix: "kache" }),
    "s3://sccache/kache",
  );
  assert.equal(
    expectedRemoteDescription({ bucket: "sccache", prefix: "" }),
    "s3://sccache",
  );
});

test("daemonRemoteFromStats recognizes the expected active remote", () => {
  const stats = [
    "Daemon:     v0.15.1 (epoch 1787664243, config /tmp/kache/kache-action.toml)",
    "Remote:     s3://sccache/kache",
  ].join("\n");
  assert.deepEqual(daemonRemoteFromStats(stats, "s3://sccache/kache"), {
    ok: true,
    detail: "s3://sccache/kache",
  });
  // Without an expectation, any active remote passes.
  assert.equal(daemonRemoteFromStats(stats).ok, true);
});

test("daemonRemoteFromStats rejects a divergent remote", () => {
  const verdict = daemonRemoteFromStats(
    "Remote:     s3://other-bucket/elsewhere",
    "s3://sccache/kache",
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /expected s3:\/\/sccache\/kache/);
});

test("daemonRemoteFromStats flags offline, local-only, and misconfigured daemons", () => {
  assert.equal(daemonRemoteFromStats("Daemon:     offline").ok, false);
  assert.equal(daemonRemoteFromStats("Remote:     not configured").ok, false);
  assert.equal(
    daemonRemoteFromStats("Remote:     MISCONFIGURED — bad bucket").ok,
    false,
  );
  assert.equal(
    daemonRemoteFromStats("Remote:     local-only mode (remote + planner ignored)")
      .ok,
    false,
  );
});

test("daemonRemoteFromStats treats the client-config fallback as unverified", () => {
  const verdict = daemonRemoteFromStats(
    "Remote:     s3://sccache/kache [client config — daemon did not report its remote state]",
    "s3://sccache/kache",
  );
  assert.equal(verdict.ok, null);
});

test("daemonRemoteFromStats returns null for unrecognized output", () => {
  assert.equal(daemonRemoteFromStats("").ok, null);
  assert.equal(daemonRemoteFromStats("something else entirely").ok, null);
});
