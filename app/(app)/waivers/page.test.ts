import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WaiverPlanner } from "./planner";

describe("waiver comparison entry contract", () => {
  it("server-renders scope, discovery and no-transactions notice without fetching by navigation", () => {
    const html = renderToStaticMarkup(createElement(WaiverPlanner));
    expect(html).toContain("Waiver comparison");
    expect(html).toContain("One week. One addition and one drop. No transactions submitted.");
    expect(html).toContain("Choose up to 12 unrostered players");
    expect(html).toContain("Load verified league pool");
    expect(html).toContain("not the player’s raw projection");
    expect(html).toContain("No paid data");
    expect(html).toContain("Weekly lineup planner");
    expect(html).not.toContain("Positive included-lineup gain");
    expect(html).not.toContain('href="/sign-in"');
    expect(html).not.toContain('>Sign in</button>');
  });
});
