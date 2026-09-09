import { NextRequest, NextResponse } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ access: vi.fn(), source: vi.fn(), estimates: vi.fn() }));
vi.mock("@/lib/server/personal-access", () => ({ personalSourceAccess: mocks.access }));
vi.mock("@/lib/sources/sleeper-lineup", () => ({ importSleeperLineup: mocks.source }));
vi.mock("@/lib/sources/nflverse-weekly-projections", () => ({ generateNflverseWeeklyProjections: mocks.estimates }));
import { GET } from "./route";
beforeEach(() => vi.clearAllMocks());
it("performs admission before any weekly source request", async () => {
  mocks.access.mockResolvedValue(NextResponse.json({ error: "Denied" }, { status: 429 }));
  expect((await GET(new NextRequest("http://localhost/api/weekly-lineup?leagueId=123&ownerId=456&week=1&estimates=nflverse"))).status).toBe(429);
  expect(mocks.access).toHaveBeenCalledWith("model"); expect(mocks.source).not.toHaveBeenCalled();
  await GET(new NextRequest("http://localhost/api/weekly-lineup?leagueId=123&ownerId=456&week=1"));
  expect(mocks.access).toHaveBeenLastCalledWith("roster");
});
it.each(["", "&experimental=unknown", "&experimental=coverage-baselines"])("experimental baseline requests remain separately explicit and admitted first: %s", async query => {
  mocks.access.mockResolvedValue(null);
  mocks.source.mockResolvedValue({ season: 2026, scoringId: 'sleeper-v1:{"rec":1}', players: [{ id: "p" }] });
  mocks.estimates.mockResolvedValue({ ok: false, reason: "Fixture unavailable" });
  const response = await GET(new NextRequest(`http://localhost/api/weekly-lineup?leagueId=123&ownerId=456&week=1&estimates=nflverse${query}`));
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(mocks.estimates).toHaveBeenCalledWith(expect.objectContaining({ includeConditionalEstimates: false, includeExperimentalEstimates: query === "&experimental=coverage-baselines" }));
  expect(mocks.access.mock.invocationCallOrder[0]).toBeLessThan(mocks.source.mock.invocationCallOrder[0]);
});
