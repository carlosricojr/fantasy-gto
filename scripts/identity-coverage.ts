import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseCsv } from "../lib/nfl/csv";
import { parseBoardFixture } from "../lib/nfl/draft/mock";
import {
  auditIdentityCoverage,
  hasUnresolvedIdentityCoverage,
  type CoverageCounts,
  type PickIdentityClassification,
  type PlayerIdentity,
} from "../lib/nfl/draft/provider-identity";
import { parseSeasonRoster, seasonRosterUrl } from "../lib/sources/nflverse";
import { parsePlayersDump, playersUrl } from "../lib/sources/sleeper";

/**
 * Re-measures the provider-to-board identity seam used by live draft picks.
 *
 * Usage:
 *   pnpm identity-coverage
 *   pnpm identity-coverage -- --board path/to/draft-board.json
 *
 * The default board is the public production `draft:board` query for the checked-in current
 * shape. Its provenance is printed before the counts; pass an exported snapshot to audit a
 * different board. Sleeper and the nflverse season roster are fetched afresh and copied to
 * `.cache/identity-coverage` for inspection. Those caches are evidence, never inputs, so
 * this command cannot present yesterday's provider universe as current coverage.
 */

const DEFAULT_BOARD = join(
  process.cwd(),
  "tests/fixtures/draft_board_2026_half_ppr_10team.json",
);
const CACHE = join(process.cwd(), ".cache", "identity-coverage");
const PRODUCTION_CONVEX_URL = "https://limitless-elk-261.convex.cloud";
const CURRENT_SHAPE = { season: 2026, scoringId: "half_ppr", teams: 10 };

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a path`);
  }
  return value;
}

async function fetchFresh(name: string, url: string): Promise<string> {
  mkdirSync(CACHE, { recursive: true });
  process.stdout.write(`fetching ${name} (live; cache is not read)\n`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  const text = await response.text();
  writeFileSync(join(CACHE, name), text);
  return text;
}

async function fetchCurrentBoard() {
  const response = await fetch(`${PRODUCTION_CONVEX_URL}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "draft:board",
      args: CURRENT_SHAPE,
      format: "json",
    }),
  });
  if (!response.ok)
    throw new Error(`production draft board responded ${response.status}`);
  const payload: unknown = await response.json();
  if (typeof payload !== "object" || payload === null) {
    throw new Error("production draft board is not an object response");
  }
  const value = (payload as Record<string, unknown>).value;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("production draft board returned no rows");
  }
  return parseBoardFixture({
    source: `live production draft:board, ${PRODUCTION_CONVEX_URL}`,
    ...CURRENT_SHAPE,
    computedAt: 0,
    rows: value,
  });
}

function line(label: string, counts: CoverageCounts): void {
  process.stdout.write(
    `${label}: matched ${counts.matched}/${counts.total}; ` +
      `ambiguous ${counts.ambiguous}/${counts.total}; ` +
      `unmatched ${counts.unmatched}/${counts.total}\n`,
  );
}

function formatClassification(
  classification: Exclude<PickIdentityClassification, { state: "matched" }>,
): string {
  const source = classification.input;
  const context =
    `${source.pickKey}: ${source.name} | ${source.position ?? "?"} | ` +
    `${source.team ?? "?"} | provider id ${source.providerPlayerId ?? "?"}`;
  if (classification.state === "unmatched")
    return `${context} — unmatched (${classification.reason})`;
  const candidates = classification.candidates
    .map(
      (candidate) =>
        `${candidate.boardPlayerId} (${candidate.name}, ${candidate.position}, ` +
        `${candidate.team ?? "?"}, provider id ${candidate.providerId ?? "?"})`,
    )
    .join("; ");
  return `${context} — ambiguous (${classification.reason}): ${candidates}`;
}

function unresolved(label: string, counts: CoverageCounts): void {
  process.stdout.write(
    `\n${label} unresolved identities (${counts.unresolved.length})\n`,
  );
  if (counts.unresolved.length === 0) {
    process.stdout.write("  none\n");
    return;
  }
  for (const classification of [...counts.unresolved].sort((a, b) =>
    a.input.pickKey.localeCompare(b.input.pickKey),
  )) {
    process.stdout.write(`  ${formatClassification(classification)}\n`);
  }
}

async function main(): Promise<void> {
  const boardPath = argument("--board");
  const fixture =
    boardPath === null
      ? await fetchCurrentBoard()
      : parseBoardFixture(
          JSON.parse(readFileSync(boardPath ?? DEFAULT_BOARD, "utf8")),
        );
  const rosterRaw = await fetchFresh(
    `roster_${fixture.season}.csv`,
    seasonRosterUrl(fixture.season),
  );
  const sleeperRaw = await fetchFresh("players_nfl.json", playersUrl());
  const sleeperPayload: unknown = JSON.parse(sleeperRaw);
  if (
    typeof sleeperPayload !== "object" ||
    sleeperPayload === null ||
    Array.isArray(sleeperPayload)
  ) {
    throw new Error(
      "Sleeper players payload is not the object the parser expects",
    );
  }

  const rosterById = new Map(
    parseSeasonRoster(parseCsv(rosterRaw)).map((row) => [row.playerId, row]),
  );
  const board: PlayerIdentity[] = fixture.rows.map((row) => {
    const roster = rosterById.get(row.playerId);
    return {
      id: row.playerId,
      providerId: roster?.sleeperId ?? null,
      name: row.name,
      position: row.position,
      team: row.team,
      rookie: roster?.rookieYear === fixture.season,
    };
  });
  const provider: PlayerIdentity[] = parsePlayersDump(
    sleeperPayload as Record<string, unknown>,
  ).map((row) => ({
    id: row.sleeperId,
    providerId: row.sleeperId,
    name: row.name,
    position: row.position,
    team: row.team,
    rookie: row.rookie,
  }));
  const audit = auditIdentityCoverage(board, provider);

  process.stdout.write(
    `\nDraft identity coverage\n` +
      `board: ${fixture.source}\n` +
      `shape: ${fixture.season} ${fixture.scoringId}, ${fixture.teams} teams\n` +
      `Sleeper player universe: ${provider.length} parsed identities\n\n`,
  );
  line("current draft board", audit.board);
  line("current draft board rookies", audit.boardRookies);
  line("current Sleeper player universe", audit.provider);
  line("current Sleeper player universe rookies", audit.providerRookies);
  unresolved("Draft board", audit.board);
  unresolved("Sleeper player universe", audit.provider);
  process.stdout.write(
    `\nidentity coverage status: ${hasUnresolvedIdentityCoverage(audit) ? "UNRESOLVED — not clean" : "clean"}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`identity coverage failed: ${message}\n`);
  process.exitCode = 1;
});
