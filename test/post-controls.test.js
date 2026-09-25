const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DIST_SAVE = path.join(__dirname, "..", "dist", "save", "index.js");

test("save-cache and job-summary opt-outs affect the shipped post action", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kache-post-"));
  const summaryPath = path.join(dir, "summary.md");

  try {
    const result = spawnSync(process.execPath, [DIST_SAVE], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        KACHE_CACHE_DIR: dir,
        GITHUB_STEP_SUMMARY: summaryPath,
        "STATE_s3-configured": "false",
        "STATE_gh-cache": "true",
        "STATE_save-cache": "false",
        "INPUT_PR-COMMENT": "false",
        "INPUT_JOB-SUMMARY": "false",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Cache saving disabled \(save-cache: false\)/);
    assert.match(result.stdout, /Job summary disabled \(job-summary: false\)/);
    assert.equal(fs.existsSync(summaryPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the post action removes a runtime directory it created", () => {
  // The derived runtime directory lives under /tmp, not RUNNER_TEMP, so the
  // runner never cleans it; left behind, one accumulates per job on
  // self-hosted hosts.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kache-post-"));
  const runtime = path.join(dir, "runtime");
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(runtime, "daemon.log"), "");

  try {
    const result = spawnSync(process.execPath, [DIST_SAVE], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        KACHE_CACHE_DIR: dir,
        KACHE_RUNTIME_DIR: runtime,
        "STATE_runtime-dir-owned": runtime,
        "STATE_save-cache": "false",
        "INPUT_PR-COMMENT": "false",
        "INPUT_JOB-SUMMARY": "false",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(runtime), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the post action leaves a caller's runtime directory alone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kache-post-"));
  const runtime = path.join(dir, "runtime");
  fs.mkdirSync(runtime);

  try {
    const result = spawnSync(process.execPath, [DIST_SAVE], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        KACHE_CACHE_DIR: dir,
        KACHE_RUNTIME_DIR: runtime,
        "STATE_save-cache": "false",
        "INPUT_PR-COMMENT": "false",
        "INPUT_JOB-SUMMARY": "false",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(runtime), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
