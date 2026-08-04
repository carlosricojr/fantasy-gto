import { describe, expect, it } from "vitest";

import {
  MATCH_AMBIGUITY_MARGIN,
  buildMarketIndex,
  AUTO_APPLY_CONFIDENCE,
  MIN_MATCH_CONFIDENCE,
  editDistance,
  findNamesInText,
  matchName,
  normalizeName,
  similarity,
} from "./match";

/**
 * Name matching.
 *
 * The tests that matter are the failure cases. A missed match is visible and correctable;
 * a wrong match is silent and corrupts the board, so the bar is that plausible-but-wrong
 * input produces nothing rather than a guess.
 */

const UNIVERSE = [
  { id: "1", name: "Ja'Marr Chase" },
  { id: "2", name: "A.J. Brown" },
  { id: "3", name: "Kenneth Walker III" },
  { id: "4", name: "Bijan Robinson" },
  { id: "5", name: "Brian Robinson Jr." },
  { id: "6", name: "Puka Nacua" },
  { id: "7", name: "Amon-Ra St. Brown" },
];

describe("normalizeName", () => {
  it("strips punctuation and case", () => {
    expect(normalizeName("Ja'Marr Chase")).toBe("jamarrchase");
    expect(normalizeName("A.J. Brown")).toBe("ajbrown");
    expect(normalizeName("AJ BROWN")).toBe("ajbrown");
    expect(normalizeName("Amon-Ra St. Brown")).toBe("amonrastbrown");
  });

  it("drops generational suffixes, which sources disagree about", () => {
    expect(normalizeName("Kenneth Walker III")).toBe(normalizeName("Kenneth Walker"));
    expect(normalizeName("Brian Robinson Jr.")).toBe(normalizeName("Brian Robinson"));
  });
});

describe("editDistance and similarity", () => {
  it("counts single-character edits", () => {
    expect(editDistance("chase", "chace")).toBe(1);
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("same", "same")).toBe(0);
  });

  it("reports similarity in [0,1]", () => {
    expect(similarity("abc", "abc")).toBe(1);
    expect(similarity("", "")).toBe(1);
    expect(similarity("abc", "xyz")).toBe(0);
  });
});

describe("matchName", () => {
  it("recovers a name through typical OCR damage", () => {
    // The three ways a name comes back damaged in practice: a substituted letter, a
    // dropped apostrophe, and a space inserted mid-word. (This comment used to list
    // rn/m, l/1 and s/5, none of which any of these inputs exercise.)
    for (const damaged of ["Ja'Marr Chsse", "JaMarr Chase", "Ja Marr Chas e"]) {
      const match = matchName(damaged, UNIVERSE);
      expect(match?.candidate.id).toBe("1");
    }
  });

  it("matches across punctuation and suffix differences", () => {
    expect(matchName("AJ Brown", UNIVERSE)?.candidate.id).toBe("2");
    expect(matchName("Kenneth Walker", UNIVERSE)?.candidate.id).toBe("3");
  });

  it("returns null for a player who is not in the universe", () => {
    // The important negative: an unknown name must not be forced onto the nearest known
    // one. Drafting the wrong player into the board poisons every later recommendation.
    expect(matchName("Patrick Mahomes", UNIVERSE)).toBeNull();
    expect(matchName("Zzzz Qqqq", UNIVERSE)).toBeNull();
  });

  it("refuses an ambiguous match rather than guessing", () => {
    // Two Robinsons. A surname alone does not identify either, which is exactly what
    // happens when OCR clips the first name off a narrow column.
    expect(matchName("Robinson", UNIVERSE)).toBeNull();
  });

  it("still resolves an ambiguous surname when the first name survives", () => {
    expect(matchName("Bijan Robinson", UNIVERSE)?.candidate.id).toBe("4");
    expect(matchName("Brian Robinson", UNIVERSE)?.candidate.id).toBe("5");
  });

  it("ignores fragments too short to identify anyone", () => {
    expect(matchName("AJ", UNIVERSE)).toBeNull();
    expect(matchName("", UNIVERSE)).toBeNull();
  });

  it("reports confidence, and an exact name is certain", () => {
    const match = matchName("Puka Nacua", UNIVERSE);
    expect(match?.confidence).toBe(1);
    expect(match!.confidence).toBeGreaterThan(AUTO_APPLY_CONFIDENCE);
  });

  it("keeps a damaged match below the auto-apply bar", () => {
    // Recovered, but not confidently enough to apply without a human glance.
    const match = matchName("Bijan Robnsn", UNIVERSE, 0.6);
    expect(match?.candidate.id).toBe("4");
    expect(match!.confidence).toBeLessThan(AUTO_APPLY_CONFIDENCE);
  });
});

describe("findNamesInText", () => {
  it("pulls players out of a draft-board row", () => {
    // The shape a real capture produces: pick number, name, position, team, clock.
    const text = `
      1.01  Ja'Marr Chase   WR  CIN   00:42
      1.02  Bijan Robinson  RB  ATL   01:15
      1.03  Puka Nacua      WR  LAR   —
    `;
    const ids = findNamesInText(text, UNIVERSE).map((m) => m.candidate.id);
    expect(ids).toContain("1");
    expect(ids).toContain("4");
    expect(ids).toContain("6");
  });

  it("prefers the longer name when both are known players", () => {
    const matches = findNamesInText("RD2 Brian Robinson Jr. RB WAS", UNIVERSE);
    expect(matches[0].candidate.id).toBe("5");
  });

  it("reports each player once, at their best confidence", () => {
    const text = "Puka Nacua ... later ... Puka Nacua";
    const matches = findNamesInText(text, UNIVERSE);
    expect(matches.filter((m) => m.candidate.id === "6")).toHaveLength(1);
  });

  it("finds nothing in text with no players in it", () => {
    // Chrome, adverts, and menu chrome must not produce phantom picks.
    const text = "File Edit View History Bookmarks Window Help — 12:04 PM — 87%";
    expect(findNamesInText(text, UNIVERSE)).toEqual([]);
  });

  it("survives an empty capture", () => {
    expect(findNamesInText("", UNIVERSE)).toEqual([]);
    expect(findNamesInText("   \n\t ", UNIVERSE)).toEqual([]);
  });

  it("honours the confidence floor it is given", () => {
    const strict = findNamesInText("Bijan Robnsn", UNIVERSE, 0.99);
    expect(strict).toEqual([]);
    const lenient = findNamesInText("Bijan Robnsn", UNIVERSE, 0.6);
    expect(lenient[0]?.candidate.id).toBe("4");
  });

  it("refuses a confusable pair the confidence floor alone cannot separate", () => {
    // The reason the ambiguity margin exists. Bijan Robinson and Brian Robinson Jr. are
    // different players whose normalised names are 0.846 similar — above the floor. The
    // floor cannot separate them; only the margin can.
    expect(
      similarity(normalizeName("Brian Robinson"), normalizeName("Bijan Robinson")),
    ).toBeGreaterThan(MIN_MATCH_CONFIDENCE);

    // Clean text still resolves, because the correct match is a clear 0.154 ahead.
    expect(matchName("Bijan Robinson", UNIVERSE)?.candidate.id).toBe("4");
    expect(matchName("Brian Robinson", UNIVERSE)?.candidate.id).toBe("5");

    // One character of damage puts them within the margin, and it refuses rather than
    // picking one. Drafting the wrong Robinson is silent and unrecoverable.
    expect(matchName("Brjan Robinson", UNIVERSE)).toBeNull();
    expect(matchName("Bran Robinson", UNIVERSE)).toBeNull();
  });
});

describe("buildMarketIndex", () => {
  const norm = (raw: string) => (raw === "PK" ? "K" : raw.toUpperCase());
  const row = (name: string, position: string, adp: number) => ({ name, position, adp });

  it("joins on name when the board has no collision", () => {
    const index = buildMarketIndex([row("Bijan Robinson", "RB", 3)], norm);
    expect(index.find("Bijan Robinson", "RB")?.adp).toBe(3);
  });

  it("separates two players who normalise to the same name, by position", () => {
    // The case that motivated this. `normalizeName` drops generational suffixes, so
    // "Michael Carter" and "Michael Carter II" collapse to one key — and a plain Map
    // would hand whichever came second the other's ADP, spread, and bye week.
    const index = buildMarketIndex(
      [row("Michael Carter", "RB", 90), row("Michael Carter II", "WR", 250)],
      norm,
    );
    expect(index.find("Michael Carter", "RB")?.adp).toBe(90);
    expect(index.find("Michael Carter", "WR")?.adp).toBe(250);
    expect(index.collisions).toEqual(["michaelcarter"]);
  });

  it("refuses rather than guessing when position cannot separate them either", () => {
    // Two genuinely indistinguishable rows. Returning either one silently prices a
    // player off somebody else's market; returning null shows a missing price.
    const index = buildMarketIndex(
      [row("John Smith", "WR", 40), row("John Smith", "WR", 200)],
      norm,
    );
    expect(index.find("John Smith", "WR")).toBeNull();
  });

  it("refuses a colliding name asked for under a third position", () => {
    const index = buildMarketIndex(
      [row("Michael Carter", "RB", 90), row("Michael Carter II", "WR", 250)],
      norm,
    );
    expect(index.find("Michael Carter", "TE")).toBeNull();
  });

  it("still matches when the sources disagree about position", () => {
    // Real and common: the market lists a player at RB, the roster file says WR. The
    // name-only fallback exists so this keeps its price instead of silently losing it.
    const index = buildMarketIndex([row("Deebo Samuel", "RB", 25)], norm);
    expect(index.find("Deebo Samuel", "WR")?.adp).toBe(25);
  });

  it("applies the caller's position normalisation on both sides", () => {
    const index = buildMarketIndex([row("Justin Tucker", "PK", 150)], norm);
    expect(index.find("Justin Tucker", "K")?.adp).toBe(150);
  });

  it("reports no match rather than throwing on an unknown or empty name", () => {
    const index = buildMarketIndex([row("Bijan Robinson", "RB", 3)], norm);
    expect(index.find("Nobody At All", "RB")).toBeNull();
    expect(index.find("", "RB")).toBeNull();
  });

  it("ignores a market row whose name normalises to nothing", () => {
    // Punctuation-only names would otherwise all share the empty key and collide.
    const index = buildMarketIndex([row("!!!", "RB", 1), row("???", "WR", 2)], norm);
    expect(index.collisions).toEqual([]);
    expect(index.find("!!!", "RB")).toBeNull();
  });
});

describe("normalizeName folds accents", () => {
  it("gives an accented and unaccented spelling the same key", () => {
    // The sources disagree about accents constantly. Stripping rather than folding
    // deleted the whole character — "José" became "jos" — so one spelling could not find
    // the other and `buildMarketIndex` reported the market price as missing.
    expect(normalizeName("José Gonzalez")).toBe(normalizeName("Jose Gonzalez"));
    expect(normalizeName("Amon-Ra St. Brown")).toBe(normalizeName("Amon Ra St Brown"));
    expect(normalizeName("Ndamukong Suh")).toBe("ndamukongsuh");
  });

  it("keeps the letter rather than dropping it", () => {
    expect(normalizeName("José Gonzalez")).toBe("josegonzalez");
  });
});

/**
 * The length prune inside `matchName`.
 *
 * It skips the edit distance for candidates whose lengths are too far apart to matter. The
 * argument that this is invisible is short — a candidate below
 * `minConfidence - MATCH_AMBIGUITY_MARGIN` can neither win nor suppress a winner — but an
 * argument is not a check, and the prune sits directly on the path that decides which
 * player a screen-read pick belongs to.
 *
 * So the pruned implementation is compared against an unpruned one over every candidate in
 * a plausible universe, damaged twelve ways, at three confidence thresholds.
 */
describe("matchName is unchanged by its length prune", () => {
  /** The implementation as it was before the prune, kept deliberately naive. */
  function unpruned<T extends { id: string; name: string }>(
    raw: string,
    candidates: readonly T[],
    minConfidence: number,
  ): { candidate: T; confidence: number } | null {
    const needle = normalizeName(raw);
    if (needle.length < 4) return null;
    let best: { candidate: T; confidence: number } | null = null;
    let runnerUp = 0;
    for (const candidate of candidates) {
      const score = similarity(needle, normalizeName(candidate.name));
      if (best === null || score > best.confidence) {
        runnerUp = best?.confidence ?? 0;
        best = { candidate, confidence: score };
      } else if (score > runnerUp) {
        runnerUp = score;
      }
    }
    if (best === null || best.confidence < minConfidence) return null;
    if (best.confidence - runnerUp < MATCH_AMBIGUITY_MARGIN) return null;
    return best;
  }

  const FIRST = ["Ja", "Bijan", "Brian", "Amon", "Jose", "Puka", "CeeDee", "Saquon", "De"];
  const LAST = [
    "Marr Chase",
    "Robinson",
    "Robinson Jr",
    "Ra St Brown",
    "Gonzalez",
    "Nacua",
    "Lamb",
    "Barkley",
    "Von Achane",
  ];
  const universe = FIRST.flatMap((f, i) =>
    LAST.map((l, j) => ({ id: `${i}-${j}`, name: `${f} ${l}` })),
  );

  /** Deletions, inserted spaces and substitutions — what a screen read actually does. */
  const damage = (s: string, k: number): string => {
    const a = s.split("");
    if (k % 3 === 0 && a.length > 3) a.splice(k % a.length, 1);
    if (k % 3 === 1) a.splice(k % a.length, 0, " ");
    if (k % 3 === 2 && a.length > 2) a[k % a.length] = "s";
    return a.join("");
  };

  // Deliberately exhaustive: 2,187 comparisons, each running two full passes over an
  // 81-player universe, about five seconds on an idle machine. The domain project raises
  // the timeout for exactly this reason — see vitest.config.mts.
  it("agrees with the unpruned implementation on every case", () => {
    let checked = 0;
    for (const candidate of universe) {
      for (let k = 0; k < 12; k += 1) {
        for (const confidence of [0.7, MIN_MATCH_CONFIDENCE, 0.9]) {
          const probe = damage(candidate.name, k);
          const pruned = matchName(probe, universe, confidence);
          const plain = unpruned(probe, universe, confidence);
          expect(pruned?.candidate.id ?? null).toBe(plain?.candidate.id ?? null);
          expect(pruned?.confidence ?? 0).toBeCloseTo(plain?.confidence ?? 0, 12);
          checked += 1;
        }
      }
    }
    // Guards against the loops silently covering nothing.
    expect(checked).toBeGreaterThan(2000);
  });
});

describe("the normalisation cache follows an array that grew", () => {
  it("does not serve a stale list after the caller appends", () => {
    // The cache is keyed on array identity. `readonly T[]` stops mutation through the
    // parameter, not through the caller's own reference — and a shorter cached list leaves
    // `normalized[i]` undefined and throws on `.length` a few lines later.
    const universe = [{ id: "1", name: "Bijan Robinson" }];
    expect(matchName("Bijan Robinson", universe)?.candidate.id).toBe("1");

    universe.push({ id: "2", name: "Puka Nacua" });
    expect(() => matchName("Puka Nacua", universe)).not.toThrow();
    expect(matchName("Puka Nacua", universe)?.candidate.id).toBe("2");
  });
});

/**
 * The two numbers this module reports.
 *
 * `similarity` is the confidence the interface shows and the thresholds are compared
 * against, and `findNamesInText` returns its answers best-first so the caller can trust the
 * head of the list. Neither was pinned: dividing by the *shorter* string instead of the
 * longer one changed 5,711 of 12,000 damaged spellings without a single test objecting, and
 * turning the sort comparator into a sum left the results in insertion order.
 */
describe("similarity is normalised by the longer string", () => {
  it("scores a prefix against its extension by the length of the extension", () => {
    // Three edits over a length of six is a half. Dividing by the shorter string instead
    // gives 1 - 3/3 = 0, which fails everything rather than scoring it.
    expect(similarity("abc", "abcdef")).toBeCloseTo(0.5, 10);
    expect(similarity("puka", "pukanacua")).toBeCloseTo(4 / 9, 10);
    expect(similarity("", "abcd")).toBeCloseTo(0, 10);
    expect(similarity("same", "same")).toBeCloseTo(1, 10);
  });

  it("reports a confidence a caller can act on", () => {
    // `Bijan Robnsn` is two deletions from `bijanrobinson` (13 characters).
    const match = matchName("Bijan Robnsn", UNIVERSE);
    expect(match?.candidate.id).toBe("4");
    expect(match?.confidence).toBeCloseTo(11 / 13, 10);
  });
});

describe("findNamesInText orders by confidence", () => {
  it("returns the most confident match first", () => {
    // A clean read and a damaged one in the same line. Best-first is what lets a caller
    // trust the head of the list; a comparator that never reorders leaves insertion order,
    // which is the order the *text* happened to use.
    const found = findNamesInText(
      "1.01 Bijan Robnsn RB ATL 1.02 Puka Nacua WR LAR",
      UNIVERSE,
    );
    expect(found.length).toBeGreaterThan(1);
    expect(found[0].candidate.id).toBe("6");
    expect(found[0].confidence).toBeGreaterThan(found[1].confidence);
    for (let i = 1; i < found.length; i += 1) {
      expect(found[i - 1].confidence).toBeGreaterThanOrEqual(found[i].confidence);
    }
  });
});

/**
 * What `normalizeName` keeps and what it throws away.
 *
 * It builds the key for the per-player market index, so what survives normalisation decides
 * which players are found at all. Two mutants changed that silently: narrowing the
 * character class drops digits from names that carry them, and requiring more than one
 * character per token drops initials — which is exactly how OCR and hand-typed input render
 * "A.J." and "T.J.", the module's own documented damage model.
 */
describe("normalizeName keeps what identifies a player", () => {
  it("keeps digits, which some names carry", () => {
    // "San Francisco 49ers" is a real board entry: defences are named by team.
    expect(normalizeName("San Francisco 49ers")).toBe("sanfrancisco49ers");
    expect(normalizeName("Robert Griffin III")).toBe("robertgriffin");
  });

  it("keeps single-character tokens, which is how initials arrive", () => {
    // Dropping tokens of length one turns "A. J. Brown" into "brown" — a different player
    // from "ajbrown", so the index misses him entirely.
    expect(normalizeName("A. J. Brown")).toBe("ajbrown");
    expect(normalizeName("A.J. Brown")).toBe("ajbrown");
    expect(normalizeName("T. J. Hockenson")).toBe("tjhockenson");
  });

  it("agrees across the spellings the sources actually use", () => {
    const forms = ["A.J. Brown", "AJ Brown", "A. J. Brown", "a.j. brown"];
    const keys = new Set(forms.map(normalizeName));
    expect(keys.size).toBe(1);
  });
});

/**
 * The thresholds `matchName` compares against.
 *
 * A name is only reported above `MIN_MATCH_CONFIDENCE`, only accepted when it leads the
 * runner-up by `MATCH_AMBIGUITY_MARGIN`, and only considered at all when the text is at
 * least four characters. Each of those is a boundary, and each could move by one with
 * nothing objecting — which changes which picks a screen-read attributes and which it
 * refuses.
 */
describe("matchName's boundaries", () => {
  it("needs four characters before it will guess at all", () => {
    // Shorter than that and a fragment matches half the league. Tested against a low
    // confidence floor so the *length* guard is what decides — at the normal floor "puka"
    // is refused for its score (4/9) and the boundary would be invisible.
    expect(matchName("Puka", UNIVERSE, 0.4)?.candidate.id).toBe("6");
    expect(matchName("Puk", UNIVERSE, 0.01)).toBeNull();
    expect(matchName("aj", UNIVERSE, 0.01)).toBeNull();
  });

  it("reports a match at the floor and refuses one below it", () => {
    // Confidence is compared with `<`, so a score exactly at the floor is reported. A
    // shifted comparison silently changes which reads are trusted.
    const exact = matchName("Puka Nacua", UNIVERSE, 1);
    expect(exact?.candidate.id).toBe("6");
    // A perfect match scores 1, so a floor above 1 can never be met.
    expect(matchName("Puka Nacua", UNIVERSE, 1.01)).toBeNull();
  });

  it("refuses two candidates that are equally close", () => {
    // The documented case: "Bijan Robinson" and "Brian Robinson Jr." normalise 0.846
    // similar. With one character of damage the two land inside the margin and the text
    // genuinely does not say which player it is.
    expect(matchName("Bran Robinson", UNIVERSE)).toBeNull();
    // A clean read of either is unambiguous.
    expect(matchName("Bijan Robinson", UNIVERSE)?.candidate.id).toBe("4");
    expect(matchName("Brian Robinson", UNIVERSE)?.candidate.id).toBe("5");
  });

  // Not tested here: `score > best.confidence` versus `>=`. With two candidates scoring
  // identically the ambiguity margin refuses the match either way, so the two forms are
  // indistinguishable through this function's public result. Recorded rather than covered
  // by an assertion that would pass regardless.
});

/**
 * Edit distance, past the cases a name matcher happens to exercise.
 *
 * Every match in this file goes through `similarity`, which divides this by a length — so a
 * distance that is wrong by one usually still lands the same side of a 0.82 confidence
 * floor and nothing fails. The base cases and the loop bounds need asserting directly.
 */
describe("editDistance is the distance, not an approximation of it", () => {
  it("agrees with the worked example everyone checks against", () => {
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("saturday", "sunday")).toBe(3);
    expect(editDistance("flaw", "lawn")).toBe(2);
  });

  it("handles a single character against a longer string", () => {
    // The empty-string shortcuts are `a.length === 0` and `b.length === 0`. Moved to one,
    // they return the other string's whole length for any single-character input: "a"
    // against "abc" would be 3 rather than 2, and every one-letter token in a scanned
    // board would be scored against the wrong distance.
    expect(editDistance("a", "abc")).toBe(2);
    expect(editDistance("abc", "a")).toBe(2);
    expect(editDistance("a", "b")).toBe(1);
    expect(editDistance("a", "a")).toBe(0);
  });

  it("is symmetric, which the single row of state does not make obvious", () => {
    const pairs = [
      ["chase", "chace"],
      ["ajbrown", "amonrastbrown"],
      ["kennethwalker", "kenwalker"],
      ["", "abc"],
      ["x", "xyz"],
    ] as const;
    for (const [a, b] of pairs) {
      expect(editDistance(a, b)).toBe(editDistance(b, a));
    }
  });

  it("counts each kind of edit once", () => {
    expect(editDistance("abc", "abd")).toBe(1); // substitution
    expect(editDistance("abc", "abcd")).toBe(1); // insertion
    expect(editDistance("abcd", "abc")).toBe(1); // deletion
    expect(editDistance("abc", "xyz")).toBe(3); // nothing in common
  });

  it("never exceeds the length of the longer string", () => {
    // The bound `similarity` relies on to stay inside [0, 1]. A loop that starts or stops
    // one step out breaks it without any single case looking obviously wrong.
    const words = ["", "a", "ab", "abc", "abcd", "xyz", "abcde", "bacd"];
    for (const a of words) {
      for (const b of words) {
        const d = editDistance(a, b);
        expect(d).toBeGreaterThanOrEqual(Math.abs(a.length - b.length));
        expect(d).toBeLessThanOrEqual(Math.max(a.length, b.length));
        expect(similarity(a, b)).toBeGreaterThanOrEqual(0);
        expect(similarity(a, b)).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("findNamesInText reads phrases of every length", () => {
  it("finds a one-word name", () => {
    // The window shrinks from four words down to one. Stopping at two never matches a
    // player by surname alone, which is how half a scanned board reads.
    const found = findNamesInText("Nacua", UNIVERSE, 0.4);
    expect(found.map((m) => m.candidate.id)).toEqual(["6"]);
  });

  it("finds a four-word name", () => {
    // "Amon-Ra St. Brown" arrives from OCR as four separate tokens. A window one shorter
    // never assembles it, and the player with the longest name on the board is the one
    // that stops being findable.
    const found = findNamesInText("RB Amon Ra St Brown BYE", UNIVERSE, 0.8);
    expect(found.map((m) => m.candidate.id)).toContain("7");
  });

  it("reads a phrase at the very end of the text", () => {
    // `start + size <= words.length`. Anything that moves that bound drops the last window,
    // so the final row of a scanned board goes missing — the one place nobody looks.
    const found = findNamesInText("QB1 RB1 WR1 Puka Nacua", UNIVERSE, 0.8);
    expect(found.map((m) => m.candidate.id)).toEqual(["6"]);
  });

  it("keeps single-character tokens, which carry the initials", () => {
    // "A.J. Brown" splits into "A", "J", "Brown" once the punctuation is separators.
    // Dropping one-character words leaves "brown", which is closer to "Amon-Ra St. Brown"
    // than the length prune admits and matches nobody at the normal floor.
    const found = findNamesInText("A J Brown", UNIVERSE, 0.8);
    expect(found.map((m) => m.candidate.id)).toEqual(["2"]);
  });
});
