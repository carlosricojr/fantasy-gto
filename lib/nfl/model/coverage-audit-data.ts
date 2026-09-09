import type { CsvRow } from "../csv";

/** Audit-only boundary: refuse wrong-year, malformed or duplicate regular-season rows. */
export function assertCoverageAuditRows(rows: readonly CsvRow[], season: number, identityKey: "player_id" | "team"): void {
  if (!Number.isInteger(season) || season < 2011 || season > 2024) throw new Error("Coverage audit excludes the 2025 holdout and later seasons.");
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.season_type !== "REG") continue;
    const week = Number(row.week);
    if (Number(row.season) !== season || !Number.isInteger(week) || week < 1 || week > 18 || !row[identityKey]?.trim()) {
      throw new Error("Malformed coverage audit identity or period.");
    }
    const key = `${row[identityKey]}:${week}`;
    if (seen.has(key)) throw new Error(`Duplicate coverage audit observation: ${key}`);
    seen.add(key);
  }
}

/** Empty or whitespace input is missing, never a numeric zero. */
export function hasExplicitCounters(row: CsvRow, keys: readonly string[]): boolean {
  return keys.every(key => row[key] !== undefined && row[key].trim() !== "" && Number.isFinite(Number(row[key])));
}
