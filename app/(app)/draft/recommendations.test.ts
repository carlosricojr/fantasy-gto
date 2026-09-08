import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ChampionshipRecommendation } from "@/lib/core/draft-policy";
import type { ValueBasis } from "@/lib/nfl/draft/provenance";
import type { useRecommendations } from "./use-recommendations";
import { Recommendations } from "./recommendations";

/** A complete enough recommendation to exercise the user-facing interpretation contract. */
function recommendation(
  id: string,
  name: string,
  championshipProbability: number,
  tiedWithLeader: boolean,
): ChampionshipRecommendation {
  return {
    player: {
      id,
      name,
      position: "WR",
      weeklyMean: 12,
      p10: 0.5,
      p90: 1.5,
      byeWeek: 7,
      availability: 0.9,
      adp: 120,
      adpStdev: 12,
    },
    championshipProbability,
    deltaVsBaseline: 0.007,
    playoffProbability: 0.4,
    expectedPoints: 1_850,
    standardError: 0.008,
    tiedWithLeader,
    vsLeader: tiedWithLeader
      ? {
          n: 600,
          candidateOnly: 12,
          baselineOnly: 13,
          agreed: 575,
          meanDifference: -0.002,
          standardError: 0.006,
          interval: [-0.014, 0.01],
          confidenceLevel: 95,
        }
      : null,
  };
}

function renderRecommendations(onTheClock: boolean) {
  const state = {
    recommendations: [
      recommendation("parker", "Parker Washington", 0.042, true),
      recommendation("michael", "Michael Wilson", 0.04, true),
    ],
    teams: 12,
    stale: false,
    loading: false,
    error: null,
    lastElapsedMs: null,
    lastFromCache: false,
    unavailable: null,
  } as ReturnType<typeof useRecommendations>;

  return renderToStaticMarkup(
    createElement(Recommendations, {
      state,
      scenarios: 600,
      candidates: 10,
      onTheClock,
      draftComplete: false,
      onPick: () => undefined,
      waitPick: null,
      waitPickLabel: null,
      unrankedAdp: 999,
      basisFor: () => "blend" as ValueBasis,
    }),
  );
}

describe("Recommendations interpretation", () => {
  it("labels title chance as conditional simulation output, not an equal-odds baseline", () => {
    const html = renderRecommendations(true);

    expect(html).toContain("4.2%");
    expect(html).toContain("± 0.8 pp");
    expect(html).toContain("simulated title chance");
    expect(html).toContain("sampling error only");
    expect(html).toContain("vs. default policy pick");
    expect(html).toContain("not vs. equal odds");
    expect(html).toContain("An even pre-draft reference in a 12-team league is 8.3%");
    expect(html).toContain("(1 in 12)");
    expect(html).toContain("not all uncertainty");
    expect(html).toContain("one standard error from 600 simulated seasons");
  });

  it("keeps the clock context and displayed probability order when candidates are tied", () => {
    const onClock = renderRecommendations(true);
    const waiting = renderRecommendations(false);

    expect(onClock).toContain("Your pick");
    expect(waiting).toContain("If the board holds");
    expect(onClock).toContain("Viable alternatives");
    expect(onClock).toContain("these simulations do not reliably separate the choices");
    expect(onClock).toContain("Viable alternative · tied in this simulation");
    expect(onClock.indexOf("Take Parker Washington")).toBeLessThan(
      onClock.indexOf("Michael Wilson"),
    );
  });

  it("uses the team count that arrived with the recommendation snapshot", () => {
    const html = renderRecommendations(true);

    // `Recommendations` receives the count only from `RecommendationState`, which the hook
    // binds to the reply id. It cannot borrow a newly selected league's size while that
    // league retargets the worker.
    expect(html).toContain("An even pre-draft reference in a 12-team league is 8.3%");
  });
});
