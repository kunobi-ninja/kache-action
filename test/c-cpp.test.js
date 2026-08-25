const { test } = require("node:test");
const assert = require("node:assert/strict");
const utils = require("../src/utils");

test("getCppCompilerEnv sets no compiler on Unix", () => {
  // cc-rs applies RUSTC_WRAPPER as the C/C++ wrapper on its own (kache is in
  // its accelerator list since cc 1.2.66) and does so after picking the
  // compiler, so there is nothing to set and cross targets keep their own
  // toolchain. A bare CC here would send every target to the host compiler
  // (kunobi-ninja/kache#823).
  assert.deepEqual(utils.getCppCompilerEnv("linux", {}, "x64"), {});
  assert.deepEqual(utils.getCppCompilerEnv("darwin", {}, "arm64"), {});
});

test("getCppCompilerEnv scopes clang-cl to the runner's own target on Windows", () => {
  // Windows still needs an explicit compiler: without one cc-rs selects MSVC
  // `cl.exe`, which kache does not support. Scoping it to the host triple
  // keeps that choice off every other target.
  assert.deepEqual(utils.getCppCompilerEnv("win32", {}, "x64"), {
    CC_x86_64_pc_windows_msvc: "kache clang-cl",
    CXX_x86_64_pc_windows_msvc: "kache clang-cl",
    CC_KNOWN_WRAPPER_CUSTOM: "kache",
  });
  assert.deepEqual(utils.getCppCompilerEnv("win32", {}, "arm64"), {
    CC_aarch64_pc_windows_msvc: "kache clang-cl",
    CXX_aarch64_pc_windows_msvc: "kache clang-cl",
    CC_KNOWN_WRAPPER_CUSTOM: "kache",
  });
});

test("getCppCompilerEnv never sets a bare CC of its own", () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    const exported = utils.getCppCompilerEnv(platform, {}, "x64");
    assert.equal(exported.CC, undefined, `${platform} must not set a bare CC`);
    assert.equal(
      exported.CXX,
      undefined,
      `${platform} must not set a bare CXX`,
    );
  }
});

test("getCppCompilerEnv preserves explicitly selected compilers", () => {
  // A compiler the user configured is their choice of toolchain, target
  // included, so it is wrapped where it stands rather than second-guessed.
  assert.deepEqual(
    utils.getCppCompilerEnv(
      "linux",
      { CC: "clang-18", CXX: "clang++-18" },
      "x64",
    ),
    {
      CC: "kache clang-18",
      CXX: "kache clang++-18",
      CC_KNOWN_WRAPPER_CUSTOM: "kache",
    },
  );
});

test("hostTargetTriple maps runner platform and arch", () => {
  assert.equal(
    utils.hostTargetTriple("linux", "x64"),
    "x86_64-unknown-linux-gnu",
  );
  assert.equal(
    utils.hostTargetTriple("linux", "arm64"),
    "aarch64-unknown-linux-gnu",
  );
  assert.equal(
    utils.hostTargetTriple("darwin", "arm64"),
    "aarch64-apple-darwin",
  );
  assert.equal(
    utils.hostTargetTriple("win32", "x64"),
    "x86_64-pc-windows-msvc",
  );
});

test("wrapCppCompiler does not double-wrap kache commands", () => {
  assert.equal(utils.wrapCppCompiler("kache clang", "cc"), "kache clang");
  assert.equal(
    utils.wrapCppCompiler("KACHE.EXE clang-cl", "clang-cl"),
    "KACHE.EXE clang-cl",
  );
});
