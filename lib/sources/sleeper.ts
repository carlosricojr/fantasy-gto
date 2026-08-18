import { MAX_DRAFT_ROUNDS, MAX_LEAGUE_TEAMS } from "../core/draft";
import { type ProviderResult, failed, ok } from "../core/providers";
import { normalizeTeam } from "../nfl/teams";
import { type TextFetcher, httpTextFetcher } from "./nflverse";

/**
 * Sleeper draft state.
 *
 * The only mainstream platform that publishes live draft state without authentication, so
 * it is the one place a draft can be followed exactly rather than read off the screen.
 * Where this works it should always be preferred: OCR is an approximation with a
 * confidence score, and this is the actual list of picks.
 *
 * ESPN is not an option and cannot be — `lm.espn.com` and `lm-api-reads.espn.com` do not
 * resolve. Yahoo requires OAuth. For everything that is not Sleeper, the screen-reading
 * and manual paths exist, and they are the reason this feature does not depend on any
 * platform's cooperation.
 *
 * Verified by direct request; see `docs/data-sources.md`.
 */

const BASE = "https://api.sleeper.app/v1";

export function draftUrl(draftId: string): string {
  return `${BASE}/draft/${encodeURIComponent(draftId)}`;
}

export function draftPicksUrl(draftId: string): string {
  return `${BASE}/draft/${encodeURIComponent(draftId)}/picks`;
}

export function playersUrl(): string {
  return `${BASE}/players/nfl`;
}

export interface SleeperDraftSettings {
  teams: number;
  rounds: number;
  /** `snake`, `linear`, or `auction`. Only snake and linear are modeled. */
  type: string;
  status: string;
}

export interface SleeperPick {
  /** Overall pick number, 1-based. */
  overall: number;
  /** Round number, 1-based, or `null` when the source did not give a usable one. */
  round: number | null;
  /** Draft slot, 1-based, which is the manager's seat rather than their roster id. */
  draftSlot: number;
  playerName: string;
  position: string | null;
  team: string | null;
  /** Sleeper's own player id, kept so a pick can be de-duplicated across polls. */
  playerId: string | null;
}

export class SleeperDraftProvider {
  constructor(private readonly fetchText: TextFetcher = httpTextFetcher) {}

  async settings(draftId: string): Promise<ProviderResult<SleeperDraftSettings>> {
    const parsed = await this.json(draftUrl(draftId), "draft");
    if (!parsed.ok) return parsed;

    const settings = parseSettings(parsed.data);
    if (settings === null) {
      return failed(
        `Sleeper returned no settings for draft ${draftId}. Check the draft id in the URL.`,
      );
    }
    return ok(settings);
  }

  /**
   * Picks made so far, in order.
   *
   * Safe to poll: it returns the whole list every time, so a caller that misses a poll
   * cannot end up with a board that has permanently skipped a pick. Reconciling the full
   * list each time is deliberate — an incremental feed would make a dropped update
   * silently persistent, which is the failure mode this whole feature has to avoid.
   */
  async picks(draftId: string, teams?: number): Promise<ProviderResult<SleeperPick[]>> {
    const parsed = await this.json(draftPicksUrl(draftId), "picks");
    if (!parsed.ok) return parsed;
    if (!Array.isArray(parsed.data)) {
      return failed(`Sleeper returned an unexpected shape for draft ${draftId}.`);
    }
    // `teams` comes from `settings()`. Optional because a caller polling picks alone still
    // gets the lower bound; supplying it adds the upper one.
    return ok(parsePicks(parsed.data, teams));
  }

  private async json(url: string, what: string): Promise<ProviderResult<unknown>> {
    return sleeperJson(
      this.fetchText,
      url,
      `the draft ${what}`,
      // Sleeper answers an unknown id with a 200 carrying `null` rather than a 404.
      `Sleeper has no draft with that id.`,
    );
  }
}

/**
 * Fetch-and-parse shared by every Sleeper endpoint.
 *
 * `nullMeans` is the caller's reading of a bare `null` body, because the endpoints
 * disagree about what it signifies: on a draft it is Sleeper's spelling of "not found"
 * (200 with `null`, never a 404), on the players dump it would be an upstream fault. One
 * generic message would mislead whichever caller it was not written for.
 */
async function sleeperJson(
  fetchText: TextFetcher,
  url: string,
  what: string,
  nullMeans: string,
): Promise<ProviderResult<unknown>> {
  let raw: string;
  try {
    raw = await fetchText(url);
  } catch (cause) {
    return failed(`Could not reach Sleeper for ${what}.`, cause);
  }
  if (raw.trim() === "null") {
    return failed(nullMeans);
  }
  try {
    return ok(JSON.parse(raw));
  } catch (cause) {
    return failed(`Sleeper returned invalid JSON for ${what}.`, cause);
  }
}

export function parseSettings(payload: unknown): SleeperDraftSettings | null {
  if (typeof payload !== "object" || payload === null) return null;
  const root = payload as Record<string, unknown>;
  // `??` rather than `||` by preference, not by necessity: the two are equivalent here and
  // provably so. They differ only when `settings` is falsy but not nullish — 0, "" or
  // false — and for each of those, `??` keeps the primitive and every property read comes
  // back undefined, while `||` substitutes `{}` and every property read comes back
  // undefined. Both then fail the count checks below and return null. No input separates
  // them, which is why a mutation run leaves this one standing.
  const settings = (root.settings ?? {}) as Record<string, unknown>;

  const teams = toInt(settings.teams);
  const rounds = toInt(settings.rounds);
  // The null tests are what make the comparisons well-typed; they are not what rejects a
  // missing value. `null <= 0` is true — `null` coerces to zero — so either comparison
  // alone already refuses an unreadable field, and dropping a null test changes nothing.
  //
  // The upper bounds are the ones that matter for a payload from outside. `toInt` accepts
  // any integer-valued number, so `{"teams": 1e9, "rounds": 1e9}` is a well-formed response
  // and, carried through to `snakePicks` and `pickOwnership`, an allocation of 10^18
  // entries. Refused here as well as there, because this is the trust boundary.
  if (teams === null || rounds === null || teams <= 0 || rounds <= 0) return null;
  if (teams > MAX_LEAGUE_TEAMS || rounds > MAX_DRAFT_ROUNDS) return null;

  // `type` decides the pick order, which puts it in the same class as teams and rounds:
  // defaulting it produces a complete-looking board that attributes real players to the
  // wrong managers. A linear draft read as a snake misassigns every pick from round two.
  // `status` is genuinely cosmetic and is still defaulted.
  // Only the two formats this code models. An auction has no pick order at all, so every
  // pick number `snakePicks` produces for it is fiction — and read as a snake it would
  // render a complete, confident board attributing real players to seats that never
  // existed. Refusing a draft we cannot represent is the whole point of not defaulting
  // this field.
  const type = typeof root.type === "string" ? root.type.trim().toLowerCase() : "";
  if (type !== "snake" && type !== "linear") return null;

  return {
    teams,
    rounds,
    type,
    status: typeof root.status === "string" ? root.status : "unknown",
  };
}

export function parsePicks(
  payload: readonly unknown[],
  teams?: number,
): SleeperPick[] {
  const picks: SleeperPick[] = [];
  for (const item of payload) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    // `??` over `||` by the same proof as `parseSettings`: a falsy-but-present metadata
    // reads every property as undefined either way, so no input separates the two forms
    // and a mutation run leaves the `||` variant standing.
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;

    // Rejected below 1 for the same reason `draft_slot` is: an identity field that parses
    // but cannot be real places the pick at a position no draft has, and a pick at overall
    // 0 or -3 sorts ahead of the true first pick and shifts the board under it.
    const overall = toInt(row.pick_no);
    if (overall === null || overall < 1) continue;

    const first = typeof metadata.first_name === "string" ? metadata.first_name : "";
    const last = typeof metadata.last_name === "string" ? metadata.last_name : "";
    const name = `${first} ${last}`.trim();
    if (name === "") continue;

    // A pick whose seat is unknown cannot be attributed to a team, and defaulting it to
    // zero silently files it under a manager who did not make it — which is worse than
    // dropping it, because the roster it corrupts is then used to compute odds.
    // Bounded above as well as below, when the caller knows the league size. A seat of 14
    // in a twelve-team draft is not a seat; unbounded it persists and is treated as one,
    // which is the same "attributed to a manager who does not exist" failure the lower
    // bound exists for, from the other end.
    const draftSlot = toInt(row.draft_slot);
    if (draftSlot === null || draftSlot < 1) continue;
    if (teams !== undefined && draftSlot > teams) continue;

    picks.push({
      overall,
      // Zero is not a round. Defaulting to it invents a value that reads as real, in the
      // same way `draft_slot` and `pick_no` do, so it is null when the source does not say.
      round: positiveOrNull(toInt(row.round)),
      draftSlot,
      playerName: name,
      position:
        typeof metadata.position === "string" ? metadata.position.toUpperCase() : null,
      team: typeof metadata.team === "string" ? metadata.team.toUpperCase() : null,
      playerId: typeof row.player_id === "string" ? row.player_id : null,
    });
  }
  return picks.sort((a, b) => a.overall - b.overall);
}

/**
 * Sleeper's whole-league players dump.
 *
 * `GET /v1/players/nfl` — public, unauthenticated, one object keyed by Sleeper's player
 * id, ~14 MB. Verified by direct request on 2026-08-18 (HTTP 200, 12,221 entries); the
 * measured coverage is recorded in `docs/data-sources.md`.
 *
 * Why it exists here: the market-price feed covers only the players the market drafts,
 * and #88's audit showed what the board does with the rest — a player absent from that
 * feed carried a model-only price into round 2. This dump is the deeper *awareness*
 * signal for exactly those rows (#90.2): `search_rank` and the depth chart say whether
 * anyone outside our model has an opinion about a player at all.
 *
 * **`search_rank` is a search-relevance ordering, not an ADP, and must never be priced
 * as one.** It must not reach `fitAdpCurve` or any other pricing path; the honest uses
 * are a discipline gate and a provenance label, and no interface label may call it a
 * market price. `lib/nfl/draft/value.test.ts` enforces the pricing boundary.
 */
export interface SleeperPlayerRow {
  /** Sleeper's own player id — the dump's key, kept for de-duplication and audit. */
  sleeperId: string;
  name: string;
  /**
   * The player's *fantasy* position, folded to the codes the board uses.
   *
   * `fantasy_positions[0]` where present, because the roster position disagrees with the
   * fantasy one exactly where it matters: a fullback is `position: "FB"` but
   * `fantasy_positions: ["RB"]`, and reading the roster code dropped Kyle Juszczyk
   * (search rank 410) from a skill-position join. Measured 2026-08-18.
   */
  position: string;
  team: string | null;
  /**
   * Sleeper's search-relevance rank, or `null` where Sleeper itself declines one.
   *
   * The dump marks a player outside its search relevance with the sentinel 9,999,999
   * rather than omitting the field (measured: 2,195 of 4,039 skill rows carry it).
   * Parsed to `null` because the sentinel is not a rank — carried as a number it would
   * sort as "the 9,999,999th most relevant player", which reads as information and is
   * the absence of it.
   */
  searchRank: number | null;
  /** Depth-chart slot code as published — `RB`, `SWR`, `TE` — not our position set. */
  depthChartPosition: string | null;
  /** 1-based depth-chart rank at that slot: 2 means the listed backup. */
  depthChartOrder: number | null;
}

/** The sentinel Sleeper publishes for "outside search relevance". Measured 2026-08-18. */
const UNRANKED_SEARCH_RANK = 9_999_999;

export class SleeperPlayersProvider {
  constructor(private readonly fetchText: TextFetcher = httpTextFetcher) {}

  async players(): Promise<ProviderResult<SleeperPlayerRow[]>> {
    const parsed = await sleeperJson(
      this.fetchText,
      playersUrl(),
      "the players dump",
      `Sleeper returned an empty players dump.`,
    );
    if (!parsed.ok) return parsed;
    // A mutation run reports both `||`s as survivors under `&&`, and both are genuine
    // equivalences rather than gaps: `typeof null` is "object", so the null test can
    // only fire where the typeof test does not — and a bare-`null` body never reaches
    // this line anyway, refused one layer down as the sentinel body.
    if (typeof parsed.data !== "object" || parsed.data === null || Array.isArray(parsed.data)) {
      return failed(`Sleeper returned an unexpected shape for the players dump.`);
    }
    return ok(parsePlayersDump(parsed.data as Record<string, unknown>));
  }
}

export function parsePlayersDump(
  payload: Readonly<Record<string, unknown>>,
): SleeperPlayerRow[] {
  const rows: SleeperPlayerRow[] = [];
  for (const [sleeperId, item] of Object.entries(payload)) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;

    // A row without a usable name cannot be joined to anything, so it is skipped rather
    // than guessed at — the same rule `parsePicks` applies, for the same reason.
    const full = typeof row.full_name === "string" ? row.full_name.trim() : "";
    const first = typeof row.first_name === "string" ? row.first_name : "";
    const last = typeof row.last_name === "string" ? row.last_name : "";
    const name = full !== "" ? full : `${first} ${last}`.trim();
    if (name === "") continue;

    // The fantasy position where the dump publishes one — see `SleeperPlayerRow.position`
    // for the fullback case this decides — the roster position otherwise.
    const fantasy = Array.isArray(row.fantasy_positions)
      ? row.fantasy_positions.find((p): p is string => typeof p === "string" && p.trim() !== "")
      : undefined;
    const roster = typeof row.position === "string" ? row.position.trim() : "";
    // `??`, though `||` cannot disagree: `fantasy` is either undefined or a string the
    // predicate above proved non-blank, so there is no falsy-but-present value for the
    // two operators to split on — a mutation run reports the `||` form as a survivor.
    const position = (fantasy ?? roster).trim().toUpperCase();
    if (position === "") continue;

    // The sentinel is a refusal to rank, not a rank; so are zero and negatives, which no
    // 1-based relevance ordering produces.
    const rank = toInt(row.search_rank);
    const searchRank =
      rank === null || rank < 1 || rank >= UNRANKED_SEARCH_RANK ? null : rank;

    const depthChartPosition =
      typeof row.depth_chart_position === "string" && row.depth_chart_position.trim() !== ""
        ? row.depth_chart_position.trim().toUpperCase()
        : null;

    rows.push({
      sleeperId,
      name,
      position,
      team: normalizeTeam(typeof row.team === "string" ? row.team : null),
      searchRank,
      depthChartPosition,
      depthChartOrder: positiveOrNull(toInt(row.depth_chart_order)),
    });
  }
  return rows;
}

/** A 1-based count, or `null` for the zeroes and negatives that are not one. */
function positiveOrNull(value: number | null): number | null {
  return value === null || value < 1 ? null : value;
}

/**
 * A whole number, or `null`.
 *
 * Rejects a fractional value rather than truncating it. Every caller here is reading an
 * identity field — a seat, a pick number, a team count — and 10.5 teams is not a league
 * that got rounded, it is a payload this code does not understand. Truncating turned that
 * into a plausible 10 and hid it from the guards downstream, which are the whole reason
 * these fields are parsed separately in the first place.
 */
function toInt(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(parsed) ? parsed : null;
}
