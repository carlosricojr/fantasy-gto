import type { WeeklyDecisionRecord, WeeklyDecisionOutcomes } from "../nfl/decision-journal";
import { parseSleeperScoring } from "../nfl/scoring/sleeper";
import { resolveWeeklyRosterTeam } from "../nfl/weekly-lineup-inputs";
import { NflverseProvider, httpTextFetcher, type TextFetcher } from "./nflverse";
import { leagueUrl } from "./sleeper";

const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed outcome source response.");
  return value as Record<string, unknown>;
};
const list = (value: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new Error("Incomplete league outcome context.");
  return value.map(object);
};

/** The documented matchup endpoint may omit player-level scores; never substitute team totals. */
export function parseDecisionMatchups(record: WeeklyDecisionRecord, leagueRaw: unknown, rostersRaw: unknown, matchupsRaw: unknown, stateRaw: unknown): { pointsByPlayer: Record<string, number>; weekClosed: boolean } {
  const { snapshot } = record;
  const league = object(leagueRaw);
  if (league.league_id !== snapshot.leagueId || Number(league.season) !== snapshot.season || league.sport !== "nfl") throw new Error("Outcome league/season does not match this decision.");
  const scoring = parseSleeperScoring(league.scoring_settings);
  if (!scoring.ok || scoring.profile.id !== snapshot.scoringId) throw new Error("League scoring has changed or cannot be verified; frozen scores cannot be compared safely.");
  const rosters = list(rostersRaw);
  const owners = rosters.filter(row => row.owner_id === snapshot.ownerId || (Array.isArray(row.co_owners) && row.co_owners.includes(snapshot.ownerId)));
  if (owners.length !== 1 || owners[0].league_id !== snapshot.leagueId || !Number.isInteger(owners[0].roster_id)) throw new Error("Cannot verify the saved team's current roster ownership.");
  const matchups = list(matchupsRaw);
  const own = matchups.filter(row => row.roster_id === owners[0].roster_id);
  if (own.length !== 1) throw new Error("No unique weekly matchup exists for this team.");
  if (own[0].custom_points !== null) throw new Error("Commissioner-adjusted team points cannot be compared as player-level lineup outcomes.");
  const ids = new Set(snapshot.players.map(player => player.id));
  const values = new Map<string, number>();
  for (const row of matchups) {
    if (row.players_points === undefined || row.players_points === null) continue;
    const scores = object(row.players_points);
    if (!Array.isArray(row.players) || row.players.some(id => typeof id !== "string")) throw new Error("Outcome roster identities are malformed.");
    for (const [id, points] of Object.entries(scores)) {
      if (!ids.has(id)) continue;
      if (!row.players.includes(id) || typeof points !== "number" || !Number.isFinite(points) || Math.abs(points) > 10000) throw new Error("Invalid player-level outcome score or identity.");
      if (values.has(id) && values.get(id) !== points) throw new Error("Conflicting player scores across weekly matchups.");
      values.set(id, points);
    }
  }
  const state = object(stateRaw);
  const season = Number(state.season);
  if (!Number.isInteger(season) || season < snapshot.season || !Number.isInteger(state.week) || Number(state.week) < 1 || Number(state.week) > 18) throw new Error("NFL state cannot establish the outcome period.");
  // Wait for the platform to move past the period, as well as posted game results.
  // This avoids treating pregame zeroes or in-progress scores as final outcomes.
  return { pointsByPlayer: Object.fromEntries(values), weekClosed: season > snapshot.season || Number(state.week) > snapshot.week };
}

/** User-triggered read-only observation. This fetches no forecasts and never reads the reserved 2025 holdout. */
export async function fetchWeeklyDecisionOutcomes(record: WeeklyDecisionRecord, options: { now: number }, fetchText: TextFetcher = httpTextFetcher): Promise<WeeklyDecisionOutcomes> {
  const { snapshot } = record;
  if (!/^\d{1,30}$/.test(snapshot.leagueId) || !/^\d{1,30}$/.test(snapshot.ownerId) || !Number.isInteger(snapshot.season) || snapshot.season < 2026 || !Number.isInteger(snapshot.week) || snapshot.week < 1 || snapshot.week > 18 || !Number.isFinite(options.now) || options.now < record.recordedAt) throw new Error("Outcome tracking supports prospectively saved decisions from 2026 onward.");
  const base = leagueUrl(snapshot.leagueId);
  const [league, rosters, matchups, state] = await Promise.all([fetchText(base), fetchText(`${base}/rosters`), fetchText(`${base}/matchups/${snapshot.week}`), fetchText("https://api.sleeper.app/v1/state/nfl")]);
  const parsed = parseDecisionMatchups(record, JSON.parse(league), JSON.parse(rosters), JSON.parse(matchups), JSON.parse(state));
  const provider = new NflverseProvider(fetchText);
  const [contests, identities, weekly] = await Promise.all([provider.allContests(), provider.draftRoster(snapshot.season), provider.weeklyRoster(snapshot.season)]);
  if (!contests.ok || !identities.ok || !weekly.ok) throw new Error("Independent game/weekly team context is unavailable; outcomes have not been finalized.");
  const games = contests.data.filter(game => game.period.season === snapshot.season && game.period.index === snapshot.week);
  const kickoffByPlayer: Record<string, number> = {};
  const completePlayerIds: string[] = [];
  for (const player of snapshot.players) {
    const team = resolveWeeklyRosterTeam(player.id, player.positions, snapshot.season, snapshot.week, identities.data.entries, weekly.data.entries);
    const matches = team === null ? [] : games.filter(game => game.homeTeam === team || game.awayTeam === team);
    if (matches.length !== 1 || matches[0].startsAt === null) continue;
    const game = matches[0];
    const kickoff = Date.parse(game.startsAt!);
    if (!Number.isFinite(kickoff)) continue;
    kickoffByPlayer[player.id] = kickoff;
    if (parsed.weekClosed && kickoff < options.now && game.result !== null && Number.isFinite(game.result.homeScore) && Number.isFinite(game.result.awayScore) && game.result.homeScore >= 0 && game.result.awayScore >= 0 && Object.prototype.hasOwnProperty.call(parsed.pointsByPlayer, player.id)) completePlayerIds.push(player.id);
  }
  return { leagueId: snapshot.leagueId, ownerId: snapshot.ownerId, season: snapshot.season, week: snapshot.week, scoringId: snapshot.scoringId, fetchedAt: options.now, source: "Sleeper documented matchup endpoint (optional player scores), independently matched nflverse weekly teams and completed schedule; later stat corrections may change observed results", pointsByPlayer: parsed.pointsByPlayer, completePlayerIds, kickoffByPlayer };
}
