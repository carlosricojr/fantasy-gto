import { expect, it } from "vitest";
import { sleeperLeagueId, sleeperUserInput, weeklyLineupHref, weeklyLineupPrefill } from "./sleeper-connection";

it("parses numeric league IDs and supported league links without arbitrary URLs", () => {
  expect(sleeperLeagueId(" 123 ")).toBe("123");
  expect(sleeperLeagueId("https://sleeper.com/leagues/123/team")).toBe("123");
  for (const value of ["https://evil.test/leagues/123", "https://sleeper.com.evil.test/leagues/123", "https://user@sleeper.com/leagues/123", "https://sleeper.com:444/leagues/123", "http://sleeper.com/leagues/123", "123/../../", "https://sleeper.com/draft/123"]) expect(sleeperLeagueId(value)).toBeNull();
});
it("normalizes a username and rejects path/query injection", () => {
  expect(sleeperUserInput(" @Manager_1 ")).toBe("Manager_1");
  for (const value of ["../me", "a?admin=1", "a/b", "", "a".repeat(41)]) expect(sleeperUserInput(value)).toBeNull();
});
it("prefills only single valid context parameters and roundtrips handoff", () => {
  const href = weeklyLineupHref({ leagueId: "123", ownerId: "456" }, 8);
  expect(weeklyLineupPrefill(href.split("?")[1])).toEqual({ leagueId: "123", ownerId: "456", week: "8" });
  expect(weeklyLineupPrefill("leagueId=1&leagueId=2&ownerId=bad&week=19")).toEqual({ leagueId: "", ownerId: "", week: "" });
});
