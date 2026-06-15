// Tests for the pure platform→target-triple mapping.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const utils = require("../src/utils");

test("getTargetFor maps all supported platform/arch pairs", () => {
  assert.equal(utils.getTargetFor("linux", "x64"), "x86_64-unknown-linux-musl");
  assert.equal(utils.getTargetFor("linux", "arm64"), "aarch64-unknown-linux-musl");
  assert.equal(utils.getTargetFor("darwin", "x64"), "x86_64-apple-darwin");
  assert.equal(utils.getTargetFor("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(utils.getTargetFor("win32", "x64"), "x86_64-pc-windows-msvc");
  assert.equal(utils.getTargetFor("win32", "arm64"), "aarch64-pc-windows-msvc");
});

test("getTargetFor throws on an unsupported platform/arch", () => {
  assert.throws(
    () => utils.getTargetFor("freebsd", "x64"),
    /Unsupported platform: freebsd-x64/
  );
});
