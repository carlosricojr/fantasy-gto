import { parseCsv } from "./csv";

/**
 * Lineup import and export.
 *
 * Kept pure and separate from the HTTP routes so the format is testable without a server.
 * The export format is deliberately the same shape the importer accepts, so a round trip
 * is lossless — a user can export, edit in a spreadsheet, and re-import.
 */

export interface LineupRow {
  slot: string;
  player: string;
  position: string;
  team: string;
  projected: number | null;
}

const HEADER = ["slot", "player", "position", "team", "projected"] as const;

/**
 * Escapes a field for CSV output.
 *
 * Player names contain commas ("Odell Beckham, Jr.") and apostrophes, and a naive join
 * would corrupt the file in exactly the way our own importer would then misread.
 */
function escapeField(value: string): string {
  if (value === "") return "";
  const needsQuotes = /[",\r\n]/.test(value);
  const escaped = value.replace(/"/g, '""');
  return needsQuotes ? `"${escaped}"` : escaped;
}

/** Serialises a lineup to CSV with a header row and CRLF terminators, per RFC 4180. */
export function toLineupCsv(rows: readonly LineupRow[]): string {
  const lines = [HEADER.join(",")];
  for (const row of rows) {
    lines.push(
      [
        escapeField(row.slot),
        escapeField(row.player),
        escapeField(row.position),
        escapeField(row.team),
        row.projected === null ? "" : row.projected.toFixed(2),
      ].join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

export interface LineupParseResult {
  rows: LineupRow[];
  /** Human-readable problems. Present rows are still returned. */
  warnings: string[];
}

/**
 * Parses an uploaded lineup.
 *
 * Tolerant by design: a spreadsheet round trip reorders columns, changes case, and adds
 * blank rows. Unknown columns are ignored and missing optional values become null, but a
 * file with no recognisable player column is reported rather than silently yielding
 * nothing.
 */
export function fromLineupCsv(text: string): LineupParseResult {
  const warnings: string[] = [];
  const parsed = parseCsv(text);

  if (parsed.length === 0) {
    return { rows: [], warnings: ["The file is empty or has only a header row."] };
  }

  // Match headers case-insensitively and ignore surrounding whitespace.
  const sample = parsed[0];
  const keyFor = (want: string): string | null => {
    for (const key of Object.keys(sample)) {
      if (key.trim().toLowerCase() === want) return key;
    }
    return null;
  };

  const playerKey = keyFor("player") ?? keyFor("name");
  if (playerKey === null) {
    return {
      rows: [],
      warnings: ["No 'player' column found. Expected columns: slot, player, position, team."],
    };
  }

  const slotKey = keyFor("slot");
  const positionKey = keyFor("position") ?? keyFor("pos");
  const teamKey = keyFor("team");
  const projectedKey = keyFor("projected") ?? keyFor("projection");

  const rows: LineupRow[] = [];
  for (const [index, record] of parsed.entries()) {
    const player = (record[playerKey] ?? "").trim();
    if (player === "") continue; // blank spreadsheet row

    let projected: number | null = null;
    if (projectedKey !== null) {
      const raw = (record[projectedKey] ?? "").trim();
      if (raw !== "") {
        const value = Number(raw);
        if (Number.isFinite(value)) {
          projected = value;
        } else {
          warnings.push(`Row ${index + 2}: could not read "${raw}" as a projection.`);
        }
      }
    }

    rows.push({
      slot: slotKey ? (record[slotKey] ?? "").trim() : "",
      player,
      position: positionKey ? (record[positionKey] ?? "").trim().toUpperCase() : "",
      team: teamKey ? (record[teamKey] ?? "").trim().toUpperCase() : "",
      projected,
    });
  }

  if (rows.length === 0) warnings.push("No player rows were found in the file.");

  return { rows, warnings };
}
