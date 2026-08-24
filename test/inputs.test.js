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
  delete process.env.KACHE_CACHE_DIR;
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

test("getCacheDir falls back to an absolute per-OS path ending in 'kache'", () => {
  const dir = utils.getCacheDir();
  assert.ok(path.isAbsolute(dir));
  assert.ok(dir.endsWith(`${path.sep}kache`), dir);
  assert.ok(dir.startsWith(os.homedir()));
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
