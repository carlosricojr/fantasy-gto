import { describe, expect, it } from "vitest";

import { solveLineup } from "../core/optimizer";
import {
  DEFAULT_TEMPLATE,
  ROSTER_TEMPLATES,
  SLOT_ELIGIBILITY,
  STANDARD_TEMPLATE,
  SUPERFLEX_TEMPLATE,
  THREE_WR_TEMPLATE,
  buildSlots,
  rosterTemplateById,
  slotsForTemplate,
} from "./roster";

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
    // Three templates that all built the same slots would be three names for one game.
    const shapes = ROSTER_TEMPLATES.map((t) =>
      buildSlots(t.counts)
        .map((s) => s.id)
        .join(","),
    );
    expect(new Set(shapes).size).toBe(ROSTER_TEMPLATES.length);
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
