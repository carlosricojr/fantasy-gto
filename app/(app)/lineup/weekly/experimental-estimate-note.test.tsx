import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { WeeklyPlayer } from "@/lib/nfl/weekly-lineup";
import { WeeklyExperimentalNote } from "./experimental-estimate-note";

const kicker: WeeklyPlayer = { id: "k", name: "Synthetic kicker", positions: ["K"], availability: "active", kickoffAt: 1000, currentSlotId: "k", projectedPoints: 9, projectionOrigin: "experimental", experimentalEstimate: { version: 1, points: 9, method: "kicker-prior-season-game-mean", condition: "active-at-kickoff", historyGames: 9, lastPlayed: { season: 2025, index: 18 }, historyGapWeeks: 1, calibration: "none", scoringScope: "kicking-events-only", excludedRules: ["pass_td", "rush_td"], evidence: "exploratory-development-tuning" } };
it("labels kicker arithmetic, history, active condition, omitted rules and no calibration", () => {
  const html = renderToStaticMarkup(<WeeklyExperimentalNote player={kicker} />);
  for (const phrase of ["Experimental input selected", "kicking events only; no calibration", "9", "2025", "18", "active at kickoff", "pass_td, rush_td", "not prospective validation"]) expect(html).toContain(phrase);
  expect(html).not.toContain("Model estimate");
});
it("keeps provenance visible while not implying a disabled or manual row is selected", () => {
  const html = renderToStaticMarkup(<WeeklyExperimentalNote player={{ ...kicker, projectedPoints: null, projectionOrigin: "manual" }} />);
  expect(html).toContain("Experimental input not selected"); expect(html).toContain("blank manual override does not opt into");
  expect(renderToStaticMarkup(<WeeklyExperimentalNote player={{ ...kicker, experimentalEstimate: undefined }} />)).toBe("");
});
