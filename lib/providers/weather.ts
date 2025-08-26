import { getCachedJson, setCachedJson } from "@/lib/cache/redis";

const API = "https://api.openweathermap.org/data/2.5";
const TTL_SECONDS = 3600; // 60m default

export async function getForecast<T = unknown>(lat: number, lon: number): Promise<T> {
  const key = `owm:forecast:${lat.toFixed(2)}:${lon.toFixed(2)}`;
  const cached = await getCachedJson<T>(key);
  if (cached) return cached;
  const url = `${API}/forecast?lat=${lat}&lon=${lon}&appid=${process.env.WEATHER_API_KEY}&units=imperial`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`OpenWeatherMap error ${res.status}`);
  const json = (await res.json()) as T;
  await setCachedJson(key, json, TTL_SECONDS);
  return json;
}


