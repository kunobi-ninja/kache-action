// With cache-c-cpp on Linux and macOS, C objects are cached only when the cc
// crate recognizes kache through RUSTC_WRAPPER, which needs cc 1.2.66 or newer.
// Setup points out lockfiles that pin an older one.
const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const utils = require("../src/utils");

const created = [];

afterEach(() => {
  while (created.length) fs.rmSync(created.pop(), { recursive: true, force: true });
});

function lockfile(...packages) {
  return packages
    .map(
      ([name, version]) =>
        `[[package]]\nname = "${name}"\nversion = "${version}"\n` +
        'source = "registry+https://github.com/rust-lang/crates.io-index"\n',
    )
    .join("\n");
}

test("oldCcVersions lists cc releases before 1.2.66", () => {
  assert.deepEqual(utils.oldCcVersions(lockfile(["cc", "1.2.65"])), ["1.2.65"]);
  assert.deepEqual(utils.oldCcVersions(lockfile(["cc", "1.0.83"], ["libc", "0.2.170"])), ["1.0.83"]);
  assert.deepEqual(utils.oldCcVersions(lockfile(["cc", "1.2.66"])), []);
  assert.deepEqual(utils.oldCcVersions(lockfile(["cc", "1.3.0"])), []);
  assert.deepEqual(utils.oldCcVersions(lockfile(["cc", "2.0.0"])), []);
  assert.deepEqual(utils.oldCcVersions(lockfile(["cc", "1.2.40"], ["cc", "1.2.70"])), ["1.2.40"]);
});

test("oldCcVersions only looks at the package named exactly cc", () => {
  assert.deepEqual(utils.oldCcVersions(lockfile(["cc-helper", "0.1.0"], ["gcc", "0.3.55"])), []);
  assert.deepEqual(utils.oldCcVersions(""), []);
});

test("findOldCcLockfiles reports every lockfile that pins an old cc", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kache-cc-"));
  created.push(dir);
  const write = (rel, content) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write("Cargo.lock", lockfile(["cc", "1.2.65"]));
  write("tools/Cargo.lock", lockfile(["cc", "1.2.66"]));
  write("other/Cargo.lock", lockfile(["cc", "1.1.0"], ["serde", "1.0.0"]));

  const found = await utils.findOldCcLockfiles(dir);
  const relative = found
    .map(({ file, versions }) => [path.relative(dir, file), versions])
    .sort(([a], [b]) => a.localeCompare(b));
  assert.deepEqual(relative, [
    ["Cargo.lock", ["1.2.65"]],
    [path.join("other", "Cargo.lock"), ["1.1.0"]],
  ]);
});
