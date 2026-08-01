import type { RosterSlot } from "./optimizer";
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
  seed: number,
): number[][] {
  const allWeeks = [...config.weeks, ...config.playoffWeeks];
  const scenarios: number[][] = [];
  for (let s = 0; s < config.scenarios; s += 1) {
    scenarios.push(
      drawWeek(roster, config.slots, allWeeks, config.meanAbsenceWeeks, seed, s),
    );
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
/**
 * An arbitrary but stable ordering key for breaking ties within a scenario.
 *
 * Deterministic, so a seeded run reproduces, and uncorrelated with team index, so no
 * position in the array is favoured.
 */
function tieBreakKey(scenario: number, team: number): number {
  let hash = Math.imul(scenario + 1, 0x9e3779b1) ^ Math.imul(team + 1, 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 15), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

/** Rounds a single-elimination bracket needs to reduce a field to one. */
export function bracketRoundsRequired(playoffTeams: number): number {
  return playoffTeams <= 1 ? 0 : Math.ceil(Math.log2(playoffTeams));
}

export function simulateLeague(
  teamScores: ReadonlyArray<ReadonlyArray<readonly number[]>>,
  config: LeagueConfig,
): TeamOutcome[] {
  const teamCount = teamScores.length;
  const regularWeeks = config.weeks.length;

  // A bracket that cannot finish does not produce a champion, it produces whoever happened
  // to be left standing — and that is silently the top remaining seed, never having played
  // the deciding game. Six qualifiers over two weeks crowned a different team than the same
  // six over three, with no indication anything was wrong.
  if (!Number.isInteger(config.playoffTeams) || config.playoffTeams < 1) {
    throw new Error(
      `playoffTeams must be a positive integer, got ${config.playoffTeams}. ` +
        `A non-positive field passes the round check and then crowns nobody.`,
    );
  }
  const requiredRounds = bracketRoundsRequired(
    Math.min(config.playoffTeams, teamCount),
  );
  // Every team must carry a score for every week the simulation will read. Indexing past
  // the end yields `undefined`, which compares false against everything and propagates as
  // NaN through the point totals — a silently wrong standings table rather than an error.
  const weeksNeeded = regularWeeks + config.playoffWeeks.length;
  for (const [team, scenarios] of teamScores.entries()) {
    // The week dimension was checked here and the scenario dimension was not, so a team
    // supplying too few scenarios reached the simulation loop and died on
    // `teamScores[t][s]` being undefined — an unreadable TypeError from the middle of a
    // Monte Carlo run, where these guards exist precisely to say what is wrong instead.
    // Reachable in practice: `recommendByChampionship` samples opponents once and reuses
    // them across candidates, so a cached sample and a changed config disagree here.
    if (scenarios.length !== config.scenarios) {
      throw new Error(
        `Team ${team} supplies ${scenarios.length} scenario(s) but the league is ` +
          `simulated over ${config.scenarios}. Sample with the same config the league ` +
          `is simulated with.`,
      );
    }
    for (const weekly of scenarios) {
      if (weekly.length < weeksNeeded) {
        throw new Error(
          `Team ${team} has scores for ${weekly.length} week(s) but the season needs ` +
            `${weeksNeeded}. Sample with the same config the league is simulated with.`,
        );
      }
    }
  }

  if (config.playoffWeeks.length < requiredRounds) {
    throw new Error(
      `A ${config.playoffTeams}-team bracket needs ${requiredRounds} playoff week(s), ` +
        `but ${config.playoffWeeks.length} were configured. It would crown the highest ` +
        `remaining seed without playing the deciding game.`,
    );
  }
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
        // A tie is half a win each, which is what leagues actually do — and, less
        // obviously, the only unbiased option here. Awarding a tie to the "home" side gave
        // one team every tie in the league: the circle method holds team 0 fixed, so it
        // occupied the home position in all fourteen weeks while everyone else got five to
        // eight. With every game tied that produced 14 wins for team 0 and 6 for the rest.
        //
        // Ties are not the rarity they look either. Early in a draft, rosters are nearly
        // empty and two teams can both field nobody in a week, both score zero, and tie.
        if (homeScore > awayScore) wins[home] += 1;
        else if (awayScore > homeScore) wins[away] += 1;
        else {
          wins[home] += 0.5;
          wins[away] += 0.5;
        }
      }
    }

    for (let t = 0; t < teamCount; t += 1) {
      winTotals[t] += wins[t];
      pointTotals[t] += points[t];
    }

    // The final tiebreak must not correlate with array position. `championshipProbability`
    // always passes our team first, so breaking ties by index handed us every one of them:
    // in a fully tied league our title probability came out at exactly 1.0. A
    // scenario-dependent shuffle key is arbitrary in the same way a coin is, without
    // favouring anyone.
    const seeded = Array.from({ length: teamCount }, (_, t) => t).sort(
      (a, b) =>
        wins[b] - wins[a] ||
        points[b] - points[a] ||
        tieBreakKey(s, a) - tieBreakKey(s, b),
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
    // Byes belong in the first round, and only enough games are played to reduce the field
    // to a power of two. Taking `floor(n/2)` games instead gave a six-team field no bye at
    // all — all six played, leaving three, and the bye then landed in round two on
    // whichever seed happened to survive. A bye conditional on another team's result is not
    // a real format, and it made seeds one and two structurally different when they should
    // be identical.
    const nextPowerDown = 2 ** Math.floor(Math.log2(field.length));
    const games =
      field.length === nextPowerDown ? field.length / 2 : field.length - nextPowerDown;
    const byes = field.slice(0, field.length - games * 2);
    const playing = field.slice(field.length - games * 2);

    const winners: number[] = [];
    for (let i = 0; i < playing.length / 2; i += 1) {
      const high = playing[i];
      const low = playing[playing.length - 1 - i];
      const highScore = teamScores[high][scenario][week];
      const lowScore = teamScores[low][scenario][week];
      // The better seed advancing on a tie is the standard rule, and it is fair here only
      // because seeding itself is no longer decided by array position.
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
