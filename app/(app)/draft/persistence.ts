/**
 * Keeping a draft in progress across a remount.
 *
 * The board holds everything in component state, which is fine until something throws.
 * The error boundary above it offers "Try again", and `reset()` re-renders the segment —
 * which remounts this page, which reinitialises `useState`, which loses every pick the
 * user has recorded. The boundary's own text claimed the opposite. A draft is used once a
 * year under a pick clock, and losing the board at that moment is the worst failure this
 * feature has, so the fix is to make the claim true rather than to soften it.
 *
 * `sessionStorage` rather than `localStorage`: a draft belongs to the tab it is happening
 * in, and a stale board silently restored into a *new* draft next August would be worse
 * than starting empty. It also survives a reload, so both buttons on the error screen now
 * keep the picks.
 *
 * Restoration happens in an effect rather than in a `useState` initialiser. The initialiser
 * runs during render, including on the server where `sessionStorage` does not exist, and
 * seeding from it would make the server and client render different markup.
 */

import { ROSTER_TEMPLATES } from "@/lib/nfl/roster";
import { SCORING_PRESETS } from "@/lib/nfl/scoring/presets";

/** Bumped when the shape below changes, so an old payload is ignored rather than misread. */
export const DRAFT_STORAGE_KEY = "fantasy-gto:draft:v1";

/**
 * League sizes a board is built for. ADP is published per league size, so a board is not
 * transferable. Mirrors `DRAFT_BOARD_LEAGUE_SIZES` in `convex/ingest.ts`.
 *
 * These live here rather than in the page because this is the module that has to decide
 * whether a stored draft is one the product can actually serve.
 */
export const LEAGUE_SIZES = [8, 10, 12, 14] as const;

export const PLAYOFF_FIELDS = [4, 6] as const;

/** Rounds beyond this are not a draft anyone is running. */
export const MAX_ROUNDS = 40;

export interface PersistedDraft {
  teams: number;
  rounds: number;
  slot: number;
  scoringId: string;
  templateId: string;
  playoffTeams: number;
  started: boolean;
  /** Overall pick number to player id. */
  picks: Record<number, string>;
}

/**
 * Reads a stored draft, or `null` if there is nothing usable there.
 *
 * Every field is checked. The payload survives a deploy, so a build that changed the shape
 * will find the old one still sitting in the browser, and a half-read draft that restores
 * some fields and defaults others is a board whose picks belong to a different league —
 * exactly the silent wrongness this whole feature is written to avoid.
 */
export function parsePersistedDraft(raw: string | null): PersistedDraft | null {
  if (raw === null || raw === "") return null;

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const row = payload as Record<string, unknown>;

  const teams = whole(row.teams);
  const rounds = whole(row.rounds);
  const slot = whole(row.slot);
  const playoffTeams = whole(row.playoffTeams);
  if (teams === null || rounds === null || slot === null || playoffTeams === null) {
    return null;
  }
  // Range and cross-field checks, not only types. Nothing downstream repairs these: the
  // setup controls only offer valid values, so a stored `playoffTeams` of 11 has no
  // control that could correct it and goes straight into the simulation config. A slot
  // outside the league is the specific bug that once handed a manager's whole draft to
  // another seat.
  if (!LEAGUE_SIZES.includes(teams as (typeof LEAGUE_SIZES)[number])) return null;
  if (rounds > MAX_ROUNDS) return null;
  if (slot > teams) return null;
  if (!PLAYOFF_FIELDS.includes(playoffTeams as (typeof PLAYOFF_FIELDS)[number])) return null;
  // Unreachable with the current lists — 4 or 6 against 8 through 14 — and kept for the
  // day one of them changes. A field as large as the league sends everyone to the
  // playoffs, which is not a league anyone is simulating.
  if (playoffTeams >= teams) return null;

  const { scoringId, templateId, started } = row;
  if (typeof scoringId !== "string" || typeof templateId !== "string") return null;
  if (typeof started !== "boolean") return null;
  // An unknown preset would silently fall back to the default, scoring the whole board
  // under rules the user did not choose.
  if (!SCORING_PRESETS.some((preset) => preset.id === scoringId)) return null;
  if (!ROSTER_TEMPLATES.some((template) => template.id === templateId)) return null;

  const picks = parsePicks(row.picks, teams * rounds);
  if (picks === null) return null;

  return { teams, rounds, slot, scoringId, templateId, playoffTeams, started, picks };
}

/**
 * Pick numbers are 1-based whole numbers inside the draft, and player ids are non-empty
 * and unique.
 *
 * A pick beyond the last one in the league belongs to no seat, and the same player drafted
 * twice is a board that cannot exist — both would be rendered as a real draft and both
 * would make the recommendations wrong rather than absent.
 */
function parsePicks(value: unknown, totalPicks: number): Record<number, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<number, string> = {};
  const seen = new Set<string>();
  for (const [key, playerId] of Object.entries(value as Record<string, unknown>)) {
    const pick = Number(key);
    if (!Number.isInteger(pick) || pick < 1 || pick > totalPicks) return null;
    // `"1"` and `"01"` both parse to pick 1, and the second would overwrite the first —
    // silently repairing corrupt state into a different draft instead of refusing it.
    if (String(pick) !== key) return null;
    if (typeof playerId !== "string" || playerId === "") return null;
    if (seen.has(playerId)) return null;
    seen.add(playerId);
    out[pick] = playerId;
  }
  return out;
}

function whole(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}
