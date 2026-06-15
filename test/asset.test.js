// Tests for release-asset filename selection (tarball vs zip per platform).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const utils = require("../src/utils");

test("assetName uses .tar.gz for unix targets", () => {
  assert.equal(
    utils.assetName("x86_64-unknown-linux-musl"),
    "kache-x86_64-unknown-linux-musl.tar.gz"
  );
  assert.equal(
    utils.assetName("aarch64-apple-darwin"),
    "kache-aarch64-apple-darwin.tar.gz"
  );
});

test("assetName uses .zip for windows targets", () => {
  assert.equal(
    utils.assetName("x86_64-pc-windows-msvc"),
    "kache-x86_64-pc-windows-msvc.zip"
  );
  assert.equal(
    utils.assetName("aarch64-pc-windows-msvc"),
    "kache-aarch64-pc-windows-msvc.zip"
  );
});
