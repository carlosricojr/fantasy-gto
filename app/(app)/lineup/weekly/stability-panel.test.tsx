import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { WeeklyStabilityPanel } from "./stability-panel";

it.each([2, 0, -2])("describes adverse margin %s with a current-starters-only, non-probabilistic scope", (adverseMargin) => {
  const html = renderToStaticMarkup(<WeeklyStabilityPanel stressPoints={1} onStressChange={() => {}} analysis={{ status: "compared", includedGain: 2, variablePlayerIds: ["a", "b"], stressPoints: 1, adverseMargin, eraseAdvantagePoints: 1 }} />);
  expect(html).toContain("Sensitivity versus your current starters");
  expect(html).toContain("±1.00 points per changed player");
  expect(html).toContain(adverseMargin > 0 ? "remains +2.00" : adverseMargin === 0 ? "(a tie)" : "reverse");
  expect(html).toContain("not a measured error range or confidence level");
  expect(html).toContain("not every alternative lineup");
  expect(html).toContain("rounded up to a whole cent");
  expect(html).not.toMatch(/probability|robust best|stable lineup/i);
});
it("does not invent a stress threshold without a starter comparison", () => {
  const html = renderToStaticMarkup(<WeeklyStabilityPanel stressPoints={1} onStressChange={() => {}} analysis={{ status: "unavailable", reason: "No current starters." }} />);
  expect(html).toContain("No current starters.");
  expect(html).not.toContain("<select");
  expect(html).not.toContain("points per changed player");
});
