// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { entitlementsFor } from "@/lib/billing/entitlements";
import type { WeeklyLineupSnapshot } from "@/lib/nfl/weekly-lineup";

const session = vi.hoisted(() => ({ id: "a", authenticated: true }));
// Only external infrastructure is substituted; all product modules execute.
vi.mock("@clerk/nextjs", () => ({ useUser: () => ({ user: session.authenticated ? { id: session.id } : null }) }));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: session.authenticated }),
  useQuery: () => ({ signedIn: session.authenticated, entitlements: entitlementsFor({ planId: "pro", status: "active", pastDueSince: null, currentPeriodEnd: null }, Date.now()) }),
  useMutation: () => vi.fn(),
}));
import WeeklyLineupPage from "./page";

let root: Root; let container: HTMLDivElement;
const now = Date.UTC(2026, 8, 9, 12);
function fixture(): WeeklyLineupSnapshot {
  return { leagueId: "123", ownerId: "456", leagueName: "Synthetic local test league", season: 2026, week: 1, scoringId: "ppr", source: "Manual", retrievedAt: now, rosterRetrievedAt: now, projectionUpdatedAt: now, slots: [{ id: "rb", label: "RB", eligiblePositions: ["RB"] }], players: [10, 15].map((points, i) => ({ id: String(i), name: `Runner ${i}`, positions: ["RB"], availability: "active", kickoffAt: now + 3_600_000, currentSlotId: i === 0 ? "rb" : null, projectedPoints: points, projectionOrigin: "manual", projectionEnteredAt: now })) };
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
  session.id = "a"; session.authenticated = true;
  window.history.replaceState({}, "", "/lineup/weekly?leagueId=123&ownerId=456&week=1");
  window.localStorage.clear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => fixture() })));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function render() { await act(async () => root.render(<WeeklyLineupPage />)); }
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === text)!;
  expect(button).toBeDefined(); await act(async () => button.click());
}
const panel = () => container.querySelector('section[aria-labelledby="weekly-stability-heading"]');

it("updates only the stress explanation, hides authenticated sign-in, clears on account switch", async () => {
  await render();
  expect(container.querySelector('a[href="/sign-in"]')).toBeNull();
  await click("Import roster and generate estimates");
  expect(panel()?.textContent).toContain("±2.50 points per changed player");
  expect(panel()?.textContent).toContain("remains +3.00");
  const select = panel()!.querySelector("select")!;
  await act(async () => { select.value = "5"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(panel()?.textContent).toContain("reverse");
  expect(container.textContent).toContain("Start Runner 1 at RB");
  expect(container.textContent).toContain("+5.00 included-estimate points");
  expect(fetch).toHaveBeenCalledTimes(1);
  session.id = "b"; await render();
  expect(panel()).toBeNull(); expect(container.textContent).not.toContain("Runner 1");
});
it("removes the stress result when freshness fails and after a failed refresh", async () => {
  await render(); await click("Import roster and generate estimates");
  expect(panel()).not.toBeNull();
  vi.setSystemTime(now + 16 * 60_000);
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(panel()).toBeNull(); expect(container.textContent).toContain("Inputs needed before a recommendation");
  vi.setSystemTime(now); await act(async () => window.dispatchEvent(new Event("focus")));
  expect(panel()).not.toBeNull();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ error: "Source unavailable" }) })));
  await click("Refresh roster and model estimates");
  expect(panel()).toBeNull(); expect(container.textContent).toContain("Source unavailable");
});
it("does not display an old result while a refresh is in flight", async () => {
  await render(); await click("Import roster and generate estimates");
  let complete!: (value: unknown) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => { complete = resolve; })));
  await click("Refresh roster and model estimates"); expect(panel()).toBeNull();
  await act(async () => complete({ ok: true, json: async () => fixture() }));
  expect(panel()).not.toBeNull();
});
it("retains the sign-in invitation only for signed-out viewers", async () => {
  session.authenticated = false; await render();
  expect(container.querySelector('a[href="/sign-in"]')?.textContent).toBe("Sign in");
  expect(panel()).toBeNull(); expect(fetch).not.toHaveBeenCalled();
});
