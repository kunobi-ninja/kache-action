const core = require("@actions/core");
const {
  runKache,
  saveCache,
  parseEvents,
  buildStatsMarkdown,
  postOrUpdateComment,
  COMMENT_MARKER,
} = require("./utils");

async function run() {
  try {
    // Skip post step if [no-cache] was detected during setup
    if (core.getState("no-cache") === "true") {
      core.info("[no-cache] — skipping kache post step");
      return;
    }

    const s3Configured = core.getState("s3-configured") === "true";
    const ghCache = core.getState("gh-cache") === "true";

    // Push cache: S3 or GitHub Actions cache
    if (s3Configured) {
      // Save manifest first — records which keys were used + cost data for next warm
      const saveArgs = ["save-manifest"];
      const manifestKey = core.getInput("manifest-key");
      if (manifestKey) saveArgs.push("--manifest-key", manifestKey);
      core.info("Saving build manifest...");
      await runKache(saveArgs);

      core.info("Pushing cache to S3...");
      await runKache(["sync", "--push"]);
    } else if (ghCache) {
      core.info("Saving cache to GitHub Actions cache...");
      await saveCache();
    }

    // Get report markdown directly from kache (kache owns all rendering)
    let reportMarkdown = null;
    try {
      const md = await runKache(["report", "--format", "github", "--since", "24h"]);
      if (md && md.trim() && md.includes("kache build cache")) {
        reportMarkdown = md.trim();
      }
    } catch {
      // Older kache without report/github format — fall back to legacy
    }

    // Legacy fallback for older kache versions
    const startTime = parseInt(core.getState("start-time") || "0", 10);
    const duration = startTime
      ? ((Date.now() - startTime) / 1000).toFixed(1)
      : "?";
    const backend = s3Configured
      ? "S3"
      : ghCache
        ? "GitHub Actions cache"
        : "local only";

    let commentBody = reportMarkdown;
    if (!commentBody) {
      const stats = parseEvents();
      if (stats && stats.total > 0) {
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
        commentBody = lines.join("\n");
      }
    }

    // Post/update sticky PR comment
    if (commentBody) {
      const token = core.getInput("token");
      try {
        await postOrUpdateComment(commentBody, token);
      } catch (err) {
        if (err.message?.includes("Resource not accessible")) {
          core.info(
            "Skipping PR comment — token lacks pull-requests: write permission"
          );
        } else {
          core.warning(`Failed to post PR comment: ${err.message}`);
        }
      }
    }

    // Write job summary (always, even outside PRs)
    let summary = core.summary.addHeading("Kache Build Cache", 2);
    if (commentBody) {
      summary = summary.addRaw(commentBody).addRaw("\n");
    } else {
      summary = summary.addRaw(
        `**Backend:** ${backend} | **Duration:** ${duration}s\n\n`
      );
    }
    await summary.write();
  } catch (error) {
    // Post step should not fail the build
    core.warning(`kache post step failed: ${error.message}`);
  }
}

run();
