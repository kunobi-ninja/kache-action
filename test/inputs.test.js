// Tests for backend-selection, cache-dir resolution, and the [no-cache] opt-out.
const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
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

// The environment of the macOS release leg that could not start its daemon.
const MAC_RUNNER = {
  RUNNER_TEMP: "/Users/zondax-ci/actions-runner/runner-3/_work/_temp",
  GITHUB_RUN_ID: "36081599948",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_JOB: "build-sign",
};
const SUN_PATH_MACOS = 103;

test("the default runtime dir keeps the daemon socket short whatever the job is called", () => {
  // The old default put the job name in the path: this runner reached exactly
  // 103 bytes for daemon.sock, and a longer job name did not fit at all.
  for (const job of ["build-sign", "a-matrix-leg-with-a-considerably-longer-job-name-than-usual"]) {
    const dir = utils.defaultRuntimeDir({ ...MAC_RUNNER, GITHUB_JOB: job }, "darwin");
    for (const socket of ["daemon.sock", "daemon.control.v2.sock"]) {
      const bytes = Buffer.byteLength(path.posix.join(dir, socket));
      assert.ok(bytes <= SUN_PATH_MACOS, `${socket} under ${dir} is ${bytes} bytes`);
    }
  }
});

test("the default runtime dir is stable for one job", () => {
  assert.equal(
    utils.defaultRuntimeDir(MAC_RUNNER, "linux"),
    utils.defaultRuntimeDir({ ...MAC_RUNNER }, "linux"),
  );
});

test("runners sharing a host get distinct default runtime dirs", () => {
  // Matrix legs share run, attempt and job, and runners on one host share
  // /tmp; only the runner's own temp directory tells two legs apart.
  const a = utils.defaultRuntimeDir(MAC_RUNNER, "darwin");
  const b = utils.defaultRuntimeDir(
    { ...MAC_RUNNER, RUNNER_TEMP: "/Users/zondax-ci/actions-runner/runner-1/_work/_temp" },
    "darwin",
  );
  assert.notEqual(a, b);
});

test("Windows keeps its runner-temp runtime layout", () => {
  process.env.GITHUB_JOB = "checks/rust";
  assert.equal(
    utils.defaultRuntimeDir(
      { RUNNER_TEMP: "/runner/temp", GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "2", GITHUB_JOB: "checks/rust" },
      "win32",
    ),
    path.join("/runner/temp", "kache-runtime-42-2-checks_rust"),
  );
});

test("a private runtime dir is created 0700 and accepted when it already is ours", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "kache-rt-"));
  try {
    const dir = path.join(parent, "runtime");
    utils.ensurePrivateDir(dir);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    utils.ensurePrivateDir(dir);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a runtime dir that is a symlink is refused", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "kache-rt-"));
  try {
    const target = path.join(parent, "elsewhere");
    fs.mkdirSync(target);
    const link = path.join(parent, "runtime");
    fs.symlinkSync(target, link);
    assert.throws(() => utils.ensurePrivateDir(link), /not a plain directory/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
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
