/**
 * Matching noisy text to a known player.
 *
 * This exists so that reading a draft board off the screen is tractable. General OCR of
 * an arbitrary interface is unreliable, and a tool that silently misread a pick would
 * quietly corrupt every recommendation after it. But the problem is not general: at any
 * moment there are a few hundred draftable players, and the question is only which of
 * *those* appears in the text. A constrained vocabulary turns a hard transcription
 * problem into a tolerable nearest-neighbour one — "Ja'Marr Chsse" has exactly one
 * plausible answer.
 *
 * Everything here is pure and works on any string, so the same matcher backs manual
 * search, paste-a-draft-board, and screen capture. Confidence is always returned and
 * never discarded: the caller is expected to show it, because a match this code is unsure
 * of is exactly the one a human should confirm.
 */

/** Name suffixes that carry no identity and are dropped before comparison. */
const DROPPED_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

/**
 * Reduces a name to its comparable core.
 *
 * Punctuation and case are noise — `A.J. Brown`, `AJ Brown`, and `aj brown` are one
 * player, and OCR will produce all three. Generational suffixes are dropped because
 * sources disagree about them constantly.
 */
export function normalizeName(raw: string): string {
  const words = raw
    .toLowerCase()
    // Accents are folded, not stripped. Decomposing first turns "é" into "e" plus a
    // combining mark, so removing the marks leaves the letter — where the punctuation
    // filter below would otherwise delete the whole character. One source spelling
    // "José" and another "Jose" produced two different keys for one player, and
    // `buildMarketIndex` then reported his market price as missing.
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !DROPPED_SUFFIXES.has(w));
  return words.join("");
}

/** The two fields any market row must carry to be joinable to a roster row. */
export interface MarketRow {
  name: string;
  position: string;
}

/**
 * A market board indexed for joining onto a roster, with collisions refused.
 *
 * The naive version of this is `new Map(entries.map(e => [normalizeName(e.name), e]))`,
 * which is wrong in a way that never announces itself: `Map` takes the last write, so when
 * two players normalise to the same name one of them silently inherits the other's ADP,
 * dispersion, and bye week. Dropping generational suffixes makes that more likely, not
 * less — it is exactly what collapses a father-and-son or same-name pair into one key.
 *
 * So the lookup is position-qualified first, and falls back to name-only *only* when the
 * name is unique across the whole board. The fallback matters because the sources
 * genuinely disagree about position — a player the market lists at RB can be a WR on the
 * roster file — and without it every such player would lose his market price.
 *
 * When neither key resolves to exactly one row, the answer is `null`. A player with no
 * market price is visibly missing a price; a player with someone else's is not.
 */
export interface MarketIndex<T extends MarketRow> {
  /** The one row for this player, or `null` if there is no unambiguous answer. */
  find(name: string, position: string): T | null;
  /** Normalised names that appear on more than one row, for reporting. */
  readonly collisions: readonly string[];
}

export function buildMarketIndex<T extends MarketRow>(
  entries: readonly T[],
  normalizePosition: (raw: string) => string,
): MarketIndex<T> {
  // `null` marks a key that more than one row claims, which is not the same as a key no
  // row claims. Both must lose, but only after being told apart from each other.
  const byNameAndPosition = new Map<string, T | null>();
  const byName = new Map<string, T | null>();
  const collisions = new Set<string>();

  for (const entry of entries) {
    const name = normalizeName(entry.name);
    if (name === "") continue;
    const qualified = `${name}|${normalizePosition(entry.position)}`;

    byNameAndPosition.set(
      qualified,
      byNameAndPosition.has(qualified) ? null : entry,
    );
    if (byName.has(name)) {
      byName.set(name, null);
      collisions.add(name);
    } else {
      byName.set(name, entry);
    }
  }

  return {
    find(name, position) {
      const key = normalizeName(name);
      if (key === "") return null;
      return (
        byNameAndPosition.get(`${key}|${normalizePosition(position)}`) ??
        byName.get(key) ??
        null
      );
    },
    collisions: [...collisions],
  };
}

/**
 * Levenshtein distance, iterative with a single row of state.
 *
 * The row index starts at one because row zero is the initial `previous`. Starting it at
 * zero instead is harmless rather than wrong: that row compares `a[-1]`, which equals
 * nothing, and every cell then resolves to `previous[j-1] + 1 === j`, reproducing the row
 * it started from. Worth stating, because it looks like an off-by-one and is not one.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/** Similarity in [0, 1], where 1 is identical. */
export function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - editDistance(a, b) / longest;
}

export interface MatchCandidate {
  id: string;
  name: string;
}

export interface NameMatch<T extends MatchCandidate> {
  candidate: T;
  confidence: number;
}

/**
 * Below this, a match is not reported at all.
 *
 * Set where it is because the cost of the two errors is not symmetric. A missed pick is
 * visible — the player stays on the board and the user corrects it. A wrong pick is
 * invisible and poisons every later recommendation, because the board now believes
 * someone is gone who is not.
 */
export const MIN_MATCH_CONFIDENCE = 0.82;

/**
 * Above this, a match may be applied without asking.
 *
 * Between the two thresholds the caller should confirm rather than assume.
 */
export const AUTO_APPLY_CONFIDENCE = 0.93;

/**
 * How far ahead the best match must be before it is trusted over the runner-up.
 *
 * Measured against a real pair rather than picked: `Bijan Robinson` and
 * `Brian Robinson Jr.` are two different players whose normalised names are 0.846
 * similar — above the confidence floor, so the floor alone cannot separate them. With one
 * character of OCR damage the two scores land 0.077 apart, and at that distance the text
 * genuinely does not say which player it is.
 *
 * A tenth is therefore the smallest margin that refuses the damaged cases while still
 * accepting a clean read, where the two sit 0.154 apart. Refusing is the cheap error: the
 * pick stays on the board and the user clicks it. Guessing is the expensive one — the
 * board silently believes the wrong player is gone, and every recommendation after it is
 * computed against a roster that does not exist.
 */
export const MATCH_AMBIGUITY_MARGIN = 0.1;

/**
 * Normalised names for a candidate list, cached against the list itself.
 *
 * `findNamesInText` calls `matchName` once per word window across four window sizes, so on
 * a few-hundred-player universe and a screen's worth of text the same few hundred names
 * were being renormalised roughly a million times — for a result that cannot change
 * between calls. Keyed weakly on the array so a caller that rebuilds its universe is not
 * served the old one, and so holding the cache cannot keep a dead universe alive.
 */
const normalizedCache = new WeakMap<readonly MatchCandidate[], string[]>();

function normalizedNames(candidates: readonly MatchCandidate[]): string[] {
  // Length-checked as well as identity-checked. `readonly T[]` stops mutation through
  // *this* reference, not through the caller's own — and a caller that pushes to the array
  // it already passed would otherwise be served a shorter cached list, leaving
  // `normalized[i]` undefined and throwing on `.length` a few lines later.
  const hit = normalizedCache.get(candidates);
  if (hit !== undefined && hit.length === candidates.length) return hit;
  const computed = candidates.map((c) => normalizeName(c.name));
  normalizedCache.set(candidates, computed);
  return computed;
}

/** Best match for a single name-like string, or `null` if nothing is close enough. */
export function matchName<T extends MatchCandidate>(
  raw: string,
  candidates: readonly T[],
  minConfidence = MIN_MATCH_CONFIDENCE,
): NameMatch<T> | null {
  const needle = normalizeName(raw);
  if (needle.length < 4) return null;

  let best: NameMatch<T> | null = null;
  // Any starting value does: the first candidate to pass the prune finds `best` null and
  // overwrites this with `best?.confidence ?? 0`, and if none does, `best` stays null and
  // the runner-up is never read.
  let runnerUp = 0;

  const normalized = normalizedNames(candidates);

  // Below this, a candidate can affect neither the winner nor the ambiguity check, so the
  // edit distance need not be computed at all.
  //
  // `best` is only returned when it clears `minConfidence`, and the runner-up only matters
  // through `best - runnerUp < MATCH_AMBIGUITY_MARGIN`. If a candidate scores under
  // `minConfidence - MATCH_AMBIGUITY_MARGIN` then for any returnable `best` that
  // difference already exceeds the margin, so the candidate cannot suppress a match
  // either. The bound is exact rather than heuristic: skipping is provably invisible.
  //
  // Which is also why the comparison itself cannot be pinned by a test. Skipping one more
  // candidate — the one scoring exactly at the floor — is invisible for the same reason,
  // and skipping none at all is invisible by construction, since the prune is an
  // optimisation over a result that does not depend on it. Only a prune that removes a
  // candidate *above* the floor changes an answer, and that one is covered.
  const floor = minConfidence - MATCH_AMBIGUITY_MARGIN;

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const name = normalized[i];
    // Two strings differing in length by `d` are at least `d` edits apart, so
    // `1 - d / max(len)` is an upper bound on their similarity — available without running
    // the O(n·m) comparison. On a few-hundred-player universe most candidates fail it.
    const longest = Math.max(needle.length, name.length);
    if (longest > 0 && 1 - Math.abs(needle.length - name.length) / longest < floor) {
      continue;
    }
    const score = similarity(needle, name);
    if (best === null || score > best.confidence) {
      runnerUp = best?.confidence ?? 0;
      best = { candidate, confidence: score };
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }

  if (best === null || best.confidence < minConfidence) return null;

  // An ambiguous match is worse than none. Two players whose names are nearly equally
  // close means the text does not identify either — the real case is a shared surname
  // where OCR dropped or damaged the first name.
  //
  // `<` and `<=` are the same function on every input this can receive, and that is a
  // proof rather than a shrug. A confidence is `1 - d / L` for whole `d` and `L`, so the
  // difference of two of them is a difference of two such rationals; searched exhaustively
  // for `L` up to 40 — well past the longest normalised name — no pair differs by exactly
  // the double nearest 0.1. The boundary this comparison sits on is not reachable.
  if (best.confidence - runnerUp < MATCH_AMBIGUITY_MARGIN) return null;

  return best;
}

/**
 * Finds every known player named anywhere in a block of text.
 *
 * Scans runs of one to four consecutive words, because OCR of a draft board interleaves
 * names with everything else on the row — pick numbers, positions, team codes, clocks.
 * Longer runs are tried first so `Brian Robinson Jr` is preferred over `Brian Robinson`
 * when both are known players.
 *
 * Each candidate is reported at most once, at its best confidence.
 */
export function findNamesInText<T extends MatchCandidate>(
  text: string,
  candidates: readonly T[],
  minConfidence = MIN_MATCH_CONFIDENCE,
): NameMatch<T>[] {
  const words = text
    .replace(/[\n\r\t|]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);

  const bestById = new Map<string, NameMatch<T>>();

  // Four is the longest name this can assemble — "Amon-Ra St. Brown" arrives as four
  // tokens — and it is a real limit rather than a spare margin: a five-word name would not
  // be found. Widening it costs a pass over the text and finds nothing, because any
  // five-word phrase is longer than every candidate and the length prune rejects it before
  // the comparison.
  for (let size = 4; size >= 1; size -= 1) {
    // `start + size <= words.length` keeps the window inside the text. Overrunning it is
    // harmless rather than wrong — `slice` past the end returns a short phrase or an empty
    // one, and `matchName` refuses anything under four characters — so only a bound that
    // stops *early* loses a match, which is the last row of a scanned board.
    for (let start = 0; start + size <= words.length; start += 1) {
      const phrase = words.slice(start, start + size).join(" ");
      const match = matchName(phrase, candidates, minConfidence);
      if (match === null) continue;
      const existing = bestById.get(match.candidate.id);
      if (existing === undefined || match.confidence > existing.confidence) {
        bestById.set(match.candidate.id, match);
      }
    }
  }

  return [...bestById.values()].sort((a, b) => b.confidence - a.confidence);
}
