import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DraftEvidencePanel } from "./evidence-panel";
import DraftEvidencePage from "./evidence/page";
import { describe, expect, it } from "vitest";
import type { DraftPolicyState } from "@/lib/core/draft-policy";
import type { PlayerRisk } from "@/lib/core/roster-utility";
import { marketFirstOption } from "./market-first";
import { MarketFirstCard } from "./market-first-card";

const slots = [{ id: "qb", label: "QB", eligiblePositions: ["QB"] }, { id: "wr", label: "WR", eligiblePositions: ["WR"] }];
const player = (id: string, position: string, adp: number | null): PlayerRisk => ({ id, name: id, position, adp, adpStdev: null, weeklyMean: 10, p10: 0.5, p90: 1.5, availability: 1, byeWeek: null });
function state(): DraftPolicyState {
  return { myTeamIndex: 0, rosterSize: 3, teams: [{ id: "mine", name: "Mine", roster: [player("held", "WR", 1)], remainingPicks: [1, 4] }, { id: "other", name: "Other", roster: [], remainingPicks: [2, 3] }], available: [player("cheap", "WR", 5), player("quarterback", "QB", 50), player("other-qb", "QB", 60)] };
}

describe("immediate market comparator", () => {
  it("connects the visible experimental status to an accessible in-app evidence summary", () => {
    const panel = renderToStaticMarkup(createElement(DraftEvidencePanel));
    expect(panel).toContain('aria-label="Draft strategy evidence"');
    expect(panel).toContain("Experimental · not promoted");
    expect(panel).toContain("recommendation list still ranks by experimental simulation");
    expect(panel).toContain('href="/draft/evidence"');
    const summary = renderToStaticMarkup(createElement(DraftEvidencePage));
    expect(summary).toContain("descriptive diagnostic, not a proven drafting edge");
    expect(summary).toContain("reserved 2025 outcomes were not evaluated");
    expect(summary).toContain("Needed:");
    expect(summary).toContain("What we still need to prove");
    expect(summary).toContain("deserves more trust than the simple alternatives");
    expect(summary).toContain("Technical review requirements");
    expect(summary.indexOf("Gate version:")).toBeGreaterThan(summary.indexOf("<details"));
    expect(summary).not.toContain("Met:");
    expect(summary).toContain("Browser/mobile latency within the registered budget");
    expect(summary).toContain("does not automatically promote");
    expect(summary).toContain('href="/draft"');
  });
  it("sorts by actual ADP without ranking null ahead of priced players", () => {
    const current = state(); current.available.push(player("unpriced", "WR", null));
    expect(marketFirstOption(current, slots)?.id).toBe("cheap");
  });
  it("respects the final starter deadline and traded draft capacity", () => {
    const current = state(); current.teams[0].draftRosterSize = 2;
    expect(marketFirstOption(current, slots)?.id).toBe("quarterback");
  });
  it("protects the last required position before intervening opponents", () => {
    const current = state(); current.available = current.available.filter(p => p.id !== "other-qb");
    expect(marketFirstOption(current, slots)?.id).toBe("quarterback");
  });
  it("does not label a future-turn player as currently draftable", () => {
    const current = state(); current.teams[0].remainingPicks = [4];
    expect(marketFirstOption(current, slots)).toBeNull();
  });
  it("does not manufacture a legal market option for impossible or unpriced pools", () => {
    const current = state(); current.available = [player("only-wr", "WR", 5)];
    expect(marketFirstOption(current, slots)).toBeNull();
    current.available = [player("only-qb", "QB", null)];
    expect(marketFirstOption(current, slots)).toBeNull();
    current.available[0].adp = undefined;
    expect(marketFirstOption(current, slots)).toBeNull();
  });
  it("excludes already-held identities even if a malformed pool repeats them", () => {
    const current = state(); current.teams[1].roster.push(current.available[0]);
    expect(marketFirstOption(current, slots)?.id).toBe("quarterback");
  });
  it("does not advise when actual pick capacity is exhausted", () => {
    const current = state(); current.teams[0].draftRosterSize = 1;
    expect(marketFirstOption(current, slots)).toBeNull();
  });
  it("labels market provenance and limitations without championship odds", () => {
    const html = renderToStaticMarkup(createElement(MarketFirstCard, { player: player("Market Player", "WR", 42), onPick: () => undefined }));
    expect(html).toContain("Market-first legal option");
    expect(html).toContain("FantasyFootballCalculator");
    expect(html).toContain("not a proven best pick");
    expect(html).toContain("Record Market Player");
    expect(html).not.toContain("title chance");
  });
});
