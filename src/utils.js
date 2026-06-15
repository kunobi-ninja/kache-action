// @actions/exec.exec() uses child_process.execFile internally (not shell exec).
// Arguments are passed as an array, so there is no command injection risk.
const cache = require("@actions/cache");
const core = require("@actions/core");
const actionsExec = require("@actions/exec");
const glob = require("@actions/glob");
const github = require("@actions/github");
const tc = require("@actions/tool-cache");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

/** Heading text emitted by `kache report --format github`; the JS guard and the
 *  per-job heading label both key off this literal, so keep them in sync. */
const REPORT_HEADING = "kache build cache";

/** Map an explicit OS+arch to a Rust target triple. Pure — no `os` access — so
 *  it is unit-testable for every platform, not just the host's. */
function getTargetFor(platform, arch) {
  if (platform === "linux" && arch === "x64")
    return "x86_64-unknown-linux-musl";
  if (platform === "linux" && arch === "arm64")
    return "aarch64-unknown-linux-musl";
  if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
  if (platform === "win32" && arch === "arm64") return "aarch64-pc-windows-msvc";

  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

/** Map the runner's OS+arch to a Rust target triple. */
function getTarget() {
  return getTargetFor(os.platform(), os.arch());
}

/** The kache executable filename for a platform (`.exe` on Windows). */
function binaryName(platform) {
  return platform === "win32" ? "kache.exe" : "kache";
}

/** Fetch latest release tag from kunobi-ninja/kache that has binary assets.
 *  Skips releases where binaries haven't been uploaded yet (e.g. a tag was
 *  just pushed and the release build is still in progress). */
async function getLatestVersion(token, octokit = github.getOctokit(token)) {
  try {
    const { data: releases } = await octokit.rest.repos.listReleases({
      owner: "kunobi-ninja",
      repo: "kache",
      per_page: 5,
    });
    for (const release of releases) {
      if (release.draft || release.prerelease) continue;
      if (release.assets && release.assets.length > 0) {
        return release.tag_name;
      }
    }
    return null;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/** Verify a buffer's SHA256 against a `.sha256` file's contents (format:
 *  "<hash>  <filename>"). Pure — no fs/network — so the supply-chain integrity
 *  check is unit-testable. Returns the verified hash; throws on mismatch. */
function verifyChecksum(buffer, shaFileContents, name) {
  const expectedHash = shaFileContents.trim().split(/\s+/)[0];
  const actualHash = crypto.createHash("sha256").update(buffer).digest("hex");
  if (actualHash !== expectedHash) {
    throw new Error(
      `SHA256 mismatch for ${name}: expected ${expectedHash}, got ${actualHash}`
    );
  }
  return actualHash;
}

/** Release-asset filename for a target. Windows builds ship as `.zip`, every
 *  other platform as `.tar.gz`. Pure — unit-testable. */
function assetName(target) {
  const ext = target.includes("windows") ? "zip" : "tar.gz";
  return `kache-${target}.${ext}`;
}

/** Download binary archive (tarball or zip) and verify SHA256 checksum */
async function downloadAndVerify(version, target) {
  const base = `https://github.com/kunobi-ninja/kache/releases/download/${version}`;
  const archiveName = assetName(target);
  const archiveUrl = `${base}/${archiveName}`;
  const shaUrl = `${archiveUrl}.sha256`;

  core.info(`Downloading ${archiveUrl}`);
  const archivePath = await tc.downloadTool(archiveUrl);

  core.info(`Downloading checksum ${shaUrl}`);
  const shaPath = await tc.downloadTool(shaUrl);

  verifyChecksum(
    fs.readFileSync(archivePath),
    fs.readFileSync(shaPath, "utf8"),
    archiveName
  );
  core.info("Checksum verified");

  return archivePath;
}

/** Run a kache CLI command, returning stdout.
 *  Uses @actions/exec which calls execFile (array args, no shell injection). */
async function runKache(args) {
  let stdout = "";
  let stderr = "";
  const exitCode = await actionsExec.exec("kache", args, {
    listeners: {
      stdout: (data) => {
        stdout += data.toString();
      },
      stderr: (data) => {
        stderr += data.toString();
      },
    },
    ignoreReturnCode: true,
  });
  if (exitCode !== 0) {
    core.warning(`kache ${args.join(" ")} exited with code ${exitCode}`);
    if (stderr) core.warning(stderr);
  }
  return stdout;
}

/** Check if S3 is configured */
function isS3Configured() {
  return !!core.getInput("s3-bucket");
}

/** Check if GitHub Actions cache should be used */
function useGitHubCache() {
  return !isS3Configured() && core.getInput("github-cache") === "true";
}

/** Resolve the kache cache dir for an explicit platform/env/home. Mirrors
 *  kache's `dirs::cache_dir().join("kache")`. Pure — unit-testable per platform.
 *  - macOS: ~/Library/Caches/kache
 *  - Windows: %LOCALAPPDATA%\kache (fallback ~/AppData/Local)
 *  - Linux/other: ~/.cache/kache */
function getCacheDirFor(platform, env, home) {
  if (env.KACHE_CACHE_DIR) return env.KACHE_CACHE_DIR;
  if (platform === "darwin")
    return path.join(home, "Library", "Caches", "kache");
  if (platform === "win32")
    return path.join(
      env.LOCALAPPDATA || path.join(home, "AppData", "Local"),
      "kache"
    );
  return path.join(home, ".cache", "kache");
}

/** Get the kache local cache directory (matches kache's default_cache_dir) */
function getCacheDir() {
  return getCacheDirFor(os.platform(), process.env, os.homedir());
}

/** Build a GitHub Actions cache key from Cargo.lock files and kache version.
 *  Including the kache version ensures that binary upgrades (which may change
 *  cache key computation) invalidate stale caches. GH Actions cache is immutable
 *  so without this, old entries would persist forever after a kache update. */
async function buildCacheKey(workspace = process.cwd()) {
  const prefix = core.getInput("cache-key-prefix") || "kache";
  const platform = `${os.platform()}-${os.arch()}`;
  const kacheVersion = process.env.KACHE_VERSION || "unknown";

  // Hash all Cargo.lock files in the workspace
  const pattern = path.join(workspace, "**/Cargo.lock");
  const globber = await glob.create(pattern, { followSymbolicLinks: false });
  const lockfiles = await globber.glob();

  let lockHash = "no-lockfile";
  if (lockfiles.length > 0) {
    const hasher = crypto.createHash("sha256");
    for (const f of lockfiles.sort()) {
      hasher.update(fs.readFileSync(f));
    }
    lockHash = hasher.digest("hex").slice(0, 16);
  }

  const key = `${prefix}-${kacheVersion}-${platform}-${lockHash}`;
  const restoreKeys = [`${prefix}-${kacheVersion}-${platform}-`];
  return { key, restoreKeys };
}

/** Restore kache directory from GitHub Actions cache. Returns cache hit key or undefined. */
async function restoreCache() {
  const cacheDir = getCacheDir();
  const { key, restoreKeys } = await buildCacheKey();
  core.info(`GitHub cache key: ${key}`);
  try {
    const hitKey = await cache.restoreCache([cacheDir], key, restoreKeys);
    if (hitKey) {
      core.info(`GitHub cache restored from key: ${hitKey}`);
    } else {
      core.info("GitHub cache miss");
    }
    return hitKey;
  } catch (err) {
    core.warning(`GitHub cache restore failed: ${err.message}`);
    return undefined;
  }
}

/** Save kache directory to GitHub Actions cache */
async function saveCache() {
  const cacheDir = getCacheDir();
  if (!fs.existsSync(cacheDir)) {
    core.info("No kache cache directory to save");
    return;
  }
  const { key } = await buildCacheKey();
  try {
    await cache.saveCache([cacheDir], key);
    core.info(`GitHub cache saved with key: ${key}`);
  } catch (err) {
    // Cache already exists for this key — not an error
    if (err.message?.includes("already exists")) {
      core.info("GitHub cache already up to date");
    } else {
      core.warning(`GitHub cache save failed: ${err.message}`);
    }
  }
}

/** Get path to kache's event log */
function getEventLogPath() {
  return path.join(getCacheDir(), "events.jsonl");
}

/** Clear the event log so we only capture this run's events */
function clearEventLog() {
  const logPath = getEventLogPath();
  try {
    fs.writeFileSync(logPath, "");
    core.info("Cleared kache event log");
  } catch {
    // Log may not exist yet — that's fine
  }
}

/** Clear the transfer log so we only capture this run's transfers */
function clearTransferLog() {
  const logPath = path.join(getCacheDir(), "transfers.jsonl");
  try {
    fs.writeFileSync(logPath, "");
    core.info("Cleared kache transfer log");
  } catch {
    // Log may not exist yet — that's fine
  }
}

/** Parse events.jsonl and compute stats for this run */
function parseEvents() {
  const logPath = getEventLogPath();
  if (!fs.existsSync(logPath)) return null;
  return parseEventsFrom(fs.readFileSync(logPath, "utf8"));
}

/** Aggregate run stats from raw events.jsonl content. Pure — no fs — so the
 *  hit-rate math, miss sorting and malformed-line handling are unit-testable.
 *  Returns null when there are no parseable events. */
function parseEventsFrom(rawContent) {
  const content = rawContent.trim();
  if (!content) return null;

  const events = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }

  if (events.length === 0) return null;

  let localHits = 0;
  let remoteHits = 0;
  let misses = 0;
  let errors = 0;
  const missedCrates = [];

  for (const e of events) {
    switch (e.result) {
      case "local_hit":
        localHits++;
        break;
      case "remote_hit":
        remoteHits++;
        break;
      case "miss":
        misses++;
        missedCrates.push({
          name: e.crate_name,
          elapsed_ms: e.elapsed_ms || 0,
          size: e.size || 0,
          cache_key: e.cache_key || "",
        });
        break;
      case "error":
        errors++;
        break;
    }
  }

  const total = localHits + remoteHits + misses;
  const hits = localHits + remoteHits;
  const hitRate = total > 0 ? ((hits / total) * 100).toFixed(1) : "0.0";

  // Sort misses by compile time (most expensive first)
  missedCrates.sort((a, b) => b.elapsed_ms - a.elapsed_ms);

  return {
    total,
    localHits,
    remoteHits,
    hits,
    misses,
    errors,
    hitRate,
    missedCrates,
  };
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Build stats table + cache misses markdown (shared by PR comment and job summary) */
function buildStatsMarkdown(stats, backend, duration) {
  const lines = [];

  // Stats table
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| Hit rate | ${stats.hitRate}% |`);
  lines.push(`| Local hits | ${stats.localHits} |`);
  lines.push(`| Remote hits | ${stats.remoteHits} |`);
  lines.push(`| Misses | ${stats.misses} |`);
  if (stats.errors > 0) {
    lines.push(`| Errors | ${stats.errors} |`);
  }
  lines.push(`| Total crates | ${stats.total} |`);
  lines.push(`| Backend | ${backend} |`);
  lines.push(`| Duration | ${duration}s |`);

  // Top cache misses
  if (stats.missedCrates.length > 0) {
    const top = stats.missedCrates.slice(0, 10);
    const hasKeys = top.some((c) => c.cache_key);
    lines.push("");
    lines.push("<details>");
    lines.push(`<summary>Cache misses (${stats.misses} crates)</summary>`);
    lines.push("");
    if (hasKeys) {
      lines.push("| Crate | Compile time | Size | Key |");
      lines.push("|-------|-------------|------|-----|");
      for (const c of top) {
        const key = c.cache_key ? `\`${c.cache_key.slice(0, 12)}\` ` : "";
        lines.push(
          `| \`${c.name}\` | ${formatMs(c.elapsed_ms)} | ${formatBytes(c.size)} | ${key}|`
        );
      }
    } else {
      lines.push("| Crate | Compile time | Size |");
      lines.push("|-------|-------------|------|");
      for (const c of top) {
        lines.push(
          `| \`${c.name}\` | ${formatMs(c.elapsed_ms)} | ${formatBytes(c.size)} |`
        );
      }
    }
    if (stats.missedCrates.length > 10) {
      const cols = hasKeys ? 4 : 3;
      const empties = "| ".repeat(cols - 1);
      lines.push(
        `| *... ${stats.missedCrates.length - 10} more* ${empties}|`
      );
    }
    lines.push("");
    lines.push("</details>");
  }

  return lines.join("\n");
}

/** Human-readable label identifying this matrix leg: "<job> (<target>)". */
function jobLabel() {
  const job = github.context.job || "build";
  let target;
  try {
    target = getTarget();
  } catch {
    target = "unknown";
  }
  return `${job} (${target})`;
}

/** Per-job sticky-comment marker so parallel matrix jobs don't clobber each
 *  other's comment. Keyed by GITHUB_JOB + target triple. Sanitized to stay on
 *  one line and not break the surrounding HTML comment. */
function commentMarker() {
  const key = jobLabel()
    .replace(/-->/g, "")
    .replace(/[\r\n]+/g, " ")
    .trim();
  return `<!-- kache-action-comment:${key} -->`;
}

/** Post or update a sticky PR comment with cache stats */
async function postOrUpdateComment(body, token) {
  const context = github.context;

  // Only post on pull requests
  const prNumber =
    context.payload.pull_request?.number ||
    context.issue?.number;
  if (!prNumber) {
    core.info("Not a PR context, skipping comment");
    return;
  }

  const marker = commentMarker();
  const markedBody = `${marker}\n${body}`;
  const octokit = github.getOctokit(token);
  const repo = context.repo;

  // Find existing comment
  const { data: comments } = await octokit.rest.issues.listComments({
    ...repo,
    issue_number: prNumber,
    per_page: 100,
  });

  const existing = comments.find(
    (c) => c.body && c.body.includes(marker)
  );

  if (existing) {
    await octokit.rest.issues.updateComment({
      ...repo,
      comment_id: existing.id,
      body: markedBody,
    });
    core.info(`Updated existing PR comment #${existing.id}`);
  } else {
    await octokit.rest.issues.createComment({
      ...repo,
      issue_number: prNumber,
      body: markedBody,
    });
    core.info("Posted new PR comment");
  }
}

/** Append the per-job label to the first "kache build cache" markdown heading,
 *  so the PR comment is self-identifying regardless of whether the body came
 *  from `kache report` or the legacy JS fallback. No-op if no such heading. */
function labelHeading(markdown, label) {
  // Escape so a future REPORT_HEADING with regex metacharacters stays literal.
  const heading = REPORT_HEADING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^(#{1,6}\\s+${heading})(.*)$`, "im");
  return markdown.replace(re, `$1 — ${label}$2`);
}

/** Check if caching is disabled via [no-cache] in the PR description */
function isNoCacheRequested() {
  const context = github.context;
  const body = context.payload.pull_request?.body || "";
  return body.includes("[no-cache]");
}

module.exports = {
  REPORT_HEADING,
  getTarget,
  getTargetFor,
  binaryName,
  assetName,
  verifyChecksum,
  getLatestVersion,
  downloadAndVerify,
  runKache,
  isS3Configured,
  useGitHubCache,
  getCacheDir,
  getCacheDirFor,
  buildCacheKey,
  restoreCache,
  saveCache,
  clearEventLog,
  clearTransferLog,
  parseEvents,
  parseEventsFrom,
  formatBytes,
  formatMs,
  buildStatsMarkdown,
  postOrUpdateComment,
  isNoCacheRequested,
  jobLabel,
  commentMarker,
  labelHeading,
};
