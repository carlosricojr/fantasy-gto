import { afterEach, describe, expect, it, vi } from "vitest";
import { httpTextFetcher } from "./nflverse";

afterEach(() => vi.unstubAllGlobals());

describe("live provider HTTP cache", () => {
  it("bypasses HTTP caching for documented Sleeper endpoints", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("[]"));
    vi.stubGlobal("fetch", fetcher);
    expect(await httpTextFetcher("https://api.sleeper.app/v1/draft/123/picks")).toBe("[]");
    expect(fetcher).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }));
  });

  it("does not change the cache mode of other providers", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("data"));
    vi.stubGlobal("fetch", fetcher);
    await httpTextFetcher("https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv");
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty("cache");
  });

  it("surfaces a failed live refresh instead of inventing a response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(httpTextFetcher("https://api.sleeper.app/v1/draft/123/picks")).rejects.toThrow("offline");
  });
});
