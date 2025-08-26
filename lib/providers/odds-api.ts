import { getCachedJson, setCachedJson } from "@/lib/cache/redis";

const API = "https://api.the-odds-api.com/v4";
const TTL_SECONDS = 300; // 5m

export async function getNflOdds<T = unknown>(market: string): Promise<T> {
  const key = `oddsapi:nfl:${market}`;
  const cached = await getCachedJson<T>(key);
  if (cached) return cached;
  const url = `${API}/sports/americanfootball_nfl/odds?apiKey=${process.env.ODDS_API_KEY}&regions=us&markets=${market}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`OddsAPI error ${res.status}`);
  const json = (await res.json()) as T;
  await setCachedJson(key, json, TTL_SECONDS);
  return json;
}


