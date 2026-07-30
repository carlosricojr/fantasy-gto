import type { RosterSlot } from "@/lib/core/optimizer";

import type { Position } from "./scoring/types";

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

const SLOT_LABELS: Readonly<Record<string, string>> = {
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
    const count = counts[kind] ?? 0;
    for (let i = 1; i <= count; i += 1) {
      slots.push({
        id: count === 1 ? kind.toLowerCase() : `${kind.toLowerCase()}${i}`,
        label: SLOT_LABELS[kind] ?? kind,
        eligiblePositions: SLOT_ELIGIBILITY[kind],
      });
    }
  }
  return slots;
}

export interface RosterTemplate {
  id: string;
  label: string;
  description: string;
  counts: Readonly<Record<string, number>>;
}

/** The near-universal default: one quarterback, two backs, two receivers, tight end, flex. */
export const STANDARD_TEMPLATE: RosterTemplate = {
  id: "standard",
  label: "Standard",
  description: "QB, 2 RB, 2 WR, TE, FLEX, K, D/ST",
  counts: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
};

export const SUPERFLEX_TEMPLATE: RosterTemplate = {
  id: "superflex",
  label: "Superflex",
  description: "Standard plus a SUPERFLEX that accepts a second QB",
  counts: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPERFLEX: 1, K: 1, DST: 1 },
};

export const THREE_WR_TEMPLATE: RosterTemplate = {
  id: "three_wr",
  label: "3 WR",
  description: "QB, 2 RB, 3 WR, TE, FLEX, K, D/ST",
  counts: { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1, K: 1, DST: 1 },
};

export const ROSTER_TEMPLATES: readonly RosterTemplate[] = [
  STANDARD_TEMPLATE,
  THREE_WR_TEMPLATE,
  SUPERFLEX_TEMPLATE,
];

export const DEFAULT_TEMPLATE = STANDARD_TEMPLATE;

/** Looks up a template by id, falling back to the default rather than throwing. */
export function rosterTemplateById(id: string | null | undefined): RosterTemplate {
  return ROSTER_TEMPLATES.find((template) => template.id === id) ?? DEFAULT_TEMPLATE;
}

/** The slots for a template. */
export function slotsForTemplate(id: string | null | undefined): RosterSlot[] {
  return buildSlots(rosterTemplateById(id).counts);
}
