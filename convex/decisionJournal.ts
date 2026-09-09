import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { createWeeklyDecisionRecord, evaluateWeeklyDecision, type WeeklyDecisionRecord } from "../lib/nfl/decision-journal";
import { parseWeeklyDecisionInput } from "../lib/nfl/decision-journal-inputs";
import { fetchWeeklyDecisionOutcomes } from "../lib/sources/weekly-decision-outcomes";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, mutation } from "./_generated/server";
import { invalid, notFound, requireEntitlement } from "./lib/auth";
import { requireTimedEntitlement } from "./lib/timedEntitlement";
import { admitPersonalOperation } from "./lib/personalQuota";

const timing = v.union(v.literal("before-listed-kickoffs"), v.literal("after-listed-kickoff"), v.literal("unknown-kickoff"));
const summaryValidator = v.object({ _id: v.id("weeklyDecisions"), recordedAt: v.number(), leagueName: v.string(), season: v.number(), week: v.number(), timing });
const observationValidator = v.object({ observedAt: v.number(), outcomeJson: v.string(), evaluationJson: v.string() });
const detailValidator = v.union(v.null(), v.object({ _id: v.id("weeklyDecisions"), recordJson: v.string(), observations: v.array(observationValidator) }));
const pageValidator = v.object({ page: v.array(summaryValidator), isDone: v.boolean(), continueCursor: v.string() });
type Summary = { _id: Id<"weeklyDecisions">; recordedAt: number; leagueName: string; season: number; week: number; timing: WeeklyDecisionRecord["timing"] };
type Detail = { _id: Id<"weeklyDecisions">; recordJson: string; observations: { observedAt: number; outcomeJson: string; evaluationJson: string }[] } | null;
type Page = { page: Summary[]; isDone: boolean; continueCursor: string };

export const create = mutation({
  args: { snapshotJson: v.string(), preferencesJson: v.string(), requestId: v.string() }, returns: v.id("weeklyDecisions"),
  handler: async (ctx, args) => {
    const user = await requireEntitlement(ctx, "performance_history");
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(args.requestId)) throw invalid("Invalid decision request ID.");
    let supplied;
    try { supplied = parseWeeklyDecisionInput(args.snapshotJson, args.preferencesJson); } catch { throw invalid("Decision inputs are invalid or too large."); }
    const existing = await ctx.db.query("weeklyDecisions").withIndex("by_user_request", (q) => q.eq("userId", user._id).eq("requestId", args.requestId)).first();
    if (existing) {
      const prior = JSON.parse(existing.recordJson) as WeeklyDecisionRecord;
      if (JSON.stringify([prior.snapshot, prior.preferences]) !== JSON.stringify([supplied.snapshot, supplied.preferences])) throw invalid("This request ID already belongs to different decision inputs.");
      return existing._id;
    }
    await admitPersonalOperation(ctx, "journal-save");
    const storage = await ctx.db.query("personalUsage").withIndex("by_user_operation", (q) => q.eq("userId", user._id).eq("operation", "journal-save")).first();
    // New release tables start empty. An older dev row without accounting must
    // fail closed, not assume zero or read hundreds of large record payloads.
    if (!storage || (storage.retainedDecisions === undefined && await ctx.db.query("weeklyDecisions").withIndex("by_user_time", (q) => q.eq("userId", user._id)).first())) throw invalid("Decision storage accounting needs repair before another record can be saved. Existing records are unchanged.");
    const retained = storage.retainedDecisions ?? 0;
    if (!Number.isInteger(retained) || retained < 0 || retained >= 500) throw invalid("The 500 retained-decision limit has been reached. No history was deleted. Individual removal and export are not currently available.");
    let record: WeeklyDecisionRecord;
    try { record = createWeeklyDecisionRecord(args.snapshotJson, args.preferencesJson, Date.now()); } catch (cause) { throw invalid(cause instanceof Error ? cause.message : "Cannot record this decision."); }
    const recordJson = JSON.stringify(record);
    if (new TextEncoder().encode(recordJson).length > 700_000) throw invalid("Decision record is too large.");
    await ctx.db.patch(storage._id, { retainedDecisions: retained + 1 });
    return ctx.db.insert("weeklyDecisions", { userId: user._id, requestId: args.requestId, recordJson, recordedAt: record.recordedAt, leagueName: record.snapshot.leagueName, season: record.snapshot.season, week: record.snapshot.week, timing: record.timing });
  },
});

/** Actions provide server time. Query callers cannot forge a grace-period clock. */
export const list = action({ args: { paginationOpts: paginationOptsValidator }, returns: pageValidator,
  handler: async (ctx, args): Promise<Page> => {
    await ctx.runMutation(internal.personalTools.admit, { operation: "journal-read" });
    return ctx.runQuery(internal.decisionJournal.listOwned, { ...args, now: Date.now() });
  },
});
export const listOwned = internalQuery({ args: { paginationOpts: paginationOptsValidator, now: v.number() }, returns: pageValidator,
  handler: async (ctx, { paginationOpts, now }) => {
    const user = await requireTimedEntitlement(ctx, "performance_history", now);
    if (!Number.isInteger(paginationOpts.numItems) || paginationOpts.numItems < 1 || paginationOpts.numItems > 20) throw invalid("Request 1–20 decisions per page.");
    // Never forward client endCursor/maximumRowsRead: endCursor can bypass
    // numItems and turn a requested one-row page into an unbounded range read.
    const result = await ctx.db.query("weeklyDecisions").withIndex("by_user_time", (q) => q.eq("userId", user._id)).order("desc").paginate({ numItems: paginationOpts.numItems, cursor: paginationOpts.cursor, maximumRowsRead: 20, maximumBytesRead: 4_000_000 });
    return { isDone: result.isDone, continueCursor: result.continueCursor, page: result.page.map(({ _id, recordedAt, leagueName, season, week, timing }) => ({ _id, recordedAt, leagueName, season, week, timing })) };
  },
});
export const detail = action({ args: { id: v.id("weeklyDecisions") }, returns: detailValidator,
  handler: async (ctx, args): Promise<Detail> => {
    await ctx.runMutation(internal.personalTools.admit, { operation: "journal-read" });
    return ctx.runQuery(internal.decisionJournal.detailOwned, { ...args, now: Date.now() });
  },
});
export const detailOwned = internalQuery({ args: { id: v.id("weeklyDecisions"), now: v.number() }, returns: detailValidator,
  handler: async (ctx, { id, now }) => {
    const user = await requireTimedEntitlement(ctx, "performance_history", now);
    const row = await ctx.db.get(id);
    if (!row || row.userId !== user._id) return null;
    const observations = await ctx.db.query("weeklyDecisionObservations").withIndex("by_decision_time", (q) => q.eq("decisionId", id)).order("desc").take(20);
    return { _id: row._id, recordJson: row.recordJson, observations: observations.map(({ observedAt, outcomeJson, evaluationJson }) => ({ observedAt, outcomeJson, evaluationJson })) };
  },
});
export const refreshOutcomes = action({ args: { id: v.id("weeklyDecisions") }, returns: v.null(),
  handler: async (ctx, { id }): Promise<null> => {
    await ctx.runMutation(internal.personalTools.admit, { operation: "journal-refresh" });
    const owned = await ctx.runQuery(internal.decisionJournal.detailOwned, { id, now: Date.now() });
    if (!owned) throw notFound("That decision does not exist.");
    if (owned.observations.length >= 20) throw invalid("This decision has reached its 20-observation limit. Existing observations remain unchanged; no additional source request was sent.");
    if (owned.observations[0] && Date.now() - owned.observations[0].observedAt < 60_000) throw invalid("Wait one minute before checking this decision's outcomes again.");
    const record = JSON.parse(owned.recordJson) as WeeklyDecisionRecord;
    try {
      const outcome = await fetchWeeklyDecisionOutcomes(record, { now: Date.now() });
      const evaluation = evaluateWeeklyDecision(record, outcome);
      return await ctx.runMutation(internal.decisionJournal.appendObservation, { id, observedAt: outcome.fetchedAt, outcomeJson: JSON.stringify(outcome), evaluationJson: JSON.stringify(evaluation) });
    } catch (cause) { throw invalid(cause instanceof Error ? cause.message : "Outcome sources are unavailable. No observation was written."); }
  },
});
/** No public function accepts claimed actual scores. Only the source action appends observations. */
export const appendObservation = internalMutation({ args: { id: v.id("weeklyDecisions"), observedAt: v.number(), outcomeJson: v.string(), evaluationJson: v.string() }, returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireEntitlement(ctx, "performance_history");
    const row = await ctx.db.get(args.id);
    if (!row || row.userId !== user._id) throw notFound("That decision does not exist.");
    if (!Number.isFinite(args.observedAt) || args.observedAt < row.recordedAt || args.observedAt > Date.now() || args.outcomeJson.length > 64_000 || args.evaluationJson.length > 64_000 || new TextEncoder().encode(args.outcomeJson + args.evaluationJson).length > 128_000) throw invalid("Invalid outcome observation.");
    const observations = await ctx.db.query("weeklyDecisionObservations").withIndex("by_decision_time", (q) => q.eq("decisionId", args.id)).order("desc").take(20);
    const latest = observations[0];
    if (latest && args.observedAt - latest.observedAt < 60_000) throw invalid("An outcome check was already recorded within the last minute.");
    // A refresh that changes retrieval time only is not a new observation.
    // Preserve its original timestamp rather than rewriting the history row.
    if (latest && semanticJson(latest.outcomeJson, true) === semanticJson(args.outcomeJson, true) && semanticJson(latest.evaluationJson) === semanticJson(args.evaluationJson)) return null;
    if (observations.length >= 20) throw invalid("This decision has reached its 20-observation limit. No observation was replaced or deleted.");
    await ctx.db.insert("weeklyDecisionObservations", { userId: user._id, decisionId: args.id, observedAt: args.observedAt, outcomeJson: args.outcomeJson, evaluationJson: args.evaluationJson });
    return null;
  },
});

function semanticJson(raw: string, outcome = false): string {
  const value: unknown = JSON.parse(raw);
  if (outcome && value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    delete record.fetchedAt;
    if (Array.isArray(record.completePlayerIds)) record.completePlayerIds = [...record.completePlayerIds].sort();
  }
  const ordered = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(ordered) : entry && typeof entry === "object" ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, ordered(child)])) : entry;
  return JSON.stringify(ordered(value));
}
