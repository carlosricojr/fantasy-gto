/** League/season rules that every NFL league record needs to carry. */

export const PLAYOFF_FIELDS = [4, 6] as const;

/**
 * Weeks a league can play its final in.
 *
 * Week 17 is where every mainstream platform's default lands, and it is the default here.
 * The two below it are the settings leagues actually change it to, and they change it for
 * a reason the product has to be able to represent: an NFL team with its seed decided
 * rests its starters in the last week or two, so a final played then is decided partly by
 * who happened to be sitting. Moving it earlier is the standard remedy.
 *
 * Week 18 is deliberately not offered. It is an NFL week, so `isNflRegularSeasonWeek`
 * admits it, but it is the week resting is near-universal and no mainstream platform
 * defaults a final into it. Offering it would be offering a season this product cannot
 * model well — and it is why every league here ends before the NFL does.
 *
 * The list stops at three because these are the choices, not a range. `fantasySeasonWeeks`
 * accepts any week; what is *offered* is a product decision and lives here with the other
 * ones.
 */
export const CHAMPIONSHIP_WEEKS = [15, 16, 17] as const;

/** What a league plays unless it says otherwise, and what a pre-existing draft restores as. */
export const DEFAULT_CHAMPIONSHIP_WEEK = 17;
