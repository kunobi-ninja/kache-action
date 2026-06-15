// Tests for per-platform cache-dir resolution (must match kache's dirs::cache_dir()).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const utils = require("../src/utils");

const HOME = path.join(path.sep, "home", "runner");

test("getCacheDirFor resolves Windows to %LOCALAPPDATA%\\kache", () => {
  const local = path.join("C:", "Users", "runner", "AppData", "Local");
  assert.equal(
    utils.getCacheDirFor("win32", { LOCALAPPDATA: local }, HOME),
    path.join(local, "kache")
  );
});

test("getCacheDirFor falls back to ~/AppData/Local on Windows without LOCALAPPDATA", () => {
  assert.equal(
    utils.getCacheDirFor("win32", {}, HOME),
    path.join(HOME, "AppData", "Local", "kache")
  );
});

test("getCacheDirFor resolves macOS to ~/Library/Caches/kache", () => {
  assert.equal(
    utils.getCacheDirFor("darwin", {}, HOME),
    path.join(HOME, "Library", "Caches", "kache")
  );
});

test("getCacheDirFor resolves Linux to ~/.cache/kache", () => {
  assert.equal(
    utils.getCacheDirFor("linux", {}, HOME),
    path.join(HOME, ".cache", "kache")
  );
});

test("getCacheDirFor honors KACHE_CACHE_DIR override on any platform", () => {
  assert.equal(
    utils.getCacheDirFor("win32", { KACHE_CACHE_DIR: "/custom" }, HOME),
    "/custom"
  );
});
