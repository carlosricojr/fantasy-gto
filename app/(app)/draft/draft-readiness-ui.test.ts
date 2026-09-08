import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BoardGrid } from "./board-grid";
import { LeagueForm } from "./league-form";
import { StatusBar } from "./status-bar";
import { DraftSetup } from "./setup";
import { describeTurn } from "./board-view";

describe("live-draft incident regressions", () => {
  it("counts future keepers without moving the first open pick", () => {
    const html = renderToStaticMarkup(createElement(StatusBar, {
      turn: describeTurn({ currentPick: 2, totalPicks: 160, teams: 10, slot: 5, owner: 1 }),
      pickLabel: "1.02", currentPick: 2, recordedCount: 20, totalPicks: 160,
      picksUntilTurn: 2, nextOwnPickLabel: "1.05", canUndo: false, onUndo: () => {}, onOpenSettings: () => {},
    }));
    expect(html).toContain("20 of 160 picks recorded");
    expect(html).toContain("1.02");
  });
  it("explains an unavailable custom board without suggesting different league rules", () => {
    const html = renderToStaticMarkup(createElement(DraftSetup, {
      settings: { teams: 10, rounds: 16, slot: 5, playoffTeams: 6, championshipWeek: 17, scoringId: "ppr", templateId: "two_flex" },
      onChange: () => {}, onStart: () => {}, boardSize: 0, boardBlock: "Exact custom board is not published.",
      season: 2026, leagueSizes: [10], scoringConfirmed: true, slotConfirmed: true,
    }));
    expect(html).toContain("Exact custom board is not published.");
    expect(html).not.toContain("Choose another size");
    expect(html).not.toContain("Start draft");
  });
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
