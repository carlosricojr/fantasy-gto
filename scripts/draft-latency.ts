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
import type { LeagueConfig } from "@/lib/core/season-sim";
import { slotsForTemplate } from "@/lib/nfl/roster";

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
 * - **speculative hit** — the position was precomputed while an opponent was on the clock
 *   and the board that arrived matches the prepared one exactly.
 * - **speculative miss** — it was precomputed and the board that arrived does not match, so
 *   the answer is computed live. This is the *cost* of speculating and being wrong, and it
 *   is the number that decides whether speculating is worth it.
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
const SCENARIO_COUNTS = [150, 300, 600, 1000] as const;

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

function measure(label: string, run: (index: number) => void): Sample {
  const timings: number[] = [];
  for (let i = 0; i < SAMPLES; i += 1) {
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
    `  ${sample.label.padEnd(22)} n=${String(sample.timings.length).padStart(3)}  ` +
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
      weeks: Array.from({ length: 14 }, (_, i) => i + 1),
      playoffWeeks: [15, 16, 17],
      playoffTeams: 6,
      scenarios,
      meanAbsenceWeeks: 3,
    };

    // A different position per sample, so nothing is accidentally served warm. Picks 1
    // through 24 is the first two rounds, which is where the pool is largest and the work
    // therefore heaviest.
    const cold = measure("cold", (i) => {
      recommendByChampionship(stateFor(pool, i * 2), config, SEED, CANDIDATES);
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
    // One opponent pick between the current board and ours, sampled a few times from the
    // ADP dispersion the survival model already uses. Four samples rather than forty: this
    // measures the *lookup*, and preparing more futures makes the preparation slower without
    // changing what a hit costs.
    const anticipated = anticipateStates(before, [{ team: 1 }], 4, createRng(SEED));
    const cache = precomputeRecommendations(before, anticipated, config, SEED, {
      candidateLimit: CANDIDATES,
      maxStates: 4,
    });
    const hitState =
      cache.entries.length > 0 ? anticipated[0].state : before;
    const hitResolution = resolveFromCache(cache, hitState);
    const hit = measure("speculative hit", () => {
      recommendWithCache(cache, hitState, config, SEED, {
        candidateLimit: CANDIDATES,
      });
    });
    const missState = stateFor(pool, 13);
    const miss = measure("speculative miss", () => {
      recommendWithCache(cache, missState, config, SEED, {
        candidateLimit: CANDIDATES,
      });
    });

    process.stdout.write(`\n${scenarios} scenarios\n`);
    for (const sample of [cold, warm, hit, miss]) process.stdout.write(`${report(sample)}\n`);
    process.stdout.write(
      `  speculative cache: ${cache.entries.length} entr(ies) prepared, ` +
        `hit path resolved as "${hitResolution.kind}"\n`,
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
