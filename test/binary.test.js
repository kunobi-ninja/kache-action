// Tests for the platform-specific kache binary filename.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const utils = require("../src/utils");

test("binaryName is kache.exe on Windows", () => {
  assert.equal(utils.binaryName("win32"), "kache.exe");
});

test("binaryName is kache on Unix platforms", () => {
  assert.equal(utils.binaryName("linux"), "kache");
  assert.equal(utils.binaryName("darwin"), "kache");
});
