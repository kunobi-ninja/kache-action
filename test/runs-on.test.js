// Where the S3 remote comes from: inputs, then the RunsOn cache bucket, then
// KACHE_S3_* already in the environment (kunobi-ninja/kache#1260).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveS3Settings } = require("../src/utils");

const inputs = (values) => (name) => values[name] || "";

test("the s3-* inputs win over RunsOn and the environment", () => {
  const settings = resolveS3Settings(
    { RUNS_ON_S3_BUCKET_CACHE: "runs-on", KACHE_S3_BUCKET: "env" },
    inputs({ "s3-bucket": "input", "runs-on-cache": "true" }),
  );
  assert.deepEqual(settings, {
    source: "inputs",
    bucket: "input",
    region: "us-east-1",
    prefix: "artifacts",
    endpoint: undefined,
  });
});

test("runs-on-cache uses the stack bucket under the repository id", () => {
  const settings = resolveS3Settings(
    {
      RUNS_ON_S3_BUCKET_CACHE: "stack-cache",
      RUNS_ON_AWS_REGION: "eu-west-1",
      GITHUB_REPOSITORY_ID: "123456",
      GITHUB_REPOSITORY: "acme/app",
    },
    inputs({ "runs-on-cache": "true" }),
  );
  assert.deepEqual(settings, {
    source: "runs-on",
    bucket: "stack-cache",
    region: "eu-west-1",
    prefix: "cache/kache/123456",
    endpoint: undefined,
  });
});

test("runs-on-cache falls back to a sanitized repository name", () => {
  const settings = resolveS3Settings(
    {
      RUNS_ON_S3_BUCKET_CACHE: "stack-cache",
      RUNS_ON_AWS_REGION: "eu-west-1",
      GITHUB_REPOSITORY: "acme/app",
    },
    inputs({ "runs-on-cache": "true" }),
  );
  assert.equal(settings.prefix, "cache/kache/acme_app");
});

test("runs-on-cache without the RunsOn variables says what to add", () => {
  assert.throws(
    () => resolveS3Settings({}, inputs({ "runs-on-cache": "true" })),
    /extras=s3-cache/,
  );
});

test("KACHE_S3_* in the environment configure the remote", () => {
  const settings = resolveS3Settings(
    {
      KACHE_S3_BUCKET: " exported ",
      KACHE_S3_REGION: "us-west-2",
      KACHE_S3_PREFIX: "cache/kache/1",
    },
    inputs({}),
  );
  assert.deepEqual(settings, {
    source: "environment",
    bucket: "exported",
    region: "us-west-2",
    prefix: "cache/kache/1",
    endpoint: undefined,
  });
});

test("no inputs, no RunsOn and no exported bucket means no S3 remote", () => {
  assert.equal(resolveS3Settings({ KACHE_S3_BUCKET: "  " }, inputs({})), null);
  assert.equal(
    resolveS3Settings({ RUNS_ON_S3_BUCKET_CACHE: "x" }, inputs({})),
    null,
    "RunsOn is opt-in",
  );
});
