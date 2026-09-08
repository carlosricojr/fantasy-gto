import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BoardGrid } from "./board-grid";
import { LeagueForm } from "./league-form";

describe("live-draft incident regressions", () => {
  it("offers 17 rounds before importing or editing storage", () => {
    const html = renderToStaticMarkup(createElement(LeagueForm, {
      value: { teams: 12, rounds: 16, slot: 11, playoffTeams: 6, championshipWeek: 17, scoringId: "ppr", templateId: "two_flex" },
      onChange: () => {},
    }));
    const rounds = html.match(/aria-label="Rounds"[^]*?<\/div>/)?.[0];
    expect(rounds).toBeDefined();
    expect(rounds).toContain('>17</button>');
  });
  it("renders a recorded unknown player as occupied, not an empty pick", () => {
    const html = renderToStaticMarkup(createElement(BoardGrid, {
      teams: 2, slot: 1, rounds: 1, picks: { 1: "unlisted:Kareem Hunt", 2: "lost-catalog-id" },
      playersById: new Map(), currentPick: 3, pickOwners: new Map([[1, 0], [2, 1]]),
    }));
    expect(html).toContain("Kareem Hunt");
    expect(html).toContain("Unlisted player");
    expect(html).toContain("Recorded · no valuation");
    expect(html).not.toContain("not yet picked");
  });
});
