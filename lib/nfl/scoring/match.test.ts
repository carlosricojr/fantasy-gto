import { describe, expect, it } from "vitest";

import { matchScoringPreset, scoringMatchExplanation } from "./match";
import { HALF_PPR, PPR, SCORING_PRESETS, STANDARD, scoringPresetById } from "./presets";
import type { OffenseScoringRules } from "./types";

/**
 * Reading a league's scoring.
 *
 * The failure this exists to prevent is the quiet one: a league whose rules are not one of
 * the three importing as PPR, drafting against a board built for rules it does not use, with
 * nothing on the screen saying so. Every test here is about refusing to answer rather than
 * about answering.
 */

const of = (preset: { offense: OffenseScoringRules }) => ({ ...preset.offense });

describe("matchScoringPreset finds an exact preset", () => {
  it("recognises each shipped preset from its own rules", () => {
    for (const preset of SCORING_PRESETS) {
      const match = matchScoringPreset(of(preset));
      expect(match.kind).toBe("exact");
      if (match.kind === "exact") expect(match.preset).toBe(preset);
    }
  });

  it("separates the three by the one field that separates them", () => {
    // Reception points, and nothing else. A matcher that compared anything less than every
    // field would call all three the same league.
    expect(PPR.offense.receptionPoints).toBe(1);
    expect(HALF_PPR.offense.receptionPoints).toBe(0.5);
    expect(STANDARD.offense.receptionPoints).toBe(0);
    for (const [points, expected] of [
      [1, PPR],
      [0.5, HALF_PPR],
      [0, STANDARD],
    ] as const) {
      const match = matchScoringPreset({ ...of(PPR), receptionPoints: points });
      expect(match.kind).toBe("exact");
      if (match.kind === "exact") expect(match.preset).toBe(expected);
    }
  });

  it("ignores fields it was not asked to compare", () => {
    // Kicker and defense rules are deliberately outside the comparison — the model projects
    // neither position, so nothing the product shows depends on them, and refusing a
    // genuinely-PPR league over a field-goal tier would block an import for no gain.
    const match = matchScoringPreset({
      ...of(PPR),
      // Extra keys a provider might carry. They are not offensive scoring fields and must
      // not turn an exact match into an unsupported one.
      ...({ fg50to59: 99, sack: 3 } as Record<string, number>),
    });
    expect(match.kind).toBe("exact");
  });
});

describe("matchScoringPreset refuses to guess", () => {
  it("reports what is missing rather than assuming a default", () => {
    const { receptionPoints: _drop, passingTd: _drop2, ...rest } = of(PPR);
    const match = matchScoringPreset(rest);
    expect(match.kind).toBe("incomplete");
    if (match.kind === "incomplete") {
      expect([...match.missing].sort()).toEqual(["passingTd", "receptionPoints"]);
    }
  });

  it("treats null, undefined and NaN as missing rather than as a value", () => {
    // A parsed empty string is NaN, and NaN equals nothing — so an unguarded comparison
    // would answer "unsupported" for a field nobody supplied, which is a different finding
    // and a different message.
    for (const value of [null, undefined, Number.NaN]) {
      const match = matchScoringPreset({ ...of(PPR), receptionPoints: value });
      expect(match.kind).toBe("incomplete");
      if (match.kind === "incomplete") expect(match.missing).toEqual(["receptionPoints"]);
    }
  });

  it("says unsupported for rules no preset carries, and names what differs", () => {
    // A tight-end premium is a receptionPoints value this product has no board for. It is
    // *closest* to PPR and it is not PPR.
    const match = matchScoringPreset({ ...of(PPR), receptionPoints: 1.5, passingTd: 6 });
    expect(match.kind).toBe("unsupported");
    if (match.kind === "unsupported") {
      expect(match.closest).toBe(PPR);
      expect(match.differences).toHaveLength(2);
      expect(match.differences.join(" ")).toContain("receptionPoints: 1.5 vs 1");
      expect(match.differences.join(" ")).toContain("passingTd: 6 vs 4");
    }
  });

  it("never answers with a preset for scoring it does not carry", () => {
    // The whole point. Several plausible real formats, none of them representable.
    const unsupported = [
      { ...of(PPR), passingTd: 6 }, // six-point passing touchdowns
      { ...of(STANDARD), receptionPoints: 0.25 }, // quarter PPR
      { ...of(HALF_PPR), rushingYardsPerPoint: 0.2 }, // one point per five yards
      { ...of(PPR), fumbleLost: 0 },
    ];
    for (const offense of unsupported) {
      const match = matchScoringPreset(offense);
      expect(match.kind).toBe("unsupported");
    }
  });

  it("picks the nearest preset deterministically when nothing matches", () => {
    // Standard rules with one field changed is nearest to standard, not to the first preset
    // in the list. Ties go to the earlier preset, which makes the answer independent of
    // object key order.
    const match = matchScoringPreset({ ...of(STANDARD), passingTd: 6 });
    expect(match.kind).toBe("unsupported");
    if (match.kind === "unsupported") {
      expect(match.closest).toBe(STANDARD);
      expect(match.differences).toEqual(["passingTd: 6 vs 4"]);
    }
  });
});

describe("the difference between an import and a stored preference", () => {
  it("is that only one of them may fall back", () => {
    // `scoringPresetById` answering PPR for an unknown id is right: the user chose one of
    // three and the id is the whole of the choice. `matchScoringPreset` answering PPR for
    // rules it has not seen would be a different league.
    expect(scoringPresetById("not-a-preset")).toBe(PPR);
    expect(matchScoringPreset({}).kind).toBe("incomplete");
    expect(matchScoringPreset({ ...of(PPR), receptionPoints: 2 }).kind).toBe(
      "unsupported",
    );
  });
});

describe("scoringMatchExplanation", () => {
  it("says nothing at all for an exact match", () => {
    expect(scoringMatchExplanation(matchScoringPreset(of(HALF_PPR)))).toBeNull();
  });

  it("names the missing rules and says nothing was chosen", () => {
    const text = scoringMatchExplanation(matchScoringPreset({}))!;
    expect(text).toContain("nothing");
    expect(text).toContain("manually");
    expect(text).toContain("receptionPoints");
  });

  it("names the differences and does not present the nearest preset as the answer", () => {
    const text = scoringMatchExplanation(
      matchScoringPreset({ ...of(PPR), receptionPoints: 1.5 }),
    )!;
    expect(text).toContain("not one of the three");
    expect(text).toContain("receptionPoints: 1.5 vs 1");
    // The closest preset appears only as the thing compared against. A message that read
    // "imported as PPR" is exactly the outcome this issue forbids.
    expect(text).not.toMatch(/imported as|selected|using PPR/i);
    expect(text).toContain("manually");
  });
});
