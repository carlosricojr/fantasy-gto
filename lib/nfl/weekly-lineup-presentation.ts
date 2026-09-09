import type { WeeklyLineupPlan, WeeklyLineupSnapshot } from "./weekly-lineup";

export interface WeeklyNoticeGroup { title: string; messages: string[] }
/** Group without discarding source evidence. Original detail remains expandable in the UI. */
export function groupWeeklyNotices(messages: readonly string[]): WeeklyNoticeGroup[] {
  const groups = new Map<string, string[]>();
  for (const message of new Set(messages)) {
    const title = /injur|active|questionable|doubtful|availability|kickoff|team or kickoff/i.test(message) ? "Availability and kickoff checks"
      : /missing.*projection|no estimate|unpriced|no valued|incomplete|scoring|omitted|omit|provisional|comparison/i.test(message) ? "Estimate coverage and scoring limits"
      : /fresh|publication|retriev|timestamp|calculation/i.test(message) ? "Source timing and refresh"
      : "Other source limitations";
    groups.set(title, [...(groups.get(title) ?? []), message]);
  }
  return [...groups].map(([title, entries]) => ({ title, messages: entries }));
}

export function weeklyLineupActions(snapshot: WeeklyLineupSnapshot, plan: WeeklyLineupPlan): { playerId: string; kind: "start" | "bench" | "slot"; text: string; reason: string }[] {
  if (plan.status === "blocked") return [];
  const assigned = new Map(plan.assignments.filter((a) => a.playerId !== null).map((a) => [a.playerId!, a]));
  const slotName = (id: string) => snapshot.slots.find((s) => s.id === id)?.label ?? id;
  const eligibility = new Map(snapshot.slots.map((s) => [s.id, [...new Set(s.eligiblePositions)].sort().join(",")]));
  const unchangedGroups = new Set(eligibility.values());
  for (const player of snapshot.players) {
    const before = player.currentSlotId === null ? undefined : eligibility.get(player.currentSlotId);
    const after = eligibility.get(assigned.get(player.id)?.slotId ?? "");
    if (before !== after) {
      if (before !== undefined) unchangedGroups.delete(before);
      if (after !== undefined) unchangedGroups.delete(after);
    }
  }
  return snapshot.players.flatMap((p) => {
    const next = assigned.get(p.id);
    if (next?.fixed || (next?.slotId ?? null) === p.currentSlotId) return [];
    // Suppress only closed equivalent-slot permutations. During a substitution,
    // a common starter's move may be needed to free the named destination.
    const group = eligibility.get(next?.slotId ?? "");
    if (next && p.currentSlotId !== null && group !== undefined && group === eligibility.get(p.currentSlotId) && unchangedGroups.has(group)) return [];
    const kind = next ? p.currentSlotId === null ? "start" as const : "slot" as const : "bench" as const;
    const text = next ? p.currentSlotId === null ? `Start ${p.name} at ${slotName(next.slotId)}` : `Move ${p.name} from ${slotName(p.currentSlotId)} to ${slotName(next.slotId)}` : `Bench ${p.name}`;
    const reason = ["out", "inactive", "bye", "reserve"].includes(p.availability) ? `Imported status: ${p.availability}.` : next && p.currentSlotId !== null ? "Legal slot reassignment; equal-point arrangements preserve later-game flexibility." : "Part of the highest included-estimate legal assignment, conditional on the displayed limitations.";
    return [{ playerId: p.id, kind, text, reason }];
  });
}

export function weeklyKickoffChecks(snapshot: WeeklyLineupSnapshot, now: number): { gameId: string; kickoffAt: number; checkAt: number; players: string[]; locked: boolean }[] {
  const games = new Map<string, { gameId: string; kickoffAt: number; checkAt: number; players: string[]; locked: boolean }>();
  for (const player of snapshot.players) {
    if (player.kickoffAt === null || !Number.isFinite(player.kickoffAt)) continue;
    const key = player.gameId ?? `kickoff:${player.kickoffAt}`;
    const row = games.get(key) ?? { gameId: key, kickoffAt: player.kickoffAt, checkAt: player.kickoffAt - 90 * 60 * 1000, players: [], locked: player.kickoffAt <= now };
    row.players.push(player.name);
    games.set(key, row);
  }
  return [...games.values()].sort((a, b) => a.kickoffAt - b.kickoffAt);
}
