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

  it("normalises position and team casing", () => {
    const picks = parsePicks(PICKS);
    expect(picks[0].position).toBe("RB");
    expect(picks[0].team).toBe("DET");
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
