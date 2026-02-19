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

/** Map runner OS+arch to Rust target triple */
function getTarget() {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === "linux" && arch === "x64")
    return "x86_64-unknown-linux-musl";
  if (platform === "linux" && arch === "arm64")
    return "aarch64-unknown-linux-musl";
  if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";

  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

/** Fetch latest release tag from kunobi-ninja/kache. Returns null if no release exists. */
async function getLatestVersion(token) {
  const octokit = github.getOctokit(token);
  try {
    const { data } = await octokit.rest.repos.getLatestRelease({
      owner: "kunobi-ninja",
      repo: "kache",
    });
    return data.tag_name;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/** Download binary tarball and verify SHA256 checksum */
async function downloadAndVerify(version, target) {
  const base = `https://github.com/kunobi-ninja/kache/releases/download/${version}`;
  const tarName = `kache-${target}.tar.gz`;
  const tarUrl = `${base}/${tarName}`;
  const shaUrl = `${base}/${tarName}.sha256`;

  core.info(`Downloading ${tarUrl}`);
  const tarPath = await tc.downloadTool(tarUrl);

  core.info(`Downloading checksum ${shaUrl}`);
  const shaPath = await tc.downloadTool(shaUrl);

  // Verify SHA256
  const expectedLine = fs.readFileSync(shaPath, "utf8").trim();
  const expectedHash = expectedLine.split(/\s+/)[0];
  const fileBuffer = fs.readFileSync(tarPath);
  const actualHash = crypto
    .createHash("sha256")
    .update(fileBuffer)
    .digest("hex");

  if (actualHash !== expectedHash) {
    throw new Error(
      `SHA256 mismatch for ${tarName}: expected ${expectedHash}, got ${actualHash}`
    );
  }
  core.info("Checksum verified");

  return tarPath;
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

/** Get the kache local cache directory (matches kache's default_cache_dir) */
function getCacheDir() {
  if (process.env.KACHE_CACHE_DIR) return process.env.KACHE_CACHE_DIR;
  // Linux: ~/.cache/kache, macOS: ~/Library/Caches/kache
  const platform = os.platform();
  const home = os.homedir();
  if (platform === "darwin") return path.join(home, "Library", "Caches", "kache");
  return path.join(home, ".cache", "kache");
}

/** Build a GitHub Actions cache key from Cargo.lock files and kache version.
 *  Including the kache version ensures that binary upgrades (which may change
 *  cache key computation) invalidate stale caches. GH Actions cache is immutable
 *  so without this, old entries would persist forever after a kache update. */
async function buildCacheKey() {
  const prefix = core.getInput("cache-key-prefix") || "kache";
  const platform = `${os.platform()}-${os.arch()}`;
  const kacheVersion = process.env.KACHE_VERSION || "unknown";

  // Hash all Cargo.lock files in the workspace
  const pattern = "**/Cargo.lock";
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

/** Parse events.jsonl and compute stats for this run */
function parseEvents() {
  const logPath = getEventLogPath();
  if (!fs.existsSync(logPath)) return null;

  const content = fs.readFileSync(logPath, "utf8").trim();
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

/** Build a markdown PR comment body from event stats */
function buildCommentBody(stats, backend, duration) {
  const lines = [];

  lines.push("### kache build cache");
  lines.push("");
  lines.push(
    `**${stats.hitRate}%** hit rate \u2014 ${stats.hits}/${stats.total} crates from cache, ${stats.misses} compiled`
  );
  lines.push("");
  lines.push(buildStatsMarkdown(stats, backend, duration));
  lines.push("");
  lines.push("*Posted by [kache-action](https://github.com/kunobi-ninja/kache-action)*");

  return lines.join("\n");
}

const COMMENT_MARKER = "<!-- kache-action-comment -->";

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

  const markedBody = `${COMMENT_MARKER}\n${body}`;
  const octokit = github.getOctokit(token);
  const repo = context.repo;

  // Find existing comment
  const { data: comments } = await octokit.rest.issues.listComments({
    ...repo,
    issue_number: prNumber,
    per_page: 100,
  });

  const existing = comments.find(
    (c) => c.body && c.body.includes(COMMENT_MARKER)
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

module.exports = {
  getTarget,
  getLatestVersion,
  downloadAndVerify,
  runKache,
  isS3Configured,
  useGitHubCache,
  getCacheDir,
  restoreCache,
  saveCache,
  clearEventLog,
  parseEvents,
  buildStatsMarkdown,
  buildCommentBody,
  postOrUpdateComment,
};
