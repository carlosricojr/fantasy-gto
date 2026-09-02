import { describe, expect, it } from "vitest";

import {
  CHAMPIONSHIP_WEEKS,
  DEFAULT_CHAMPIONSHIP_WEEK,
  MAX_ROUNDS,
  type PersistedDraft,
  nextPick,
  parsePersistedDraft,
  recordPick,
  undoPick,
} from "./persistence";
import { ROSTER_TEMPLATES } from "@/lib/nfl/roster";

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
  scoringConfirmed: true,
  playoffTeams: 6,
  championshipWeek: 17,
  started: true,
  picks: { 1: "player-a", 2: "player-b" },
  queue: ["player-c", "player-d"],
  sleeper: null,
};

const stored = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({ ...VALID, ...overrides });

describe("the queue is read leniently, and it is the only field that is", () => {
  it("restores a payload written before the queue existed", () => {
    // The failure this prevents is severe and entirely self-inflicted: a build that adds
    // an optional field and validates it strictly throws away the in-progress draft of
    // everybody who was mid-draft when it shipped. Every other field here decides whose
    // picks are whose; a watch list does not.
    const withoutQueue: Record<string, unknown> = { ...VALID };
    delete withoutQueue.queue;
    const restored = parsePersistedDraft(JSON.stringify(withoutQueue));
    expect(restored?.picks).toEqual(VALID.picks);
    expect(restored?.queue).toEqual([]);
  });

  it("drops unusable entries rather than the draft", () => {
    expect(parsePersistedDraft(stored({ queue: "not an array" }))?.queue).toEqual([]);
    expect(parsePersistedDraft(stored({ queue: [1, "", null, "a"] }))?.queue).toEqual(["a"]);
  });

  it("keeps the order the manager put them in, without duplicates", () => {
    // Two rows for one player render two remove buttons that both delete the first.
    expect(parsePersistedDraft(stored({ queue: ["b", "a", "b"] }))?.queue).toEqual([
      "b",
      "a",
    ]);
  });
});

describe("parsePersistedDraft", () => {
  it("round-trips a draft it wrote", () => {
    expect(parsePersistedDraft(stored())).toEqual(VALID);
  });

  it("refuses malformed Sleeper sync while retaining absent legacy sync", () => {
    const legacy: Record<string, unknown> = { ...VALID };
    delete legacy.sleeper;
    expect(parsePersistedDraft(JSON.stringify(legacy))?.sleeper).toBeNull();
    expect(parsePersistedDraft(stored({ sleeper: { draftId: "only-this" } }))).toBeNull();
  });

  it("round-trips the exact configuration this epic is built against", () => {
    // Ten teams, fifteen rounds, standard scoring, two FLEX — the league the recommendations
    // were tested against, and the one no roster template could represent before #41. A
    // preset that cannot be *restored* is a preset a user loses on a page refresh, halfway
    // through the draft it was chosen for.
    const mock: PersistedDraft = {
      teams: 10,
      rounds: 15,
      slot: 9,
      scoringId: "standard",
      templateId: "two_flex",
      scoringConfirmed: true,
      playoffTeams: 6,
      championshipWeek: 17,
      started: true,
      queue: [],
      picks: { 1: "player-a" },
      sleeper: null,
    };
    expect(parsePersistedDraft(JSON.stringify(mock))).toEqual(mock);
  });

  it("round-trips every shipped roster template at its own round count", () => {
    // Each preset carries the roster size it is drafted at, and both halves have to survive
    // a reload: a two-FLEX league restored at thirteen rounds is a different league.
    for (const template of ROSTER_TEMPLATES) {
      const payload: PersistedDraft = {
        ...VALID,
        templateId: template.id,
        rounds: template.rounds,
      };
      expect(parsePersistedDraft(JSON.stringify(payload))).toEqual(payload);
    }
  });

  it("carries no template whose own round count this refuses", () => {
    // A preset the setup screen applies and the parser then rejects would be a draft that
    // cannot be reloaded, discovered only on a refresh. `normalizeLeagueSetup` clamps rather
    // than refusing, so the mismatch would be silent in the other direction too.
    for (const template of ROSTER_TEMPLATES) {
      expect(template.rounds).toBeLessThanOrEqual(MAX_ROUNDS);
      expect(template.rounds).toBeGreaterThanOrEqual(1);
    }
  });

  it("reads a payload with no scoring confirmation as unconfirmed", () => {
    // A draft stored before the confirmation existed carries a format nobody confirmed.
    // Treating it as confirmed would invent the acknowledgement the field exists to require.
    const older: Record<string, unknown> = { ...VALID };
    delete older.scoringConfirmed;
    expect(parsePersistedDraft(JSON.stringify(older))?.scoringConfirmed).toBe(false);
  });

  it("refuses a scoring confirmation that is not a boolean", () => {
    // Not coerced. `"false"` is truthy, and a payload carrying the string "false" would
    // otherwise confirm a format the user never looked at.
    for (const value of ["true", "false", 1, 0, {}]) {
      expect(parsePersistedDraft(stored({ scoringConfirmed: value }))).toBeNull();
    }
  });

  it("treats an explicit null the same as an absent field", () => {
    // Both mean "nobody confirmed anything", and both resolve to unconfirmed rather than to
    // a refusal — a stored draft is not worth discarding over a field that says nothing.
    expect(parsePersistedDraft(stored({ scoringConfirmed: null }))?.scoringConfirmed).toBe(
      false,
    );
  });

  it("round-trips a confirmed and an unconfirmed draft as different drafts", () => {
    expect(parsePersistedDraft(stored({ scoringConfirmed: true }))?.scoringConfirmed).toBe(
      true,
    );
    expect(parsePersistedDraft(stored({ scoringConfirmed: false }))?.scoringConfirmed).toBe(
      false,
    );
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
    // Six through sixteen are built — seven of them from a neighbour's board by rescaling
    // every pick number, which the board itself records. Outside that range there is no
    // board at all and the setup screen never offers one.
    for (const teams of [1, 4, 5, 17, 20, 32]) {
      expect(parsePersistedDraft(stored({ teams }))).toBeNull();
    }
  });

  it("accepts the sizes with no published market board of their own", () => {
    // The seven this used to refuse. They are ordinary leagues; what was missing was a
    // published board, not a reason to decline the league.
    for (const teams of [6, 7, 9, 11, 13, 15, 16]) {
      // Playoff field 4, because a six-team league cannot send six teams to the playoffs
      // and the parser refuses a field as large as the league.
      expect(
        parsePersistedDraft(stored({ teams, slot: 4, playoffTeams: 4 }))?.teams,
      ).toBe(teams);
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

  it("restores a draft written before the championship week was a setting", () => {
    // The migration this default exists for. A payload without the field was already being
    // simulated as a week-17 final — that pair of literals was the only season the board
    // could describe — so restoring it as anything else would move a draft in progress
    // into a league it was not drafted for. Unlike the queue, the value is not a note to
    // self; unlike `scoringConfirmed`, defaulting it invents nothing.
    const legacy: Record<string, unknown> = { ...VALID };
    delete legacy.championshipWeek;
    const restored = parsePersistedDraft(JSON.stringify(legacy));
    expect(restored?.championshipWeek).toBe(DEFAULT_CHAMPIONSHIP_WEEK);
    expect(restored?.picks).toEqual(VALID.picks);
  });

  it("restores every championship week the product offers, and refuses the rest", () => {
    for (const championshipWeek of CHAMPIONSHIP_WEEKS) {
      expect(parsePersistedDraft(stored({ championshipWeek }))?.championshipWeek).toBe(
        championshipWeek,
      );
    }
    // Nothing downstream repairs a stored value: the control offers only these three, so a
    // stored 13 has no button that could correct it and would reach `fantasySeasonWeeks`
    // as is. Week 18 is refused deliberately rather than incidentally — it is a real NFL
    // week that `isNflRegularSeasonWeek` admits, and it is the one no league should be
    // advised to play a final in.
    for (const championshipWeek of [0, 12, 13, 14, 18, 19, 16.5, "16", null]) {
      expect(parsePersistedDraft(stored({ championshipWeek }))).toBeNull();
    }
  });

  it("refuses an unknown scoring preset or roster template", () => {
    // `scoringById` falls back to the default rather than throwing, so an unknown id here
    // would silently score the whole board under rules the user did not pick.
    expect(parsePersistedDraft(stored({ scoringId: "dynasty-2qb" }))).toBeNull();
    expect(parsePersistedDraft(stored({ templateId: "not-a-template" }))).toBeNull();
  });

  it("refuses a pick number past the end of the draft", () => {
    // 12 teams over 15 rounds is 180 picks; pick 181 belongs to no seat. The valid case has
    // to be a full 1..180, because picks are also required to be a prefix — a lone pick 180
    // is a different kind of corrupt, and using it here would test the wrong guard.
    const full = Object.fromEntries(
      Array.from({ length: 180 }, (_, i) => [i + 1, `p${i + 1}`]),
    );
    expect(parsePersistedDraft(stored({ picks: full }))).not.toBeNull();
    expect(parsePersistedDraft(stored({ picks: { ...full, 181: "extra" } }))).toBeNull();
  });

  it("refuses picks with a gap in them", () => {
    // Each key passing its own range check is not enough. `{"5": "someone"}` satisfies every
    // per-key test, and then `nextPick` puts pick 1 on the clock while a player sits at
    // pick 5: recording fills 1 through 4 and stops, so the board reads as five picks made
    // and one of them is a player nobody chose at a turn nobody took. `undoPick` cannot
    // repair it either — from a lone pick 5 it computes pick 0 and refuses.
    expect(parsePersistedDraft(stored({ picks: { 5: "a" } }))).toBeNull();
    expect(parsePersistedDraft(stored({ picks: { 1: "a", 3: "c" } }))).toBeNull();
    expect(parsePersistedDraft(stored({ picks: { 2: "b" } }))).toBeNull();
    // A genuine prefix, and an empty draft, are both fine.
    expect(parsePersistedDraft(stored({ picks: { 1: "a", 2: "b" } }))?.picks).toEqual({
      1: "a",
      2: "b",
    });
    expect(parsePersistedDraft(stored({ picks: {} }))?.picks).toEqual({});
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
    const parsed = parsePersistedDraft(
      stored({ picks: { 1: "a", 2: "b", 3: "c", 4: "d", 5: "e", 6: "f", 7: "p" } }),
    );
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

/**
 * The boundaries of what will be restored, and of the pick helpers.
 *
 * A restore that accepts one field too many puts a board on screen that the rest of the
 * code refuses, and a restore that rejects one too few loses a draft in progress. Each of
 * these was a surviving mutant: every guard could be moved by one, and the two comparisons
 * in the pick helpers could be loosened, without a single assertion changing.
 */
describe("parsePersistedDraft boundaries", () => {
  const valid = {
    teams: 12,
    rounds: 15,
    slot: 3,
    playoffTeams: 4,
    scoringId: "ppr",
    templateId: "standard",
    started: true,
    picks: {},
  };
  const parse = (over: Record<string, unknown>) =>
    parsePersistedDraft(JSON.stringify({ ...valid, ...over }));

  it("restores the longest draft it allows, and refuses one longer", () => {
    expect(parse({ rounds: MAX_ROUNDS })?.rounds).toBe(MAX_ROUNDS);
    expect(parse({ rounds: MAX_ROUNDS + 1 })).toBeNull();
    expect(MAX_ROUNDS).toBe(30);
  });

  it("refuses a playoff field the lists do not offer", () => {
    // Refused by the `PLAYOFF_FIELDS` whitelist, which is the guard that actually fires.
    // The `playoffTeams >= teams` line below it cannot be reached while the lists are 4 or
    // 6 against 8 through 14 — the source says so — and this test does not pretend to
    // cover it. Asserting a rejection that a *different* guard produces would read as
    // coverage of the cross-field check and be none.
    expect(parse({ teams: 12, playoffTeams: 12 })).toBeNull();
    expect(parse({ teams: 12, playoffTeams: 5 })).toBeNull();
    expect(parse({ teams: 12, playoffTeams: 6 })?.playoffTeams).toBe(6);
    expect(parse({ teams: 8, playoffTeams: 4 })?.playoffTeams).toBe(4);
  });

  it("needs every numeric field, not just one of them", () => {
    // Four `|| null` checks in one condition. Turned into `&&`, a single missing field
    // passes and reaches the rest of the parse as `null`.
    for (const missing of ["teams", "rounds", "slot", "playoffTeams"]) {
      expect(parse({ [missing]: "not a number" })).toBeNull();
      expect(parse({ [missing]: null })).toBeNull();
    }
  });

  it("needs both string fields, not just one", () => {
    expect(parse({ scoringId: 5 })).toBeNull();
    expect(parse({ templateId: 5 })).toBeNull();
    expect(parse({ scoringId: 5, templateId: 5 })).toBeNull();
  });

  it("treats an empty string as nothing stored, not as a payload", () => {
    // `raw === null || raw === ""`. `JSON.parse("")` throws, so as `&&` this reaches the
    // parse and the whole restore path fails on a key that simply has no value yet.
    expect(parsePersistedDraft("")).toBeNull();
    expect(parsePersistedDraft(null)).toBeNull();
  });
});

describe("the pick helpers' own boundaries", () => {
  it("fills the last pick of a draft rather than stopping one short", () => {
    // `pick > totalPicks`. One tighter and the final pick of every draft can never be
    // recorded — the board sits one short of complete with no way to finish it.
    expect(recordPick({ 1: "a" }, "b", 2)).toEqual({ 1: "a", 2: "b" });
    expect(recordPick({ 1: "a", 2: "b" }, "c", 2)).toEqual({ 1: "a", 2: "b" });
  });

  it("scans every pick of the draft, including the last", () => {
    // The loop bound in `nextPick`. As `<` the final pick is never offered, so a full board
    // reports the same number as one with its last pick still open.
    expect(nextPick({ 1: "a" }, 2)).toBe(2);
    expect(nextPick({ 1: "a", 2: "b" }, 2)).toBe(3);
  });

  it("undoes the first pick rather than refusing it", () => {
    // `pick < 1`. One looser and the first pick of a draft can never be taken back.
    expect(undoPick({ 1: "a" }, 10)).toEqual({});
  });
});
