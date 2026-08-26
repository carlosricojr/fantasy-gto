/**
 * The player pool: what is in it, what order it is in, and what the roster still needs.
 *
 * The board this replaced had no pool at all. The only way to enter a pick was to type a
 * name into a search box that returned nothing under two characters and at most eight rows
 * after that, which meant three things a draft cannot do without were impossible: you
 * could not see who was left, you could not compare two players, and you could not record
 * a pick for somebody whose name you had misheard.
 *
 * Pure, and separated from the components, because these are the decisions a test can
 * hold: which rows are shown, in what order, and which starting slots are still empty.
 */

import { type LineupSolution, type RosterSlot, solveLineup } from "@/lib/core/optimizer";
import type { PlayerRisk } from "@/lib/core/roster-utility";
import { UNRANKED_ADP_PADDING } from "@/lib/core/draft";
import { matchName } from "@/lib/nfl/draft/match";
import type { ValueBasis } from "@/lib/nfl/draft/provenance";
import type { MarketValueBasis } from "@/lib/nfl/draft/value";

/** A player as the pool presents them, board facts and draft state together. */
export interface PoolPlayer {
  id: string;
  name: string;
  position: string;
  team: string | null;
  byeWeek: number | null;
  /** Projected season total under the league's scoring — the board's blended value. */
  seasonPoints: number;
  /** Our own season projection, absent for kickers and defences. */
  modelPoints: number | null;
  /** What the market's price implies, absent when the market has no opinion. */
  marketPoints: number | null;
  /** Whether that price preserves ADP ordering or is a fitted curve's mean. */
  marketValueBasis: MarketValueBasis | null;
  adp: number | null;
  adpStdev: number | null;
  /** Modelled share of weeks fit, shrunk toward the league rate. */
  availability: number;
  /**
   * Where this row's number came from — a blend, or one side of it alone.
   *
   * Carried per row rather than derived from the position, because the two reasons a row
   * can be market-only are different things to tell a manager: the model does not cover
   * kickers at all, and it has no opinion yet about a rookie who has never played.
   */
  basis: ValueBasis;
  /** 1-based position on the board, by blended value. Stable while the draft runs. */
  overallRank: number;
  /** Overall pick number they went at, or `null` if still available. */
  draftedAt: number | null;
  /** Who took them — "You" or a seat — or `null` if still available. */
  draftedBy: string | null;
}

export type PoolFilter = "available" | "drafted";

/** Sort keys the pool header offers. */
export type PoolSort = "value" | "adp" | "bye" | "name";

export const POOL_SORTS: readonly { id: PoolSort; label: string }[] = [
  { id: "value", label: "Projected" },
  { id: "adp", label: "ADP" },
  { id: "bye", label: "Bye" },
  { id: "name", label: "Name" },
];

/**
 * Where a player the market has not priced is assumed to go.
 *
 * Behind everyone it has priced, which is what `UNRANKED_ADP_PADDING` is for. Computed in
 * one place because two callers — the survival figure on a row and the one in the
 * recommendation panel — must not answer the same question differently.
 */
export function unrankedAdpFor(totalPicks: number): number {
  return totalPicks + UNRANKED_ADP_PADDING;
}

/**
 * Rows matching the current filter, search and position tab.
 *
 * The search is substring-first and fuzzy-second: a manager typing "jeff" wants every
 * Jefferson, and a manager who has misheard a name over a noisy draft room wants the
 * nearest one. `matchName` alone returns a single best match, which is the right answer
 * for reconciling an imported roster and the wrong one for a person browsing.
 */
export function filterPool(
  players: readonly PoolPlayer[],
  input: { filter: PoolFilter; position: string | null; query: string },
): PoolPlayer[] {
  const query = input.query.trim().toLowerCase();
  const rows = players.filter((player) => {
    if (input.filter === "available" && player.draftedAt !== null) return false;
    if (input.filter === "drafted" && player.draftedAt === null) return false;
    if (input.position !== null && player.position.toUpperCase() !== input.position) {
      return false;
    }
    return true;
  });
  if (query === "") return rows;

  const substring = rows.filter((player) => player.name.toLowerCase().includes(query));
  if (substring.length > 0) return substring;

  // Nothing contained what was typed. One fuzzy match is better than an empty list, and
  // an empty list is what sent a tester looking for a bug: the pool went blank for a
  // misspelling and read as "this player is not in this draft".
  const fuzzy = matchName(input.query, rows, 0.55);
  return fuzzy === null ? [] : [fuzzy.candidate];
}

/**
 * Sorted rows.
 *
 * Every comparator falls back to overall rank so the order is total: two players with the
 * same bye week, or no ADP at all, must not swap places between renders. A pool that
 * reshuffles under a moving finger costs a pick.
 */
export function sortPool(players: readonly PoolPlayer[], sort: PoolSort): PoolPlayer[] {
  const rows = [...players];
  switch (sort) {
    case "adp":
      // Unranked players last rather than first. A missing ADP sorted as zero would put
      // every player the market has never heard of at the top of the board, which is the
      // exact inversion `UNRANKED_ADP_PADDING` exists to prevent elsewhere.
      return rows.sort(
        (a, b) =>
          (a.adp ?? Number.POSITIVE_INFINITY) - (b.adp ?? Number.POSITIVE_INFINITY) ||
          a.overallRank - b.overallRank,
      );
    case "bye":
      return rows.sort(
        (a, b) =>
          (a.byeWeek ?? Number.POSITIVE_INFINITY) - (b.byeWeek ?? Number.POSITIVE_INFINITY) ||
          a.overallRank - b.overallRank,
      );
    case "name":
      return rows.sort((a, b) => a.name.localeCompare(b.name) || a.overallRank - b.overallRank);
    case "value":
    default:
      return rows.sort((a, b) => a.overallRank - b.overallRank);
  }
}

/**
 * How many of each position are in the rows given, for the filter tabs.
 *
 * Counts what it is handed rather than filtering to available itself. The caller already
 * knows which set the tabs are describing, and hard-coding availability here made the tabs
 * describe a different list than the one underneath them the moment the "Drafted" filter
 * was on.
 */
export function positionCounts(players: readonly PoolPlayer[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const player of players) {
    const key = player.position.toUpperCase();
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * The best legal lineup a draft roster can field.
 *
 * One definition of how a `PlayerRisk` becomes something the solver accepts, exported so
 * the roster panel uses it too. Three call sites had their own copy of this mapping —
 * which slots are empty, which positions fill a need, and what the panel displays — and
 * they were free to drift: one crediting a player at a different value than another would
 * make the "fills a starting slot" marker disagree with the list of empty slots printed
 * beside it. The repeated *solve* is deliberate and cheap; a roster is a few dozen players
 * against ten slots.
 */
export function solveRoster(
  slots: readonly RosterSlot[],
  roster: readonly PlayerRisk[],
): LineupSolution {
  return solveLineup(
    slots,
    roster.map((player) => ({
      id: player.id,
      name: player.name,
      position: player.position,
      // Season value per game, which is the quantity the roster carries. The absolute
      // scale is irrelevant here — only which slots end up occupied.
      projectedPoints: player.weeklyMean,
      availability: "active" as const,
    })),
  );
}

function assignRoster(slots: readonly RosterSlot[], roster: readonly PlayerRisk[]) {
  return solveRoster(slots, roster).assignments;
}

/**
 * The starting slots this roster cannot fill, by label.
 *
 * Solved rather than counted. Counting positions against slot names gets flex wrong in
 * both directions — three backs and one receiver fills RB, RB and FLEX and leaves WR2
 * empty, which no per-position tally reports — and this product already owns an exact
 * answer to that question. The same matching that decides a weekly lineup decides what a
 * draft still needs.
 */
export function unfilledSlots(
  slots: readonly RosterSlot[],
  roster: readonly PlayerRisk[],
): string[] {
  return assignRoster(slots, roster)
    .filter((assignment) => assignment.competitorId === null)
    .map((assignment) => assignment.slotLabel);
}

/**
 * Positions that would fill a slot the roster still has empty.
 *
 * Drives the "fills a need" marker in the pool. Derived from the unfilled slots rather
 * than from a wishlist, so a league with two flexes and a superflex gets the right answer
 * without anything here knowing those formats exist.
 */
export function neededPositions(
  slots: readonly RosterSlot[],
  roster: readonly PlayerRisk[],
): Set<string> {
  const empty = new Set(
    assignRoster(slots, roster)
      .filter((assignment) => assignment.competitorId === null)
      .map((assignment) => assignment.slotId),
  );

  const positions = new Set<string>();
  for (const slot of slots) {
    if (!empty.has(slot.id)) continue;
    for (const position of slot.eligiblePositions) positions.add(position);
  }
  return positions;
}

/** A bye week that leaves a starting slot unfillable, and which slots those are. */
export interface ByeGap {
  week: number;
  /** Slot labels that go empty that week, one entry per empty slot. */
  slots: string[];
  /**
   * Whether the week is one of the league's playoff rounds.
   *
   * A hole in a regular-season week costs part of one matchup out of a dozen. The same
   * hole in a playoff round is a title lost, and the difference is entirely a fact about
   * the league's calendar — a bye in week 14 is ordinary for a league whose final is in
   * week 17 and is the semi-final for a league whose final is in week 15. The simulation
   * already prices this correctly, because it plays the weeks out; this exists so the
   * screen can say which of the two a listed gap is instead of leaving the reader to
   * remember their own settings.
   */
  inPlayoffs: boolean;
}

/**
 * Bye weeks that actually cost a starting slot.
 *
 * The panel this replaces listed every week where two players on the roster shared a bye.
 * That over-reports in one direction and under-reports in the other, and by the end of a
 * fifteen-round draft it fires on nearly every week and stops discriminating.
 *
 * Over-reports, because two backs sharing a bye costs nothing if a third can start in
 * their place — depth is exactly what a bench is for. Under-reports, because restricting
 * it to starters instead, which is the obvious correction, misses the case that matters
 * most: a starter and the only player who could cover them sharing a week. The roster is
 * then one player short at that slot and no tally of starters can see it.
 *
 * Both readings are guesses at a question the product can answer exactly. Take the week's
 * players away and solve the lineup again; whatever slot the matching can no longer fill
 * is the cost, in the same units the rest of this screen uses. The baseline is subtracted
 * so a slot nobody has drafted for yet — no tight end in round three — is not reported as
 * a bye problem in all fourteen weeks at once.
 */
export function byeGaps(
  slots: readonly RosterSlot[],
  roster: readonly PlayerRisk[],
  /**
   * The league's playoff rounds, so a gap can say which half of the season it falls in.
   *
   * Defaulted to none rather than to a literal bracket. A caller that does not know the
   * league's calendar must not have one invented for it — the wrong three weeks would
   * label a regular-season bye as a lost semi-final, which is worse than saying nothing.
   */
  playoffWeeks: readonly number[] = [],
): ByeGap[] {
  const inPlayoffs = new Set(playoffWeeks);
  const weeks = [
    ...new Set(
      roster
        .map((player) => player.byeWeek)
        .filter((week): week is number => week !== null),
    ),
  ].sort((a, b) => a - b);
  if (weeks.length === 0) return [];

  const baseline = countLabels(unfilledSlots(slots, roster));

  const gaps: ByeGap[] = [];
  for (const week of weeks) {
    const available = roster.filter((player) => player.byeWeek !== week);
    const missing = countLabels(unfilledSlots(slots, available));

    // How many slots the week actually costs. Counted as a total first, because the
    // per-label difference below can name a *different* slot than the one that emptied when
    // two are interchangeable — a back moving from RB to FLEX is not a new gap. The names
    // are then capped at that total, so the list can never claim more empty slots than the
    // solve lost. The count is exact; each label is a reasonable name for one of them.
    const lost = total(missing) - total(baseline);
    if (lost <= 0) continue;

    const worse: string[] = [];
    for (const [label, count] of missing) {
      const extra = count - (baseline.get(label) ?? 0);
      for (let i = 0; i < extra && worse.length < lost; i += 1) worse.push(label);
    }
    if (worse.length > 0) {
      gaps.push({ week, slots: worse, inPlayoffs: inPlayoffs.has(week) });
    }
  }
  return gaps;
}

function total(counts: ReadonlyMap<string, number>): number {
  let sum = 0;
  for (const count of counts.values()) sum += count;
  return sum;
}

function countLabels(labels: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return counts;
}
