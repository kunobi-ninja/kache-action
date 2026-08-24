const { test } = require("node:test");
const assert = require("node:assert/strict");
const utils = require("../src/utils");

test("getCppCompilerEnv uses cc/c++ defaults on Unix", () => {
  assert.deepEqual(utils.getCppCompilerEnv("linux", {}), {
    CC: "kache cc",
    CXX: "kache c++",
  });
  assert.deepEqual(utils.getCppCompilerEnv("darwin", {}), {
    CC: "kache cc",
    CXX: "kache c++",
  });
});

test("getCppCompilerEnv uses clang-cl defaults on Windows", () => {
  assert.deepEqual(utils.getCppCompilerEnv("win32", {}), {
    CC: "kache clang-cl",
    CXX: "kache clang-cl",
  });
});

test("getCppCompilerEnv preserves explicitly selected compilers", () => {
  assert.deepEqual(
    utils.getCppCompilerEnv("linux", { CC: "clang-18", CXX: "clang++-18" }),
    { CC: "kache clang-18", CXX: "kache clang++-18" }
  );
});

test("wrapCppCompiler does not double-wrap kache commands", () => {
  assert.equal(utils.wrapCppCompiler("kache clang", "cc"), "kache clang");
  assert.equal(
    utils.wrapCppCompiler("KACHE.EXE clang-cl", "clang-cl"),
    "KACHE.EXE clang-cl"
  );
});
