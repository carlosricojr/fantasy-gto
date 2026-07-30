import type {
  DefenseStatLine,
  KickerStatLine,
  ScoreBreakdown,
  ScoreComponent,
  ScoringRules,
  ScoringTier,
  StatLine,
} from "./types";

/**
 * Fantasy scoring.
 *
 * Every function here is pure and total: same input, same output, no I/O, no clock, no
 * throwing on ordinary data. That is what lets the whole engine be verified against real
 * upstream production in `score.test.ts`.
 *
 * Scores are quantised to two decimals. Fantasy points are compared, ranked, and summed
 * constantly, and raw binary floating point makes those comparisons unstable — `0.04 * 3`
 * is not `0.12`. Rounding at the component level keeps arithmetic associative enough that
 * a lineup total does not depend on the order players were added.
 */

/**
 * Rounds to two decimals, half away from zero, without `-0`.
 *
 * Scaling by 100 and rounding does not work: `1.005 * 100` is `100.49999999999999` in
 * IEEE-754, so the obvious implementation returns 1.00 while claiming to round half up.
 * Adding an epsilon does not fix it either — the error is larger than one ulp.
 *
 * Shifting the decimal point through the exponent instead is exact, because it reuses the
 * decimal representation rather than performing a binary multiplication. The sign is
 * handled separately because `Math.round` breaks ties toward positive infinity, which
 * would round -1.005 to -1.00 rather than away from zero.
 */
export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;

  const magnitude = Math.abs(value);
  const shifted = Number(`${magnitude}e2`);

  // Exponential input (e.g. 1e21) stringifies with its own `e`, which the shift above
  // cannot parse. Nothing in fantasy scoring reaches that range, but fall back rather
  // than return NaN.
  const rounded = Number.isFinite(shifted)
    ? Number(`${Math.round(shifted)}e-2`)
    : Math.round(magnitude * 100) / 100;

  const signed = value < 0 ? -rounded : rounded;
  return signed === 0 ? 0 : signed;
}

/**
 * Builds a breakdown from candidate terms.
 *
 * Zero-valued terms are dropped so the interface shows only what actually moved the
 * number. The total is derived from the retained components, which is what makes
 * "components sum to total" true by construction rather than by convention.
 */
function breakdown(terms: readonly ScoreComponent[]): ScoreBreakdown {
  const components = terms
    .map((term) => ({ label: term.label, points: round2(term.points) }))
    .filter((term) => term.points !== 0);
  const total = round2(components.reduce((sum, term) => sum + term.points, 0));
  return { total, components };
}

/**
 * Resolves a tiered bonus.
 *
 * Bands are inclusive of `min` and exclusive of `max`, with `null` meaning unbounded, so
 * a well-formed ladder tiles the range with no gap or overlap. Returns 0 when no band
 * matches rather than throwing: a missing band is a ruleset configuration problem, and
 * silently scoring zero is safer than failing a whole week's scoring.
 */
export function resolveTier(value: number, tiers: readonly ScoringTier[]): number {
  for (const tier of tiers) {
    const aboveMin = value >= tier.min;
    const belowMax = tier.max === null || value < tier.max;
    if (aboveMin && belowMax) return tier.points;
  }
  return 0;
}

/** Scores a skill-position player. */
export function scoreOffense(stats: StatLine, rules: ScoringRules): ScoreBreakdown {
  const r = rules.offense;
  const twoPointConversions =
    stats.passing2ptConversions + stats.rushing2ptConversions + stats.receiving2ptConversions;

  return breakdown([
    { label: "Passing yards", points: stats.passingYards * r.passingYardsPerPoint },
    { label: "Passing TDs", points: stats.passingTds * r.passingTd },
    { label: "Interceptions", points: stats.passingInterceptions * r.passingInterception },
    { label: "Rushing yards", points: stats.rushingYards * r.rushingYardsPerPoint },
    { label: "Rushing TDs", points: stats.rushingTds * r.rushingTd },
    { label: "Receptions", points: stats.receptions * r.receptionPoints },
    { label: "Receiving yards", points: stats.receivingYards * r.receivingYardsPerPoint },
    { label: "Receiving TDs", points: stats.receivingTds * r.receivingTd },
    { label: "Return TDs", points: stats.specialTeamsTds * r.specialTeamsTd },
    { label: "2-point conversions", points: twoPointConversions * r.twoPointConversion },
    { label: "Fumbles lost", points: stats.fumblesLost * r.fumbleLost },
  ]);
}

/** Scores a kicker. Field goals are worth more from distance, which the bands encode. */
export function scoreKicker(stats: KickerStatLine, rules: ScoringRules): ScoreBreakdown {
  const r = rules.kicker;
  return breakdown([
    { label: "FG 0-19", points: stats.made0to19 * r.fg0to19 },
    { label: "FG 20-29", points: stats.made20to29 * r.fg20to29 },
    { label: "FG 30-39", points: stats.made30to39 * r.fg30to39 },
    { label: "FG 40-49", points: stats.made40to49 * r.fg40to49 },
    { label: "FG 50-59", points: stats.made50to59 * r.fg50to59 },
    { label: "FG 60+", points: stats.made60plus * r.fg60plus },
    { label: "FGs missed", points: stats.missed * r.fgMissed },
    { label: "Extra points", points: stats.patMade * r.patMade },
    { label: "Extra points missed", points: stats.patMissed * r.patMissed },
  ]);
}

/** Scores a team defense, including the tiered points-allowed bonus. */
export function scoreDefense(stats: DefenseStatLine, rules: ScoringRules): ScoreBreakdown {
  const r = rules.defense;
  const terms: ScoreComponent[] = [
    { label: "Sacks", points: stats.sacks * r.sack },
    { label: "Interceptions", points: stats.interceptions * r.interception },
    { label: "Fumble recoveries", points: stats.fumbleRecoveries * r.fumbleRecovery },
    { label: "Defensive TDs", points: stats.defensiveTds * r.defensiveTd },
    { label: "Return TDs", points: stats.specialTeamsTds * r.specialTeamsTd },
    { label: "Safeties", points: stats.safeties * r.safety },
    {
      label: "Points allowed",
      points: resolveTier(stats.pointsAllowed, r.pointsAllowedTiers),
    },
  ];

  if (r.yardsAllowedTiers && stats.yardsAllowed !== null) {
    terms.push({
      label: "Yards allowed",
      points: resolveTier(stats.yardsAllowed, r.yardsAllowedTiers),
    });
  }

  return breakdown(terms);
}
