import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { RosterSlot } from "@/lib/core/optimizer";
import type { PlayerRisk } from "@/lib/core/roster-utility";
import type { ValueBasis } from "@/lib/nfl/draft/provenance";
import { MyTeam } from "./my-team";

const slots: readonly RosterSlot[] = [
  { id: "rb", label: "RB", eligiblePositions: ["RB"] },
];

const roster: readonly PlayerRisk[] = [
  {
    id: "jacobs",
    name: "Josh Jacobs",
    position: "RB",
    weeklyMean: 8,
    p10: 0.5,
    p90: 1.5,
    byeWeek: 7,
    availability: 0.9,
  },
];

function renderTeam(ownRecordOnlyPlayers: Parameters<typeof MyTeam>[0]["ownRecordOnlyPlayers"]) {
  return renderToStaticMarkup(
    createElement(MyTeam, {
      slots,
      roster,
      pickByPlayerId: new Map([["jacobs", 86]]),
      teams: 12,
      playoffWeeks: [15, 16, 17],
      basisFor: () => "blend" as ValueBasis,
      ownRecordOnlyPlayers,
    }),
  );
}

describe("MyTeam record-only caveat", () => {
  it("limits the exact lineup claim when an own player uses positional-floor bookkeeping", () => {
    const html = renderTeam([{ id: "jacobs", name: "Josh Jacobs", position: "RB" }]);

    expect(html).toContain("The slot assignment is solved exactly");
    expect(html).toContain("Josh Jacobs uses positional-floor or fallback bookkeeping value");
    expect(html).toContain("not a personal projection");
    expect(html).toContain("apply to those substitute values");
  });

  it("leaves the standard lineup claim alone for a normally valued roster", () => {
    const html = renderTeam([]);

    expect(html).toContain("The slot assignment is solved exactly");
    expect(html).not.toContain("positional-floor or fallback bookkeeping value");
  });
});
