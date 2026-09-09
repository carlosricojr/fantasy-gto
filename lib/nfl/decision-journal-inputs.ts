import { z } from "zod";
import type { WeeklyLineupSnapshot } from "./weekly-lineup";

const finite = z.number().finite();
const timestamp = finite.min(0).max(8.64e15);
const id = z.string().min(1).max(100);
const text = z.string().max(2000);
const status = z.enum(["active", "questionable", "doubtful", "out", "inactive", "bye", "reserve", "unknown"]);
const conditional = z.object({
  points: finite.min(-10000).max(10000),
  condition: z.literal("active-at-kickoff"),
  missingEvidence: z.literal("team-injury-report"),
}).strict();

/** Bounded, versioned journal input. Unknown fields fail rather than lose provenance. */
export const weeklyDecisionSnapshotSchema = z.object({
  leagueId: z.string().regex(/^\d{1,30}$/),
  ownerId: z.string().regex(/^\d{1,30}$/),
  season: z.number().int().min(2000).max(2100),
  week: z.number().int().min(1).max(18),
  scoringId: z.string().min(1).max(16000),
  leagueName: z.string().min(1).max(300),
  slots: z.array(z.object({ id, label: z.string().min(1).max(100), eligiblePositions: z.array(id).min(1).max(12) }).strict()).min(1).max(12),
  players: z.array(z.object({
    id,
    name: z.string().min(1).max(300),
    positions: z.array(id).min(1).max(12),
    availability: status,
    kickoffAt: timestamp.nullable(),
    currentSlotId: id.nullable(),
    projectedPoints: finite.min(-10000).max(10000).nullable(),
    projectionOrigin: z.enum(["model", "model-conditional", "manual"]).optional(),
    conditionalEstimate: conditional.optional(),
    projectionMissingReason: text.nullable().optional(),
    projectionEnteredAt: timestamp.optional(),
    team: z.string().max(20).nullable().optional(),
    gameId: id.nullable().optional(),
    gameContextConflict: z.boolean().optional(),
    nflverseAvailability: status.optional(),
    injuryCoverage: z.enum(["available", "unavailable"]).optional(),
    modelGameContextChecked: z.boolean().optional(),
  }).strict()).min(1).max(32),
  source: z.string().min(1).max(2000),
  retrievedAt: timestamp,
  projectionUpdatedAt: timestamp.nullable(),
  rosterRetrievedAt: timestamp,
  warnings: z.array(text).max(200).optional(),
  model: z.object({
    source: z.string().min(1).max(2000),
    computedAt: timestamp,
    providerUpdatedAt: timestamp.nullable(),
    excludedRules: z.array(z.string().max(100)).max(200),
    warnings: z.array(text).max(200),
    coverage: z.object({ requested: z.number().int().min(0).max(1000), projected: z.number().int().min(0).max(1000) }).strict(),
  }).strict().optional(),
  refreshFailed: z.boolean().optional(),
}).strict() satisfies z.ZodType<WeeklyLineupSnapshot>;

export const weeklyDecisionPreferencesSchema = z.object({
  holdUnpricedPositions: z.array(z.enum(["K", "DST"])).max(2).default([]),
  compareAvailableEstimates: z.boolean().default(false),
  allowConditionalEstimates: z.boolean().default(false),
}).strict();

export type WeeklyDecisionPreferences = z.output<typeof weeklyDecisionPreferencesSchema>;

/** At most 128K UTF-16 code units; even four-byte UTF-8 remains below a Convex document. */
export const MAX_DECISION_JSON_LENGTH = 128 * 1024;

export function parseWeeklyDecisionInput(snapshotJson: string, preferencesJson: string): {
  snapshot: WeeklyLineupSnapshot; preferences: WeeklyDecisionPreferences;
} {
  if (snapshotJson.length > MAX_DECISION_JSON_LENGTH || preferencesJson.length > 1024) throw new Error("Decision input is too large.");
  return {
    snapshot: weeklyDecisionSnapshotSchema.parse(JSON.parse(snapshotJson)),
    preferences: weeklyDecisionPreferencesSchema.parse(JSON.parse(preferencesJson)),
  };
}
