/** Rebuilds only the 2024 diagnostic fixture from free sources; never reads 2025. */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseCsv, num, str } from "../lib/nfl/csv";
import { parseAdp, adpUrl } from "../lib/sources/adp";
import { buildMarketIndex } from "../lib/nfl/draft/match";
import { normalizeMarketPosition } from "../lib/nfl/draft/config";
import { toWeeklyRoster } from "../lib/nfl/weekly-roster";
import { teamByeWeeks } from "../lib/nfl/byes";
import { parseContests } from "../lib/sources/nflverse";
import { adpImpliedPoints, blendedSeasonValue, expectedGames, fitAdpCurves, seasonProjection } from "../lib/nfl/draft/value";

const cache = process.argv[2] ?? ".cache/nflverse";
const hashes: Record<string, string> = {};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const load = (year: number) => {
  if (![2022, 2023, 2024].includes(year)) throw new Error("Only declared non-holdout years are allowed.");
  const file = `stats_player_week_${year}.csv`;
  const text = readFileSync(`${cache}/${file}`, "utf8");
  hashes[file] = hash(text);
  const rows = parseCsv(text).filter((row) => str(row, "season_type") === "REG" && ["QB", "RB", "FB", "WR", "TE"].includes(str(row, "position")));
  const players = new Map<string, { id: string; name: string; position: string; points: Record<string, number> }>();
  for (const row of rows) {
    const id = str(row, "player_id");
    const prior = players.get(id) ?? { id, name: str(row, "player_display_name"), position: str(row, "position") === "FB" ? "RB" : str(row, "position"), points: {} };
    prior.points[String(num(row, "week"))] = num(row, "fantasy_points_ppr");
    players.set(id, prior);
  }
  if (rows.length < 4000) throw new Error(`Truncated ${file}.`);
  return players;
};
const adp = async (year: number) => {
  const url = adpUrl("ppr", 12, year);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const text = await response.text();
  hashes[url] = hash(text);
  const raw = JSON.parse(text);
  const entries = parseAdp(raw);
  if (entries === null || entries.length < 150) throw new Error(`Missing ADP ${year}.`);
  return { entries, meta: raw.meta, url };
};
async function main() {
  const prior2 = load(2022), prior = load(2023), actual = load(2024);
  const [training, target] = await Promise.all([adp(2023), adp(2024)]);
  const rosterUrl = "https://github.com/nflverse/nflverse-data/releases/download/weekly_rosters/roster_weekly_2024.csv";
  const rosterResponse = await fetch(rosterUrl);
  if (!rosterResponse.ok) throw new Error(`${rosterUrl}: ${rosterResponse.status}`);
  const rosterText = await rosterResponse.text();
  hashes[rosterUrl] = hash(rosterText);
  const openingTeams = new Map<string, string>();
  for (const row of toWeeklyRoster(parseCsv(rosterText)).entries.filter((entry) => entry.season === 2024 && entry.week === 1)) {
    if (row.team === null) continue;
    if (openingTeams.has(row.playerId) && openingTeams.get(row.playerId) !== row.team) throw new Error(`Ambiguous opening team: ${row.playerId}`);
    openingTeams.set(row.playerId, row.team);
  }
  const gamesText = readFileSync(`${cache}/games.csv`, "utf8");
  hashes["games.csv"] = hash(gamesText);
  const byes = teamByeWeeks(parseContests(parseCsv(gamesText)), 2024);
  if (byes.size !== 32 || openingTeams.size < 1500) throw new Error("Incomplete 2024 opening roster or schedule.");
  const priorIndex = buildMarketIndex([...prior.values()], normalizeMarketPosition);
  const curves = fitAdpCurves(training.entries.flatMap((entry) => {
    const player = priorIndex.find(entry.name, entry.position);
    return player === null ? [] : [{ adp: entry.adp, position: entry.position, actualSeasonPoints: Object.values(player.points).reduce((a, b) => a + b, 0) }];
  }), 2023);
  const distributions: Record<string, number[]> = {};
  for (const position of ["QB", "RB", "WR", "TE"]) {
    const ratios = [...prior.values()].filter((player) => player.position === position).flatMap((player) => {
      const history = Object.values(prior2.get(player.id)?.points ?? {});
      const mean = history.reduce((a, b) => a + b, 0) / history.length;
      return history.length < 8 || mean <= 0 ? [] : Object.values(player.points).map((points) => points / mean);
    }).sort((a, b) => a - b);
    if (ratios.length < 100) throw new Error(`Thin training distribution: ${position}.`);
    const knots = Array.from({ length: 100 }, (_, index) => ratios[Math.floor((index + 0.5) / 100 * ratios.length)]);
    const mean = knots.reduce((a, b) => a + b, 0) / knots.length;
    distributions[position] = knots.map((value) => value / mean);
  }
  // Target statistics are used ONLY to resolve identity and to store external outcomes.
  // Every published target ADP skill row stays on the decision board, including rookies.
  const identityIndex = buildMarketIndex([...new Map([...prior2, ...prior, ...actual]).values()], normalizeMarketPosition);
  // Observed FFC/nflverse spelling differences in this archived board, scoped to WR.
  const identityAliases: Record<string, string> = { "Hollywood Brown": "Marquise Brown", "Joshua Palmer": "Josh Palmer" };
  const unresolved: string[] = [];
  const missingOpeningTeams: string[] = [];
  let replacedAdpByes = 0;
  const rows = target.entries.filter((entry) => ["QB", "RB", "WR", "TE"].includes(entry.position)).map((entry) => {
    const identity = identityIndex.find(entry.position === "WR" ? identityAliases[entry.name] ?? entry.name : entry.name, entry.position);
    if (identity === null) unresolved.push(entry.name);
    const id = identity?.id ?? `ffc:${entry.position}:${entry.name}`;
    const openingTeam = openingTeams.get(id);
    const byeWeek = openingTeam === undefined ? null : byes.get(openingTeam) ?? null;
    if (byeWeek === null) missingOpeningTeams.push(entry.name);
    if (byeWeek !== entry.bye) replacedAdpByes += 1;
    const history = [...Object.values(prior2.get(id)?.points ?? {}), ...Object.values(prior.get(id)?.points ?? {})];
    const games = Object.keys(prior.get(id)?.points ?? {}).length;
    const market = adpImpliedPoints(entry.adp, entry.position, curves);
    if (market === null) throw new Error(`No prior-year curve for ${entry.position}.`);
    const model = history.length === 0 ? null : seasonProjection({ perGamePoints: history, priorSeasonGames: games });
    const points = model === null ? market : blendedSeasonValue(model, market);
    const availability = expectedGames(games) / 17;
    return { player: { id, name: entry.name, position: entry.position, weeklyMean: points / 17 / availability,
      availability, adp: entry.adp, adpStdev: entry.stdev, byeWeek, p10: 0.25, p90: 1.75 },
    openingTeam, actual: identity === null ? null : actual.get(id)?.points ?? {}, modelPoints: model, marketPoints: market };
  });
  if (new Set(rows.map((row) => row.player.id)).size !== rows.length) throw new Error("Duplicate target identities.");
  if (unresolved.length > 0 || missingOpeningTeams.length > 0) throw new Error(`Incomplete historical identities or opening schedule: ${JSON.stringify({ unresolved, missingOpeningTeams })}`);
  const fixture = { provenance: { diagnosticOnly: true, season: 2024, trainingSeasons: [2022, 2023],
    targetAdp: target.meta, trainingAdp: training.meta, sources: hashes, unresolved, identityAliases, missingOpeningTeams, replacedAdpByes,
    note: "Retrospective source downloads; ADP metadata predates kickoff. Target actuals resolve identities and score only, never price players. No 2025 player outcomes are read. Skill-only PPR diagnostic, not a reconstruction of the full production board." }, distributions, rows };
  writeFileSync("tests/fixtures/draft-evaluation-2024.json", `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(JSON.stringify({ rows: rows.length, unresolved, missingOpeningTeams, replacedAdpByes, sourceHashes: hashes }));
}
void main();
