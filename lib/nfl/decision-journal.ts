import { planWeeklyLineup, type WeeklyLineupPlan, type WeeklyLineupSnapshot } from "./weekly-lineup";
import { parseWeeklyDecisionInput, type WeeklyDecisionPreferences } from "./decision-journal-inputs";

export const DECISION_JOURNAL_VERSION = 1;
export const DECISION_PROJECTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const DECISION_ROSTER_MAX_AGE_MS = 15 * 60 * 1000;

export interface WeeklyDecisionRecord {
  version: 1;
  recordedAt: number;
  /** The server dates receipt, not the authorship or truth of the supplied forecasts. */
  inputProvenance: "user-supplied";
  timing: "before-listed-kickoffs" | "after-listed-kickoff" | "unknown-kickoff";
  earliestKickoffAt: number | null;
  snapshot: WeeklyLineupSnapshot;
  preferences: WeeklyDecisionPreferences;
  plan: WeeklyLineupPlan;
}

/** Recompute the decision with the RECEIVING server's clock; never trust a submitted plan. */
export function createWeeklyDecisionRecord(snapshotJson: string, preferencesJson: string, recordedAt: number): WeeklyDecisionRecord {
  if (!Number.isFinite(recordedAt) || recordedAt < 0 || recordedAt > 8.64e15) throw new Error("Invalid decision receipt time.");
  const { snapshot, preferences } = parseWeeklyDecisionInput(snapshotJson, preferencesJson);
  const plan = planWeeklyLineup(snapshot, {
    ...preferences, now: recordedAt,
    maxProjectionAgeMs: DECISION_PROJECTION_MAX_AGE_MS,
    maxRosterAgeMs: DECISION_ROSTER_MAX_AGE_MS,
  });
  if (plan.status === "blocked") throw new Error(`Decision not recorded: ${plan.problems.slice(0, 3).join(" ")}`);
  const compared = new Set(comparedLineups(snapshot, plan).flat());
  const listedPlayers = snapshot.players.filter(player => compared.has(player.id));
  const kickoffs = listedPlayers.map(player => player.kickoffAt).filter((at): at is number => at !== null);
  const earliestKickoffAt = kickoffs.length === 0 ? null : Math.min(...kickoffs);
  const timing = listedPlayers.some(player => player.kickoffAt === null)
    ? "unknown-kickoff" : earliestKickoffAt !== null && recordedAt < earliestKickoffAt
      ? "before-listed-kickoffs" : "after-listed-kickoff";
  return { version: DECISION_JOURNAL_VERSION, recordedAt, inputProvenance: "user-supplied", timing, earliestKickoffAt, snapshot, preferences, plan };
}

export interface WeeklyDecisionOutcomes {
  leagueId: string;
  ownerId: string;
  season: number;
  week: number;
  scoringId: string;
  fetchedAt: number;
  source: string;
  /** Missing is unknown, not a DNP or zero. */
  pointsByPlayer: Readonly<Record<string, number>>;
  /** Completion must be established from game/source evidence, not nonzero points. */
  completePlayerIds: readonly string[];
  /** Actual game kickoffs independently recovered from the outcome source/context. */
  kickoffByPlayer: Readonly<Record<string, number>>;
}

export interface WeeklyDecisionEvaluation {
  status: "complete" | "pending" | "ineligible";
  reason: string | null;
  comparedPlayerIds: string[];
  missingPlayerIds: string[];
  recommendedActualPoints: number | null;
  originalActualPoints: number | null;
  actualDifference: number | null;
  forecastErrors: { origin: "model" | "manual" | "unspecified"; count: number; meanAbsoluteError: number }[];
  unevaluatedForecastCount: number;
  scope: "included-estimates";
}

function comparedLineups(snapshot: WeeklyLineupSnapshot, plan: WeeklyLineupPlan): [string[], string[]] {
  const excluded = new Set(plan.excludedSlotIds);
  return [
    plan.assignments.filter(a => !excluded.has(a.slotId) && a.playerId !== null).map(a => a.playerId!),
    snapshot.players.filter(p => p.currentSlotId !== null && !excluded.has(p.currentSlotId)).map(p => p.id),
  ];
}

/** Score the FROZEN two lineups. Never choose a new lineup after reading actual outcomes. */
export function evaluateWeeklyDecision(record: WeeklyDecisionRecord, outcomes: WeeklyDecisionOutcomes): WeeklyDecisionEvaluation {
  const result: WeeklyDecisionEvaluation = { status: "ineligible", reason: null, comparedPlayerIds: [], missingPlayerIds: [], recommendedActualPoints: null, originalActualPoints: null, actualDifference: null, forecastErrors: [], unevaluatedForecastCount: snapshotForecastCount(record.snapshot), scope: "included-estimates" };
  const fail = (reason: string) => ({ ...result, reason });
  const snapshot = record.snapshot;
  if (record.version !== DECISION_JOURNAL_VERSION || record.plan.status === "blocked") return fail("Unsupported or blocked decision record.");
  if (outcomes.leagueId !== snapshot.leagueId || outcomes.ownerId !== snapshot.ownerId || outcomes.season !== snapshot.season || outcomes.week !== snapshot.week || outcomes.scoringId !== snapshot.scoringId) return fail("Outcome league, team, week, or scoring does not match the frozen decision.");
  if (!Number.isFinite(outcomes.fetchedAt) || outcomes.fetchedAt < record.recordedAt || !outcomes.source) return fail("Invalid outcome provenance or retrieval time.");
  if (record.timing !== "before-listed-kickoffs") return fail("This record was not received before every compared player's listed kickoff.");
  const [proposed, original] = comparedLineups(snapshot, record.plan);
  const compared = [...new Set([...proposed, ...original])];
  result.comparedPlayerIds = compared;
  if (compared.length === 0) return fail("No valued starting slots were included.");
  // Source-confirmed kickoff is checked independently of the submitted snapshot's timing.
  if (compared.some(id => Number.isFinite(outcomes.kickoffByPlayer[id]) && record.recordedAt >= outcomes.kickoffByPlayer[id])) return fail("Outcome context shows that a compared player had already kicked off when this decision was received.");
  const complete = new Set(outcomes.completePlayerIds);
  result.missingPlayerIds = compared.filter(id => !Number.isFinite(outcomes.kickoffByPlayer[id]) || !complete.has(id) || !Object.prototype.hasOwnProperty.call(outcomes.pointsByPlayer, id) || !Number.isFinite(outcomes.pointsByPlayer[id]) || Math.abs(outcomes.pointsByPlayer[id]) > 10000);
  if (result.missingPlayerIds.length > 0) return { ...result, status: "pending", reason: "At least one compared player's game or point value is incomplete." };
  const total = (ids: readonly string[]) => ids.reduce((sum, id) => sum + outcomes.pointsByPlayer[id], 0);
  result.recommendedActualPoints = total(proposed);
  result.originalActualPoints = total(original);
  result.actualDifference = result.recommendedActualPoints - result.originalActualPoints;
  // Conditional-on-active and partial-scoring means are not forecasts of the full
  // realized score. Never fold them into an ordinary accuracy number.
  const forecasts = snapshot.players.filter(p => p.projectedPoints !== null && p.projectionOrigin !== "model-conditional" && !(p.projectionOrigin === "model" && (snapshot.model?.excludedRules.length ?? 0) > 0) && complete.has(p.id) && Object.prototype.hasOwnProperty.call(outcomes.pointsByPlayer, p.id) && Number.isFinite(outcomes.pointsByPlayer[p.id]) && Math.abs(outcomes.pointsByPlayer[p.id]) <= 10000 && Number.isFinite(outcomes.kickoffByPlayer[p.id]) && record.recordedAt < outcomes.kickoffByPlayer[p.id]);
  result.unevaluatedForecastCount -= forecasts.length;
  for (const origin of ["model", "manual", "unspecified"] as const) {
    const group = forecasts.filter(p => (p.projectionOrigin ?? "unspecified") === origin);
    if (group.length > 0) result.forecastErrors.push({ origin, count: group.length, meanAbsoluteError: group.reduce((sum, p) => sum + Math.abs(p.projectedPoints! - outcomes.pointsByPlayer[p.id]), 0) / group.length });
  }
  return { ...result, status: "complete", reason: null };
}

const snapshotForecastCount = (snapshot: WeeklyLineupSnapshot) => snapshot.players.filter(p => p.projectedPoints !== null).length;
