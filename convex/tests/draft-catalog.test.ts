import { getFunctionName } from "convex/server";
import type { FunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";

import { runRefreshDraftPlayerCatalog } from "../ingest";
import {
  NflverseProvider,
  schedulesUrl,
  seasonRosterUrl,
} from "../../lib/sources/nflverse";

const SEASON = 2026;

function rosterCsv(activeCount: number): string {
  const header =
    "season,team,position,status,full_name,gsis_id,sleeper_id,rookie_year";
  const active = Array.from({ length: activeCount }, (_, index) =>
    [
      SEASON,
      "KC",
      index % 2 === 0 ? "WR" : "RB",
      "ACT",
      `Active ${index}`,
      `00-005${String(index).padStart(4, "0")}`,
      `8${String(index).padStart(4, "0")}`,
      2024,
    ].join(","),
  );
  return [
    header,
    ...active,
    `${SEASON},SEA,RB,RES,Reserve Veteran,00-0060001,90001,2023`,
    `${SEASON},GB,RB,EXE,Exempt Veteran,00-0060002,90002,2020`,
    `${SEASON},NYJ,K,ACT,No GSIS Kicker,,90003,2022`,
    `${SEASON},SF,WR,W04,New Code Veteran,00-0060004,90004,2021`,
  ].join("\n");
}

function provider(activeCount: number): NflverseProvider {
  return new NflverseProvider(async (url) => {
    if (url === seasonRosterUrl(SEASON)) return rosterCsv(activeCount);
    if (url === schedulesUrl()) {
      return "game_id,season,game_type,week,gameday,gametime,away_team,home_team";
    }
    throw new Error(`unexpected url ${url}`);
  });
}

function recordingCtx(current: { fingerprint: string } | null = null) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const ctx = {
    runQuery: async () => current,
    runMutation: async (
      ref: FunctionReference<"mutation", "internal">,
      args: Record<string, unknown>,
    ) => {
      const fn = getFunctionName(ref);
      calls.push({ fn, args });
      if (fn === "draft:pruneCatalog") return { deleted: 0, more: false };
      return "job_1";
    },
  } as unknown as Parameters<typeof runRefreshDraftPlayerCatalog>[0];
  return { ctx, calls };
}

describe("runRefreshDraftPlayerCatalog", () => {
  it("publishes active, unpriced and unavailable identities as one atomic snapshot", async () => {
    const { ctx, calls } = recordingCtx();
    const result = await runRefreshDraftPlayerCatalog(ctx, SEASON, provider(300));

    // 300 ordinary active players plus the active no-GSIS kicker.
    expect(result.active).toBe(301);
    expect(result.players).toBe(304);
    expect(result.unknownStatuses).toEqual([{ code: "W04", count: 1 }]);
    expect(result.unchanged).toBe(false);

    const catalogRows = calls
      .filter((call) => call.fn === "draft:upsertCatalogBatch")
      .flatMap((call) => call.args.rows as Array<Record<string, unknown>>);
    expect(catalogRows.find((row) => row.name === "No GSIS Kicker")).toMatchObject({
      playerId: "sleeper:90003",
      rosterStatus: "active",
    });
    expect(catalogRows.find((row) => row.name === "Exempt Veteran")).toMatchObject({
      rosterStatus: "reserve",
      rosterStatusCode: "EXE",
    });

    const order = calls.map((call) => call.fn);
    expect(order.indexOf("draft:publishCatalog")).toBeGreaterThan(
      order.lastIndexOf("draft:upsertCatalogBatch"),
    );
    expect(order.indexOf("draft:pruneCatalog")).toBeGreaterThan(
      order.indexOf("draft:publishCatalog"),
    );
  });

  it("verifies an unchanged snapshot without rewriting every player", async () => {
    const first = recordingCtx();
    await runRefreshDraftPlayerCatalog(first.ctx, SEASON, provider(300));
    const fingerprint = first.calls.find(
      (call) => call.fn === "draft:publishCatalog",
    )?.args.fingerprint;
    expect(typeof fingerprint).toBe("string");

    const second = recordingCtx({ fingerprint: fingerprint as string });
    const result = await runRefreshDraftPlayerCatalog(
      second.ctx,
      SEASON,
      provider(300),
    );
    expect(result.unchanged).toBe(true);
    expect(
      second.calls.filter((call) => call.fn === "draft:upsertCatalogBatch"),
    ).toHaveLength(0);
    expect(second.calls.some((call) => call.fn === "draft:touchCatalog")).toBe(true);
  });

  it("keeps the previous snapshot live when the source is implausibly thin", async () => {
    const { ctx, calls } = recordingCtx();
    await expect(
      runRefreshDraftPlayerCatalog(ctx, SEASON, provider(298)),
    ).rejects.toThrow("truncated or its status codes changed");
    expect(calls.some((call) => call.fn === "draft:publishCatalog")).toBe(false);
    const finish = calls.filter((call) => call.fn === "jobs:finish").at(-1);
    expect(finish?.args.status).toBe("failed");
  });
});
