// A GitHub Actions cache entry is immutable. After a restore that matched the
// exact key, the post step skips the save instead of compressing the whole
// cache directory only to be rejected.
const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cache = require("@actions/cache");
const utils = require("../src/utils");

const originalSaveCache = cache.saveCache;
const created = [];

afterEach(() => {
  cache.saveCache = originalSaveCache;
  delete process.env.KACHE_EFFECTIVE_CACHE_DIR;
  while (created.length) fs.rmSync(created.pop(), { recursive: true, force: true });
});

test("only a restore that matched the exact key makes the save redundant", () => {
  const key = "kache-v0.19.0-linux-x64-0123456789abcdef";
  assert.equal(utils.ghCacheSaveIsRedundant(key, key), true);
  // A restore-key (prefix) match restored an older entry: save the new key.
  assert.equal(utils.ghCacheSaveIsRedundant("kache-v0.19.0-linux-x64-fedcba9876543210", key), false);
  assert.equal(utils.ghCacheSaveIsRedundant("", key), false);
  assert.equal(utils.ghCacheSaveIsRedundant(undefined, key), false);
});

test("saveCache uploads nothing after an exact restore and saves otherwise", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kache-save-"));
  created.push(dir);
  process.env.KACHE_EFFECTIVE_CACHE_DIR = dir;
  const saved = [];
  cache.saveCache = async (paths, key) => {
    saved.push(key);
    return 1;
  };
  const { key } = await utils.buildCacheKey();

  await utils.saveCache(key);
  assert.deepEqual(saved, [], "an exact restore must not compress and upload again");

  await utils.saveCache(`${key}-older`);
  assert.deepEqual(saved, [key]);

  await utils.saveCache(undefined);
  assert.deepEqual(saved, [key, key]);
});
