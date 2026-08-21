import type { RosterSlot } from "../core/optimizer";

import type { Position } from "./scoring/types";
import { CURRENT_TEAMS } from "./teams";

/**
 * Roster shapes.
 *
 * Slot templates are data rather than code so a league can define its own without a
 * release. The eligibility sets follow the standard fantasy taxonomy: FLEX excludes
 * quarterbacks, SUPERFLEX includes them, and the two must not be conflated — a
 * SUPERFLEX league is a fundamentally different game.
 */

/** Slot kinds and the positions each accepts. */
export const SLOT_ELIGIBILITY: Readonly<Record<string, readonly Position[]>> = {
  QB: ["QB"],
  RB: ["RB"],
  WR: ["WR"],
  TE: ["TE"],
  FLEX: ["RB", "WR", "TE"],
  WR_TE: ["WR", "TE"],
  RB_WR: ["RB", "WR"],
  SUPERFLEX: ["QB", "RB", "WR", "TE"],
  K: ["K"],
  DST: ["DST"],
};

export type SlotKind = keyof typeof SLOT_ELIGIBILITY;

export const SLOT_LABELS: Readonly<Record<string, string>> = {
  QB: "QB",
  RB: "RB",
  WR: "WR",
  TE: "TE",
  FLEX: "FLEX",
  WR_TE: "WR/TE",
  RB_WR: "RB/WR",
  SUPERFLEX: "SUPERFLEX",
  K: "K",
  DST: "D/ST",
};

/**
 * Expands counts per slot kind into concrete, uniquely identified slots.
 *
 * Ids are stable and deterministic (`rb1`, `rb2`, …) so a stored lineup keeps referring to
 * the same slot across sessions.
 */
export function buildSlots(counts: Readonly<Record<string, number>>): RosterSlot[] {
  const slots: RosterSlot[] = [];
  for (const kind of Object.keys(SLOT_ELIGIBILITY)) {
    // `??` and `||` agree: the only falsy number a count can be is zero, which is the
    // fallback anyway.
    const count = counts[kind] ?? 0;
    for (let i = 1; i <= count; i += 1) {
      slots.push({
        id: count === 1 ? kind.toLowerCase() : `${kind.toLowerCase()}${i}`,
        // `??` and `||` agree here too, for a weaker reason: no label is the empty string.
        // Kept as `??` so it stays correct if one ever is.
        label: SLOT_LABELS[kind] ?? kind,
        eligiblePositions: SLOT_ELIGIBILITY[kind],
      });
    }
  }
  return slots;
}

/**
 * A league's roster: which slots start, and how many players fill it.
 *
 * The two belong together because a user picks them together — "standard, fifteen rounds" is
 * one decision about one league — and because everything downstream needs both. The
 * simulation fields the slots; the draft is `rounds` picks long; the difference between them
 * is the bench, and the bench is what the depth model prices.
 */
export interface RosterTemplate {
  /**
   * The serialized id. Stored in `sessionStorage` and validated on restore, so it is part of
   * the persistence contract: renaming one orphans every saved draft that used it.
   */
  id: string;
  label: string;
  description: string;
  counts: Readonly<Record<string, number>>;
  /**
   * Total roster size — starters plus bench — and therefore the number of rounds.
   *
   * A default rather than a constraint: the setup screen applies it when the shape is chosen
   * and leaves the user free to change it afterwards. It is on the template because the two
   * are not independent — a SUPERFLEX league starts ten and a no-kicker league starts seven,
   * and carrying fifteen rounds into both gives one a five-man bench and the other an
   * eight-man one without saying so.
   */
  rounds: number;
}

/** The near-universal default: one quarterback, two backs, two receivers, tight end, flex. */
export const STANDARD_TEMPLATE: RosterTemplate = {
  id: "standard",
  label: "Standard",
  description: "QB, 2 RB, 2 WR, TE, FLEX, K, D/ST",
  counts: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
  rounds: 15,
};

/**
 * Standard with a second flex — the shape of the league this was tested against.
 *
 * Not a variant of anything: two flexible slots change what the league drafts, because the
 * flex demand is solved against the board rather than divided among eligible positions. See
 * `lib/core/draft-replacement.ts`, and `roster.test.ts` for the measured difference.
 */
export const TWO_FLEX_TEMPLATE: RosterTemplate = {
  id: "two_flex",
  label: "2 FLEX",
  description: "QB, 2 RB, 2 WR, TE, 2 FLEX, K, D/ST",
  counts: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, K: 1, DST: 1 },
  rounds: 15,
};

export const SUPERFLEX_TEMPLATE: RosterTemplate = {
  id: "superflex",
  label: "Superflex",
  description: "Standard plus a SUPERFLEX that accepts a second QB",
  counts: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPERFLEX: 1, K: 1, DST: 1 },
  rounds: 16,
};

/**
 * Two quarterbacks that *must* both be quarterbacks.
 *
 * Distinct from SUPERFLEX and not interchangeable with it, which is the same distinction
 * `SLOT_ELIGIBILITY` draws between FLEX and SUPERFLEX. A superflex league may start a second
 * quarterback; a 2QB league has to, and cannot put a back in that slot when its second
 * quarterback is on bye.
 */
export const TWO_QB_TEMPLATE: RosterTemplate = {
  id: "two_qb",
  label: "2 QB",
  description: "2 QB, 2 RB, 2 WR, TE, FLEX, K, D/ST",
  counts: { QB: 2, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
  rounds: 16,
};

export const THREE_WR_TEMPLATE: RosterTemplate = {
  id: "three_wr",
  label: "3 WR",
  description: "QB, 2 RB, 3 WR, TE, FLEX, K, D/ST",
  counts: { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1, K: 1, DST: 1 },
  rounds: 15,
};

/**
 * Leagues that start no kicker, no defense, or neither.
 *
 * Worth shipping as presets rather than leaving to a custom builder, because getting them
 * *wrong* is silent: a league that starts no kicker, drafted against the standard template,
 * spends a pick on one and fields a lineup one slot short of the one it is scored on. A
 * position with no slot has no starting demand at all, and the value model already says a
 * player at it is worth nothing over the one freely available — asserted in `roster.test.ts`
 * rather than assumed.
 */
export const NO_K_TEMPLATE: RosterTemplate = {
  id: "no_k",
  label: "No K",
  description: "QB, 2 RB, 2 WR, TE, FLEX, D/ST",
  counts: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, DST: 1 },
  rounds: 15,
};

export const NO_DST_TEMPLATE: RosterTemplate = {
  id: "no_dst",
  label: "No D/ST",
  description: "QB, 2 RB, 2 WR, TE, FLEX, K",
  counts: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1 },
  rounds: 15,
};

export const NO_K_DST_TEMPLATE: RosterTemplate = {
  id: "no_k_dst",
  label: "No K or D/ST",
  description: "QB, 2 RB, 2 WR, TE, FLEX",
  counts: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1 },
  rounds: 14,
};

/**
 * The standard shape over a shorter draft.
 *
 * The same slots as `STANDARD_TEMPLATE` and a different league, which is the reason `rounds`
 * belongs on the template at all: thirteen rounds behind nine starters is a four-man bench
 * where fifteen is a six-man one, and the depth model prices those differently.
 */
export const SHALLOW_BENCH_TEMPLATE: RosterTemplate = {
  id: "shallow_bench",
  label: "Shallow bench",
  description: "Standard starters, 13 rounds",
  counts: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
  rounds: 13,
};

/**
 * How much of an absence the waiver wire covers for free, by position.
 *
 * The number `lib/core/draft-bench.ts` calls `wireCover`, and it lives here because the
 * argument for it can only be made by naming positions, which `lib/core` may not do. One
 * means the wire supplies the position entirely — a drafted reserve there sells you
 * nothing you could not have signed on the day you needed him. Zero means the wire
 * supplies nothing and depth has to be drafted.
 *
 * **Judgement, not measurement, and marked as such** — the same status
 * `UtilityConfig.meanAbsenceWeeks` carries, and for the same reason: what would settle it
 * is the weekly value of the best free agent at each position, which nothing in this repo
 * measures. `docs/draft-validation.md` records what the absence of that term cost (#88's
 * two kickers, two defences, five tight ends and two wide receivers) and what this
 * replaces it with. The entries, and the argument for each:
 *
 *  - **K and D/ST — 1.** Both are already special in this codebase for a reason that
 *    settles this: *the model does not project either*, and will not pretend to. Their
 *    entire price is the market's, and their weekly spread is the `placeholder` band
 *    rather than a measured one (#90.4). So there is no model claim that a particular
 *    kicker's absence costs more than a freely available kicker's presence, and drafting
 *    a second one buys a claim nothing in the system is making. Thirty-two NFL teams
 *    supply a starting kicker and a starting defence; a ten-team league rosters ten.
 *  - **TE — 0.75.** One tight-end slot, and the wire holds a starting NFL tight end in
 *    every week of the season, so most of a reserve's cover is free. Not all of it: the
 *    top of the position is separated from the wire by far more than the top kicker is,
 *    which is why this diminishes cover rather than deleting it. This is the "TE cover
 *    diminishing far faster" of #88's finding 3.
 *  - **RB and WR — 0.** The best undrafted back is nowhere near the best drafted one: a
 *    ten-team league with two flexible slots rosters most of the startable supply at both.
 *  - **QB — 0 only as the fail-closed base.** A one-quarterback league streams the
 *    position while SUPERFLEX/2QB does not. Every product producer calls
 *    `waiverWireCover`, below, which replaces this zero with a league-aware measurement
 *    from demand versus the 32 current NFL starters. Keeping the base at zero means a new
 *    caller that forgets the derivation cannot silently claim free QB coverage.
 */
export const WAIVER_WIRE_COVER: ReadonlyMap<Position, number> = new Map([
  ["QB", 0],
  ["RB", 0],
  ["WR", 0],
  ["TE", 0.75],
  ["K", 1],
  ["DST", 1],
]);

/** Positions whose draft rows are priced entirely by the market, not by the weekly model. */
export const UNPROJECTED_POSITIONS: ReadonlySet<Position> = new Set(["K", "DST"]);

/**
 * Derives QB waiver coverage from league demand against current startable supply.
 *
 * Coverage is free startable quarterbacks per demanded starter, capped to a share. A
 * ten-team 1-QB league derives `(32 - 10) / 10`, capped to 1; SUPERFLEX/2QB derives
 * `(32 - 20) / 20 = 0.6`. Both inputs are measured data already owned here — current NFL
 * teams and slot eligibility — rather than a second QB constant chosen to fit one mock.
 */
export function waiverWireCover(
  fantasyTeams: number,
  slots: readonly RosterSlot[],
): ReadonlyMap<Position, number> {
  const cover = new Map(WAIVER_WIRE_COVER);
  const teams = Number.isInteger(fantasyTeams) && fantasyTeams > 0 ? fantasyTeams : 0;
  const qbSlots = slots.filter((slot) => slot.eligiblePositions.includes("QB")).length;
  const demand = teams * qbSlots;
  const freeStartable = Math.max(CURRENT_TEAMS.length - demand, 0);
  cover.set("QB", demand > 0 ? Math.min(freeStartable / demand, 1) : 0);
  return cover;
}

export const ROSTER_TEMPLATES: readonly RosterTemplate[] = [
  STANDARD_TEMPLATE,
  TWO_FLEX_TEMPLATE,
  THREE_WR_TEMPLATE,
  SUPERFLEX_TEMPLATE,
  TWO_QB_TEMPLATE,
  NO_K_TEMPLATE,
  NO_DST_TEMPLATE,
  NO_K_DST_TEMPLATE,
  SHALLOW_BENCH_TEMPLATE,
];

export const DEFAULT_TEMPLATE = STANDARD_TEMPLATE;

/** Looks up a template by id, falling back to the default rather than throwing. */
export function rosterTemplateById(id: string | null | undefined): RosterTemplate {
  // `find` returns a template or `undefined`, and a template is always truthy, so `??` and
  // `||` cannot differ. Searching a list rather than indexing an object is deliberate: `id`
  // arrives from `sessionStorage`, and a property lookup would resolve `constructor` to
  // something truthy and hand it back as a roster shape.
  return ROSTER_TEMPLATES.find((template) => template.id === id) ?? DEFAULT_TEMPLATE;
}

/** The slots for a template. */
export function slotsForTemplate(id: string | null | undefined): RosterSlot[] {
  return buildSlots(rosterTemplateById(id).counts);
}

/**
 * The slot counts as a user reads them: `QB 1 · RB 2 · WR 2 · TE 1 · FLEX 1 · K 1 · D/ST 1`.
 *
 * Derived from `counts` rather than from `description`, so a shape and the words next to it
 * cannot drift apart. The description says what the league *is*; this says what the app will
 * actually field, and a setup screen that shows only the first has no way to be caught
 * showing the wrong one.
 */
export function slotSummary(id: string | null | undefined): string {
  const counts = rosterTemplateById(id).counts;
  return Object.keys(SLOT_ELIGIBILITY)
    .filter((kind) => (counts[kind] ?? 0) > 0)
    .map((kind) => `${SLOT_LABELS[kind] ?? kind} ${counts[kind]}`)
    .join(" · ");
}

/**
 * The shipped template with exactly these slot counts and this roster size, or `null`.
 *
 * For importing a league from a provider. **Exact match only, and deliberately**: a league
 * whose shape this does not carry is an unsupported shape, not the nearest preset. Silently
 * rounding a 3-WR-2-FLEX league to the standard template would draft against a lineup the
 * user never fields and never say so — and the caller that has to decide what to do about
 * that (#44 for the import, #56 for arbitrary shapes) can only decide it if this reports the
 * miss rather than absorbing it.
 *
 * `rounds` is required rather than optional because two shipped templates share a slot shape
 * — `standard` and `shallow_bench` differ only in how many rounds they draft — so counts
 * alone do not identify one. Every provider that reports a lineup also reports a roster size,
 * so nothing real is being asked for that a caller does not have.
 *
 * Zero and absent are the same slot count, so `{ QB: 1, K: 0 }` matches a template with no
 * kicker rather than failing on a key the other side omits.
 */
export function templateForRoster(
  counts: Readonly<Record<string, number>>,
  rounds: number,
): RosterTemplate | null {
  const kinds = Object.keys(SLOT_ELIGIBILITY);
  // A slot kind this build has no eligibility for cannot be matched by any template, and
  // treating it as absent would match a league with an extra slot to one without it.
  for (const [kind, count] of Object.entries(counts)) {
    if ((count ?? 0) > 0 && !kinds.includes(kind)) return null;
  }
  return (
    ROSTER_TEMPLATES.find(
      (template) =>
        template.rounds === rounds &&
        kinds.every((kind) => (template.counts[kind] ?? 0) === (counts[kind] ?? 0)),
    ) ?? null
  );
}
