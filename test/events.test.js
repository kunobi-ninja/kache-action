// Tests for the pure events.jsonl parser / stats aggregator.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const utils = require("../src/utils");

const line = (o) => JSON.stringify(o);

test("parseEventsFrom returns null for empty or whitespace content", () => {
  assert.equal(utils.parseEventsFrom(""), null);
  assert.equal(utils.parseEventsFrom("   \n  \n"), null);
});

test("parseEventsFrom returns null when no line is valid JSON", () => {
  assert.equal(utils.parseEventsFrom("not json\n{broken"), null);
});

test("parseEventsFrom tallies hits/misses/errors and computes hit rate", () => {
  const content = [
    line({ result: "local_hit" }),
    line({ result: "remote_hit" }),
    line({ result: "miss", crate_name: "serde", elapsed_ms: 1200, size: 4096 }),
    line({ result: "error" }),
  ].join("\n");

  const s = utils.parseEventsFrom(content);
  assert.equal(s.localHits, 1);
  assert.equal(s.remoteHits, 1);
  assert.equal(s.misses, 1);
  assert.equal(s.errors, 1);
  assert.equal(s.hits, 2);
  // total counts hits + misses (errors excluded): 1 + 1 + 1 = 3
  assert.equal(s.total, 3);
  assert.equal(s.hitRate, "66.7");
});

test("parseEventsFrom skips malformed lines but keeps valid ones", () => {
  const content = ["garbage", line({ result: "local_hit" }), "{also bad"].join("\n");
  const s = utils.parseEventsFrom(content);
  assert.equal(s.total, 1);
  assert.equal(s.localHits, 1);
});

test("parseEventsFrom sorts missed crates by compile time, descending", () => {
  const content = [
    line({ result: "miss", crate_name: "cheap", elapsed_ms: 50 }),
    line({ result: "miss", crate_name: "expensive", elapsed_ms: 9000 }),
    line({ result: "miss", crate_name: "mid", elapsed_ms: 500 }),
  ].join("\n");
  const s = utils.parseEventsFrom(content);
  assert.deepEqual(
    s.missedCrates.map((c) => c.name),
    ["expensive", "mid", "cheap"]
  );
});

test("parseEventsFrom defaults missing miss fields", () => {
  const s = utils.parseEventsFrom(line({ result: "miss", crate_name: "x" }));
  assert.deepEqual(s.missedCrates[0], {
    name: "x",
    elapsed_ms: 0,
    size: 0,
    cache_key: "",
  });
});
