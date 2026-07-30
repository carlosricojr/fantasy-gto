"use node";

import { v } from "convex/values";

import { api, internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

import { DVP_SHRINKAGE } from "../lib/nfl/model/config";
import {
  type ImpliedTotalEntry,
  buildDefenseFactors,
  impliedTeamTotal,
  meanImpliedTotalBefore,
  projectPlayer,
} from "../lib/nfl/model/project";
import { DEFAULT_SCORING, SCORING_PRESETS } from "../lib/nfl/scoring/presets";
import { NflverseProvider } from "../lib/sources/nflverse";
import { NFL_REGULAR_SEASON_WEEKS } from "../lib/nfl/season";
import type { PlayerWeek } from "../lib/nfl/stats/parse";

/**
 * Projection ingest.
 *
 * Runs as a Node action because it fetches multi-megabyte CSVs and does real computation,
 * neither of which belongs in a transaction. Database writes are pushed back through small
 * internal mutations in batches.
 *
 * The whole job is idempotent: every write is an upsert keyed by
 * (player, season, week, ruleset), so a retry after a partial failure converges rather
 * than duplicating.
 */

/** Batch size for writes. Small enough to stay well inside a transaction's limits. */
const WRITE_BATCH = 100;

/**
 * How many weeks a player may go without appearing before they stop being projected.
 *
 * Four covers a bye plus a short-term injury. Beyond that the absence is more likely to be
 * injured reserve, a release, or retirement, and projecting stale form as a confident
 * number is worse than projecting nothing.
 */
const INACTIVITY_WEEKS = 4;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Computes and stores projections for a week.
 *
 * `season`/`week` identify the week being projected. History is drawn from the same season
 * plus the prior one, and defense-vs-position factors always come from the prior season so
 * no future information reaches a projection.
 */
export const projectWeek = internalAction({
  args: {
    season: v.number(),
    week: v.number(),
    scoringIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { season, week, scoringIds }): Promise<{
    projections: number;
    players: number;
    /** Skipped because no current-season appearance established their team. */
    unknownTeam: number;
  }> => {
    const startedAt = Date.now();
    const jobId = await ctx.runMutation(internal.jobs.start, {
      kind: `project:${season}-${week}`,
      detail: `Projecting ${season} week ${week}`,
    });

    try {
      const provider = new NflverseProvider();

      // Upstream publishes stats_player_week_{season}.csv only once games have been
      // played, so at week 1 a 404 is the normal state, not a failure. The file also
      // contributes nothing to week-1 history — every current-season row is dropped below
      // — so treating it as fatal would make week 1 permanently unprojectable.
      const currentSeason = await provider.playerWeeks(season);
      if (!currentSeason.ok && week > 1) throw new Error(currentSeason.reason);
      const currentWeeks: PlayerWeek[] = currentSeason.ok ? currentSeason.data : [];
      const priorSeason = await provider.playerWeeks(season - 1);
      // A missing prior season is survivable: early-career players simply have less
      // history and the matchup term is skipped.
      const priorWeeks: PlayerWeek[] = priorSeason.ok ? priorSeason.data : [];

      const contestsResult = await provider.allContests();
      const linesResult = await provider.allMarketLines();
      if (!contestsResult.ok) throw new Error(contestsResult.reason);
      if (!linesResult.ok) throw new Error(linesResult.reason);

      const lineByContest = new Map(linesResult.data.map((l) => [l.contestId, l]));

      // Each team's implied total per week, kept as a series. The Vegas term compares this
      // week against the team's own norm, and that norm is computed only from weeks
      // already played — collapsing the whole season to one average would let later form
      // inform an earlier projection.
      const currentTeamWeek = new Map<string, number>();
      const teamTotals = new Map<string, ImpliedTotalEntry[]>();
      const weekContestByTeam = new Map<string, (typeof contestsResult.data)[number]>();
      for (const contest of contestsResult.data) {
        if (contest.period.season !== season) continue;
        const line = lineByContest.get(contest.id);
        if (contest.period.index === week) {
          weekContestByTeam.set(contest.homeTeam, contest);
          weekContestByTeam.set(contest.awayTeam, contest);
        }
        if (!line) continue;
        for (const team of [contest.homeTeam, contest.awayTeam]) {
          const implied = impliedTeamTotal(
            line.total,
            line.spread,
            team,
            contest.homeTeam,
            contest.awayTeam,
          );
          if (implied === null) continue;
          const bucket = teamTotals.get(team) ?? [];
          bucket.push({ week: contest.period.index, impliedTotal: implied });
          teamTotals.set(team, bucket);
        }
      }

      // A player's team for THIS season, taken from their most recent current-season
      // appearance regardless of week.
      //
      // Which team someone plays for is not a prediction, so reading it from a row at or
      // after the target week is legitimate for a live run — unlike their production,
      // which is strictly excluded below. Deriving the team from `history` instead would
      // read a *prior-season* row at week 1 and project every player against their old
      // team's game: wrong opponent, wrong betting line, and the bye-week guard passes
      // because the old team does play. The same thing happens after a trade.
      const currentTeam = new Map<string, string>();
      for (const playerWeek of currentWeeks) {
        const team = playerWeek.competitor.team;
        if (!team) continue;
        const seen = currentTeamWeek.get(playerWeek.competitor.id) ?? -1;
        if (playerWeek.period.index > seen) {
          currentTeamWeek.set(playerWeek.competitor.id, playerWeek.period.index);
          currentTeam.set(playerWeek.competitor.id, team);
        }
      }

      // History strictly before the target week.
      const history = new Map<string, PlayerWeek[]>();
      for (const playerWeek of [...priorWeeks, ...currentWeeks]) {
        const isFuture =
          playerWeek.period.season === season && playerWeek.period.index >= week;
        if (isFuture) continue;
        const bucket = history.get(playerWeek.competitor.id) ?? [];
        bucket.push(playerWeek);
        history.set(playerWeek.competitor.id, bucket);
      }
      for (const bucket of history.values()) {
        bucket.sort(
          (a, b) => a.period.season - b.period.season || a.period.index - b.period.index,
        );
      }

      // An unrecognised ruleset must fail the job, not be silently dropped. Filtering it
      // out would report success while writing no projections for that ruleset, and the
      // gap would only surface as an empty board days later.
      const rulesets = (scoringIds ?? [DEFAULT_SCORING.id]).map((id) => {
        const preset = SCORING_PRESETS.find((candidate) => candidate.id === id);
        if (!preset) throw new Error(`Unknown scoring ruleset "${id}"`);
        return preset;
      });

      // Persist identity for everyone we know about, so rosters can resolve names.
      const identities = new Map<
        string,
        { externalId: string; name: string; position: string; team: string | null }
      >();
      for (const bucket of history.values()) {
        const latest = bucket[bucket.length - 1];
        identities.set(latest.competitor.id, {
          externalId: latest.competitor.id,
          name: latest.competitor.name,
          position: latest.competitor.position,
          team: latest.competitor.team,
        });
      }
      for (const batch of chunk([...identities.values()], WRITE_BATCH)) {
        await ctx.runMutation(internal.projections.upsertPlayers, { players: batch });
      }

      let written = 0;
      let unknownTeam = 0;
      // Declared before the loop so progress reports one stable denominator for the whole
      // run rather than a number that changes as each ruleset starts.
      let totalExpected = 0;
      for (const scoring of rulesets) {
        const defenseFactors = buildDefenseFactors(priorWeeks, scoring, DVP_SHRINKAGE);

        const rows = [];
        for (const [playerId, bucket] of history) {
          const latest = bucket[bucket.length - 1];
          const position = latest.competitor.position;
          if (position === "DST") continue;

          // Only project players who are plausibly still active.
          //
          // History spans two seasons, so without this a player who retired, was released,
          // or has been on injured reserve since September keeps producing a confident
          // projection from stale form — and `mean <= 0` never catches them, because their
          // old form was good. Two rules, both derived from what the data can actually
          // tell us:
          //
          //  - after week 1, they must have played at least once in the current season;
          //  - and their last appearance must be recent, which is what distinguishes a
          //    bye or a one-week knock from a season-ending absence.
          //
          // The recency test spans the season boundary, so a player who was hurt in week 3
          // of last season and never returned is excluded from week 1 of this one. Without
          // that, the only week where the current-season rule cannot apply is exactly the
          // week the staleness check was skipped.
          const lastPlayed = latest.period;
          if (week > 1 && lastPlayed.season !== season) continue;
          const weeksSincePlayed =
            lastPlayed.season === season
              ? week - lastPlayed.index
              : NFL_REGULAR_SEASON_WEEKS - lastPlayed.index + week;
          if (weeksSincePlayed > INACTIVITY_WEEKS) continue;

          // Never fall back to `latest.competitor.team`: at week 1 that is last season's
          // team. Without current-season evidence the player's team is genuinely unknown,
          // and skipping is better than projecting them into the wrong game.
          const team = currentTeam.get(playerId) ?? null;
          if (!team) {
            unknownTeam += 1;
            continue;
          }
          const contest = weekContestByTeam.get(team);

          // No contest this week means the team is on bye (or the player has no team).
          // Such a player will score exactly zero, so they must not be projected at all.
          //
          // Without this the model happily returns their normal projection — the Vegas and
          // matchup terms are *skipped* when there is no game, not zeroed — and the lineup
          // solver, which is advertised as provably optimal, would start them. Verified on
          // 2025 week 10: four teams are on bye, and Ja'Marr Chase and Patrick Mahomes
          // ranked 4th and 8th on a board they should not have appeared on at all.
          if (!contest || !team) continue;

          const line = lineByContest.get(contest.id);
          const opponent =
            contest.homeTeam === team ? contest.awayTeam : contest.homeTeam;

          const projection = projectPlayer({
            competitorId: playerId,
            position,
            period: { season, index: week },
            history: bucket,
            game: {
              opponent,
              impliedTeamTotal: line
                ? impliedTeamTotal(
                    line.total,
                    line.spread,
                    team,
                    contest.homeTeam,
                    contest.awayTeam,
                  )
                : null,
              teamMeanImpliedTotal: team
                ? meanImpliedTotalBefore(teamTotals.get(team) ?? [], week)
                : null,
            },
            scoring,
            defenseFactors,
          });

          // A player projected at zero has no usable history; storing them adds noise.
          if (projection.mean <= 0) continue;

          rows.push({
            season,
            week,
            playerId,
            position,
            scoringId: scoring.id,
            team,
            opponent,
            mean: projection.mean,
            floor: projection.floor,
            ceiling: projection.ceiling,
            contributions: projection.contributions,
            modelVersion: projection.modelVersion,
          });
        }

        totalExpected = Math.max(totalExpected, rows.length * rulesets.length);

        for (const batch of chunk(rows, WRITE_BATCH)) {
          await ctx.runMutation(internal.projections.upsertBatch, { rows: batch });
          written += batch.length;
          // `rows.length` is this ruleset's count, so multiplying it by the ruleset
          // count only gives a stable total when every ruleset produces the same number
          // of rows. It does — the eligibility filters are ruleset-independent — but
          // deriving the total from the eligible-player count states that directly
          // instead of relying on the coincidence.
          await ctx.runMutation(internal.jobs.progress, {
            jobId,
            processed: written,
            total: totalExpected,
          });
        }
      }

      await ctx.runMutation(internal.jobs.finish, {
        jobId,
        status: "succeeded",
        error: null,
      });

      return { projections: written, players: identities.size, unknownTeam };
    } catch (error) {
      await ctx.runMutation(internal.jobs.finish, {
        jobId,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      void startedAt;
    }
  },
});

/**
 * Resolves the live season and week, then recomputes projections for it.
 *
 * The entry point for the daily cron. It derives the week from the schedule rather than
 * the clock, for the same reason the interface does: during the offseason the calendar
 * year and the season with data disagree.
 *
 * Returns rather than throws when there is nothing to do, so a quiet offseason does not
 * fill the job log with failures.
 */
export const refreshCurrentWeek = internalAction({
  args: {},
  handler: async (ctx): Promise<{ skipped: boolean; season?: number; week?: number }> => {
    const state = await ctx.runQuery(api.season.current, {});
    if (!state || state.isComplete) return { skipped: true };

    await ctx.runAction(internal.ingest.projectWeek, {
      season: state.season,
      week: state.week,
      scoringIds: SCORING_PRESETS.map((preset) => preset.id),
    });
    return { skipped: false, season: state.season, week: state.week };
  },
});

/** Refreshes the schedule and lines for whichever season is live. */
export const refreshCurrentSchedule = internalAction({
  args: {},
  handler: async (ctx): Promise<{ skipped: boolean; contests?: number }> => {
    const state = await ctx.runQuery(api.season.current, {});
    if (!state) return { skipped: true };

    // Sync the next season too. `season.current` resolves to the latest season with a
    // *completed* game, so syncing only that season means next season's rows never land,
    // `season.current` can never advance to it, and both crons stay frozen on a finished
    // season indefinitely.
    let contests = 0;
    for (const season of [state.season, state.season + 1]) {
      const result = await ctx.runAction(internal.ingest.syncSchedule, { season });
      contests += result.contests;
    }
    return { skipped: false, contests };
  },
});

/** Refreshes the stored schedule and market lines for a season. */
export const syncSchedule = internalAction({
  args: { season: v.number() },
  handler: async (ctx, { season }): Promise<{ contests: number }> => {
    const provider = new NflverseProvider();
    const contestsResult = await provider.allContests();
    const linesResult = await provider.allMarketLines();
    if (!contestsResult.ok) throw new Error(contestsResult.reason);
    if (!linesResult.ok) throw new Error(linesResult.reason);

    const lineByContest = new Map(linesResult.data.map((l) => [l.contestId, l]));
    const rows = contestsResult.data
      .filter((contest) => contest.period.season === season)
      .map((contest) => {
        const line = lineByContest.get(contest.id);
        return {
          externalId: contest.id,
          season: contest.period.season,
          week: contest.period.index,
          homeTeam: contest.homeTeam,
          awayTeam: contest.awayTeam,
          startsAt: contest.startsAt,
          spread: line?.spread ?? null,
          total: line?.total ?? null,
          homeScore: contest.result?.homeScore ?? null,
          awayScore: contest.result?.awayScore ?? null,
        };
      });

    for (const batch of chunk(rows, WRITE_BATCH)) {
      await ctx.runMutation(internal.contests.upsertBatch, { rows: batch });
    }

    return { contests: rows.length };
  },
});
