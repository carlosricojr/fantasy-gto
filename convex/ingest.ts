"use node";

import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

import { DVP_SHRINKAGE } from "../lib/nfl/model/config";
import {
  buildDefenseFactors,
  impliedTeamTotal,
  projectPlayer,
} from "../lib/nfl/model/project";
import { DEFAULT_SCORING, SCORING_PRESETS } from "../lib/nfl/scoring/presets";
import { NflverseProvider } from "../lib/nfl/stats/nflverse";
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
  }> => {
    const startedAt = Date.now();
    const jobId = await ctx.runMutation(internal.jobs.start, {
      kind: `project:${season}-${week}`,
      detail: `Projecting ${season} week ${week}`,
    });

    try {
      const provider = new NflverseProvider();

      const currentSeason = await provider.playerWeeks(season);
      if (!currentSeason.ok) throw new Error(currentSeason.reason);
      const priorSeason = await provider.playerWeeks(season - 1);
      // A missing prior season is survivable: early-career players simply have less
      // history and the matchup term is skipped.
      const priorWeeks: PlayerWeek[] = priorSeason.ok ? priorSeason.data : [];

      const contestsResult = await provider.allContests();
      const linesResult = await provider.allMarketLines();
      if (!contestsResult.ok) throw new Error(contestsResult.reason);
      if (!linesResult.ok) throw new Error(linesResult.reason);

      const lineByContest = new Map(linesResult.data.map((l) => [l.contestId, l]));

      // Each team's own average implied total for the season, the reference the Vegas
      // term is measured against.
      const teamTotals = new Map<string, number[]>();
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
          bucket.push(implied);
          teamTotals.set(team, bucket);
        }
      }
      const teamMean = new Map<string, number>();
      for (const [team, values] of teamTotals) {
        teamMean.set(team, values.reduce((s, v) => s + v, 0) / values.length);
      }

      // History strictly before the target week.
      const history = new Map<string, PlayerWeek[]>();
      for (const playerWeek of [...priorWeeks, ...currentSeason.data]) {
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

      const rulesets = (scoringIds ?? [DEFAULT_SCORING.id])
        .map((id) => SCORING_PRESETS.find((preset) => preset.id === id))
        .filter((preset): preset is (typeof SCORING_PRESETS)[number] => preset !== undefined);

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
      for (const scoring of rulesets) {
        const defenseFactors = buildDefenseFactors(priorWeeks, scoring, DVP_SHRINKAGE);

        const rows = [];
        for (const [playerId, bucket] of history) {
          const latest = bucket[bucket.length - 1];
          const position = latest.competitor.position;
          if (position === "DST") continue;

          const team = latest.competitor.team;
          const contest = team ? weekContestByTeam.get(team) : undefined;
          const line = contest ? lineByContest.get(contest.id) : undefined;
          const opponent = contest
            ? contest.homeTeam === team
              ? contest.awayTeam
              : contest.homeTeam
            : null;

          const projection = projectPlayer({
            competitorId: playerId,
            position,
            period: { season, index: week },
            history: bucket,
            game: {
              opponent,
              impliedTeamTotal:
                contest && line && team
                  ? impliedTeamTotal(
                      line.total,
                      line.spread,
                      team,
                      contest.homeTeam,
                      contest.awayTeam,
                    )
                  : null,
              teamMeanImpliedTotal: team ? (teamMean.get(team) ?? null) : null,
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
            mean: projection.mean,
            floor: projection.floor,
            ceiling: projection.ceiling,
            contributions: projection.contributions,
            modelVersion: projection.modelVersion,
          });
        }

        for (const batch of chunk(rows, WRITE_BATCH)) {
          await ctx.runMutation(internal.projections.upsertBatch, { rows: batch });
          written += batch.length;
          await ctx.runMutation(internal.jobs.progress, {
            jobId,
            processed: written,
            total: rows.length * rulesets.length,
          });
        }
      }

      await ctx.runMutation(internal.jobs.finish, {
        jobId,
        status: "succeeded",
        error: null,
      });

      return { projections: written, players: identities.size };
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
