import { describe, expect, it } from "vitest";

import { DRAFTABLE_POSITIONS, MODELED_POSITIONS } from "./config";
import { OUTCOME_QUANTILES, PLACEHOLDER_QUANTILES } from "../model/config";
import {
  type ValueBasis,
  basisBadge,
  basisExplanation,
  hasMeasuredSpread,
  isMarketOnly,
  isModeledPosition,
  marketEstimateExplanation,
  recommendationCaveat,
  valueBasis,
} from "./provenance";

/**
 * Where a number came from.
 *
 * The label has to be attached to the number it limits, and it has to be *right* for every
 * position rather than for the two it was written about. A label that leaked onto a running
 * back would be worse than none: it would say the model has no view of a position it is
 * measured on.
 */

const row = (
  position: string,
  modelPoints: number | null,
  marketPoints: number | null,
  marketValueBasis?: "adp-ordered" | "position-mean" | "pooled-mean" | null,
) => ({ position, modelPoints, marketPoints, marketValueBasis });

describe("isModeledPosition", () => {
  it("is exactly the positions the weekly model projects", () => {
    expect([...MODELED_POSITIONS]).toEqual(["QB", "RB", "WR", "TE"]);
    for (const position of MODELED_POSITIONS) {
      expect(isModeledPosition(position)).toBe(true);
    }
    expect(isModeledPosition("K")).toBe(false);
    expect(isModeledPosition("DST")).toBe(false);
  });

  it("does not treat an unknown position as modeled", () => {
    // A draftable position added later, or a typo out of a provider payload. Defaulting to
    // "modeled" would suppress the caveat on exactly the rows nobody has checked.
    for (const position of ["", "IDP", "P", "qb", "RB ", "DEF", "PK"]) {
      expect(isModeledPosition(position)).toBe(false);
    }
  });

  it("covers every draftable position one way or the other", () => {
    // The board carries more positions than the model projects, which is the whole reason
    // this module exists. Both sets are asserted so a position added to one and not the
    // other is caught here rather than by a blank badge on a real board.
    expect([...DRAFTABLE_POSITIONS].filter((p) => !isModeledPosition(p))).toEqual([
      "K",
      "DST",
    ]);
  });
});

describe("valueBasis", () => {
  it("names the position case before the history case", () => {
    // A veteran kicker has a history row per game and every one of them scores zero, so
    // "has history" once said the model had an opinion when the position was about to
    // overrule it — and marked every veteran kicker down by twenty percent. The order of
    // these two checks is the fix, and this is the test that keeps it.
    expect(valueBasis(row("K", 0, 90))).toBe("market-only-position");
    expect(valueBasis(row("K", 120, 90))).toBe("market-only-position");
    expect(valueBasis(row("DST", null, 90))).toBe("market-only-position");
  });

  it("separates a rookie from an unprojectable position", () => {
    // Both carry the market's price alone and they are not the same limitation: one goes
    // away after week one, the other never does.
    expect(valueBasis(row("RB", null, 200))).toBe("market-only-history");
    expect(valueBasis(row("K", null, 90))).toBe("market-only-position");
    expect(basisExplanation("market-only-history")).toContain("No prior games");
    expect(basisExplanation("market-only-position")).toContain(
      "does not cover this position",
    );
  });

  it("names the ordinary case a blend and the marketless one model-only", () => {
    expect(valueBasis(row("WR", 180, 200))).toBe("blend");
    expect(valueBasis(row("WR", 180, 200, "adp-ordered"))).toBe("blend");
    expect(valueBasis(row("WR", 180, null))).toBe("model-only");
  });

  it("distinguishes an exact flat market curve from an ADP-ordered blend", () => {
    expect(valueBasis(row("QB", 240, 247, "position-mean"))).toBe(
      "blend-position-mean",
    );
    expect(valueBasis(row("QB", 240, 247, "pooled-mean"))).toBe(
      "blend-pooled-mean",
    );
    expect(valueBasis(row("QB", null, 247, "position-mean"))).toBe(
      "market-only-history-position-mean",
    );
  });

  it("names a row neither side priced", () => {
    expect(valueBasis(row("K", null, null))).toBe("unpriced");
    expect(valueBasis(row("TE", null, null))).toBe("unpriced");
  });

  it("treats a zero market price as a price", () => {
    // `??`-style falsiness would call a zero-priced player unpriced. Nothing on a real board
    // carries zero, which is exactly why a `!row.marketPoints` would survive review.
    expect(valueBasis(row("K", null, 0))).toBe("market-only-position");
    expect(valueBasis(row("WR", 0, 0))).toBe("blend");
  });
});

describe("the labels themselves", () => {
  it("warns about every basis except the ordinary one", () => {
    const bases: ValueBasis[] = [
      "blend",
      "model-only",
      "market-only-position",
      "market-only-history",
      "blend-position-mean",
      "blend-pooled-mean",
      "market-only-history-position-mean",
      "market-only-history-pooled-mean",
      "market-only-position-position-mean",
      "market-only-position-pooled-mean",
      "unpriced",
    ];
    for (const basis of bases) {
      const badge = basisBadge(basis);
      if (basis === "blend") expect(badge).toBeNull();
      else expect(badge).toBeTruthy();
      // Every basis has a sentence, so a case added without one shows up here rather than
      // as `undefined` in the interface.
      expect(basisExplanation(basis).length).toBeGreaterThan(20);
    }
  });

  it("says market only for the two positions the model does not cover", () => {
    expect(basisBadge(valueBasis(row("K", null, 90)))).toBe("market only");
    expect(basisBadge(valueBasis(row("DST", null, 90)))).toBe("market only");
  });

  it("says nothing at all for a projected player", () => {
    // The leak this module is most at risk of. A badge on a running back would tell a reader
    // the model has no view of a position it is measured on.
    for (const position of MODELED_POSITIONS) {
      expect(basisBadge(valueBasis(row(position, 180, 200)))).toBeNull();
      expect(recommendationCaveat(position)).toBeNull();
    }
  });

  it("classifies market-only correctly and nothing else", () => {
    expect(isMarketOnly("market-only-position")).toBe(true);
    expect(isMarketOnly("market-only-history")).toBe(true);
    expect(isMarketOnly("market-only-history-position-mean")).toBe(true);
    expect(isMarketOnly("market-only-position-pooled-mean")).toBe(true);
    expect(isMarketOnly("blend")).toBe(false);
    expect(isMarketOnly("model-only")).toBe(false);
    expect(isMarketOnly("unpriced")).toBe(false);
  });
});

describe("the market estimate disclosure", () => {
  it("says explicitly when the selected curve carries no ADP ordering", () => {
    expect(marketEstimateExplanation(247, "position-mean")).toContain(
      "carries no within-position ADP ordering",
    );
    expect(marketEstimateExplanation(247, "position-mean")).toContain(
      "position’s historical mean",
    );
    expect(marketEstimateExplanation(247, "pooled-mean")).toContain(
      "pooled historical mean",
    );
    expect(marketEstimateExplanation(247, "position-mean")).not.toContain("constrained");
  });

  it("does not apply the flat-curve disclosure to ordered or legacy rows", () => {
    for (const basis of ["adp-ordered", null, undefined] as const) {
      expect(marketEstimateExplanation(247, basis)).not.toContain("carries no");
      expect(marketEstimateExplanation(247, basis)).toContain("average draft position");
    }
  });

  it("says a row with no recorded basis is unknown rather than calling it ADP-ordered", () => {
    // The schema makes `marketValueBasis` optional so an older row can decline to answer,
    // and says readers must treat that as unknown. This is where that promise is kept or
    // broken: the sentence for an absent basis has to differ from the one for a row that
    // really was fitted per position.
    const ordered = marketEstimateExplanation(247, "adp-ordered");
    expect(ordered).toContain("fitted per position");
    for (const basis of [null, undefined] as const) {
      const unknown = marketEstimateExplanation(247, basis);
      expect(unknown).not.toBe(ordered);
      expect(unknown).not.toContain("fitted per position");
      expect(unknown).toContain("unknown");
    }
  });

  it("does not describe an ADP fit when no market estimate exists", () => {
    const explanation = marketEstimateExplanation(null, null);
    expect(explanation).toContain("no market estimate is available");
    expect(explanation).not.toContain("average draft position");
  });
});

describe("the weekly spread behind a row", () => {
  it("agrees with the band the ingest actually writes", () => {
    // `hasMeasuredSpread` exists because a recommendation carries a `PlayerRisk`, which has
    // the quantiles but not where they came from. It has to give the same answer the stored
    // row does, so it is asserted against `OUTCOME_QUANTILES` — including the fallback,
    // which is the branch `convex/ingest.ts` reaches for a position with no entry.
    for (const position of DRAFTABLE_POSITIONS) {
      const band =
        OUTCOME_QUANTILES[position as keyof typeof OUTCOME_QUANTILES] ??
        PLACEHOLDER_QUANTILES;
      expect(hasMeasuredSpread(position)).toBe(band.provenance === "measured");
    }
    expect(hasMeasuredSpread("LS")).toBe(false);
  });

  it("is not the same question as whether the model projects the position", () => {
    // The discriminating case, and the reason this function may not answer
    // `isModeledPosition`: both bands are measured, neither position is projected. Keying
    // on projection would make the recommendation contradict the row beside it.
    for (const position of ["K", "DST"]) {
      expect(hasMeasuredSpread(position)).toBe(true);
      expect(isModeledPosition(position)).toBe(false);
    }
  });

  it("caveats exactly the positions the model does not project", () => {
    for (const position of DRAFTABLE_POSITIONS) {
      const caveat = recommendationCaveat(position);
      if (isModeledPosition(position)) expect(caveat).toBeNull();
      else expect(caveat).toContain("does not cover this position");
    }
  });

  it("never claims a projection for a kicker or a defense", () => {
    const caveat = recommendationCaveat("K")!;
    // The sentence a reader sees does not use calibrated-model language for them...
    expect(caveat).not.toMatch(/calibrat/i);
    expect(caveat).not.toMatch(/\bedge\b/i);
    expect(caveat).toContain("Market price only");
    // ...and it no longer disclaims a spread that is now measured, which would be the
    // opposite failure: a true limitation replaced by a false one.
    expect(caveat).not.toMatch(/placeholder/i);
    expect(caveat).not.toMatch(/assumed/i);
  });
});
