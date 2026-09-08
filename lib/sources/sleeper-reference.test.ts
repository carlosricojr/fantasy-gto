import { expect, it } from "vitest";
import { leagueUrl, resolveSleeperDraftId } from "./sleeper";

it("resolves the actual predraft URL against the fixed public API", async () => {
  const seen: string[] = [];
  const result = await resolveSleeperDraftId("https://sleeper.com/leagues/1389387330229374976/predraft", async (url) => {
    seen.push(url);
    return JSON.stringify({ league_id: "1389387330229374976", draft_id: "1389387330229374977" });
  });
  expect(result).toEqual({ ok: true, data: "1389387330229374977", degraded: false });
  expect(seen).toEqual([leagueUrl("1389387330229374976")]);
});
it("accepts draft links and IDs without extra network requests", async () => {
  for (const value of ["1389387330229374977", "https://sleeper.com/draft/nfl/1389387330229374977"]) {
    expect(await resolveSleeperDraftId(value, async () => { throw new Error("must not fetch"); })).toEqual({ ok: true, data: "1389387330229374977", degraded: false });
  }
});
it.each(["https://example.com/leagues/1", "https://sleeper.com@evil.example/leagues/1", "http://sleeper.com/leagues/1", "https://sleeper.com:999/leagues/1", "https://sleeper.com/settings", ""]) ("rejects unknown or unsafe links %s", async (url) => {
  expect((await resolveSleeperDraftId(url, async () => { throw new Error("must not fetch"); })).ok).toBe(false);
});
it("refuses a mismatched league response", async () => {
  expect((await resolveSleeperDraftId("https://sleeper.com/leagues/1/predraft", async () => JSON.stringify({ league_id: "2", draft_id: "3" }))).ok).toBe(false);
});
