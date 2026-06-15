const core = require("@actions/core");
const {
  runKache,
  saveCache,
  parseEvents,
  buildStatsMarkdown,
  postOrUpdateComment,
  jobLabel,
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
        lines.push(`### kache build cache — ${jobLabel()}`);
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

    // Post/update sticky PR comment (opt-out via pr-comment: false)
    const prCommentEnabled = core.getInput("pr-comment") !== "false";
    if (prCommentEnabled && commentBody) {
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
    } else if (!prCommentEnabled) {
      core.info("PR comment disabled (pr-comment: false)");
    }

    // Write job summary (always, even outside PRs).
    // commentBody from `kache report` already carries its own
    // "### kache build cache" title, so only add a heading for the
    // legacy fallback below to avoid a double title.
    let summary = core.summary;
    if (commentBody) {
      summary = summary.addRaw(commentBody).addRaw("\n");
    } else {
      summary = summary
        .addHeading("Kache Build Cache", 2)
        .addRaw(`**Backend:** ${backend} | **Duration:** ${duration}s\n\n`);
    }
    await summary.write();
  } catch (error) {
    // Post step should not fail the build
    core.warning(`kache post step failed: ${error.message}`);
  }
}

run();
