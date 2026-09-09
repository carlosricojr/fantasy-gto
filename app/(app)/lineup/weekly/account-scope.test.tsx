// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { entitlementsFor } from "@/lib/billing/entitlements";

const session = vi.hoisted(() => ({ id: "account-a", loading: false, saves: [] as { account: string; league: string }[] }));
vi.mock("@clerk/nextjs", () => ({ useUser: () => ({ user: { id: session.id } }) }));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: session.loading, isAuthenticated: !session.loading }),
  useQuery: () => ({ signedIn: true, entitlements: entitlementsFor({ planId: "pro", status: "active", pastDueSince: null, currentPeriodEnd: null }, Date.now()) }),
  useMutation: () => vi.fn(),
}));
vi.mock("@/components/sleeper-connection-finder", () => ({ SleeperConnectionFinder: () => null }));
vi.mock("@/components/weekly-decision-save", () => ({ WeeklyDecisionSave: ({ snapshot }: { snapshot: { leagueName: string } }) => {
  session.saves.push({ account: session.id, league: snapshot.leagueName });
  return <div>Private Save</div>;
} }));
import WeeklyLineupPage from "./page";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  session.id = "account-a"; session.loading = false; session.saves = [];
  window.history.replaceState({}, "", "/lineup/weekly?leagueId=123&ownerId=456&week=1");
  window.localStorage.clear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
function fixture() {
  const now = Date.now();
  return { leagueId: "123", ownerId: "456", leagueName: "Account A league", season: 2026, week: 1, scoringId: "ppr", source: "Manual", retrievedAt: now, rosterRetrievedAt: now, projectionUpdatedAt: now, slots: [{ id: "rb", label: "RB", eligiblePositions: ["RB"] }], players: [{ id: "1", name: "Runner", positions: ["RB"], availability: "active", kickoffAt: now + 3600000, currentSlotId: "rb", projectedPoints: 10, projectionOrigin: "manual", projectionEnteredAt: now }] };
}
async function render() { await act(async () => root.render(<WeeklyLineupPage />)); }
async function importRoster() {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === "Import roster and generate estimates")!;
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
}

it("remounts before any new-account Save sees prior inputs and resets all consent", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => fixture() })));
  await render();
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await importRoster();
  expect(session.saves.some((s) => s.account === "account-a")).toBe(true);
  session.id = "account-b";
  await render();
  expect(session.saves.some((s) => s.account === "account-b")).toBe(false);
  expect(container.textContent).not.toContain("Account A league");
  expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
});

it("discards an in-flight old-account import without persisting its manual values", async () => {
  let resolve!: (value: unknown) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise((done) => { resolve = done; })));
  await render(); await importRoster();
  session.id = "account-b"; await render();
  await act(async () => resolve({ ok: true, json: async () => fixture() }));
  expect(session.saves).toEqual([]);
  expect(window.localStorage.getItem("fantasygto.weekly-manual.v1:account-b")).toBeNull();
});

it("does not issue source requests or access manual storage while identity initializes", async () => {
  session.loading = true;
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => fixture() })));
  await render(); await importRoster();
  expect(container.textContent).toContain("Sign in to import league data");
  expect(fetch).not.toHaveBeenCalled();
  expect(window.localStorage.length).toBe(0);
});
