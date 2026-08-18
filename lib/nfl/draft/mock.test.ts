import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ChampionshipRecommendation } from "../../core/draft-policy";
import type { PlayerRisk } from "../../core/roster-utility";
import { type LeagueConfig, fantasySeasonWeeks } from "../../core/season-sim";
import { slotsForTemplate } from "../roster";
import { teamIndexForSeat } from "../../core/draft";
import { teamByeWeeks } from "../byes";
import { parseCsv } from "../csv";
import { parseContests } from "../../sources/nflverse";
import {
  CHECK_DEFINITIONS,
  EARLY_ROUNDS,
  MIN_WIDE_RECEIVERS,
  type MockBoardRow,
  type MockDraftReplay,
  type MockDraftSetup,
  type MockPick,
  applyTeamByes,
  evaluateChecks,
  expectationFor,
  fixtureLeagueMismatch,
  parseBoardFixture,
  pickLabelFor,
  replayAdpMockDraft,
  stateAtPick,
  toPlayerRisk,
  unexpectedOutcomes,
} from "./mock";

const FIXTURE_PATH = join(
  __dirname,
  "../../../tests/fixtures/draft_board_2026_half_ppr_10team.json",
);

const SCHEDULE_FIXTURE_PATH = join(__dirname, "../../../tests/fixtures/games_2026.csv");

function row(
  playerId: string,
  position: string,
  blendedPoints: number,
  adp: number | null,
  overrides: Partial<MockBoardRow> = {},
): MockBoardRow {
  return {
    playerId,
    name: `Player ${playerId}`,
    position,
    team: "T",
    modelPoints: blendedPoints,
    marketPoints: adp === null ? null : blendedPoints,
    blendedPoints,
    adp,
    adpStdev: adp === null ? null : 6,
    byeWeek: 7,
    availability: 0.9,
    p10: 0.269,
    p90: 1.901,
    quantileProvenance: "measured",
    ...overrides,
  };
}

/** A board the engine can draft a small league from: sorted, mostly market-ranked. */
function syntheticBoard(): MockBoardRow[] {
  const spec: Array<[string, number, number]> = [
    ["QB", 12, 300],
    ["RB", 22, 290],
    ["WR", 22, 280],
    ["TE", 12, 220],
    ["K", 6, 130],
    ["DST", 6, 125],
  ];
  const rows: MockBoardRow[] = [];
  let nextAdp = 1;
  for (const [position, count, top] of spec) {
    for (let i = 0; i < count; i += 1) {
      // The last two rows of each position are unranked, like the real board's no-ADP tail.
      const ranked = i < count - 2;
      rows.push(
        row(`${position}${i}`, position, top - i * 6, ranked ? (nextAdp += 2) : null, {
          adpStdev: ranked ? 5 : null,
          byeWeek: 5 + ((i + position.length) % 8),
        }),
      );
    }
  }
  // An ADP of zero: the market's very first pick, not a missing rank. Falsy-zero
  // collapse has shipped in this codebase before, and this row is what makes the
  // strict-ADP assertion notice it.
  rows.push(row("zeroAdp", "WR", 275, 0, { byeWeek: 9 }));
  // An exact ADP tie, broken by board rank: the pool's sort and the replay must both
  // take the higher-ranked row first.
  rows.push(row("tieHigh", "RB", 200, 50.5));
  rows.push(row("tieLow", "RB", 195, 50.5));
  rows.sort(
    (a, b) => b.blendedPoints - a.blendedPoints || (a.playerId < b.playerId ? -1 : 1),
  );
  return rows;
}

function smallSetup(): MockDraftSetup {
  const config: LeagueConfig = {
    slots: slotsForTemplate("two_flex"),
    ...fantasySeasonWeeks(17, 4),
    playoffTeams: 4,
    scenarios: 40,
    meanAbsenceWeeks: 3,
  };
  return { teams: 4, slot: 2, rounds: 12, config, seed: 7, candidateLimit: 4 };
}

/** A pick log entry for the check tests, which never run the engine. */
function pick(
  overall: number,
  teams: number,
  slot: number,
  playerId: string,
  recommendations: ChampionshipRecommendation[] | null = null,
): MockPick {
  const round = Math.ceil(overall / teams);
  const inRound = overall - (round - 1) * teams;
  const seat = round % 2 === 1 ? inRound : teams + 1 - inRound;
  const mine = seat === slot;
  return {
    overall,
    round,
    label: pickLabelFor(overall, teams),
    // Honest even though no check reads them today: a future check that does must not
    // be tested against fabricated seats.
    teamIndex: teamIndexForSeat(seat, slot),
    seat,
    mine,
    playerId,
    recommendations: mine ? recommendations : null,
  };
}

function recommendation(
  player: PlayerRisk,
  championshipProbability: number,
): ChampionshipRecommendation {
  return {
    player,
    championshipProbability,
    deltaVsBaseline: 0,
    playoffProbability: 0.5,
    expectedPoints: 1200,
    standardError: 0.014,
    vsLeader: null,
    tiedWithLeader: false,
  };
}

/** A replay whose own picks are `mine`, opponents filled with distinct board rows. */
function replayFromOwnPicks(
  board: MockBoardRow[],
  mine: Array<{ round: number; playerId: string; recommendations?: ChampionshipRecommendation[] }>,
  teams = 10,
  rounds = 16,
): { replay: MockDraftReplay; board: MockBoardRow[] } {
  const slot = 5;
  const config: LeagueConfig = {
    slots: slotsForTemplate("two_flex"),
    ...fantasySeasonWeeks(17, 6),
    playoffTeams: 6,
    scenarios: 600,
    meanAbsenceWeeks: 3,
  };
  const byRound = new Map(mine.map((entry) => [entry.round, entry]));
  const picks: MockPick[] = [];
  const used = new Set(mine.map((entry) => entry.playerId));
  let filler = 0;
  for (let overall = 1; overall <= teams * rounds; overall += 1) {
    const round = Math.ceil(overall / teams);
    const inRound = overall - (round - 1) * teams;
    const seatOnClock = round % 2 === 1 ? inRound : teams + 1 - inRound;
    if (seatOnClock === slot) {
      const entry = byRound.get(round);
      if (entry === undefined) throw new Error(`no own pick defined for round ${round}`);
      picks.push(pick(overall, teams, slot, entry.playerId, entry.recommendations ?? null));
    } else {
      // Opponents absorb the rest of the board; add filler rows as needed so every pick
      // names a real board row.
      let id: string;
      do {
        id = `opp${filler}`;
        filler += 1;
      } while (used.has(id));
      board.push(row(id, "WR", 1, null, { blendedPoints: 0.5 }));
      picks.push(pick(overall, teams, slot, id));
    }
  }
  const replay: MockDraftReplay = {
    setup: { teams, slot, rounds, config, seed: 20260731, candidateLimit: 10 },
    picks,
  };
  return { replay, board };
}

function outcome(replay: MockDraftReplay, board: readonly MockBoardRow[], id: string) {
  const found = evaluateChecks(replay, board).find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no check ${id}`);
  return found;
}

describe("toPlayerRisk", () => {
  it("converts a board row exactly as the draft page does", () => {
    const converted = toPlayerRisk(
      row("x1", "RB", 170, 12.5, { availability: 0.85, byeWeek: 9 }),
    );
    // Points per game played: season total over seventeen games at 85% availability.
    expect(converted.weeklyMean).toBeCloseTo(170 / (17 * 0.85), 10);
    expect(converted).toMatchObject({
      id: "x1",
      position: "RB",
      byeWeek: 9,
      availability: 0.85,
      adp: 12.5,
      adpStdev: 6,
      p10: 0.269,
      p90: 1.901,
    });
  });
});

describe("parseBoardFixture", () => {
  it("accepts the frozen production board and preserves its facts", () => {
    const fixture = parseBoardFixture(JSON.parse(readFileSync(FIXTURE_PATH, "utf8")));
    expect(fixture.season).toBe(2026);
    expect(fixture.scoringId).toBe("half_ppr");
    expect(fixture.teams).toBe(10);
    // The fixture's identity, not just its label: this is the board run #88 audited, and
    // a silently regenerated or truncated fixture must not keep wearing its provenance.
    expect(fixture.computedAt).toBe(1786964483127);
    expect(fixture.rows.length).toBe(622);
    // The facts the known-fail checks hinge on: the audit's round-2 pick is on this board
    // with no market rank and no bye — the exact combination #88 and #89.D describe.
    const gainwell = fixture.rows.find((entry) => entry.name === "Kenneth Gainwell");
    expect(gainwell).toMatchObject({ position: "RB", adp: null, byeWeek: null });
  });

  it("rejects a row missing a field instead of producing numbers", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
      rows: Array<Record<string, unknown>>;
    };
    delete fixture.rows[3].blendedPoints;
    // The #37 failure mode: an untyped harness fed a wrong-shaped fixture and every score
    // silently became zero. #64 requires this to be an error, not an output.
    expect(() => parseBoardFixture(fixture)).toThrow(/blendedPoints/);
  });

  it("rejects rows out of board order, because row index is overall rank", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
      rows: Array<Record<string, unknown>>;
    };
    const [first] = fixture.rows.splice(0, 1);
    fixture.rows.push(first);
    expect(() => parseBoardFixture(fixture)).toThrow(/board order/);
  });

  it("rejects a duplicated player", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
      rows: Array<Record<string, unknown>>;
    };
    fixture.rows[1] = { ...fixture.rows[0] };
    expect(() => parseBoardFixture(fixture)).toThrow(/order|duplicate/);
  });

  it("rejects a value tie sorted against the id order", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
      rows: Array<Record<string, unknown>>;
    };
    const [a, b] = fixture.rows;
    // Equal blended value with ids descending: not a duplicate, but not board order
    // either — the tie-break is part of the ordering contract.
    fixture.rows = [
      { ...a, playerId: "zz-tie", blendedPoints: 100 },
      { ...b, playerId: "aa-tie", blendedPoints: 100 },
    ];
    expect(() => parseBoardFixture(fixture)).toThrow(/board order/);
  });

  it("accepts a one-row fixture: the guard rejects emptiness, not smallness", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
      rows: Array<Record<string, unknown>>;
    };
    fixture.rows = [fixture.rows[0]];
    expect(parseBoardFixture(fixture).rows.length).toBe(1);
  });

  it("rejects non-finite numbers, empty strings, and wrong containers", () => {
    const base = () =>
      JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
        rows: Array<Record<string, unknown>>;
      };
    // JSON.parse can never produce these, but this parser's callers are not all JSON —
    // a hand-built fixture with an Infinity or a NaN must fail the same way #37's did not.
    const infinite = base();
    infinite.rows[0].blendedPoints = Number.POSITIVE_INFINITY;
    expect(() => parseBoardFixture(infinite)).toThrow(/blendedPoints/);
    const nan = base();
    nan.rows[0].adp = Number.NaN;
    expect(() => parseBoardFixture(nan)).toThrow(/adp/);
    const unnamed = base();
    unnamed.rows[0].name = "";
    expect(() => parseBoardFixture(unnamed)).toThrow(/name/);
    const listName = base();
    listName.rows[0].name = ["Bad"];
    expect(() => parseBoardFixture(listName)).toThrow(/name/);
    expect(() => parseBoardFixture(null)).toThrow(/fixture must be an object/);
    const missing = base() as Record<string, unknown>;
    delete missing.rows;
    expect(() => parseBoardFixture(missing)).toThrow(/rows must be a non-empty array/);
    const empty = base();
    empty.rows = [];
    expect(() => parseBoardFixture(empty)).toThrow(/rows must be a non-empty array/);
    const nullRow = base();
    nullRow.rows[0] = null as unknown as Record<string, unknown>;
    expect(() => parseBoardFixture(nullRow)).toThrow(/rows\[0\] must be an object/);
  });

  it("rejects finite numbers outside their domain", () => {
    const base = () =>
      JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
        rows: Array<Record<string, unknown>>;
      };
    // A misspelt position fills no roster slot and silently distorts every figure — the
    // #37 failure class one level up from shape.
    const position = base();
    position.rows[0].position = "RB ";
    expect(() => parseBoardFixture(position)).toThrow(/position/);
    const available = base();
    available.rows[0].availability = 1.2;
    expect(() => parseBoardFixture(available)).toThrow(/availability/);
    const never = base();
    never.rows[0].availability = 0;
    expect(() => parseBoardFixture(never)).toThrow(/availability/);
    const inverted = base();
    inverted.rows[0].p10 = 2;
    inverted.rows[0].p90 = 1;
    expect(() => parseBoardFixture(inverted)).toThrow(/p10/);
    const freeAgent = base();
    freeAgent.rows[0].adp = 0;
    expect(() => parseBoardFixture(freeAgent)).toThrow(/adp/);
    const bye = base();
    bye.rows[0].byeWeek = 99;
    expect(() => parseBoardFixture(bye)).toThrow(/byeWeek/);
  });

  it("keeps the domain gates on their boundaries", () => {
    const base = () =>
      JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
        rows: Array<Record<string, unknown>>;
      };
    // Legal edges parse: a zero-width quantile band, a market's very first fraction of a
    // pick, week-1 and week-18 byes, a fully available player.
    const edges = base();
    edges.rows[0].p10 = 1;
    edges.rows[0].p90 = 1;
    edges.rows[0].adp = 0.5;
    edges.rows[0].byeWeek = 1;
    edges.rows[0].availability = 1;
    edges.rows[1].byeWeek = 18;
    expect(parseBoardFixture(edges).rows[0].adp).toBe(0.5);
    // Illegal edges fail: week 0, week 19, and a fractional week.
    const weekZero = base();
    weekZero.rows[0].byeWeek = 0;
    expect(() => parseBoardFixture(weekZero)).toThrow(/byeWeek/);
    const weekNineteen = base();
    weekNineteen.rows[0].byeWeek = 19;
    expect(() => parseBoardFixture(weekNineteen)).toThrow(/byeWeek/);
    const halfWeek = base();
    halfWeek.rows[0].byeWeek = 5.5;
    expect(() => parseBoardFixture(halfWeek)).toThrow(/byeWeek/);
  });
});

describe("fixtureLeagueMismatch", () => {
  const fixture = parseBoardFixture(JSON.parse(readFileSync(FIXTURE_PATH, "utf8")));

  it("accepts the league the fixture was frozen for", () => {
    expect(
      fixtureLeagueMismatch(fixture, { season: 2026, scoringId: "half_ppr", teams: 10 }),
    ).toBeNull();
  });

  it("refuses to mislabel another board's results, naming both leagues", () => {
    const message = fixtureLeagueMismatch(fixture, {
      season: 2026,
      scoringId: "ppr",
      teams: 12,
    });
    expect(message).toContain("fixture is for season 2026, half_ppr, 10 teams");
    expect(message).toContain("2026 ppr 12-team audit");
  });

  it("refuses on any single differing field, however many agree", () => {
    // One wrong field with the other two right, each way — a match must be all three.
    expect(
      fixtureLeagueMismatch(fixture, { season: 2025, scoringId: "half_ppr", teams: 10 }),
    ).not.toBeNull();
    expect(
      fixtureLeagueMismatch(fixture, { season: 2026, scoringId: "ppr", teams: 10 }),
    ).not.toBeNull();
    expect(
      fixtureLeagueMismatch(fixture, { season: 2026, scoringId: "half_ppr", teams: 12 }),
    ).not.toBeNull();
  });
});

describe("applyTeamByes", () => {
  const byes = new Map([
    ["TB", 10],
    ["SEA", 11],
  ]);

  it("fills a teamed row's null bye and leaves everything else of it alone", () => {
    const before = row("g1", "RB", 180, null, { team: "TB", byeWeek: null });
    const [after] = applyTeamByes([before], byes);
    expect(after.byeWeek).toBe(10);
    expect({ ...after, byeWeek: null }).toEqual(before);
    // The input is data, not a workspace: the frozen fixture's rows pass through here.
    expect(before.byeWeek).toBeNull();
  });

  it("resolves a disagreeing bye to the schedule's, as ingest now does", () => {
    const [after] = applyTeamByes([row("g1", "RB", 180, 12, { team: "TB", byeWeek: 6 })], byes);
    expect(after.byeWeek).toBe(10);
  });

  it("touches neither a teamless row nor a team the schedule cannot answer for", () => {
    const teamless = row("f1", "RB", 100, null, { team: null, byeWeek: null });
    const unanswered = row("f2", "WR", 90, 40, { team: "NYG", byeWeek: 11 });
    expect(applyTeamByes([teamless, unanswered], byes)).toEqual([teamless, unanswered]);
  });
});

describe("the frozen 2026 schedule fixture", () => {
  const scheduleByes = teamByeWeeks(
    parseContests(parseCsv(readFileSync(SCHEDULE_FIXTURE_PATH, "utf8"))),
    2026,
  );

  it("derives one bye for each of the 32 teams", () => {
    // The fixture's identity, like the board's `computedAt`: 272 regular-season games,
    // verified against the live release on 2026-08-17, every team idle exactly once. A
    // truncated or edited fixture derives fewer teams and `--schedule-byes` would
    // quietly measure a partial fix.
    expect(scheduleByes.size).toBe(32);
    expect(scheduleByes.get("TB")).toBe(10);
    expect(scheduleByes.get("SEA")).toBe(11);
    expect(scheduleByes.get("DET")).toBe(6);
  });

  it("answers for every teamed row of the frozen board, and agrees with every market bye", () => {
    // The measured shape of the `--schedule-byes` mode, pinned: 388 teamed rows fill from
    // null, 21 teamless rows stay null, and not one of the 213 market-published byes
    // disagrees with the schedule — so on this board the derivation only ever fills.
    const fixture = parseBoardFixture(JSON.parse(readFileSync(FIXTURE_PATH, "utf8")));
    let filled = 0;
    let agreeing = 0;
    for (const entry of fixture.rows) {
      if (entry.team === null) continue;
      const scheduleBye = scheduleByes.get(entry.team);
      expect(scheduleBye).toBeDefined();
      if (entry.byeWeek === null) filled += 1;
      else {
        expect(entry.byeWeek).toBe(scheduleBye);
        agreeing += 1;
      }
    }
    expect(filled).toBe(388);
    expect(agreeing).toBe(213);
    expect(fixture.rows.filter((entry) => entry.team === null)).toHaveLength(21);

    // Post-application residue: the 15 teamless rows with no market bye either — the
    // population the simulation's assumed-week charge exists for. (The other 6 teamless
    // rows carry a market-published bye and keep it.)
    const applied = applyTeamByes(fixture.rows, scheduleByes);
    expect(applied.filter((entry) => entry.byeWeek === null)).toHaveLength(15);
    expect(
      applied.filter((entry, i) => entry.byeWeek !== fixture.rows[i].byeWeek),
    ).toHaveLength(388);
  });
});

describe("unexpectedOutcomes", () => {
  it("rings only for a status that disagrees with its documented expectation", () => {
    const outcomes = CHECK_DEFINITIONS.map((definition) => ({
      ...definition,
      status: definition.expected,
      violations: [],
    }));
    expect(unexpectedOutcomes(outcomes)).toEqual([]);

    // Flip one check each way: an unexpected pass and an unexpected failure both ring.
    // The flipped checks are picked by their documented expectation rather than by id,
    // so this test survives a fix PR flipping a particular check's column. Asserted
    // before use so the protocol's end state — every check expected to pass — fails
    // this test with an instruction to construct a synthetic definition, not with a
    // TypeError.
    const knownFail = CHECK_DEFINITIONS.find((d) => d.expected === "fail");
    const knownPass = CHECK_DEFINITIONS.find((d) => d.expected === "pass");
    expect(knownFail, "no expected-fail check left; flip one synthetically here").toBeDefined();
    expect(knownPass, "no expected-pass check left; flip one synthetically here").toBeDefined();
    if (knownFail === undefined || knownPass === undefined) return;
    const surprisePass = outcomes.map((outcome) =>
      outcome.id === knownFail.id ? { ...outcome, status: "pass" as const } : outcome,
    );
    expect(unexpectedOutcomes(surprisePass).map((outcome) => outcome.id)).toEqual([
      knownFail.id,
    ]);
    const regression = outcomes.map((outcome) =>
      outcome.id === knownPass.id ? { ...outcome, status: "fail" as const } : outcome,
    );
    expect(unexpectedOutcomes(regression).map((outcome) => outcome.id)).toEqual([
      knownPass.id,
    ]);
  });

  it("enforces the expectation column of the mode it is given", () => {
    // Constructed rather than read off CHECK_DEFINITIONS, so this holds whatever the
    // measured expectations currently are: one outcome whose two columns disagree must
    // ring in exactly one mode.
    const split = {
      ...CHECK_DEFINITIONS[0],
      expected: "fail" as const,
      expectedWithScheduleByes: "pass" as const,
      status: "fail" as const,
      violations: ["measured"],
    };
    expect(expectationFor(split, "frozen")).toBe("fail");
    expect(expectationFor(split, "schedule-byes")).toBe("pass");
    expect(unexpectedOutcomes([split], "frozen")).toEqual([]);
    expect(unexpectedOutcomes([split], "schedule-byes").map((o) => o.id)).toEqual([
      split.id,
    ]);
    // And the one-argument form is the frozen mode, because that is the default replay.
    expect(unexpectedOutcomes([split])).toEqual([]);
  });
});

describe("replayAdpMockDraft", () => {
  const board = syntheticBoard();
  const setup = smallSetup();
  const replay = replayAdpMockDraft(board, setup);
  const totalPicks = setup.teams * setup.rounds;

  it("plays every pick exactly once", () => {
    expect(replay.picks.length).toBe(totalPicks);
    expect(new Set(replay.picks.map((entry) => entry.playerId)).size).toBe(totalPicks);
    expect(replay.picks.map((entry) => entry.overall)).toEqual(
      Array.from({ length: totalPicks }, (_, i) => i + 1),
    );
  });

  it("gives our seat its snake picks and nobody else's", () => {
    const ours = replay.picks.filter((entry) => entry.mine);
    expect(ours.length).toBe(setup.rounds);
    expect(ours.map((entry) => entry.overall)).toEqual(
      Array.from({ length: setup.rounds }, (_, round) =>
        round % 2 === 0
          ? round * setup.teams + setup.slot
          : (round + 1) * setup.teams + 1 - setup.slot,
      ),
    );
  });

  it("has every opponent take the lowest ADP still available, ties to board rank", () => {
    const taken = new Set<string>();
    for (const entry of replay.picks) {
      if (!entry.mine) {
        // First-lowest in board order: a tie goes to the better rank, and an ADP of
        // zero beats every other number — the identity comparison is what notices both.
        const best = board
          .filter((candidate) => !taken.has(candidate.playerId))
          .reduce((held, candidate) => {
            const heldAdp = held.adp ?? Number.POSITIVE_INFINITY;
            const candidateAdp = candidate.adp ?? Number.POSITIVE_INFINITY;
            return candidateAdp < heldAdp ? candidate : held;
          });
        expect(entry.playerId).toBe(best.playerId);
      }
      taken.add(entry.playerId);
    }
  });

  it("completes a draft that consumes the whole board", () => {
    const exactSpec: Array<[string, number, number]> = [
      ["QB", 4, 300],
      ["RB", 6, 290],
      ["WR", 6, 280],
      ["TE", 4, 220],
      ["K", 2, 130],
      ["DST", 2, 125],
    ];
    const exact: MockBoardRow[] = [];
    let adp = 0;
    for (const [position, count, top] of exactSpec) {
      for (let i = 0; i < count; i += 1) {
        exact.push(row(`${position}${i}`, position, top - i * 6, (adp += 3)));
      }
    }
    exact.sort(
      (a, b) => b.blendedPoints - a.blendedPoints || (a.playerId < b.playerId ? -1 : 1),
    );
    const config: LeagueConfig = {
      slots: slotsForTemplate("two_flex"),
      ...fantasySeasonWeeks(17, 2),
      playoffTeams: 2,
      scenarios: 16,
      meanAbsenceWeeks: 3,
    };
    // 24 players, 24 picks, drafting from the last seat: a board exactly the draft's
    // size is legal, and so is `slot === teams`.
    const drained = replayAdpMockDraft(exact, {
      teams: 2,
      slot: 2,
      rounds: 12,
      config,
      seed: 3,
      candidateLimit: 2,
    });
    expect(new Set(drained.picks.map((entry) => entry.playerId)).size).toBe(24);
  });

  it("takes the panel's displayed leader on every one of our turns", () => {
    for (const entry of replay.picks) {
      if (!entry.mine) {
        expect(entry.recommendations).toBeNull();
        continue;
      }
      expect(entry.recommendations).not.toBeNull();
      expect(entry.recommendations?.[0]?.player.id).toBe(entry.playerId);
    }
  });

  it("replays identically from the same inputs", () => {
    const again = replayAdpMockDraft(board, setup);
    expect(again.picks.map((entry) => entry.playerId)).toEqual(
      replay.picks.map((entry) => entry.playerId),
    );
  });

  it("refuses a board too small for the draft", () => {
    expect(() => replayAdpMockDraft(board.slice(0, 10), setup)).toThrow(/needs/);
  });

  it("refuses a seat outside the league", () => {
    // The exact guard messages, not a keyword: `pickOwnership` downstream throws its own
    // "A league cannot have …" errors, and a loose /slot/ or /teams/ match cannot tell
    // this module's guard from the one it is standing in front of.
    expect(() => replayAdpMockDraft(board, { ...setup, slot: 5 })).toThrow(
      /slot must be within 1\.\.4/,
    );
  });

  it("refuses fractional or degenerate league dimensions", () => {
    expect(() => replayAdpMockDraft(board, { ...setup, teams: 2.5 })).toThrow(
      /teams must be at least 2/,
    );
    expect(() => replayAdpMockDraft(board, { ...setup, slot: 0 })).toThrow(
      /slot must be within 1\.\.4/,
    );
    expect(() => replayAdpMockDraft(board, { ...setup, slot: 1.5 })).toThrow(
      /slot must be within 1\.\.4/,
    );
    expect(() => replayAdpMockDraft(board, { ...setup, rounds: 0 })).toThrow(
      /rounds must be positive/,
    );
    expect(() => replayAdpMockDraft(board, { ...setup, rounds: 1.5 })).toThrow(
      /rounds must be positive/,
    );
  });

  it("plays a single-round draft from the first seat: both boundaries are legal", () => {
    const config: LeagueConfig = {
      slots: slotsForTemplate("two_flex"),
      ...fantasySeasonWeeks(17, 2),
      playoffTeams: 2,
      scenarios: 8,
      meanAbsenceWeeks: 3,
    };
    const tiny = replayAdpMockDraft(board, {
      teams: 2,
      slot: 1,
      rounds: 1,
      config,
      seed: 3,
      candidateLimit: 1,
    });
    expect(tiny.picks.length).toBe(2);
    expect(tiny.picks[0].mine).toBe(true);
    expect(tiny.picks[1].mine).toBe(false);
  });
});

describe("stateAtPick", () => {
  const board = syntheticBoard();
  const league = { teams: 4, slot: 2, rounds: 12 };
  const [first, second] = board.filter((entry) => entry.adp !== null);

  it("builds the page's state: we are team 0, and the current pick is still ours", () => {
    // Picks 1 and 2 recorded; seat 2's second-round pick (overall 7) is on the clock.
    const state = stateAtPick(
      board,
      [
        { overall: 1, playerId: first.playerId },
        { overall: 2, playerId: second.playerId },
      ],
      league,
      7,
    );
    expect(state.myTeamIndex).toBe(0);
    expect(state.rosterSize).toBe(12);
    expect(state.teams.map((team) => team.name)).toEqual([
      "You",
      "Seat 1",
      "Seat 3",
      "Seat 4",
    ]);
    // Overall pick 2 belongs to seat 2 — us, team 0. Pick 1 belongs to seat 1.
    expect(state.teams[0].roster.map((player) => player.id)).toEqual([second.playerId]);
    expect(state.teams[1].roster.map((player) => player.id)).toEqual([first.playerId]);
    // The pick on the clock is *included*: its first entry is the pick being made.
    expect(state.teams[0].remainingPicks[0]).toBe(7);
    expect(state.available.map((player) => player.id)).not.toContain(first.playerId);
    expect(state.available.map((player) => player.id)).not.toContain(second.playerId);
    expect(state.available.length).toBe(board.length - 2);
  });

  it("keeps our own on-the-clock pick in our remaining picks at the boundary", () => {
    const state = stateAtPick(board, [{ overall: 1, playerId: first.playerId }], league, 2);
    // Seat 2 owns overall pick 2 and is about to make it. Filtering it out here is the
    // page-parity bug this function exists to make assertable.
    expect(state.teams[0].remainingPicks[0]).toBe(2);
  });

  it("ignores a recorded pick it cannot place, as the page does", () => {
    const state = stateAtPick(
      board,
      [
        { overall: 999, playerId: first.playerId },
        { overall: 1, playerId: "nobody" },
      ],
      league,
      1,
    );
    expect(state.teams.every((team) => team.roster.length === 0)).toBe(true);
    expect(state.available.length).toBe(board.length);
  });
});

describe("evaluateChecks", () => {
  it("documents six checks with the expectations both replay modes measured", () => {
    expect(CHECK_DEFINITIONS.map((entry) => entry.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
    // Both modes, as measured after PR 2: (a) flipped to pass by the assumed-bye
    // charge, (c) measured passing with its near-miss on record in the definition, and
    // the four structural findings — streamable positions, market-round distance, WR
    // count, leader inversion — remain known failures for PRs 4 and 5.
    expect(
      CHECK_DEFINITIONS.map((entry) => `${entry.id}:${entry.expected}`),
    ).toEqual(["a:pass", "b:fail", "c:pass", "d:fail", "e:fail", "f:fail"]);
    expect(
      CHECK_DEFINITIONS.map((entry) => `${entry.id}:${entry.expectedWithScheduleByes}`),
    ).toEqual(["a:pass", "b:fail", "c:pass", "d:fail", "e:fail", "f:fail"]);
  });

  it("states the protocol numbers in the titles it displays", () => {
    // Written as literals on purpose: the boundary tests import the constants, so a
    // drifted constant would drift those tests with it. The titles are the scoreboard's
    // public contract, and these strings are where the numbers are pinned.
    const titles = new Map(CHECK_DEFINITIONS.map((entry) => [entry.id, entry.title]));
    expect(titles.get("a")).toBe(
      "no player absent from the market's list leads a pick in rounds 1-6",
    );
    expect(titles.get("b")).toBe("at most one K and one D/ST before the final 2 rounds");
    expect(titles.get("d")).toBe(
      "first K and first D/ST no more than 2 rounds before their market round",
    );
    expect(titles.get("e")).toBe("at least 4 wide receivers on the final roster");
  });

  it("(a) flags a market-absent leader inside the early rounds and not after", () => {
    const noAdp = row("ghost", "RB", 200, null);
    const leader = recommendation(toPlayerRisk(noAdp), 0.145);
    const inside = replayFromOwnPicks(
      [noAdp, ...Array.from({ length: 15 }, (_, i) => row(`m${i}`, "WR", 150 - i, i + 1))],
      Array.from({ length: 16 }, (_, i) => ({
        round: i + 1,
        playerId: i === 1 ? "ghost" : `m${i - (i > 1 ? 1 : 0)}`,
        recommendations: i === 1 ? [leader] : undefined,
      })),
    );
    const flagged = outcome(inside.replay, inside.board, "a");
    expect(flagged.status).toBe("fail");
    expect(flagged.violations).toEqual([
      expect.stringContaining("2.06 leader Player ghost (RB, T) has no market rank"),
    ]);

    // Round six is the last early round: a market-absent leader there is still flagged.
    const boundary = replayFromOwnPicks(
      [noAdp, ...Array.from({ length: 15 }, (_, i) => row(`m${i}`, "WR", 150 - i, i + 1))],
      Array.from({ length: 16 }, (_, i) => ({
        round: i + 1,
        playerId: i === EARLY_ROUNDS - 1 ? "ghost" : `m${i - (i > EARLY_ROUNDS - 1 ? 1 : 0)}`,
        recommendations: i === EARLY_ROUNDS - 1 ? [leader] : undefined,
      })),
    );
    expect(outcome(boundary.replay, boundary.board, "a").status).toBe("fail");

    // The same leader shown in round 7 is outside the early window.
    const outside = replayFromOwnPicks(
      [noAdp, ...Array.from({ length: 15 }, (_, i) => row(`m${i}`, "WR", 150 - i, i + 1))],
      Array.from({ length: 16 }, (_, i) => ({
        round: i + 1,
        playerId: i === EARLY_ROUNDS ? "ghost" : `m${i - (i > EARLY_ROUNDS ? 1 : 0)}`,
        recommendations: i === EARLY_ROUNDS ? [leader] : undefined,
      })),
    );
    expect(outcome(outside.replay, outside.board, "a").status).toBe("pass");
  });

  it("(a) tolerates an empty panel rather than crashing on it", () => {
    const rows = Array.from({ length: 16 }, (_, i) => row(`m${i}`, "WR", 150 - i, i + 1));
    const empty = replayFromOwnPicks(
      [...rows],
      Array.from({ length: 16 }, (_, i) => ({
        round: i + 1,
        playerId: `m${i}`,
        recommendations: i === 1 ? [] : undefined,
      })),
    );
    expect(outcome(empty.replay, empty.board, "a").status).toBe("pass");
  });

  it("(b) allows a second kicker only in the closing rounds", () => {
    const rows = [
      row("k1", "K", 120, 140),
      row("k2", "K", 118, 141),
      ...Array.from({ length: 14 }, (_, i) => row(`s${i}`, "WR", 150 - i, i + 1)),
    ];
    const early = replayFromOwnPicks(
      [...rows],
      Array.from({ length: 16 }, (_, i) => ({
        round: i + 1,
        playerId: i === 8 ? "k1" : i === 11 ? "k2" : `s${i - (i > 11 ? 2 : i > 8 ? 1 : 0)}`,
      })),
    );
    const flagged = outcome(early.replay, early.board, "b");
    expect(flagged.status).toBe("fail");
    expect(flagged.violations).toEqual([expect.stringContaining("2 K before round 15")]);

    // Round 15 is where the closing window opens: a second kicker there is free.
    const closing = replayFromOwnPicks(
      [...rows],
      Array.from({ length: 16 }, (_, i) => ({
        round: i + 1,
        playerId: i === 8 ? "k1" : i === 14 ? "k2" : `s${i - (i > 14 ? 2 : i > 8 ? 1 : 0)}`,
      })),
    );
    expect(outcome(closing.replay, closing.board, "b").status).toBe("pass");
  });

  it("(c) flags consecutive same-position turns only when the second outranks the first", () => {
    const worse = row("qbWorse", "QB", 250, 100);
    const better = row("qbBetter", "QB", 260, 110);
    const fillers = Array.from({ length: 14 }, (_, i) => row(`f${i}`, "WR", 150 - i, i + 1));
    const churn = replayFromOwnPicks(
      [better, worse, ...fillers],
      Array.from({ length: 16 }, (_, i) => ({
        round: i + 1,
        playerId:
          i === 9 ? "qbWorse" : i === 10 ? "qbBetter" : `f${i - (i > 10 ? 2 : i > 9 ? 1 : 0)}`,
      })),
    );
    const flagged = outcome(churn.replay, churn.board, "c");
    expect(flagged.status).toBe("fail");
    // The board ranks and pick labels in the message are the evidence: #2 bought at
    // 10.06, then #1 at 11.05 — both halves are asserted so neither can silently swap.
    expect(flagged.violations).toEqual([
      "QB Player qbWorse at 10.06 (board #2) then Player qbBetter at 11.05 (board #1) — " +
        "the second pick benches the first",
    ]);

    // The same two picks in value order upgrade nothing and are allowed.
    const ordered = replayFromOwnPicks(
      [better, worse, ...fillers],
      Array.from({ length: 16 }, (_, i) => ({
        round: i + 1,
        playerId:
          i === 9 ? "qbBetter" : i === 10 ? "qbWorse" : `f${i - (i > 10 ? 2 : i > 9 ? 1 : 0)}`,
      })),
    );
    expect(outcome(ordered.replay, ordered.board, "c").status).toBe("pass");
  });

  it("(d) measures the first kicker against its market round", () => {
    const kicker = row("k1", "K", 120, 137.1);
    const fillers = Array.from({ length: 15 }, (_, i) => row(`f${i}`, "WR", 150 - i, i + 1));
    const early = replayFromOwnPicks(
      [kicker, ...fillers],
      Array.from({ length: 16 }, (_, i) => ({
        round: i + 1,
        playerId: i === 10 ? "k1" : `f${i - (i > 10 ? 1 : 0)}`,
      })),
    );
    const flagged = outcome(early.replay, early.board, "d");
    expect(flagged.status).toBe("fail");
    // ADP 137.1 in a ten-team league is a round-14 price; round 11 is three rounds early.
    expect(flagged.violations).toEqual([
      expect.stringContaining(
        "first K Player k1 at 11.05, 3 rounds ahead of its round-14 market (ADP 137.1)",
      ),
    ]);

    const onTime = replayFromOwnPicks(
      [kicker, ...fillers],
      Array.from({ length: 16 }, (_, i) => ({
        round: i + 1,
        playerId: i === 13 ? "k1" : `f${i - (i > 13 ? 1 : 0)}`,
      })),
    );
    expect(outcome(onTime.replay, onTime.board, "d").status).toBe("pass");

    // Exactly the tolerance ahead — round 12 against a round-14 market — is allowed.
    const atTolerance = replayFromOwnPicks(
      [kicker, ...fillers],
      Array.from({ length: 16 }, (_, i) => ({
        round: i + 1,
        playerId: i === 11 ? "k1" : `f${i - (i > 11 ? 1 : 0)}`,
      })),
    );
    expect(outcome(atTolerance.replay, atTolerance.board, "d").status).toBe("pass");
  });

  it("(d) prices an unranked kicker behind the whole draft and an ADP of zero at the top", () => {
    const unranked = row("k1", "K", 120, null);
    const fillers = Array.from({ length: 15 }, (_, i) => row(`f${i}`, "WR", 150 - i, i + 1));
    const ghost = replayFromOwnPicks(
      [unranked, ...fillers],
      Array.from({ length: 16 }, (_, i) => ({
        round: i + 1,
        playerId: i === 4 ? "k1" : `f${i - (i > 4 ? 1 : 0)}`,
      })),
    );
    const flagged = outcome(ghost.replay, ghost.board, "d");
    expect(flagged.status).toBe("fail");
    // 160 picks + 24 padding = pick 184, a round-19 price a 16-round draft never reaches.
    expect(flagged.violations).toEqual([
      expect.stringContaining("14 rounds ahead of its round-19 market (ADP none)"),
    ]);

    // ADP zero is the market's first pick, not a missing rank: no round is early.
    const zero = replayFromOwnPicks(
      [row("k0", "K", 120, 0), ...fillers.map((entry) => ({ ...entry }))],
      Array.from({ length: 16 }, (_, i) => ({
        round: i + 1,
        playerId: i === 4 ? "k0" : `f${i - (i > 4 ? 1 : 0)}`,
      })),
    );
    expect(outcome(zero.replay, zero.board, "d").status).toBe("pass");
  });

  it("(e) counts wide receivers on the final roster", () => {
    const receivers = Array.from({ length: MIN_WIDE_RECEIVERS }, (_, i) =>
      row(`wr${i}`, "WR", 160 - i, i + 1),
    );
    const backs = Array.from({ length: 16 }, (_, i) => row(`rb${i}`, "RB", 150 - i, 20 + i));
    const thin = replayFromOwnPicks(
      [...receivers, ...backs],
      Array.from({ length: 16 }, (_, i) => ({
        round: i + 1,
        playerId: i < 2 ? `wr${i}` : `rb${i}`,
      })),
    );
    const flagged = outcome(thin.replay, thin.board, "e");
    expect(flagged.status).toBe("fail");
    expect(flagged.violations).toEqual([expect.stringContaining("2 WR drafted in 16 rounds")]);

    // One short of the requirement still fails: the threshold is four, not three.
    const almost = replayFromOwnPicks(
      [...receivers.map((entry) => ({ ...entry })), ...backs.map((entry) => ({ ...entry }))],
      Array.from({ length: 16 }, (_, i) => ({
        round: i + 1,
        playerId: i < MIN_WIDE_RECEIVERS - 1 ? `wr${i}` : `rb${i}`,
      })),
    );
    expect(outcome(almost.replay, almost.board, "e").status).toBe("fail");

    const enough = replayFromOwnPicks(
      [...receivers, ...backs],
      Array.from({ length: 16 }, (_, i) => ({
        round: i + 1,
        playerId: i < MIN_WIDE_RECEIVERS ? `wr${i}` : `rb${i}`,
      })),
    );
    expect(outcome(enough.replay, enough.board, "e").status).toBe("pass");
  });

  it("(e) states a zero-receiver roster plainly and names a lone receiver", () => {
    const backs = Array.from({ length: 16 }, (_, i) => row(`rb${i}`, "RB", 150 - i, 20 + i));
    const none = replayFromOwnPicks(
      [...backs.map((entry) => ({ ...entry }))],
      Array.from({ length: 16 }, (_, i) => ({ round: i + 1, playerId: `rb${i}` })),
    );
    const flagged = outcome(none.replay, none.board, "e");
    expect(flagged.status).toBe("fail");
    expect(flagged.violations).toEqual(["0 WR drafted in 16 rounds"]);

    // One receiver gets the parenthetical: a single name is still evidence.
    const one = replayFromOwnPicks(
      [row("wr0", "WR", 160, 1), ...backs.map((entry) => ({ ...entry }))],
      Array.from({ length: 16 }, (_, i) => ({
        round: i + 1,
        playerId: i === 0 ? "wr0" : `rb${i}`,
      })),
    );
    expect(outcome(one.replay, one.board, "e").violations).toEqual([
      "1 WR drafted in 16 rounds (Player wr0 at 1.05)",
    ]);
  });

  it("(f) flags a leader displayed below a runner-up's championship odds", () => {
    const lead = row("lead", "RB", 200, 15);
    const runner = row("run", "RB", 199, 16);
    const fillers = Array.from({ length: 15 }, (_, i) => row(`f${i}`, "WR", 150 - i, i + 20));
    const inverted = replayFromOwnPicks(
      [lead, runner, ...fillers],
      Array.from({ length: 16 }, (_, i) => ({
        round: i + 1,
        playerId: i === 0 ? "lead" : `f${i - 1}`,
        recommendations:
          i === 0
            ? [
                recommendation(toPlayerRisk(lead), 0.145),
                recommendation(toPlayerRisk(runner), 0.162),
              ]
            : undefined,
      })),
    );
    const flagged = outcome(inverted.replay, inverted.board, "f");
    expect(flagged.status).toBe("fail");
    expect(flagged.violations).toEqual([
      expect.stringContaining("14.5% sits above Player run at 16.2%"),
    ]);

    const upright = replayFromOwnPicks(
      [lead, runner, ...fillers],
      Array.from({ length: 16 }, (_, i) => ({
        round: i + 1,
        playerId: i === 0 ? "lead" : `f${i - 1}`,
        recommendations:
          i === 0
            ? [
                recommendation(toPlayerRisk(lead), 0.162),
                recommendation(toPlayerRisk(runner), 0.145),
              ]
            : undefined,
      })),
    );
    expect(outcome(upright.replay, upright.board, "f").status).toBe("pass");

    // A dead-equal tie is not an inversion: the leader label is not below anybody.
    const level = replayFromOwnPicks(
      [{ ...lead }, { ...runner }, ...fillers.map((entry) => ({ ...entry }))],
      Array.from({ length: 16 }, (_, i) => ({
        round: i + 1,
        playerId: i === 0 ? "lead" : `f${i - 1}`,
        recommendations:
          i === 0
            ? [
                recommendation(toPlayerRisk(lead), 0.15),
                recommendation(toPlayerRisk(runner), 0.15),
              ]
            : undefined,
      })),
    );
    expect(outcome(level.replay, level.board, "f").status).toBe("pass");
  });
});
