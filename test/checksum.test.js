// Tests for the security-critical SHA-256 verification, isolated from network/fs.
// Uses known SHA-256 vectors (not crypto-computed) so the test can't drift with
// the implementation it verifies.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const utils = require("../src/utils");

// sha256("") and sha256("abc")
const SHA_EMPTY =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SHA_ABC =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

test("verifyChecksum passes and returns the hash when it matches", () => {
  const out = utils.verifyChecksum(
    Buffer.from("abc"),
    `${SHA_ABC}  kache.tar.gz`,
    "kache.tar.gz"
  );
  assert.equal(out, SHA_ABC);
});

test("verifyChecksum parses the 'hash  filename' format (first token only)", () => {
  assert.doesNotThrow(() =>
    utils.verifyChecksum(Buffer.from(""), `${SHA_EMPTY}  some-file`, "f")
  );
});

test("verifyChecksum tolerates surrounding whitespace/newlines in the sha file", () => {
  assert.doesNotThrow(() =>
    utils.verifyChecksum(Buffer.from("abc"), `\n  ${SHA_ABC}  x \n`, "x")
  );
});

test("verifyChecksum throws on a mismatch, naming the artifact", () => {
  assert.throws(
    () => utils.verifyChecksum(Buffer.from("abc"), `${SHA_EMPTY}  x`, "kache.tar.gz"),
    /SHA256 mismatch for kache\.tar\.gz/
  );
});
