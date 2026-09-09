# Weekly lineup planner

`/lineup/weekly` imports a Sleeper league's current roster, ordered starters, exact
scoring coefficients, fantasy position eligibility and player designations. Its
server route reads only the documented league, rosters, players and NFL state APIs,
plus nflverse's schedule and current roster identity inputs. The roster import does not request Sleeper projections or submit a lineup. Separate explicit actions can save a private connection or decision record in Convex. This workflow is for the owner's personal leagues; it does not
establish permission for commercial redistribution of any source.

The process caches the full Sleeper player directory for one day, following that API's
guidance, and the nflverse schedule for 15 minutes. Concurrent imports share those
downloads. League/roster/state reads are refreshed each time. A persistent warning
states that directory injury designations can be up to a day old and must be checked
against the final inactive list; refreshing the roster does not claim fresh injury
data. This is a process-local cache, so separate server instances each have their own.

The user-triggered import can also generate weekly skill-position estimates through
the existing FantasyGTO model using nflverse statistics, roster, injury and schedule
inputs. A model value is distinct from the history used to calculate it. Players
without sufficient recent history and unprojected K/DST positions remain unpriced.
Each row identifies its origin and any missing-estimate reason. The model's scoring
omissions and PPR calibration limitation remain immutable metadata, and unknown
source publication times cannot be replaced with a manual date.

Where the nflverse helper supplies a current roster or injury designation, the
planner combines it conservatively with the directory: an Out or inactive player
is excluded, an unknown status blocks advice, and a missing injury row cannot clear
another source's Questionable or Doubtful designation. Fantasy reserve and bye
statuses remain authoritative for their own exclusions.

Missing team/week injury-report coverage is distinct from an unknown player status:
it withholds automatic points without declaring the player healthy or Out. Users
can enter manual points and explicitly opt into an incomplete comparison after
acknowledging that they must verify the final active list. The per-player coverage
warning survives manual entry and roster-only refreshes. Missing coverage cannot
clear an earlier observed Out designation; fresh covered injury evidence is required.

An additional, default-off opt-in can request **active-at-kickoff** forecasts for
otherwise eligible players whose team/week injury report is missing. These pass
the same identity, active-roster, position, scoring, future-game and recent-history
gates. They do not appear for known Out/unknown injury status, unsupported K/DST or
insufficient history. They remain nested conditional evidence: ordinary points stay
null, and ordinary model coverage does not increase. These forecasts are not
availability-adjusted expectations.

The browser overlays these values only while the separate provisional-forecast
checkbox is enabled, gives them a distinct row label, and also requires the existing
incomplete-comparison consent. Disabling the option removes them immediately without
changing ordinary missing points or manual overrides. Roster-only refresh does not
retain the provisional forecasts. They retain all model freshness, scoring-omission,
injury and kickoff safeguards; a prior observed Out designation cannot be bypassed.
On September 9, 2026, the source helper returned 2 ordinary and 10 additional
conditional forecasts for the owner's 16-player roster; the other 4 remained missing.

Users can enter weekly expected points under the displayed scoring rules, replacing
individual model rows with manual overrides. A blank estimate stays missing. It
cannot be replaced with a season
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
an available player's eligibility or an occupied slot's lock. Kickoff team identity
comes from the current nflverse weekly roster joined through its full season player
catalog, including reserves. A cached Sleeper team is not used for locks. A unique
active transaction destination wins over the prior team; conflicting active rows
remain unresolved. When the model and import expose different team/game/kickoff
contexts, the comparison blocks until a consistent refresh resolves them.

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

A separate explicit incomplete-estimates comparison can hold **all** unpriced players
in their current places, including an unpriced FLEX starter or bench alternative.
The result names every excluded player, holds occupied unpriced slots fixed, and
states that those unknown values could change the best full-roster lineup. The same
opt-in permits comparison of partial model estimates with the omitted scoring rules
listed. It never turns those omitted terms into assumed zeros or claims an exact
full-scoring expectation. With no valued players to compare, the result stays blocked.

Refresh preserves entered estimates only when league ID, owner ID, season, week and
exact scoring identity match. Automatic values refresh; manual overrides and their
original entry times persist, including an explicitly cleared value. A changed team,
game, or kickoff clears that player's retained manual estimate and asks for a new
weekly value. New roster
players use their own available estimates; departed players are removed. Refresh
does not advance manual entry time or the source publication time. The browser
retains entered values after a failed refresh but blocks recommendations until a
refresh succeeds. The browser clock updates every second and on focus so a comparison expires and locks advance
while the screen remains open.

Manual entries now persist in this browser for at most 24 hours from their original
entry timestamp. The bounded store retains at most eight exact league/owner/season/week/
scoring contexts and 32 manual rows each. It does not save automatic values, roster
freshness, availability clearance or either consent. A fresh successful import must
precede restoration; expired/future-dated entries, departed players and changed team,
game or kickoff context are discarded. Original source text and publication time remain
unchanged. Storage errors leave the open-page workflow usable with an explicit warning.
The user can clear saved browser entries. Storage is separated by signed-in Clerk
account (or the anonymous browser context); switching accounts clears the displayed
snapshot and consent, and a response started under another account is discarded.
Browser storage is device-local, not an
authenticated private account store; do not use it on a shared browser for private notes.

My leagues now accepts a Sleeper username or league URL. Username lookup resolves the
stable public user ID; a league URL lists roster managers for explicit selection. Saving
rechecks public roster membership server-side, derives the local owner from the Clerk
identity, and stores a private bookmark, not Sleeper credentials or proof of controlling
that external account. Connections and legacy saved leagues share the existing league
cap in the same transaction. Lists are bounded to 100 bookmarks; retries update the
same bookmark rather than consuming a second slot. No subscription is created or changed.
Deleting a Clerk account immediately revokes access and schedules indexed bounded
erasure batches for its saved connections, decisions and outcome observations,
including orphaned observations. The public API exposes no erase-by-user operation.

Dashboard links prefill `/lineup/weekly?leagueId=…&ownerId=…`; explicit week parameters
are validated, and an omitted week resolves the current Sleeper week only when the user
imports. Visiting a URL alone never fetches a roster. Finding a team on the planner
fills its fields but still requires the import button. The saved bookmark's season and
last check are context, not live roster evidence.

The planner shows concrete start/bench/slot actions, grouped expandable input checks and
source warnings, and a local kickoff checklist. The suggested recheck time is 90 minutes
before kickoff, not a claim that every source publishes exactly then. Checkmarks reset
on refresh and never clear injury warnings or unlock started players. No notifications,
notification permissions or automatic submissions are added.

On September 9, 2026, a direct read through the production import function resolved
the owner's requested league to 16 players and 10 starting slots for 2026 week 1.
Every rostered player joined a kickoff;
Michael Pittman's designation was Questionable. These are dated source observations,
not permanent availability assertions.

Verification includes an independent exhaustive assignment oracle across 160 small
rosters; signed points, multi-position eligibility, starter/bench locks, unavailable
players, unknown inputs, duplicate assignments, freshness, exact custom scoring
identity and scoped K/DST handling have targeted tests. The underlying projection
model is unchanged and the reserved 2025 holdout is not evaluated.

## Release verification and remaining friction

September 9 browser QA against a clean local production build exercised ordinary
import (2/16 estimates, no provisional values), enabling the provisional option and
refreshing (10 additional labeled forecasts, ordinary coverage still 2/16), and the
separate incomplete-comparison consent gate. A synthetic manual value survived
disabling provisional forecasts and a same-context ordinary refresh; another
provisional row returned to blank immediately. The test value was discarded by
reloading afterward. A 390px phone viewport had no page-level horizontal overflow;
the roster remains an intentionally horizontally scrollable table. No Sleeper write
action exists or was performed.

The shared desktop/mobile Lineup navigation leads to `/lineup`, whose weekly link
is available even before legacy data loads. My leagues also links to the legacy
optimizer in its empty state. The weekly page is public, but source imports require
sign-in under the later cost-protection policy below.
The workflow follow-up adds username/URL lookup, private saved-connection handoff,
bounded manual-entry restoration, grouped source notes and kickoff checklists. Exact
duplicate messages are removed only from presentation; source evidence remains intact.
Semantically similar provider-ID and named-player messages may still both appear in
expanded detail. A legacy manual league has no external Sleeper identity to prefill;
connect its public Sleeper counterpart explicitly if one exists.

Before the later source-access gate, follow-up QA on September 9 used a local production build and the existing development
backend. Browser interactions resolved the owner's actual username to the intended
league, selected current week 1, and imported 16 roster rows with two ordinary estimates.
A synthetic manual value survived reload only after a fresh same-context import, with
its original millisecond timestamp unchanged; all three comparison options remained off.
The value was then removed using the clear-storage control. At 390px, the page's scroll
width was exactly 390px. The signed-out save and history views withheld private actions;
no hydration error was recorded. Development Clerk's unrelated dashboard-link prefetch
produced a cross-origin sign-in warning. Signed-in production happy-path verification
remains a separate release check; no Sleeper write or subscription change was performed.

The development backend was pushed successfully. Anonymous live calls returned an empty
connection list and explicit unauthenticated rejections for journal listing and waiver
authorization. In-memory backend regressions cover ownership, combined-cap enforcement,
subscription expiry, idempotent decision creation, concurrent outcome throttling,
bounded pagination and account-erasure batches including orphan observations.

## Source access and bounded compute

The later September 9 personal-use cost policy supersedes anonymous import access.
Static/local tools remain public. Authenticated Free accounts can resolve Sleeper
connections and import rosters without automatic model estimates. Pro adds generated
weekly estimates, the narrow waiver comparator and private decision history. Access
is derived from stored subscriptions at server time; no owner identity, subscription
or entitlement is manufactured for the app owner.

Before source I/O, the weekly and connection HTTP routes verify the Clerk session,
obtain its Convex token and call an authenticated admission action. The waiver route
uses the same backend mechanism. Unauthenticated, insufficient-plan and exhausted
requests return 401, 403 and 429; backend outages return 503 without source requests.
Successful admission consumes one allowance even if the upstream later fails.

| Operation | Per fixed 15 minutes | Per UTC day |
| --- | ---: | ---: |
| Connection lookup or saved-connection revalidation | 6 | Free 20 / Pro 60 |
| Roster-only import | 6 | Free 20 / Pro 60 |
| Model import | 6 | Pro 40 |
| Waiver discovery or comparison | 6 | Pro 30 |
| New decision save | 10 | Pro 100 |
| Journal list or detail | 60 | Pro 500 |
| Outcome refresh | 6 | Pro 30 |

Counters are shared across app instances, keyed by authenticated owner and operation,
and reused rather than appended indefinitely. Windows are fixed, so adjacent-window
bursts remain possible. Exact idempotent save retries do not count as new records;
invalid save transactions roll back and do not consume a successful-save allowance.
Outcome refresh retains its additional per-record one-minute append guard. Counter
rows join the bounded account-erasure cascade. Retry errors include server-calculated
timing. These are application-work bounds, not a zero-cost hosting guarantee: rejected
HTTP/Convex calls still use infrastructure, and unrelated public data-query surfaces
need separate hardening. Deployment protection is an independent operational control;
this code does not claim that it has been activated.

Mounted browser-runtime tests cover immediate account-switch remount, all consent
reset, no old-account snapshot reaching new-account Save, and discarded in-flight
imports. Pending authentication sends no source request and does not touch browser
manual storage. Storage is account-namespaced; original timestamps and exact matchup
and context checks remain mandatory after a fresh import.
