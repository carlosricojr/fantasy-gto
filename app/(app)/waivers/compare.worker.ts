import { compareWeeklyWaivers } from "@/lib/nfl/waiver-planner";

self.onmessage = (event: MessageEvent<{ input: Parameters<typeof compareWeeklyWaivers>[0]; options: Parameters<typeof compareWeeklyWaivers>[1] }>) => {
  try { self.postMessage({ result: compareWeeklyWaivers(event.data.input, event.data.options) }); }
  catch (cause) { self.postMessage({ error: cause instanceof Error ? cause.message : "Comparison failed." }); }
};
