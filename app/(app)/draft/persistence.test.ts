import { describe, expect, it } from "vitest";

import {
  MAX_ROUNDS,
  type PersistedDraft,
  nextPick,
  parsePersistedDraft,
  recordPick,
  undoPick,
} from "./persistence";

/**
 * Restoring a draft.
 *
 * The payload outlives the code that wrote it — a user with a draft open across a deploy
 * has last week's shape sitting in their tab. So the only two acceptable outcomes are a
 * fully valid draft or nothing at all. A partial restore, where the picks come back but
 * the league they belong to does not, is a board attributing real players to the wrong
 * seats, which is the failure this feature is written to avoid everywhere else.
 */

const VALID: PersistedDraft = {
  teams: 12,
  rounds: 15,
  slot: 4,
  scoringId: "ppr",
  templateId: "standard",
  playoffTeams: 6,
  started: true,
  picks: { 1: "player-a", 2: "player-b" },
};

const stored = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({ ...VALID, ...overrides });

describe("parsePersistedDraft", () => {
  it("round-trips a draft it wrote", () => {
    expect(parsePersistedDraft(stored())).toEqual(VALID);
  });

  it("restores an unstarted draft, which is not the same as no draft", () => {
    expect(parsePersistedDraft(stored({ started: false, picks: {} }))?.started).toBe(false);
  });

  it("returns null when there is nothing stored", () => {
    expect(parsePersistedDraft(null)).toBeNull();
    expect(parsePersistedDraft("")).toBeNull();
  });

  it("returns null rather than throwing on malformed JSON", () => {
    expect(parsePersistedDraft("{not json")).toBeNull();
    expect(parsePersistedDraft("null")).toBeNull();
    expect(parsePersistedDraft('"a string"')).toBeNull();
    expect(parsePersistedDraft("[]")).toBeNull();
  });

  it("refuses a payload missing any league field rather than defaulting it", () => {
    // Defaulting `teams` or `slot` restores the picks into a different league than the one
    // they were made in, and every seat below the user's is then named one too high.
    for (const field of ["teams", "rounds", "slot", "playoffTeams"]) {
      expect(parsePersistedDraft(stored({ [field]: undefined }))).toBeNull();
      expect(parsePersistedDraft(stored({ [field]: 0 }))).toBeNull();
      expect(parsePersistedDraft(stored({ [field]: -1 }))).toBeNull();
      expect(parsePersistedDraft(stored({ [field]: 12.5 }))).toBeNull();
      expect(parsePersistedDraft(stored({ [field]: "12" }))).toBeNull();
    }
  });

  it("refuses a payload missing the scoring or roster template", () => {
    // These decide what a lineup even is. Silently reverting to the default preset would
    // score the whole board under rules the user did not choose.
    expect(parsePersistedDraft(stored({ scoringId: undefined }))).toBeNull();
    expect(parsePersistedDraft(stored({ templateId: 42 }))).toBeNull();
  });

  it("refuses a payload whose started flag is not a boolean", () => {
    expect(parsePersistedDraft(stored({ started: "yes" }))).toBeNull();
    expect(parsePersistedDraft(stored({ started: undefined }))).toBeNull();
  });

  it("refuses picks that are not pick-number to player-id", () => {
    expect(parsePersistedDraft(stored({ picks: { 0: "p" } }))).toBeNull();
    expect(parsePersistedDraft(stored({ picks: { "-1": "p" } }))).toBeNull();
    expect(parsePersistedDraft(stored({ picks: { "1.5": "p" } }))).toBeNull();
    expect(parsePersistedDraft(stored({ picks: { abc: "p" } }))).toBeNull();
    expect(parsePersistedDraft(stored({ picks: { 1: "" } }))).toBeNull();
    expect(parsePersistedDraft(stored({ picks: { 1: 99 } }))).toBeNull();
    expect(parsePersistedDraft(stored({ picks: ["p"] }))).toBeNull();
    expect(parsePersistedDraft(stored({ picks: null }))).toBeNull();
  });

  it("accepts an empty board", () => {
    expect(parsePersistedDraft(stored({ picks: {} }))?.picks).toEqual({});
  });

  it("refuses a league size no board is built for", () => {
    // ADP is published per league size, so a board is not transferable. An 11-team draft
    // has no board behind it and the setup screen never offers one.
    for (const teams of [7, 11, 13, 32]) {
      expect(parsePersistedDraft(stored({ teams }))).toBeNull();
    }
  });

  it("accepts every league size a board is built for, at both ends", () => {
    // Pinned individually so a change to the list is a change to a test, not a silent
    // widening or narrowing of what the product will restore.
    for (const teams of [8, 10, 12, 14]) {
      expect(parsePersistedDraft(stored({ teams, slot: 1 }))?.teams).toBe(teams);
    }
  });

  it("refuses a round count past the maximum, and accepts the maximum itself", () => {
    // Against the constant, not a literal. The setup control uses the same one, and the
    // two were independent numbers until they disagreed — 30 in the interface against 40
    // here, so a restored draft could hold a round count nothing could correct.
    expect(parsePersistedDraft(stored({ rounds: MAX_ROUNDS, picks: {} }))?.rounds).toBe(
      MAX_ROUNDS,
    );
    expect(parsePersistedDraft(stored({ rounds: MAX_ROUNDS + 1, picks: {} }))).toBeNull();
  });

  it("refuses a slot outside the league it was stored with", () => {
    // The failure this exact check exists for: `snakePicks` still produces plausible
    // numbers for an out-of-range seat, and they belong to somebody else.
    expect(parsePersistedDraft(stored({ teams: 12, slot: 13 }))).toBeNull();
    expect(parsePersistedDraft(stored({ teams: 12, slot: 12 }))?.slot).toBe(12);
  });

  it("refuses a playoff field the product does not offer, or one that cannot fit", () => {
    // Nothing downstream repairs this. The setup control lists only 4 and 6, so a stored
    // 11 has no control that could correct it and reaches the simulation config as is.
    for (const playoffTeams of [1, 2, 3, 5, 8, 11]) {
      expect(parsePersistedDraft(stored({ playoffTeams }))).toBeNull();
    }
    expect(parsePersistedDraft(stored({ teams: 8, playoffTeams: 6 }))).not.toBeNull();
    // Note what this does *not* prove. `playoffTeams: 8` is rejected by the list check
    // above, not by the `playoffTeams >= teams` check below it — with the current lists
    // (4 or 6 against 8 through 14) a valid field is always smaller than its league, so
    // that comparison is unreachable and no input can exercise it. It stays as a guard
    // for the day someone adds a smaller league or a larger field, and this comment is
    // here so nobody reads the line above as covering it.
    expect(parsePersistedDraft(stored({ teams: 8, playoffTeams: 8 }))).toBeNull();
  });

  it("refuses an unknown scoring preset or roster template", () => {
    // `scoringById` falls back to the default rather than throwing, so an unknown id here
    // would silently score the whole board under rules the user did not pick.
    expect(parsePersistedDraft(stored({ scoringId: "dynasty-2qb" }))).toBeNull();
    expect(parsePersistedDraft(stored({ templateId: "not-a-template" }))).toBeNull();
  });

  it("refuses a pick number past the end of the draft", () => {
    // 12 teams over 15 rounds is 180 picks. Pick 181 belongs to no seat.
    expect(parsePersistedDraft(stored({ picks: { 180: "p" } }))).not.toBeNull();
    expect(parsePersistedDraft(stored({ picks: { 181: "p" } }))).toBeNull();
  });

  it("refuses the same player drafted twice", () => {
    // A board that cannot exist. Restored, it would show a player on two rosters and
    // remove him from the pool once.
    expect(parsePersistedDraft(stored({ picks: { 1: "dup", 2: "dup" } }))).toBeNull();
  });

  it("refuses two keys that resolve to the same pick", () => {
    // `"1"` and `"01"` both parse to 1, and the second would overwrite the first — quietly
    // repairing corrupt state into a different draft rather than refusing it. The
    // numeric-lookup assertion below cannot prove this, because `picks[7]` coerces to
    // `picks["7"]` either way.
    expect(parsePersistedDraft(stored({ picks: { "1": "a", "01": "b" } }))).toBeNull();
    expect(parsePersistedDraft(stored({ picks: { "007": "a" } }))).toBeNull();
    expect(parsePersistedDraft(stored({ picks: { " 7": "a" } }))).toBeNull();
  });

  it("keeps pick numbers as numbers, not the strings JSON turns keys into", () => {
    // `Object.entries` hands back string keys. The board indexes picks by number, and a
    // record keyed by "1" does not answer a lookup for 1.
    const parsed = parsePersistedDraft(stored({ picks: { 7: "p" } }));
    expect(parsed?.picks[7]).toBe("p");
  });
});

/**
 * Recording and undoing a pick, on the state the updater is handed.
 *
 * These were inline in the page and read `currentPick` from the render closure, so a second
 * click arriving before React re-rendered still saw the previous pick number. The
 * `drafted.has(playerId)` guard covered a repeated click on the *same* player and nothing
 * else: two different players clicked quickly wrote the same key, the first was silently
 * overwritten, and the player it dropped stayed on the board and kept being recommended.
 */
describe("recordPick", () => {
  it("puts a player at the first empty pick", () => {
    expect(recordPick({}, "a", 10)).toEqual({ 1: "a" });
    expect(recordPick({ 1: "a" }, "b", 10)).toEqual({ 1: "a", 2: "b" });
  });

  it("gives two players in a row two different picks", () => {
    // The race, as it reaches the reducer: both calls start from the same state. Applied in
    // sequence — which is what a functional updater guarantees — the second must see the
    // first. Reading the pick number from a render closure is what broke that.
    const first = recordPick({}, "a", 10);
    const second = recordPick(first, "b", 10);
    expect(second).toEqual({ 1: "a", 2: "b" });
    expect(Object.keys(second)).toHaveLength(2);
  });

  it("refuses a player who is already on a roster", () => {
    const state = { 1: "a", 2: "b" };
    expect(recordPick(state, "a", 10)).toBe(state);
    expect(recordPick(state, "b", 10)).toBe(state);
  });

  it("refuses a pick past the end of the draft", () => {
    const full = { 1: "a", 2: "b" };
    expect(recordPick(full, "c", 2)).toBe(full);
  });

  it("fills a gap left by an undo before extending", () => {
    // `nextPick` is "first empty", not "one past the last", so an undo in the middle is
    // refilled rather than skipped.
    expect(recordPick({ 1: "a", 3: "c" }, "b", 10)).toEqual({ 1: "a", 2: "b", 3: "c" });
  });
});

describe("undoPick", () => {
  it("removes the most recent pick", () => {
    expect(undoPick({ 1: "a", 2: "b" }, 10)).toEqual({ 1: "a" });
  });

  it("removes two picks when called twice, not one", () => {
    // The same staleness in the other direction: two rapid undos both deleted the same key.
    expect(undoPick(undoPick({ 1: "a", 2: "b", 3: "c" }, 10), 10)).toEqual({ 1: "a" });
  });

  it("does nothing on an empty draft", () => {
    const empty = {};
    expect(undoPick(empty, 10)).toBe(empty);
  });

  it("removes the last pick of a finished draft", () => {
    expect(undoPick({ 1: "a", 2: "b" }, 2)).toEqual({ 1: "a" });
  });
});

describe("nextPick", () => {
  it("runs one past the end when every pick is in", () => {
    expect(nextPick({ 1: "a", 2: "b" }, 2)).toBe(3);
  });

  it("is the first gap, not the count", () => {
    expect(nextPick({ 1: "a", 3: "c" }, 10)).toBe(2);
    expect(nextPick({}, 10)).toBe(1);
  });
});
