import { describe, expect, it } from "vitest";

import { solveLineup } from "../core/optimizer";
import {
  DEFAULT_TEMPLATE,
  NO_DST_TEMPLATE,
  NO_K_DST_TEMPLATE,
  NO_K_TEMPLATE,
  ROSTER_TEMPLATES,
  SHALLOW_BENCH_TEMPLATE,
  SLOT_ELIGIBILITY,
  STANDARD_TEMPLATE,
  SUPERFLEX_TEMPLATE,
  THREE_WR_TEMPLATE,
  TWO_FLEX_TEMPLATE,
  TWO_QB_TEMPLATE,
  buildSlots,
  rosterTemplateById,
  slotSummary,
  slotsForTemplate,
  templateForRoster,
} from "./roster";
import { leagueUnfilledSlots, solveDemand } from "../core/draft-replacement";
import { scoreCandidates, type PolicyLeague } from "../core/draft-policy";
import type { PlayerRisk } from "../core/roster-utility";

/**
 * Roster shapes.
 *
 * The second module in the mutation harness's own target list with no test file, after
 * `rng.ts`. Every recommendation in this branch is scored against slots this builds, and
 * every test above supplies them by calling `buildSlots` — so the shapes were exercised
 * constantly and never *asserted*. What a slot accepts is the difference between two
 * fantasy games, and an id that changes is a stored lineup that no longer refers to
 * anything.
 */
describe("SLOT_ELIGIBILITY", () => {
  it("keeps quarterbacks out of FLEX and in SUPERFLEX", () => {
    // The distinction the module's docstring calls fundamental. Conflated, a superflex
    // league is scored as though a second quarterback could not start — or, worse, a
    // standard league is scored as though one could, which changes every recommendation
    // from the first round on.
    expect(SLOT_ELIGIBILITY.FLEX).toEqual(["RB", "WR", "TE"]);
    expect(SLOT_ELIGIBILITY.SUPERFLEX).toEqual(["QB", "RB", "WR", "TE"]);
    expect(SLOT_ELIGIBILITY.FLEX).not.toContain("QB");
    expect(SLOT_ELIGIBILITY.SUPERFLEX).toContain("QB");
  });

  it("gives every single-position slot exactly its own position", () => {
    for (const kind of ["QB", "RB", "WR", "TE", "K", "DST"]) {
      expect(SLOT_ELIGIBILITY[kind]).toEqual([kind]);
    }
  });

  it("keeps the two partial flexes distinct from each other and from FLEX", () => {
    expect(SLOT_ELIGIBILITY.WR_TE).toEqual(["WR", "TE"]);
    expect(SLOT_ELIGIBILITY.RB_WR).toEqual(["RB", "WR"]);
    expect(SLOT_ELIGIBILITY.WR_TE).not.toContain("RB");
    expect(SLOT_ELIGIBILITY.RB_WR).not.toContain("TE");
  });
});

describe("buildSlots", () => {
  it("numbers repeated slots and leaves a single one unnumbered", () => {
    // Ids are stored: a lineup saved as `rb1` has to keep meaning the same slot. Numbering
    // a lone slot, or failing to number a pair, silently orphans every saved lineup.
    expect(buildSlots({ QB: 1, RB: 2 }).map((s) => s.id)).toEqual(["qb", "rb1", "rb2"]);
    expect(buildSlots({ WR: 3 }).map((s) => s.id)).toEqual(["wr1", "wr2", "wr3"]);
  });

  it("produces one slot per count, and none for a kind not asked for", () => {
    const slots = buildSlots({ QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1 });
    expect(slots).toHaveLength(7);
    expect(slots.some((s) => s.id.startsWith("k"))).toBe(false);
    expect(buildSlots({})).toEqual([]);
    expect(buildSlots({ RB: 0 })).toEqual([]);
  });

  it("orders slots the way the eligibility table is written", () => {
    // Not incidental: `solveLineup` fills slots in order and the board renders them in
    // order, so a flex appearing before the backs it is meant to catch the overflow from
    // reads as a different roster.
    expect(buildSlots({ FLEX: 1, QB: 1, DST: 1, RB: 1 }).map((s) => s.id)).toEqual([
      "qb",
      "rb",
      "flex",
      "dst",
    ]);
  });

  it("gives every slot a unique id", () => {
    const ids = slotsForTemplate("superflex").map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("labels D/ST for people rather than for the code", () => {
    expect(buildSlots({ DST: 1 })[0].label).toBe("D/ST");
    expect(buildSlots({ WR_TE: 1 })[0].label).toBe("WR/TE");
    expect(buildSlots({ RB_WR: 1 })[0].label).toBe("RB/WR");
  });

  it("ignores a kind the eligibility table does not define", () => {
    // A stored template from a future release, or a typo. Silently inventing a slot with
    // no eligible positions would produce a lineup with a hole nothing can fill.
    expect(buildSlots({ NOT_A_SLOT: 2 })).toEqual([]);
  });
});

describe("the shipped templates", () => {
  it("are the shapes they say they are", () => {
    // The counts themselves, pinned. Every league is scored against these: a quarterback
    // slot that quietly became two, or a kicker slot that disappeared, changes what
    // `solveLineup` fills and therefore every recommendation, with nothing else in the
    // suite objecting — the other tests here check the *relationships* between templates,
    // which survive moving all three together.
    expect(STANDARD_TEMPLATE.counts).toEqual({
      QB: 1,
      RB: 2,
      WR: 2,
      TE: 1,
      FLEX: 1,
      K: 1,
      DST: 1,
    });
    expect(THREE_WR_TEMPLATE.counts).toEqual({
      QB: 1,
      RB: 2,
      WR: 3,
      TE: 1,
      FLEX: 1,
      K: 1,
      DST: 1,
    });
    expect(SUPERFLEX_TEMPLATE.counts).toEqual({
      QB: 1,
      RB: 2,
      WR: 2,
      TE: 1,
      FLEX: 1,
      SUPERFLEX: 1,
      K: 1,
      DST: 1,
    });
    // And the starting-lineup sizes they add up to, which is what a user counts.
    expect(slotsForTemplate("standard")).toHaveLength(9);
    expect(slotsForTemplate("three_wr")).toHaveLength(10);
    expect(slotsForTemplate("superflex")).toHaveLength(10);
  });

  it("differ from each other in the way their names claim", () => {
    // Templates that all built the same league would be several names for one game. The
    // league is the slots *and* the roster size: `standard` and `shallow_bench` field the
    // same nine starters over fifteen rounds and thirteen, which is a four-man bench against
    // a six-man one and a materially different draft.
    const leagues = ROSTER_TEMPLATES.map(
      (t) =>
        `${buildSlots(t.counts)
          .map((s) => s.id)
          .join(",")}|${t.rounds}`,
    );
    expect(new Set(leagues).size).toBe(ROSTER_TEMPLATES.length);
    expect(new Set(ROSTER_TEMPLATES.map((t) => t.id)).size).toBe(
      ROSTER_TEMPLATES.length,
    );
  });

  it("gives superflex a slot a second quarterback can start in, and standard none", () => {
    const secondQb = { id: "qb2", name: "Backup", position: "QB", projectedPoints: 20, availability: "active" as const };
    const starter = { id: "qb1", name: "Starter", position: "QB", projectedPoints: 25, availability: "active" as const };

    const standard = solveLineup(slotsForTemplate("standard"), [starter, secondQb]);
    expect(standard.benchedIds).toContain("qb2");

    const superflex = solveLineup(slotsForTemplate("superflex"), [starter, secondQb]);
    expect(superflex.benchedIds).not.toContain("qb2");
    expect(superflex.totalPoints).toBeGreaterThan(standard.totalPoints);
  });

  it("gives the three-receiver template a third receiver slot", () => {
    const wrSlots = (id: string) =>
      slotsForTemplate(id).filter((s) => s.eligiblePositions.join() === "WR").length;
    expect(wrSlots("three_wr")).toBe(3);
    expect(wrSlots("standard")).toBe(2);
  });

  it("describes itself accurately enough to pick from", () => {
    // The descriptions are rendered on the setup screen, so one that disagrees with its
    // counts is a user choosing a shape they were not shown. Each is checked against the
    // claim it actually makes: the two that enumerate are checked against their counts, and
    // superflex — which describes itself by difference — against that difference.
    for (const template of [STANDARD_TEMPLATE, THREE_WR_TEMPLATE]) {
      for (const [kind, count] of Object.entries(template.counts)) {
        if (count > 1) expect(template.description).toContain(`${count} ${kind}`);
      }
    }

    // "Standard plus a SUPERFLEX that accepts a second QB", asserted rather than read.
    expect(SUPERFLEX_TEMPLATE.description).toContain("Standard plus a SUPERFLEX");
    expect(SUPERFLEX_TEMPLATE.counts).toEqual({
      ...STANDARD_TEMPLATE.counts,
      SUPERFLEX: 1,
    });
  });
});

describe("rosterTemplateById", () => {
  it("falls back to the default rather than throwing", () => {
    // Reached from stored state, so an id from a deleted template must not take the page
    // down. Falling back is the documented choice — and the default is the standard shape,
    // not whichever template happens to be listed first.
    expect(rosterTemplateById("no-such-template")).toBe(DEFAULT_TEMPLATE);
    expect(rosterTemplateById(null)).toBe(DEFAULT_TEMPLATE);
    expect(rosterTemplateById(undefined)).toBe(DEFAULT_TEMPLATE);
    expect(DEFAULT_TEMPLATE).toBe(STANDARD_TEMPLATE);
  });

  it("returns each template by its own id", () => {
    for (const template of ROSTER_TEMPLATES) {
      expect(rosterTemplateById(template.id)).toBe(template);
    }
    expect(rosterTemplateById("superflex")).toBe(SUPERFLEX_TEMPLATE);
  });

  it("does not resolve a prototype key to a template", () => {
    // `templateId` reaches here from `sessionStorage`. A lookup by property would resolve
    // `constructor` to something truthy; this one searches a list, and the test is here so
    // it stays that way.
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(rosterTemplateById(key)).toBe(DEFAULT_TEMPLATE);
    }
  });
});

/**
 * Every shipped preset, asserted rather than described.
 *
 * The mock this epic is built against is ten teams, fifteen rounds, standard scoring and
 * **two** flex slots, which no template carried. A preset that cannot be selected exactly is
 * a preset that gets approximated, and the whole point of the value model is that a league's
 * shape decides what it drafts.
 */
describe("every shipped preset", () => {
  const EXPECTED: ReadonlyArray<
    readonly [string, Readonly<Record<string, number>>, number, number]
  > = [
    // id, counts, starting slots, rounds
    ["standard", { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 }, 9, 15],
    ["two_flex", { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, K: 1, DST: 1 }, 10, 15],
    ["three_wr", { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1, K: 1, DST: 1 }, 10, 15],
    [
      "superflex",
      { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPERFLEX: 1, K: 1, DST: 1 },
      10,
      16,
    ],
    ["two_qb", { QB: 2, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 }, 10, 16],
    ["no_k", { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, DST: 1 }, 8, 15],
    ["no_dst", { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1 }, 8, 15],
    ["no_k_dst", { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1 }, 7, 14],
    ["shallow_bench", { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 }, 9, 13],
  ];

  it("has exactly these ids, counts, slot totals and rounds", () => {
    expect(ROSTER_TEMPLATES.map((t) => t.id)).toEqual(EXPECTED.map(([id]) => id));
    for (const [id, counts, slots, rounds] of EXPECTED) {
      const template = rosterTemplateById(id);
      expect(template.counts).toEqual(counts);
      expect(template.rounds).toBe(rounds);
      expect(slotsForTemplate(id)).toHaveLength(slots);
      // Rounds must leave room for the starters. A template that drafts fewer players than
      // it fields would field a lineup with a permanent hole.
      expect(rounds).toBeGreaterThanOrEqual(slots);
    }
  });

  it("gives every slot an eligibility set the table actually defines", () => {
    // Not "non-empty" — a set that came from `SLOT_ELIGIBILITY`. A template naming a kind
    // the table has no entry for would build a slot with nothing eligible for it, which
    // `solveLineup` fills with nobody and the simulation scores as a permanent hole.
    const known = Object.values(SLOT_ELIGIBILITY).map((set) => set.join(","));
    for (const template of ROSTER_TEMPLATES) {
      const slots = buildSlots(template.counts);
      // Every count asked for produced a slot, so no kind was silently dropped.
      const asked = Object.values(template.counts).reduce((a, b) => a + b, 0);
      expect(slots).toHaveLength(asked);
      for (const slot of slots) {
        expect(slot.eligiblePositions.length).toBeGreaterThan(0);
        expect(known).toContain(slot.eligiblePositions.join(","));
      }
      // Ids are the serialized contract and must be unique inside a template.
      const ids = slots.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("summarizes its slots from the counts rather than from the prose", () => {
    expect(slotSummary("two_flex")).toBe(
      "QB 1 · RB 2 · WR 2 · TE 1 · FLEX 2 · K 1 · D/ST 1",
    );
    expect(slotSummary("no_k_dst")).toBe("QB 1 · RB 2 · WR 2 · TE 1 · FLEX 1");
    // A shape the app cannot field never appears in the summary.
    expect(slotSummary("no_k")).not.toContain("K 1");
    expect(slotSummary("no_dst")).not.toContain("D/ST");
  });
});

describe("the two-FLEX preset", () => {
  const flexOf = (id: string) =>
    slotsForTemplate(id).filter((s) => s.label === "FLEX");

  it("has two of them, and standard has one", () => {
    expect(flexOf("two_flex")).toHaveLength(2);
    expect(flexOf("standard")).toHaveLength(1);
    expect(flexOf("two_flex").map((s) => s.id)).toEqual(["flex1", "flex2"]);
    expect(flexOf("standard").map((s) => s.id)).toEqual(["flex"]);
  });

  it("is filled by the optimizer without anything knowing which preset it is", () => {
    // Four backs and nothing else at the flex-eligible positions. Two take the RB slots and
    // the other two take both FLEX slots — which no code special-cases, because the solver
    // reads eligibility rather than a template id.
    const backs = [17, 15, 13, 11].map((points, i) => ({
      id: `rb${i}`,
      name: `rb${i}`,
      position: "RB",
      projectedPoints: points,
      availability: "active" as const,
    }));
    const solution = solveLineup(slotsForTemplate("two_flex"), backs);
    const started = solution.assignments
      .filter((a) => a.competitorId !== null)
      .map((a) => a.slotId);
    expect(started).toContain("flex1");
    expect(started).toContain("flex2");
    expect(solution.benchedIds).toEqual([]);

    // The same four against one FLEX leaves the worst on the bench.
    expect(solveLineup(slotsForTemplate("standard"), backs).benchedIds).toEqual(["rb3"]);
  });

  it("changes the league's remaining starter demand", () => {
    // #38's demand solver reads the slots, so a second flex is twelve more flexible slots
    // across a twelve-team league — and they go where the value curves send them rather than
    // a third each to RB, WR and TE.
    const board = [
      ...Array.from({ length: 60 }, (_, i) => ({ position: "RB", value: 20 - i * 0.5 })),
      ...Array.from({ length: 60 }, (_, i) => ({ position: "WR", value: 20 - i * 0.5 })),
      ...Array.from({ length: 40 }, (_, i) => ({ position: "TE", value: 14 - i })),
      ...Array.from({ length: 40 }, (_, i) => ({ position: "QB", value: 20 - i * 0.2 })),
      ...Array.from({ length: 30 }, (_, i) => ({ position: "K", value: 8 - i * 0.05 })),
      ...Array.from({ length: 30 }, (_, i) => ({ position: "DST", value: 8.5 - i * 0.06 })),
    ];
    const demandFor = (id: string) =>
      solveDemand(
        leagueUnfilledSlots(
          Array.from({ length: 12 }, () => []),
          slotsForTemplate(id),
        ),
        board,
      );
    const one = demandFor("standard");
    const two = demandFor("two_flex");
    expect(one.get("RB")).toBe(30);
    expect(one.get("WR")).toBe(30);
    expect(one.get("TE")).toBe(12);
    expect(two.get("RB")).toBe(36);
    expect(two.get("WR")).toBe(36);
    expect(two.get("TE")).toBe(12);
  });
});

describe("a template that starts no kicker", () => {
  const player = (
    id: string,
    position: string,
    weeklyMean: number,
  ): PlayerRisk => ({
    id,
    name: id,
    position,
    weeklyMean,
    p10: 0.269,
    p90: 1.901,
    byeWeek: 6,
    availability: 0.95,
  });

  const board = (): PlayerRisk[] => [
    ...Array.from({ length: 30 }, (_, i) => player(`rb${i}`, "RB", 17 - i * 0.3)),
    ...Array.from({ length: 30 }, (_, i) => player(`wr${i}`, "WR", 16 - i * 0.25)),
    ...Array.from({ length: 20 }, (_, i) => player(`te${i}`, "TE", 13 - i * 0.3)),
    ...Array.from({ length: 20 }, (_, i) => player(`qb${i}`, "QB", 20 - i * 0.35)),
    ...Array.from({ length: 12 }, (_, i) => player(`k${i}`, "K", 8 - i * 0.05)),
    ...Array.from({ length: 12 }, (_, i) => player(`dst${i}`, "DST", 8.5 - i * 0.06)),
  ];

  const league = (id: string): PolicyLeague => ({
    slots: slotsForTemplate(id),
    weeks: 14,
  });

  const demandOf = (id: string) =>
    leagueUnfilledSlots(
      Array.from({ length: 12 }, () => []),
      slotsForTemplate(id),
    );

  it("prices every kicker at exactly nothing", () => {
    // Not "small" — nothing. A position with no starting slot has no demand, so replacement
    // is the best player at it and there is no slot for a reserve to cover. The generic
    // depth term that used to leave a positive score behind is gone; this is the assertion
    // that says so, and it is the one that fails if it comes back.
    const scored = scoreCandidates([], board(), league("no_k"), demandOf("no_k"));
    for (const entry of scored.filter((e) => e.player.position === "K")) {
      expect(entry.value).toBe(0);
    }
    // And the same board under the standard template does value a kicker, so the zero is a
    // property of the template rather than of the kickers.
    const withK = scoreCandidates([], board(), league("standard"), demandOf("standard"));
    expect(withK.find((e) => e.player.position === "K")!.value).toBeGreaterThan(0);
  });

  it("does the same for a defense, and for both at once", () => {
    const noDst = scoreCandidates([], board(), league("no_dst"), demandOf("no_dst"));
    for (const entry of noDst.filter((e) => e.player.position === "DST")) {
      expect(entry.value).toBe(0);
    }
    const neither = scoreCandidates(
      [],
      board(),
      league("no_k_dst"),
      demandOf("no_k_dst"),
    );
    for (const entry of neither.filter((e) => ["K", "DST"].includes(e.player.position))) {
      expect(entry.value).toBe(0);
    }
  });

  it("never puts one on the shortlist while anything else is worth more than nothing", () => {
    const scored = scoreCandidates([], board(), league("no_k_dst"), demandOf("no_k_dst"));
    const positive = scored.filter((e) => e.value > 0);
    expect(positive.length).toBeGreaterThan(20);
    for (const entry of scored.slice(0, positive.length)) {
      expect(["K", "DST"]).not.toContain(entry.player.position);
    }
  });
});

describe("templateForRoster", () => {
  it("finds each shipped preset from its own counts and rounds", () => {
    for (const template of ROSTER_TEMPLATES) {
      expect(templateForRoster(template.counts, template.rounds)).toBe(template);
    }
  });

  it("treats an absent slot kind and a zero count as the same thing", () => {
    // A provider that lists every kind with a zero must match the same template as one that
    // omits the kinds it does not use.
    expect(
      templateForRoster(
        { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 0, DST: 0, SUPERFLEX: 0 },
        14,
      ),
    ).toBe(NO_K_DST_TEMPLATE);
  });

  it("separates the two presets that share a slot shape", () => {
    expect(templateForRoster(STANDARD_TEMPLATE.counts, 15)).toBe(STANDARD_TEMPLATE);
    expect(templateForRoster(STANDARD_TEMPLATE.counts, 13)).toBe(SHALLOW_BENCH_TEMPLATE);
    // And a roster size neither carries is not either of them.
    expect(templateForRoster(STANDARD_TEMPLATE.counts, 20)).toBeNull();
  });

  it("keeps 2QB and SUPERFLEX apart", () => {
    // A league that must start two quarterbacks is not a league that may. Matching one to
    // the other would draft a back for a slot only a quarterback can fill.
    expect(templateForRoster(TWO_QB_TEMPLATE.counts, 16)).toBe(TWO_QB_TEMPLATE);
    expect(templateForRoster(SUPERFLEX_TEMPLATE.counts, 16)).toBe(SUPERFLEX_TEMPLATE);
    expect(TWO_QB_TEMPLATE.counts).not.toEqual(SUPERFLEX_TEMPLATE.counts);
  });

  it("reports a miss rather than the nearest preset", () => {
    // Three receivers *and* two flexes. Nothing shipped carries it, and answering
    // `three_wr` or `two_flex` would draft against a lineup the user never fields.
    expect(
      templateForRoster(
        { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 2, K: 1, DST: 1 },
        15,
      ),
    ).toBeNull();
    // An extra slot kind nobody ships.
    expect(
      templateForRoster({ ...STANDARD_TEMPLATE.counts, WR_TE: 1 }, 15),
    ).toBeNull();
    // A slot kind this build has no eligibility for at all.
    expect(
      templateForRoster({ ...STANDARD_TEMPLATE.counts, IDP: 2 }, 15),
    ).toBeNull();
    expect(templateForRoster({}, 15)).toBeNull();
  });

  it("matches the templates the no-specialist leagues describe", () => {
    expect(templateForRoster(NO_K_TEMPLATE.counts, 15)).toBe(NO_K_TEMPLATE);
    expect(templateForRoster(NO_DST_TEMPLATE.counts, 15)).toBe(NO_DST_TEMPLATE);
    expect(templateForRoster(TWO_FLEX_TEMPLATE.counts, 15)).toBe(TWO_FLEX_TEMPLATE);
  });
});
