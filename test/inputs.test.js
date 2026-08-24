// Tests for backend-selection, cache-dir resolution, and the [no-cache] opt-out.
const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const github = require("@actions/github");
const utils = require("../src/utils");

afterEach(() => {
  delete process.env["INPUT_S3-BUCKET"];
  delete process.env["INPUT_GITHUB-CACHE"];
  delete process.env["INPUT_CACHE-DIR"];
  delete process.env["INPUT_NODE-CACHE"];
  delete process.env["INPUT_RUNTIME-DIR"];
  delete process.env.KACHE_CACHE_DIR;
  delete process.env.KACHE_EFFECTIVE_CACHE_DIR;
  delete process.env.KACHE_RUNTIME_DIR;
  delete process.env.RUNNER_TEMP;
  delete process.env.GITHUB_RUN_ID;
  delete process.env.GITHUB_RUN_ATTEMPT;
  delete process.env.GITHUB_JOB;
  github.context.payload = {};
});

test("isS3Configured reflects the s3-bucket input", () => {
  assert.equal(utils.isS3Configured(), false);
  process.env["INPUT_S3-BUCKET"] = "my-bucket";
  assert.equal(utils.isS3Configured(), true);
});

test("useGitHubCache is true only when S3 is absent and github-cache is true", () => {
  process.env["INPUT_GITHUB-CACHE"] = "true";
  assert.equal(utils.useGitHubCache(), true);

  process.env["INPUT_GITHUB-CACHE"] = "false";
  assert.equal(utils.useGitHubCache(), false);

  process.env["INPUT_GITHUB-CACHE"] = "true";
  process.env["INPUT_S3-BUCKET"] = "my-bucket"; // S3 takes precedence
  assert.equal(utils.useGitHubCache(), false);

  delete process.env["INPUT_S3-BUCKET"];
  process.env["INPUT_NODE-CACHE"] = "true";
  assert.equal(utils.useGitHubCache(), false);
});

test("local-only mode remains available when persistent backends are disabled", () => {
  process.env["INPUT_GITHUB-CACHE"] = "false";
  assert.equal(utils.isS3Configured(), false);
  assert.equal(utils.useGitHubCache(), false);
});

test("getCacheDir honors KACHE_CACHE_DIR override", () => {
  process.env.KACHE_CACHE_DIR = "/custom/cache";
  assert.equal(utils.getCacheDir(), "/custom/cache");
});

test("getCacheDir honors the cache-dir input", () => {
  process.env["INPUT_CACHE-DIR"] = "/runner/temp/kache";
  assert.equal(utils.getCacheDir(), "/runner/temp/kache");
});

test("cache-dir input takes precedence over KACHE_CACHE_DIR", () => {
  process.env.KACHE_CACHE_DIR = "/environment/cache";
  process.env["INPUT_CACHE-DIR"] = "/input/cache";
  assert.equal(utils.getCacheDir(), "/input/cache");
});

test("effective cache dir overrides the requested mounted path after fallback", () => {
  process.env["INPUT_CACHE-DIR"] = "/mounted/cache";
  process.env.KACHE_EFFECTIVE_CACHE_DIR = "/runner/temp/kache-fallback";
  assert.equal(utils.getCacheDir(), "/runner/temp/kache-fallback");
});

test("node-cache health accepts a writable store with sufficient free space", () => {
  const calls = [];
  const fakeFs = {
    mkdirSync: (...args) => calls.push(["mkdir", ...args]),
    writeFileSync: (...args) => calls.push(["write", ...args]),
    unlinkSync: (...args) => calls.push(["unlink", ...args]),
    statfsSync: () => ({ bavail: 20n, bsize: 1024n * 1024n * 1024n }),
  };
  assert.deepEqual(utils.checkNodeCacheStore("/node/cache", fakeFs), { ok: true });
  assert.equal(calls[0][0], "mkdir");
  assert.equal(calls[1][0], "write");
  assert.equal(calls[2][0], "unlink");
});

test("node-cache health fails open on read-only or disk-pressure stores", () => {
  const readOnly = {
    mkdirSync: () => {},
    writeFileSync: () => {
      throw new Error("read-only filesystem");
    },
    unlinkSync: () => {},
  };
  assert.match(
    utils.checkNodeCacheStore("/node/cache", readOnly).reason,
    /read-only/
  );

  const diskPressure = {
    mkdirSync: () => {},
    writeFileSync: () => {},
    unlinkSync: () => {},
    statfsSync: () => ({ bavail: 1n, bsize: 1024n }),
  };
  const result = utils.checkNodeCacheStore("/node/cache", diskPressure);
  assert.equal(result.ok, false);
  assert.match(result.reason, /free bytes/);
});

test("node-cache fallback remains eligible for ordinary GitHub cache", () => {
  process.env["INPUT_NODE-CACHE"] = "true";
  process.env["INPUT_GITHUB-CACHE"] = "true";
  assert.equal(utils.useGitHubCache(true), false);
  assert.equal(utils.useGitHubCache(false), true);
});

test("node-cache fallback path is job-local", () => {
  process.env.RUNNER_TEMP = "/runner/temp";
  assert.equal(
    utils.nodeCacheFallbackDir(),
    path.join("/runner/temp", "kache-fallback")
  );
});

test("getCacheDir falls back to an absolute per-OS path ending in 'kache'", () => {
  const dir = utils.getCacheDir();
  assert.ok(path.isAbsolute(dir));
  assert.ok(dir.endsWith(`${path.sep}kache`), dir);
  assert.ok(dir.startsWith(os.homedir()));
});

test("every Actions job derives a stable job-scoped runtime dir", () => {
  process.env.RUNNER_TEMP = "/runner/temp";
  process.env.GITHUB_RUN_ID = "42";
  process.env.GITHUB_RUN_ATTEMPT = "2";
  process.env.GITHUB_JOB = "checks/rust";
  assert.equal(
    utils.getRuntimeDir(),
    path.join("/runner/temp", "kache-runtime-42-2-checks_rust")
  );
});

test("runtime-dir input and environment override job derivation", () => {
  process.env["INPUT_NODE-CACHE"] = "true";
  process.env.RUNNER_TEMP = "/runner/temp";
  process.env.KACHE_RUNTIME_DIR = "/environment/runtime";
  assert.equal(utils.getRuntimeDir(), "/environment/runtime");
  process.env["INPUT_RUNTIME-DIR"] = "/input/runtime";
  assert.equal(utils.getRuntimeDir(), "/input/runtime");
});

test("runtime-dir can explicitly retain the compatible cache path outside node-cache mode", () => {
  process.env["INPUT_RUNTIME-DIR"] = "/cache";
  assert.equal(utils.getRuntimeDir(), "/cache");
});

test("runtime-dir stays unset outside Actions when no override is provided", () => {
  assert.equal(utils.getRuntimeDir(), "");
});

test("daemon status proves whether the installed Kache honors runtime-dir", () => {
  const runtimeDir = path.join("/runner", "temp", "runtime");
  assert.equal(
    utils.daemonStatusUsesRuntimeDir(
      `Socket: ${path.join(runtimeDir, "daemon.sock")}`,
      runtimeDir
    ),
    true
  );
  assert.equal(
    utils.daemonStatusUsesRuntimeDir("Socket: /shared/cache/daemon.sock", runtimeDir),
    false
  );
});

test("only Kache 0.15.0 has the unsafe environment-only daemon gap", () => {
  assert.equal(utils.hasUnsafeEnvOnlyDaemonVersion("v0.15.0"), true);
  assert.equal(utils.hasUnsafeEnvOnlyDaemonVersion("0.15.0"), true);
  assert.equal(utils.hasUnsafeEnvOnlyDaemonVersion("v0.14.2"), false);
  assert.equal(utils.hasUnsafeEnvOnlyDaemonVersion("v0.15.1"), false);
});

test("fork PR detection rejects fork flag and cross-repository heads", () => {
  github.context.payload = {
    pull_request: {
      head: { repo: { fork: true, full_name: "fork/repo" } },
      base: { repo: { full_name: "org/repo" } },
    },
  };
  assert.equal(utils.isForkPullRequest(), true);
  github.context.payload.pull_request.head.repo.fork = false;
  assert.equal(utils.isForkPullRequest(), true);
  github.context.payload.pull_request.head.repo.full_name = "org/repo";
  assert.equal(utils.isForkPullRequest(), false);
});

test("isNoCacheRequested detects [no-cache] in the PR body", () => {
  github.context.payload = { pull_request: { body: "fix stuff\n\n[no-cache] please" } };
  assert.equal(utils.isNoCacheRequested(), true);
});

test("isNoCacheRequested is false without the marker or without a PR", () => {
  github.context.payload = { pull_request: { body: "normal description" } };
  assert.equal(utils.isNoCacheRequested(), false);
  github.context.payload = {};
  assert.equal(utils.isNoCacheRequested(), false);
});
