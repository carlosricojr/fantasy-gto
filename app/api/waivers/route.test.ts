import { afterEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { auth } from "@clerk/nextjs/server";
import { fetchAction } from "convex/nextjs";
import { getFunctionName } from "convex/server";
import { GET } from "./route";

// Infrastructure mocks only; the actual source adapter and domain parsers run unchanged.
vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));
vi.mock("convex/nextjs", () => ({ fetchAction: vi.fn() }));
const url = "https://example.test/api/waivers?leagueId=123&ownerId=456&week=1";
const session = (userId: string | null, token: string | null) => vi.mocked(auth).mockResolvedValue({ userId, getToken: async () => token } as unknown as Awaited<ReturnType<typeof auth>>);
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });

describe("waiver API server authorization", () => {
  it.each([[null, null], ["user", null]] as const)("requires authenticated server token before source I/O: %s/%s", async (userId, token) => {
    session(userId, token);
    const network = vi.fn(); vi.stubGlobal("fetch", network);
    const response = await GET(new Request(url));
    expect(response.status).toBe(401);
    expect(fetchAction).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it.each([["entitlement", 403], ["unauthenticated", 401]] as const)("fails closed on backend %s before source I/O", async (code, status) => {
    session("user", "signed-token");
    vi.mocked(fetchAction).mockRejectedValue(new ConvexError({ code }));
    const network = vi.fn(); vi.stubGlobal("fetch", network);
    const response = await GET(new Request(url));
    expect(response.status).toBe(status);
    expect(network).not.toHaveBeenCalled();
    const [reference, args, options] = vi.mocked(fetchAction).mock.calls[0];
    expect(getFunctionName(reference)).toBe("personalTools:authorizeWaiverComparison");
    expect(args).toEqual({});
    expect(options).toEqual({ token: "signed-token" });
  });
  it("treats backend failure as unverified access, never an authorization bypass", async () => {
    session("user", "signed-token");
    vi.mocked(fetchAction).mockRejectedValue(new Error("service unavailable"));
    const network = vi.fn(); vi.stubGlobal("fetch", network);
    const response = await GET(new Request(url));
    expect(response.status).toBe(503);
    expect(network).not.toHaveBeenCalled();
  });
  it("validates malformed requests without contacting either authorization or sources", async () => {
    const network = vi.fn(); vi.stubGlobal("fetch", network);
    expect((await GET(new Request(`${url}&candidates=7,7`))).status).toBe(400);
    expect(auth).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
  it("only enters real source I/O after a successful server authorization", async () => {
    session("user", "signed-token");
    let authorized = false;
    vi.mocked(fetchAction).mockImplementation(async () => { authorized = true; return null; });
    const network = vi.fn(async () => { expect(authorized).toBe(true); throw new Error("Fixture source unavailable"); });
    vi.stubGlobal("fetch", network);
    const response = await GET(new Request(url));
    expect(response.status).toBe(502);
    expect(network).toHaveBeenCalledTimes(4);
    expect(await response.json()).toEqual({ error: "Fixture source unavailable" });
  });
});
