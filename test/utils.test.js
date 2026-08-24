// Unit tests for src/utils.js — run with `node --test` (Node 24 built-in test runner, no deps).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const github = require("@actions/github");
const utils = require("../src/utils");

// GITHUB_REPOSITORY is always present in a real Actions runtime; context.repo
// (used transitively by context.issue) throws without it. Set it for all tests.
process.env.GITHUB_REPOSITORY = "owner/repo";

// github.context is a singleton whose `job` is read from GITHUB_JOB in its
// constructor (at import). We mutate the singleton directly per test.
function setJob(job) {
  github.context.job = job;
}

test("labelHeading appends the label to a present heading exactly once", () => {
  const md = "### kache build cache\n\nsome stats";
  const out = utils.labelHeading(md, "build (x86_64-unknown-linux-musl)");
  assert.equal(
    out.split("\n")[0],
    "### kache build cache — build (x86_64-unknown-linux-musl)"
  );
  // exactly one em-dash label inserted
  assert.equal(out.match(/—/g).length, 1);
});

test("labelHeading works for any heading level (## from kache report)", () => {
  const out = utils.labelHeading("## kache build cache\n\nx", "job (t)");
  assert.equal(out.split("\n")[0], "## kache build cache — job (t)");
});

test("labelHeading is a no-op when no matching heading exists", () => {
  const md = "## Some other heading\n\nbody";
  assert.equal(utils.labelHeading(md, "job (t)"), md);
});

test("labelHeading only labels the first matching heading (no global flag)", () => {
  const md = "### kache build cache\n\n```\n### kache build cache\n```\n";
  const out = utils.labelHeading(md, "L");
  // first line labeled, the in-code-block occurrence left untouched
  assert.equal(out.split("\n")[0], "### kache build cache — L");
  assert.ok(out.includes("\n### kache build cache\n"));
  assert.equal(out.match(/— L/g).length, 1);
});

test("labelCurrentJobWindow makes the cleared-log report window truthful", () => {
  const md = [
    "| | |",
    "|---|---|",
    "| Window | last 24h |",
    "| Crates | 1 cached / 0 compiled |",
  ].join("\n");
  const out = utils.labelCurrentJobWindow(md);
  assert.match(out, /^\| Window \| current job \|$/m);
  assert.doesNotMatch(out, /last 24h/);
});

test("labelCurrentJobWindow leaves unrelated markdown unchanged", () => {
  const md = "| Window | last 7d |";
  assert.equal(utils.labelCurrentJobWindow(md), md);
});

test("commentMarker is a single-line HTML comment carrying the job", () => {
  setJob("build");
  const m = utils.commentMarker();
  assert.match(m, /^<!-- kache-action-comment:build \(.+\) -->$/);
  assert.ok(!m.includes("\n"));
});

test("commentMarker sanitizes a job name containing --> and newlines", () => {
  setJob("ev\nil-->x");
  const m = utils.commentMarker();
  // no embedded close-comment or newline beyond the single trailing ` -->`
  assert.ok(!m.includes("\n"));
  assert.equal(m.match(/-->/g).length, 1);
  assert.ok(m.endsWith(" -->"));
});

test("commentMarker: distinct jobs never collide via substring (matrix safety)", () => {
  setJob("build");
  const a = utils.commentMarker();
  setJob("build-extra");
  const b = utils.commentMarker();
  assert.notEqual(a, b);
  assert.ok(!a.includes(b), "shorter marker must not be a substring of longer");
  assert.ok(!b.includes(a), "longer marker must not contain shorter");
});

test("jobLabel falls back to 'build' when GITHUB_JOB is empty", () => {
  setJob(undefined);
  assert.match(utils.jobLabel(), /^build \(.+\)$/);
});

// --- postOrUpdateComment with a mocked octokit + PR context ---

function withMockedOctokit(comments, sink) {
  const original = github.getOctokit;
  github.getOctokit = () => ({
    rest: {
      issues: {
        listComments: async () => ({ data: comments }),
        createComment: async (args) => sink.created.push(args),
        updateComment: async (args) => sink.updated.push(args),
      },
    },
  });
  return () => {
    github.getOctokit = original;
  };
}

test("postOrUpdateComment: no PR context → no API calls", async () => {
  github.context.payload = {};
  const sink = { created: [], updated: [] };
  const restore = withMockedOctokit([], sink);
  try {
    await utils.postOrUpdateComment("body", "tok");
  } finally {
    restore();
  }
  assert.equal(sink.created.length, 0);
  assert.equal(sink.updated.length, 0);
});

test("postOrUpdateComment: creates when no marker present", async () => {
  process.env.GITHUB_REPOSITORY = "owner/repo";
  github.context.payload = { pull_request: { number: 7 } };
  setJob("build");
  const sink = { created: [], updated: [] };
  const restore = withMockedOctokit(
    [{ id: 1, body: "unrelated comment" }],
    sink
  );
  try {
    await utils.postOrUpdateComment("hello", "tok");
  } finally {
    restore();
  }
  assert.equal(sink.created.length, 1);
  assert.equal(sink.updated.length, 0);
  assert.equal(sink.created[0].issue_number, 7);
  assert.ok(sink.created[0].body.includes(utils.commentMarker()));
});

test("postOrUpdateComment: updates the matching per-job comment", async () => {
  process.env.GITHUB_REPOSITORY = "owner/repo";
  github.context.payload = { pull_request: { number: 7 } };
  setJob("build");
  const marker = utils.commentMarker();
  const sink = { created: [], updated: [] };
  const restore = withMockedOctokit(
    [{ id: 42, body: `${marker}\nold stats` }],
    sink
  );
  try {
    await utils.postOrUpdateComment("new stats", "tok");
  } finally {
    restore();
  }
  assert.equal(sink.updated.length, 1);
  assert.equal(sink.created.length, 0);
  assert.equal(sink.updated[0].comment_id, 42);
});

test("postOrUpdateComment: a sibling job's comment is NOT clobbered", async () => {
  process.env.GITHUB_REPOSITORY = "owner/repo";
  github.context.payload = { pull_request: { number: 7 } };
  // existing comment belongs to a different matrix job
  setJob("other-job");
  const siblingMarker = utils.commentMarker();
  setJob("build");
  const sink = { created: [], updated: [] };
  const restore = withMockedOctokit(
    [{ id: 99, body: `${siblingMarker}\nsibling stats` }],
    sink
  );
  try {
    await utils.postOrUpdateComment("my stats", "tok");
  } finally {
    restore();
  }
  // must create its own, not update the sibling's
  assert.equal(sink.updated.length, 0);
  assert.equal(sink.created.length, 1);
});
