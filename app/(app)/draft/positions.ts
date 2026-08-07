/**
 * Position colour, defined once.
 *
 * A draft board is scanned, not read. Position is the one attribute a manager filters on
 * at a glance — "how many backs have gone", "is that a receiver in my flex" — and the only
 * way to answer that from a grid of two hundred cells is by hue. Everything else on this
 * screen stays neutral so that this can mean something.
 *
 * Written as whole class strings rather than composed at runtime because Tailwind scans
 * source text: `bg-${hue}-500/12` produces no CSS at all, and the failure is a board of
 * colourless chips that looks like a design choice.
 *
 * The hues are low-chroma tints with a matching ring, so a chip reads as a chip in both
 * themes without any of them competing with the brand green, which carries "this is the
 * recommendation" and must stay the loudest thing on the page.
 */

/** Order positions are presented in, which is the order a roster is usually read in. */
export const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"] as const;

export type Position = (typeof POSITIONS)[number];

const CHIPS: Readonly<Record<string, string>> = {
  QB: "bg-violet-500/12 text-violet-700 ring-violet-500/25 dark:text-violet-300",
  RB: "bg-sky-500/12 text-sky-700 ring-sky-500/25 dark:text-sky-300",
  WR: "bg-amber-500/14 text-amber-700 ring-amber-500/25 dark:text-amber-300",
  TE: "bg-rose-500/12 text-rose-700 ring-rose-500/25 dark:text-rose-300",
  K: "bg-teal-500/12 text-teal-700 ring-teal-500/25 dark:text-teal-300",
  DST: "bg-slate-500/12 text-slate-700 ring-slate-500/25 dark:text-slate-300",
};

/** A neutral chip for anything the board carries that this list does not know about. */
const UNKNOWN_CHIP = "bg-muted text-muted-foreground ring-border";

export function positionChipClass(position: string): string {
  return CHIPS[position.toUpperCase()] ?? UNKNOWN_CHIP;
}

const BARS: Readonly<Record<string, string>> = {
  QB: "bg-violet-500",
  RB: "bg-sky-500",
  WR: "bg-amber-500",
  TE: "bg-rose-500",
  K: "bg-teal-500",
  DST: "bg-slate-500",
};

/** The solid edge on a filled board cell, which is what makes a column scannable. */
export function positionBarClass(position: string): string {
  return BARS[position.toUpperCase()] ?? "bg-muted-foreground/40";
}

/** How a position is written out. Only D/ST differs from its code. */
export function positionLabel(position: string): string {
  return position.toUpperCase() === "DST" ? "D/ST" : position.toUpperCase();
}
