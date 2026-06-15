// Tests for the user-visible markdown rendering helpers.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const utils = require("../src/utils");

test("formatBytes renders 0 and unit boundaries", () => {
  assert.equal(utils.formatBytes(0), "0 B");
  assert.equal(utils.formatBytes(1024), "1.0 KB");
  assert.equal(utils.formatBytes(1536), "1.5 KB");
  assert.equal(utils.formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(utils.formatBytes(1024 * 1024 * 1024), "1.0 GB");
});

test("formatMs renders sub-second as ms and >=1s as seconds", () => {
  assert.equal(utils.formatMs(999), "999ms");
  assert.equal(utils.formatMs(1000), "1.0s");
  assert.equal(utils.formatMs(2500), "2.5s");
});

const baseStats = {
  hitRate: "80.0",
  localHits: 4,
  remoteHits: 0,
  misses: 1,
  errors: 0,
  total: 5,
  missedCrates: [{ name: "serde", elapsed_ms: 1200, size: 4096, cache_key: "" }],
};

test("buildStatsMarkdown renders the stats table with backend and duration", () => {
  const md = utils.buildStatsMarkdown(baseStats, "S3", "12.3");
  assert.match(md, /\| Hit rate \| 80\.0% \|/);
  assert.match(md, /\| Backend \| S3 \|/);
  assert.match(md, /\| Duration \| 12\.3s \|/);
});

test("buildStatsMarkdown omits the Errors row when there are no errors", () => {
  const md = utils.buildStatsMarkdown(baseStats, "S3", "1");
  assert.doesNotMatch(md, /\| Errors \|/);
});

test("buildStatsMarkdown includes the Errors row when errors > 0", () => {
  const md = utils.buildStatsMarkdown({ ...baseStats, errors: 3 }, "S3", "1");
  assert.match(md, /\| Errors \| 3 \|/);
});

test("buildStatsMarkdown lists missed crates with a count summary", () => {
  const md = utils.buildStatsMarkdown(baseStats, "S3", "1");
  assert.match(md, /Cache misses \(1 crates\)/);
  assert.match(md, /serde/);
});

test("buildStatsMarkdown truncates to the top 10 misses with a '… more' row", () => {
  const missedCrates = Array.from({ length: 12 }, (_, i) => ({
    name: `crate${i}`,
    elapsed_ms: (12 - i) * 100,
    size: 0,
    cache_key: "",
  }));
  const md = utils.buildStatsMarkdown(
    { ...baseStats, misses: 12, missedCrates },
    "S3",
    "1"
  );
  assert.match(md, /Cache misses \(12 crates\)/);
  assert.match(md, /2 more/); // 12 - 10
});
