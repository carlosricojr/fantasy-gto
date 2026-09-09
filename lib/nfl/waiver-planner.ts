import { planWeeklyLineup, type WeeklyLineupPlan, type WeeklyLineupSnapshot, type WeeklyPlayer } from "./weekly-lineup";
import type { WaiverOwnership } from "./waiver-pool";

export const WAIVER_CANDIDATE_LIMIT = 12;
export const WAIVER_ROSTER_LIMIT = 24;
export const WAIVER_SLOT_LIMIT = 10;
export const WAIVER_ROSTER_MAX_AGE_MS = 15 * 60 * 1000;
export interface WaiverComparisonInput {
  roster: WeeklyLineupSnapshot;
  candidates: readonly WeeklyPlayer[];
  ownership: WaiverOwnership;
  availableCount: number;
}
export interface WaiverChoice {
  addId: string;
  dropId: string;
  marginalPoints: number;
  lineup: WeeklyLineupPlan;
}
export interface WaiverComparison {
  status: "blocked" | "unknown" | "no-improvement" | "improvement";
  problems: string[];
  warnings: string[];
  baseline: WeeklyLineupPlan | null;
  choices: WaiverChoice[];
  excluded: { playerId: string; role: "add" | "drop"; reason: string }[];
  coverage: { available: number; selected: number; eligibleAdds: number; eligibleDrops: number; evaluatedPairs: number; unknownPairs: number };
}
const movable = (player: WeeklyPlayer, now: number): string | null => {
  if (player.kickoffAt === null || !Number.isFinite(player.kickoffAt)) return "Kickoff is unknown.";
  if (player.kickoffAt <= now) return "Game has started; this player is locked.";
  if (!["active", "questionable", "doubtful"].includes(player.availability)) return `Availability is ${player.availability}; not compared.`;
  if (player.projectedPoints === null) return player.projectionMissingReason ?? "No weekly estimate; held fixed, never valued at zero.";
  if (player.gameContextConflict) return "Sources disagree on the current team or kickoff.";
  return null;
};
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && new Set(a).size === a.length && a.every((id) => b.includes(id));

/** Exact included-lineup delta, not the candidate's raw points or a season-long drop valuation. */
export function compareWeeklyWaivers(input: WaiverComparisonInput, options: { now: number; compareAvailableEstimates: boolean; allowConditionalEstimates: boolean }): WaiverComparison {
  const { roster, candidates, ownership } = input;
  const result: WaiverComparison = { status: "blocked", problems: [], warnings: ["One-week estimates only: bench depth, future weeks, acquisition timing, waiver priority and FAAB are not valued. Verify platform claim eligibility; no transaction is submitted."], baseline: null, choices: [], excluded: [], coverage: { available: input.availableCount, selected: candidates.length, eligibleAdds: 0, eligibleDrops: 0, evaluatedPairs: 0, unknownPairs: 0 } };
  if (ownership.leagueId !== roster.leagueId || ownership.ownerId !== roster.ownerId || !sameSet(ownership.ownPlayerIds, roster.players.map((p) => p.id)) || ownership.ownPlayerIds.some((id) => !ownership.ownedPlayerIds.includes(id))) result.problems.push("Ownership does not match this roster.");
  if (!Number.isFinite(ownership.retrievedAt) || ownership.retrievedAt > options.now || options.now - ownership.retrievedAt > WAIVER_ROSTER_MAX_AGE_MS) result.problems.push("League ownership is stale or invalid. Refresh every roster before comparing.");
  if (roster.players.length > WAIVER_ROSTER_LIMIT || roster.slots.length > WAIVER_SLOT_LIMIT || candidates.length === 0 || candidates.length > WAIVER_CANDIDATE_LIMIT) result.problems.push(`Comparison supports 1–${WAIVER_CANDIDATE_LIMIT} selected candidates, at most ${WAIVER_ROSTER_LIMIT} rostered players and ${WAIVER_SLOT_LIMIT} starting slots.`);
  if (!Number.isInteger(input.availableCount) || input.availableCount < candidates.length || new Set(candidates.map((p) => p.id)).size !== candidates.length || candidates.some((p) => ownership.ownedPlayerIds.includes(p.id) || p.currentSlotId !== null)) result.problems.push("Candidates are duplicated, rostered, or inconsistent with the verified available pool.");
  if (result.problems.length) return result;
  result.warnings.push(`${candidates.length} selected candidates out of ${input.availableCount} unrostered directory candidates assessed; others are unsearched, not inferior.`);
  const planOptions = { ...options, maxProjectionAgeMs: 24 * 60 * 60 * 1000, maxRosterAgeMs: WAIVER_ROSTER_MAX_AGE_MS };
  const baseline = planWeeklyLineup(roster, planOptions);
  result.baseline = baseline;
  result.warnings.push(...baseline.warnings);
  if (baseline.status === "blocked") { result.problems.push(...baseline.problems); return result; }
  const drops = roster.players.filter((player) => {
    const reason = ownership.protectedPlayerIds.includes(player.id) ? "Reserve/taxi holding does not free an active-roster slot." : baseline.excludedPlayerIds.includes(player.id) || baseline.excludedSlotIds.includes(player.currentSlotId ?? "") ? "Unpriced/fixed comparison scope must not change." : movable(player, options.now);
    if (reason) result.excluded.push({ playerId: player.id, role: "drop", reason });
    return reason === null;
  });
  const adds = candidates.filter((player) => {
    const reason = movable(player, options.now) ?? (!roster.slots.some((slot) => slot.eligiblePositions.some((p) => player.positions.includes(p))) ? "No eligible league starting position." : null);
    if (reason) result.excluded.push({ playerId: player.id, role: "add", reason });
    return reason === null;
  });
  result.coverage.eligibleAdds = adds.length;
  result.coverage.eligibleDrops = drops.length;
  for (const add of adds) for (const drop of drops) {
    const lineup = planWeeklyLineup({ ...roster, players: [...roster.players.filter((p) => p.id !== drop.id), add] }, planOptions);
    if (lineup.status === "blocked" || !sameSet(lineup.excludedSlotIds, baseline.excludedSlotIds) || !sameSet(lineup.excludedPlayerIds, baseline.excludedPlayerIds)) { result.coverage.unknownPairs += 1; continue; }
    result.coverage.evaluatedPairs += 1;
    result.choices.push({ addId: add.id, dropId: drop.id, marginalPoints: (Math.round(lineup.projectedPoints! * 100) - Math.round(baseline.projectedPoints! * 100)) / 100, lineup });
  }
  result.choices.sort((a, b) => b.marginalPoints - a.marginalPoints || a.addId.localeCompare(b.addId) || a.dropId.localeCompare(b.dropId));
  result.status = result.choices.length === 0 ? "unknown" : result.choices[0].marginalPoints > 0 ? "improvement" : "no-improvement";
  if (result.coverage.unknownPairs > 0) result.warnings.push(`${result.coverage.unknownPairs} pairs could not be compared under the same verified scope; they are unknown, not losing choices.`);
  return result;
}
