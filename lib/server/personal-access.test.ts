import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), action: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("convex/nextjs", () => ({ fetchAction: mocks.action }));
import { personalSourceAccess } from "./personal-access";
beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue({ userId: "account", getToken: async () => "verified-token" }); mocks.action.mockResolvedValue(null); });
it("denies anonymous and missing tokens before backend admission", async () => {
  mocks.auth.mockResolvedValue({ userId: null });
  expect((await personalSourceAccess("model"))!.status).toBe(401);
  expect(mocks.action).not.toHaveBeenCalled();
  mocks.auth.mockResolvedValue({ userId: "account", getToken: async () => null });
  expect((await personalSourceAccess("connection"))!.status).toBe(401);
  expect(mocks.action).not.toHaveBeenCalled();
});
it("maps entitlement, quota and outages to safe explicit no-store errors", async () => {
  for (const [code, status] of [["entitlement", 403], ["unauthenticated", 401], ["rate_limit", 429], ["unknown", 503]]) {
    mocks.action.mockRejectedValue({ data: { code, message: "Denied", retryAfterSeconds: 47 } });
    const response = (await personalSourceAccess("model"))!;
    expect(response.status).toBe(status); expect(response.headers.get("Cache-Control")).toBe("no-store");
    if (code === "rate_limit") expect(response.headers.get("Retry-After")).toBe("47");
  }
});
it("passes only fixed operation arguments and an authenticated token", async () => {
  expect(await personalSourceAccess("model")).toBeNull();
  expect(mocks.action).toHaveBeenLastCalledWith(expect.anything(), { model: true }, { token: "verified-token" });
  expect(await personalSourceAccess("connection")).toBeNull();
  expect(mocks.action).toHaveBeenLastCalledWith(expect.anything(), {}, { token: "verified-token" });
});
