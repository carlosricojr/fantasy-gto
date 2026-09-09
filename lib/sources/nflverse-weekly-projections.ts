import { type ProviderResult, failed, ok } from "../core/providers";
import type { Contest, MarketLine } from "../core/domain";
import { buildDefenseFactors, impliedTeamTotal, meanImpliedTotalBefore, projectPlayer } from "../nfl/model/project";
import { DVP_SHRINKAGE } from "../nfl/model/config";
import { weeksBetween } from "../nfl/season";
import { DEFAULT_SCORING } from "../nfl/scoring/presets";
import { sleeperScoringFromId, type SleeperScoringProfile } from "../nfl/scoring/sleeper";
import type { ScoringRules } from "../nfl/scoring/types";
import type { PlayerWeek } from "../nfl/stats/parse";
import type { WeeklyRosterEntry } from "../nfl/weekly-roster";
import { indexInjuries, injuryKey, type InjuryReport } from "../nfl/injuries";
import { NflverseProvider, type DraftRosterEntry, type RosterEntry } from "./nflverse";
import { injuryCoverageWarning, summarizeNflverseInjuryCoverage, type NflverseInjuryCoverage } from "./nflverse-injury-coverage";

export interface NflverseWeeklyRequest {
  season: number;
  week: number;
  profile: SleeperScoringProfile;
  /** Exact Sleeper IDs for the personal roster; no name-based guessing. */
  playerIds: readonly string[];
  now: number;
  /** Explicit opt-in only; never changes ordinary points or availability clearance. */
  includeConditionalEstimates?: boolean;
}
export interface NflverseWeeklyEstimate {
  playerId: string;
  gsisId: string | null;
  points: number | null;
  reason: string | null;
  /** Omitted when this source has no current availability evidence for the identity. */
  availability?: "active" | "questionable" | "doubtful" | "out" | "inactive" | "unknown";
  /** Report coverage is distinct from a player's observed roster/injury designation. */
  injuryCoverage?: "available" | "unavailable";
  conditionalEstimate?: {
    points: number;
    condition: "active-at-kickoff";
    missingEvidence: "team-injury-report";
  };
  /** Absent without current roster evidence; null kickoff means no unique usable game. */
  team?: string | null;
  gameId?: string | null;
  kickoffAt?: number | null;
}
export interface NflverseWeeklyEstimates {
  source: "FantasyGTO model using nflverse";
  sourceUrl: "https://github.com/nflverse/nflverse-data";
  season: number;
  week: number;
  scoringId: string;
  computedAt: number;
  /** Existing provider does not expose release revision headers. Do not invent them. */
  providerUpdatedAt: null;
  excludedRules: string[];
  warnings: string[];
  players: NflverseWeeklyEstimate[];
  coverage: { requested: number; projected: number };
  /** Optional for old consumers; current producer always reports this evidence summary. */
  injurySource?: NflverseInjuryCoverage;
}

const EXTRA_OFFENSE = ["st_ff", "st_fum_rec", "fum_rec_td"];

/** Identity must include inactive entries; eligibility belongs to the current weekly row. */
export function nflverseWeeklyIdentities(entries: readonly DraftRosterEntry[]): RosterEntry[] {
  return entries.flatMap(entry => entry.gsisId === null ? [] : [{
    playerId: entry.gsisId, sleeperId: entry.sleeperId, name: entry.name, position: entry.position,
    team: entry.team, rookieYear: entry.rookieYear,
  }]);
}

/** Existing weekly model's supported offensive subset; omissions are returned, never hidden. */
export function nflverseWeeklyScoring(profile: SleeperScoringProfile): { scoring: ScoringRules; excludedRules: string[] } {
  if (sleeperScoringFromId(profile.id) === null ||
    JSON.stringify(sleeperScoringFromId(profile.id)!.coefficients) !== JSON.stringify(profile.coefficients)) {
    throw new Error("Weekly scoring profile is not canonical.");
  }
  const c = (key: string) => profile.coefficients[key] ?? 0;
  const excludedRules = EXTRA_OFFENSE.filter(key => c(key) !== 0);
  const twos = [c("pass_2pt"), c("rush_2pt"), c("rec_2pt")];
  const sameTwoPointRule = twos.every(value => value === twos[0]);
  if (!sameTwoPointRule) excludedRules.push(...["pass_2pt", "rush_2pt", "rec_2pt"].filter(key => c(key) !== 0));
  return {
    excludedRules,
    scoring: { ...DEFAULT_SCORING, id: `weekly-subset:${profile.id}`, label: "Imported offensive scoring subset",
      offense: { passingYardsPerPoint: c("pass_yd"), passingTd: c("pass_td"), passingInterception: c("pass_int"),
        rushingYardsPerPoint: c("rush_yd"), rushingTd: c("rush_td"), receptionPoints: c("rec"),
        receivingYardsPerPoint: c("rec_yd"), receivingTd: c("rec_td"), fumbleLost: c("fum_lost"),
        specialTeamsTd: c("st_td"), twoPointConversion: sameTwoPointRule ? twos[0] : 0 } },
  };
}

export interface NflverseWeeklyInputs {
  history: readonly PlayerWeek[];
  roster: readonly RosterEntry[];
  weeklyRoster: readonly WeeklyRosterEntry[];
  injuries: readonly InjuryReport[];
  contests: readonly Contest[];
  lines: readonly MarketLine[];
}

/** Pure calculation exported for tests; source I/O is below. No lineup is submitted. */
export function buildNflverseWeeklyEstimates(request: NflverseWeeklyRequest, data: NflverseWeeklyInputs): NflverseWeeklyEstimates {
  const { season, week, profile, now } = request;
  if (!Number.isInteger(season) || season < 2013 || season > 2100 || !Number.isInteger(week) || week < 1 || week > 18 || !Number.isFinite(now) ||
    request.includeConditionalEstimates !== undefined && typeof request.includeConditionalEstimates !== "boolean") {
    throw new Error("Invalid weekly projection request.");
  }
  const { scoring, excludedRules } = nflverseWeeklyScoring(profile);
  const history = data.history.filter(row => row.period.season >= season - 2 &&
    (row.period.season < season || row.period.season === season && row.period.index < week));
  const factors = buildDefenseFactors(history.filter(row => row.period.season === season - 1), scoring, DVP_SHRINKAGE);
  const lines = new Map(data.lines.map(line => [line.contestId, line]));
  const injuries = indexInjuries(data.injuries);
  const injurySource = summarizeNflverseInjuryCoverage(data.injuries, season, week);
  const injuryCoverageTeams = new Set(data.injuries.filter(row => row.season === season && row.week === week)
    .map(row => row.team).filter(team => team !== null));
  const missingMarketPlayerIds: string[] = [];
  const players = [...new Set(request.playerIds)].map((playerId): NflverseWeeklyEstimate => {
    const identities = data.roster.filter(row => row.sleeperId === playerId);
    const ids = new Set(identities.map(row => row.playerId));
    const gsisId = ids.size === 1 ? [...ids][0] : null;
    let availability: NflverseWeeklyEstimate["availability"];
    let injuryCoverage: NflverseWeeklyEstimate["injuryCoverage"] = undefined;
    let gameContext: Pick<NflverseWeeklyEstimate, "team" | "gameId" | "kickoffAt"> = {};
    const unavailable = (reason: string): NflverseWeeklyEstimate => ({ playerId, gsisId, points: null, reason,
      ...gameContext, ...(availability === undefined ? {} : { availability }),
      ...(injuryCoverage === undefined ? {} : { injuryCoverage }) });
    if (gsisId === null) return unavailable(ids.size > 1 ? "Ambiguous player identity" : "No verified nflverse player identity");
    const weekly = data.weeklyRoster.filter(row => row.playerId === gsisId && row.season === season && row.week === week);
    if (weekly.length === 0) return unavailable("Current weekly roster is missing or ambiguous");
    const active = weekly.filter(row => row.status === "active");
    const candidates = active.length > 0 ? active : weekly;
    if (new Set(candidates.map(row => JSON.stringify([row.team, row.position, row.status]))).size !== 1) {
      availability = "unknown";
      return unavailable("Current weekly roster is missing or ambiguous");
    }
    const current = candidates[0];
    const contests = data.contests.filter(contest => contest.period.season === season && contest.period.index === week &&
      (contest.homeTeam === current.team || contest.awayTeam === current.team));
    const contest = contests.length === 1 ? contests[0] : null;
    const kickoff = contest?.startsAt == null ? NaN : Date.parse(contest.startsAt);
    gameContext = { team: current.team, gameId: contest?.id ?? null, kickoffAt: Number.isFinite(kickoff) ? kickoff : null };
    injuryCoverage = current.team !== null && injuryCoverageTeams.has(current.team) ? "available" : "unavailable";
    availability = current.status === "active" ? "active" : current.status === "unknown" ? "unknown" : "inactive";
    if (current.status !== "active") return unavailable(`Current roster status: ${current.status}`);
    const injury = injuries.get(injuryKey(gsisId, season, week));
    if (injury?.gameStatus === "out") { availability = "out"; return unavailable("Out injury designation"); }
    if (injury?.gameStatus === "unknown") { availability = "unknown"; return unavailable("Unknown injury designation"); }
    if (injury?.gameStatus === "doubtful") availability = "doubtful";
    else if (injury?.gameStatus === "questionable") availability = "questionable";
    if (injuryCoverage === "unavailable" && request.includeConditionalEstimates !== true) {
      return unavailable("Injury reports for this team and requested week are unavailable; roster status is not injury clearance");
    }
    if (Object.values(scoring.offense).every(value => value === 0)) return unavailable("No supported offensive scoring rules");
    const position = current.position === "FB" ? "RB" : current.position;
    if (position !== "QB" && position !== "RB" && position !== "WR" && position !== "TE") return unavailable("The model does not project this position");
    const offense = scoring.offense;
    const productiveRules = position === "QB"
      ? [offense.passingYardsPerPoint, offense.passingTd, offense.rushingYardsPerPoint, offense.rushingTd]
      : [offense.rushingYardsPerPoint, offense.rushingTd, offense.receptionPoints, offense.receivingYardsPerPoint, offense.receivingTd];
    if (!productiveRules.some(value => value > 0)) {
      return unavailable("The model's positive usage prior requires positive production scoring for this position; enter a manual estimate");
    }
    if (contest === null) return unavailable("No unique scheduled game this week");
    if (!Number.isFinite(kickoff) || kickoff <= now || contest.result !== null) return unavailable("Game has started or kickoff is unknown");
    const bucket = history.filter(row => row.competitor.id === gsisId).sort((a, b) => a.period.season - b.period.season || a.period.index - b.period.index);
    if (bucket.length < 4) return unavailable("Fewer than four prior games; no supported model estimate");
    const latest = bucket[bucket.length - 1];
    if (weeksBetween(latest.period, { season, index: week }) > 4 || week > 1 && latest.period.season !== season) return unavailable("Playing history is too old for this week's model");
    const line = lines.get(contest.id);
    const priorTotals = data.contests.filter(game => game.period.season === season && game.period.index < week &&
      (game.homeTeam === current.team || game.awayTeam === current.team)).flatMap(game => {
      const market = lines.get(game.id);
      const implied = market ? impliedTeamTotal(market.total, market.spread, current.team!, game.homeTeam, game.awayTeam) : null;
      return implied === null ? [] : [{ week: game.period.index, impliedTotal: implied }];
    });
    const implied = line ? impliedTeamTotal(line.total, line.spread, current.team!, contest.homeTeam, contest.awayTeam) : null;
    const projection = projectPlayer({ competitorId: gsisId, position, period: { season, index: week }, history: bucket, scoring,
      defenseFactors: factors, game: { opponent: contest.homeTeam === current.team ? contest.awayTeam : contest.homeTeam,
        impliedTeamTotal: implied,
        teamMeanImpliedTotal: meanImpliedTotalBefore(priorTotals, week) } });
    if (Number.isFinite(projection.mean) && implied === null) missingMarketPlayerIds.push(playerId);
    if (Number.isFinite(projection.mean) && injuryCoverage === "unavailable") {
      return { ...unavailable("Injury reports for this team and requested week are unavailable; roster status is not injury clearance"),
        conditionalEstimate: { points: projection.mean, condition: "active-at-kickoff", missingEvidence: "team-injury-report" } };
    }
    return Number.isFinite(projection.mean)
      ? { playerId, gsisId, points: projection.mean, reason: null, availability, injuryCoverage, ...gameContext }
      : unavailable("The model did not produce a finite estimate under these rules");
  });
  return { source: "FantasyGTO model using nflverse", sourceUrl: "https://github.com/nflverse/nflverse-data", season, week,
    scoringId: profile.id, computedAt: now, providerUpdatedAt: null, excludedRules, injurySource,
    warnings: ["Skill-position model estimates; rookies without history, kickers and defenses remain unpriced.",
      injuryCoverageWarning(injurySource),
      "Model calibration was fitted on PPR; custom-scoring accuracy has not been validated.",
      "Source revision timestamps are unavailable; computed time is not source freshness.",
      ...(players.some(player => player.conditionalEstimate !== undefined)
        ? ["Conditional forecasts assume the player is active at kickoff; they are not availability-adjusted expected points or injury clearance."] : []),
      ...players.filter(player => player.injuryCoverage === "unavailable")
        .map(player => `Player ${player.playerId} has no current team injury-report coverage; roster status is not injury clearance, including when a manual estimate is supplied.`),
      ...(missingMarketPlayerIds.length ? [`Betting lines are missing for ${missingMarketPlayerIds.length} projected player games; those estimates omit the betting-market adjustment.`] : []),
      ...players.filter(player => player.availability === "questionable" || player.availability === "doubtful")
        .map(player => `Player ${player.playerId} is ${player.availability}; recheck availability before kickoff.`),
      ...excludedRules.map(key => `Estimate excludes scoring rule ${key}; this is not a full custom-scoring projection.`)],
    players, coverage: { requested: players.length, projected: players.filter(player => player.points !== null).length } };
}

/** User-triggered reads of existing free nflverse sources, scoped to a supplied roster. */
export async function generateNflverseWeeklyProjections(request: NflverseWeeklyRequest, provider = new NflverseProvider()): Promise<ProviderResult<NflverseWeeklyEstimates>> {
  // Validate before any network request, including a bounded roster to cap per-user work.
  if (!Number.isInteger(request.season) || request.season < 2013 || request.season > 2100 ||
    !Number.isInteger(request.week) || request.week < 1 || request.week > 18 ||
    request.playerIds.length === 0 || request.playerIds.length > 100 || !Number.isFinite(request.now) ||
    request.includeConditionalEstimates !== undefined && typeof request.includeConditionalEstimates !== "boolean") return failed("Invalid or oversized weekly projection request.");
  try {
    nflverseWeeklyScoring(request.profile);
    const [old, prior, current, roster, weekly, injuries, contests, lines] = await Promise.all([
      provider.playerWeeks(request.season - 2), provider.playerWeeks(request.season - 1),
      request.week === 1 ? Promise.resolve(ok<PlayerWeek[]>([])) : provider.playerWeeks(request.season),
      provider.draftRoster(request.season), provider.weeklyRoster(request.season), provider.injuries(request.season),
      provider.allContests(), provider.allMarketLines(),
    ]);
    // Fail closed on required data; a missing current stats release is only expected in week 1.
    if (!old.ok) return failed(old.reason);
    if (!prior.ok) return failed(prior.reason);
    if (!current.ok) return failed(current.reason);
    if (!roster.ok) return failed(roster.reason);
    if (!weekly.ok) return failed(weekly.reason);
    if (!injuries.ok) return failed(injuries.reason);
    if (!contests.ok) return failed(contests.reason);
    const result = buildNflverseWeeklyEstimates(request, { history: [...old.data, ...prior.data, ...current.data],
      roster: nflverseWeeklyIdentities(roster.data.entries), weeklyRoster: weekly.data.entries, injuries: injuries.data.reports, contests: contests.data, lines: lines.ok ? lines.data : [] });
    if (!lines.ok) result.warnings.push("Betting lines were unavailable; estimates omit the betting-market adjustment.");
    return ok(result);
  } catch (cause) { return failed("Could not generate nflverse weekly estimates.", cause); }
}
