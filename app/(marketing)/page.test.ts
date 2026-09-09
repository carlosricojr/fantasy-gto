import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import MarketingPage from "./page";

describe("public lineup optimality claims", () => {
  it("binds exactness to the projected objective and constraints, not realized results", () => {
    const text = renderToStaticMarkup(createElement(MarketingPage));
    expect(text).toContain("Exact lineup assignment");
    expect(text).toContain("same supplied projections, eligibility, locks and exclusions");
    expect(text).toContain("does not guarantee the highest actual score");
    expect(text).not.toContain("can leave real points on the bench");
    expect(text).not.toContain("Every lineup is the highest-scoring arrangement");
  });
});
