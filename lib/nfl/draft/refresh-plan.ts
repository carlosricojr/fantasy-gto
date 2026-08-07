import type { SeasonState } from "../season";
import { draftSeasonFor } from "../season";
import { SCORING_PRESETS } from "../scoring/presets";
import { SUPPORTED_LEAGUE_SIZES } from "./league-size";

/**
 * Whether to rebuild the draft boards, and which ones.
 *
 * The decision was three lines inside a Convex action, which is where it could not be
 * tested. That mattered more than it sounds: the two clauses had already disagreed once, and
 * the symptom was the worst kind. `refreshDraftBoards` built only when the *displayed* season
 * was complete, so through the whole preseason — the one window in which anybody drafts — it
 * rebuilt nothing at all, silently, twice a day.
 *
 * A refusal is a *reason*, not a false. An action that returns `{rebuilt: 0}` for "the season
 * is under way" and for "the schedule has not been ingested" is an action whose logs cannot
 * distinguish working correctly from not working.
 */

export interface RefreshShape {
  scoringId: string;
  teams: number;
}

export type RefreshPlan =
  | {
      kind: "skip";
      /** Why nothing is being built, in a sentence a log reader can act on. */
      reason: string;
    }
  | {
      kind: "rebuild";
      season: number;
      shapes: readonly RefreshShape[];
    };

/**
 * The full matrix: every scoring format across every league size the product offers.
 *
 * Built from the two lists rather than restated, so a preset or a size added anywhere
 * automatically gets a board. The alternative — a third literal — is how the page came to
 * offer sizes the cron did not build.
 */
export function draftBoardMatrix(): RefreshShape[] {
  const shapes: RefreshShape[] = [];
  for (const preset of SCORING_PRESETS) {
    for (const teams of SUPPORTED_LEAGUE_SIZES) {
      shapes.push({ scoringId: preset.id, teams });
    }
  }
  return shapes;
}

/**
 * What a scheduled refresh should do, given where the league is in its calendar.
 *
 * Boards are built in the **offseason and preseason** and not during the regular season.
 * That is not a cost decision dressed as a rule: once the season is under way the season's
 * draft has happened, the board describes a market that no longer exists, and nobody is
 * reading it. Building it anyway would be twice-daily work for nobody.
 *
 * `draftSeasonFor` decides *which* season, and it is the same function the draft page reads,
 * deliberately — these two disagreed once and the page spent a preseason serving a board the
 * cron was not building.
 */
export function planDraftRefresh(state: SeasonState | null): RefreshPlan {
  if (state === null) {
    return {
      kind: "skip",
      reason:
        "No season state: the schedule has not been ingested, so there is no season to " +
        "build a board for. Run the schedule sync first.",
    };
  }
  if (state.phase === "regular") {
    return {
      kind: "skip",
      reason:
        `The ${state.season} season is under way, so its draft has already happened and ` +
        `the board describes a market that no longer exists.`,
    };
  }
  const season = draftSeasonFor(state);
  if (season === null) {
    return {
      kind: "skip",
      reason: "No draftable season could be resolved from the schedule.",
    };
  }
  return { kind: "rebuild", season, shapes: draftBoardMatrix() };
}

/**
 * How old a board may be before the interface says so.
 *
 * **Justified against the cron cadence rather than chosen.** The rebuild runs at 11:00 and
 * 23:00 UTC, so a healthy board is at most twelve hours old and a board older than that has
 * missed at least one scheduled run. Twenty-six hours is two full cycles plus two hours of
 * slack, which is the smallest threshold that does not fire on a single late or slow run —
 * and firing on a single late run would be worse than not firing at all, because a warning
 * that appears routinely is a warning nobody reads.
 *
 * The two numbers are coupled: change the cron and this has to change with it, which is why
 * the cadence is written down here beside it rather than only in `convex/crons.ts`.
 */
export const BOARD_REFRESH_INTERVAL_HOURS = 12;
export const BOARD_STALE_AFTER_MS = (2 * BOARD_REFRESH_INTERVAL_HOURS + 2) * 60 * 60 * 1000;

export type BoardHealth =
  /** Rebuilt within the expected window. */
  | "fresh"
  /** Older than two scheduled runs, so at least one refresh did not land. */
  | "stale"
  /** A board exists and the last refresh attempt for it failed. */
  | "last-refresh-failed"
  /** A refresh is running now. */
  | "refreshing"
  /** No board has ever been published for this shape. */
  | "never-built";

export interface BoardHealthInput {
  now: number;
  /** When the published board was computed, or `null` if none has been. */
  publishedAt: number | null;
  /** When a refresh for this shape last started, or `null` if never. */
  lastAttemptAt: number | null;
  /** Whether the most recent completed attempt failed. */
  lastAttemptFailed: boolean;
  /** Whether an attempt is currently in flight. */
  refreshing: boolean;
}

/**
 * What the interface should say about a board.
 *
 * The order matters and is the whole design. "Refreshing" outranks everything, because a
 * warning about a board that is already being replaced sends somebody to fix what is fixing
 * itself. A *failed* attempt outranks a fresh timestamp, because that is the exact state this
 * issue exists for: a board that is only hours old, looks entirely healthy, and is not the
 * board the last run was trying to produce.
 *
 * `never-built` is separate from `stale` on purpose. They lead to different actions — one is
 * "wait or run the refresh", the other is "this league shape has never worked".
 */
export function boardHealth(input: BoardHealthInput): BoardHealth {
  if (input.refreshing) return "refreshing";
  if (input.publishedAt === null) return "never-built";
  if (input.lastAttemptFailed) return "last-refresh-failed";
  return input.now - input.publishedAt > BOARD_STALE_AFTER_MS ? "stale" : "fresh";
}

/** What a reader is told, and what they can do about it. */
export function describeBoardHealth(
  health: BoardHealth,
  input: Pick<BoardHealthInput, "now" | "publishedAt">,
): string {
  const hours =
    input.publishedAt === null
      ? null
      : Math.floor((input.now - input.publishedAt) / (60 * 60 * 1000));
  switch (health) {
    case "fresh":
      return `Board rebuilt ${hours} hour(s) ago.`;
    case "stale":
      return (
        `Board is ${hours} hour(s) old and has missed at least one scheduled rebuild ` +
        `(every ${BOARD_REFRESH_INTERVAL_HOURS} hours). Prices may not reflect the last ` +
        `two days of camp news.`
      );
    case "last-refresh-failed":
      return (
        `The last rebuild failed, so this board is ${hours} hour(s) old and is not the one ` +
        `the last run was trying to produce. See the operator runbook in ` +
        `docs/data-sources.md.`
      );
    case "refreshing":
      return "A rebuild is running now.";
    case "never-built":
      return "No board has ever been built for this league shape.";
  }
}
