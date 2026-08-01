import { describe, expect, it } from "vitest";

import {
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
    // Substitutions of the kind OCR actually makes: rn/m, l/1, s/5.
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
