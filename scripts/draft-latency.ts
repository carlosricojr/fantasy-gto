import { cpus, arch, platform, totalmem } from "node:os";

import { pickOwnership } from "@/lib/core/draft";
import { LruMemoStore, recommendMemoized } from "@/lib/core/draft-memo";
import {
  type DraftPolicyState,
  type DraftTeam,
  recommendByChampionship,
} from "@/lib/core/draft-policy";
import {
  anticipateStates,
  precomputeRecommendations,
  recommendWithCache,
  resolveFromCache,
} from "@/lib/core/draft-speculation";
import { createRng } from "@/lib/core/rng";
import type { PlayerRisk } from "@/lib/core/roster-utility";
import { type LeagueConfig, fantasySeasonWeeks } from "@/lib/core/season-sim";
import { WAIVER_WIRE_COVER, slotsForTemplate } from "@/lib/nfl/roster";

/**
 * How long a recommendation takes, and therefore what a pick clock can afford.
 *
 * `pnpm draft-latency`
 *
 * A displayed elapsed time is not a latency budget. It says how long *that* call took on
 * *that* machine, tells nobody what the tail looks like, and cannot fail. This prints a
 * distribution with the environment it was measured in, so a number quoted from it can be
 * checked — and so that quoting one without the environment is visibly wrong.
 *
 * ## What is measured, and what each path means
 *
 * - **cold** — nothing cached. Every pick in a real draft is a new position, so this is the
 *   path a user actually waits on and the one the budget has to be built from.
 * - **warm** — the same position again, served by the LRU memo the worker already keeps.
 *   Real because picks are corrected constantly: a board changes and changes back.
 * - **speculative prepare** — solving the futures a board might reach while an opponent is on
 *   the clock. Paid whether or not the guess turns out right, which is why it is its own row
 *   rather than folded into either outcome.
 * - **speculative hit** — the board that arrived matches a prepared one exactly, so the
 *   answer is a lookup. This row is the lookup alone; the preparation is above it.
 * - **speculative miss (fallback only)** — the board does not match, so the answer is
 *   computed live. This row is the fallback alone.
 *
 * The **cost of speculating and being wrong** is prepare + miss, and it is printed as its own
 * line rather than left to a reader to add up — because the row labelled "miss" measuring
 * only the fallback is exactly the sort of thing that gets quoted as the whole cost.
 *
 * **The speculative paths are prototype measurements.** `recommendWithCache` and
 * `precomputeRecommendations` have no production caller — the worker uses the memo and not
 * the speculative cache — so these two rows say what the primitives cost, not what the
 * product does. #58 is where that gets wired; `docs/draft-validation.md` says the same.
 *
 * ## The board
 *
 * Synthetic and deterministic, sized and shaped like the real published one (614 rows, the
 * same position mix, curves that fall away at the rates real ones do). A benchmark that
 * depended on a live provider would measure the provider, and one that depended on a cached
 * download would not run at all on a machine that has never fetched it.
 */

const SEED = 20260101;
const SAMPLES = 12;
const TEAMS = 12;
const ROUNDS = 15;
const SLOT = 9;
const CANDIDATES = 10;
/**
 * The league shape the timings are measured for: the default a draft opens with.
 *
 * A six-team bracket ending in week 17 is fourteen regular weeks plus three playoff ones,
 * which is what the season simulation actually iterates and therefore what these numbers
 * describe. Derived rather than written out, so a change to how a season is laid out moves
 * the benchmark with it instead of leaving it measuring a season nothing runs.
 */
const PLAYOFF_TEAMS = 6;
const CHAMPIONSHIP_WEEK = 17;
const SCENARIO_COUNTS = [150, 300, 600, 1000] as const;

/**
 * How many futures the speculative rows prepare.
 *
 * The preparation cost scales with this and the hit cost does not, so the two are reported
 * separately and this number is printed beside them. Four is small enough to be honest about:
 * a real speculative path would want more, and would pay proportionally more to be wrong.
 */
const PREPARED_FUTURES = 4;

/**
 * Samples for the preparation row.
 *
 * Fewer than the rest: each one solves `PREPARED_FUTURES` positions from scratch, so a dozen
 * at a thousand scenarios is three minutes for one row. Every row prints its own `n`, which
 * is the point — a thin row that says so is honest, and one that hides it is not.
 */
const PREPARE_SAMPLES = 3;

/** The two-minute pick clock this has to fit inside, in milliseconds. */
const PICK_CLOCK_MS = 120_000;

/**
 * A board shaped like the real one.
 *
 * Row counts are the published 2026 standard ten-team board's, measured: WR 232, RB 147,
 * TE 124, QB 81, DST 15, K 15. The curves are chosen so the top of each position lands near
 * the real board's per-game values; what the benchmark needs is the *size and shape* of the
 * work, which is set by how many players there are and how many positions the optimizer has
 * to consider, not by any particular player being worth any particular number.
 */
function board(): PlayerRisk[] {
  const spec = [
    ["WR", 232, 13.2, 0.05, 11, 1.808, 0.186],
    ["RB", 147, 18.3, 0.09, 6, 1.901, 0.269],
    ["TE", 124, 9.3, 0.05, 13, 1.953, 0.217],
    ["QB", 81, 17.1, 0.12, 7, 1.772, 0.171],
    ["DST", 15, 7.3, 0.06, 9, 2.0, 0.2],
    ["K", 15, 7.0, 0.03, 14, 1.85, 0.25],
  ] as const;
  const players: PlayerRisk[] = [];
  for (const [position, count, top, step, bye, p90, p10] of spec) {
    for (let i = 0; i < count; i += 1) {
      players.push({
        id: `${position}${i}`,
        name: `${position} ${i}`,
        position,
        weeklyMean: Math.max(top - i * step, 0.5),
        p10,
        p90,
        byeWeek: ((bye + i) % 9) + 5,
        availability: Math.max(0.97 - (i % 40) * 0.008, 0.55),
        adp: 1 + i * (TEAMS * ROUNDS) / count,
        adpStdev: 4 + (i % 17),
      });
    }
  }
  return players;
}

function stateFor(pool: readonly PlayerRisk[], picksMade: number): DraftPolicyState {
  const owners = pickOwnership(TEAMS, SLOT, ROUNDS);
  const rosters: PlayerRisk[][] = Array.from({ length: TEAMS }, () => []);
  const taken = new Set<string>();
  // Deal the top of the board out in pick order, which is roughly how a real early draft
  // looks and — more importantly — is deterministic.
  const byValue = [...pool].sort(
    (a, b) => b.weeklyMean * b.availability - a.weeklyMean * a.availability,
  );
  for (let pick = 1; pick <= picksMade; pick += 1) {
    const team = owners.get(pick);
    const player = byValue[pick - 1];
    if (team === undefined || player === undefined) continue;
    rosters[team].push(player);
    taken.add(player.id);
  }
  const teams: DraftTeam[] = rosters.map((roster, index) => ({
    id: `t${index}`,
    name: `t${index}`,
    roster,
    remainingPicks: [...owners.entries()]
      .filter(([pick, team]) => team === index && pick > picksMade)
      .map(([pick]) => pick)
      .sort((a, b) => a - b),
  }));
  return {
    teams,
    myTeamIndex: 0,
    available: pool.filter((p) => !taken.has(p.id)),
    rosterSize: ROUNDS,
  };
}

interface Sample {
  label: string;
  timings: number[];
}

function measure(
  label: string,
  run: (index: number) => void,
  samples: number = SAMPLES,
): Sample {
  const timings: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    const started = process.hrtime.bigint();
    run(i);
    timings.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  return { label, timings };
}

/**
 * The `q`-th percentile by nearest rank.
 *
 * Nearest rank rather than interpolation, because every value here is an observation and an
 * interpolated p95 is a number no run produced. At twelve samples the difference is large
 * and the honest one is the one that happened.
 */
function percentile(timings: readonly number[], q: number): number {
  const sorted = [...timings].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((q / 100) * sorted.length));
  return sorted[rank - 1];
}

function report(sample: Sample): string {
  const p50 = percentile(sample.timings, 50);
  const p95 = percentile(sample.timings, 95);
  const worst = Math.max(...sample.timings);
  return (
    `  ${sample.label.padEnd(28)} n=${String(sample.timings.length).padStart(3)}  ` +
    `p50 ${p50.toFixed(0).padStart(6)}ms  p95 ${p95.toFixed(0).padStart(6)}ms  ` +
    `worst ${worst.toFixed(0).padStart(6)}ms`
  );
}

function main(): void {
  const pool = board();
  const slots = slotsForTemplate("standard");
  const counts = new Map<string, number>();
  for (const player of pool) {
    counts.set(player.position, (counts.get(player.position) ?? 0) + 1);
  }

  process.stdout.write(
    `draft recommendation latency\n\n` +
      `environment\n` +
      `  node ${process.version}, ${platform()} ${arch()}\n` +
      `  ${cpus()[0]?.model ?? "unknown cpu"} x${cpus().length}\n` +
      `  ${(totalmem() / 1024 ** 3).toFixed(1)} GiB total memory\n\n` +
      `inputs\n` +
      `  board ${pool.length} players (` +
      `${[...counts.entries()].sort().map(([k, v]) => `${k} ${v}`).join(", ")})\n` +
      `  ${TEAMS} teams, ${ROUNDS} rounds, seat ${SLOT}, template standard ` +
      `(${slots.length} starters)\n` +
      `  ${CANDIDATES} candidates, seed ${SEED}, ${SAMPLES} samples per row\n` +
      `  board is synthetic and deterministic — see the module docstring for why\n`,
  );

  let worstColdP95 = 0;
  for (const scenarios of SCENARIO_COUNTS) {
    const config: LeagueConfig = {
      slots,
      ...fantasySeasonWeeks(CHAMPIONSHIP_WEEK, PLAYOFF_TEAMS),
      playoffTeams: PLAYOFF_TEAMS,
      scenarios,
      meanAbsenceWeeks: 3,
      wireCover: WAIVER_WIRE_COVER,
    };

    // A different position per sample, so nothing is accidentally served warm. Picks 1
    // through 24 is the first two rounds, which is where the pool is largest and the work
    // therefore heaviest.
    //
    // Built before the clock starts, like every other row. `stateFor` filters a 614-player
    // board and builds a pick-ownership map; folding that into the cold row and not into the
    // warm one would make the comparison between them a comparison of two different things.
    const coldStates = Array.from({ length: SAMPLES }, (_, i) => stateFor(pool, i * 2));
    const cold = measure("cold", (i) => {
      recommendByChampionship(coldStates[i], config, SEED, CANDIDATES);
    });

    const warmState = stateFor(pool, 11);
    const store = new LruMemoStore(256);
    recommendMemoized(store, warmState, config, SEED, CANDIDATES);
    const warm = measure("warm (memo hit)", () => {
      recommendMemoized(store, warmState, config, SEED, CANDIDATES);
    });

    // Speculation: prepare the futures reachable from the position before ours, then ask
    // for one of them. An exact hit is a lookup; a miss pays the full computation on top of
    // whatever the preparation cost, which is the number that decides whether it is worth
    // doing at all.
    const before = stateFor(pool, 10);
    // One opponent pick between the current board and ours, sampled from the ADP dispersion
    // the survival model already uses. `PREPARED_FUTURES` of them, because the preparation
    // cost scales with that number and the hit cost does not — so the two have to be
    // reported separately or the trade cannot be read.
    const anticipated = anticipateStates(
      before,
      [{ team: 1 }],
      PREPARED_FUTURES,
      createRng(SEED),
    );
    // Timed. This is paid on every opponent pick whether the guess turns out right or not,
    // and leaving it out of the report is how "speculation is nearly free" gets said.
    let cache = precomputeRecommendations(before, anticipated, config, SEED, {
      candidateLimit: CANDIDATES,
      maxStates: PREPARED_FUTURES,
    });
    // Fewer samples, because each one solves `PREPARED_FUTURES` positions from scratch — a
    // dozen of them at a thousand scenarios is three minutes for one row. The count is
    // printed per row, so a reader can see which rows are thin rather than having to trust
    // that they are not.
    const prepare = measure(
      "speculative prepare",
      () => {
        cache = precomputeRecommendations(before, anticipated, config, SEED, {
          candidateLimit: CANDIDATES,
          maxStates: PREPARED_FUTURES,
        });
      },
      PREPARE_SAMPLES,
    );
    const hitState = cache.entries.length > 0 ? anticipated[0].state : before;
    const hitResolution = resolveFromCache(cache, hitState);
    const hit = measure("speculative hit", () => {
      recommendWithCache(cache, hitState, config, SEED, {
        candidateLimit: CANDIDATES,
      });
    });
    const missState = stateFor(pool, 13);
    const miss = measure("speculative miss (fallback)", () => {
      recommendWithCache(cache, missState, config, SEED, {
        candidateLimit: CANDIDATES,
      });
    });

    process.stdout.write(`\n${scenarios} scenarios\n`);
    for (const sample of [cold, warm, prepare, hit, miss]) {
      process.stdout.write(`${report(sample)}\n`);
    }
    // Spelled out rather than left to a reader to add up, because a row labelled "miss" that
    // measures only the fallback is exactly what gets quoted as the whole cost of being
    // wrong — and because the two costs land in different places, which the arithmetic
    // alone does not say.
    const wrongGuess = percentile(prepare.timings, 95) + percentile(miss.timings, 95);
    const coldP95 = percentile(cold.timings, 95);
    process.stdout.write(
      `  work done when the guess is wrong: ${wrongGuess.toFixed(0)}ms ` +
        `(prepare ${percentile(prepare.timings, 95).toFixed(0)} + fallback ` +
        `${percentile(miss.timings, 95).toFixed(0)}), against ${coldP95.toFixed(0)}ms for ` +
        `not speculating — ${(wrongGuess / coldP95).toFixed(1)}x the CPU\n` +
        `  of which the user waits for the fallback alone; the preparation runs while an ` +
        `opponent is on the clock, unless it is still running when the turn arrives\n` +
        `  speculative cache: ${cache.entries.length} entr(ies) prepared from ` +
        `${PREPARED_FUTURES} sampled future(s), hit path resolved as ` +
        `"${hitResolution.kind}"\n`,
    );
    if (hitResolution.kind !== "exact") {
      process.stdout.write(
        `  NOTE: the hit row did not resolve exactly, so it measures the miss path.\n`,
      );
    }
    worstColdP95 = Math.max(worstColdP95, percentile(cold.timings, 95));
  }

  // The budget is read off the measurement rather than chosen before it. Stated as a
  // fraction of the clock, because that is the quantity that matters and it is the one a
  // reader can check against the rows above.
  process.stdout.write(
    `\nbudget\n` +
      `  worst cold p95 across every scenario count: ${worstColdP95.toFixed(0)}ms\n` +
      `  pick clock: ${PICK_CLOCK_MS}ms\n` +
      `  that is ${((worstColdP95 / PICK_CLOCK_MS) * 100).toFixed(2)}% of the clock, ` +
      `a margin of ${(PICK_CLOCK_MS / worstColdP95).toFixed(0)}x\n` +
      `  these numbers describe THIS machine. Quote them with the environment above or ` +
      `not at all.\n`,
  );
}

main();
