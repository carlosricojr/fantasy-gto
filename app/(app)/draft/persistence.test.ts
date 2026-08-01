import { describe, expect, it } from "vitest";

import { type PersistedDraft, parsePersistedDraft } from "./persistence";

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

  it("keeps pick numbers as numbers, not the strings JSON turns keys into", () => {
    // `Object.entries` hands back string keys. The board indexes picks by number, and a
    // record keyed by "1" does not answer a lookup for 1.
    const parsed = parsePersistedDraft(stored({ picks: { 7: "p" } }));
    expect(parsed?.picks[7]).toBe("p");
  });
});
