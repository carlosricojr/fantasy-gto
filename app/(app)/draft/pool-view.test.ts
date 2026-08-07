import { describe, expect, it } from "vitest";

import type { PlayerRisk } from "@/lib/core/roster-utility";
import { slotsForTemplate } from "@/lib/nfl/roster";
import {
  type PoolPlayer,
  byeGaps,
  filterPool,
  neededPositions,
  positionCounts,
  sortPool,
  unfilledSlots,
  unrankedAdpFor,
} from "./pool-view";

/**
 * The player pool.
 *
 * Two things here can be wrong without looking wrong. A sort that treats a missing ADP as
 * zero puts every player the market has never heard of at the top of the board, which
 * reads as a ranking rather than as a bug. And a "what do I still need" answer that counts
 * positions instead of solving slots gets flex wrong in both directions, which reads as an
 * opinion.
 */

function player(overrides: Partial<PoolPlayer> & { id: string }): PoolPlayer {
  return {
    name: overrides.id,
    position: "RB",
    team: "ATL",
    byeWeek: 5,
    seasonPoints: 200,
    modelPoints: 190,
    marketPoints: 210,
    adp: 10,
    adpStdev: 8,
    availability: 0.9,
    basis: "blend",
    overallRank: 1,
    draftedAt: null,
    draftedBy: null,
    ...overrides,
  };
}

const POOL: PoolPlayer[] = [
  player({ id: "1", name: "Bijan Robinson", position: "RB", overallRank: 1, adp: 1.2 }),
  player({ id: "2", name: "Ja'Marr Chase", position: "WR", overallRank: 2, adp: 6.6 }),
  player({ id: "3", name: "Josh Allen", position: "QB", overallRank: 3, adp: null }),
  player({
    id: "4",
    name: "Derrick Henry",
    position: "RB",
    overallRank: 4,
    adp: 7.4,
    draftedAt: 3,
    draftedBy: "Seat 3",
  }),
];

describe("filterPool", () => {
  it("separates who is left from who is gone", () => {
    const available = filterPool(POOL, { filter: "available", position: null, query: "" });
    expect(available.map((row) => row.id)).toEqual(["1", "2", "3"]);
    const drafted = filterPool(POOL, { filter: "drafted", position: null, query: "" });
    expect(drafted.map((row) => row.id)).toEqual(["4"]);
  });

  it("keeps drafted players reachable, because a mis-recorded pick has to be checkable", () => {
    // The previous board filtered taken players out of everything, so a name typed wrongly
    // simply vanished and the only repair was to undo picks back to it.
    expect(
      filterPool(POOL, { filter: "drafted", position: null, query: "henry" }).map((r) => r.id),
    ).toEqual(["4"]);
  });

  it("filters by position", () => {
    expect(
      filterPool(POOL, { filter: "available", position: "RB", query: "" }).map((r) => r.id),
    ).toEqual(["1"]);
  });

  it("matches every player containing what was typed, not just the best one", () => {
    // A single best match is right for reconciling an imported roster and wrong for a
    // person browsing: someone typing a shared surname wants all of them.
    const rows = filterPool(POOL, { filter: "available", position: null, query: "a" });
    expect(rows.length).toBeGreaterThan(1);
  });

  it("falls back to the nearest name when nothing contains the query", () => {
    // A draft room is loud and names get misheard. An empty list for a misspelling reads
    // as "this player is not in this draft".
    const rows = filterPool(POOL, {
      filter: "available",
      position: null,
      query: "Bijan Robinsen",
    });
    expect(rows.map((row) => row.id)).toEqual(["1"]);
  });

  it("returns nothing rather than a wrong guess when nothing is close", () => {
    expect(
      filterPool(POOL, { filter: "available", position: null, query: "zzzzzzzz" }),
    ).toEqual([]);
  });
});

describe("sortPool", () => {
  it("ranks by board value by default", () => {
    expect(sortPool(POOL, "value").map((row) => row.overallRank)).toEqual([1, 2, 3, 4]);
  });

  it("puts players the market has not priced last, not first", () => {
    // Sorting a missing ADP as zero would make every unranked player look like the
    // consensus first overall pick — the same inversion `UNRANKED_ADP_PADDING` exists to
    // prevent in the survival model.
    expect(sortPool(POOL, "adp").map((row) => row.id)).toEqual(["1", "2", "4", "3"]);
  });

  it("is a total order, so the list cannot reshuffle under a moving finger", () => {
    const tied = [
      player({ id: "a", byeWeek: 7, overallRank: 9 }),
      player({ id: "b", byeWeek: 7, overallRank: 2 }),
      player({ id: "c", byeWeek: 7, overallRank: 5 }),
    ];
    expect(sortPool(tied, "bye").map((row) => row.id)).toEqual(["b", "c", "a"]);
    expect(sortPool([...tied].reverse(), "bye").map((row) => row.id)).toEqual(["b", "c", "a"]);
  });

  it("does not mutate what it was given", () => {
    const before = POOL.map((row) => row.id);
    sortPool(POOL, "adp");
    expect(POOL.map((row) => row.id)).toEqual(before);
  });
});

describe("positionCounts", () => {
  it("counts the rows it is given, so the tabs describe the list underneath them", () => {
    // The caller scopes to the active filter first. Filtering to available *inside* this
    // function made the tabs read "RB 41" over a list of drafted players, and made a
    // position with nothing available disappear from the tabs while its drafted players
    // sat in the list with no way to filter to them.
    const available = filterPool(POOL, { filter: "available", position: null, query: "" });
    expect(positionCounts(available)).toEqual({ RB: 1, WR: 1, QB: 1 });

    const drafted = filterPool(POOL, { filter: "drafted", position: null, query: "" });
    expect(positionCounts(drafted)).toEqual({ RB: 1 });
  });
});

describe("what the roster still needs", () => {
  const slots = slotsForTemplate("standard");

  function risk(id: string, position: string): PlayerRisk {
    return {
      id,
      name: id,
      position,
      weeklyMean: 12,
      p10: 0.6,
      p90: 1.4,
      byeWeek: 5,
      availability: 0.9,
    };
  }

  it("solves flex rather than counting positions", () => {
    // Three backs and one receiver fills RB, RB, WR and FLEX. A per-position tally reads
    // that as "RB covered, WR covered" and misses that a receiver slot is still empty;
    // this is the case that makes counting wrong in both directions at once.
    const roster = [risk("a", "RB"), risk("b", "RB"), risk("c", "RB"), risk("d", "WR")];
    expect(unfilledSlots(slots, roster).sort()).toEqual(["D/ST", "K", "QB", "TE", "WR"]);
    expect([...neededPositions(slots, roster)].sort()).toEqual([
      "DST",
      "K",
      "QB",
      "TE",
      "WR",
    ]);
  });

  it("reports every starting slot on an empty roster", () => {
    expect(unfilledSlots(slots, [])).toHaveLength(slots.length);
  });

  it("reports nothing once every starting slot is filled", () => {
    const roster = [
      risk("qb", "QB"),
      risk("rb1", "RB"),
      risk("rb2", "RB"),
      risk("wr1", "WR"),
      risk("wr2", "WR"),
      risk("te", "TE"),
      risk("flex", "WR"),
      risk("k", "K"),
      risk("dst", "DST"),
    ];
    expect(unfilledSlots(slots, roster)).toEqual([]);
    expect(neededPositions(slots, roster).size).toBe(0);
  });

  it("does not count a bench player as filling a slot twice", () => {
    // The whole unfilled set, not just the absence of QB. Asserting only that "QB" is
    // gone passes even if the second quarterback wrongly occupied some other slot, which
    // is the failure the test is named for.
    const roster = [risk("qb1", "QB"), risk("qb2", "QB")];
    expect(unfilledSlots(slots, roster).sort()).toEqual(
      slots
        .filter((slot) => slot.label !== "QB")
        .map((slot) => slot.label)
        .sort(),
    );
  });
});

describe("unrankedAdpFor", () => {
  it("puts an unpriced player behind everyone the market has priced", () => {
    expect(unrankedAdpFor(180)).toBeGreaterThan(180);
  });
});

describe("byeGaps", () => {
  const slots = slotsForTemplate("standard");

  function risk(id: string, position: string, byeWeek: number | null): PlayerRisk {
    return {
      id,
      name: id,
      position,
      weeklyMean: 12,
      p10: 0.6,
      p90: 1.4,
      byeWeek,
      availability: 0.9,
    };
  }

  /** A roster that fills every starting slot, with each player on a different bye. */
  function fullRoster(): PlayerRisk[] {
    return [
      risk("qb", "QB", 1),
      risk("rb1", "RB", 2),
      risk("rb2", "RB", 3),
      risk("wr1", "WR", 4),
      risk("wr2", "WR", 5),
      risk("te", "TE", 6),
      risk("flex", "WR", 7),
      risk("k", "K", 8),
      risk("dst", "DST", 9),
    ];
  }

  it("reports the slot a bye leaves empty, not the players sharing a week", () => {
    // The old panel said "Week 9: RB, RB". That is a fact about the roster, not a cost —
    // what a manager needs to know is which slot has nobody in it that week.
    const gaps = byeGaps(slots, fullRoster());
    expect(gaps.find((gap) => gap.week === 1)?.slots).toEqual(["QB"]);
    expect(gaps.find((gap) => gap.week === 6)?.slots).toEqual(["TE"]);
  });

  it("says nothing when depth covers the week", () => {
    // Three backs sharing nothing but a position: losing one to a bye costs no slot,
    // because the third steps into the flex. Counting shared byes reported this as a
    // collision; it is exactly what a bench is for.
    const roster = [...fullRoster(), risk("rb3", "RB", 9)];
    const gaps = byeGaps(slots, roster);
    expect(gaps.find((gap) => gap.week === 9)?.slots).toEqual(["D/ST"]);
    expect(gaps.find((gap) => gap.week === 2)).toBeUndefined();
  });

  it("catches a starter and their only cover sharing a week", () => {
    // The case that "count only the starters" misses. The backup is on the bench, so a
    // starters-only tally sees one player on week 2 and reports nothing — while the
    // roster is genuinely one back short that week.
    const roster = [...fullRoster(), risk("rb3", "RB", 2)];
    expect(byeGaps(slots, roster).find((gap) => gap.week === 2)?.slots).toEqual(["RB"]);
  });

  it("does not blame a bye for a slot nobody has drafted for", () => {
    // Without the baseline subtraction, an empty tight end slot in round three is reported
    // as a bye problem in every week of the season at once.
    const roster = [risk("rb1", "RB", 5), risk("wr1", "WR", 7)];
    const gaps = byeGaps(slots, roster);
    expect(gaps.find((gap) => gap.week === 5)?.slots).toEqual(["RB"]);
    expect(gaps.find((gap) => gap.week === 5)?.slots).not.toContain("TE");
  });

  it("marks the gaps that land in the league's own playoff weeks", () => {
    // Week 14 is an ordinary week for a league whose final is in week 17 and the
    // semi-final for one whose final is in week 15, and a manager reading a list of week
    // numbers cannot tell which league they are in. The same gap therefore has to be
    // labelled differently for the two, from the league's real bracket rather than a
    // literal.
    // The only tight end, idle in week 14 — an NFL bye week, and the last one there is.
    const roster = fullRoster().map((player) =>
      player.id === "te" ? { ...player, byeWeek: 14 } : player,
    );
    const early = byeGaps(slots, roster, [13, 14, 15]);
    expect(early.find((gap) => gap.week === 14)?.slots).toEqual(["TE"]);
    expect(early.find((gap) => gap.week === 14)?.inPlayoffs).toBe(true);
    expect(early.find((gap) => gap.week === 1)?.inPlayoffs).toBe(false);

    const late = byeGaps(slots, roster, [15, 16, 17]);
    expect(late.find((gap) => gap.week === 14)?.inPlayoffs).toBe(false);
  });

  it("claims no playoff week when it has not been told the league's bracket", () => {
    // The default is "none", not a literal 15-17. A caller that does not know the
    // calendar must not have one invented for it: three assumed weeks would label a
    // regular-season bye as a lost semi-final, which is worse than saying nothing.
    for (const gap of byeGaps(slots, fullRoster())) expect(gap.inPlayoffs).toBe(false);
  });

  it("is empty for a roster with no byes known", () => {
    expect(byeGaps(slots, [risk("a", "RB", null)])).toEqual([]);
    expect(byeGaps(slots, [])).toEqual([]);
  });

  it("never names more empty slots than the week actually costs", () => {
    // The per-label difference can name a different slot than the one that emptied when two
    // are interchangeable — a back moving from RB to FLEX is not a new gap. The count comes
    // from the totals, and the names are capped at it, so the list cannot over-report.
    for (const roster of [
      fullRoster(),
      [...fullRoster(), risk("rb3", "RB", 2)],
      [risk("rb1", "RB", 4), risk("rb2", "RB", 4), risk("wr1", "WR", 4)],
    ]) {
      for (const gap of byeGaps(slots, roster)) {
        const available = roster.filter((player) => player.byeWeek !== gap.week);
        const lost =
          unfilledSlots(slots, available).length - unfilledSlots(slots, roster).length;
        expect(gap.slots.length).toBe(lost);
      }
    }
  });

  it("returns weeks in order", () => {
    const weeks = byeGaps(slots, fullRoster()).map((gap) => gap.week);
    expect(weeks).toEqual([...weeks].sort((a, b) => a - b));
  });
});
