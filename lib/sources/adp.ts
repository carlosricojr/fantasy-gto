import { type ProviderResult, failed, ok } from "../core/providers";
import { type TextFetcher, httpTextFetcher } from "./nflverse";
import { normalizeTeam } from "../nfl/teams";

/**
 * Average draft position.
 *
 * ADP is the market's aggregate opinion about when a player will be taken. It is the one
 * input a draft tool cannot derive for itself: no amount of box-score modeling tells you
 * that a rookie is being drafted in the second round because of training-camp reports.
 *
 * Source is Fantasy Football Calculator, whose ADP endpoint is public, unauthenticated,
 * and returns a standard deviation alongside each mean — which matters more than it
 * sounds. Without dispersion, ADP reads as a deadline and a draft strategy built on it
 * reaches for players who would have lasted another full round.
 *
 * Verified by direct request; see `docs/data-sources.md`.
 */

const BASE = "https://fantasyfootballcalculator.com/api/v1/adp";

/** Scoring formats the endpoint serves, mapped to our own ruleset ids. */
const FORMAT_BY_SCORING: Readonly<Record<string, string>> = {
  ppr: "ppr",
  half_ppr: "half-ppr",
  standard: "standard",
};

export interface AdpEntry {
  name: string;
  position: string;
  team: string | null;
  /** Mean overall pick. */
  adp: number;
  /** Standard deviation of that pick, in picks. */
  stdev: number;
  /** How many drafts the mean was taken from, so a thin sample is visible. */
  timesDrafted: number | null;
  /**
   * The week the player's team is idle.
   *
   * Carried because a bye is a hard constraint on a roster, not a detail: two starters
   * sharing one means a week fielding nobody in that slot. The endpoint publishes it, so
   * there is no reason to derive it from the schedule separately.
   */
  bye: number | null;
}

/** The upstream format for a scoring id, or `null` if there is no mapping for it. */
export function adpFormatFor(scoringId: string): string | null {
  // Own-property, not a plain index. `scoringId` comes from stored or user-supplied state,
  // and a key like `constructor` or `toString` resolves through the prototype to something
  // truthy — which would sail past the null check below and be interpolated into the URL.
  return Object.hasOwn(FORMAT_BY_SCORING, scoringId)
    ? FORMAT_BY_SCORING[scoringId]
    : null;
}

/**
 * Throws on an unmapped scoring id rather than substituting PPR.
 *
 * The fallback was silent and the board it produced looked entirely normal: a half-PPR or
 * standard league would have been priced off a PPR market, which reorders receivers
 * against backs throughout. Every caller already handles a failed provider result, and a
 * missing board is visible in a way a wrong one is not.
 */
export function adpUrl(scoringId: string, teams: number, season: number): string {
  const format = adpFormatFor(scoringId);
  if (format === null) {
    throw new Error(
      `No average-draft-position board is published for scoring "${scoringId}". ` +
        `Serving another format's board would price the league under the wrong rules.`,
    );
  }
  return `${BASE}/${format}?teams=${teams}&year=${season}`;
}

export class AdpProvider {
  constructor(private readonly fetchText: TextFetcher = httpTextFetcher) {}

  /**
   * ADP for a season and league size.
   *
   * League size is not cosmetic: the same player has a different overall ADP in an
   * eight-team league than a fourteen-team one, because a round is a different number of
   * picks. Passing the wrong one silently shifts every survival probability.
   */
  /**
   * One answer per board, for the lifetime of the provider.
   *
   * The board-refresh action builds every combination of three scoring formats and eleven
   * league sizes, and each build asks for the target season plus two prior ones — ninety-nine
   * requests for thirty-six distinct answers, to somebody else's server, inside one action.
   * Seven of the eleven sizes share a board with a neighbour, which makes the duplication
   * worse rather than better.
   *
   * `NflverseProvider` already caches for the same reason and this mirrors it, including the
   * two things that are easy to get wrong: the in-flight promise is shared, so two concurrent
   * callers make one request rather than two; and **only successes are cached**, because a
   * failure is usually transient and one provider serves a whole run — caching it would turn
   * a single bad fetch into every later call for that board failing for the lifetime of the
   * action.
   */
  private readonly cache = new Map<string, ProviderResult<AdpEntry[]>>();
  private readonly inFlight = new Map<string, Promise<ProviderResult<AdpEntry[]>>>();

  async forSeason(
    season: number,
    scoringId: string,
    teams: number,
  ): Promise<ProviderResult<AdpEntry[]>> {
    // Serialized rather than joined, so no combination of a scoring id containing a
    // separator could make two different boards share one entry.
    const key = JSON.stringify([season, scoringId, teams]);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    let pending = this.inFlight.get(key);
    if (pending === undefined) {
      pending = this.fetchSeason(season, scoringId, teams).finally(() => {
        this.inFlight.delete(key);
      });
      this.inFlight.set(key, pending);
    }
    const result = await pending;
    if (result.ok) this.cache.set(key, result);
    return result;
  }

  private async fetchSeason(
    season: number,
    scoringId: string,
    teams: number,
  ): Promise<ProviderResult<AdpEntry[]>> {
    if (adpFormatFor(scoringId) === null) {
      return failed(
        `No average-draft-position board is published for scoring "${scoringId}".`,
      );
    }
    const url = adpUrl(scoringId, teams, season);
    let raw: string;
    try {
      raw = await this.fetchText(url);
    } catch (cause) {
      return failed(`Could not load average draft position for ${season}.`, cause);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      return failed(`Average draft position for ${season} was not valid JSON.`, cause);
    }

    const entries = parseAdp(parsed);
    if (entries === null) {
      // The endpoint answers 200 with `{"status":"Error"}` for a season it has no data
      // for, rather than a 404. Treating that as success would produce a board where
      // every player is unranked and every survival probability is one.
      return failed(
        `No average draft position published for ${season}. It is usually available a ` +
          `few months before the season starts.`,
      );
    }
    if (entries.length === 0) {
      return failed(`Average draft position for ${season} was empty.`);
    }

    return ok(entries);
  }
}

/** Pure parse, exported so it is tested against captured payloads rather than the network. */
export function parseAdp(payload: unknown): AdpEntry[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const root = payload as Record<string, unknown>;
  if (typeof root.status === "string" && root.status.toLowerCase() !== "success") {
    return null;
  }
  if (!Array.isArray(root.players)) return null;

  const entries: AdpEntry[] = [];
  for (const item of root.players) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const adp = toNumber(row.adp);
    if (name === "" || adp === null || adp <= 0) continue;

    entries.push({
      name,
      // Trimmed like `name` and `team`. A published " RB" is not mapped by
      // `normalizeMarketPosition`, so it becomes the key `name|" RB"` and the
      // position-qualified lookup in `buildMarketIndex` misses the player entirely.
      position: typeof row.position === "string" ? row.position.trim().toUpperCase() : "",
      // Through the same normalizer the roster uses. Left raw, an alias spelling — LAR,
      // OAK, STL, WFT — is a different key from the roster's canonical one, so the two
      // sources stop agreeing about which team a player is on.
      team:
        typeof row.team === "string" && row.team.trim() !== ""
          ? normalizeTeam(row.team.trim())
          : null,
      adp,
      // Kept as published, including a zero. The survival model owns the decision about
      // what a missing spread means, and defaulting it here would hide which players had
      // no dispersion at all — see `DEFAULT_ADP_STDEV`.
      stdev: toNumber(row.stdev) ?? 0,
      timesDrafted: toNumber(row.times_drafted),
      // Unlike `stdev`, a published zero here is not data — weeks are numbered from one,
      // so a bye of 0 means "not stated", and carrying it through invents a week that
      // does not exist. The season simulation happens to be immune (it compares against
      // 1-based week numbers, which never equal zero), but the board is not: it prints
      // "bye 0" next to the player, and the bye-collision summary skips only `null`, so
      // every player the source left blank gets grouped into a phantom week-0 clash.
      bye: positiveOrNull(toNumber(row.bye)),
    });
  }
  return entries;
}

/** A week number, or `null` for the zeroes and negatives that mean "not stated". */
function positiveOrNull(value: number | null): number | null {
  return value === null || value <= 0 ? null : value;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
