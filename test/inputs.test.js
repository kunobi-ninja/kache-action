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

test("getCacheDir falls back to an absolute per-OS path ending in 'kache'", () => {
  const dir = utils.getCacheDir();
  assert.ok(path.isAbsolute(dir));
  assert.ok(dir.endsWith(`${path.sep}kache`), dir);
  assert.ok(dir.startsWith(os.homedir()));
});

test("node-cache derives a stable job-scoped runtime dir", () => {
  process.env["INPUT_NODE-CACHE"] = "true";
  process.env.RUNNER_TEMP = "/runner/temp";
  process.env.GITHUB_RUN_ID = "42";
  process.env.GITHUB_RUN_ATTEMPT = "2";
  process.env.GITHUB_JOB = "checks/rust";
  assert.equal(
    utils.getRuntimeDir(),
    path.join("/runner/temp", "kache-runtime-42-2-checks_rust")
  );
});

test("runtime-dir input and environment override node-cache derivation", () => {
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
