import { describe, expect, it } from "vitest";

import {
  SleeperDraftProvider,
  draftPicksUrl,
  draftUrl,
  parsePicks,
  parseSettings,
} from "./sleeper";

/**
 * Sleeper draft state.
 *
 * Unlike the ADP fixture, these payloads are constructed from Sleeper's documented shape
 * rather than captured from a live draft — no public draft id was available to record.
 * That limitation is stated in `docs/data-sources.md` rather than glossed, and it is why
 * both parsers are written to skip what they cannot read instead of assuming a field is
 * present.
 */

const DRAFT = {
  type: "snake",
  status: "drafting",
  settings: { teams: 12, rounds: 15 },
};

const PICKS = [
  {
    pick_no: 2,
    round: 1,
    draft_slot: 2,
    player_id: "6786",
    metadata: { first_name: "Bijan", last_name: "Robinson", position: "RB", team: "ATL" },
  },
  {
    pick_no: 1,
    round: 1,
    draft_slot: 1,
    player_id: "9509",
    metadata: { first_name: "Jahmyr", last_name: "Gibbs", position: "rb", team: "det" },
  },
];

describe("urls", () => {
  it("escapes the draft id rather than interpolating it raw", () => {
    // A pasted id can carry whitespace or a stray path segment. Interpolating it raw
    // would silently request a different endpoint.
    expect(draftUrl("123/../evil")).not.toContain("/../");
    expect(draftPicksUrl("a b")).toContain("a%20b");
  });
});

describe("parseSettings", () => {
  it("reads teams and rounds", () => {
    const settings = parseSettings(DRAFT);
    expect(settings).toEqual({ teams: 12, rounds: 15, type: "snake", status: "drafting" });
  });

  it("returns null when the numbers that matter are missing", () => {
    // Teams and rounds decide every pick number this feature computes. Defaulting them
    // would produce a plausible-looking board built on invented league settings.
    expect(parseSettings({ settings: {} })).toBeNull();
    expect(parseSettings({ settings: { teams: 12 } })).toBeNull();
    expect(parseSettings({ settings: { teams: 0, rounds: 15 } })).toBeNull();
    expect(parseSettings(null)).toBeNull();
  });

  it("refuses to default the draft type, which decides pick order", () => {
    // Same class of field as teams and rounds. A linear draft read as a snake misassigns
    // every pick from round two onward, producing a complete-looking board attributing
    // real players to the wrong managers.
    expect(parseSettings({ settings: { teams: 10, rounds: 16 } })).toBeNull();
    expect(parseSettings({ type: "", settings: { teams: 10, rounds: 16 } })).toBeNull();
    expect(
      parseSettings({ type: "LINEAR", settings: { teams: 10, rounds: 16 } })?.type,
    ).toBe("linear");
  });

  it("refuses a fractional team or round count rather than truncating it", () => {
    // 10.5 teams is not a league that got rounded, it is a payload this code does not
    // understand — and truncating turned it into a plausible 10 that the guards below
    // could no longer see.
    expect(parseSettings({ type: "snake", settings: { teams: 10.5, rounds: 16 } })).toBeNull();
    expect(parseSettings({ type: "snake", settings: { teams: 10, rounds: 16.5 } })).toBeNull();
  });

  it("refuses a draft format it cannot represent at all", () => {
    // An auction has no pick order, so every pick number derived from it is fiction. Read
    // as a snake it produces a complete, confident board of seats that never existed.
    expect(parseSettings({ type: "auction", settings: { teams: 10, rounds: 16 } })).toBeNull();
    expect(parseSettings({ type: "unknown", settings: { teams: 10, rounds: 16 } })).toBeNull();
  });

  it("defaults only what is genuinely cosmetic", () => {
    const settings = parseSettings({ type: "snake", settings: { teams: 10, rounds: 16 } });
    expect(settings?.status).toBe("unknown");
  });
});

describe("parsePicks", () => {
  it("orders picks by overall number regardless of arrival order", () => {
    // Sleeper does not guarantee order, and a board built in arrival order would attribute
    // picks to the wrong managers.
    const picks = parsePicks(PICKS);
    expect(picks.map((p) => p.overall)).toEqual([1, 2]);
    expect(picks[0].playerName).toBe("Jahmyr Gibbs");
  });

  it("normalizes position and team casing", () => {
    const picks = parsePicks(PICKS);
    expect(picks[0].position).toBe("RB");
    expect(picks[0].team).toBe("DET");
  });

  it("carries the platform's own player id, and only when it is one", () => {
    // The id is how a pick is de-duplicated across polls. Inverting the type check turns
    // every real pick's id into null — Sleeper documents it as a string — while letting
    // non-string junk through into a field typed `string | null`.
    expect(parsePicks(PICKS)[0].playerId).toBe("9509");
    expect(parsePicks(PICKS)[1].playerId).toBe("6786");
    expect(
      parsePicks([
        { pick_no: 1, draft_slot: 1, player_id: 6786, metadata: { first_name: "A", last_name: "B" } },
      ])[0].playerId,
    ).toBeNull();
  });

  it("skips a pick with no usable name rather than inventing one", () => {
    const picks = parsePicks([
      { pick_no: 1, draft_slot: 1, metadata: {} },
      { pick_no: 2, draft_slot: 2, metadata: { first_name: "Real", last_name: "Player" } },
    ]);
    expect(picks).toHaveLength(1);
    expect(picks[0].playerName).toBe("Real Player");
  });

  it("drops a pick whose seat is unknown rather than attributing it to seat zero", () => {
    // The seat decides which manager owns the pick. Defaulting it files the player under
    // somebody who did not take him, and that roster is what the odds are computed from —
    // strictly worse than not recording the pick at all.
    expect(
      parsePicks([{ pick_no: 1, metadata: { first_name: "A", last_name: "B" } }]),
    ).toEqual([]);
    expect(
      parsePicks([
        { pick_no: 1, draft_slot: "not a number", metadata: { first_name: "A", last_name: "B" } },
      ]),
    ).toEqual([]);

    // Seats are 1-based. Zero and negatives parse as integers but are not seats, and
    // would attribute the pick to a manager who does not exist.
    for (const draftSlot of [0, -1, -12]) {
      expect(
        parsePicks([
          { pick_no: 1, draft_slot: draftSlot, metadata: { first_name: "A", last_name: "B" } },
        ]),
      ).toEqual([]);
    }
  });

  it("drops a pick whose overall number is not a real pick", () => {
    // Same rule as `draft_slot`, and for the same reason: an identity field that parses
    // but cannot be real puts the pick at a position no draft has. Picks are sorted by
    // this number, so an overall of 0 or -3 sorts ahead of the true first pick.
    for (const pickNo of [0, -1, -12]) {
      expect(
        parsePicks([
          { pick_no: pickNo, draft_slot: 1, metadata: { first_name: "A", last_name: "B" } },
        ]),
      ).toEqual([]);
    }
  });

  it("leaves an unusable round null rather than calling it round zero", () => {
    // Same rule as the other identity fields: a defaulted zero reads as real data.
    const [pick] = parsePicks([
      { pick_no: 1, draft_slot: 1, round: 0, metadata: { first_name: "A", last_name: "B" } },
    ]);
    expect(pick.round).toBeNull();
    const [withRound] = parsePicks([
      { pick_no: 1, draft_slot: 1, round: 3, metadata: { first_name: "A", last_name: "B" } },
    ]);
    expect(withRound.round).toBe(3);
  });

  it("drops a pick whose seat or number is fractional", () => {
    expect(
      parsePicks([
        { pick_no: 1, draft_slot: 2.5, metadata: { first_name: "A", last_name: "B" } },
      ]),
    ).toEqual([]);
    expect(
      parsePicks([
        { pick_no: 1.5, draft_slot: 2, metadata: { first_name: "A", last_name: "B" } },
      ]),
    ).toEqual([]);
  });

  it("skips a pick with no overall number", () => {
    // Without it the pick cannot be placed in the draft at all.
    expect(
      parsePicks([{ draft_slot: 1, metadata: { first_name: "A", last_name: "B" } }]),
    ).toEqual([]);
  });

  it("survives junk entries", () => {
    expect(parsePicks([null, "nope", 42])).toEqual([]);
    expect(parsePicks([])).toEqual([]);
  });

  it("handles a single-name player", () => {
    const picks = parsePicks([
      { pick_no: 5, draft_slot: 3, metadata: { first_name: "", last_name: "Ogunbowale" } },
    ]);
    expect(picks[0].playerName).toBe("Ogunbowale");
  });
});

describe("SleeperDraftProvider", () => {
  const provider = (body: string | Error) =>
    new SleeperDraftProvider(async () => {
      if (body instanceof Error) throw body;
      return body;
    });

  it("reads settings for a live draft", async () => {
    const result = await provider(JSON.stringify(DRAFT)).settings("abc");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.teams).toBe(12);
  });

  it("reports an unknown draft id clearly", async () => {
    // Sleeper answers an unknown id with HTTP 200 and the body `null`, not a 404.
    // Parsing that as an object would surface as a confusing shape error instead.
    const result = await provider("null").settings("nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no draft with that id/);
  });

  it("returns every pick on each poll, so a missed poll cannot skip one", async () => {
    const result = await provider(JSON.stringify(PICKS)).picks("abc");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toHaveLength(2);
  });

  it("fails rather than throwing when Sleeper is unreachable", async () => {
    const result = await provider(new Error("offline")).picks("abc");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Could not reach Sleeper/);
  });

  it("rejects a non-array picks payload instead of coercing it", async () => {
    const result = await provider('{"unexpected":true}').picks("abc");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/unexpected shape/);
  });
});

describe("seats above the league", () => {
  const pick = (draftSlot: number) => ({
    pick_no: 1,
    draft_slot: draftSlot,
    metadata: { first_name: "A", last_name: "B" },
  });

  it("drops a seat past the last one when the league size is known", () => {
    // The mirror of the below-1 rule. A seat of 14 in a twelve-team draft is not a seat,
    // and unbounded it persists and gets treated as one — a pick attributed to a manager
    // who does not exist, from the other end.
    expect(parsePicks([pick(14)], 12)).toEqual([]);
    expect(parsePicks([pick(13)], 12)).toEqual([]);
    expect(parsePicks([pick(12)], 12)).toHaveLength(1);
  });

  it("keeps the lower bound when the league size is not supplied", () => {
    expect(parsePicks([pick(14)])).toHaveLength(1);
    expect(parsePicks([pick(0)])).toEqual([]);
  });
});

/**
 * The boundaries on every count Sleeper publishes.
 *
 * Each of these is a field the board is built from, and each had a boundary that could move
 * by one without anything objecting — a zero-team league accepted, round one nulled, a
 * missing settings object treated as an empty one rather than as missing.
 */
describe("count boundaries", () => {
  const withSettings = (settings: Record<string, unknown>) =>
    parseSettings({ type: "snake", settings });

  it("accepts the smallest real league and rejects anything below it", () => {
    // `teams <= 0` guards the bottom. One step either way and either a zero-team league
    // parses, or a one-team league is refused.
    expect(withSettings({ teams: 1, rounds: 1 })).not.toBeNull();
    expect(withSettings({ teams: 0, rounds: 15 })).toBeNull();
    expect(withSettings({ teams: -2, rounds: 15 })).toBeNull();
    expect(withSettings({ teams: 12, rounds: 0 })).toBeNull();
    expect(withSettings({ teams: 12, rounds: -1 })).toBeNull();
  });

  it("refuses a payload with no settings rather than inventing defaults", () => {
    // `root.settings ?? {}` reads a *missing* settings object as empty, which then fails
    // the count checks. `||` would do the same for a settings object that is legitimately
    // falsy-but-present, and both must end in null rather than in a guessed league.
    expect(parseSettings({ type: "snake" })).toBeNull();
    expect(parseSettings({ type: "snake", settings: null })).toBeNull();
  });

  it("keeps round one, which is the most common round in any draft", () => {
    // `value < 1` is the boundary. `<= 1` nulls round one — every first-round pick, the
    // only round that certainly exists.
    const [first] = parsePicks([
      { pick_no: 1, draft_slot: 1, round: 1, metadata: { first_name: "A", last_name: "B" } },
    ]);
    expect(first.round).toBe(1);
  });

  it("reads a name from either field, and refuses when neither is usable", () => {
    // `first_name` and `last_name` are separate fields upstream; a pick with only one is
    // ordinary, and a pick with neither cannot be attributed to anybody.
    expect(
      parsePicks([{ pick_no: 1, draft_slot: 1, metadata: { last_name: "Ogunbowale" } }])[0]
        .playerName,
    ).toBe("Ogunbowale");
    expect(
      parsePicks([{ pick_no: 1, draft_slot: 1, metadata: { first_name: "Cooper" } }])[0]
        .playerName,
    ).toBe("Cooper");
    expect(
      parsePicks([{ pick_no: 1, draft_slot: 1, metadata: { first_name: 42, last_name: 7 } }]),
    ).toEqual([]);
  });
});

describe("the settings a draft cannot be read without", () => {
  it("refuses each of the four ways teams and rounds can be unusable", () => {
    // `teams === null || rounds === null || teams <= 0 || rounds <= 0`. Four independent
    // reasons joined by `||`; turning any one into `&&` lets that case through, and a
    // draft with zero rounds or an unreadable team count produces a board that looks
    // complete and attributes real players to managers who do not exist.
    const base = { type: "snake", status: "complete", settings: { teams: 12, rounds: 15 } };
    expect(parseSettings({ ...base, settings: { rounds: 15 } })).toBeNull();
    expect(parseSettings({ ...base, settings: { teams: 12 } })).toBeNull();
    expect(parseSettings({ ...base, settings: { teams: 0, rounds: 15 } })).toBeNull();
    expect(parseSettings({ ...base, settings: { teams: 12, rounds: 0 } })).toBeNull();
    expect(parseSettings({ ...base, settings: { teams: -1, rounds: 15 } })).toBeNull();
    expect(parseSettings({ ...base, settings: { teams: 12, rounds: -1 } })).toBeNull();
    // The fixture is only meaningful if the unbroken version is accepted.
    expect(parseSettings(base)).not.toBeNull();
  });

  it("reads a whole number sent as a string, and refuses an empty one", () => {
    // `value.trim() !== ""` guards the string branch. Inverted, a numeric string falls
    // through to `NaN` and every field parses as null — while an *empty* string becomes
    // `Number("")`, which is 0, an integer, and therefore a perfectly acceptable team
    // count of zero.
    expect(parseSettings({
      type: "snake",
      status: "complete",
      settings: { teams: "12", rounds: "15" },
    })).toMatchObject({ teams: 12, rounds: 15 });
    expect(parseSettings({
      type: "snake",
      status: "complete",
      settings: { teams: "", rounds: "15" },
    })).toBeNull();
    expect(parseSettings({
      type: "snake",
      status: "complete",
      settings: { teams: "  ", rounds: "15" },
    })).toBeNull();
  });
});

describe("a league too large to build pick numbers for", () => {
  it("refuses a team or round count that is an allocation rather than a league", () => {
    // `toInt` accepts any integer-valued number, so this is a well-formed payload — and
    // carried through to `snakePicks` and `pickOwnership` it is one array entry per round
    // and one map entry per pick, which is 10^18 of them.
    const base = { type: "snake", status: "complete" };
    expect(parseSettings({ ...base, settings: { teams: 1e9, rounds: 1e9 } })).toBeNull();
    expect(parseSettings({ ...base, settings: { teams: 33, rounds: 15 } })).toBeNull();
    expect(parseSettings({ ...base, settings: { teams: 12, rounds: 41 } })).toBeNull();
    // The largest league the rest of the product accepts still parses.
    expect(parseSettings({ ...base, settings: { teams: 32, rounds: 40 } })).toMatchObject({
      teams: 32,
      rounds: 40,
    });
  });
});
