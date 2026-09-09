# Weekly lineup planner

`/lineup/weekly` imports a Sleeper league's current roster, ordered starters, exact
scoring coefficients, fantasy position eligibility and player designations. Its
server route reads only the documented league, rosters, players and NFL state APIs,
plus nflverse's schedule. It does not request Sleeper projections, write to Convex,
or submit a lineup. This workflow is for the owner's personal leagues; it does not
establish permission for commercial redistribution of any source.

The process caches the full Sleeper player directory for one day, following that API's
guidance, and the nflverse schedule for 15 minutes. Concurrent imports share those
downloads. League/roster/state reads are refreshed each time. A persistent warning
states that directory injury designations can be up to a day old and must be checked
against the final inactive list; refreshing the roster does not claim fresh injury
data. This is a process-local cache, so separate server instances each have their own.

The first version takes user-entered weekly expected points under the displayed
scoring rules. A blank estimate stays missing. It cannot be replaced with a season
total, ADP-derived draft value, historical average, or an assumed zero. The projection
source and its publication time are separate from the roster retrieval time. Unknown
publication time produces a conditional comparison. Estimates older than 24 hours,
rosters older than 15 minutes, and future timestamps block recommendations. These
are operational cutoffs, not measured claims about forecast accuracy.

The import accepts only Sleeper's current season/week, since the live roster endpoint
does not prove historical starter assignments. It validates ownership, rejects
unsupported starter slots and custom scoring rules, and preserves the provider's
starter order. Best ball and automatic substitution settings are unsupported. Schedule
gaps do not become byes: a bye requires a complete 17-game team schedule and one
unplayed week. Unknown kickoff or availability blocks advice where it could affect
an available player's eligibility or an occupied slot's lock.

`planWeeklyLineup` is a pure subset dynamic program for at most 12 starting slots
and 32 rostered players; larger requests fail before the state search begins. It
maximizes supplied expected points rounded to cents under slot eligibility. It does
not estimate championship probability or optimize realized outcomes. Started players keep their current slots;
started bench players remain on the bench. Out, inactive, bye and reserve players
are excluded before kickoff. Questionable and doubtful players remain candidates
with a visible warning. Among equal-point arrangements, later kickoffs receive
broader slots where possible, preserving flexibility without sacrificing expected
points. Negative projections can make an empty slot the highest-points arrangement;
the interface explicitly shows that empty slot.

Locked starter estimates remain a constant in both compared totals. They are not
live scoreboard values, and the interface does not claim a points-to-date total.

An explicit checkbox can hold unpriced kicker and defense slots fixed. Their values
remain null and are excluded from both current and proposed totals and gains. This
is a scoped comparison, not a full-roster optimum. The mechanism cannot hide an
unpriced FLEX tradeoff: any unpriced player eligible for a compared slot still blocks
the recommendation.

Refresh preserves entered estimates only when league ID, owner ID, season, week and
exact scoring identity match. New roster players need estimates; departed players
are removed. Refresh does not advance the projection publication time. The browser
clock updates every second and on focus so a comparison expires and locks advance
while the screen remains open. No point entries are persisted across browser reloads.

On September 9, 2026, a direct read through the production import function resolved
the requested league `1389387330229374976` and owner `1260318953792602112` to 16
players and 10 starting slots for 2026 week 1. Every rostered player joined a kickoff;
Michael Pittman's designation was Questionable. These are dated source observations,
not permanent availability assertions.

Verification includes an independent exhaustive assignment oracle across 160 small
rosters; signed points, multi-position eligibility, starter/bench locks, unavailable
players, unknown inputs, duplicate assignments, freshness, exact custom scoring
identity and scoped K/DST handling have targeted tests. The underlying projection
model is unchanged and the reserved 2025 holdout is not evaluated.
