/**
 * Draft-clock compute budget.
 *
 * The full 600-scenario run is useful only when it returns before the next pick. Start
 * smaller on clearly constrained hardware, then move downward monotonically when the
 * device itself proves the current budget is too slow. Never move back up mid-draft: a
 * panel that alternates between fast and slow is harder to trust than a stable lower-
 * precision one, and the UI already labels statistical ties.
 */
export const LITE_SCENARIOS = 300;
export const MIN_SCENARIOS = 150;

export function initialScenarioBudget(input: {
  full: number;
  hardwareConcurrency?: number;
  deviceMemoryGb?: number;
}): number {
  const constrainedCpu =
    input.hardwareConcurrency !== undefined && input.hardwareConcurrency <= 4;
  const constrainedMemory =
    input.deviceMemoryGb !== undefined && input.deviceMemoryGb <= 4;
  return constrainedCpu || constrainedMemory
    ? Math.min(input.full, LITE_SCENARIOS)
    : input.full;
}

export function nextScenarioBudget(current: number, elapsedMs: number): number {
  if (elapsedMs > 6_000) return Math.min(current, MIN_SCENARIOS);
  if (elapsedMs > 3_500) return Math.min(current, LITE_SCENARIOS);
  return current;
}
