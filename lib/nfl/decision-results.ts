import { z } from "zod";

/** Descriptive protocol, not an accuracy study or a claim of independent trials. */
export const DECISION_RESULTS_PROTOCOL = "recent-decisions-v1";
export const DECISION_RESULTS_LIMIT = 20;

export interface DecisionResultsInput {
  _id: string;
  recordJson: string;
  observations: readonly { observedAt: number; evaluationJson: string }[];
}
export type DecisionResultsCohort = "unrestricted" | "limited" | "experimental";
export interface DecisionResultsRow {
  id: string;
  leagueName: string;
  season: number;
  week: number;
  recordedAt: number;
  scoringGroup: string;
  teamId: string;
  scoringId: string;
  cohort: DecisionResultsCohort;
  status: "complete" | "pending" | "ineligible" | "unavailable";
  difference: number | null;
}
export interface DecisionResultsReport {
  inspected: number;
  invalidRecords: number;
  lateOrUnknownRecords: number;
  revisions: number;
  rows: DecisionResultsRow[];
  cohorts: { key: string; scoringGroup: string; teamId: string; scoringId: string; leagueName: string; season: number; cohort: DecisionResultsCohort; complete: number; weeks: number; difference: number | null; meanDifference: number | null }[];
}

const time = z.number().finite().min(0).max(8.64e15);
const recordSchema = z.object({
  version: z.literal(1), recordedAt: time,
  timing: z.enum(["before-listed-kickoffs", "after-listed-kickoff", "unknown-kickoff"]),
  snapshot: z.object({
    leagueId: z.string().min(1), ownerId: z.string().min(1), leagueName: z.string(),
    season: z.number().int().min(2026), week: z.number().int().min(1).max(18), scoringId: z.string().min(1),
    players: z.array(z.object({ projectedPoints: z.number().finite().nullable(), projectionOrigin: z.string().optional() })).max(32),
    model: z.object({ excludedRules: z.array(z.string()) }).optional(),
  }),
  plan: z.object({ status: z.enum(["ready", "conditional"]), excludedSlotIds: z.array(z.string()), excludedPlayerIds: z.array(z.string()) }),
});
const evaluationSchema = z.object({
  status: z.enum(["complete", "pending", "ineligible"]),
  recommendedActualPoints: z.number().finite().min(-320000).max(320000).nullable(),
  originalActualPoints: z.number().finite().min(-320000).max(320000).nullable(),
  actualDifference: z.number().finite().min(-640000).max(640000).nullable(),
});
type ParsedRecord = z.infer<typeof recordSchema>;

function cohortOf(record: ParsedRecord): DecisionResultsCohort {
  const origins = record.snapshot.players.filter(p => p.projectedPoints !== null).map(p => p.projectionOrigin);
  // Unknown future origins are conservatively segregated, never folded into ordinary results.
  if (origins.some(origin => origin !== undefined && !["model", "model-conditional", "manual"].includes(origin))) return "experimental";
  if (record.plan.status === "conditional" || record.plan.excludedSlotIds.length > 0 || record.plan.excludedPlayerIds.length > 0 || (record.snapshot.model?.excludedRules.length ?? 0) > 0 || origins.includes("model-conditional")) return "limited";
  return "unrestricted";
}

/** Latest pre-listed-kickoff receipt per league/team/week, chosen BEFORE observing results.
 * An independently ineligible/pending latest receipt never falls back to an older winner.
 * The caller must supply the most-recent server-ordered batch, not selected favorable rows.
 */
export function summarizeDecisionResults(inputs: readonly DecisionResultsInput[]): DecisionResultsReport {
  if (inputs.length > DECISION_RESULTS_LIMIT) throw new Error("Decision review exceeds its bounded batch.");
  if (new Set(inputs.map(input => input._id)).size !== inputs.length) throw new Error("Duplicate decision IDs in review batch.");
  const report: DecisionResultsReport = { inspected: inputs.length, invalidRecords: 0, lateOrUnknownRecords: 0, revisions: 0, rows: [], cohorts: [] };
  const candidates: { input: DecisionResultsInput; record: ParsedRecord }[] = [];
  for (const input of inputs) {
    try {
      if (input.recordJson.length > 700000 || input.observations.length > 20) throw new Error("Oversized record");
      const record = recordSchema.parse(JSON.parse(input.recordJson));
      if (record.timing !== "before-listed-kickoffs") report.lateOrUnknownRecords++;
      else candidates.push({ input, record });
    } catch { report.invalidRecords++; }
  }
  // An unreadable receipt may be the newest revision of ANY otherwise valid context.
  // Withhold the whole batch rather than accidentally resurrect an older winner.
  if (report.invalidRecords > 0) return report;
  candidates.sort((a, b) => b.record.recordedAt - a.record.recordedAt || a.input._id.localeCompare(b.input._id));
  const contexts = new Set<string>();
  for (const { input, record } of candidates) {
    const context = JSON.stringify([record.snapshot.leagueId, record.snapshot.ownerId, record.snapshot.season, record.snapshot.week]);
    if (contexts.has(context)) { report.revisions++; continue; }
    contexts.add(context);
    const scoringGroup = JSON.stringify([record.snapshot.leagueId, record.snapshot.ownerId, record.snapshot.season, record.snapshot.scoringId]);
    const row: DecisionResultsRow = { id: input._id, leagueName: record.snapshot.leagueName, season: record.snapshot.season, week: record.snapshot.week, recordedAt: record.recordedAt, scoringGroup, teamId: record.snapshot.ownerId, scoringId: record.snapshot.scoringId, cohort: cohortOf(record), status: "pending", difference: null };
    // Select the latest stored observation even when it is pending or invalid. Never backfill a better outcome.
    const observations = [...input.observations].sort((a, b) => b.observedAt - a.observedAt);
    if (observations.length > 0) {
      try {
        const latest = observations[0];
        if (observations.some(o => !Number.isFinite(o.observedAt) || o.observedAt < record.recordedAt || o.observedAt > 8.64e15)) throw new Error("Invalid observation time");
        if (observations.some(o => o !== latest && o.observedAt === latest.observedAt && o.evaluationJson !== latest.evaluationJson)) throw new Error("Conflicting observations");
        if (latest.evaluationJson.length > 64000) throw new Error("Oversized evaluation");
        const evaluation = evaluationSchema.parse(JSON.parse(latest.evaluationJson));
        row.status = evaluation.status;
        if (evaluation.status === "complete") {
          const { actualDifference, originalActualPoints, recommendedActualPoints } = evaluation;
          if (actualDifference === null || originalActualPoints === null || recommendedActualPoints === null || Math.abs(recommendedActualPoints - originalActualPoints - actualDifference) > 1e-6) throw new Error("Incomplete or inconsistent totals");
          row.difference = actualDifference;
        }
      } catch { row.status = "unavailable"; }
    }
    report.rows.push(row);
  }
  const groups = new Map(report.rows.map(row => [JSON.stringify([row.scoringGroup, row.cohort]), row]));
  report.cohorts = [...groups].map(([key, sample]) => {
    const complete = report.rows.filter(row => row.scoringGroup === sample.scoringGroup && row.cohort === sample.cohort && row.status === "complete");
    const difference = complete.length > 0 ? complete.reduce((sum, row) => sum + row.difference!, 0) : null;
    return { key, scoringGroup: sample.scoringGroup, teamId: sample.teamId, scoringId: sample.scoringId, leagueName: sample.leagueName, season: sample.season, cohort: sample.cohort, complete: complete.length, weeks: new Set(complete.map(row => `${row.season}:${row.week}`)).size, difference, meanDifference: difference === null ? null : difference / complete.length };
  });
  return report;
}
