import { SCORING_PRESETS } from "./presets";
import type { OffenseScoringRules, ScoringRules } from "./types";

/**
 * Deciding which preset a league's scoring actually is.
 *
 * The product supports three exact formats — PPR, half PPR and standard — and cannot
 * represent anything else. That is a harder limit than it looks, because it binds on both
 * halves of a player's value at once: the projection would need re-scoring, and the market
 * half does not exist at all, since average draft position is only published for those three.
 * `docs/draft-validation.md` records it, and #57 is the architecture that would lift it.
 *
 * Until then the only honest answers to "what is this imported league's scoring" are *this
 * preset* and *not one of them*. There is no third answer, and in particular the nearest
 * preset is not one. A league with a tight-end premium imported as PPR is drafted against a
 * board built for rules it does not use, and nothing on the screen would say so.
 *
 * `scoringPresetById` falls back to the default for an unknown id, which is right for a
 * stored preference — the user picked one of three and the id is the whole of it — and wrong
 * for an import, where "nothing matched" is the finding. So the two are separate functions
 * with separate return types, and this one cannot silently answer PPR.
 *
 * ## What is compared, and what is not
 *
 * The **offensive** rules, in full and exactly. They are what the projection model scores,
 * what separates the three presets, and what average draft position is published against.
 *
 * Kicker and defense rules are deliberately not compared. The model projects neither
 * position — `docs/draft-validation.md` says so and this repository will not invent one — and
 * their draft values remain the market's. Their historical outcome bands do depend on the
 * shipped default ladders, so an imported match is explicitly an *offensive* match rather
 * than a claim about the whole league. Refusing an import over a field-goal tier would block
 * a league whose offense is exactly PPR without giving the product a scoring-specific K/D/ST
 * market or projection to use instead; the draft UI discloses that boundary persistently.
 */

/** Every field that has to be known before a comparison means anything. */
const OFFENSE_FIELDS = [
  "passingYardsPerPoint",
  "passingTd",
  "passingInterception",
  "rushingYardsPerPoint",
  "rushingTd",
  "receptionPoints",
  "receivingYardsPerPoint",
  "receivingTd",
  "fumbleLost",
  "twoPointConversion",
  "specialTeamsTd",
] as const satisfies ReadonlyArray<keyof OffenseScoringRules>;

export type ScoringMatch =
  | {
      /** The offensive rules are exactly this preset's. */
      kind: "exact";
      preset: ScoringRules;
    }
  | {
      /**
       * Every field was supplied and no preset matches. The league is playing rules this
       * product cannot represent, and the caller must say so rather than choose the nearest.
       */
      kind: "unsupported";
      /**
       * What differs from the closest preset, as `field: theirs vs ours` lines, and which
       * preset "closest" means. For telling a user *why* their league did not import, which
       * is the difference between a dead end and a decision.
       */
      closest: ScoringRules;
      differences: readonly string[];
    }
  | {
      /**
       * The payload did not carry enough to decide. Distinct from `unsupported`: those rules
       * might be exactly PPR, and answering PPR without having seen the fields would be
       * guessing rather than reading.
       */
      kind: "incomplete";
      missing: readonly string[];
    };

/**
 * Which preset these offensive rules are, if any.
 *
 * Fields are compared by value. A provider that reports one point per twenty-five passing
 * yards as `0.04` matches; one that reports it as `25` does not, and translating the units is
 * the adapter's job rather than this function's — a matcher that guessed at units would turn
 * a unit bug into a silently different league.
 */
export function matchScoringPreset(
  offense: Partial<Record<keyof OffenseScoringRules, number | null | undefined>>,
): ScoringMatch {
  const missing = OFFENSE_FIELDS.filter((field) => {
    const value = offense[field];
    // `!Number.isFinite` rather than a null check, so NaN — which a parsed empty string
    // produces — is missing rather than a value that equals nothing.
    return value == null || !Number.isFinite(value);
  });
  if (missing.length > 0) return { kind: "incomplete", missing };

  for (const preset of SCORING_PRESETS) {
    if (OFFENSE_FIELDS.every((field) => offense[field] === preset.offense[field])) {
      return { kind: "exact", preset };
    }
  }

  // Nothing matched, so name the nearest and say what is different about it. "Nearest" is
  // the fewest differing fields, and ties go to the earlier preset in `SCORING_PRESETS` —
  // deterministic, and not a claim that the nearest is close.
  let closest = SCORING_PRESETS[0];
  let fewest = Infinity;
  for (const preset of SCORING_PRESETS) {
    const differing = OFFENSE_FIELDS.filter(
      (field) => offense[field] !== preset.offense[field],
    ).length;
    if (differing < fewest) {
      fewest = differing;
      closest = preset;
    }
  }
  const differences = OFFENSE_FIELDS.filter(
    (field) => offense[field] !== closest.offense[field],
  ).map((field) => `${field}: ${String(offense[field])} vs ${closest.offense[field]}`);
  return { kind: "unsupported", closest, differences };
}

/**
 * The sentence a user is shown for a match that did not resolve to a preset.
 *
 * `null` for an exact match, so a caller renders nothing rather than a reassurance. Neither
 * message names a preset as the answer — the closest one appears only as the thing being
 * compared against, which is what stops "closest: PPR" reading as "we chose PPR".
 */
export function scoringMatchExplanation(match: ScoringMatch): string | null {
  switch (match.kind) {
    case "exact":
      return null;
    case "incomplete":
      return (
        `This league's scoring could not be read — ${match.missing.length} rule(s) were ` +
        `missing: ${match.missing.join(", ")}. Choose your scoring format manually; nothing ` +
        `has been selected for you.`
      );
    case "unsupported":
      return (
        `This league's scoring is not one of the three formats this board is built for. ` +
        `Against ${match.closest.label} it differs in: ${match.differences.join("; ")}. ` +
        `Choose one of the three manually, and read its recommendations as being for that ` +
        `format rather than for your league's.`
      );
  }
}
