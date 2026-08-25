const core = require("@actions/core");
const tc = require("@actions/tool-cache");
const path = require("path");
const os = require("os");
const {
  getTarget,
  binaryName,
  getLatestVersion,
  downloadAndVerify,
  runKache,
  isS3Configured,
  useGitHubCache,
  isNodeCacheEnabled,
  isForkPullRequest,
  getCacheDir,
  checkNodeCacheStore,
  nodeCacheFallbackDir,
  getRuntimeDir,
  daemonStatusUsesRuntimeDir,
  hasUnsafeEnvOnlyDaemonVersion,
  restoreCache,
  clearEventLog,
  clearTransferLog,
  isNoCacheRequested,
  getCppCompilerEnv,
} = require("./utils");

async function run() {
  try {
    // Allow PRs to opt out of caching via [no-cache] in the description
    if (isNoCacheRequested()) {
      core.info("[no-cache] found in PR description — skipping kache setup");
      core.saveState("no-cache", "true");
      return;
    }

    const token = core.getInput("token");
    const target = getTarget();

    // Resolve version
    let version = core.getInput("version");
    if (!version) {
      core.info("No version specified, fetching latest release...");
      version = await getLatestVersion(token);
    }
    if (!version) {
      core.warning(
        "No kache release found — skipping cache setup (bootstrapping mode)",
      );
      return;
    }
    if (!version.startsWith("v")) version = `v${version}`;
    core.info(`Using kache ${version} for ${target}`);

    // Check tool-cache (self-hosted runner reuse)
    const toolName = "kache";
    const semver = version.replace(/^v/, "");
    let toolDir = tc.find(toolName, semver);

    if (!toolDir) {
      let archivePath;
      try {
        archivePath = await downloadAndVerify(version, target);
      } catch (err) {
        core.warning(
          `Failed to download kache ${version} — skipping cache setup (binary not yet available): ${err.message}`,
        );
        return;
      }
      // Windows releases ship as .zip, every other platform as .tar.gz.
      const extracted =
        os.platform() === "win32"
          ? await tc.extractZip(archivePath)
          : await tc.extractTar(archivePath);
      toolDir = await tc.cacheDir(extracted, toolName, semver);
    } else {
      core.info(`Found cached kache ${semver}`);
    }

    // Add to PATH
    core.addPath(toolDir);

    // Set RUSTC_WRAPPER (kache.exe on Windows)
    const kacheBin = path.join(toolDir, binaryName(os.platform()));
    core.exportVariable("RUSTC_WRAPPER", kacheBin);
    core.info(`RUSTC_WRAPPER=${kacheBin}`);

    // Enable kache debug logging (unless user already set KACHE_LOG)
    if (!process.env.KACHE_LOG) {
      core.exportVariable("KACHE_LOG", "kache=info");
    }

    // Export version so buildCacheKey() can include it in the GH cache key.
    // This ensures kache upgrades invalidate stale caches (GH cache is immutable).
    core.exportVariable("KACHE_VERSION", version);

    // Keep kache itself and the action's restore/save paths aligned. This also
    // lets ephemeral runners place the store beside the build tree so reflinks
    // do not cross filesystem boundaries.
    let cacheDir = getCacheDir();
    let nodeCache = isNodeCacheEnabled();
    if (
      nodeCache &&
      !core.getInput("cache-dir") &&
      !process.env.KACHE_CACHE_DIR
    ) {
      throw new Error(
        "node-cache requires an explicit cache-dir mounted only into the trusted runner pool",
      );
    }
    if (nodeCache && os.platform() !== "linux") {
      throw new Error(
        "node-cache currently supports Linux ephemeral runners only",
      );
    }
    if (nodeCache && isForkPullRequest()) {
      throw new Error("node-cache is forbidden for pull requests from forks");
    }
    core.exportVariable("KACHE_CACHE_DIR", cacheDir);
    core.exportVariable("KACHE_EFFECTIVE_CACHE_DIR", cacheDir);
    core.info(`KACHE_CACHE_DIR=${cacheDir}`);
    const runtimeDir = getRuntimeDir();
    if (runtimeDir) {
      if (nodeCache && path.resolve(runtimeDir) === path.resolve(cacheDir)) {
        throw new Error(
          "runtime-dir must differ from cache-dir in node-cache mode",
        );
      }
      core.exportVariable("KACHE_RUNTIME_DIR", runtimeDir);
      core.info(`KACHE_RUNTIME_DIR=${runtimeDir}`);
    }
    let runtimeSupported = false;
    if (runtimeDir && !process.env.KACHE_SOCKET_PATH) {
      const status = await runKache(["daemon", "status"]);
      runtimeSupported = daemonStatusUsesRuntimeDir(status, runtimeDir);
    }
    if (nodeCache) {
      if (process.env.KACHE_SOCKET_PATH) {
        throw new Error(
          "node-cache does not accept KACHE_SOCKET_PATH because it would mask the runtime-directory compatibility check",
        );
      }
      const health = checkNodeCacheStore(cacheDir);
      if (!health.ok || !runtimeSupported) {
        const reason = health.ok
          ? "the installed Kache release does not honor KACHE_RUNTIME_DIR"
          : health.reason;
        cacheDir = nodeCacheFallbackDir();
        nodeCache = false;
        core.warning(
          `Trusted node-local cache unavailable (${reason}); falling back to job-local cache with ordinary remote v3 behavior`,
        );
        core.exportVariable("KACHE_CACHE_DIR", cacheDir);
        core.exportVariable("KACHE_EFFECTIVE_CACHE_DIR", cacheDir);
        core.info(`KACHE_CACHE_DIR=${cacheDir}`);
      } else {
        core.info(
          "Trusted node-local cache enabled; GitHub Actions cache restore/save is disabled",
        );
      }
    }
    // Register cleanup after the job-private runtime is known, but before any
    // later operation can start a daemon and fail.
    core.saveState("node-cache", nodeCache ? "true" : "false");

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

    // Opt-in C/C++ object caching. Preserve an explicitly configured real
    // compiler and otherwise use kache's supported platform defaults.
    if (core.getBooleanInput("cache-c-cpp")) {
      const compilerEnv = getCppCompilerEnv(os.platform(), process.env);
      for (const [name, value] of Object.entries(compilerEnv)) {
        core.exportVariable(name, value);
      }
      const exported = Object.keys(compilerEnv).filter(
        (n) => n !== "CC_KNOWN_WRAPPER_CUSTOM",
      );
      core.info(
        exported.length
          ? `C/C++ caching enabled via ${exported.join(", ")}`
          : "C/C++ caching enabled via RUSTC_WRAPPER (the cc crate wraps the compiler it selects, cross targets included)",
      );
    }

    // Max local store size before LRU eviction (applies regardless of backend)
    const maxSize = core.getInput("max-size");
    if (maxSize) {
      core.exportVariable("KACHE_MAX_SIZE", maxSize);
      core.info(`KACHE_MAX_SIZE=${maxSize}`);
    }

    // Restore cache: S3 (daemon auto-prefetches from manifest), sync (legacy), or GitHub Actions cache
    const s3 = isS3Configured();
    const ghCache = useGitHubCache(nodeCache);
    const saveCacheEnabled = core.getBooleanInput("save-cache");
    if (s3 && hasUnsafeEnvOnlyDaemonVersion(version) && !runtimeSupported) {
      throw new Error(
        "Kache 0.15.0 cannot safely inherit an environment-only S3 remote in its background daemon; use Kache 0.15.1 or newer",
      );
    }
    core.saveState("stop-daemon", s3 && runtimeDir ? "true" : "false");

    // Keep S3 consumers genuinely read-only: the daemon normally uploads
    // artifacts during the build, before the post step gets a chance to skip.
    if (s3 && !saveCacheEnabled) {
      core.exportVariable("KACHE_REMOTE_READONLY", "1");
      core.info("Remote cache writes disabled (save-cache: false)");
    }

    // Local-only caching is useful when multiple steps share the same runner,
    // even when no persistent backend is configured.
    if (!s3 && !ghCache) {
      core.info(
        "No persistent cache backend configured — using the local kache store only",
      );
    }
    if (!s3 && ghCache) {
      core.warning(
        "kache: no S3 remote configured — falling back to GitHub Actions cache. " +
          "This provides basic caching but S3/R2 is recommended for best performance " +
          "(faster restore, async uploads, cross-branch sharing). " +
          "See: https://github.com/kunobi-ninja/kache#remote-cache",
      );
    }

    // Export manifest config as env vars for the daemon's auto-prefetch
    if (s3) {
      const manifestKey = core.getInput("manifest-key");
      if (manifestKey) core.exportVariable("KACHE_MANIFEST_KEY", manifestKey);
      // Namespace drives sharded prefetch (kache reads KACHE_NAMESPACE in
      // build_intent::discover) and shard upload in the post step. Default to the
      // manifest-key so any consumer already scoping its build gets shards — and
      // thus prefetch that overlaps downloads with compilation — for free. Export
      // before the daemon starts below so the daemon inherits it too.
      const namespace = core.getInput("namespace") || manifestKey;
      if (namespace) core.exportVariable("KACHE_NAMESPACE", namespace);
      const minMs = core.getInput("min-compile-ms");
      if (minMs && minMs !== "1000")
        core.exportVariable("KACHE_MIN_COMPILE_MS", minMs);
      const warm = core.getInput("warm") !== "false";
      if (!warm) core.exportVariable("KACHE_MIN_COMPILE_MS", "999999999");
    }

    if (s3 && core.getInput("sync") === "true") {
      core.info("Pulling remote cache from S3...");
      await runKache(["sync", "--pull"]);
    } else if (ghCache) {
      core.info("Restoring cache from GitHub Actions cache...");
      await restoreCache();
    }

    // Clear event and transfer logs so we only capture this run's data
    clearEventLog();
    clearTransferLog();

    // Start daemon early so manifest prefetch races against cargo fetch, not compilation
    if (s3) {
      core.info("Starting kache daemon for early prefetch...");
      await runKache(["daemon", "start"]);
    }

    // Save state for post step
    core.saveState("start-time", Date.now().toString());
    core.saveState("s3-configured", s3 ? "true" : "false");
    core.saveState("gh-cache", ghCache ? "true" : "false");
    core.saveState("save-cache", saveCacheEnabled ? "true" : "false");
    core.saveState("kache-version", version);
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
