import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  type AwarenessBoardRow,
  type AwarenessSourceRow,
  joinMarketAwareness,
} from "./market-awareness";

/**
 * The awareness join.
 *
 * The cases worth pinning are the refusals: this join exists because #88's audit showed
 * what a wrong market signal does downstream, and a player wearing someone else's rank
 * is exactly as wrong as a player wearing someone else's price. The happy path is one
 * case; the refusals are the design.
 */

function boardRow(overrides: Partial<AwarenessBoardRow> = {}): AwarenessBoardRow {
  return {
    playerId: "p1",
    name: "Kenneth Gainwell",
    position: "RB",
    team: "TB",
    adp: null,
    ...overrides,
  };
}

function sourceRow(overrides: Partial<AwarenessSourceRow> = {}): AwarenessSourceRow {
  return {
    name: "Kenny Gainwell",
    position: "RB",
    team: "TB",
    searchRank: 86,
    depthChartPosition: "RB",
    depthChartOrder: 2,
    ...overrides,
  };
}

describe("joinMarketAwareness", () => {
  it("joins the measured Kenny/Kenneth case through the alias keys", () => {
    // The pick-2.06 player: our board spells him "Kenneth", the dump "Kenny". The strict
    // keys disagree, so this line is the whole reason `aliasNameKeys` exists.
    const { byPlayerId, ambiguities, unmatched } = joinMarketAwareness(
      [boardRow()],
      [sourceRow()],
    );
    expect(byPlayerId.get("p1")).toEqual({
      searchRank: 86,
      depthChartPosition: "RB",
      depthChartOrder: 2,
      sourceName: "Kenny Gainwell",
    });
    expect(ambiguities).toEqual([]);
    expect(unmatched).toEqual([]);
  });

  it("skips rows the market has priced — the signal must not second-guess a price", () => {
    const { byPlayerId } = joinMarketAwareness(
      [boardRow({ adp: 81.7 })],
      [sourceRow()],
    );
    expect(byPlayerId.size).toBe(0);
  });

  it("requires the position to agree, not only the name", () => {
    const { byPlayerId, unmatched } = joinMarketAwareness(
      [boardRow({ team: null })],
      [sourceRow({ position: "WR" })],
    );
    expect(byPlayerId.size).toBe(0);
    expect(unmatched).toEqual(["Kenneth Gainwell"]);
  });

  it("falls back to team + position + last name when no name key matches", () => {
    // A first name the alias table has never measured — the fallback is what rescues
    // it, and only because team and position also agree.
    const { byPlayerId } = joinMarketAwareness(
      [boardRow({ name: "Bob Gainwell" })],
      [sourceRow({ name: "Robert Gainwell", searchRank: 300 })],
    );
    expect(byPlayerId.get("p1")?.searchRank).toBe(300);
  });

  it("refuses the fallback when two source rows share it, and says so", () => {
    const { byPlayerId, ambiguities } = joinMarketAwareness(
      [boardRow({ name: "Bob Gainwell" })],
      [
        sourceRow({ name: "Robert Gainwell" }),
        sourceRow({ name: "Bobby Gainwell", searchRank: 999 }),
      ],
    );
    expect(byPlayerId.size).toBe(0);
    expect(ambiguities).toEqual(["Bob Gainwell"]);
  });

  it("never reaches the fallback for a board row without a team", () => {
    // Team is the fallback's whole warrant. Without it, a shared surname at a position
    // spans the entire league, and a match on that is a guess wearing a join.
    const { byPlayerId, unmatched } = joinMarketAwareness(
      [boardRow({ name: "Bob Gainwell", team: null })],
      [sourceRow({ name: "Robert Gainwell" })],
    );
    expect(byPlayerId.size).toBe(0);
    expect(unmatched).toEqual(["Bob Gainwell"]);
  });

  it("folds the source's market position spellings to the board's", () => {
    // Sleeper publishes defenses as `DEF`; the board says `DST`. Same fold as the ADP
    // feed's `normalizeMarketPosition`.
    const { byPlayerId } = joinMarketAwareness(
      [boardRow({ name: "Seattle Seahawks", position: "DST", team: "SEA" })],
      [
        sourceRow({
          name: "Seattle Seahawks",
          position: "DEF",
          team: "SEA",
          searchRank: 120,
          depthChartPosition: null,
          depthChartOrder: null,
        }),
      ],
    );
    expect(byPlayerId.get("p1")?.searchRank).toBe(120);
  });

  it("carries a matched row's null rank as null — known to the source, outside awareness", () => {
    const { byPlayerId, unmatched } = joinMarketAwareness(
      [boardRow()],
      [sourceRow({ searchRank: null })],
    );
    expect(byPlayerId.get("p1")?.searchRank).toBeNull();
    expect(unmatched).toEqual([]);
  });

  it("matches by exact name when the source offers no team", () => {
    // The name index is the primary join and must stand on its own: a dump row with no
    // team can never be rescued by the fallback, so a hit here is the only path.
    const { byPlayerId } = joinMarketAwareness(
      [boardRow()],
      [sourceRow({ team: null })],
    );
    expect(byPlayerId.get("p1")?.searchRank).toBe(86);
  });

  it("surfaces a name-index collision as an ambiguity, not a miss", () => {
    // Two dump rows with the same name at the same position: the position-qualified name
    // key is claimed twice, and with no team on either side nothing can arbitrate.
    const { byPlayerId, ambiguities } = joinMarketAwareness(
      [boardRow({ team: null })],
      [
        sourceRow({ name: "Kenneth Gainwell", team: null }),
        sourceRow({ name: "Kenneth Gainwell", team: null, searchRank: 900 }),
      ],
    );
    expect(byPlayerId.size).toBe(0);
    expect(ambiguities).toEqual(["Kenneth Gainwell"]);
  });

  it("does not let a crowded fallback overrule a unique name match", () => {
    // The fallback is a rescue for rows the name keys cannot place, never a second
    // opinion: here the alias keys identify the player exactly, while his team also
    // carries a second Gainwell that makes the team+position+last-name key ambiguous.
    const { byPlayerId, ambiguities } = joinMarketAwareness(
      [boardRow()],
      [sourceRow(), sourceRow({ name: "Zeke Gainwell", searchRank: 500 })],
    );
    expect(byPlayerId.get("p1")?.searchRank).toBe(86);
    expect(ambiguities).toEqual([]);
  });

  it("keys the fallback on a single-word name's only word", () => {
    const { byPlayerId } = joinMarketAwareness(
      [boardRow({ name: "Gainwell" })],
      [sourceRow()],
    );
    expect(byPlayerId.get("p1")?.searchRank).toBe(86);
  });

  it("keeps two fallback rescues on one team apart by their last names", () => {
    // Both rows resolve only through team+position+last name; the last name is what
    // separates them, so a fallback keyed on anything else collapses them into an
    // ambiguity or matches nobody.
    const { byPlayerId, ambiguities, unmatched } = joinMarketAwareness(
      [
        boardRow({ playerId: "p1", name: "Bob Gainwell" }),
        boardRow({ playerId: "p2", name: "Cletus Smith" }),
      ],
      [
        sourceRow({ name: "Robert Gainwell", searchRank: 300 }),
        sourceRow({ name: "Zeke Smith", searchRank: 400 }),
      ],
    );
    expect(byPlayerId.get("p1")?.searchRank).toBe(300);
    expect(byPlayerId.get("p2")?.searchRank).toBe(400);
    expect(ambiguities).toEqual([]);
    expect(unmatched).toEqual([]);
  });

  it("folds the BOARD's position spelling too, not only the source's", () => {
    // The price feed spells defenses `DEF` and kickers `PK` before
    // `normalizeMarketPosition` runs, and `AwarenessBoardRow` is documented as satisfied
    // by ingest rows. Folding only the source side builds a key the index does not hold,
    // and every defense and kicker lands in `unmatched` with no error.
    const { byPlayerId, unmatched } = joinMarketAwareness(
      [boardRow({ name: "Seattle Seahawks", position: "DEF", team: "SEA" })],
      [
        sourceRow({
          name: "Seattle Seahawks",
          position: "DST",
          team: "SEA",
          searchRank: 120,
        }),
      ],
    );
    expect(byPlayerId.get("p1")?.searchRank).toBe(120);
    expect(unmatched).toEqual([]);
  });

  it("treats a board row with no adp field at all as unpriced", () => {
    // `undefined` and `null` say the same thing about the player. Reading absent as
    // priced would skip the row into neither `unmatched` nor `ambiguities` — the one
    // outcome this module refuses everywhere else.
    const { adp: _dropped, ...withoutAdp } = boardRow();
    const { byPlayerId } = joinMarketAwareness(
      [withoutAdp as AwarenessBoardRow],
      [sourceRow()],
    );
    expect(byPlayerId.get("p1")?.searchRank).toBe(86);
  });

  it("lists what it could not match rather than dropping it", () => {
    const { unmatched } = joinMarketAwareness(
      [boardRow({ name: "Bam Knight", team: null })],
      [sourceRow()],
    );
    expect(unmatched).toEqual(["Bam Knight"]);
  });
});

describe("search rank stays out of the pricing pipeline", () => {
  /**
   * The one hard rule #90.2 attached to this source: `search_rank` is a search-relevance
   * ordering, not an ADP, and it must never reach `fitAdpCurve` as if it were a draft
   * position. A rule that only exists in prose gets argued with (see
   * `import-alias.test.ts` for the precedent), so this walks every deployable source
   * file that calls the curve fit and asserts none of them can see a search rank. A
   * future change that genuinely needs both in one file has to edit this test in the
   * same commit, which is the deliberate-flip discipline every lock in this repo uses.
   *
   * `app/` is guarded too, though nothing there calls the curve fit today: the claim the
   * README makes is "every caller", and a lock that skipped the one directory where a
   * label is actually rendered would be the weaker claim wearing the stronger one's
   * words.
   */
  const GUARDED = ["lib", "convex", "scripts", "app"];

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const name of readdirSync(d)) {
        if (name === "_generated" || name === "node_modules") continue;
        const full = join(d, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
      }
    };
    walk(dir);
    return out;
  }

  it("no file that calls fitAdpCurve mentions a search rank", () => {
    const offenders: string[] = [];
    for (const dir of GUARDED) {
      for (const file of sourceFiles(dir)) {
        const source = readFileSync(file, "utf8");
        if (!/\bfitAdpCurves?\(/.test(source)) continue;
        if (/search_?[Rr]ank/.test(source)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
