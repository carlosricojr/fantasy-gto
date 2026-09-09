import { expect, it } from "vitest";
import { JsonBodyTooLargeError, readBoundedJson } from "./bounded-json";

it("enforces streamed byte rather than character limits and cancels excess input", async () => {
  let canceled = false;
  let reads = 0;
  const stream = new ReadableStream({ pull(controller) { reads++; controller.enqueue(new Uint8Array(60)); }, cancel() { canceled = true; } });
  await expect(readBoundedJson(stream, 100)).rejects.toBeInstanceOf(JsonBodyTooLargeError);
  expect(canceled).toBe(true); expect(reads).toBeLessThanOrEqual(3);
  await expect(readBoundedJson(new Response('"éé"').body, 5)).rejects.toBeInstanceOf(JsonBodyTooLargeError);
  expect(await readBoundedJson(new Response('{"value":1}').body, 100)).toEqual({ value: 1 });
});
