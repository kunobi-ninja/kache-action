// Tests for keeping the cache on the workspace's mount (kunobi-ninja/kache#835).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const utils = require("../src/utils");

const WORKSPACE = "/__w/repo/repo";
const HOME_CACHE = "/github/home/.cache/kache";
const RUNNER_TEMP = "/__w/_temp";

// A probe that answers by destination, recording every call.
function fakeProbe(answers) {
  const calls = [];
  const probe = (from, to) => {
    calls.push([from, to]);
    return answers[to] ?? "ok";
  };
  return { probe, calls };
}

function layout(overrides, answers) {
  const { probe, calls } = fakeProbe(answers);
  const result = utils.colocateCacheDir(
    {
      cacheDir: HOME_CACHE,
      configured: false,
      workspace: WORKSPACE,
      runnerTemp: RUNNER_TEMP,
      ...overrides,
    },
    probe,
  );
  return { result, calls };
}

test("a default cache dir that links into the workspace is kept silently", () => {
  const { result, calls } = layout({}, {});
  assert.deepEqual(result, { cacheDir: HOME_CACHE });
  assert.deepEqual(calls, [[WORKSPACE, HOME_CACHE]]);
});

const TEMP_CACHE = path.join(RUNNER_TEMP, "kache");
const SIBLING_CACHE = path.join(path.dirname(WORKSPACE), ".kache-cache");

test("a default cache dir on another mount moves under RUNNER_TEMP", () => {
  const { result, calls } = layout({}, { [HOME_CACHE]: "cross-mount" });
  assert.equal(result.cacheDir, TEMP_CACHE);
  assert.match(result.info, /different mount/);
  assert.equal(result.warning, undefined);
  assert.deepEqual(calls, [
    [WORKSPACE, HOME_CACHE],
    [WORKSPACE, TEMP_CACHE],
  ]);
});

// GitHub's container jobs mount /__w/_temp separately from /__w.
test("a RUNNER_TEMP on another mount too moves the cache next to the workspace", () => {
  for (const answer of ["cross-mount", "unknown"]) {
    const { result, calls } = layout(
      {},
      { [HOME_CACHE]: "cross-mount", [TEMP_CACHE]: answer },
    );
    assert.equal(result.cacheDir, SIBLING_CACHE, answer);
    assert.match(result.info, /different mount/, answer);
    assert.deepEqual(calls.at(-1), [WORKSPACE, SIBLING_CACHE], answer);
  }
});

test("without RUNNER_TEMP the cache moves next to the workspace", () => {
  const { result, calls } = layout(
    { runnerTemp: undefined },
    { [HOME_CACHE]: "cross-mount" },
  );
  assert.equal(result.cacheDir, SIBLING_CACHE);
  assert.equal(calls.length, 2);
});

test("the sibling cache dir is never the workspace, even for a repo named kache", () => {
  const workspace = "/__w/kache/kache";
  const { result } = layout(
    { workspace },
    { [HOME_CACHE]: "cross-mount", [TEMP_CACHE]: "cross-mount" },
  );
  assert.equal(result.cacheDir, path.join("/__w/kache", ".kache-cache"));
  assert.notEqual(result.cacheDir, workspace);
});

test("a configured cache dir on another mount is kept and warned about", () => {
  const { result, calls } = layout(
    { configured: true },
    { [HOME_CACHE]: "cross-mount" },
  );
  assert.equal(result.cacheDir, HOME_CACHE);
  assert.match(result.warning, /^cache-dir .* different mount/);
  assert.equal(calls.length, 1, "a configured dir is never replaced");
});

test("the default is kept with a warning when no candidate links", () => {
  const { result, calls } = layout(
    {},
    {
      [HOME_CACHE]: "cross-mount",
      [TEMP_CACHE]: "cross-mount",
      [SIBLING_CACHE]: "unknown",
    },
  );
  assert.equal(result.cacheDir, HOME_CACHE);
  assert.match(result.warning, /^The default cache dir .* different mount/);
  assert.equal(calls.length, 3);
});

test("a probe that cannot tell changes nothing", () => {
  const { result } = layout({}, { [HOME_CACHE]: "unknown" });
  assert.deepEqual(result, { cacheDir: HOME_CACHE });
});

test("no workspace means no probe", () => {
  const { result, calls } = layout({ workspace: undefined }, {});
  assert.deepEqual(result, { cacheDir: HOME_CACHE });
  assert.equal(calls.length, 0);
});

test("probeHardlink links within one directory tree and cleans up", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kache-probe-"));
  try {
    const cache = path.join(root, "cache", "kache");
    assert.equal(utils.probeHardlink(root, cache), "ok");
    assert.deepEqual(fs.readdirSync(cache), []);
    assert.deepEqual(fs.readdirSync(root), ["cache"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("probeHardlink reports EXDEV as cross-mount and removes what it made", () => {
  const work = path.join(path.sep, "work");
  const cache = path.join(path.sep, "home", ".cache", "kache");
  const unlinked = [];
  const removedDirs = [];
  const exdev = Object.assign(new Error("cross-device link"), {
    code: "EXDEV",
  });
  const fsApi = {
    writeFileSync() {},
    mkdirSync: () => path.join(path.sep, "home", ".cache"),
    linkSync() {
      throw exdev;
    },
    unlinkSync(file) {
      unlinked.push(file);
      if (file.startsWith(cache)) throw new Error("ENOENT");
    },
    rmSync(dir) {
      removedDirs.push(dir);
    },
  };
  assert.equal(utils.probeHardlink(work, cache, fsApi), "cross-mount");
  assert.equal(unlinked.length, 2);
  assert.ok(
    unlinked[1].startsWith(path.join(work, ".kache-action-link-probe-")),
  );
  assert.deepEqual(removedDirs, [path.join(path.sep, "home", ".cache")]);
});

test("probeHardlink keeps a directory that already existed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kache-probe-"));
  try {
    const exdev = Object.assign(new Error("x"), { code: "EXDEV" });
    const fsApi = { ...fs, linkSync() { throw exdev; } };
    assert.equal(utils.probeHardlink(root, root, fsApi), "cross-mount");
    assert.ok(fs.existsSync(root));
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("probeHardlink reports other failures as unknown", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kache-probe-"));
  try {
    const missing = path.join(root, "missing");
    assert.equal(utils.probeHardlink(missing, root), "unknown");
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
