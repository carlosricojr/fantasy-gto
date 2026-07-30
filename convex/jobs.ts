import { v } from "convex/values";

import { internalMutation, query } from "./_generated/server";
import { requireUser } from "./lib/auth";

/**
 * Job records.
 *
 * Ingest fetches multi-megabyte files and writes thousands of rows, so it cannot run
 * inside one transaction. These records make a long run observable while it is happening
 * and diagnosable after it fails, rather than leaving a silent gap.
 */

export const start = internalMutation({
  args: { kind: v.string(), detail: v.string() },
  handler: async (ctx, { kind, detail }) => {
    return await ctx.db.insert("jobs", {
      kind,
      status: "running",
      detail,
      processed: 0,
      total: 0,
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
    });
  },
});

/**
 * Records progress on a running job.
 *
 * Ignores an update once the job has reached a terminal state, and refuses counts that
 * cannot be real. A late or malformed progress call is a caller bug, and persisting it
 * would leave a finished job displaying a moving bar — the record exists to be trusted
 * when something goes wrong, so it must not itself be a source of confusion.
 */
export const progress = internalMutation({
  args: { jobId: v.id("jobs"), processed: v.number(), total: v.number() },
  handler: async (ctx, { jobId, processed, total }) => {
    if (!Number.isInteger(processed) || !Number.isInteger(total)) return;
    if (processed < 0 || total < 0 || processed > total) return;

    const job = await ctx.db.get(jobId);
    if (!job || job.status !== "running") return;

    await ctx.db.patch(jobId, { processed, total });
  },
});

/**
 * Marks a job terminal.
 *
 * Idempotent: an already-finished job keeps its original outcome. A retried action could
 * otherwise overwrite the first failure's message with a second one, losing the error that
 * actually explains what happened.
 */
export const finish = internalMutation({
  args: {
    jobId: v.id("jobs"),
    status: v.union(v.literal("succeeded"), v.literal("failed")),
    error: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { jobId, status, error }) => {
    const job = await ctx.db.get(jobId);
    if (!job || job.status !== "running") return;

    await ctx.db.patch(jobId, { status, error, finishedAt: Date.now() });
  },
});

/**
 * The most recent run of a kind.
 *
 * Requires a signed-in caller and returns only progress, never `error` or `detail`. Job
 * failures quote upstream messages and internal identifiers, which is operator
 * information, not something to hand to an anonymous visitor.
 *
 * Uses the `by_kind_started` index in descending order and takes one row, rather than
 * collecting every historical run and sorting in memory.
 */
export const latest = query({
  args: { kind: v.string() },
  handler: async (ctx, { kind }) => {
    await requireUser(ctx);
    const job = await ctx.db
      .query("jobs")
      .withIndex("by_kind_started", (q) => q.eq("kind", kind))
      .order("desc")
      .first();
    if (!job) return null;
    return {
      kind: job.kind,
      status: job.status,
      processed: job.processed,
      total: job.total,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    };
  },
});
