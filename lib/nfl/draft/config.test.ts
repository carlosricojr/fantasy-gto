import { describe, expect, it } from "vitest";

import { MODEL_BLEND_WEIGHT, normalizeMarketPosition } from "./config";

/**
 * The market's position spellings, mapped onto ours.
 *
 * Small enough to look obviously correct, and it sits on the join between two feeds — so
 * a code that fails to normalise means a player the board cannot price, and a code that
 * normalises to the wrong thing means one priced off the wrong curve.
 */
describe("normalizeMarketPosition", () => {
  it("maps the spellings the market actually publishes", () => {
    expect(normalizeMarketPosition("PK")).toBe("K");
    expect(normalizeMarketPosition("DEF")).toBe("DST");
    expect(normalizeMarketPosition("D/ST")).toBe("DST");
  });

  it("passes our own spellings through", () => {
    for (const code of ["QB", "RB", "WR", "TE", "K", "DST"]) {
      expect(normalizeMarketPosition(code)).toBe(code);
    }
  });

  it("trims and uppercases before looking anything up", () => {
    // Feeds publish " rb " and "Def". Untrimmed or unfolded, the lookup misses and the
    // player is joined under a key nothing else uses.
    expect(normalizeMarketPosition("  rb ")).toBe("RB");
    expect(normalizeMarketPosition("def")).toBe("DST");
    expect(normalizeMarketPosition(" pk")).toBe("K");
  });

  it("returns a string for a prototype key, and does so on purpose", () => {
    // A review flagged this as reading inherited properties — `normalizeMarketPosition`
    // does index an object literal, and `adpFormatFor` in `lib/sources/adp.ts` had exactly
    // that bug and carries a guard for it.
    //
    // Here it cannot happen, but only because the uppercasing runs *first*: every member of
    // `Object.prototype` is lowercase or camelCase, so no uppercased input can name one.
    // That is incidental protection — move the `toUpperCase()` below the lookup and the bug
    // appears — which is why it is pinned rather than argued.
    for (const key of ["__proto__", "toString", "constructor", "hasOwnProperty", "valueOf"]) {
      const out = normalizeMarketPosition(key);
      expect(typeof out).toBe("string");
      expect(out).toBe(key.toUpperCase());
    }
  });
});

describe("MODEL_BLEND_WEIGHT", () => {
  it("is the weight the published figures were measured at", () => {
    // `docs/draft-validation.md` calls 0.2 the best of the values swept and reports the
    // evaluation table at that weight. `published-metrics.test.ts` checks the document
    // against the metrics file; this checks the constant the code actually blends with.
    expect(MODEL_BLEND_WEIGHT).toBe(0.2);
  });
});
