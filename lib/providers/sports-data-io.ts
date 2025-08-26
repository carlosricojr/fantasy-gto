import { getCachedJson, setCachedJson } from "@/lib/cache/redis";

const API = "https://api.sportsdata.io/v3/nfl";
const TTL_SECONDS = 300; // 5-15m depending on endpoint; start with 5m

export async function getInjuries<T = unknown>(season: string, week: number): Promise<T> {
  const key = `sdataio:injuries:${season}:${week}`;
  const cached = await getCachedJson<T>(key);
  if (cached) return cached;
  const url = `${API}/scores/json/Injuries/${season}/${week}?key=${process.env.SPORTSDATAIO_KEY}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`SportsDataIO error ${res.status}`);
  const json = (await res.json()) as T;
  await setCachedJson(key, json, TTL_SECONDS);
  return json;
}


