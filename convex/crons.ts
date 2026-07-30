import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

/**
 * Scheduled refreshes.
 *
 * This file exists because the entitlement table sells `daily_refresh`. Without a
 * scheduler nothing ever recomputed a projection, so that capability would have been sold
 * against a job that never ran — the same class of defect as granting a feature that does
 * not exist.
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
