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

test("a default cache dir on another mount moves under RUNNER_TEMP", () => {
  const { result, calls } = layout({}, { [HOME_CACHE]: "cross-mount" });
  const colocated = path.join(RUNNER_TEMP, "kache");
  assert.equal(result.cacheDir, colocated);
  assert.match(result.info, /different mount/);
  assert.equal(result.warning, undefined);
  assert.deepEqual(calls, [
    [WORKSPACE, HOME_CACHE],
    [WORKSPACE, colocated],
  ]);
});

test("a configured cache dir on another mount is kept and warned about", () => {
  const { result, calls } = layout(
    { configured: true },
    { [HOME_CACHE]: "cross-mount" },
  );
  assert.equal(result.cacheDir, HOME_CACHE);
  assert.match(result.warning, /^cache-dir .* different mount .* runner\.temp/);
  assert.equal(calls.length, 1, "a configured dir is never replaced");
});

test("the default is kept with a warning when RUNNER_TEMP cannot link either", () => {
  for (const answer of ["cross-mount", "unknown"]) {
    const colocated = path.join(RUNNER_TEMP, "kache");
    const { result } = layout(
      {},
      { [HOME_CACHE]: "cross-mount", [colocated]: answer },
    );
    assert.equal(result.cacheDir, HOME_CACHE, answer);
    assert.match(result.warning, /different mount/, answer);
  }
});

test("the default is kept with a warning when RUNNER_TEMP is unset", () => {
  const { result, calls } = layout(
    { runnerTemp: undefined },
    { [HOME_CACHE]: "cross-mount" },
  );
  assert.equal(result.cacheDir, HOME_CACHE);
  assert.match(result.warning, /different mount/);
  assert.equal(calls.length, 1);
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

test("probeHardlink reports EXDEV as cross-mount and removes its file", () => {
  const removed = [];
  const exdev = Object.assign(new Error("cross-device link"), {
    code: "EXDEV",
  });
  const fsApi = {
    writeFileSync() {},
    mkdirSync() {},
    linkSync() {
      throw exdev;
    },
    unlinkSync(file) {
      removed.push(file);
      if (file.startsWith("/cache")) throw new Error("ENOENT");
    },
  };
  assert.equal(utils.probeHardlink("/work", "/cache", fsApi), "cross-mount");
  assert.equal(removed.length, 2);
  assert.ok(removed[1].startsWith("/work/.kache-action-link-probe-"));
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
