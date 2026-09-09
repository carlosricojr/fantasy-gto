/** Public Sleeper identity inputs. A link is parsed, never fetched as an arbitrary URL. */
export function sleeperLeagueId(input: string): string | null {
  const value = input.trim();
  if (/^\d{1,30}$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !["sleeper.com", "sleeper.app", "www.sleeper.com", "www.sleeper.app"].includes(url.hostname)) return null;
    return /^\/(?:leagues?|i\/league)\/(\d{1,30})(?:\/.*)?$/.exec(url.pathname)?.[1] ?? null;
  } catch { return null; }
}

export function sleeperUserInput(input: string): string | null {
  const value = input.trim().replace(/^@/, "");
  return /^[a-zA-Z0-9_\-.]{1,40}$/.test(value) ? value : null;
}

export interface SleeperConnection {
  leagueId: string;
  ownerId: string;
  leagueName: string;
  username: string;
  season: number;
}

export function weeklyLineupHref(connection: Pick<SleeperConnection, "leagueId" | "ownerId">, week?: number): string {
  const params = new URLSearchParams({ leagueId: connection.leagueId, ownerId: connection.ownerId });
  if (week !== undefined && Number.isInteger(week) && week >= 1 && week <= 18) params.set("week", String(week));
  return `/lineup/weekly?${params}`;
}

/** Invalid or repeated parameters are ignored; visiting a link never initiates an import. */
export function weeklyLineupPrefill(query: string): { leagueId: string; ownerId: string; week: string } {
  const params = new URLSearchParams(query);
  const single = (key: string) => params.getAll(key).length === 1 ? params.get(key)! : "";
  const week = single("week");
  return { leagueId: sleeperLeagueId(single("leagueId")) ?? "", ownerId: /^\d{1,30}$/.test(single("ownerId")) ? single("ownerId") : "", week: /^(?:[1-9]|1[0-8])$/.test(week) ? week : "" };
}
