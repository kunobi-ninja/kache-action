const core = require("@actions/core");
const tc = require("@actions/tool-cache");
const path = require("path");
const {
  getTarget,
  getLatestVersion,
  downloadAndVerify,
  runKache,
  isS3Configured,
  useGitHubCache,
  restoreCache,
  clearEventLog,
} = require("./utils");

async function run() {
  try {
    const token = core.getInput("token");
    const target = getTarget();

    // Resolve version
    let version = core.getInput("version");
    if (!version) {
      core.info("No version specified, fetching latest release...");
      version = await getLatestVersion(token);
    }
    if (!version) {
      core.warning("No kache release found — skipping cache setup (bootstrapping mode)");
      return;
    }
    if (!version.startsWith("v")) version = `v${version}`;
    core.info(`Using kache ${version} for ${target}`);

    // Check tool-cache (self-hosted runner reuse)
    const toolName = "kache";
    const semver = version.replace(/^v/, "");
    let toolDir = tc.find(toolName, semver);

    if (!toolDir) {
      let tarPath;
      try {
        tarPath = await downloadAndVerify(version, target);
      } catch (err) {
        core.warning(`Failed to download kache ${version} — skipping cache setup (binary not yet available): ${err.message}`);
        return;
      }
      const extracted = await tc.extractTar(tarPath);
      toolDir = await tc.cacheDir(extracted, toolName, semver);
    } else {
      core.info(`Found cached kache ${semver}`);
    }

    // Add to PATH
    core.addPath(toolDir);

    // Set RUSTC_WRAPPER
    const kacheBin = path.join(toolDir, "kache");
    core.exportVariable("RUSTC_WRAPPER", kacheBin);
    core.info(`RUSTC_WRAPPER=${kacheBin}`);

    // Enable kache debug logging (unless user already set KACHE_LOG)
    if (!process.env.KACHE_LOG) {
      core.exportVariable("KACHE_LOG", "kache=info");
    }

    // Export version so buildCacheKey() can include it in the GH cache key.
    // This ensures kache upgrades invalidate stale caches (GH cache is immutable).
    core.exportVariable("KACHE_VERSION", version);

    // Export S3 env vars if configured
    const s3Vars = {
      "s3-bucket": "KACHE_S3_BUCKET",
      "s3-region": "KACHE_S3_REGION",
      "s3-prefix": "KACHE_S3_PREFIX",
      "s3-endpoint": "KACHE_S3_ENDPOINT",
      "s3-access-key-id": "KACHE_S3_ACCESS_KEY",
      "s3-secret-access-key": "KACHE_S3_SECRET_KEY",
    };

    for (const [input, envVar] of Object.entries(s3Vars)) {
      const value = core.getInput(input);
      if (value) {
        core.exportVariable(envVar, value);
        // Mask secrets
        if (input.includes("secret") || input.includes("access-key")) {
          core.setSecret(value);
        }
      }
    }

    // Cache executables option
    if (core.getInput("cache-executables") === "true") {
      core.exportVariable("KACHE_CACHE_EXECUTABLES", "1");
    }

    // Restore cache: S3 sync or GitHub Actions cache
    const s3 = isS3Configured();
    const ghCache = useGitHubCache();

    if (s3 && core.getInput("sync") === "true") {
      core.info("Pulling remote cache from S3...");
      await runKache(["sync", "--pull"]);
    } else if (ghCache) {
      core.info("Restoring cache from GitHub Actions cache...");
      await restoreCache();
    }

    // Clear event log so we only capture this run's events
    clearEventLog();

    // Save state for post step
    core.saveState("start-time", Date.now().toString());
    core.saveState("s3-configured", s3 ? "true" : "false");
    core.saveState("gh-cache", ghCache ? "true" : "false");
    core.saveState("kache-version", version);
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
