import { type RosterSlot, solveLineup } from "./optimizer";
import { type Rng } from "./rng";
import { type PlayerRisk, type UtilityConfig, drawWeek } from "./roster-utility";

/**
 * League simulation, and the objective the draft actually maximises.
 *
 * Expected points is a proxy, and a leaky one. A fantasy season is won by beating a
 * specific opponent each week and then surviving a bracket, and that is not a monotone
 * function of expected points: variance is worth *more* when you project to miss the
 * playoffs and *less* when you are already first, because what you need is to cross a
 * threshold rather than to accumulate. Two rosters with identical expected points can have
 * materially different championship odds.
 *
 * Simulating to the terminal outcome is also what removes the need to weight anything. The
 * previous design had to decide how much a bye collision was worth against a point of
 * projection, or depth against a starter — every one of those a constant someone had to
 * choose. Here nothing is weighted: byes, injuries, weekly variance, schedule, and
 * opponent quality all resolve into one number, the probability of winning the league,
 * because the simulation plays the season out.
 *
 * **Opponents are observed, not assumed.** A draft board records every team's picks, not
 * only yours, so by the middle rounds the league's rosters are largely known. Modelling
 * them as an average is throwing away information that is sitting in front of you.
 */

export interface LeagueTeam {
  id: string;
  name: string;
  roster: readonly PlayerRisk[];
}

export interface LeagueConfig extends UtilityConfig {
  slots: readonly RosterSlot[];
  /** How many teams reach the playoffs. Seeded by record, then points. */
  playoffTeams: number;
  /** Weeks the bracket is played over. One round per week. */
  playoffWeeks: readonly number[];
}

export interface TeamOutcome {
  teamId: string;
  championshipProbability: number;
  playoffProbability: number;
  expectedWins: number;
  expectedPoints: number;
}

/**
 * A round-robin schedule, extended by repeating when the season is longer than one cycle.
 *
 * The circle method: fix one team and rotate the rest. Twelve teams have eleven distinct
 * opponents and a fourteen-week season, so three matchups repeat — which is what real
 * leagues do.
 */
export function roundRobinSchedule(
  teamCount: number,
  weeks: number,
): number[][][] {
  if (teamCount < 2) return Array.from({ length: weeks }, () => []);
  // An odd league gets a bye slot; the team drawn against it simply does not play.
  const size = teamCount % 2 === 0 ? teamCount : teamCount + 1;
  const rotation = Array.from({ length: size - 1 }, (_, i) => i + 1);

  const schedule: number[][][] = [];
  for (let week = 0; week < weeks; week += 1) {
    const round = week % (size - 1);
    const order = [0, ...rotation.slice(round), ...rotation.slice(0, round)];
    const pairs: number[][] = [];
    for (let i = 0; i < size / 2; i += 1) {
      const home = order[i];
      const away = order[size - 1 - i];
      if (home < teamCount && away < teamCount) pairs.push([home, away]);
    }
    schedule.push(pairs);
  }
  return schedule;
}

/**
 * Samples one team's weekly scores across every scenario.
 *
 * Separated from the league simulation because opponents do not change while you are
 * deciding a pick. Sampling them once and reusing the result is what makes evaluating
 * candidate picks against a full league affordable; recomputing eleven other teams for
 * every candidate would be the same arithmetic repeated.
 */
export function sampleTeamWeeklyScores(
  roster: readonly PlayerRisk[],
  config: LeagueConfig,
  rng: Rng,
): number[][] {
  const allWeeks = [...config.weeks, ...config.playoffWeeks];
  const scenarios: number[][] = [];
  for (let s = 0; s < config.scenarios; s += 1) {
    scenarios.push(drawWeek(roster, config.slots, allWeeks, config.meanAbsenceWeeks, rng));
  }
  return scenarios;
}

/**
 * Plays the league out and returns each team's odds.
 *
 * Regular-season weeks decide seeding by wins, then by total points — the near-universal
 * tiebreak. The bracket is single elimination between the top seeds, higher seed on the
 * left, which is what every mainstream platform does.
 */
export function simulateLeague(
  teamScores: ReadonlyArray<ReadonlyArray<readonly number[]>>,
  config: LeagueConfig,
): TeamOutcome[] {
  const teamCount = teamScores.length;
  const regularWeeks = config.weeks.length;
  const schedule = roundRobinSchedule(teamCount, regularWeeks);

  const titles = new Array<number>(teamCount).fill(0);
  const berths = new Array<number>(teamCount).fill(0);
  const winTotals = new Array<number>(teamCount).fill(0);
  const pointTotals = new Array<number>(teamCount).fill(0);

  for (let s = 0; s < config.scenarios; s += 1) {
    const wins = new Array<number>(teamCount).fill(0);
    const points = new Array<number>(teamCount).fill(0);

    for (let w = 0; w < regularWeeks; w += 1) {
      for (let t = 0; t < teamCount; t += 1) points[t] += teamScores[t][s][w];
      for (const [home, away] of schedule[w]) {
        const homeScore = teamScores[home][s][w];
        const awayScore = teamScores[away][s][w];
        // A tie is broken by the coin the league would flip; ties are rare enough that
        // the choice cannot move the result, but leaving it undefined would make the
        // simulation non-deterministic for a fixed seed.
        if (homeScore >= awayScore) wins[home] += 1;
        else wins[away] += 1;
      }
    }

    for (let t = 0; t < teamCount; t += 1) {
      winTotals[t] += wins[t];
      pointTotals[t] += points[t];
    }

    const seeded = Array.from({ length: teamCount }, (_, t) => t).sort(
      (a, b) => wins[b] - wins[a] || points[b] - points[a] || a - b,
    );
    const qualified = seeded.slice(0, Math.min(config.playoffTeams, teamCount));
    for (const t of qualified) berths[t] += 1;

    const champion = playBracket(qualified, teamScores, s, config, regularWeeks);
    if (champion !== null) titles[champion] += 1;
  }

  const n = config.scenarios;
  return teamScores.map((_, t) => ({
    teamId: String(t),
    championshipProbability: titles[t] / n,
    playoffProbability: berths[t] / n,
    expectedWins: winTotals[t] / n,
    expectedPoints: round2(pointTotals[t] / n),
  }));
}

/**
 * Single-elimination bracket over the seeded qualifiers.
 *
 * A field that is not a power of two gives the top seeds a first-round bye, which is how
 * real leagues handle six qualifiers in a three-week bracket.
 */
function playBracket(
  qualified: readonly number[],
  teamScores: ReadonlyArray<ReadonlyArray<readonly number[]>>,
  scenario: number,
  config: LeagueConfig,
  regularWeeks: number,
): number | null {
  if (qualified.length === 0) return null;
  if (qualified.length === 1) return qualified[0];

  let field = [...qualified];
  for (let round = 0; round < config.playoffWeeks.length && field.length > 1; round += 1) {
    const week = regularWeeks + round;
    // Byes go to the top seeds when the field is not a power of two.
    const games = Math.floor(field.length / 2);
    const byes = field.slice(0, field.length - games * 2);
    const playing = field.slice(field.length - games * 2);

    const winners: number[] = [];
    for (let i = 0; i < playing.length / 2; i += 1) {
      const high = playing[i];
      const low = playing[playing.length - 1 - i];
      const highScore = teamScores[high][scenario][week];
      const lowScore = teamScores[low][scenario][week];
      winners.push(highScore >= lowScore ? high : low);
    }
    // Re-seed so the bracket stays ordered by original seeding.
    field = [...byes, ...winners].sort(
      (a, b) => qualified.indexOf(a) - qualified.indexOf(b),
    );
  }
  return field[0];
}

/**
 * Championship odds for one team, with every other team's roster held fixed.
 *
 * The opponents' sampled scores are passed in rather than recomputed, so a caller
 * comparing candidate picks pays for its own team only. Both sides share the scenario
 * index, so the comparison is made under identical conditions.
 */
export function championshipProbability(
  myScores: ReadonlyArray<readonly number[]>,
  opponentScores: ReadonlyArray<ReadonlyArray<readonly number[]>>,
  config: LeagueConfig,
): TeamOutcome {
  return simulateLeague([myScores, ...opponentScores], config)[0];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
