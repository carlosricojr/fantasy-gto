import { describe, expect, it } from "vitest";

import {
  applyIdentityRepairs,
  auditIdentityCoverage,
  classifyProviderPicks,
  hasUnresolvedIdentityCoverage,
  type PlayerIdentity,
  type ProviderPickIdentity,
} from "./provider-identity";

function player(overrides: Partial<PlayerIdentity> = {}): PlayerIdentity {
  return {
    id: "00-board-a",
    providerId: "sleeper-a",
    name: "Brian Robinson Jr.",
    position: "RB",
    team: "WAS",
    rookie: false,
    ...overrides,
  };
}

function pick(
  overrides: Partial<ProviderPickIdentity> = {},
): ProviderPickIdentity {
  return {
    pickKey: "pick-1",
    providerPlayerId: "sleeper-a",
    name: "Brian Robinson",
    position: "RB",
    team: "WAS",
    ...overrides,
  };
}

describe("classifyProviderPicks", () => {
  it("uses the stable provider id before a conflicting name fallback", () => {
    const results = classifyProviderPicks(
      [pick({ name: "Michael Penix", position: "QB", team: "ATL" })],
      [
        player(),
        player({
          id: "00-penix",
          providerId: "sleeper-penix",
          name: "Michael Penix Jr.",
          position: "QB",
          team: "ATL",
          rookie: true,
        }),
      ],
    );

    expect(results).toMatchObject([
      {
        state: "matched",
        boardPlayerId: "00-board-a",
        matchedBy: "provider-id",
      },
    ]);
  });

  it("uses punctuation and suffix normalization only with matching position and team", () => {
    const results = classifyProviderPicks(
      [
        pick({
          providerPlayerId: null,
          name: "A.J. Brown",
          position: "WR",
          team: "PHI",
        }),
      ],
      [player({ name: "AJ Brown Jr.", position: "WR", team: "PHI" })],
    );

    expect(results).toMatchObject([
      {
        state: "matched",
        boardPlayerId: "00-board-a",
        matchedBy: "name-position-team",
      },
    ]);
  });

  it("matches a defense by normalized team when provider and board names differ", () => {
    const results = classifyProviderPicks(
      [
        pick({
          providerPlayerId: "LAR",
          name: "Los Angeles Rams",
          position: "DEF",
          team: "LAR",
        }),
      ],
      [
        player({
          id: "dst-laramsdefense",
          providerId: null,
          name: "LA Rams Defense",
          position: "DST",
          team: "LA",
        }),
      ],
    );

    expect(results).toMatchObject([
      {
        state: "matched",
        boardPlayerId: "dst-laramsdefense",
        matchedBy: "defense-team",
      },
    ]);
  });

  it("refuses to guess when a board contains duplicate defenses for one team", () => {
    const results = classifyProviderPicks(
      [pick({ providerPlayerId: "DEN", name: "Denver Broncos", position: "DEF", team: "DEN" })],
      [
        player({ id: "dst-den-a", providerId: null, name: "Denver Defense", position: "DST", team: "DEN" }),
        player({ id: "dst-den-b", providerId: null, name: "Denver Broncos Defense", position: "DST", team: "DEN" }),
      ],
    );

    expect(results).toMatchObject([
      {
        state: "ambiguous",
        reason: "defense-team-collision",
        candidates: [
          { boardPlayerId: "dst-den-a" },
          { boardPlayerId: "dst-den-b" },
        ],
      },
    ]);
  });

  it("does not use a stale team as a name fallback, while a provider id survives a team change", () => {
    const board = [player({ team: "SF" })];
    const results = classifyProviderPicks(
      [
        pick({ pickKey: "fallback", providerPlayerId: null, team: "WAS" }),
        pick({ pickKey: "provider", team: "WAS" }),
      ],
      board,
    );

    expect(results).toMatchObject([
      { state: "unmatched", reason: "no-provider-id-or-fallback-match" },
      {
        state: "matched",
        boardPlayerId: "00-board-a",
        matchedBy: "provider-id",
      },
    ]);
  });

  it("reports duplicate normalized candidates as ambiguous with repair details", () => {
    const results = classifyProviderPicks(
      [pick({ providerPlayerId: null })],
      [player(), player({ id: "00-board-b", providerId: "sleeper-b" })],
    );

    expect(results).toEqual([
      expect.objectContaining({
        state: "ambiguous",
        reason: "fallback-collision",
        candidates: [
          expect.objectContaining({ boardPlayerId: "00-board-a" }),
          expect.objectContaining({ boardPlayerId: "00-board-b" }),
        ],
      }),
    ]);
  });

  it("keeps short aliases and unfamiliar names as explicit unmatched picks", () => {
    const input = [
      pick({ pickKey: "short", providerPlayerId: null, name: "CMC" }),
      pick({
        pickKey: "unknown",
        providerPlayerId: null,
        name: "Rookie McRookieface",
      }),
    ];
    const results = classifyProviderPicks(input, [
      player({ name: "Christian McCaffrey", team: "SF" }),
    ]);

    expect(results).toHaveLength(input.length);
    expect(results.map((result) => result.state)).toEqual([
      "unmatched",
      "unmatched",
    ]);
    expect(results.map((result) => result.input.pickKey)).toEqual([
      "short",
      "unknown",
    ]);
  });

  it("names each missing fallback component instead of manufacturing a null key", () => {
    const results = classifyProviderPicks(
      [
        pick({ pickKey: "no-name", providerPlayerId: null, name: "   " }),
        pick({
          pickKey: "no-position",
          providerPlayerId: null,
          position: null,
        }),
        pick({ pickKey: "no-team", providerPlayerId: null, team: null }),
      ],
      [player()],
    );

    expect(results).toEqual([
      expect.objectContaining({
        state: "unmatched",
        reason: "missing-name-position-or-team",
      }),
      expect.objectContaining({
        state: "unmatched",
        reason: "missing-name-position-or-team",
      }),
      expect.objectContaining({
        state: "unmatched",
        reason: "missing-name-position-or-team",
      }),
    ]);
  });

  it("does not use a fallback to conceal a duplicate provider-id mapping", () => {
    const results = classifyProviderPicks(
      [pick()],
      [
        player(),
        player({ id: "00-board-b", name: "Different Person", team: "DAL" }),
      ],
    );

    expect(results).toMatchObject([
      {
        state: "ambiguous",
        reason: "provider-id-collision",
        candidates: expect.arrayContaining([
          expect.objectContaining({ boardPlayerId: "00-board-a" }),
          expect.objectContaining({ boardPlayerId: "00-board-b" }),
        ]),
      },
    ]);
  });

  it("classifies a rookie through the same provider-id path as a veteran", () => {
    const results = classifyProviderPicks(
      [
        pick({
          providerPlayerId: "sleeper-rookie",
          name: "Tetairoa McMillan",
          team: "CAR",
        }),
      ],
      [
        player({
          id: "00-rookie",
          providerId: "sleeper-rookie",
          name: "Tetairoa McMillan",
          position: "WR",
          team: "CAR",
          rookie: true,
        }),
      ],
    );

    expect(results).toMatchObject([
      {
        state: "matched",
        boardPlayerId: "00-rookie",
        matchedBy: "provider-id",
      },
    ]);
  });
});
describe("applyIdentityRepairs", () => {
  it("replays a repair over an unresolved pick without changing the source history", () => {
    const source = pick({
      providerPlayerId: null,
      name: "JSN",
      position: "WR",
      team: "SEA",
    });
    const board = [
      player({
        id: "00-jsn",
        name: "Jaxon Smith-Njigba",
        position: "WR",
        team: "SEA",
      }),
    ];
    const unresolved = classifyProviderPicks([source], board);
    const repaired = applyIdentityRepairs(unresolved, board, [
      { repairId: "repair-1", pickKey: "pick-1", boardPlayerId: "00-jsn" },
    ]);

    expect(unresolved[0]).toMatchObject({ state: "unmatched", input: source });
    expect(repaired.classifications).toMatchObject([
      {
        state: "matched",
        input: source,
        boardPlayerId: "00-jsn",
        matchedBy: "operator-repair",
        repairId: "repair-1",
      },
    ]);
    expect(repaired.rejected).toEqual([]);
  });

  it("refuses duplicate, unknown-target, and matched-pick repairs instead of overwriting", () => {
    const board = [player()];
    const classifications = classifyProviderPicks(
      [
        pick({ pickKey: "matched" }),
        pick({ pickKey: "unmatched", providerPlayerId: null, name: "CMC" }),
        pick({
          pickKey: "bad-target",
          providerPlayerId: null,
          name: "JSN",
          position: "WR",
          team: "SEA",
        }),
      ],
      board,
    );
    const result = applyIdentityRepairs(classifications, board, [
      { repairId: "already", pickKey: "matched", boardPlayerId: "00-board-a" },
      {
        repairId: "bad-target",
        pickKey: "bad-target",
        boardPlayerId: "missing",
      },
      {
        repairId: "duplicate-1",
        pickKey: "unmatched",
        boardPlayerId: "00-board-a",
      },
      {
        repairId: "duplicate-2",
        pickKey: "unmatched",
        boardPlayerId: "00-board-a",
      },
    ]);

    expect(result.classifications).toEqual(classifications);
    expect(result.rejected.map((entry) => entry.reason).sort()).toEqual([
      "board-player-not-found",
      "duplicate-pick-repair",
      "duplicate-pick-repair",
      "pick-not-unresolved",
    ]);
  });

  it("refuses repairs that would assign a board player twice", () => {
    const board = [
      player(),
      player({
        id: "00-jsn",
        providerId: "sleeper-jsn",
        name: "Jaxon Smith-Njigba",
        position: "WR",
        team: "SEA",
      }),
    ];
    const classifications = classifyProviderPicks(
      [
        pick({ pickKey: "matched" }),
        pick({ pickKey: "conflict", providerPlayerId: null, name: "CMC" }),
        pick({ pickKey: "first", providerPlayerId: null, name: "JSN" }),
        pick({ pickKey: "second", providerPlayerId: null, name: "DK" }),
      ],
      board,
    );
    const result = applyIdentityRepairs(classifications, board, [
      {
        repairId: "conflicts-with-match",
        pickKey: "conflict",
        boardPlayerId: "00-board-a",
      },
      {
        repairId: "first-jsn-repair",
        pickKey: "first",
        boardPlayerId: "00-jsn",
      },
      {
        repairId: "second-jsn-repair",
        pickKey: "second",
        boardPlayerId: "00-jsn",
      },
    ]);

    expect(result.classifications).toMatchObject([
      { state: "matched", boardPlayerId: "00-board-a" },
      { state: "unmatched" },
      {
        state: "matched",
        boardPlayerId: "00-jsn",
        matchedBy: "operator-repair",
      },
      { state: "unmatched" },
    ]);
    expect(result.rejected.map((entry) => entry.reason).sort()).toEqual([
      "board-player-already-assigned",
      "board-player-already-assigned",
    ]);
  });
});

describe("auditIdentityCoverage", () => {
  it("counts both universes and rookies, and cannot call unresolved coverage clean", () => {
    const board = [
      player(),
      player({
        id: "00-rookie",
        providerId: "sleeper-rookie",
        name: "Rookie Receiver",
        position: "WR",
        team: "CAR",
        rookie: true,
      }),
    ];
    const provider = [
      player({ id: "sleeper-a", providerId: "sleeper-a", rookie: false }),
      player({
        id: "sleeper-extra",
        providerId: null,
        name: "Unknown Rookie",
        position: "WR",
        team: "CAR",
        rookie: true,
      }),
    ];
    const audit = auditIdentityCoverage(board, provider);

    expect(audit.board).toMatchObject({
      total: 2,
      matched: 1,
      unmatched: 1,
      ambiguous: 0,
    });
    expect(audit.provider).toMatchObject({
      total: 2,
      matched: 1,
      unmatched: 1,
      ambiguous: 0,
    });
    expect(audit.boardRookies).toMatchObject({ total: 1, unmatched: 1 });
    expect(audit.providerRookies).toMatchObject({ total: 1, unmatched: 1 });
    expect(hasUnresolvedIdentityCoverage(audit)).toBe(true);
  });

  it("reports clean coverage as clean and a one-sided gap as unresolved", () => {
    const cleanBoard = [player()];
    const cleanProvider = [
      player({ id: "sleeper-a", providerId: "sleeper-a" }),
    ];
    expect(
      hasUnresolvedIdentityCoverage(
        auditIdentityCoverage(cleanBoard, cleanProvider),
      ),
    ).toBe(false);

    const oneSidedGap = auditIdentityCoverage(
      [
        ...cleanBoard,
        player({ id: "board-only", providerId: null, name: "Board Only" }),
      ],
      cleanProvider,
    );
    expect(oneSidedGap.board).toMatchObject({ matched: 1, unmatched: 1 });
    expect(oneSidedGap.provider).toMatchObject({ matched: 1, unmatched: 0 });
    expect(hasUnresolvedIdentityCoverage(oneSidedGap)).toBe(true);

    const providerOnlyGap = auditIdentityCoverage(cleanBoard, [
      ...cleanProvider,
      player({ id: "sleeper-only", providerId: null, name: "Sleeper Only" }),
    ]);
    expect(providerOnlyGap.board).toMatchObject({ matched: 1, unmatched: 0 });
    expect(providerOnlyGap.provider).toMatchObject({
      matched: 1,
      unmatched: 1,
    });
    expect(hasUnresolvedIdentityCoverage(providerOnlyGap)).toBe(true);
  });
});
