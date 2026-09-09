import { NextRequest, NextResponse } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ access: vi.fn(), source: vi.fn() }));
vi.mock("@/lib/server/personal-access", () => ({ personalSourceAccess: mocks.access }));
vi.mock("@/lib/sources/sleeper-lineup", () => ({ importSleeperLineup: mocks.source }));
import { GET } from "./route";
beforeEach(() => vi.clearAllMocks());
it("performs admission before any weekly source request", async () => {
  mocks.access.mockResolvedValue(NextResponse.json({ error: "Denied" }, { status: 429 }));
  expect((await GET(new NextRequest("http://localhost/api/weekly-lineup?leagueId=123&ownerId=456&week=1&estimates=nflverse"))).status).toBe(429);
  expect(mocks.access).toHaveBeenCalledWith("model"); expect(mocks.source).not.toHaveBeenCalled();
  await GET(new NextRequest("http://localhost/api/weekly-lineup?leagueId=123&ownerId=456&week=1"));
  expect(mocks.access).toHaveBeenLastCalledWith("roster");
});
