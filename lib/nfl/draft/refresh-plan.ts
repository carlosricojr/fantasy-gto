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
 * **Derived from the cron cadence rather than chosen, and derived from the schedule itself
 * rather than from a copy of it.** `convex/crons.ts` imports `BOARD_REFRESH_CRON` from here,
 * so there is one schedule and the interval below is read off it. A board older than two full
 * cycles plus two hours has missed at least one run; the slack is what stops a single late or
 * slow run from firing a warning, because a warning that appears routinely is a warning
 * nobody reads.
 */
export const BOARD_REFRESH_CRON = "0 11,23 * * *";

/**
 * The longest gap between two scheduled rebuilds, derived from the schedule itself.
 *
 * This was the literal `12` sitting beside a cron expression in another file, with nothing
 * connecting them. Change the cron to `0 * /6 * * *` and the threshold below silently becomes
 * four times too loose: the interface would go on calling a twenty-six-hour-old board fresh
 * when it had missed four runs. Two constants that must agree and cannot check each other are
 * the same defect as the league-size list the page and the cron each kept their own copy of.
 *
 * Only the hour field is read, because that is the only field this schedule uses and a parser
 * that pretended to handle the rest would be claiming more than it does. A schedule this
 * cannot read throws rather than guessing — a wrong interval here produces a plausible
 * threshold, which is the failure this exists to prevent.
 */
export function cronIntervalHours(expression: string): number {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Not a five-field cron expression: "${expression}".`);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (dayOfMonth !== "*" || month !== "*" || dayOfWeek !== "*") {
    throw new Error(
      `Only a daily schedule can be reduced to one interval; "${expression}" is not one.`,
    );
  }
  if (!/^\d+$/.test(minute)) {
    throw new Error(`Only a fixed minute is supported, got "${minute}".`);
  }
  const hours = hour.split(",").map((part) => {
    if (!/^\d+$/.test(part)) {
      throw new Error(`Only explicit hours are supported, got "${hour}".`);
    }
    return Number(part);
  });
  if (hours.length === 0) throw new Error(`No hours in "${expression}".`);
  const sorted = [...hours].sort((a, b) => a - b);
  // Including the wrap past midnight, which is the gap a naive `max(diff)` misses — and
  // misses in the unsafe direction, reporting a schedule as tighter than it is.
  let longest = 24 - sorted[sorted.length - 1] + sorted[0];
  for (let i = 1; i < sorted.length; i += 1) {
    longest = Math.max(longest, sorted[i] - sorted[i - 1]);
  }
  return longest;
}

export const BOARD_REFRESH_INTERVAL_HOURS = cronIntervalHours(BOARD_REFRESH_CRON);
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
