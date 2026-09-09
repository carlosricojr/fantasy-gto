// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { DecisionResultsReport, DecisionResultsSummary } from "@/components/decision-results-report";
import { summarizeDecisionResults } from "@/lib/nfl/decision-results";
import type { DecisionDetail, DecisionSummary } from "@/components/decision-history";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const row = (id: string): DecisionSummary => ({ _id: id, recordedAt: 1, leagueName: "Private", season: 2026, week: 1, timing: "before-listed-kickoffs" });
const detail = (id: string): DecisionDetail => ({ _id: id, recordJson: JSON.stringify({ version: 1, recordedAt: 1, timing: "before-listed-kickoffs", snapshot: { leagueId: "123", ownerId: "456", leagueName: "Private", season: 2026, week: 1, scoringId: "half-ppr", players: [] }, plan: { status: "ready", excludedPlayerIds: [], excludedSlotIds: [] } }), observations: [] });
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); });
async function mount(transport: Parameters<typeof DecisionResultsReport>[0]["transport"]) {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(h(DecisionResultsReport, { transport, onSelect: vi.fn() })));
}
async function click() { await act(async () => host.querySelector<HTMLButtonElement>("button")!.click()); }

describe("explicit recent-decision review", () => {
  it("does not read automatically and requests at most the bounded first batch", async () => {
    const transport = { list: vi.fn(async () => ({ page: [row("a"), row("b")], isDone: false, continueCursor: "older" })), detail: vi.fn(async (id: string) => detail(id)) };
    await mount(transport);
    expect(transport.list).not.toHaveBeenCalled();
    await click();
    expect(transport.list).toHaveBeenCalledExactlyOnceWith(null);
    expect(transport.detail).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("not your complete season history");
    expect(host.textContent).toContain("Pending / not checked");
    expect(host.textContent).not.toContain("+0.00 points");
  });
  it("does not publish a partial report after a failed or owner-mismatched detail read", async () => {
    const transport = { list: vi.fn(async () => ({ page: [row("a")], isDone: true, continueCursor: "" })), detail: vi.fn(async () => detail("other")) };
    await mount(transport); await click();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).not.toContain("records inspected");
  });
  it("stops further batches and discards replies after account-key unmount", async () => {
    let resolve!: (value: DecisionDetail) => void;
    const pending = new Promise<DecisionDetail>(r => { resolve = r; });
    const transport = { list: vi.fn(async () => ({ page: [row("a"), row("b"), row("c")], isDone: true, continueCursor: "" })), detail: vi.fn((id: string) => id === "a" ? pending : Promise.resolve(detail(id))) };
    await mount(transport); await click();
    expect(transport.detail).toHaveBeenCalledTimes(2);
    await act(async () => root!.unmount()); root = undefined;
    await act(async () => resolve(detail("a")));
    expect(transport.detail).toHaveBeenCalledTimes(2);
    expect(host.textContent).toBe("");
  });
  it("keeps retry disabled until both issued requests settle after asymmetric failure", async () => {
    let finish!: (value: DecisionDetail) => void;
    const sibling = new Promise<DecisionDetail>(resolve => { finish = resolve; });
    const transport = { list: vi.fn(async () => ({ page: [row("a"), row("b")], isDone: true, continueCursor: "" })), detail: vi.fn((id: string) => id === "a" ? Promise.reject(new Error("Read failed")) : sibling) };
    await mount(transport); await click();
    expect(host.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
    await click();
    expect(transport.detail).toHaveBeenCalledTimes(2);
    await act(async () => finish(detail("b")));
    expect(host.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).not.toContain("records inspected");
  });
  it("shows the selection rule, incomplete evidence and non-independence without invented accuracy", () => {
    const report = summarizeDecisionResults([detail("a")]);
    const html = renderToStaticMarkup(h(DecisionResultsSummary, { report, hasOlder: false, onSelect: vi.fn() }));
    expect(html).toContain("selected without looking at outcomes");
    expect(html).toContain("not independent trials");
    expect(html).toContain("Saving decisions selectively can bias");
    expect(html).toContain("No completed comparisons yet");
    expect(html).not.toContain("MAE");
    expect(html).toContain("Team owner ID: ");
    expect(html).toContain("half-ppr");
    expect(html).toContain("Group 1 team and exact scoring");
  });
});
