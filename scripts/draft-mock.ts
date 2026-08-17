import { readFileSync } from "node:fs";
import { join } from "node:path";

import { UNRANKED_ADP_PADDING } from "@/lib/core/draft";
import { type LeagueConfig, fantasySeasonWeeks } from "@/lib/core/season-sim";
import {
  type CheckOutcome,
  type MockBoardRow,
  type MockDraftReplay,
  evaluateChecks,
  parseBoardFixture,
  replayAdpMockDraft,
} from "@/lib/nfl/draft/mock";
import { slotsForTemplate } from "@/lib/nfl/roster";

/**
 * The mock-draft harness: the #88/#89 audit as a command.
 *
 * `pnpm draft-mock`            replay the audit draft on the frozen board and score it
 * `pnpm draft-mock -- --log`   also print all 160 picks, not only ours
 *
 * Nine opponents draft strictly by ADP; seat 5 takes the recommendation panel's #1 every
 * turn, exactly as the audit's browser automation did on the production board built
 * 2026-08-17 07:00 UTC — the board frozen under `tests/fixtures/`. The replay is
 * deterministic, so the scoreboard is a property of the code, not of a run.
 *
 * Five of the six checks are currently **documented expected failures**: `expected:
 * "fail"` in `lib/nfl/draft/mock.ts`, carrying the audit's observed numbers. Check (c)
 * is expected to pass — the audit's browser run observed it failing, the deterministic
 * replay measures it passing, and its definition records why the two disagree. The PR
 * that fixes a finding flips its expectation in the same commit (#91's table says which
 * PR owns which check). The exit code enforces the contract in both directions:
 *
 *  - a check failing as expected is the documented state — exit 0;
 *  - a check *passing* while expected to fail means a fix landed without flipping its
 *    expectation — exit 1, flip it;
 *  - a check failing while expected to pass is a regression — exit 1, that is the alarm
 *    this harness exists to sound.
 *
 * The weekly model is untouched by any of this: the harness reads the frozen 2026 draft
 * board, simulates with the page's own seed, and never scores a season — no backtest
 * obligations, no holdout contact (#64 scope).
 */

const FIXTURE_PATH = join(
  process.cwd(),
  "tests/fixtures/draft_board_2026_half_ppr_10team.json",
);

/** The audit league, exactly: 10 teams, seat 5, 16 rounds, half PPR, 2 FLEX, top 6, week 17. */
const TEAMS = 10;
const SLOT = 5;
const ROUNDS = 16;
const TEMPLATE_ID = "two_flex";
const SCORING_ID = "half_ppr";
const SEASON = 2026;
const PLAYOFF_TEAMS = 6;
const CHAMPIONSHIP_WEEK = 17;

/** The page's own constants — see `app/(app)/draft/page.tsx`. */
const SEED = 20260731;
const SCENARIOS = 600;
const CANDIDATES = 10;

function positionSummary(rows: readonly MockBoardRow[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.position, (counts.get(row.position) ?? 0) + 1);
  return [...counts.entries()]
    .sort()
    .map(([position, count]) => `${position} ${count}`)
    .join(", ");
}

function ourPickLines(replay: MockDraftReplay, rowById: Map<string, MockBoardRow>): string {
  const lines: string[] = [];
  for (const pick of replay.picks) {
    if (!pick.mine) continue;
    const row = rowById.get(pick.playerId);
    if (row === undefined) continue;
    const leader = pick.recommendations?.[0];
    const odds =
      leader === undefined
        ? ""
        : `title ${(leader.championshipProbability * 100).toFixed(1)}%` +
          `±${(leader.standardError * 100).toFixed(1)}`;
    const market =
      row.adp === null ? "no market rank" : `adp ${row.adp.toFixed(1).padStart(5)}`;
    lines.push(
      `  ${pick.label.padEnd(6)}${row.position.padEnd(4)}` +
        `${row.name.padEnd(24)}${odds.padEnd(18)}${market}`,
    );
  }
  return lines.join("\n");
}

function fullLogLines(replay: MockDraftReplay, rowById: Map<string, MockBoardRow>): string {
  const lines: string[] = [];
  for (const pick of replay.picks) {
    const row = rowById.get(pick.playerId);
    if (row === undefined) continue;
    const who = pick.mine ? "You    " : `Seat ${String(pick.seat).padEnd(2)}`;
    lines.push(
      `  ${pick.label.padEnd(6)}${who} ${row.position.padEnd(4)}${row.name.padEnd(24)}` +
        (row.adp === null ? "no market rank" : `adp ${row.adp.toFixed(1)}`),
    );
  }
  return lines.join("\n");
}

function scoreboardLines(outcomes: readonly CheckOutcome[]): string {
  const lines: string[] = [];
  for (const outcome of outcomes) {
    const agreed = outcome.status === outcome.expected;
    const verdict = agreed
      ? outcome.status === "fail"
        ? "FAIL  known-fail"
        : "PASS"
      : outcome.status === "pass"
        ? "PASS  UNEXPECTED — fix landed; flip this check's expectation in mock.ts"
        : "FAIL  UNEXPECTED — REGRESSION";
    lines.push(`  (${outcome.id}) ${verdict}`);
    lines.push(`      ${outcome.title}`);
    for (const violation of outcome.violations) {
      lines.push(`        - ${violation}`);
    }
    lines.push(`      audit: ${outcome.audit}`);
  }
  return lines.join("\n");
}

function main(): void {
  const showFullLog = process.argv.includes("--log");

  const fixture = parseBoardFixture(JSON.parse(readFileSync(FIXTURE_PATH, "utf8")));
  if (
    fixture.season !== SEASON ||
    fixture.scoringId !== SCORING_ID ||
    fixture.teams !== TEAMS
  ) {
    throw new Error(
      `fixture is for season ${fixture.season}, ${fixture.scoringId}, ` +
        `${fixture.teams} teams; this harness replays the ${SEASON} ${SCORING_ID} ` +
        `${TEAMS}-team audit and refuses to mislabel another board's results`,
    );
  }

  const slots = slotsForTemplate(TEMPLATE_ID);
  const config: LeagueConfig = {
    slots,
    ...fantasySeasonWeeks(CHAMPIONSHIP_WEEK, PLAYOFF_TEAMS),
    playoffTeams: PLAYOFF_TEAMS,
    scenarios: SCENARIOS,
    meanAbsenceWeeks: 3,
  };

  process.stdout.write(
    `mock draft replay — strict-ADP opponents vs the recommendation panel\n\n` +
      `inputs\n` +
      `  board  ${fixture.rows.length} players (${positionSummary(fixture.rows)})\n` +
      `         frozen from ${fixture.source}\n` +
      `         computedAt ${new Date(fixture.computedAt).toISOString()}\n` +
      `  league ${TEAMS} teams, seat ${SLOT}, ${ROUNDS} rounds, ${SCORING_ID}, ` +
      `${TEMPLATE_ID} (${slots.length} starters), top ${PLAYOFF_TEAMS}, ` +
      `final week ${CHAMPIONSHIP_WEEK}\n` +
      `  engine seed ${SEED}, ${SCENARIOS} scenarios, ${CANDIDATES} candidates — ` +
      `the /draft page's own constants\n` +
      `  policy opponents take the lowest ADP (unranked players last, ` +
      `priced at +${UNRANKED_ADP_PADDING} picks); we take the panel's #1\n\n`,
  );

  const started = process.hrtime.bigint();
  const replay = replayAdpMockDraft(fixture.rows, {
    teams: TEAMS,
    slot: SLOT,
    rounds: ROUNDS,
    config,
    seed: SEED,
    candidateLimit: CANDIDATES,
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  const rowById = new Map(fixture.rows.map((row) => [row.playerId, row]));
  process.stdout.write(
    `our picks (replayed in ${(elapsedMs / 1000).toFixed(1)}s)\n` +
      `${ourPickLines(replay, rowById)}\n\n`,
  );
  if (showFullLog) {
    process.stdout.write(`every pick\n${fullLogLines(replay, rowById)}\n\n`);
  }

  const outcomes = evaluateChecks(replay, fixture.rows);
  process.stdout.write(`scoreboard\n${scoreboardLines(outcomes)}\n\n`);

  const unexpected = outcomes.filter((outcome) => outcome.status !== outcome.expected);
  const failing = outcomes.filter((outcome) => outcome.status === "fail").length;
  if (unexpected.length === 0) {
    process.stdout.write(
      `${outcomes.length} checks: ${outcomes.length - failing} pass, ${failing} fail — ` +
        `every outcome matches its documented expectation.\n` +
        (failing > 0
          ? `The failures are the audit's findings, regression-locked; ` +
            `#91 says which PR flips which.\n`
          : ``),
    );
  } else {
    process.stdout.write(
      `${unexpected.length} check(s) disagree with their documented expectation: ` +
        `${unexpected.map((outcome) => `(${outcome.id}) expected ${outcome.expected}, ` +
          `got ${outcome.status}`).join("; ")}\n` +
        `An unexpected pass means a fix landed without flipping its expectation in ` +
        `lib/nfl/draft/mock.ts. An unexpected failure is a regression.\n`,
    );
    process.exitCode = 1;
  }
}

main();
