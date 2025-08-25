import crypto from "node:crypto";
import { getCachedJson, setCachedJson } from "@/lib/cache/redis";

const ESPN_BASE = "https://lm.espn.com/apis/v3/games/ffl";

function getKey(): Buffer {
  const b64 = process.env.ESPN_TOKEN_ENC_KEY;
  if (!b64) throw new Error("ESPN_TOKEN_ENC_KEY not set");
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error("ESPN_TOKEN_ENC_KEY must be 32 bytes (base64)");
  return key;
}

export function encryptToken(plain: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptToken(token: string): string {
  const key = getKey();
  const buf = Buffer.from(token, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString("utf8");
}

type EspnOpts = { s2?: string; swid?: string };

function buildCookie(opts?: EspnOpts): string | undefined {
  if (!opts?.s2 || !opts?.swid) return undefined;
  return `espn_s2=${opts.s2}; SWID=${opts.swid}`;
}

async function fetchJson<T>(url: string, opts?: EspnOpts): Promise<T> {
  const headers: Record<string, string> = { "accept": "application/json" };
  const cookie = buildCookie(opts);
  if (cookie) headers["cookie"] = cookie;
  const res = await fetch(url, { headers, cache: "no-store" });
  if (!res.ok) throw new Error(`ESPN error ${res.status}`);
  return res.json() as Promise<T>;
}

export async function getLeague(season: number, leagueId: string, opts?: EspnOpts) {
  const cacheKey = `espn:league:${season}:${leagueId}`;
  const cached = await getCachedJson<any>(cacheKey);
  if (cached) return cached;
  const url = `${ESPN_BASE}/seasons/${season}/segments/0/leagues/${leagueId}?view=mSettings`;
  const data = await fetchJson<any>(url, opts);
  await setCachedJson(cacheKey, data, 300);
  return data;
}

export async function getRoster(
  season: number,
  leagueId: string,
  teamId: string,
  week?: number,
  opts?: EspnOpts
) {
  const keyWeek = week ?? 0;
  const cacheKey = `espn:roster:${season}:${leagueId}:${teamId}:${keyWeek}`;
  const cached = await getCachedJson<any>(cacheKey);
  if (cached) return cached;
  const params = new URLSearchParams({ view: "mRoster" });
  if (week) params.set("scoringPeriodId", String(week));
  const url = `${ESPN_BASE}/seasons/${season}/segments/0/leagues/${leagueId}?${params}`;
  const data = await fetchJson<any>(url, opts);
  await setCachedJson(cacheKey, data, 300);
  return data;
}

export async function getScoreboard(season: number, leagueId: string, week: number, opts?: EspnOpts) {
  const cacheKey = `espn:score:${season}:${leagueId}:${week}`;
  const cached = await getCachedJson<any>(cacheKey);
  if (cached) return cached;
  const params = new URLSearchParams({ view: "mScoreboard", scoringPeriodId: String(week) });
  const url = `${ESPN_BASE}/seasons/${season}/segments/0/leagues/${leagueId}?${params}`;
  const data = await fetchJson<any>(url, opts);
  await setCachedJson(cacheKey, data, 300);
  return data;
}


