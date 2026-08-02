"use node";

import { v } from "convex/values";

import { api, internal } from "./_generated/api";
import { type ActionCtx, internalAction } from "./_generated/server";

import type { Contribution } from "../lib/core/domain";
import { DVP_SHRINKAGE } from "../lib/nfl/model/config";
import { GAMES_IN_SEASON } from "../lib/nfl/draft/config";
import {
  type ImpliedTotalEntry,
  buildDefenseFactors,
  impliedTeamTotal,
  meanImpliedTotalBefore,
  projectPlayer,
} from "../lib/nfl/model/project";
import { DEFAULT_SCORING, SCORING_PRESETS } from "../lib/nfl/scoring/presets";
import { scoreOffense } from "../lib/nfl/scoring/score";
import { NflverseProvider } from "../lib/sources/nflverse";
import { AdpProvider } from "../lib/sources/adp";
import {
  DRAFTABLE_POSITIONS,
  MODELLED_POSITIONS,
  normalizeMarketPosition,
} from "../lib/nfl/draft/config";
import { buildMarketIndex, normalizeName } from "../lib/nfl/draft/match";
import {
  type AdpCurveSet,
  adpImpliedPoints,
  blendedSeasonValue,
  fitAdpCurves,
  seasonProjection,
} from "../lib/nfl/draft/value";
import { weeksBetween } from "../lib/nfl/season";
import { OUTCOME_QUANTILES, PLACEHOLDER_QUANTILES } from "../lib/nfl/model/config";
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

/** One stored projection, as `projections.upsertBatch` accepts it. */
interface ProjectionRow {
  season: number;
  week: number;
  playerId: string;
  position: string;
  scoringId: string;
  team: string;
  opponent: string;
  mean: number;
  floor: number;
  ceiling: number;
  contributions: Contribution[];
  modelVersion: string;
}

/**
 * Prior strength and mean for a player's weekly availability.
 *
 * Games played is a small sample — seventeen at most — so taking it at face value says a
 * player who finished last season is certain to finish this one, and that a rookie who
 * played nothing never plays. Both are wrong, and the second is worse: it would make every
 * incoming player worthless.
 *
 * Shrinking towards a league-typical rate fixes both. The prior is worth about ten games,
 * so a full season moves a player most of the way to the top and a lost season does not
 * write him off.
 *
 * Judgement, not measurement. The prior mean is roughly the share of games a rostered
 * skill player actually takes part in.
 */
const AVAILABILITY_PRIOR_MEAN = 0.85;
const AVAILABILITY_PRIOR_GAMES = 10;

/**
 * Weekly availability, shrunk from a player's own games played toward the league rate.
 *
 * `hasHistory` separates two situations the arithmetic cannot tell apart. A veteran who
 * played no games last season is evidence of poor availability; a rookie who played none
 * is no evidence at all, and shrinking his zero produced 0.31 — an incoming first-rounder
 * treated as missing two games in three.
 *
 * The denominator is games in a season, not weeks. A team plays seventeen times across
 * eighteen weeks, so dividing by eighteen capped every ironman below the ceiling.
 */
function shrunkAvailability(priorSeasonGames: number, hasHistory: boolean): number {
  if (!hasHistory) return AVAILABILITY_PRIOR_MEAN;
  const played = Math.min(Math.max(priorSeasonGames, 0), GAMES_IN_SEASON);
  const prior = AVAILABILITY_PRIOR_MEAN * AVAILABILITY_PRIOR_GAMES;
  return (played + prior) / (GAMES_IN_SEASON + AVAILABILITY_PRIOR_GAMES);
}

/**
 * League sizes a draft board is built for.
 *
 * ADP is published per league size and genuinely differs between them, so a board is not
 * transferable. These are the sizes that cover almost every real league; an unusual one
 * has to be built by hand.
 */
const DRAFT_BOARD_LEAGUE_SIZES = [8, 10, 12, 14] as const;

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

/**
 * Fraction of the week's playing teams that must have at least one projectable player.
 *
 * Below this the board is not representative — most commonly at week 1, before the stats
 * file has anything but the Thursday opener in it.
 */
const MIN_TEAM_COVERAGE = 0.9;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Computes and stores projections for a week.
 *
 * `season`/`week` identify the week being projected. History is drawn from the same season
 * plus the two before it, matching the window `scripts/backtest.ts` feeds the model — the
 * populations still differ, since the backtest filters on prior-game counts and the ingest
 * on staleness, team resolution, and byes, but the model sees the same depth of history in
 * both. Defense-vs-position factors come from the immediately prior season only, so no
 * future information reaches a projection.
 */
export const projectWeek = internalAction({
  args: {
    season: v.number(),
    week: v.number(),
    scoringIds: v.optional(v.array(v.string())),
  },
  handler: (ctx, args): Promise<ProjectWeekResult> =>
    runProjectWeek(ctx, args, new NflverseProvider()),
});

export interface ProjectWeekResult {
  projections: number;
  players: number;
  /** Skipped because no current-season appearance established their team. */
  unknownTeam: number;
}

/** The database surface the run needs. Narrowed so a test can supply it directly. */
type ProjectWriteCtx = Pick<ActionCtx, "runMutation">;

/**
 * The body of `projectWeek`, with its data source and database handed in.
 *
 * Separated from the action purely so both are injectable. The ordering this function
 * imposes — every row buffered until team coverage is verified — is the kind of property
 * that can only be tested by observing the sequence of writes, and that is untestable
 * while the provider is constructed inside the handler.
 */
export async function runProjectWeek(
  ctx: ProjectWriteCtx,
  { season, week, scoringIds }: { season: number; week: number; scoringIds?: string[] },
  provider: NflverseProvider,
): Promise<ProjectWeekResult> {
  {
    const startedAt = Date.now();
    const jobId = await ctx.runMutation(internal.jobs.start, {
      kind: `project:${season}-${week}`,
      detail: `Projecting ${season} week ${week}`,
    });

    try {
      // Upstream publishes stats_player_week_{season}.csv only once games have been
      // played, so at week 1 a 404 is the normal state, not a failure. The file also
      // contributes nothing to week-1 history — every current-season row is dropped below
      // — so treating it as fatal would make week 1 permanently unprojectable.
      const currentSeason = await provider.playerWeeks(season);
      if (!currentSeason.ok && week > 1) throw new Error(currentSeason.reason);
      const currentWeeks: PlayerWeek[] = currentSeason.ok ? currentSeason.data : [];

      // Load the same number of prior seasons the backtest does.
      //
      // `scripts/backtest.ts` feeds `projectPlayer` three seasons; loading fewer here
      // would mean the published accuracy figure was measured on a pipeline that differs
      // from the one serving users. The effect on any single projection is small, but the
      // problem is categorical: the number on /accuracy has to describe the shipped model.
      const priorSeasonCount = 2;
      // A missing prior season is survivable: early-career players simply have less
      // history and the matchup term is skipped.
      const priorWeeks: PlayerWeek[] = [];
      for (let back = priorSeasonCount; back >= 1; back -= 1) {
        const result = await provider.playerWeeks(season - back);
        if (result.ok) priorWeeks.push(...result.data);
      }

      // Defense-vs-position factors come from the immediately prior season only, matching
      // the backtest. Using the full window would blend two seasons of defensive form.
      const dvpSource = priorWeeks.filter((w) => w.period.season === season - 1);

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
      const coveredTeams = new Set<string>();
      // Declared before the loop so progress reports one stable denominator for the whole
      // run rather than a number that changes as each ruleset starts.
      let totalExpected = 0;
      /**
       * Rows held until team coverage has been verified.
       *
       * Writing as each ruleset finishes and checking coverage afterwards is not
       * equivalent: `projections.forWeek` is a public query that filters on neither job
       * status nor freshness, and no page reads the job record, so rows written before a
       * failed check stay live and are served as if they were the whole week. At week 1
       * that is a ~40-player board from the Thursday opener, with the optimiser solving
       * against a pool missing nearly every player a user owns.
       */
      const pending: ProjectionRow[][] = [];
      for (const scoring of rulesets) {
        const defenseFactors = buildDefenseFactors(dvpSource, scoring, DVP_SHRINKAGE);

        const rows: ProjectionRow[] = [];
        for (const [playerId, bucket] of history) {
          const latest = bucket[bucket.length - 1];
          const position = latest.competitor.position;
          if (position === "DST") continue;

          // Only project players who are plausibly still active.
          //
          // History spans three seasons, so without this a player who retired, was released,
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
          // Counted across season boundaries, multiplying the season gap out. Treating
          // the last appearance as always being in the immediately preceding season
          // understates a two-season absence by roughly a year — history spans three
          // seasons, so a player who missed all of last season would read as a couple of
          // weeks idle and keep producing a confident projection from year-old form.
          const weeksSincePlayed = weeksBetween(lastPlayed, { season, index: week });
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

          coveredTeams.add(team);
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

        // Scaling one ruleset's row count by the ruleset count is only a stable
        // denominator because the eligibility filters are ruleset-independent, so every
        // ruleset yields the same number of rows. `Math.max` keeps progress monotonic if
        // that ever stops holding.
        totalExpected = Math.max(totalExpected, rows.length * rulesets.length);
        pending.push(rows);
      }

      // Coverage is decided before anything is written.
      //
      // A run must cover most of the teams playing that week, not merely produce *some*
      // rows. Zero rows alone is too weak a test: at week 1 the stats file initially holds
      // only the Thursday opener, so a handful of players resolve a current-season team
      // and everyone else is skipped — the run would look successful while serving a board
      // whose games have already finished. The same check catches a truncated upstream
      // file mid-season.
      const teamsPlaying = new Set(weekContestByTeam.keys()).size;
      const coverage = teamsPlaying === 0 ? 0 : coveredTeams.size / teamsPlaying;

      if (coverage < MIN_TEAM_COVERAGE) {
        await ctx.runMutation(internal.jobs.finish, {
          jobId,
          status: "failed",
          error:
            `Only ${coveredTeams.size} of ${teamsPlaying} teams playing ${season} week ${week} ` +
            `had a projectable player (${unknownTeam} skipped for no current-season ` +
            `appearance). Nothing was written: a partial board would be served as though it ` +
            `were the whole week.`,
        });
        return { projections: 0, players: identities.size, unknownTeam };
      }

      // One stamp for the whole run. Every row this run writes carries it, so the prune
      // below identifies an earlier run's leftovers by exact comparison rather than by
      // where batch boundaries happened to fall in time.
      const writeStartedAt = Date.now();
      for (const rows of pending) {
        for (const batch of chunk(rows, WRITE_BATCH)) {
          await ctx.runMutation(internal.projections.upsertBatch, {
            rows: batch,
            computedAt: writeStartedAt,
          });
          written += batch.length;
          await ctx.runMutation(internal.jobs.progress, {
            jobId,
            processed: written,
            total: totalExpected,
          });
        }
      }

      // Anything left from an earlier run that this one did not rewrite is stale — a
      // player who has since been traded, benched, or put on a bye. Pruned only after the
      // coverage check passed, so a failed run cannot empty a good board.
      await ctx.runMutation(internal.projections.pruneStale, {
        season,
        week,
        scoringIds: rulesets.map((r) => r.id),
        computedBefore: writeStartedAt,
      });

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
  }
}

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

/**
 * Builds the season-long draft board.
 *
 * Distinct from `projectWeek` in what it needs and when it runs. A weekly projection is
 * driven by recent form and can only exist once games have been played; a draft board is
 * needed *before* the season, when there is no current-season form at all and a player's
 * team comes from the roster release rather than from an appearance.
 *
 * The board is the blend of two estimates — ours and the market's. The blend does **not**
 * out-rank the market: on held-out 2024 the market scored 0.5403 by rank correlation and
 * the blend 0.5364. It is kept because it wins on total points among each method's top 24,
 * because one evaluation season of 151 players cannot settle a disagreement between two
 * metrics, and because the model prices players the market has no published ADP for at
 * all. `docs/draft-validation.md` has the figures and `pnpm draft-backtest` reproduces
 * them. No ranking edge over the market may be claimed anywhere in the interface.
 */
export const buildDraftBoard = internalAction({
  args: {
    season: v.number(),
    scoringId: v.optional(v.string()),
    teams: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ players: number; withMarketPrice: number; unpriced: number }> =>
    runBuildDraftBoard(ctx, args, new NflverseProvider(), new AdpProvider()),
});

export async function runBuildDraftBoard(
  ctx: ProjectWriteCtx,
  {
    season,
    scoringId = DEFAULT_SCORING.id,
    teams = 12,
  }: { season: number; scoringId?: string; teams?: number },
  provider: NflverseProvider,
  adpProvider: AdpProvider,
): Promise<{ players: number; withMarketPrice: number; unpriced: number }> {
  const jobId = await ctx.runMutation(internal.jobs.start, {
    kind: `draft:${season}-${scoringId}-${teams}`,
    detail: `Building ${season} draft board (${scoringId}, ${teams}-team)`,
  });

  try {
    // Who is on a team this season. The only source that knows before a game is played.
    const rosterResult = await provider.seasonRoster(season);
    if (!rosterResult.ok) throw new Error(rosterResult.reason);

    // Two prior seasons of production, matching the backtest's window.
    const priorSeasons: PlayerWeek[][] = [];
    for (const back of [2, 1]) {
      const result = await provider.playerWeeks(season - back);
      if (!result.ok) throw new Error(result.reason);
      priorSeasons.push(result.data);
    }

    const adpResult = await adpProvider.forSeason(season, scoringId, teams);
    if (!adpResult.ok) throw new Error(adpResult.reason);

    const scoring = SCORING_PRESETS.find((preset) => preset.id === scoringId);
    if (!scoring) throw new Error(`Unknown scoring ruleset "${scoringId}".`);

    // Per-game points, oldest first, and games played in the immediately prior season.
    const perGame = new Map<string, number[]>();
    const priorGames = new Map<string, number>();
    for (const [index, weeks] of priorSeasons.entries()) {
      const ordered = [...weeks].sort((a, b) => a.period.index - b.period.index);
      for (const week of ordered) {
        const id = week.competitor.id;
        const points = scoreOffense(week.stats, scoring).total;
        perGame.set(id, [...(perGame.get(id) ?? []), points]);
        if (index === 1) priorGames.set(id, (priorGames.get(id) ?? 0) + 1);
      }
    }

    // The market curve turns a draft slot into points, and is fitted on a season that is
    // already finished — never on the one being drafted, which would be reading the
    // answers.
    //
    // Which season that is cannot be assumed to be the previous one. A curve needs *both*
    // a published ADP board and a finished result, and those do not always coincide:
    // there is no 2025 board at all, so a 2026 draft has to reach back to 2024. Trying
    // only `season - 1` silently produced a board with no market component whatsoever —
    // which is not a degraded version of this product, it is the pure-model board that
    // measurement says is the *worse* of the two signals.
    const seasonTotals = (weeks: readonly PlayerWeek[]) => {
      const totals = new Map<string, number>();
      const byId = new Map<string, { name: string; position: string }>();
      for (const week of weeks) {
        // A kicking line scores zero through the offensive scorer, so including kickers
        // here would fit the curve through a band of false zeros.
        if (
          !MODELLED_POSITIONS.includes(
            week.competitor.position as (typeof MODELLED_POSITIONS)[number],
          )
        ) {
          continue;
        }
        const id = week.competitor.id;
        totals.set(id, (totals.get(id) ?? 0) + scoreOffense(week.stats, scoring).total);
        byId.set(id, { name: week.competitor.name, position: week.competitor.position });
      }
      // The same position-qualified, collision-refusing index the roster join uses, rather
      // than a second hand-rolled scheme that has to be trusted separately. This lookup
      // supplies the actual season points `fitAdpCurves` is fitted on, so a collision does
      // not merely mislabel two players — it pairs one player's points with the other's ADP
      // inside the fit, and the resulting curve prices everyone at that position.
      return buildMarketIndex(
        [...byId].map(([id, who]) => ({ ...who, total: totals.get(id) ?? 0 })),
        normalizeMarketPosition,
      );
    };

    let curve: AdpCurveSet | null = null;
    const curveAttempts: string[] = [];
    for (const [offset, weeks] of [
      [1, priorSeasons[1]],
      [2, priorSeasons[0]],
    ] as const) {
      const candidateSeason = season - offset;
      const candidateAdp = await adpProvider.forSeason(candidateSeason, scoringId, teams);
      if (!candidateAdp.ok) {
        curveAttempts.push(`${candidateSeason}: no ADP board`);
        continue;
      }
      const seasonPoints = seasonTotals(weeks);
      // Fitted on *our* position spelling, and only for the positions the offensive scorer
      // can actually score. Kickers and defences get no curve of their own and are priced
      // off the pooled one — deliberately, because `scoreOffense` scores a kicking line as
      // zero, so any curve fitted from those rows would be fitted from false zeros.
      //
      // Excluding them is what this filter buys: previously the market's own spellings
      // (`PK`, `DEF`) meant no curve was ever found for them anyway, *and* their zeros were
      // dragging the pooled fit down for everybody else. Only the second half of that is
      // fixed here. They still resolve through `curves.pooled`, which is the honest
      // treatment for a position the model cannot value.
      const sampledPlayers = new Set<string>();
      const samples = candidateAdp.data
        .map((entry) => {
          const position = normalizeMarketPosition(entry.position);
          if (
            !MODELLED_POSITIONS.includes(
              position as (typeof MODELLED_POSITIONS)[number],
            )
          ) {
            return null;
          }
          // Deduplicated by the matched roster player, the rule the backtest already
          // applies. Two ADP rows — "A.J. Brown" and "AJ Brown" — can resolve to one
          // player, and counting him twice weights his (adp, points) pair twice in the
          // least-squares fit that prices everyone at that position.
          const matched = seasonPoints.find(entry.name, entry.position);
          if (matched === null || sampledPlayers.has(matched.name)) return null;
          sampledPlayers.add(matched.name);
          return {
            adp: entry.adp,
            actualSeasonPoints: matched.total,
            position,
          };
        })
        .filter(
          (s): s is { adp: number; actualSeasonPoints: number; position: string } =>
            s !== null,
        );

      const fitted = fitAdpCurves(samples, candidateSeason);
      if (fitted.pooled !== null) {
        curve = fitted;
        break;
      }
      curveAttempts.push(`${candidateSeason}: only ${samples.length} players matched`);
    }

    // Failing loudly rather than shipping a board that quietly is not the validated
    // product. Every published figure in docs/draft-validation.md describes the blend.
    if (curve === null) {
      throw new Error(
        `Could not fit a market curve for ${season}, so the board would carry no market ` +
          `component and would not be the blend the published figures describe. ` +
          `Tried — ${curveAttempts.join("; ")}.`,
      );
    }

    // Position-qualified, because a name-keyed `Map` silently hands one player another's
    // ADP, dispersion, and bye week when two names normalise the same way. See
    // `buildMarketIndex` — it refuses a collision it cannot separate rather than guessing.
    const marketIndex = buildMarketIndex(adpResult.data, normalizeMarketPosition);
    // Defences are not players and never appear on a roster file, so they are taken from
    // the market board directly. A league that starts one has to be able to draft one.
    const marketDefences = adpResult.data.filter(
      (entry) => normalizeMarketPosition(entry.position) === "DST",
    );

    const rows = [];
    let withMarketPrice = 0;
    for (const entry of rosterResult.data) {
      if (!DRAFTABLE_POSITIONS.includes(entry.position as (typeof DRAFTABLE_POSITIONS)[number])) {
        continue;
      }
      const history = perGame.get(entry.playerId) ?? [];
      const market = marketIndex.find(entry.name, entry.position);

      // Whether the model has an opinion is a question about the *position* first and the
      // row count second. Kickers have plenty of history rows, but `scoreOffense` scores a
      // kicking line as zero, so every veteran kicker produced a real zero — not a null —
      // and was blended down to 80% of his market price. That is the rookie markdown
      // reappearing for a different population, and it also split kickers in two: one with
      // no rows at all got the full market price and outranked an identically-priced
      // veteran.
      const modelled = MODELLED_POSITIONS.includes(
        entry.position as (typeof MODELLED_POSITIONS)[number],
      );

      // A player neither side can value cannot be valued by anything. Listing him at zero
      // would rank him below every kicker; omitting him is honest, and he can still be
      // drafted manually.
      //
      // Gated on `modelled`, not on the row count. Those agree for QB/RB/WR/TE, where no
      // prior games means no projection — but a kicker accumulates a history row per game
      // and every one of them scores zero, so `history.length` said the model had an
      // opinion when `modelled` was about to overrule it. A veteran kicker missing from
      // this season's ADP therefore passed the guard with no model value and no market
      // value, and `blendedSeasonValue(null, null)` wrote him to the board at exactly the
      // zero this line exists to keep off it.
      if ((!modelled || history.length === 0) && market === null) continue;
      const modelPoints =
        !modelled || history.length === 0
          ? null
          : seasonProjection({
              perGamePoints: history,
              priorSeasonGames: priorGames.get(entry.playerId) ?? 0,
            });
      const marketPoints =
        market === null ? null : adpImpliedPoints(market.adp, entry.position, curve);
      if (marketPoints !== null) withMarketPrice += 1;

      const band = OUTCOME_QUANTILES[entry.position as keyof typeof OUTCOME_QUANTILES];
      // Kickers have no model projection, so their weekly spread is the placeholder band
      // rather than a measured one. `config.ts` marks it as such.
      rows.push({
        playerId: entry.playerId,
        name: entry.name,
        position: entry.position,
        team: entry.team,
        modelPoints,
        marketPoints,
        blendedPoints: blendedSeasonValue(modelPoints, marketPoints),
        adp: market?.adp ?? null,
        adpStdev: market?.stdev ?? null,
        byeWeek: market?.bye ?? null,
        availability: shrunkAvailability(
          priorGames.get(entry.playerId) ?? 0,
          history.length > 0,
        ),
        // Measured where the weekly model has a band for the position, and an explicitly
        // unmeasured placeholder where it does not — declared in `config.ts` beside the
        // real ones rather than as two literals here, so the difference is visible at the
        // point somebody reads the measured bands.
        p10: band?.p10 ?? PLACEHOLDER_QUANTILES.p10,
        p90: band?.p90 ?? PLACEHOLDER_QUANTILES.p90,
        quantileProvenance: band?.provenance ?? PLACEHOLDER_QUANTILES.provenance,
      });
    }

    // Defences, synthesised from the market. They carry no model estimate at all, which
    // the blend already handles: where the model is silent the market's price stands.
    for (const entry of marketDefences) {
      const marketPoints = adpImpliedPoints(entry.adp, "DST", curve);
      if (marketPoints === null) continue;
      const band = OUTCOME_QUANTILES.DST;
      withMarketPrice += 1;
      rows.push({
        playerId: `dst-${normalizeName(entry.name)}`,
        name: entry.name,
        position: "DST",
        team: entry.team,
        modelPoints: null,
        marketPoints,
        blendedPoints: blendedSeasonValue(null, marketPoints),
        adp: entry.adp,
        adpStdev: entry.stdev,
        byeWeek: entry.bye,
        // No games-played history exists for a defence; a team plays every week it is not
        // on bye, so availability is the bye alone.
        availability: 1,
        p10: band.p10,
        p90: band.p90,
        // A defence's band is `placeholder` in `OUTCOME_QUANTILES`, and the stored row
        // says so rather than leaving the reader to know it.
        quantileProvenance: band.provenance,
      });
    }

    if (rows.length === 0) {
      // Thrown rather than returned. Returning normally after marking the job failed put
      // the two records in direct contradiction: `refreshDraftBoards` counts a normal
      // return as a rebuild, so the cron reported the shape rebuilt while its own job row
      // said it had failed and no board row existed. The existing catch below records the
      // failure, so this needs no bookkeeping of its own.
      throw new Error(
        `No draftable players resolved for ${season}. Nothing was written.`,
      );
    }

    const computedAt = Date.now();
    for (const batch of chunk(rows, WRITE_BATCH)) {
      await ctx.runMutation(internal.draft.upsertBoardBatch, {
        season,
        scoringId,
        teams,
        computedAt,
        rows: batch,
      });
    }
    // Publish, then prune — in that order, and both only after every batch has landed.
    //
    // Until `publishBoard` runs, readers are still being served the previous run's rows
    // and the half-written new ones are invisible, so a failure anywhere above leaves the
    // last good board whole rather than interleaving two of them. Pruning after publishing
    // means the rows being deleted are already the ones nobody is reading; pruning first
    // would delete the board that is still live.
    await ctx.runMutation(internal.draft.publishBoard, {
      season,
      scoringId,
      teams,
      computedAt,
    });
    // Drained rather than called once. `pruneBoard` deletes a bounded page and says
    // whether more remain, because the stale set includes every failed rebuild's rows and
    // is not bounded by one run's size.
    for (;;) {
      const pruned = await ctx.runMutation(internal.draft.pruneBoard, {
        season,
        scoringId,
        teams,
        computedBefore: computedAt,
      });
      if (!pruned.more) break;
    }

    await ctx.runMutation(internal.jobs.finish, { jobId, status: "succeeded", error: null });
    return {
      players: rows.length,
      withMarketPrice,
      unpriced: rows.length - withMarketPrice,
    };
  } catch (error) {
    await ctx.runMutation(internal.jobs.finish, {
      jobId,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Rebuilds the draft boards the interface offers.
 *
 * Separate from the weekly refresh because it tracks a different clock. A projection moves
 * when games are played; a draft board moves when the *market* does, which is continuous
 * through the preseason and then stops mattering entirely once drafts are over.
 *
 * Every league shape is rebuilt, because the board is keyed on scoring and league size —
 * ADP genuinely differs between them, and a shape that is never rebuilt would serve a
 * board that quietly ages out.
 */
export const refreshDraftBoards = internalAction({
  args: {},
  handler: async (ctx): Promise<{ rebuilt: number; failed: string[] }> => {
    const season = await ctx.runQuery(api.season.current, {});
    // Drafts happen for the season about to start. During the season the board is stale by
    // definition and nobody is drafting from it, so this becomes a no-op rather than an
    // expensive daily rebuild of something nobody reads.
    const target = season === null ? null : season.isComplete ? season.season + 1 : null;
    if (target === null) return { rebuilt: 0, failed: [] };

    // One provider for the whole run. `seasonRoster` and `playerWeeks` fetch and parse on
    // every call, so a fresh provider per shape re-downloaded three multi-megabyte CSVs
    // twelve times inside a single action.
    const provider = new NflverseProvider();
    const adpProvider = new AdpProvider();

    let rebuilt = 0;
    const failed: string[] = [];
    for (const scoringId of SCORING_PRESETS.map((preset) => preset.id)) {
      for (const teams of DRAFT_BOARD_LEAGUE_SIZES) {
        try {
          await runBuildDraftBoard(
            ctx,
            { season: target, scoringId, teams },
            provider,
            adpProvider,
          );
          rebuilt += 1;
        } catch (error) {
          // One shape failing must not stop the rest: a market board can be missing for an
          // unusual league size while the common ones are fine.
          failed.push(
            `${scoringId}/${teams}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    return { rebuilt, failed };
  },
});
