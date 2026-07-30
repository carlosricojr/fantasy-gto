/**
 * A minimal RFC 4180 CSV parser.
 *
 * This exists rather than a `String.split(",")` because the upstream nflverse data
 * contains quoted fields with embedded commas — `headshot_url` holds values like
 * `.../upload/f_auto,q_auto/league/...`. Splitting naively shifts every subsequent column
 * and corrupts the parse silently, which is far worse than failing loudly.
 *
 * It also exists rather than a dependency because the requirement is small and fully
 * specified, and a parser in the trust path of every projection is worth owning outright.
 *
 * Supported: quoted fields, embedded commas, embedded newlines, escaped quotes (`""`),
 * and LF / CRLF / CR line terminators. Upstream currently uses LF, but tolerating all
 * three costs nothing and removes a class of platform-dependent breakage.
 */

/** A parsed row keyed by column name. Absent trailing columns read as `""`. */
export type CsvRow = Readonly<Record<string, string>>;

/**
 * Splits CSV text into rows of raw string cells.
 *
 * A trailing newline does not produce a final empty row. A blank line in the middle of
 * the document does produce a row with a single empty cell, matching RFC 4180.
 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldWasQuoted = false;
  let i = 0;

  // Strip a UTF-8 BOM; it would otherwise contaminate the first header name.
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  const endField = () => {
    row.push(field);
    field = "";
    fieldWasQuoted = false;
  };

  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          // An escaped quote inside a quoted field.
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"' && field === "" && !fieldWasQuoted) {
      inQuotes = true;
      fieldWasQuoted = true;
      i += 1;
      continue;
    }

    if (char === ",") {
      endField();
      i += 1;
      continue;
    }

    if (char === "\r") {
      endRow();
      // Consume CRLF as a single terminator.
      i += text[i + 1] === "\n" ? 2 : 1;
      continue;
    }

    if (char === "\n") {
      endRow();
      i += 1;
      continue;
    }

    field += char;
    i += 1;
  }

  // Flush the final row unless the document ended exactly on a line terminator.
  if (field !== "" || row.length > 0) endRow();

  return rows;
}

/**
 * Parses CSV text into objects keyed by the header row.
 *
 * Rows with fewer cells than the header are padded with `""` rather than rejected:
 * upstream occasionally omits trailing empty columns, and a hard failure there would
 * take down an entire ingest for a cosmetic defect. Extra cells beyond the header are
 * dropped, since there is no name to bind them to.
 *
 * Returns an empty array for empty input or a header-only document.
 */
export function parseCsv(text: string): CsvRow[] {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];

  const header = rows[0];
  const out: CsvRow[] = [];

  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r];
    // Skip the blank line that a stray terminator can produce.
    if (cells.length === 1 && cells[0] === "") continue;

    const record: Record<string, string> = {};
    for (let c = 0; c < header.length; c += 1) {
      record[header[c]] = cells[c] ?? "";
    }
    out.push(record);
  }

  return out;
}

/**
 * Reads a numeric cell.
 *
 * nflverse encodes "no value" as an empty string and occasionally as the R idiom `NA`.
 * Both mean zero for accumulation purposes (a player with no carries has no rushing
 * yards), so both map to the supplied fallback rather than `NaN`. Letting `NaN` escape
 * here would silently poison every downstream average.
 */
export function num(row: CsvRow, key: string, fallback = 0): number {
  const raw = row[key];
  if (raw === undefined || raw === "" || raw === "NA") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Reads a string cell, normalising absent and R-style `NA` values to `""`. */
export function str(row: CsvRow, key: string): string {
  const raw = row[key];
  if (raw === undefined || raw === "NA") return "";
  return raw;
}

/**
 * Reads a numeric cell that is genuinely optional, distinguishing "absent" from "zero".
 *
 * Vegas lines and weather need this: a `total_line` of 0 is not the same as a game with
 * no line posted, and treating the latter as 0 would drag every projection toward zero.
 */
export function numOrNull(row: CsvRow, key: string): number | null {
  const raw = row[key];
  if (raw === undefined || raw === "" || raw === "NA") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
