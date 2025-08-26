import { action } from "../../_generated/server";
import { v } from "convex/values";
import { internal, api } from "../../_generated/api";
// Convex actions cannot import app code; fetch ESPN directly here with "use node" semantics.
// Using the same URLs as the app provider.
const ESPN_BASE = "https://lm.espn.com/apis/v3/games/ffl";

function buildCookie(s2?: string, swid?: string) {
  if (!s2 || !swid) return undefined;
  return `espn_s2=${s2}; SWID=${swid}`;
}

async function fetchJson<T>(url: string, s2?: string, swid?: string): Promise<T> {
  const headers: Record<string, string> = { "accept": "application/json" };
  const cookie = buildCookie(s2, swid);
  if (cookie) headers["cookie"] = cookie;
  const res = await fetch(url, { headers, cache: "no-store" });
  if (!res.ok) throw new Error(`ESPN error ${res.status}`);
  return res.json() as Promise<T>;
}

type LeagueSettings = { scoringPeriodId?: number } | Record<string, unknown>;

export const getLeague = action({
  args: { season: v.number(), leagueId: v.string(), s2: v.optional(v.string()), swid: v.optional(v.string()) },
  handler: async (ctx, args): Promise<LeagueSettings> => {
    const url = `${ESPN_BASE}/seasons/${args.season}/segments/0/leagues/${args.leagueId}?view=mSettings`;
    return fetchJson<LeagueSettings>(url, args.s2, args.swid);
  },
});

type RosterResponse = Record<string, unknown>;

export const getRoster = action({
  args: { season: v.number(), leagueId: v.string(), teamId: v.string(), week: v.optional(v.number()), s2: v.optional(v.string()), swid: v.optional(v.string()) },
  handler: async (ctx, args): Promise<RosterResponse> => {
    const params = new URLSearchParams({ view: "mRoster" });
    if (args.week) params.set("scoringPeriodId", String(args.week));
    const url = `${ESPN_BASE}/seasons/${args.season}/segments/0/leagues/${args.leagueId}?${params}`;
    return fetchJson<RosterResponse>(url, args.s2, args.swid);
  },
});

type ScoreboardResponse = { schedule?: unknown[] } | Record<string, unknown>;

export const ingestWeek = action({
  args: { season: v.number(), leagueId: v.string(), week: v.number(), s2: v.optional(v.string()), swid: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ ok: true; matchups: number }> => {
    const url = `${ESPN_BASE}/seasons/${args.season}/segments/0/leagues/${args.leagueId}?view=mScoreboard&scoringPeriodId=${args.week}`;
    const data = await fetchJson<ScoreboardResponse>(url, args.s2, args.swid);
    const matchups = Array.isArray((data as any)?.schedule) ? ((data as any).schedule as unknown[]).length : 0;
    return { ok: true, matchups };
  },
});

export const importLeague = action({
  args: { season: v.number(), leagueId: v.string(), name: v.optional(v.string()) },
  handler: async (ctx, { season, leagueId, name }): Promise<{ ok: true; league: { _id: string } }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    let user = await ctx.runQuery(api.functions.auth.getUser, {});
    if (!user) {
      user = await ctx.runMutation(api.functions.auth.ensureUser, {});
      if (!user) throw new Error("Unable to provision user");
    }
    const ents = await ctx.runQuery(api.functions.auth.getEntitlements, {});
    const leagueEnt = ents.find((e: any) => e.key === "league_count" && e.active);
    let limit = 3 as number | typeof Infinity;
    if (leagueEnt) {
      const val = (leagueEnt as any).value;
      if (val === "unlimited") limit = Infinity;
      else if (typeof val === "number") limit = val;
      else if (typeof val === "string") {
        const n = Number(val);
        if (Number.isFinite(n) && n > 0) limit = n;
      }
    }
    if (Number.isFinite(limit)) {
      const count = await ctx.runQuery(api.functions.audit.countByActorAndKind, {
        actorUserId: user._id,
        kind: "league_import",
      });
      if (count >= (limit as number)) {
        throw new Error("League import limit reached for current plan");
      }
    }
    await ctx.runMutation(internal.functions.audit.log, {
      kind: "league_import",
      actorUserId: user._id,
      payload: { season, leagueId, name },
    });
    const league = await ctx.runMutation(api.functions.leagues.upsertImported, {
      season,
      platform: "ESPN",
      externalId: leagueId,
      name,
    });
    return { ok: true, league };
  },
});


