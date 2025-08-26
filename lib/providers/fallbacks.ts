import { getNflOdds } from "./odds-api";
import { getInjuries } from "./sports-data-io";
import { getForecast } from "./weather";
import { getCachedJson, setCachedJson } from "@/lib/cache/redis";

export async function getOddsWithFallback(market: string) {
  const cacheKey = `fallback:odds:${market}`;
  const cached = await getCachedJson<unknown>(cacheKey);
  if (cached) return { provider: "cache", data: cached };
  try {
    const primary = await getNflOdds<unknown>(market);
    await setCachedJson(cacheKey, primary, 300);
    return { provider: "OddsAPI", data: primary };
  } catch {
    try {
      const sd = await getInjuries<unknown>("current", 0); // placeholder; Odds fallback via SDIO odds endpoint if added
      await setCachedJson(cacheKey, sd, 300);
      return { provider: "SportsDataIO", data: sd };
    } catch {
      const last = await getCachedJson<unknown>(cacheKey);
      if (last) return { provider: "cache", data: last };
      return { provider: "disabled", data: null };
    }
  }
}

export async function getWeatherWithFallback(lat: number, lon: number) {
  const cacheKey = `fallback:weather:${lat.toFixed(2)}:${lon.toFixed(2)}`;
  const cached = await getCachedJson<unknown>(cacheKey);
  if (cached) return { provider: "cache", data: cached };
  try {
    const wx = await getForecast<unknown>(lat, lon);
    await setCachedJson(cacheKey, wx, 3600);
    return { provider: "OpenWeatherMap", data: wx };
  } catch {
    const last = await getCachedJson<unknown>(cacheKey);
    if (last) return { provider: "cache", data: last };
    // Stadium defaults
    const defaults = { tempF: 70, windMph: 0, indoor: true };
    return { provider: "defaults", data: defaults };
  }
}

export async function getInjuriesWithFallback(season: string, week: number) {
  const cacheKey = `fallback:injuries:${season}:${week}`;
  const cached = await getCachedJson<unknown>(cacheKey);
  if (cached) return { provider: "cache", data: cached };
  try {
    const sd = await getInjuries<unknown>(season, week);
    await setCachedJson(cacheKey, sd, 600);
    return { provider: "SportsDataIO", data: sd };
  } catch {
    // Admin override and conservative projections handled in app logic
    const conservative = { note: "conservative projections due to injuries fallback" };
    await setCachedJson(cacheKey, conservative, 300);
    return { provider: "conservative", data: conservative };
  }
}


