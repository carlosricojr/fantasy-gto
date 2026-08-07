import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";
import { BOARD_REFRESH_CRON } from "../lib/nfl/draft/refresh-plan";

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

// Twice a day through the preseason. The market moves continuously as camp news lands,
// and a board built yesterday misprices exactly the players whose value just changed.
// Outside the preseason this exits immediately, so it costs nothing in season.
//
// The expression comes from `refresh-plan.ts`, which also derives the staleness threshold
// the interface warns on from it. They were two independent literals — a `12` beside a cron
// nothing connected it to — so changing this schedule to every six hours would have left the
// interface calling a board that had missed four runs "fresh".
crons.cron(
  "rebuild draft boards",
  BOARD_REFRESH_CRON,
  internal.ingest.refreshDraftBoards,
  {},
);

export default crons;
