import { v } from "convex/values";

import { internalMutation, query } from "./_generated/server";

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

export const progress = internalMutation({
  args: { jobId: v.id("jobs"), processed: v.number(), total: v.number() },
  handler: async (ctx, { jobId, processed, total }) => {
    await ctx.db.patch(jobId, { processed, total });
  },
});

export const finish = internalMutation({
  args: {
    jobId: v.id("jobs"),
    status: v.union(v.literal("succeeded"), v.literal("failed")),
    error: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { jobId, status, error }) => {
    await ctx.db.patch(jobId, { status, error, finishedAt: Date.now() });
  },
});

/**
 * The most recent run of each kind.
 *
 * Uses the `by_kind_started` index in descending order and takes one row, rather than
 * collecting every historical run and sorting in memory.
 */
export const latest = query({
  args: { kind: v.string() },
  handler: async (ctx, { kind }) => {
    return await ctx.db
      .query("jobs")
      .withIndex("by_kind_started", (q) => q.eq("kind", kind))
      .order("desc")
      .first();
  },
});
