import { describe, expect, it } from "vitest";

import { normalCdf } from "./draft";
import { type Rng, Z_90, createRng, standardNormal } from "./rng";

/**
 * The generator underneath every simulation.
 *
 * This file had no tests at all, which the mutation harness reported as "no test file
 * found for this module" and I read past twice. `createRng` drives every availability
 * draw, every weekly score, every sampled future and — through `playerStream` — every
 * cache key in the speculation layer. Every published draft figure is downstream of it.
 *
 * The reason it needs its own tests rather than being covered by its callers is the same
 * reason `tieBreakKey` did: the things that depend on it assert *statistical* properties —
 * a mean, a spread, a rate — and those survive replacing this with a different but equally
 * good generator. Its constants can all be retyped without a single downstream test
 * failing, while every cached answer and every reproducible figure silently changes.
 */
describe("createRng", () => {
  it("returns the same sequence for the same seed", () => {
    const a = Array.from({ length: 20 }, () => createRng(99).next());
    expect(new Set(a).size).toBe(1);

    const first = createRng(5);
    const second = createRng(5);
    for (let i = 0; i < 200; i += 1) expect(first.next()).toBe(second.next());
  });

  it("returns different sequences for different seeds", () => {
    // Not a distributional claim — just that the seed is read at all. A generator that
    // ignored it would satisfy every uniformity test below and make common random numbers
    // meaningless, which is the entire reason this is seeded.
    const seeds = [0, 1, 2, 42, 1000, 2 ** 31];
    const firstDraws = seeds.map((s) => createRng(s).next());
    expect(new Set(firstDraws).size).toBe(seeds.length);
  });

  it("returns the numbers it returned when these were written down", () => {
    // Golden values. mulberry32 has six constants and four shifts, and nothing else here
    // can tell one well-behaved generator from another: swap any of them and the mean, the
    // variance and every downstream rate stay exactly as correct as they were, while every
    // seeded figure this project publishes moves.
    const rng = createRng(42);
    expect(Array.from({ length: 6 }, () => rng.next())).toEqual([
      0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693,
      0.17481389874592423, 0.5265925421845168,
    ]);
  });

  it("stays inside [0, 1)", () => {
    // The half-open range is load-bearing rather than pedantic. `rng.next() < availability`
    // and `>= q` in the absence chain are written against it, and `Math.log(next())` in the
    // normal draw is undefined at zero — the reason that call is guarded.
    const rng = createRng(3);
    for (let i = 0; i < 200_000; i += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("is uniform enough to drive an availability chain", () => {
    // Ten buckets over 400,000 draws. Each expects 40,000; the tolerance is deliberately
    // loose because this is a smoke test for a catastrophically skewed generator, not a
    // statistical certification — a low bit that clumps would show as a systematic error in
    // how often players are absent, which is what the docstring says the LCG was rejected
    // for.
    const buckets = new Array<number>(10).fill(0);
    const rng = createRng(1);
    let sum = 0;
    let sumOfSquares = 0;
    const draws = 400_000;
    for (let i = 0; i < draws; i += 1) {
      const value = rng.next();
      buckets[Math.floor(value * 10)] += 1;
      sum += value;
      sumOfSquares += value * value;
    }
    for (const count of buckets) {
      expect(count).toBeGreaterThan(draws / 10 - 1500);
      expect(count).toBeLessThan(draws / 10 + 1500);
    }
    const mean = sum / draws;
    expect(mean).toBeCloseTo(0.5, 2);
    // Variance of a uniform on [0,1) is 1/12.
    expect(sumOfSquares / draws - mean * mean).toBeCloseTo(1 / 12, 3);
  });
});

describe("standardNormal", () => {
  it("returns the numbers it returned when these were written down", () => {
    const rng = createRng(7);
    const draws = Array.from({ length: 4 }, () => standardNormal(rng));
    expect(draws[0]).toBeCloseTo(2.759372987028844, 12);
    expect(draws[1]).toBeCloseTo(-0.068051356507354, 12);
    expect(draws[2]).toBeCloseTo(-0.945948960445289, 12);
    expect(draws[3]).toBeCloseTo(0.078149134150143, 12);
  });

  it("has mean zero and unit standard deviation", () => {
    const rng = createRng(2);
    let sum = 0;
    let sumOfSquares = 0;
    const draws = 400_000;
    for (let i = 0; i < draws; i += 1) {
      const value = standardNormal(rng);
      sum += value;
      sumOfSquares += value * value;
    }
    const mean = sum / draws;
    expect(mean).toBeCloseTo(0, 2);
    expect(Math.sqrt(sumOfSquares / draws - mean * mean)).toBeCloseTo(1, 2);
  });

  it("puts about the right mass inside one and two deviations", () => {
    // 68 and 95. A Box-Muller that lost its `sqrt` or its factor of two would still have a
    // mean of zero and could still pass a spread check to two decimals; the shape is what
    // separates it.
    const rng = createRng(11);
    let within1 = 0;
    let within2 = 0;
    const draws = 200_000;
    for (let i = 0; i < draws; i += 1) {
      const value = Math.abs(standardNormal(rng));
      if (value <= 1) within1 += 1;
      if (value <= 2) within2 += 1;
    }
    expect(within1 / draws).toBeCloseTo(0.6827, 2);
    expect(within2 / draws).toBeCloseTo(0.9545, 2);
  });

  it("survives a generator that returns zero, rather than producing an infinity", () => {
    // `Math.log(0)` is `-Infinity`, and the square root of that is `NaN`, which propagates
    // silently into a player's projected points and out into a recommendation. The guard
    // nudges the draw off the boundary instead. `next()` can genuinely return zero — the
    // range is half-open at that end.
    const always = (value: number): Rng => ({ next: () => value });
    const atZero = standardNormal(always(0));
    expect(Number.isFinite(atZero)).toBe(true);
    // Enormous, because it is the tail of a distribution evaluated at the smallest double
    // there is — but finite, which is the whole point.
    expect(atZero).toBeGreaterThan(30);
  });

  it("is finite across the whole range a generator can produce", () => {
    const always = (value: number): Rng => ({ next: () => value });
    for (const value of [0, Number.MIN_VALUE, 1e-300, 0.5, 1 - Number.EPSILON]) {
      expect(Number.isFinite(standardNormal(always(value)))).toBe(true);
    }
  });
});

describe("Z_90", () => {
  it("is the ninetieth percentile of the standard normal", () => {
    // Checked against `normalCdf`, which is itself pinned to twelve tabulated values within
    // the 7.5e-8 its docstring claims — so this is a check against something external
    // rather than a restatement of the same literal.
    //
    // `fitLognormal` divides by `2 * Z_90` to turn a p10/p90 pair into a sigma, so a wrong
    // value here rescales the spread of every player on the board while leaving the median
    // alone. Nothing downstream would notice: the quantile round-trip test in
    // `roster-utility.test.ts` uses this same constant on both sides and would pass for any
    // value at all.
    // Against `normalCdf`'s own documented error bound rather than a round number of
    // decimals: the residual is 6.9e-8, inside the 7.5e-8 that function claims and is
    // separately tested to, and outside the 5e-8 that `toBeCloseTo(0.9, 7)` allows. The
    // bound that means something here is the one the approximation states.
    expect(Math.abs(normalCdf(Z_90) - 0.9)).toBeLessThan(7.5e-8);
    expect(Math.abs(normalCdf(-Z_90) - 0.1)).toBeLessThan(7.5e-8);
    // And it is the *right* percentile, far outside any approximation error — a constant
    // wrong in its third decimal would land here.
    expect(Z_90).toBeGreaterThan(1.28);
    expect(Z_90).toBeLessThan(1.29);
  });
});
