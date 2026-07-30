import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

/**
 * Scheduled refreshes.
 *
 * These keep the projection board current for everyone. `daily_refresh` appears in the
 * entitlement table but is `false` on both plans and listed in `UNIMPLEMENTED_FEATURES`,
 * precisely because these jobs rewrite shared rows that `projections.forWeek` serves to
 * free and Pro alike — there is no difference to sell. If refresh frequency is ever tiered,
 * that has to be built here and in the read path, not by flipping the flag.
 *
 * Two jobs, deliberately separate:
 *
 * - The schedule and betting lines move continuously through the week, and syncing them is
 *   cheap (one CSV, a few hundred rows). It runs several times a day.
 * - Projections are expensive (three seasons of statistics, thousands of rows) and only
 *   change when new production lands, so they run once daily, after the previous day's
 *   games have been ingested upstream.
 *
 * Both are idempotent, so a missed or duplicated run converges rather than corrupting.
 */
const crons = cronJobs();

// Upstream publishes on its own cadence; every six hours keeps lines fresh without
// hammering a public GitHub release.
crons.interval(
  "sync schedule and market lines",
  { hours: 6 },
  internal.ingest.refreshCurrentSchedule,
  {},
);

// 09:00 UTC is early morning in the US, after upstream has processed the prior day.
crons.cron(
  "recompute projections for the current week",
  "0 9 * * *",
  internal.ingest.refreshCurrentWeek,
  {},
);

export default crons;
