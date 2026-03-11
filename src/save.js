const core = require("@actions/core");
const {
  runKache,
  saveCache,
  parseEvents,
  buildStatsMarkdown,
  buildReportMarkdown,
  buildCommentBody,
  postOrUpdateComment,
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

    // Try kache report (rich), fall back to parseEvents (legacy)
    let report = null;
    try {
      const json = await runKache(["report", "--format", "json", "--since", "24h"]);
      if (json && json.trim()) {
        report = JSON.parse(json);
      }
    } catch {
      // Older kache without report command — fall back to legacy
    }
    const stats = report ? null : parseEvents();

    const startTime = parseInt(core.getState("start-time") || "0", 10);
    const duration = startTime
      ? ((Date.now() - startTime) / 1000).toFixed(1)
      : "?";
    const backend = s3Configured
      ? "S3"
      : ghCache
        ? "GitHub Actions cache"
        : "local only";

    // Post/update sticky PR comment
    const hasData = report
      ? report.summary && report.summary.total_crates > 0
      : stats && stats.total > 0;

    if (hasData) {
      const token = core.getInput("token");
      const body = report
        ? buildCommentBody(report, backend)
        : buildCommentBody(stats, backend, duration);
      try {
        await postOrUpdateComment(body, token);
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

    if (report && report.summary && report.summary.total_crates > 0) {
      const s = report.summary;
      const totalHits = s.local_hits + s.prefetch_hits + s.remote_hits;
      summary = summary
        .addRaw(
          `**${s.hit_rate_pct.toFixed(1)}%** hit rate \u2014 ${totalHits}/${s.total_crates} crates from cache, ${s.misses} compiled\n\n`
        )
        .addRaw(buildReportMarkdown(report, backend))
        .addRaw("\n");
    } else if (stats && stats.total > 0) {
      summary = summary
        .addRaw(
          `**${stats.hitRate}%** hit rate \u2014 ${stats.hits}/${stats.total} crates from cache, ${stats.misses} compiled\n\n`
        )
        .addRaw(buildStatsMarkdown(stats, backend, duration))
        .addRaw("\n");
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
