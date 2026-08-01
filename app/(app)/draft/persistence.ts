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

/** Bumped when the shape below changes, so an old payload is ignored rather than misread. */
export const DRAFT_STORAGE_KEY = "fantasy-gto:draft:v1";

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
  const { scoringId, templateId, started } = row;
  if (typeof scoringId !== "string" || typeof templateId !== "string") return null;
  if (typeof started !== "boolean") return null;

  const picks = parsePicks(row.picks);
  if (picks === null) return null;

  return { teams, rounds, slot, scoringId, templateId, playoffTeams, started, picks };
}

/** Pick numbers are 1-based whole numbers and player ids are non-empty strings. */
function parsePicks(value: unknown): Record<number, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<number, string> = {};
  for (const [key, playerId] of Object.entries(value as Record<string, unknown>)) {
    const pick = Number(key);
    if (!Number.isInteger(pick) || pick < 1) return null;
    if (typeof playerId !== "string" || playerId === "") return null;
    out[pick] = playerId;
  }
  return out;
}

function whole(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}
