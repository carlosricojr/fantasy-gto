// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { entitlementsFor } from "@/lib/billing/entitlements";
import { compareWeeklyWaivers } from "@/lib/nfl/waiver-planner";
import { fixtureConnection, waiverFixture } from "./__fixtures__/waiver";
const session = vi.hoisted(() => ({ id: "account-a", authenticated: true, loading: false, pro: true }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: session.id }), SignInButton: ({ children }: { children: ReactNode }) => children }));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: session.authenticated, isLoading: session.loading }),
  useMutation: () => vi.fn(),
  useQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) => args === "skip" ? undefined : getFunctionName(reference) === "sleeperConnections:list" ? [fixtureConnection] : { signedIn: true, entitlements: entitlementsFor({ planId: session.pro ? "pro" : "free", status: "active", pastDueSince: null, currentPeriodEnd: null }, Date.now()) },
}));
import WaiversPage from "./page";
let root: Root;
let container: HTMLDivElement;
const requests: string[] = [];
class InlineWorker {
  onmessage?: (event: { data: unknown }) => void;
  terminated = false;
  postMessage({ input, options }: { input: Parameters<typeof compareWeeklyWaivers>[0]; options: Parameters<typeof compareWeeklyWaivers>[1] }) { queueMicrotask(() => { if (!this.terminated) this.onmessage?.({ data: { result: compareWeeklyWaivers(input, options) } }); }); }
  terminate() { this.terminated = true; }
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(session, { id: "account-a", authenticated: true, loading: false, pro: true });
  requests.length = 0;
  window.history.replaceState({}, "", "/waivers");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  vi.stubGlobal("Worker", InlineWorker);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    requests.push(url);
    return { ok: true, json: async () => url === "/api/sleeper-connections" ? { week: 1, connections: [fixtureConnection] } : waiverFixture(Date.now(), url.includes("candidates="), url.includes("conditional=")) };
  }));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function render() { await act(async () => root.render(<WaiversPage />)); }
async function click(text: string) { const button = [...container.querySelectorAll("button")].find((b) => b.textContent === text)!; expect(button, text).toBeDefined(); await act(async () => button.click()); }
async function check(text: string) { const label = [...container.querySelectorAll("label")].find((l) => l.textContent?.includes(text))!; expect(label, text).toBeDefined(); await act(async () => label.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()); }
async function load() { await click("Synthetic QA league · fixture_manager"); await click("Load verified league pool"); }
it("uses saved exact ownership, resolves week only on click, and compares real arithmetic under separate consent", async () => {
  await render(); expect(requests).toEqual([]); expect(container.textContent).not.toContain("Sign in");
  await load();
  expect(requests).toEqual(["/api/sleeper-connections", "/api/waivers?leagueId=123&ownerId=456&week=1"]);
  expect(container.textContent).toContain("2 missing, 3 inactive, 1 conflicting");
  await check("Fixture 7"); await check("Fixture 8"); await click("Refresh and compare selected candidates");
  expect(container.textContent).toContain("Inputs needed before comparison");
  await check("Compare incomplete estimates explicitly");
  expect(container.textContent).toContain("+2.00 included points"); expect(container.textContent).not.toContain("+10.00 included points");
  await check("Generate provisional forecasts"); await click("Refresh and compare selected candidates");
  expect(container.textContent).toContain("+10.00 included points");
  await check("Generate provisional forecasts");
  expect(container.textContent).not.toContain("+10.00 included points");
  expect(container.textContent).toContain("+2.00 included points");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Offline fixture"); }));
  await click("Refresh and compare selected candidates");
  expect(container.textContent).toContain("Offline fixture"); expect(container.textContent).not.toContain("+2.00 included points");
});
it("unmounts old-account state and discards its in-flight response", async () => {
  await render(); await load();
  let resolve!: (value: unknown) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise((done) => { resolve = done; })));
  await click("Load verified league pool");
  session.id = "account-b"; await render();
  await act(async () => resolve({ ok: true, json: async () => waiverFixture(Date.now(), false) }));
  expect(container.textContent).not.toContain("2 missing, 3 inactive, 1 conflicting");
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
});
it("shows one sign-in gate without querying saved teams or sources when signed out", async () => {
  session.authenticated = false; await render();
  expect(container.textContent).toContain("Sign in to load data"); expect(container.textContent).not.toContain("Load verified league pool"); expect(requests).toEqual([]);
});
it("does not ask an authenticated Free account to sign in again", async () => {
  session.pro = false; await render();
  expect(container.textContent).toContain("requires Pro access"); expect(container.textContent).not.toContain("Sign in to load data"); expect(requests).toEqual([]);
});
it("rejects repeated URL identity parameters rather than importing an ambiguous team", async () => {
  window.history.replaceState({}, "", "/waivers?leagueId=123&leagueId=999&ownerId=456&week=1");
  await render(); expect(requests).toEqual([]);
  expect([...container.querySelectorAll("button")].find((b) => b.textContent === "Load verified league pool")!.disabled).toBe(true);
});
