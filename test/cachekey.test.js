// Tests for the GitHub Actions cache-key derivation over a temp workspace.
const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const utils = require("../src/utils");

const PLATFORM = `${os.platform()}-${os.arch()}`;
const created = [];

function workspaceWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kache-ck-"));
  created.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

afterEach(() => {
  delete process.env["INPUT_CACHE-KEY-PREFIX"];
  delete process.env["INPUT_CACHE-KEY-SALT"];
  delete process.env.KACHE_VERSION;
  while (created.length) fs.rmSync(created.pop(), { recursive: true, force: true });
});

test("buildCacheKey composes prefix-version-platform-lockhash with a prefix restore key", async () => {
  process.env["INPUT_CACHE-KEY-PREFIX"] = "myprefix";
  process.env.KACHE_VERSION = "v1.2.3";
  const ws = workspaceWith({ "Cargo.lock": "lock-A" });

  const { key, restoreKeys } = await utils.buildCacheKey(ws);

  assert.match(key, new RegExp(`^myprefix-v1\\.2\\.3-${PLATFORM}-[0-9a-f]{16}$`));
  assert.deepEqual(restoreKeys, [`myprefix-v1.2.3-${PLATFORM}-`]);
  assert.ok(key.startsWith(restoreKeys[0]));
});

test("buildCacheKey hash changes when Cargo.lock content changes", async () => {
  process.env.KACHE_VERSION = "v1";
  const a = await utils.buildCacheKey(workspaceWith({ "Cargo.lock": "AAA" }));
  const b = await utils.buildCacheKey(workspaceWith({ "Cargo.lock": "BBB" }));
  assert.notEqual(a.key, b.key);
});

test("buildCacheKey is stable for identical lock content", async () => {
  process.env.KACHE_VERSION = "v1";
  const a = await utils.buildCacheKey(workspaceWith({ "Cargo.lock": "SAME" }));
  const b = await utils.buildCacheKey(workspaceWith({ "Cargo.lock": "SAME" }));
  assert.equal(a.key, b.key);
});

test("buildCacheKey uses 'no-lockfile' when no Cargo.lock exists", async () => {
  process.env.KACHE_VERSION = "v1";
  const { key } = await utils.buildCacheKey(workspaceWith({ "README.md": "x" }));
  assert.ok(key.endsWith("-no-lockfile"), key);
});

test("buildCacheKey defaults the prefix to 'kache' and version to 'unknown'", async () => {
  const { key } = await utils.buildCacheKey(workspaceWith({ "Cargo.lock": "x" }));
  assert.ok(key.startsWith(`kache-unknown-${PLATFORM}-`), key);
});

// A GitHub Actions cache entry is immutable: without a salt the store freezes at the
// first run after a lockfile or kache update and later runs cannot publish what they
// compiled. The salt must change the exact key while the restore key stays prefix-only,
// so a fresh entry is written and the newest one is still restored.
test("buildCacheKey appends cache-key-salt to the key and keeps the prefix restore key", async () => {
  process.env["INPUT_CACHE-KEY-PREFIX"] = "myprefix";
  process.env["INPUT_CACHE-KEY-SALT"] = "abcdef0123456789";
  process.env.KACHE_VERSION = "v1.2.3";

  const { key, restoreKeys } = await utils.buildCacheKey(workspaceWith({ "Cargo.lock": "lock-A" }));

  assert.match(key, new RegExp(`^myprefix-v1\\.2\\.3-${PLATFORM}-[0-9a-f]{16}-abcdef0123456789$`));
  assert.deepEqual(restoreKeys, [`myprefix-v1.2.3-${PLATFORM}-`]);
  assert.ok(key.startsWith(restoreKeys[0]));
});

test("buildCacheKey changes with the salt and strips key separators from it", async () => {
  process.env.KACHE_VERSION = "v1";
  const ws = workspaceWith({ "Cargo.lock": "SAME" });

  const unsalted = await utils.buildCacheKey(ws);
  process.env["INPUT_CACHE-KEY-SALT"] = "run/1 2";
  const salted = await utils.buildCacheKey(ws);
  process.env["INPUT_CACHE-KEY-SALT"] = "run/1-3";
  const other = await utils.buildCacheKey(ws);

  assert.notEqual(salted.key, unsalted.key);
  assert.notEqual(salted.key, other.key);
  // The salt is appended to the unsalted key, never interleaved with it.
  assert.ok(salted.key.startsWith(`${unsalted.key}-`), salted.key);
  assert.ok(salted.key.endsWith("-run-1-2"), salted.key);
});
