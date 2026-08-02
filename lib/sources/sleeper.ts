import { type ProviderResult, failed, ok } from "../core/providers";
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

export interface SleeperDraftSettings {
  teams: number;
  rounds: number;
  /** `snake`, `linear`, or `auction`. Only snake and linear are modelled. */
  type: string;
  status: string;
}

export interface SleeperPick {
  /** Overall pick number, 1-based. */
  overall: number;
  round: number;
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
  async picks(draftId: string): Promise<ProviderResult<SleeperPick[]>> {
    const parsed = await this.json(draftPicksUrl(draftId), "picks");
    if (!parsed.ok) return parsed;
    if (!Array.isArray(parsed.data)) {
      return failed(`Sleeper returned an unexpected shape for draft ${draftId}.`);
    }
    return ok(parsePicks(parsed.data));
  }

  private async json(url: string, what: string): Promise<ProviderResult<unknown>> {
    let raw: string;
    try {
      raw = await this.fetchText(url);
    } catch (cause) {
      return failed(`Could not reach Sleeper for the draft ${what}.`, cause);
    }
    // Sleeper answers an unknown id with a 200 carrying `null` rather than a 404.
    if (raw.trim() === "null") {
      return failed(`Sleeper has no draft with that id.`);
    }
    try {
      return ok(JSON.parse(raw));
    } catch (cause) {
      return failed(`Sleeper returned invalid JSON for the draft ${what}.`, cause);
    }
  }
}

export function parseSettings(payload: unknown): SleeperDraftSettings | null {
  if (typeof payload !== "object" || payload === null) return null;
  const root = payload as Record<string, unknown>;
  const settings = (root.settings ?? {}) as Record<string, unknown>;

  const teams = toInt(settings.teams);
  const rounds = toInt(settings.rounds);
  if (teams === null || rounds === null || teams <= 0 || rounds <= 0) return null;

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

export function parsePicks(payload: readonly unknown[]): SleeperPick[] {
  const picks: SleeperPick[] = [];
  for (const item of payload) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
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
    const draftSlot = toInt(row.draft_slot);
    if (draftSlot === null || draftSlot < 1) continue;

    picks.push({
      overall,
      round: toInt(row.round) ?? 0,
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

function toInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }
  return null;
}
