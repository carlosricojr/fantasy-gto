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

function renderRecommendations(
  onTheClock: boolean,
  ownRecordOnlyPlayers: Parameters<typeof Recommendations>[0]["ownRecordOnlyPlayers"] = [],
) {
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
      ownRecordOnlyPlayers,
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

  it("warns when an own roster player uses a positional floor instead of a personal value", () => {
    const html = renderRecommendations(true, [
      { id: "jacobs", name: "Josh Jacobs", position: "RB" },
    ]);

    expect(html).toContain("Roster player without an active valuation");
    expect(html).toContain("Josh Jacobs (RB) is record-only on this board, without an active valuation");
    expect(html).toContain("unavailable or otherwise outside the valued pool");
    expect(html).toContain("lowest current value at each player");
    expect(html).toContain("position when one is available");
    expect(html).toContain("otherwise a fallback");
    expect(html).toContain("not a personal projection");
    expect(html).toContain("incomplete rather than pick-ready");
  });

  it("does not warn when every own roster player has a normal board value", () => {
    const html = renderRecommendations(true);

    expect(html).not.toContain("Roster player without an active valuation");
    expect(html).not.toContain("record-only on this board");
  });

  it("keeps the missing-value warning visible once the draft is complete", () => {
    const state = {
      recommendations: [],
      teams: 12,
      stale: false,
      loading: false,
      error: null,
      lastElapsedMs: null,
      lastFromCache: false,
      unavailable: null,
    } as unknown as ReturnType<typeof useRecommendations>;
    const html = renderToStaticMarkup(
      createElement(Recommendations, {
        state,
        scenarios: 600,
        candidates: 10,
        onTheClock: false,
        draftComplete: true,
        onPick: () => undefined,
        waitPick: null,
        waitPickLabel: null,
        unrankedAdp: 999,
        basisFor: () => "blend" as ValueBasis,
        ownRecordOnlyPlayers: [{ id: "jacobs", name: "Josh Jacobs", position: "RB" }],
      }),
    );

    expect(html).toContain("The draft is over");
    expect(html).toContain("Roster player without an active valuation");
    expect(html).toContain("Any title estimate from this draft is incomplete");
  });
});
