import { normalizeMarketPosition } from "./config";
import { aliasNameKeys, normalizeWords } from "./match";

/**
 * Joining the board's market-absent rows onto a deeper awareness source.
 *
 * The market-price feed covers only the players the market drafts — 185 skill rows on the
 * day this was measured — and #88's audit showed what the board does with everyone else:
 * a player absent from that feed carried a model-only price into round 2. Sleeper's
 * players dump (#90.2) knows about far more players than the price feed does, and for
 * each one it publishes a search-relevance rank and a depth-chart slot. Those two fields
 * are the *awareness* signal this module attaches: does anybody outside our own model
 * have an opinion about this player at all, and roughly what kind.
 *
 * **A signal, never a price.** `searchRank` is a search-relevance ordering — rank 86 does
 * not mean pick 86 — so nothing here may flow into `fitAdpCurve` or any other pricing
 * path, and no interface label may present it as a market price. The board's own `adp`
 * stays the one market price there is; this join only annotates the rows where that price
 * is `null`, which is also why rows the market has priced are skipped outright — the
 * dump must not second-guess a published price.
 *
 * ## The join, and why it refuses to guess
 *
 * Names are matched through `aliasNameKeys`, position-qualified — the frozen board and
 * the dump disagree on first names eight measured ways ("Kenneth"/"Kenny" Gainwell being
 * the one that led pick 2.06). A row the alias keys cannot resolve gets one fallback:
 * team plus position plus normalized last name, which rescues exactly the
 * nickname-spelled rows the alias table was measured from. A key more than one dump row
 * answers to is surfaced in `ambiguities` and matched to nobody — a player with someone
 * else's rank is worse than a player with none, the same asymmetry `buildMarketIndex`
 * documents. Everything still unmatched is listed in `unmatched` rather than dropped,
 * so a coverage claim can be measured instead of assumed.
 */

/** What the awareness source publishes about one player. Shaped by `SleeperPlayerRow`. */
export interface AwarenessSourceRow {
  name: string;
  position: string;
  team: string | null;
  searchRank: number | null;
  depthChartPosition: string | null;
  depthChartOrder: number | null;
}

/** The board row fields the join reads. Satisfied by `MockBoardRow` and the ingest rows. */
export interface AwarenessBoardRow {
  playerId: string;
  name: string;
  position: string;
  team: string | null;
  adp: number | null;
}

/** The awareness signal attached to one market-absent board row. */
export interface MarketAwareness {
  searchRank: number | null;
  depthChartPosition: string | null;
  depthChartOrder: number | null;
  /** The source's own spelling, kept so any join can be audited by eye. */
  sourceName: string;
}

export interface AwarenessJoin {
  /** One entry per market-absent board row the source unambiguously answers for. */
  byPlayerId: Map<string, MarketAwareness>;
  /** Board rows whose keys more than one source row answered to — refused, not guessed. */
  ambiguities: string[];
  /** Market-absent board rows the source does not answer for at all. */
  unmatched: string[];
}

/** `null` marks a key claimed by more than one row — a refusal, not an absence. */
type Claim = AwarenessSourceRow | null;

function claim(index: Map<string, Claim>, key: string, row: AwarenessSourceRow): void {
  index.set(key, index.has(key) ? null : row);
}

/** The last normalized word of a name, or `""` for a name with none. */
function lastNameKey(raw: string): string {
  const words = normalizeWords(raw);
  return words.length === 0 ? "" : words[words.length - 1];
}

export function joinMarketAwareness(
  board: readonly AwarenessBoardRow[],
  source: readonly AwarenessSourceRow[],
): AwarenessJoin {
  // Indexed under every alias key, so the lookup below can stay single-key: the board's
  // "Kenneth Gainwell" finds the dump's "Kenny Gainwell" because the dump row was filed
  // under both spellings. Expanding both sides instead would let two different aliases
  // meet in the middle, which widens the match beyond anything that was measured.
  const byNameAndPosition = new Map<string, Claim>();
  const byTeamAndLastName = new Map<string, Claim>();
  for (const row of source) {
    const position = normalizeMarketPosition(row.position);
    for (const key of aliasNameKeys(row.name)) {
      claim(byNameAndPosition, `${key}|${position}`, row);
    }
    if (row.team !== null) {
      const last = lastNameKey(row.name);
      if (last !== "") {
        claim(byTeamAndLastName, `${row.team}|${position}|${last}`, row);
      }
    }
  }

  const byPlayerId = new Map<string, MarketAwareness>();
  const ambiguities: string[] = [];
  const unmatched: string[] = [];

  for (const row of board) {
    // The rows the market has priced keep their price; the signal exists for the rest.
    if (row.adp !== null) continue;

    let found: Claim | undefined;
    for (const key of aliasNameKeys(row.name)) {
      const hit = byNameAndPosition.get(`${key}|${row.position}`);
      if (hit !== undefined) {
        found = hit;
        break;
      }
    }
    if (found === undefined && row.team !== null) {
      const last = lastNameKey(row.name);
      if (last !== "") {
        found = byTeamAndLastName.get(`${row.team}|${row.position}|${last}`);
      }
    }

    if (found === undefined) {
      unmatched.push(row.name);
    } else if (found === null) {
      ambiguities.push(row.name);
    } else {
      byPlayerId.set(row.playerId, {
        searchRank: found.searchRank,
        depthChartPosition: found.depthChartPosition,
        depthChartOrder: found.depthChartOrder,
        sourceName: found.name,
      });
    }
  }

  return { byPlayerId, ambiguities, unmatched };
}
