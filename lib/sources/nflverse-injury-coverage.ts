import type { InjuryReport } from "../nfl/injuries";
import { injuriesUrl } from "./nflverse";

/** Observations in the requested slice, not proof of complete or current reporting. */
export interface NflverseInjuryCoverage {
  sourceUrl: string;
  season: number;
  week: number;
  reportRows: number;
  reportedTeams: string[];
  datedRows: number;
  latestRowUpdatedAt: number | null;
  /** A row date cannot establish that this release is the latest provider revision. */
  freshness: "unknown";
  scope: "reported-rows-only";
}

export function summarizeNflverseInjuryCoverage(reports: readonly InjuryReport[], season: number, week: number): NflverseInjuryCoverage {
  const rows = reports.filter(row => row.season === season && row.week === week);
  // Explicit timezone required: local-time parsing would invent a source instant.
  const dates = rows.flatMap(row => {
    if (row.dateModified === null || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(row.dateModified)) return [];
    const value = Date.parse(row.dateModified);
    return Number.isFinite(value) ? [value] : [];
  });
  return { sourceUrl: injuriesUrl(season), season, week, reportRows: rows.length,
    reportedTeams: [...new Set(rows.flatMap(row => row.team === null ? [] : [row.team]))].sort(),
    datedRows: dates.length, latestRowUpdatedAt: dates.length ? Math.max(...dates) : null,
    freshness: "unknown", scope: "reported-rows-only" };
}

export function injuryCoverageWarning(coverage: NflverseInjuryCoverage): string {
  const date = coverage.latestRowUpdatedAt === null ? "No usable row update timestamp is available."
    : `Latest dated row: ${new Date(coverage.latestRowUpdatedAt).toISOString()} (${coverage.datedRows}/${coverage.reportRows} rows dated).`;
  return `nflverse injury source for ${coverage.season} week ${coverage.week}: ${coverage.reportRows} reported rows across ${coverage.reportedTeams.length} teams${coverage.reportedTeams.length ? ` (${coverage.reportedTeams.join(", ")})` : ""}. ${date} Source freshness and complete team coverage are unverified; a represented team or an absent player is not injury clearance.`;
}
