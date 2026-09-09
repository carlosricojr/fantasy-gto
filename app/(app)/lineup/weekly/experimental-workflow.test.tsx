// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { entitlementsFor } from "@/lib/billing/entitlements";
import { parseWeeklyDecisionInput } from "@/lib/nfl/decision-journal-inputs";
import type { WeeklyLineupSnapshot } from "@/lib/nfl/weekly-lineup";

const session = vi.hoisted(() => ({ id: "a", saves: [] as { snapshotJson: string; preferencesJson: string }[] }));
vi.mock("@clerk/nextjs", () => ({ useUser: () => ({ user: { id: session.id } }) }));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useQuery: () => ({ signedIn: true, entitlements: entitlementsFor({ planId: "pro", status: "active", pastDueSince: null, currentPeriodEnd: null }, Date.now()) }),
  useMutation: () => async (args: { snapshotJson: string; preferencesJson: string }) => { session.saves.push(args); return "local-test-decision"; },
}));
import WeeklyLineupPage from "./page";

const now = Date.UTC(2026, 8, 9, 12);
let root: Root; let container: HTMLDivElement;
function fixture(): WeeklyLineupSnapshot {
  return { leagueId: "123", ownerId: "456", leagueName: "Synthetic experimental QA", season: 2026, week: 1, scoringId: "ppr", source: "Synthetic model", retrievedAt: now, rosterRetrievedAt: now, projectionUpdatedAt: null, slots: [{ id: "rb", label: "RB", eligiblePositions: ["RB"] }], players: [
    { id: "a", name: "Current runner", positions: ["RB"], availability: "active", kickoffAt: now + 3_600_000, currentSlotId: "rb", projectedPoints: 10, projectionOrigin: "model" },
    { id: "b", name: "Returning runner", positions: ["RB"], availability: "active", kickoffAt: now + 3_600_000, currentSlotId: null, projectedPoints: null, projectionOrigin: "model", projectionMissingReason: "Recent history gate", experimentalEstimate: { version: 1, points: 15, method: "frozen-model-returning-history", condition: "active-at-kickoff", historyGames: 12, lastPlayed: { season: 2025, index: 14 }, historyGapWeeks: 5, calibration: "ppr-only", scoringScope: "supported-offense", excludedRules: ["rec_2pt"], evidence: "exploratory-development-tuning" } },
  ], model: { source: "Synthetic model", computedAt: now, providerUpdatedAt: null, excludedRules: [], warnings: [], coverage: { requested: 2, projected: 1 } } };
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
  session.id = "a"; session.saves = [];
  window.history.replaceState({}, "", "/lineup/weekly?leagueId=123&ownerId=456&week=1"); window.localStorage.clear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => fixture() })));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function render() { await act(async () => root.render(<WeeklyLineupPage />)); }
const checkbox = (prefix: string) => [...container.querySelectorAll("label")].find((label) => label.textContent?.startsWith(prefix))!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
const experimental = () => checkbox("Include experimental week-one");
const points = () => container.querySelector<HTMLInputElement>('input[aria-label="Supplied points for Returning runner"]')!;
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === text)!;
  expect(button).toBeDefined(); await act(async () => button.click());
}
async function toggle(input: HTMLInputElement) { await act(async () => input.click()); }
async function change(input: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function enableAndImport() {
  await render(); await toggle(experimental()); await click("Import roster and generate estimates");
}

it("defaults off and does not request or apply an unsolicited experimental row", async () => {
  await render(); expect(experimental().checked).toBe(false);
  await click("Import roster and generate estimates");
  expect(String(vi.mocked(fetch).mock.calls[0][0])).not.toContain("experimental=");
  expect(points().value).toBe(""); expect(container.textContent).toContain("Experimental input not selected");
});
it("requires independent explicit consent and incomplete-comparison consent; saves correct provenance", async () => {
  await enableAndImport();
  expect(experimental().checked).toBe(true); expect(points().value).toBe("15");
  const url = String(vi.mocked(fetch).mock.calls[0][0]);
  expect(url).toContain("experimental=coverage-baselines"); expect(url).not.toContain("conditional=");
  expect(checkbox("Generate provisional").checked).toBe(false);
  expect(container.textContent).toContain("Inputs needed before a recommendation");
  await toggle(checkbox("Compare incomplete estimates"));
  expect(container.textContent).toContain("Start Returning runner at RB");
  expect(container.textContent).toContain("1 ordinary estimates for 2 rostered players");
  expect(container.textContent).toContain("1 experimental baselines selected");
  expect(container.textContent).toContain("Some supplied inputs are experimental baselines");
  expect(container.textContent).toContain("rec_2pt");
  await click("Save this decision");
  expect(session.saves).toHaveLength(1);
  const saved = parseWeeklyDecisionInput(session.saves[0].snapshotJson, session.saves[0].preferencesJson);
  expect(saved.preferences).toMatchObject({ allowExperimentalEstimates: true, allowConditionalEstimates: false, compareAvailableEstimates: true });
  expect(saved.snapshot.players[1]).toMatchObject({ projectedPoints: 15, projectionOrigin: "experimental", experimentalEstimate: { method: "frozen-model-returning-history", excludedRules: ["rec_2pt"] } });
  // Automatic and experimental values are not persisted as browser manual entries.
  const stored = window.localStorage.getItem("fantasygto.weekly-manual.v1:a") ?? "";
  expect(stored).not.toContain('"points":15');
});
it("disabling removes experimental values immediately without a request, not ordinary points", async () => {
  await enableAndImport(); await toggle(checkbox("Compare incomplete estimates"));
  await toggle(experimental());
  expect(points().value).toBe("");
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Supplied points for Current runner"]')!.value).toBe("10");
  expect(container.textContent).not.toContain("Start Returning runner at RB");
  expect(container.textContent).not.toContain("Some supplied inputs are experimental baselines");
  expect(fetch).toHaveBeenCalledTimes(1);
  await click("Save this decision");
  const saved = parseWeeklyDecisionInput(session.saves[0].snapshotJson, session.saves[0].preferencesJson);
  expect(saved.preferences.allowExperimentalEstimates).toBe(false);
  expect(saved.snapshot.players[1]).toMatchObject({ projectedPoints: null, projectionOrigin: "model" });
});
it("manual overrides, including a cleared override, are not replaced by consent toggles", async () => {
  await enableAndImport(); await change(points(), "18");
  expect(points().value).toBe("18");
  await toggle(experimental()); await toggle(experimental()); expect(points().value).toBe("18");
  await change(points(), ""); await toggle(experimental()); await toggle(experimental()); expect(points().value).toBe("");
  expect(container.textContent).toContain("Manual override cleared");
});
it.each(["Sleeper league ID", "Sleeper user ID", "Current week"])("clears consent and results after editing %s", async (labelText) => {
  await enableAndImport();
  const input = [...container.querySelectorAll("label")].find((label) => label.textContent === labelText)!.querySelector("input")!;
  await change(input, labelText === "Current week" ? "2" : "999");
  expect(experimental().checked).toBe(false); expect(points()).toBeNull();
});
it("clears consent on account switch and changed imported scoring context", async () => {
  await enableAndImport();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ...fixture(), scoringId: "standard" }) })));
  await click("Refresh roster and model estimates");
  expect(experimental().checked).toBe(false); expect(points().value).toBe("");
  await toggle(experimental()); session.id = "b"; await render();
  expect(experimental().checked).toBe(false); expect(points()).toBeNull();
});
it("clears consent after failed refresh or model generation even with successful roster import", async () => {
  await enableAndImport();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ error: "Upstream failed" }) })));
  await click("Refresh roster and model estimates");
  expect(experimental().checked).toBe(false); expect(points().value).toBe("");
  expect(container.textContent).toContain("Inputs needed before a recommendation");
  await toggle(experimental());
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ...fixture(), model: undefined, warnings: ["Automatic estimates unavailable"] }) })));
  await click("Refresh roster and model estimates"); expect(experimental().checked).toBe(false);
});
it("honors revocation while an experimental request is in flight", async () => {
  await render(); await toggle(experimental());
  let complete!: (value: unknown) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => { complete = resolve; })));
  await click("Import roster and generate estimates"); await toggle(experimental());
  await act(async () => complete({ ok: true, json: async () => fixture() }));
  expect(experimental().checked).toBe(false); expect(points().value).toBe("");
});
it.each(["out", "started"])("does not apply experimental points to a %s bench player", async (state) => {
  vi.stubGlobal("fetch", vi.fn(async () => {
    const data = fixture();
    return { ok: true, json: async () => ({ ...data, players: data.players.map((p) => p.id !== "b" ? p : { ...p, ...(state === "out" ? { availability: "out" } : { kickoffAt: now - 1 }) }) }) };
  }));
  await enableAndImport();
  expect(points().value).toBe(""); expect(container.textContent).not.toContain("Start Returning runner at RB");
});
