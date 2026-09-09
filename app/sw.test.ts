import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ options: null as null | {
  runtimeCaching: { matcher: (context: { sameOrigin: boolean; url: URL }) => boolean; method?: string; handler: unknown }[];
} }));
vi.mock("serwist", () => ({
  NetworkOnly: class NetworkOnly {
    constructor(readonly options: unknown) {}
  },
  Serwist: class {
    constructor(options: NonNullable<typeof captured.options>) { captured.options = options; }
    addEventListeners() {}
  },
}));
vi.mock("@serwist/next/worker", () => ({ defaultCache: [{ matcher: () => true, handler: "cached-fallback" }] }));

beforeAll(async () => {
  vi.stubGlobal("self", { __SW_MANIFEST: [] });
  await import("./sw");
});
afterAll(() => vi.unstubAllGlobals());

describe("live decision service-worker routing", () => {
  it("puts a GET NetworkOnly handler ahead of every default cache rule", () => {
    const rules = captured.options!.runtimeCaching;
    expect(rules).toHaveLength(2);
    expect(rules[0].method).toBe("GET");
    expect(rules[0].handler?.constructor.name).toBe("NetworkOnly");
    expect(rules[0].handler).toHaveProperty("options.fetchOptions.cache", "no-store");
    expect(rules[1].handler).toBe("cached-fallback");
  });

  it.each([
    [true, "https://fantasy-gto.vercel.app/api/weekly-lineup?leagueId=123&week=1"],
    [true, "https://fantasy-gto.vercel.app/api/waivers?leagueId=123&ownerId=456&week=1"],
    [true, "https://fantasy-gto.vercel.app/api/sleeper-connections?username=example"],
    [true, "https://fantasy-gto.vercel.app/api/waivers/?leagueId=123"],
    [true, "https://fantasy-gto.vercel.app/api//waivers///?leagueId=123"],
    [true, "https://fantasy-gto.vercel.app/API/WAIVERS"],
    [true, "https://fantasy-gto.vercel.app/api/weekly-lineup/"],
    [true, "https://fantasy-gto.vercel.app/api/sleeper-connections/"],
    [false, "https://api.sleeper.app/v1/draft/123/picks"],
    [false, "https://api.sleeper.app/v1/league/123/rosters"],
    [false, "https://api.sleeper.app/v1/state/nfl"],
  ])("never falls back to cached live data: %s %s", (sameOrigin, address) => {
    expect(captured.options!.runtimeCaching[0].matcher({ sameOrigin, url: new URL(address) })).toBe(true);
  });

  it.each([
    [true, "https://fantasy-gto.vercel.app/lineup/weekly"],
    [true, "https://fantasy-gto.vercel.app/_next/static/chunk.js"],
    [false, "https://api.sleeper.app.example.com/v1/draft/123/picks"],
    [false, "https://example.com/api/weekly-lineup"],
    [false, "https://example.com/api/waivers"],
    [false, "https://example.com/api/sleeper-connections"],
    [true, "https://fantasy-gto.vercel.app/api/waivers-other"],
  ])("retains existing caching for unrelated requests: %s %s", (sameOrigin, address) => {
    expect(captured.options!.runtimeCaching[0].matcher({ sameOrigin, url: new URL(address) })).toBe(false);
  });
});
