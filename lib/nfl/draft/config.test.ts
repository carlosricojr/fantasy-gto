import { describe, expect, it } from "vitest";

import {
  AVAILABILITY_FLOOR,
  GAMES_IN_SEASON,
  MODEL_BLEND_WEIGHT,
  SEASON_EMA_ALPHA,
  normalizeMarketPosition,
} from "./config";
import { EMA_ALPHA } from "../model/config";
import { expectedGames } from "./value";

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

describe("the constants the draft model is built on", () => {
  it("smooths the same way the weekly model does", () => {
    // The docstring calls this deliberate: a draft projection that weighted recent games
    // differently from the in-season model would have the two disagreeing about the same
    // player on the same evidence. Asserted against the other constant rather than restated,
    // so the two cannot drift apart silently — which is the only failure mode that matters
    // here, and the one a literal on its own could not catch.
    expect(SEASON_EMA_ALPHA).toBe(EMA_ALPHA);
    expect(SEASON_EMA_ALPHA).toBe(0.15);
  });

  it("counts the games an NFL team actually plays", () => {
    // `expectedGames` divides prior games by this and multiplies the ramp by it, and
    // `perGameRate` divides a season total by it. Doubling it halves every per-game rate on
    // the board while leaving the season totals looking correct.
    expect(GAMES_IN_SEASON).toBe(17);
    expect(expectedGames(17)).toBe(17);
    expect(expectedGames(0)).toBe(17 * AVAILABILITY_FLOOR);
  });

  it("floors expected availability at half a season", () => {
    // Judgement, and the docstring says so. What is testable is what it *does*: a player
    // with no prior games is assumed to play half a season rather than none, so he is
    // discounted rather than written off. At 1 the floor stops being a floor and everybody
    // plays a full season whatever their history — which is the mutant that survived.
    expect(AVAILABILITY_FLOOR).toBe(0.5);
    expect(expectedGames(0)).toBeLessThan(expectedGames(17));
    expect(expectedGames(0)).toBe(8.5);
    // And it ramps rather than stepping: half a season of prior games lands between them.
    expect(expectedGames(8.5)).toBeGreaterThan(expectedGames(0));
    expect(expectedGames(8.5)).toBeLessThan(expectedGames(17));
  });
});
