// Tests for release selection, with an injected octokit (no network).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const utils = require("../src/utils");

function fakeOctokit(releasesOrError) {
  return {
    rest: {
      repos: {
        listReleases: async () => {
          if (releasesOrError instanceof Error) throw releasesOrError;
          return { data: releasesOrError };
        },
      },
    },
  };
}

const rel = (tag, o = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  assets: [{ name: `kache-${tag}.tar.gz` }],
  ...o,
});

test("getLatestVersion returns the first stable release that has assets", async () => {
  const octokit = fakeOctokit([
    rel("v9", { draft: true }),
    rel("v8", { prerelease: true }),
    rel("v7", { assets: [] }), // stable but no binaries yet → skip
    rel("v6"), // <-- first qualifying
    rel("v5"),
  ]);
  assert.equal(await utils.getLatestVersion("tok", octokit), "v6");
});

test("getLatestVersion returns null when no release qualifies", async () => {
  const octokit = fakeOctokit([
    rel("v2", { draft: true }),
    rel("v1", { assets: [] }),
  ]);
  assert.equal(await utils.getLatestVersion("tok", octokit), null);
});

test("getLatestVersion returns null on a 404", async () => {
  const err = new Error("Not Found");
  err.status = 404;
  assert.equal(await utils.getLatestVersion("tok", fakeOctokit(err)), null);
});

test("getLatestVersion rethrows non-404 errors", async () => {
  const err = new Error("Server Error");
  err.status = 500;
  await assert.rejects(
    () => utils.getLatestVersion("tok", fakeOctokit(err)),
    /Server Error/
  );
});
