import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type LeagueConfig, fantasySeasonWeeks } from "@/lib/core/season-sim";
import { teamByeWeeks } from "@/lib/nfl/byes";
import { parseCsv } from "@/lib/nfl/csv";
import {
  RECOMMEND_CANDIDATES,
  RECOMMEND_SCENARIOS,
  RECOMMEND_SEED,
} from "@/lib/nfl/draft/engine-config";
import {
  type CheckOutcome,
  type MockBoardRow,
  type MockDraftReplay,
  type ReplayMode,
  applyTeamByes,
  evaluateChecks,
  expectationFor,
  fixtureLeagueMismatch,
  parseBoardFixture,
  replayAdpMockDraft,
  unexpectedOutcomes,
} from "@/lib/nfl/draft/mock";
import { WAIVER_WIRE_COVER, slotsForTemplate } from "@/lib/nfl/roster";
import { parseContests } from "@/lib/sources/nflverse";

/**
 * The mock-draft harness: the #88/#89 audit as a command.
 *
 * `pnpm draft-mock`                      replay BOTH modes and enforce both scoreboards
 * `pnpm draft-mock -- --log`             also print all 160 picks, not only ours
 * `pnpm draft-mock -- --frozen`          only the frozen-board replay (fast iteration)
 * `pnpm draft-mock -- --schedule-byes`   only the schedule-byes replay
 *
 * The schedule-byes mode is #91 PR 2's measurement: the frozen fixture is the audit's
 * record and is never regenerated, so the ingest fix's effect on the replay is measured
 * by applying the same pure bye derivation (`teamByeWeeks` over the frozen 2026 schedule
 * fixture) to the frozen rows at load time. Each mode carries its own expectation column
 * in `CHECK_DEFINITIONS`, and the default invocation replays *both* — a column enforced
 * only when somebody remembers a flag is not a lock, and the two columns are expected to
 * diverge as later PRs land mode-sensitive fixes. The single-mode flags exist for
 * iteration speed and carry the same contract for the one column they run.
 *
 * Nine opponents draft strictly by ADP; seat 5 takes the recommendation panel's #1 every
 * turn, exactly as the audit's browser automation did. The board is frozen under
 * `tests/fixtures/`, `computedAt` 2026-08-17T11:01Z — 07:01 US Eastern, the build #88
 * cites as "07:00". The replay is deterministic, so the scoreboard is a property of the
 * code, not of a run.
 *
 * Each check carries a **documented expectation per mode** in `lib/nfl/draft/mock.ts`,
 * with the audit's observed numbers alongside. As measured on the merged engine (PR 2's
 * bye charge + PR 4's paired tie ranking + PR 3's market-discipline gate): (f) passes in
 * both modes; (a) passes in both — after each of PR 2 and PR 4 alone measured it passing
 * and their merge surfaced Parkinson leading 6.06, the gate closed it structurally by
 * keeping `adp: null` players off the early-round shortlist; (c) passes in both on the
 * gate-reshuffled ordering, a measurement rather than a fix for its #89.A mechanism,
 * which PR 5 still owns; (b), (d), (e) remain the structural failures PR 5
 * owns. The PR that
 * changes a check's status flips its expectation in the same commit. The exit code
 * enforces the contract in both directions:
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

/** The 2026 regular-season schedule, frozen from the same nflverse release ingest reads. */
const SCHEDULE_FIXTURE_PATH = join(process.cwd(), "tests/fixtures/games_2026.csv");

/** The audit league, exactly: 10 teams, seat 5, 16 rounds, half PPR, 2 FLEX, top 6, week 17. */
const TEAMS = 10;
const SLOT = 5;
const ROUNDS = 16;
const TEMPLATE_ID = "two_flex";
const SCORING_ID = "half_ppr";
const SEASON = 2026;
const PLAYOFF_TEAMS = 6;
const CHAMPIONSHIP_WEEK = 17;

/**
 * The page's own constants, imported rather than re-declared: PR #92 shipped these as
 * copies and recorded the drift risk as its known limitation — a page-side change would
 * not have failed the harness. `lib/nfl/draft/engine-config.ts` is now the single copy
 * both read.
 */
const SEED = RECOMMEND_SEED;
const SCENARIOS = RECOMMEND_SCENARIOS;
const CANDIDATES = RECOMMEND_CANDIDATES;

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

function scoreboardLines(outcomes: readonly CheckOutcome[], mode: ReplayMode): string {
  const lines: string[] = [];
  for (const outcome of outcomes) {
    const agreed = outcome.status === expectationFor(outcome, mode);
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
    // Labelled as the browser run's observation: these figures were read off the #88/#89
    // audit session, not computed by this replay — the violations above are what this
    // run measured.
    lines.push(`      #88/#89 browser audit observed: ${outcome.audit}`);
  }
  return lines.join("\n");
}

/**
 * The frozen board in `--schedule-byes` mode: byes resolved from the schedule fixture.
 *
 * Refuses a schedule that cannot answer for the whole league. The fixture is frozen, so
 * this can only fire if it is truncated or edited — and a partial derivation would
 * silently measure a different fix than the one ingest ships.
 */
function boardWithScheduleByes(rows: readonly MockBoardRow[]): MockBoardRow[] {
  const contests = parseContests(parseCsv(readFileSync(SCHEDULE_FIXTURE_PATH, "utf8")));
  const byes = teamByeWeeks(contests, SEASON);
  const leagueTeams = new Set(rows.map((row) => row.team).filter((t) => t !== null));
  const unanswered = [...leagueTeams].filter((team) => !byes.has(team));
  if (unanswered.length > 0) {
    throw new Error(
      `the schedule fixture derives no bye for ${unanswered.sort().join(", ")} — ` +
        `it no longer covers the board's teams, so the mode would measure a partial fix`,
    );
  }
  return applyTeamByes(rows, byes);
}

/** The expectation column a mode reads, by the name a fixer has to type. */
function columnName(mode: ReplayMode): string {
  return mode === "frozen" ? "expected" : "expectedWithScheduleByes";
}

/** Replays one mode, prints its section, and returns the outcomes that ring the alarm. */
function runMode(
  mode: ReplayMode,
  fixture: ReturnType<typeof parseBoardFixture>,
  config: LeagueConfig,
  showFullLog: boolean,
): CheckOutcome[] {
  const board = mode === "frozen" ? fixture.rows : boardWithScheduleByes(fixture.rows);
  if (mode === "schedule-byes") {
    // "Resolved", counted by kind: on this fixture every change is a fill (the pinned
    // 213-agree/0-disagree cross-check), but `applyTeamByes` also overwrites a
    // disagreeing market bye, and a label that only ever says "filled" would misreport
    // the day the feed drifts.
    const filled = board.filter(
      (row, index) => fixture.rows[index].byeWeek === null && row.byeWeek !== null,
    ).length;
    const overwritten = board.filter(
      (row, index) =>
        fixture.rows[index].byeWeek !== null &&
        row.byeWeek !== fixture.rows[index].byeWeek,
    ).length;
    process.stdout.write(
      `mode: schedule-byes — byes resolved from tests/fixtures/games_2026.csv at load\n` +
        `  ${filled} null byes filled, ${overwritten} market byes overwritten, of ` +
        `${fixture.rows.length} rows; the fixture file is untouched\n\n`,
    );
  } else {
    process.stdout.write(`mode: frozen — the audit board verbatim\n\n`);
  }

  const started = process.hrtime.bigint();
  const replay = replayAdpMockDraft(board, {
    teams: TEAMS,
    slot: SLOT,
    rounds: ROUNDS,
    config,
    seed: SEED,
    candidateLimit: CANDIDATES,
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  const rowById = new Map(board.map((row) => [row.playerId, row]));
  process.stdout.write(
    `our picks (replayed in ${(elapsedMs / 1000).toFixed(1)}s)\n` +
      `${ourPickLines(replay, rowById)}\n\n`,
  );
  if (showFullLog) {
    process.stdout.write(`every pick\n${fullLogLines(replay, rowById)}\n\n`);
  }

  const outcomes = evaluateChecks(replay, board);
  process.stdout.write(`scoreboard\n${scoreboardLines(outcomes, mode)}\n\n`);

  const unexpected = unexpectedOutcomes(outcomes, mode);
  const failing = outcomes.filter((outcome) => outcome.status === "fail").length;
  if (unexpected.length === 0) {
    process.stdout.write(
      `${outcomes.length} checks: ${outcomes.length - failing} pass, ${failing} fail — ` +
        `every outcome matches its documented ${mode} expectation.\n` +
        (failing > 0
          ? `The failures are the audit's findings, regression-locked; ` +
            `#91 says which PR flips which.\n\n`
          : `\n`),
    );
  } else {
    process.stdout.write(
      `${unexpected.length} check(s) disagree with their documented ${mode} ` +
        `expectation: ` +
        `${unexpected.map((outcome) => `(${outcome.id}) expected ` +
          `${expectationFor(outcome, mode)}, got ${outcome.status}`).join("; ")}\n` +
        `An unexpected pass means a fix landed without flipping \`${columnName(mode)}\` ` +
        `in lib/nfl/draft/mock.ts. An unexpected failure is a regression.\n\n`,
    );
  }
  return unexpected;
}

function main(): void {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  // Rejected rather than defaulted: `--schedule-bye` or `--scheduleByes` silently
  // downgrading to a green frozen run would publish a number for work that did not
  // happen — the exact defect class `scripts/mutate.ts`'s `--limit` guard documents.
  const KNOWN_FLAGS = ["--log", "--frozen", "--schedule-byes"];
  const unknown = args.filter((a) => !KNOWN_FLAGS.includes(a));
  if (unknown.length > 0) {
    process.stderr.write(
      `Unknown argument(s): ${unknown.join(", ")}. Known flags: ${KNOWN_FLAGS.join(", ")}.\n`,
    );
    process.exitCode = 1;
    return;
  }
  const showFullLog = args.includes("--log");
  if (args.includes("--frozen") && args.includes("--schedule-byes")) {
    process.stderr.write(
      `--frozen and --schedule-byes are each a single-mode filter; ` +
        `to run both modes, pass neither.\n`,
    );
    process.exitCode = 1;
    return;
  }
  // Both by default. Each mode's expectation column is a regression lock, and a lock in
  // a mode nothing runs is not one — (c) is currently locked only by schedule-byes.
  const modes: ReplayMode[] = args.includes("--frozen")
    ? ["frozen"]
    : args.includes("--schedule-byes")
      ? ["schedule-byes"]
      : ["frozen", "schedule-byes"];

  const fixture = parseBoardFixture(JSON.parse(readFileSync(FIXTURE_PATH, "utf8")));
  const mismatch = fixtureLeagueMismatch(fixture, {
    season: SEASON,
    scoringId: SCORING_ID,
    teams: TEAMS,
  });
  if (mismatch !== null) throw new Error(mismatch);

  const slots = slotsForTemplate(TEMPLATE_ID);
  const config: LeagueConfig = {
    slots,
    ...fantasySeasonWeeks(CHAMPIONSHIP_WEEK, PLAYOFF_TEAMS),
    playoffTeams: PLAYOFF_TEAMS,
    scenarios: SCENARIOS,
    meanAbsenceWeeks: 3,
    // The product's own table, like every other engine setting this script imports
    // rather than re-declares: a harness measuring a different waiver-wire prior than
    // the page ships would be measuring a different engine.
    wireCover: WAIVER_WIRE_COVER,
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
      `  policy opponents take the lowest ADP, unranked players last; ` +
      `we take the panel's #1\n` +
      `  modes  ${modes.join(", ")}\n\n`,
  );

  let alarms = 0;
  for (const mode of modes) {
    alarms += runMode(mode, fixture, config, showFullLog).length;
  }
  if (alarms > 0) process.exitCode = 1;
}

main();
