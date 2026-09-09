import { NextRequest } from "next/server";
import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ access: vi.fn(), source: vi.fn() }));
vi.mock("@/lib/server/personal-access", () => ({ personalSourceAccess: mocks.access }));
vi.mock("@/lib/sources/sleeper-connections", () => ({ findSleeperConnections: mocks.source }));
import { POST } from "./route";

it("rejects oversized and extra-field input before upstream lookup", async () => {
  const oversized = await POST(new NextRequest("http://localhost/api/sleeper-connections", { method: "POST", body: JSON.stringify({ username: "manager", ignored: "x".repeat(2000) }) }));
  expect(oversized.status).toBe(413);
  expect(oversized.headers.get("Cache-Control")).toBe("no-store");
  const extra = await POST(new NextRequest("http://localhost/api/sleeper-connections", { method: "POST", body: '{"username":"manager","ignored":true}' }));
  expect(extra.status).toBe(400);
  const chunks = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(700)); controller.enqueue(new Uint8Array(700)); controller.close(); } });
  expect((await POST(new NextRequest("http://localhost/api/sleeper-connections", { method: "POST", body: chunks }))).status).toBe(413);
});

it("denies valid lookups before any source I/O", async () => {
  mocks.access.mockResolvedValue(new Response('{"error":"Sign in"}', { status: 401 }));
  const result = await POST(new NextRequest("http://localhost/api/sleeper-connections", { method: "POST", body: '{"username":"manager"}' }));
  expect(result.status).toBe(401); expect(mocks.source).not.toHaveBeenCalled();
});
