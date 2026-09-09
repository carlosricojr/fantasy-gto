import { NextRequest } from "next/server";
import { expect, it } from "vitest";
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
