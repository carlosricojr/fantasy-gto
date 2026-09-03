/**
 * Keeping a draft in progress across a remount.
 *
 * The board holds everything in component state, which is fine until something throws.
 * The error boundary above it offers "Try again", and `reset()` re-renders the segment —
 * which remounts this page, which reinitializes `useState`, which loses every pick the
 * user has recorded. The boundary's own text claimed the opposite. A draft is used once a
 * year under a pick clock, and losing the board at that moment is the worst failure this
 * feature has, so the fix is to make the claim true rather than to soften it.
 *
 * `sessionStorage` rather than `localStorage`: a draft belongs to the tab it is happening
 * in, and a stale board silently restored into a *new* draft next August would be worse
 * than starting empty. It also survives a reload, so both buttons on the error screen now
 * keep the picks.
 *
 * Restoration happens in an effect rather than in a `useState` initializer. The initializer
 * runs during render, including on the server where `sessionStorage` does not exist, and
 * seeding from it would make the server and client render different markup.
 */

import { SUPPORTED_LEAGUE_SIZES } from "@/lib/nfl/draft/league-size";
import {
  CHAMPIONSHIP_WEEKS,
  DEFAULT_CHAMPIONSHIP_WEEK,
  PLAYOFF_FIELDS,
} from "@/lib/nfl/league-rules";
import { ROSTER_TEMPLATES } from "@/lib/nfl/roster";
import { SCORING_PRESETS } from "@/lib/nfl/scoring/presets";
import type { IdentityRepair } from "@/lib/nfl/draft/provider-identity";
import type { SleeperSyncPick } from "@/lib/nfl/draft/sleeper-sync";
import type { SleeperTradedPick } from "@/lib/sources/sleeper";

export { CHAMPIONSHIP_WEEKS, DEFAULT_CHAMPIONSHIP_WEEK, PLAYOFF_FIELDS };

/**
 * Bumped when an old payload could be *misread*, which is not the same as whenever the
 * shape changes.
 *
 * A field added with a default that reproduces the behaviour the old payload already had
 * needs no bump, and must not get one: bumping discards every draft in progress, and doing
 * that to avoid a migration that consists of one default is the cure being worse than the
 * disease. `championshipWeek` is exactly that case — absent means week 17, which is what a
 * payload written before it existed was already being simulated as. A field whose absence
 * cannot be filled in that way is what this constant is for.
 */
export const DRAFT_STORAGE_KEY = "fantasy-gto:draft:v1";

/**
 * League sizes a board is built for.
 *
 * One list, in `lib/nfl/draft/league-size.ts`, which the ingest path reads through
 * `adpSourceFor` and the refresh plan through `draftBoardMatrix`. It used to be two literals
 * kept in step by hand, and the direction they drift in is the bad one: a size the page
 * offers and the cron does not build is a league whose board is permanently empty. The
 * constant this comment named on the other side of that pairing is gone, which is what a
 * stale guideline looks like from the inside.
 *
 * ADP is published per league size, so a board is not transferable between them — seven of
 * the eleven are derived from a neighbour by rescaling every pick number, and the board
 * carries which.
 */
export const LEAGUE_SIZES = SUPPORTED_LEAGUE_SIZES;

/**
 * Rounds beyond this are not a draft anyone is running.
 *
 * The setup control uses this same constant as its ceiling. They were two independent
 * numbers — the control capped at 30, this accepted 40 — so a restored draft could hold a
 * round count the interface could neither represent nor correct.
 */
export const MAX_ROUNDS = 30;

/** Stored source history for a connected draft. It is separate from manual board picks. */
export interface PersistedSleeperSync {
  draftId: string;
  status: string;
  /** Browser receipt time, not a claim about provider event time. */
  lastSyncedAt: number | null;
  providerPicks: readonly SleeperSyncPick[];
  repairs: readonly IdentityRepair[];
  /** Source ownership facts retained so every roster can be reconstructed after a reload. */
  slotToRosterId: Readonly<Record<number, number>>;
  tradedPicks: readonly SleeperTradedPick[];
}

export interface PersistedDraft {
  teams: number;
  rounds: number;
  slot: number;
  /** False until the manager actively confirms which draft seat is theirs. */
  slotConfirmed: boolean;
  scoringId: string;
  templateId: string;
  /**
   * Whether the user actively confirmed the scoring format, rather than accepting whatever
   * was preselected.
   *
   * The setup screen shows PPR selected on arrival, which is the most common format and a
   * reasonable default for a control — and a terrible default for a *decision*. A standard-
   * scoring league that clicked straight past it drafts against a board built for a format
   * it does not play, and every value on it is wrong in a way that reads as merely
   * surprising rather than as an error.
   *
   * Stored, so the confirmation survives a reload instead of being asked for again halfway
   * through a draft. Optional on the way in and defaulted to `false`: a payload written
   * before this field existed carries a choice nobody confirmed, and treating it as
   * confirmed would be inventing the very acknowledgement this exists to require.
   */
  scoringConfirmed: boolean;
  playoffTeams: number;
  /**
   * The week the league's final is played, which fixes both halves of the season.
   *
   * Absent on the way in and defaulted to `DEFAULT_CHAMPIONSHIP_WEEK`, which is exactly
   * what a payload written before this field existed was already being simulated as. That
   * makes the default a migration rather than a guess: a draft stored yesterday restores
   * into the same season it was drafted against. It is unlike `scoringConfirmed`, where
   * defaulting to the permissive value would have invented an acknowledgement nobody gave.
   */
  championshipWeek: number;
  started: boolean;
  /** Overall pick number to player id. */
  picks: Record<number, string>;
  /**
   * Player ids the manager is watching, in their own order.
   *
   * Read leniently — a payload without it restores as an empty queue rather than being
   * refused. That is deliberately different from every other field here. The rest decide
   * *whose picks are whose*, and a half-read one produces a board belonging to a different
   * league; a queue is a note to self, and a build that adds one must not throw away the
   * in-progress drafts of everybody who was mid-draft when it shipped. Refusing on an
   * absent optional field is how a storage-version bump loses a real draft to a cosmetic
   * change.
   */
  queue: string[];
  /** Optional so a pre-sync tab restores rather than being invalidated by this addition. */
  sleeper: PersistedSleeperSync | null;
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
  // The empty-string test is a fast path rather than a behavior: `JSON.parse("")` throws
  // and the catch below returns null anyway. Kept because "nothing stored yet" is the
  // ordinary case and reads better than an exception.
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

  // `undefined` alone is the legacy case. A stored `null`, string or fraction is a
  // malformed payload and refused with the rest, rather than quietly becoming the default
  // — the same distinction every other field here makes.
  const championshipWeek =
    row.championshipWeek === undefined
      ? DEFAULT_CHAMPIONSHIP_WEEK
      : whole(row.championshipWeek);
  if (championshipWeek === null) return null;
  if (
    !CHAMPIONSHIP_WEEKS.includes(championshipWeek as (typeof CHAMPIONSHIP_WEEKS)[number])
  ) {
    return null;
  }

  const { scoringId, templateId, started } = row;
  // Absent means "not confirmed", which is the safe reading of a payload written before the
  // field existed. Anything else present but not a boolean is malformed and refused with the
  // rest of the payload rather than coerced.
  const scoringConfirmed = row.scoringConfirmed ?? false;
  if (typeof scoringConfirmed !== "boolean") return null;
  // Like scoring confirmation, absence is the legacy case and cannot be read as consent.
  // A default seat is useful for rendering a control and unsafe for assigning a roster.
  const slotConfirmed = row.slotConfirmed ?? false;
  if (typeof slotConfirmed !== "boolean") return null;
  // Both tested here for the message they give a reader, not because either is load-bearing
  // on its own: a non-string of either kind fails the `some(...)` membership check below,
  // since no preset id equals a number.
  if (typeof scoringId !== "string" || typeof templateId !== "string") return null;
  if (typeof started !== "boolean") return null;
  // An unknown preset would silently fall back to the default, scoring the whole board
  // under rules the user did not choose.
  if (!SCORING_PRESETS.some((preset) => preset.id === scoringId)) return null;
  if (!ROSTER_TEMPLATES.some((template) => template.id === templateId)) return null;

  const picks = parsePicks(row.picks, teams * rounds);
  if (picks === null) return null;

  const sleeper = parseSleeperSync(row.sleeper);
  if (sleeper === undefined) return null;

  return {
    teams,
    rounds,
    slot,
    slotConfirmed,
    scoringId,
    templateId,
    scoringConfirmed,
    playoffTeams,
    championshipWeek,
    started,
    picks,
    queue: parseQueue(row.queue),
    sleeper,
  };
}

function parseSleeperSync(value: unknown): PersistedSleeperSync | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.draftId !== "string" || row.draftId.trim() === "") return undefined;
  if (typeof row.status !== "string" || !nullableTimestamp(row.lastSyncedAt)) return undefined;
  if (!Array.isArray(row.providerPicks) || !Array.isArray(row.repairs)) return undefined;
  const providerPicks: SleeperSyncPick[] = [];
  for (const entry of row.providerPicks) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
    const pick = entry as Record<string, unknown>;
    if (
      typeof pick.pickKey !== "string" ||
      typeof pick.playerName !== "string" ||
      !nullableWhole(pick.overall) ||
      !nullableWhole(pick.draftSlot) ||
      !nullableText(pick.position) ||
      !nullableText(pick.team) ||
      !nullableText(pick.playerId) ||
      !(typeof pick.isKeeper === "boolean" || pick.isKeeper === null)
    ) {
      return undefined;
    }
    providerPicks.push(pick as unknown as SleeperSyncPick);
  }
  const repairs: IdentityRepair[] = [];
  for (const entry of row.repairs) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
    const repair = entry as Record<string, unknown>;
    if (
      typeof repair.repairId !== "string" ||
      typeof repair.pickKey !== "string" ||
      typeof repair.boardPlayerId !== "string"
    ) {
      return undefined;
    }
    repairs.push(repair as unknown as IdentityRepair);
  }
  // Both are additive fields. A payload from before traded-pick support restores with the
  // old ordinary-snake behavior, then the live poll refreshes the authoritative source
  // facts immediately. Discarding an in-progress draft to avoid that brief migration
  // would be the more damaging failure.
  const slotToRosterId = parseSlotToRosterId(row.slotToRosterId);
  if (slotToRosterId === null) return undefined;
  const tradedPicks = parseTradedPicks(row.tradedPicks);
  if (tradedPicks === null) return undefined;
  return {
    draftId: row.draftId,
    status: row.status,
    lastSyncedAt: row.lastSyncedAt as number | null,
    providerPicks,
    repairs,
    slotToRosterId,
    tradedPicks,
  };
}

function parseSlotToRosterId(value: unknown): Record<number, number> | null {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<number, number> = {};
  for (const [key, rosterId] of Object.entries(value as Record<string, unknown>)) {
    const slot = Number(key);
    if (
      !Number.isInteger(slot) ||
      slot < 1 ||
      String(slot) !== key ||
      typeof rosterId !== "number" ||
      !Number.isInteger(rosterId) ||
      rosterId < 1
    ) {
      return null;
    }
    out[slot] = rosterId;
  }
  return out;
}

function parseTradedPicks(value: unknown): SleeperTradedPick[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: SleeperTradedPick[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const row = entry as Record<string, unknown>;
    if (
      !nullableText(row.season) ||
      !nullableWhole(row.round) ||
      !nullableWhole(row.rosterId) ||
      !nullableWhole(row.ownerId) ||
      !nullableWhole(row.previousOwnerId)
    ) {
      return null;
    }
    out.push(row as unknown as SleeperTradedPick);
  }
  return out;
}

function nullableWhole(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value > 0);
}

function nullableText(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function nullableTimestamp(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

/**
 * A stored queue, or an empty one for anything unreadable.
 *
 * Total by construction, for the reason `PersistedDraft.queue` gives: nothing about a
 * watch list justifies discarding a draft. Duplicates and non-strings are dropped rather
 * than rejected — a queue holding the same player twice renders two identical rows whose
 * remove buttons both delete the first, which is a defect, not a corrupt draft.
 */
function parseQueue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || entry === "") continue;
    seen.add(entry);
  }
  return [...seen];
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
    // Kept per-key for the clearer refusal, though the prefix check at the end of this
    // function now subsumes most of it: a fractional, zero or negative key leaves the 1..n
    // run incomplete and is refused there too. Only "past the last pick" is caught here
    // alone, and only when everything below it is otherwise a complete prefix.
    if (!Number.isInteger(pick) || pick < 1 || pick > totalPicks) return null;
    // `"1"` and `"01"` both parse to pick 1, and the second would overwrite the first —
    // silently repairing corrupt state into a different draft instead of refusing it.
    if (String(pick) !== key) return null;
    if (typeof playerId !== "string" || playerId === "") return null;
    if (seen.has(playerId)) return null;
    seen.add(playerId);
    out[pick] = playerId;
  }

  // And they must be the picks 1..n with no gaps. Each key passing its own range check is
  // not enough: `{"5":"someone"}` satisfies every test above, and then `nextPick` puts pick
  // 1 on the clock while a player sits at pick 5. Recording fills 1, 2, 3, 4 and stops —
  // `nextPick` returns 6 — so the board reads as five picks made and one of them is a
  // player nobody chose at a turn nobody took. `undoPick` cannot repair it either: from
  // `{"5":...}` it computes pick 0 and refuses.
  //
  // A draft is a prefix by construction, so anything else is corrupt rather than unusual,
  // and the rule for corrupt state here is to refuse the whole restore.
  const picked = Object.keys(out).length;
  for (let pick = 1; pick <= picked; pick += 1) {
    if (out[pick] === undefined) return null;
  }
  return out;
}

function whole(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * The pick now on the clock: the first without a player recorded against it.
 *
 * Exported, and taken as an argument rather than read from a component's render scope,
 * because both the button handlers and the display need it and they must not disagree.
 * They did: `record` and `undo` computed it once per render and used that value inside a
 * functional state update, so two clicks landing before React re-rendered both saw the
 * *previous* pick number. Two different players clicked quickly wrote the same key and the
 * first was silently overwritten — the board showed one pick where two had been made, and
 * the player it dropped stayed available and kept being recommended.
 *
 * Derived from the state the updater was handed, it cannot be stale by construction.
 */
export function nextPick(
  picks: Readonly<Record<number, string>>,
  totalPicks: number,
): number {
  for (let pick = 1; pick <= totalPicks; pick += 1) {
    if (picks[pick] === undefined) return pick;
  }
  // One past the end, which is how the caller knows the draft is finished.
  return totalPicks + 1;
}

/** Records a player at whatever pick is on the clock, or returns the state unchanged. */
export function recordPick(
  picks: Readonly<Record<number, string>>,
  playerId: string,
  totalPicks: number,
): Record<number, string> {
  // Both guards live here rather than at the call site for the same reason as `nextPick`:
  // a check against a rendered snapshot cannot see a pick made a moment ago. A stale
  // recommendation panel keeps a live button next to a player who has just been taken, and
  // a double tap on a phone is the ordinary way to hit it twice.
  if (Object.values(picks).includes(playerId)) return picks as Record<number, string>;
  const pick = nextPick(picks, totalPicks);
  if (pick > totalPicks) return picks as Record<number, string>;
  return { ...picks, [pick]: playerId };
}

/** Removes the most recent pick, or returns the state unchanged when there is none. */
export function undoPick(
  picks: Readonly<Record<number, string>>,
  totalPicks: number,
): Record<number, string> {
  const pick = nextPick(picks, totalPicks) - 1;
  if (pick < 1) return picks as Record<number, string>;
  const next = { ...picks };
  delete next[pick];
  return next;
}
