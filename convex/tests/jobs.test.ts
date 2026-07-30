import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "../_generated/api";
import schema from "../schema";

/**
 * Job records.
 *
 * These exist to be trusted when something has gone wrong, so the invariant that matters
 * is that a finished job stays finished and keeps the outcome that actually explains what
 * happened.
 */
const modules = import.meta.glob([
  "../**/*.ts",
  "../**/*.js",
  "!../**/*.d.ts",
  "!../**/*.test.ts",
  "!../tests/**",
]);

function asUser(t: ReturnType<typeof convexTest>, subject: string) {
  return t.withIdentity({ subject, issuer: "https://clerk.test" });
}

async function startJob(t: ReturnType<typeof convexTest>) {
  return t.mutation(internal.jobs.start, { kind: "test", detail: "a job" });
}

async function readJob(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => await ctx.db.query("jobs").first());
}

describe("progress", () => {
  it("records a valid update", async () => {
    const t = convexTest(schema, modules);
    const jobId = await startJob(t);
    await t.mutation(internal.jobs.progress, { jobId, processed: 10, total: 100 });

    const job = await readJob(t);
    expect(job?.processed).toBe(10);
    expect(job?.total).toBe(100);
  });

  it.each([
    ["negative processed", -1, 100],
    ["negative total", 10, -5],
    ["processed beyond total", 150, 100],
    ["fractional counts", 1.5, 100],
  ])("ignores %s", async (_name, processed, total) => {
    const t = convexTest(schema, modules);
    const jobId = await startJob(t);
    await t.mutation(internal.jobs.progress, { jobId, processed, total });

    const job = await readJob(t);
    expect(job?.processed).toBe(0);
    expect(job?.total).toBe(0);
  });

  it("ignores a late update after the job has finished", async () => {
    // A finished job showing a moving progress bar would undermine the record's purpose.
    const t = convexTest(schema, modules);
    const jobId = await startJob(t);
    await t.mutation(internal.jobs.progress, { jobId, processed: 50, total: 100 });
    await t.mutation(internal.jobs.finish, { jobId, status: "succeeded", error: null });
    await t.mutation(internal.jobs.progress, { jobId, processed: 99, total: 100 });

    expect((await readJob(t))?.processed).toBe(50);
  });
});

describe("finish", () => {
  it("marks a running job terminal", async () => {
    const t = convexTest(schema, modules);
    const jobId = await startJob(t);
    await t.mutation(internal.jobs.finish, { jobId, status: "succeeded", error: null });

    const job = await readJob(t);
    expect(job?.status).toBe("succeeded");
    expect(job?.finishedAt).not.toBeNull();
  });

  it("keeps the first outcome when called again", async () => {
    // A retried action must not overwrite the failure that explains what happened.
    const t = convexTest(schema, modules);
    const jobId = await startJob(t);
    await t.mutation(internal.jobs.finish, {
      jobId,
      status: "failed",
      error: "the real cause",
    });
    await t.mutation(internal.jobs.finish, { jobId, status: "succeeded", error: null });

    const job = await readJob(t);
    expect(job?.status).toBe("failed");
    expect(job?.error).toBe("the real cause");
  });
});

describe("latest", () => {
  it("requires a signed-in caller", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.jobs.latest, { kind: "test" })).rejects.toThrow(/signed in/);
  });

  it("never exposes internal error text", async () => {
    // Job failures quote upstream messages and identifiers — operator information.
    const t = convexTest(schema, modules);
    await asUser(t, "op").mutation(api.users.ensure, {});
    const jobId = await startJob(t);
    await t.mutation(internal.jobs.finish, {
      jobId,
      status: "failed",
      error: "https://internal.example/secret responded 500",
    });

    const latest = await asUser(t, "op").query(api.jobs.latest, { kind: "test" });
    expect(latest).not.toBeNull();
    expect(latest?.status).toBe("failed");
    expect(JSON.stringify(latest)).not.toContain("secret");
    expect(JSON.stringify(latest)).not.toContain("internal.example");
  });

  it("returns null for a kind that has never run", async () => {
    const t = convexTest(schema, modules);
    await asUser(t, "op").mutation(api.users.ensure, {});
    await expect(
      asUser(t, "op").query(api.jobs.latest, { kind: "nothing" }),
    ).resolves.toBeNull();
  });
});
