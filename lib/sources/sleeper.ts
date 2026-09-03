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

/**
 * Draft-room controls Sleeper includes on ordinary snake drafts.
 *
 * These affect the provider UI or clock, not the league shape, scoring, player pool, or
 * ownership model this adapter imports. They still remain in `extraSettings` for support
 * evidence; they simply are not custom league rules that should block every live draft.
 */
const DRAFT_ROOM_SETTINGS = new Set([
  "alpha_sort",
  "autopause_enabled",
  "autopause_end_time",
  "autopause_start_time",
  "autostart",
  "cpu_autopick",
  "enforce_position_limits",
  "nomination_timer",
]);

/** Zero is the only variant represented by the local all-player, ordinary snake board. */
const ZERO_ONLY_DRAFT_SETTINGS = new Set(["player_type", "reversal_round"]);

export function draftUrl(draftId: string, freshnessToken?: string): string {
  const url = `${BASE}/draft/${encodeURIComponent(draftId)}`;
  return freshnessToken === undefined
    ? url
    : `${url}?fantasy_gto_poll=${encodeURIComponent(freshnessToken)}`;
}

export function draftPicksUrl(draftId: string, freshnessToken?: string): string {
  const url = `${BASE}/draft/${encodeURIComponent(draftId)}/picks`;
  return freshnessToken === undefined
    ? url
    : `${url}?fantasy_gto_poll=${encodeURIComponent(freshnessToken)}`;
}

export function playersUrl(): string {
  return `${BASE}/players/nfl`;
}

export interface SleeperDraftSettings {
  /** Sleeper's stable draft identifier. Never infer it from a pasted URL. */
  draftId: string | null;
  /** The league this draft belongs to, when Sleeper exposes it. */
  leagueId: string | null;
  teams: number;
  rounds: number;
  /** Provider draft format. The setup importer currently accepts snake only. */
  type: string;
  status: string;
  /** Sleeper user id to one-based draft seat. Retained even when no local user is known. */
  draftOrder: Readonly<Record<string, number>>;
  /** Raw Sleeper roster-slot counts, including bench and unsupported slots. */
  rosterSlots: Readonly<Record<string, number>>;
  /** Seconds on the provider clock, or null when Sleeper does not supply one. */
  pickTimerSeconds: number | null;
  /** Sleeper's scoring identity and the metadata that carried it. */
  scoring: { identity: string | null; metadata: Readonly<Record<string, unknown>> };
  /** Provider fields this adapter does not interpret, retained for an explicit import warning. */
  unsupported: readonly string[];
  /** Uninterpreted root settings, never converted into a local preset. */
  extraSettings: Readonly<Record<string, unknown>>;
}

export interface SleeperPick {
  /** Stable provider event key. Repairs attach to this exact value. */
  pickKey: string;
  /** Overall pick number, 1-based, or null when Sleeper supplied an unusable value. */
  overall: number | null;
  /** Round number, 1-based, or `null` when the source did not give a usable one. */
  round: number | null;
  /** Draft slot, 1-based, which is the manager's seat rather than their roster id. */
  draftSlot: number | null;
  playerName: string;
  position: string | null;
  team: string | null;
  /** Sleeper's own player id, kept so a pick can be de-duplicated across polls. */
  playerId: string | null;
  /** Keeper state is source history, not local pick-cost semantics. */
  isKeeper: boolean | null;
  /** Source metadata remains visible for an unresolved pick and is never discarded. */
  metadata: Readonly<Record<string, unknown>>;
  /** Provider fields not used by the local snake board. */
  providerFields: Readonly<Record<string, unknown>>;
}

export class SleeperDraftProvider {
  constructor(private readonly fetchText: TextFetcher = httpTextFetcher) {}

  async settings(
    draftId: string,
    freshnessToken?: string,
  ): Promise<ProviderResult<SleeperDraftSettings>> {
    const parsed = await this.json(draftUrl(draftId, freshnessToken), "draft");
    if (!parsed.ok) return draftFailure(draftId, "settings", parsed);

    const settings = parseSettings(parsed.data);
    if (settings === null) {
      return failed(
        `Sleeper settings sync for draft ${draftId} could not read a supported response. Check the draft ID and retry.`,
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
  async picks(
    draftId: string,
    teams?: number,
    freshnessToken?: string,
  ): Promise<ProviderResult<SleeperPick[]>> {
    const parsed = await this.json(draftPicksUrl(draftId, freshnessToken), "picks");
    if (!parsed.ok) return draftFailure(draftId, "picks", parsed);
    if (!Array.isArray(parsed.data)) {
      return failed(
        `Sleeper picks sync for draft ${draftId} received an unexpected response. You can retry.`,
      );
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

function draftFailure<T>(
  draftId: string,
  operation: "settings" | "picks",
  result: Extract<ProviderResult<T>, { ok: false }>,
): ProviderResult<T> {
  return failed(
    `Sleeper ${operation} sync for draft ${draftId} could not finish. ${result.reason} You can retry.`,
    result.cause,
  );
}

/** Poll delays are intentionally bounded so an outage stays visible and retryable. */
export const SLEEPER_POLLING = {
  activeIntervalMs: 4_000,
  initialRetryMs: 2_000,
  maxRetryMs: 30_000,
} as const;

/** Bounded exponential retry delay; exported so the UI can state the actual contract. */
export function sleeperRetryDelay(failures: number): number {
  const exponent = Math.max(0, Math.min(failures - 1, 4));
  return Math.min(
    SLEEPER_POLLING.initialRetryMs * 2 ** exponent,
    SLEEPER_POLLING.maxRetryMs,
  );
}

export interface SleeperPollUpdate {
  settings: SleeperDraftSettings;
  picks: readonly SleeperPick[];
}

export interface SleeperPollHandle {
  cancel(): void;
}

/**
 * Browser-side polling for a public Sleeper draft.
 *
 * Reconciliation remains outside this adapter. `onUpdate` returns true only for a clean,
 * reconciled completion; that makes provider I/O stop without treating an unresolved
 * complete draft as clean. Cancellation suppresses both pending callbacks and future polls.
 */
export class SleeperDraftPoller {
  constructor(
    private readonly provider: Pick<SleeperDraftProvider, "settings" | "picks"> =
      new SleeperDraftProvider(),
  ) {}

  start({
    draftId,
    onUpdate,
    onError,
    signal,
  }: {
    draftId: string;
    onUpdate: (update: SleeperPollUpdate) => boolean | void;
    onError: (reason: string, retryInMs: number) => void;
    signal?: AbortSignal;
  }): SleeperPollHandle {
    let cancelled = false;
    let failures = 0;
    let requestSequence = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cancel = () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const schedule = (delay: number) => {
      if (!cancelled) timer = setTimeout(poll, delay);
    };
    const fail = (reason: string) => {
      if (cancelled) return;
        failures += 1;
        const retryInMs = sleeperRetryDelay(failures);
        try {
          onError(reason, retryInMs);
        } catch {
          // An observer must not turn a retryable provider failure into an unhandled poll.
        } finally {
          schedule(retryInMs);
        }
    };
    const poll = async () => {
      try {
        // Sleeper's REST edge can continue serving an earlier whole-draft response while
        // its websocket-powered draft room is already many picks ahead. A distinct token
        // per poll makes the URL a fresh cache key; sharing it between settings and picks
        // keeps the two reads part of the same polling attempt.
        const freshnessToken = `${Date.now()}-${requestSequence}`;
        requestSequence += 1;
        const settings = await this.provider.settings(draftId, freshnessToken);
        if (cancelled) return;
        if (!settings.ok) {
          fail(settings.reason);
          return;
        }
        const picks = await this.provider.picks(
          draftId,
          settings.data.teams,
          freshnessToken,
        );
        if (cancelled) return;
        if (!picks.ok) {
          fail(picks.reason);
          return;
        }
        failures = 0;
        if (onUpdate({ settings: settings.data, picks: picks.data }) === true) {
          cancel();
          return;
        }
        schedule(SLEEPER_POLLING.activeIntervalMs);
      } catch (cause) {
        const detail = cause instanceof Error && cause.message !== "" ? ` ${cause.message}` : "";
        fail(`Sleeper sync for draft ${draftId} hit an unexpected error.${detail} You can retry.`);
      }
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    else void poll();
    return { cancel };
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
  const settings = record(root.settings);

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
  // Retain unsupported formats for an explicit import warning. Refusing them here would
  // erase the reason the draft cannot safely be represented by the local snake board.
  if (type === "") return null;

  const metadata = record(root.metadata);
  const rosterSlots: Record<string, number> = {};
  const extraSettings: Record<string, unknown> = {};
  const unsupported: string[] = [];
  for (const [key, value] of Object.entries(settings)) {
    if (key.startsWith("slots_")) {
      const count = toInt(value);
      if (count === null || count < 0) unsupported.push(`settings.${key}`);
      else rosterSlots[key] = count;
      continue;
    }
    if (key === "teams" || key === "rounds" || key === "pick_timer") continue;
    extraSettings[key] = value;
    if (DRAFT_ROOM_SETTINGS.has(key)) continue;
    if (ZERO_ONLY_DRAFT_SETTINGS.has(key) && toInt(value) === 0) continue;
    unsupported.push(`settings.${key}`);
  }
  return {
    draftId: textOrNull(root.draft_id),
    leagueId: textOrNull(root.league_id),
    teams,
    rounds,
    type,
    status: typeof root.status === "string" ? root.status : "unknown",
    draftOrder: parseDraftOrder(root.draft_order),
    rosterSlots,
    pickTimerSeconds: positiveOrNull(toInt(settings.pick_timer)),
    scoring: {
      identity: textOrNull(metadata.scoring_type),
      metadata,
    },
    unsupported: [...new Set(unsupported)].sort(),
    extraSettings,
  };
}

export function parsePicks(payload: readonly unknown[], teams?: number): SleeperPick[] {
  const picks: SleeperPick[] = [];
  for (const item of payload) {
    const row = record(item);
    // `??` over `||` by the same proof as `parseSettings`: a falsy-but-present metadata
    // reads every property as undefined either way, so no input separates the two forms
    // and a mutation run leaves the `||` variant standing.
    const metadata = record(row.metadata);

    // Rejected below 1 for the same reason `draft_slot` is: an identity field that parses
    // but cannot be real places the pick at a position no draft has, and a pick at overall
    // 0 or -3 sorts ahead of the true first pick and shifts the board under it.
    const sourceOverall = positiveOrNull(toInt(row.pick_no));

    const first = typeof metadata.first_name === "string" ? metadata.first_name : "";
    const last = typeof metadata.last_name === "string" ? metadata.last_name : "";
    const name = `${first} ${last}`.trim();

    // A pick whose seat is unknown cannot be attributed to a team, and defaulting it to
    // zero silently files it under a manager who did not make it — which is worse than
    // dropping it, because the roster it corrupts is then used to compute odds.
    // Bounded above as well as below, when the caller knows the league size. A seat of 14
    // in a twelve-team draft is not a seat; unbounded it persists and is treated as one,
    // which is the same "attributed to a manager who does not exist" failure the lower
    // bound exists for, from the other end.
    const sourceSlot = positiveOrNull(toInt(row.draft_slot));
    const draftSlot =
      sourceSlot !== null && (teams === undefined || sourceSlot <= teams)
        ? sourceSlot
        : null;
    const playerId = textOrNull(row.player_id);
    const draftId = textOrNull(row.draft_id) ?? "unknown-draft";
    // `pick_no` is Sleeper's stable event number. Do not use the response-array index as
    // a fallback: whole-list polls may arrive in a different order, and an index-derived
    // key would turn the same provider event into a conflicting new event on the next poll.
    // When Sleeper has omitted it, retain the row under a deterministic fingerprint of the
    // source facts we did receive.
    const pickKey = stablePickKey({
      draftId,
      overall: sourceOverall,
      round: positiveOrNull(toInt(row.round)),
      draftSlot: sourceSlot,
      playerId,
      metadata,
      row,
    });
    const providerFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (!["draft_id", "draft_slot", "is_keeper", "metadata", "pick_no", "player_id", "round"].includes(key)) {
        providerFields[key] = value;
      }
    }

    picks.push({
      pickKey,
      overall: sourceOverall,
      // Zero is not a round. Defaulting to it invents a value that reads as real, in the
      // same way `draft_slot` and `pick_no` do, so it is null when the source does not say.
      round: positiveOrNull(toInt(row.round)),
      draftSlot,
      playerName: name,
      position:
        typeof metadata.position === "string" ? metadata.position.toUpperCase() : null,
      team: typeof metadata.team === "string" ? metadata.team.toUpperCase() : null,
      playerId,
      isKeeper: typeof row.is_keeper === "boolean" ? row.is_keeper : null,
      metadata,
      providerFields,
    });
  }
  // A response order is not draft order. Invalid records remain after valid ones instead
  // of disappearing; reconciliation will surface them as a repairable provider fault.
  const sorted = picks.sort(
    (a, b) =>
      (a.overall ?? Number.MAX_SAFE_INTEGER) - (b.overall ?? Number.MAX_SAFE_INTEGER) ||
      a.pickKey.localeCompare(b.pickKey) ||
      pickContentFingerprint(a).localeCompare(pickContentFingerprint(b)),
  );
  // Exact duplicate records are not useful accepted picks, but they are still provider
  // facts. Give each one a deterministic occurrence key so reconciliation can surface the
  // duplicate instead of silently collapsing it into a repeated poll.
  const occurrences = new Map<string, number>();
  return sorted.map((pick) => {
    const occurrence = (occurrences.get(pick.pickKey) ?? 0) + 1;
    occurrences.set(pick.pickKey, occurrence);
    return occurrence === 1 ? pick : { ...pick, pickKey: `${pick.pickKey}#duplicate-${occurrence}` };
  });
}

function pickContentFingerprint(pick: SleeperPick): string {
  return stableValue({
    round: pick.round,
    draftSlot: pick.draftSlot,
    playerName: pick.playerName,
    position: pick.position,
    team: pick.team,
    playerId: pick.playerId,
    isKeeper: pick.isKeeper,
    metadata: pick.metadata,
    providerFields: pick.providerFields,
  });
}

function stablePickKey(input: {
  draftId: string;
  overall: number | null;
  round: number | null;
  draftSlot: number | null;
  playerId: string | null;
  metadata: Readonly<Record<string, unknown>>;
  row: Readonly<Record<string, unknown>>;
}): string {
  if (input.overall !== null) return `${input.draftId}:pick-${input.overall}`;
  return `${input.draftId}:row-${stableValue({
    round: input.round,
    draftSlot: input.draftSlot,
    playerId: input.playerId,
    metadata: input.metadata,
    row: input.row,
  })}`;
}

/** A canonical serializer for an opaque provider row; it deliberately has no clock or RNG. */
function stableValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableValue(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
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
 * market price. `lib/nfl/draft/market-awareness.test.ts` enforces that boundary, by
 * walking every deployable file that calls the curve fit and asserting none of them can
 * see a search rank.
 */
export interface SleeperPlayerRow {
  /** Sleeper's own player id — the dump's key, kept for de-duplication and audit. */
  sleeperId: string;
  /** Sleeper's `years_exp`; zero is its explicit rookie marker. */
  rookie: boolean;
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
   * rather than omitting the field (measured 2026-08-18 through this parser: 2,373 of
   * 4,144 skill rows carry no usable rank; `pnpm verify-sources` re-measures it).
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
      rookie: toInt(row.years_exp) === 0,
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

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function parseDraftOrder(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [userId, slot] of Object.entries(record(value))) {
    const parsed = positiveOrNull(toInt(slot));
    if (parsed !== null) out[userId] = parsed;
  }
  return out;
}
