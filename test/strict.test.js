const test = require("node:test");
const assert = require("node:assert/strict");
const { strictMode } = require("../src/utils");

function fakeCore(strict) {
  const core = { printed: [], failed: [] };
  core.getInput = (name) => (name === "strict" ? strict : "");
  core.warning = (message) => core.printed.push(String(message));
  core.setFailed = (message) => core.failed.push(message);
  return core;
}

test("strict mode fails the step once, naming every warning", () => {
  const core = fakeCore("true");
  const finish = strictMode(core);
  core.warning("kache stats exited with code 2");
  core.warning(new Error("no Remote line"));
  finish();
  // Warnings still print as before.
  assert.deepEqual(core.printed, ["kache stats exited with code 2", "Error: no Remote line"]);
  assert.equal(core.failed.length, 1);
  assert.match(core.failed[0], /warned 2 time\(s\): kache stats exited with code 2 \| no Remote line$/);
});

test("strict mode without warnings does not fail", () => {
  const core = fakeCore(" TRUE ");
  strictMode(core)();
  assert.deepEqual(core.failed, []);
});

test("without strict, warnings stay warnings", () => {
  for (const value of ["", "false", "yes"]) {
    const core = fakeCore(value);
    const warning = core.warning;
    const finish = strictMode(core);
    assert.equal(core.warning, warning);
    core.warning("degraded");
    finish();
    assert.deepEqual(core.failed, []);
  }
});
