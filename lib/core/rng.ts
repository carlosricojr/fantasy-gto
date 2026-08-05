/**
 * Deterministic pseudo-randomness.
 *
 * The domain core may not call `Math.random` — a projection or a valuation that changes
 * between two runs on the same input cannot be backtested, and `lib/purity.test.ts`
 * enforces that. Randomness that the model genuinely needs is therefore passed in, the
 * same way the clock is.
 *
 * Determinism buys more than reproducibility here. Comparing two candidate rosters means
 * comparing two expectations estimated by sampling, and the difference of two independent
 * estimates is far noisier than either. Driving both from the *same* seed — common random
 * numbers — cancels most of that noise, so a comparison that would need tens of thousands
 * of scenarios to resolve needs hundreds.
 */

export interface Rng {
  /** Uniform on [0, 1). */
  next(): number;
}

/**
 * mulberry32, a 32-bit generator whose arithmetic JavaScript does exactly.
 *
 * Named correctly here because the docstring used to say "SplitMix64-style", which the
 * inline comment below already contradicted — and somebody auditing these constants
 * against SplitMix64 would not have found them.
 *
 * Chosen over a linear congruential generator because the low bits of an LCG are
 * notoriously non-random, and this is used to drive per-week availability draws where a
 * biased low bit would show up as a systematic error in how often players are absent.
 */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  return {
    next(): number {
      // mulberry32: passes the usual smallcrush battery and is exact in doubles.
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/**
 * Standard normal draw, Box-Muller.
 *
 * The transform is undefined at zero, which `next()` can return, so the draw is nudged off
 * the boundary rather than left to produce an infinity that would silently propagate into
 * a player's projected points.
 */
export function standardNormal(rng: Rng): number {
  const u1 = Math.max(rng.next(), Number.MIN_VALUE);
  const u2 = rng.next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** The 90th percentile of the standard normal, for fitting quantiles to a distribution. */
export const Z_90 = 1.2815515655446004;
