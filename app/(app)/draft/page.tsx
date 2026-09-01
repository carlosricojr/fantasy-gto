"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useQuery } from "convex/react";

import { api } from "@/convex/_generated/api";
import { PageShell } from "@/components/page-shell";
import { useStableQuery } from "@/components/use-stable-query";
import { Button } from "@/components/ui/button";
import { normalizeLeagueSetup, pickOwnership, seatForTeamIndex } from "@/lib/core/draft";
import type { DraftPolicyState, DraftTeam } from "@/lib/core/draft-policy";
import type { PlayerRisk } from "@/lib/core/roster-utility";
import { type LeagueConfig, fantasySeasonWeeks } from "@/lib/core/season-sim";
import { cn } from "@/lib/utils";
import {
  ROSTER_TEMPLATES,
  UNPROJECTED_POSITIONS,
  slotsForTemplate,
  waiverWireCover,
} from "@/lib/nfl/roster";
import { draftSeasonFor } from "@/lib/nfl/season";
import {
  RECOMMEND_CANDIDATES,
  RECOMMEND_SCENARIOS,
  RECOMMEND_SEED,
} from "@/lib/nfl/draft/engine-config";
import { boardHealth, describeBoardHealth } from "@/lib/nfl/draft/refresh-plan";
import { adpSourceLabel } from "@/lib/nfl/draft/league-size";
import { DEFAULT_SCORING, SCORING_PRESETS } from "@/lib/nfl/scoring/presets";
import { basisForPosition, valueBasis } from "@/lib/nfl/draft/provenance";
import { perGameRate } from "@/lib/nfl/draft/value";
import {
  appendSleeperIdentityRepair,
  reconcileSleeperDraft,
  type SleeperReconciliation,
} from "@/lib/nfl/draft/sleeper-sync";
import { importSleeperSetup } from "@/lib/nfl/draft/sleeper-import";
import type { PlayerIdentity } from "@/lib/nfl/draft/provider-identity";
import { SleeperDraftPoller, SleeperDraftProvider } from "@/lib/sources/sleeper";

import { BoardGrid } from "./board-grid";
import { describeTurn, nextPickFor, pickLabel, picksUntilTurn } from "./board-view";
import type { LeagueSettings } from "./league-form";
import { MyTeam } from "./my-team";
import {
  DEFAULT_CHAMPIONSHIP_WEEK,
  DRAFT_STORAGE_KEY,
  LEAGUE_SIZES,
  MAX_ROUNDS,
  PLAYOFF_FIELDS,
  type PersistedDraft,
  type PersistedSleeperSync,
  nextPick,
  parsePersistedDraft,
} from "./persistence";
import { PlayerDetail } from "./player-detail";
import { PlayerPool } from "./player-pool";
import {
  type PoolPlayer,
  neededPositions,
  unfilledSlots,
  unrankedAdpFor,
} from "./pool-view";
import { QueuePanel } from "./queue-panel";
import { describeSeason } from "./season-label";
import { leagueFingerprint } from "./reply-gate";
import { Recommendations } from "./recommendations";
import { SettingsDialog } from "./settings-dialog";
import { DraftSetup } from "./setup";
import { StatusBar } from "./status-bar";
import { useRecommendations } from "./use-recommendations";

/**
 * The draft board.
 *
 * Tracks every team's picks, not only yours, because the objective is the probability of
 * winning the league and that depends on who your opponents actually drafted. The board
 * is the source of truth and nothing is inferred.
 *
 * What it will not do is claim to know better than the market which players are good. That
 * was measured and it is not true — see `/accuracy` and `docs/draft-validation.md`. What it
 * does is answer the question average draft position structurally cannot: given *your*
 * roster, *your* league's slots and *your* remaining picks, which player leaves you most
 * likely to win.
 *
 * ## Why the layout is what it is
 *
 * This screen used to be a search box and a recommendation list, with the two swapping
 * places depending on whose turn it was. Everything else it knew — the grid of who took
 * what, the two hundred players still on the board, what the roster was actually missing,
 * how likely a player was to last until your next pick — was computed, held in memory and
 * never shown. Three quarters of this file's data was invisible.
 *
 * It is now four surfaces, in the order a manager uses them: what to take, what has gone,
 * who is left, and what you have. The swap is gone with them. One list serves both jobs —
 * taking a player on your turn and recording somebody else's on theirs — with the row's
 * button naming which it is doing, which is what the swapping panels were an attempt to
 * express and could not, because "the first thing on the screen is the only thing on the
 * screen" is a fact about phones that reordering the page under the reader does not fix.
 */

/**
 * Seed, scenario count and candidate count live in `lib/nfl/draft/engine-config.ts`,
 * shared with the mock-draft harness so `pnpm draft-mock` provably runs this page's own
 * engine settings — re-declared copies here were PR #92's recorded drift risk.
 *
 * `CANDIDATES` is a named import rather than a literal at the call site also because the
 * panel's loading skeleton is sized from it: a placeholder that is not the height of what
 * replaces it is a layout shift dressed as a courtesy.
 */
const SEED = RECOMMEND_SEED;
const SCENARIOS = RECOMMEND_SCENARIOS;
const CANDIDATES = RECOMMEND_CANDIDATES;

interface BoardPlayer {
  playerId: string;
  sleeperId?: string;
  name: string;
  position: string;
  team: string | null;
  modelPoints: number | null;
  blendedPoints: number;
  marketPoints: number | null;
  marketValueBasis: "adp-ordered" | "position-mean" | "pooled-mean" | null;
  adp: number | null;
  adpStdev: number | null;
  byeWeek: number | null;
  availability: number;
  p10: number;
  p90: number;
}

/**
 * What `boardFreshness` returns.
 *
 * More than a timestamp, because a board whose last rebuild *failed* looks perfectly
 * healthy in one: the failed run leaves the previous board intact, which is correct and is
 * exactly why the failure is invisible.
 */
interface BoardFreshness {
  computedAt: number | null;
  adpSourceTeams: number | null;
  lastAttemptAt: number | null;
  lastAttemptStatus: "running" | "succeeded" | "failed" | null;
}

export default function DraftPage() {
  const [teams, setTeams] = useState(12);
  const [rounds, setRounds] = useState(15);
  const [slot, setSlot] = useState(1);
  const [scoringId, setScoringId] = useState(DEFAULT_SCORING.id);
  const [templateId, setTemplateId] = useState(ROSTER_TEMPLATES[0].id);
  /**
   * Whether the user *chose* a scoring format rather than accepting the preselected one.
   *
   * PPR arrives selected because a control has to show something and it is the commonest
   * format. That is a reasonable default for a control and a bad one for a decision: a
   * standard-scoring league that taps past it drafts against a board built for rules it
   * does not play, and every value on that board is wrong in a way that reads as surprising
   * rather than as an error. The draft cannot start until the format has been touched.
   */
  const [scoringConfirmed, setScoringConfirmed] = useState(false);
  const [started, setStarted] = useState(false);
  const [playoffTeams, setPlayoffTeams] = useState<number>(6);
  /**
   * The week this league plays its final.
   *
   * With `playoffTeams` it decides every week the season is simulated over — see
   * `fantasySeasonWeeks`. It was a pair of literals here (weeks 1-14, playoffs 15-17) for
   * every league, which is one real setting out of the several leagues use, and the way it
   * was wrong was invisible: a league whose final is in week 15 plays its semi-final in
   * week 14, and the byes that land there were being priced as ordinary regular-season
   * weeks rather than as a round that decides the title.
   */
  const [championshipWeek, setChampionshipWeek] = useState<number>(
    DEFAULT_CHAMPIONSHIP_WEEK,
  );

  /** Overall pick number to the team index that made it. Index 0 is always the user. */
  const [picks, setPicks] = useState<Record<number, string>>({});
  const [queue, setQueue] = useState<string[]>([]);
  const [sleeper, setSleeper] = useState<PersistedSleeperSync | null>(null);
  const [sleeperDraftId, setSleeperDraftId] = useState("");
  const [sleeperMessage, setSleeperMessage] = useState<string | null>(null);
  const [sleeperRetry, setSleeperRetry] = useState(0);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  /** A request from the board to reveal one player in the pool. See `PlayerPool.focus`. */
  const [focus, setFocus] = useState<{ playerId: string; drafted: boolean } | null>(null);
  const [boardOpen, setBoardOpen] = useState(true);

  // A draft survives a remount. The error boundary's "Try again" re-renders this segment,
  // which reinitializes every `useState` above — without this, retrying after a crash
  // loses the whole board, which is precisely when the user can least afford it.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    const stored = parsePersistedDraft(
      typeof window === "undefined" ? null : window.sessionStorage.getItem(DRAFT_STORAGE_KEY),
    );
    if (stored !== null) {
      setTeams(stored.teams);
      setRounds(stored.rounds);
      setSlot(stored.slot);
      setScoringId(stored.scoringId);
      setScoringConfirmed(stored.scoringConfirmed);
      setTemplateId(stored.templateId);
      setPlayoffTeams(stored.playoffTeams);
      setChampionshipWeek(stored.championshipWeek);
      setStarted(stored.started);
      setPicks(stored.picks);
      setQueue(stored.queue);
      setSleeper(stored.sleeper);
    }
    setRestored(true);
  }, []);

  useEffect(() => {
    // Gated on `restored` so the defaults this component mounts with cannot overwrite a
    // stored draft in the tick before the effect above has read it.
    if (!restored || typeof window === "undefined") return;
    const payload: PersistedDraft = {
      teams,
      rounds,
      slot,
      scoringId,
      scoringConfirmed,
      templateId,
      playoffTeams,
      championshipWeek,
      started,
      picks,
      queue,
      sleeper,
    };
    try {
      window.sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // A full or disabled store is not worth taking the board down for. The draft still
      // works; it just will not survive a remount.
    }
  }, [
    restored,
    teams,
    rounds,
    slot,
    scoringId,
    scoringConfirmed,
    templateId,
    playoffTeams,
    championshipWeek,
    started,
    picks,
    queue,
    sleeper,
  ]);

  // The season being drafted is the one after the last completed one, resolved from the
  // schedule rather than hardcoded — a literal year silently serves last season's board
  // once the calendar rolls over.
  const seasonState = useQuery(api.season.current, {});
  // `undefined` is the query in flight; `null` is a resolved answer that there is no
  // season. Collapsing both to null left the page showing "Loading the board…" for ever
  // when the schedule had not been ingested, with nothing said and nothing to do.
  const seasonLoading = seasonState === undefined;
  // The same function the rebuild cron uses, so the board being read and the board being
  // built are always for the same season. They diverged once, and the cron was the one that
  // was wrong: it rebuilt nothing for the whole preseason.
  const season = seasonState === undefined ? null : draftSeasonFor(seasonState);

  // Lowering the league size after choosing a slot left `slot > teams`, and `snakePicks`
  // then produced the pick set of a different seat. Because the owner map is written
  // team-0-first and last write wins, that other team overwrote every one of the user's
  // picks: they owned nothing for the whole draft, "Your roster" never filled, and every
  // recommendation was computed for a team that could not pick. Nothing said so.
  // One place decides what a valid setup is, and it is tested. Ad-hoc clamping at each
  // input is how a fractional slot slipped past two separate guards.
  const setup = useMemo(
    () =>
      normalizeLeagueSetup(
        { teams, slot, rounds },
        {
          minTeams: LEAGUE_SIZES[0],
          maxTeams: LEAGUE_SIZES[LEAGUE_SIZES.length - 1],
          maxRounds: MAX_ROUNDS,
        },
      ),
    [teams, slot, rounds],
  );

  // `setup.teams` rather than `teams`. A restored draft carries whatever whole number was
  // stored, and while `setup` clamps it for ownership, pick counts and rosters, the board
  // query read the raw value — so an out-of-range league fetched one board shape and drew
  // the seats of another.
  // `useStableQuery`, not `useQuery`. A Convex result is keyed by its arguments, so
  // changing the scoring format returns `undefined` — the same value as before anything
  // has ever loaded — and the first-load branch below unmounted this entire screen,
  // including the settings dialog the change had just been made in. The previous board
  // stays on screen instead, marked as belonging to the previous setup.
  const { data: board, pending: boardPending } = useStableQuery(
    api.draft.board,
    season === null ? "skip" : { season, scoringId, teams: setup.teams },
  );
  const { data: freshness, pending: freshnessPending } = useStableQuery(
    api.draft.boardFreshness,
    season === null ? "skip" : { season, scoringId, teams: setup.teams },
  );
  // Two independent subscriptions, so one can settle before the other — and each surface
  // is marked by the one it actually reads. Marking a settled board as the previous
  // selection's because a *freshness* query is still in flight is a false statement in the
  // other direction, and this page is not allowed either of them.
  //
  //   boardPending      the rows: their projections, ADP, availability, and the count
  //   freshnessPending  the build timestamp, the ADP source, the health of the last rebuild
  //   describesHeldBoard  a sentence built from both, which needs both to have settled
  const describesHeldBoard = boardPending || freshnessPending;

  const recommender = useRecommendations();

  useEffect(() => {
    if (setup.teams !== teams) setTeams(setup.teams);
    if (setup.slot !== slot) setSlot(setup.slot);
    if (setup.rounds !== rounds) setRounds(setup.rounds);
    // The playoff buttons are filtered by `field < teams`, but the chosen value was never
    // re-checked. Picking 6 in an eight-team league and then shrinking the league left it
    // at 6 with no button showing as selected — and, worse, that stale value went into
    // `LeagueConfig`, so every recommendation was computed against a playoff field the
    // league could not field.
    if (!PLAYOFF_FIELDS.some((field) => field === playoffTeams && field < setup.teams)) {
      const usable = [...PLAYOFF_FIELDS].filter((field) => field < setup.teams);
      if (usable.length > 0) setPlayoffTeams(usable[usable.length - 1]);
    }
  }, [setup, teams, slot, rounds, playoffTeams]);

  const starters = useMemo(() => slotsForTemplate(templateId), [templateId]);

  const pool = useMemo<PlayerRisk[]>(
    () =>
      ((board ?? []) as BoardPlayer[]).map((row) => ({
        id: row.playerId,
        name: row.name,
        position: row.position,
        // Points per game *played*, which is what `PlayerRisk.weeklyMean` means. See
        // `perGameRate` for why dividing by a full season here discounted twice.
        weeklyMean: perGameRate(row.blendedPoints, row.availability),
        p10: row.p10,
        p90: row.p90,
        byeWeek: row.byeWeek,
        availability: row.availability,
        adp: row.adp,
        adpStdev: row.adpStdev,
      })),
    [board],
  );

  const byId = useMemo(() => new Map(pool.map((p) => [p.id, p])), [pool]);
  const boardIdentities = useMemo<PlayerIdentity[]>(
    () =>
      ((board ?? []) as BoardPlayer[]).map((player) => ({
        id: player.playerId,
        providerId: player.sleeperId ?? null,
        name: player.name,
        position: player.position,
        team: player.team,
        // The board query does not expose rookie metadata; #60's deterministic matcher
        // does not use it for live-pick matching, so never infer it from a name or season.
        rookie: false,
      })),
    [board],
  );

  // Ownership comes from `lib/core/draft.ts`, where it is tested against the invariant
  // that every pick in the draft has exactly one owner, for every league shape. It was
  // inlined here once and silently gave one seat's picks to another.
  const pickOwners = useMemo(
    // `slot` is clamped above, but a render can happen between the state update and the
    // effect, so an out-of-range slot must not throw the page down.
    () => pickOwnership(setup.teams, setup.slot, setup.rounds),
    [setup],
  );

  // Everything downstream reads the normalized setup, not the raw inputs. A mid-keystroke
  // value that disagrees with the ownership map produces picks nobody owns, and a player
  // recorded against one of those is never marked as taken — he stays on the board and
  // keeps being recommended after he is gone.
  const totalPicks = setup.teams * setup.rounds;
  const sleeperReconciliation = useMemo<SleeperReconciliation | null>(
    () =>
      sleeper === null
        ? null
        : reconcileSleeperDraft({
            prior: { providerPicks: sleeper.providerPicks, repairs: sleeper.repairs },
            incoming: [],
            board: boardIdentities,
            localPicks: picks,
            expectedPickCount: totalPicks,
            providerStatus: sleeper.status,
          }),
    [sleeper, boardIdentities, picks, totalPicks],
  );
  // Provider matches fill an empty local board; a local correction remains in place until
  // the explicit conflict repair chooses the provider match. Neither side is overwritten.
  const activePicks = useMemo(
    () => (sleeperReconciliation === null ? picks : { ...sleeperReconciliation.acceptedPicks, ...picks }),
    [sleeperReconciliation, picks],
  );
  const currentPick = useMemo(() => nextPick(activePicks, totalPicks), [activePicks, totalPicks]);

  const sleeperPollDraftId = sleeper?.draftId ?? null;
  const sleeperPollRepairKey = sleeper?.repairs
    .map((repair) => `${repair.repairId}:${repair.pickKey}:${repair.boardPlayerId}`)
    .join("|") ?? "";
  const sleeperRef = useRef<PersistedSleeperSync | null>(sleeper);
  useEffect(() => {
    sleeperRef.current = sleeper;
  }, [sleeper]);
  useEffect(() => {
    const currentSleeper = sleeperRef.current;
    if (currentSleeper === null || sleeperPollDraftId === null || boardPending) return;
    let history = {
      providerPicks: currentSleeper.providerPicks,
      repairs: currentSleeper.repairs,
    };
    const poller = new SleeperDraftPoller();
    const handle = poller.start({
      draftId: sleeperPollDraftId,
      onUpdate: (update) => {
        const reconciled = reconcileSleeperDraft({
          prior: history,
          incoming: update.picks,
          board: boardIdentities,
          localPicks: picks,
          expectedPickCount: totalPicks,
          providerStatus: update.settings.status,
        });
        history = reconciled.history;
        setSleeper((previous) =>
          previous === null || previous.draftId !== sleeperPollDraftId
            ? previous
            : {
                ...previous,
                status: update.settings.status,
                lastSyncedAt: Date.now(),
                providerPicks: reconciled.history.providerPicks,
                repairs: reconciled.history.repairs,
              },
        );
        setSleeperMessage(
          reconciled.cleanCompletion
            ? "Sleeper reports a complete draft; every pick and identity reconciled. Polling stopped."
            : null,
        );
        return reconciled.cleanCompletion;
      },
      onError: (reason, retryInMs) => {
        setSleeperMessage(`${reason} Retrying in ${Math.ceil(retryInMs / 1000)} seconds.`);
      },
    });
    return handle.cancel;
  }, [
    sleeperPollDraftId,
    sleeperPollRepairKey,
    boardPending,
    boardIdentities,
    picks,
    totalPicks,
    sleeperRetry,
  ]);

  const onTheClock = pickOwners.get(currentPick) === 0;
  const draftComplete = currentPick > totalPicks;

  const turn = useMemo(
    () =>
      describeTurn({
        currentPick,
        totalPicks,
        teams: setup.teams,
        slot: setup.slot,
        owner: pickOwners.get(currentPick),
      }),
    [currentPick, totalPicks, setup, pickOwners],
  );

  /** Which pick each recorded player went at, and who took them. */
  const pickedBy = useMemo(() => {
    const out = new Map<string, { pick: number; owner: string }>();
    for (const [pick, playerId] of Object.entries(activePicks)) {
      const team = pickOwners.get(Number(pick));
      if (team === undefined) continue;
      out.set(playerId, {
        pick: Number(pick),
        owner: team === 0 ? "You" : `Seat ${seatForTeamIndex(team, setup.slot)}`,
      });
    }
    return out;
  }, [activePicks, pickOwners, setup]);

  /**
   * The board as the interface consumes it: every player, available or gone.
   *
   * Drafted players stay in the list rather than being filtered out of it. Checking that a
   * pick was recorded against the right person is the one repair a manager can make under
   * a clock, and it was impossible before — a mis-typed name simply vanished.
   */
  const poolPlayers = useMemo<PoolPlayer[]>(
    () =>
      ((board ?? []) as BoardPlayer[]).map((row, index) => {
        const taken = pickedBy.get(row.playerId);
        return {
          id: row.playerId,
          name: row.name,
          position: row.position,
          team: row.team,
          byeWeek: row.byeWeek,
          seasonPoints: row.blendedPoints,
          modelPoints: row.modelPoints,
          marketPoints: row.marketPoints,
          marketValueBasis: row.marketValueBasis,
          adp: row.adp,
          adpStdev: row.adpStdev,
          availability: row.availability,
          // Where this row's number came from, decided by the board's own columns rather
          // than guessed from the position at render time — a rookie with no prior games is
          // market-only for a different reason than a kicker is, and the row says which.
          basis: valueBasis(row),
          // The board arrives sorted by blended value, so position in it *is* the rank.
          overallRank: index + 1,
          draftedAt: taken?.pick ?? null,
          draftedBy: taken?.owner ?? null,
        };
      }),
    [board, pickedBy],
  );

  const poolById = useMemo(
    () => new Map(poolPlayers.map((player) => [player.id, player])),
    [poolPlayers],
  );

  /**
   * The basis for a player the recommendation panel holds.
   *
   * A `PlayerRisk` carries the quantiles but not their source, so the board is consulted
   * first and the position is only the fallback — which is what distinguishes a rookie with
   * no history from a kicker the model does not cover.
   */
  const basisFor = useCallback(
    (player: { id: string; position: string }) =>
      poolById.get(player.id)?.basis ?? basisForPosition(player.position),
    [poolById],
  );

  const draftState = useMemo<DraftPolicyState | null>(() => {
    if (pool.length === 0) return null;
    const rosters: PlayerRisk[][] = Array.from({ length: setup.teams }, () => []);
    const taken = new Set<string>();
    for (const [pick, playerId] of Object.entries(activePicks)) {
      const team = pickOwners.get(Number(pick));
      const player = byId.get(playerId);
      // A restored draft can name a player the current board no longer carries — the
      // refresh cron can drop somebody between sessions. The pick keeps its slot rather
      // than being deleted: the alternative shifts every later pick up one and reassigns
      // them to different seats, which corrupts the whole draft to tidy up one row.
      if (team === undefined || player === undefined) continue;
      rosters[team].push(player);
      taken.add(playerId);
    }

    const draftTeams: DraftTeam[] = rosters.map((roster, index) => ({
      id: `t${index}`,
      name: index === 0 ? "You" : `Seat ${seatForTeamIndex(index, setup.slot)}`,
      roster,
      remainingPicks: [...pickOwners.entries()]
        .filter(([pick, team]) => team === index && pick >= currentPick)
        .map(([pick]) => pick)
        .sort((a, b) => a - b),
    }));

    return {
      teams: draftTeams,
      myTeamIndex: 0,
      available: pool.filter((p) => !taken.has(p.id)),
      rosterSize: setup.rounds,
    };
  }, [pool, activePicks, pickOwners, byId, setup, currentPick]);

  // Derived from the league's own final rather than written out. The literals this
  // replaces — weeks 1-14 with a three-week bracket — describe one real setting and were
  // applied to every league: a four-team field got a third playoff round, and because the
  // bracket is consumed from the front it played weeks 15 and 16 and never reached 17 — so
  // week 15 was spent as a playoff round instead of closing the regular season, and the week
  // the league called its final went unplayed. A league ending in week 15 got its semi-final
  // priced as an ordinary week 14,
  // where a dozen NFL teams are on bye.
  const config = useMemo<LeagueConfig>(
    () => ({
      slots: starters,
      ...fantasySeasonWeeks(championshipWeek, playoffTeams),
      playoffTeams,
      scenarios: SCENARIOS,
      meanAbsenceWeeks: 3,
      wireCover: waiverWireCover(setup.teams, starters),
      unprojectedPositions: UNPROJECTED_POSITIONS,
    }),
    [starters, playoffTeams, championshipWeek, setup.teams],
  );

  // Before anything is requested, and whether or not anything can be. Changing the scoring
  // format re-queries the board, and no request goes out until the new one lands — which is
  // exactly the window in which the previous format's recommendations used to sit on screen
  // unmarked.
  //
  // This used to say `draftState` is null while the board reloads. It is not, and has not
  // been since the page started holding the previous board to keep itself mounted: the
  // state is non-null and describes the *previous* league. The `boardPending` guard below
  // is what withholds the request now, and the difference matters to anyone deciding
  // whether that guard is load-bearing. It is.
  const fingerprint = leagueFingerprint({
    season,
    scoringId,
    templateId,
    teams: setup.teams,
    rounds: setup.rounds,
    // The season shape, so an answer computed for one bracket cannot sit on screen under
    // another. These are not passed through `config` because the fingerprint has to be a
    // primitive tuple; `config` is derived from exactly these two.
    playoffTeams,
    championshipWeek,
  });
  useEffect(() => {
    recommender.retargetTo(fingerprint);
    // `recommender.retargetTo` is stable; depending on the whole object would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint]);

  // Recompute whenever the board changes, including while opponents are picking — the
  // answer for a future position is worth having before the turn arrives.
  useEffect(() => {
    if (!started || draftState === null) return;
    // Never off a held board. This is the invariant `use-recommendations.ts` was written
    // against and describes in its own docblock: while the board query was reloading it
    // returned `undefined`, `draftState` was null, and no request could go out. Holding the
    // board removed that by construction — and the reply gate cannot see the difference,
    // because it is retargeted to the *selected* league the moment the format changes. So a
    // request built from the previous format's projections, sent during the reload by a
    // recorded pick or a Rounds change in the same open dialog, comes back stamped as the
    // new league's: applied, not stale, and printed as championship odds with no marker on
    // them. Odds the code did not compute for the state on screen are the one thing this
    // project refuses to render, so the request waits for the board it belongs to.
    if (boardPending) return;
    if (draftState.available.length === 0) return;
    // A finished draft still changes `draftState` on the last pick, and the pool is never
    // empty — drafted players are a small slice of the board — so without this the worker
    // ran a full season simulation for a draft that was over, and the panel went on
    // advising a pick for a clock nobody is on.
    if (draftComplete) return;
    recommender.request(draftState, config, SEED, CANDIDATES);
    // `recommender.request` is stable; depending on the whole object would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, draftState, config, draftComplete, boardPending]);

  // Memoized rather than defaulted inline. `?? []` builds a new array on every render
  // where the draft state is absent, which makes it a fresh dependency each time and
  // re-solves the roster's slot assignment on renders where nothing changed.
  const myRoster = useMemo(() => draftState?.teams[0].roster ?? [], [draftState]);
  const myRemainingPicks = draftState?.teams[0].remainingPicks ?? [];
  const nextOwnPick = nextPickFor(pickOwners, 0, currentPick);
  const untilTurn = picksUntilTurn(pickOwners, 0, currentPick);
  // "Will he last?" is always about the turn *after* the one being decided now. On your own
  // turn `nextOwnPick` is the pick you are making, and asking whether a player survives
  // until the moment you take him is not a question anybody has — the column read "83%
  // lasts to 17" on pick 17.
  const waitPick = nextPickFor(pickOwners, 0, onTheClock ? currentPick + 1 : currentPick);
  const waitPickLabel = waitPick === null ? null : pickLabel(waitPick, setup.teams);
  const unrankedAdp = unrankedAdpFor(totalPicks);
  const needs = useMemo(() => neededPositions(starters, myRoster), [starters, myRoster]);

  const rosterPicks = useMemo(
    () => new Map([...pickedBy].map(([playerId, taken]) => [playerId, taken.pick])),
    [pickedBy],
  );

  // Both of these do their work inside the updater, on the state it is handed. Reading
  // `currentPick` from this render instead let two clicks arriving before a re-render write
  // the same key: the second player overwrote the first, and the first stayed on the board.
  const record = useCallback(
    (playerId: string) => {
      setPicks((previous) => {
        const combined =
          sleeperReconciliation === null
            ? previous
            : { ...sleeperReconciliation.acceptedPicks, ...previous };
        if (Object.values(combined).includes(playerId)) return previous;
        const target = nextPick(combined, totalPicks);
        if (target > totalPicks) return previous;
        return { ...previous, [target]: playerId };
      });
      // The queue is deliberately *not* pruned here. `QueuePanel` already hides anyone
      // drafted, so a taken player disappears from it either way — but removing the id
      // outright made Undo asymmetric: correcting a mis-recorded pick brought the pick
      // back and left the player un-starred, at the exact moment a manager is repairing a
      // mistake under a clock. Keeping the id means undo restores the queue with it.
      setFocus(null);
    },
    [totalPicks, sleeperReconciliation],
  );

  const undo = useCallback(() => {
    setPicks((previous) => {
      const lastManualPick = Math.max(0, ...Object.keys(previous).map(Number));
      if (lastManualPick === 0) return previous;
      const next = { ...previous };
      delete next[lastManualPick];
      return next;
    });
    // Cleared for the same reason it is cleared on record: the highlight refers to a board
    // cell whose contents just changed.
    setFocus(null);
  }, []);

  const toggleQueue = useCallback((playerId: string) => {
    setQueue((previous) =>
      previous.includes(playerId)
        ? previous.filter((id) => id !== playerId)
        : [...previous, playerId],
    );
  }, []);

  const selectBoardPick = useCallback(
    (pick: number) => {
      const playerId = activePicks[pick];
      if (playerId === undefined) return;
      // A board cell only ever holds a player who has been taken, so `drafted` is settled
      // here rather than looked up in the pool — which is what lets the pool act on this
      // without depending on a list that changes every pick.
      //
      // A fresh object every time, and identity is what marks it as a new request — so
      // clicking the same cell twice asks twice. A counter was tried and was wrong: it
      // restarted at 1 whenever `record` or `undo` cleared the focus, so the pool, having
      // already handled a request numbered 1, silently ignored the next one.
      setFocus({ playerId, drafted: true });
    },
    [activePicks],
  );

  const swapInQueue = useCallback((a: string, b: string) => {
    setQueue((previous) => {
      const from = previous.indexOf(a);
      const to = previous.indexOf(b);
      if (from === -1 || to === -1) return previous;
      const next = [...previous];
      [next[from], next[to]] = [next[to], next[from]];
      return next;
    });
  }, []);

  const settings: LeagueSettings = {
    teams,
    rounds,
    slot,
    playoffTeams,
    championshipWeek,
    scoringId,
    templateId,
  };

  function applySettings(patch: Partial<LeagueSettings>): void {
    if (patch.teams !== undefined) setTeams(patch.teams);
    if (patch.rounds !== undefined) setRounds(patch.rounds);
    if (patch.slot !== undefined) setSlot(patch.slot);
    if (patch.playoffTeams !== undefined) setPlayoffTeams(patch.playoffTeams);
    if (patch.championshipWeek !== undefined) setChampionshipWeek(patch.championshipWeek);
    if (patch.scoringId !== undefined) {
      setScoringId(patch.scoringId);
      // Touching the control *is* the confirmation. The format decides the whole board, so
      // it is asked for rather than assumed — see `scoringConfirmed`.
      setScoringConfirmed(true);
    }
    if (patch.templateId !== undefined) setTemplateId(patch.templateId);
  }

  async function connectSleeper(): Promise<void> {
    const draftId = sleeperDraftId.trim();
    if (draftId === "") {
      setSleeperMessage("Enter the Sleeper draft ID from its URL.");
      return;
    }
    setSleeperMessage("Checking Sleeper settings…");
    const result = await new SleeperDraftProvider().settings(draftId);
    if (!result.ok) {
      setSleeperMessage(result.reason);
      return;
    }
    const imported = importSleeperSetup(result.data);
    if (!imported.exact || imported.settings === null) {
      setSleeperMessage(
        `Sleeper settings were not imported: ${imported.unsupported.join(", ")}. No local preset was selected.`,
      );
      return;
    }
    setTeams(imported.settings.teams);
    setRounds(imported.settings.rounds);
    setScoringId(imported.settings.scoringId);
    setTemplateId(imported.settings.templateId);
    setScoringConfirmed(true);
    setSleeper({
      draftId,
      status: result.data.status,
      lastSyncedAt: null,
      providerPicks: [],
      repairs: [],
    });
    setSleeperMessage(
      `Connected to Sleeper. ${imported.settings.pickTimerSeconds === null ? "No provider timer was supplied." : `Provider timer: ${imported.settings.pickTimerSeconds} seconds.`}`,
    );
    setStarted(true);
  }

  function repairSleeperIdentity(pickKey: string, boardPlayerId: string): void {
    setSleeper((previous) =>
      previous === null
        ? previous
        : {
            ...previous,
            repairs: appendSleeperIdentityRepair(
              { providerPicks: previous.providerPicks, repairs: previous.repairs },
              { repairId: `manual:${pickKey}:${boardPlayerId}`, pickKey, boardPlayerId },
            ).repairs,
          },
    );
  }

  function useProviderConflictPick(pickKey: string, overall: number): void {
    const classification = sleeperReconciliation?.classifications.find(
      (entry) => entry.input.pickKey === pickKey,
    );
    if (classification?.state !== "matched") return;
    setPicks((previous) => {
      // A manual correction may have put this board player at a different overall. Move
      // that local assignment rather than showing one player as drafted twice.
      const withoutSamePlayer = Object.fromEntries(
        Object.entries(previous).filter(([, playerId]) => playerId !== classification.boardPlayerId),
      );
      return { ...withoutSamePlayer, [overall]: classification.boardPlayerId };
    });
  }

  function resetDraft(): void {
    setPicks({});
    setQueue([]);
    setStarted(false);
    // The format has to be confirmed again for the next draft. Carrying the acknowledgement
    // across a reset would let a manager set a league up once and never be asked again.
    setScoringConfirmed(false);
    setFocus(null);
    setDetailId(null);
    setSleeper(null);
    setSleeperMessage(null);
  }

  if (!seasonLoading && season === null) {
    return (
      <PageShell title="Draft" subtitle="No season to draft for">
        <p className="text-sm text-muted-foreground">
          The schedule has not been loaded yet, so there is no season to build a board
          for. This resolves once the next season&rsquo;s schedule is published — there is
          nothing to fix here.
        </p>
      </PageShell>
    );
  }

  // Reached before anything has ever loaded, and no longer on a settings change: the board
  // is held across an argument change by `useStableQuery`, so this branch cannot take the
  // screen away from somebody who is already drafting on it.
  //
  // The skeleton is the shape of what replaces it rather than one grey block, because this
  // is now the only moment the page reflows on its own — a 10rem placeholder followed by a
  // full board is a layout shift the reader did not ask for and cannot anticipate.
  if (season === null || board === undefined) {
    return (
      <PageShell title="Draft" subtitle="Loading the board…" size={started ? "wide" : "default"}>
        <FirstLoadSkeleton started={started} />
      </PageShell>
    );
  }

  // A restored draft arrives with `started: true` and goes straight past the setup screen,
  // where the empty-board message lives. If no board exists for that season, scoring and
  // size — a shape that was never built, or one whose rows have not landed yet — the user
  // met a search box that could never match anything, with nothing to explain it and no
  // control to change the league.
  //
  // `!boardPending`, because `board` is held: an empty *previous* selection would name
  // the *new* one here — "no 2026 board has been built for 12-team ppr yet" about a query
  // that has not come back. Suppressing the same claim on the setup screen without this
  // moved it rather than removed it, since the Start button that reappears there is sticky
  // and lands under the thumb. While the answer is in flight the ordinary board renders,
  // marked as the previous selection's everywhere it shows a number.
  if (started && board.length === 0 && !boardPending) {
    return (
      <PageShell title="Draft" subtitle="No board for this league">
        <p className="text-sm text-muted-foreground">
          No {season} board has been built for {setup.teams}-team{" "}
          {scoringId.replaceAll("_", " ")} yet, so there is nothing to draft from. Boards
          exist for {LEAGUE_SIZES.join(", ")}-team leagues.
        </p>
        <Button className="mt-6" variant="outline" onClick={() => setStarted(false)}>
          Change the league setup
        </Button>
      </PageShell>
    );
  }

  if (!started) {
    return (
      <PageShell
        title="Draft"
        subtitle="Set your league up once. Everything after that is one tap per pick."
      >
        <BoardHealthNotice freshness={freshness ?? null} pending={freshnessPending} />
        <SleeperConnect
          draftId={sleeperDraftId}
          message={sleeperMessage}
          onDraftIdChange={setSleeperDraftId}
          onConnect={() => void connectSleeper()}
        />
        {/* The size and scoring buttons on this screen key the board query too, so it used
            to replace itself with a skeleton on every click. The board is held now, which
            means the count and build date below belong to the previous selection until the
            new one lands — the same fixed-height, always-present line the running board
            uses, for the same reason. */}
      <p
        className="mb-3 h-4 truncate text-xs font-medium text-amber-700 dark:text-amber-300"
        role="status"
      >
        {describesHeldBoard ? (
          <>
            {/* Two lengths and a `truncate` backstop, the same treatment the draft's status
                bar needs for the same reason: at 12px the long sentence runs about 470px,
                which is wider than a phone's content column, and a fixed-height box with a
                sentence wrapping inside it does not push the page down — it renders the
                second line straight over whatever comes next. */}
            <span className="hidden sm:inline">Loading the new selection — the board described below is the previous one.</span>
            <span className="sm:hidden">Board below is the previous selection&rsquo;s.</span>
          </>
        ) : null}
      </p>
        <DraftSetup
          settings={settings}
          onChange={applySettings}
          onStart={() => setStarted(true)}
          boardSize={board.length}
          boardPending={boardPending}
          season={season}
          leagueSizes={LEAGUE_SIZES}
          scoringConfirmed={scoringConfirmed}
        >
          <Caveat
            freshness={freshness ?? null}
            boardSize={board.length}
            teams={setup.teams}
            config={config}
            pending={describesHeldBoard}
          />
        </DraftSetup>
      </PageShell>
    );
  }

  const scoringLabel =
    SCORING_PRESETS.find((preset) => preset.id === scoringId)?.label ?? scoringId;

  return (
    <PageShell
      title="Draft"
      subtitle={`${setup.teams}-team · ${scoringLabel} · snake · ${setup.rounds} rounds · seat ${setup.slot}`}
      size="wide"
    >
      {/* The turn changing is announced, not only shown. The status bar below says whose
          pick it is in a plain paragraph, which a screen reader passes over in silence —
          leaving a user to discover a turn change by finding a button that has changed its
          label. `polite`, so it waits for a pause, and it is the same sentence the bar
          shows rather than a second wording to keep in step. */}
      <p className="sr-only" role="status" aria-live="polite">
        {turn.summary}
      </p>

      <BoardHealthNotice freshness={freshness ?? null} pending={freshnessPending} />

      <StatusBar
        turn={turn}
        pickLabel={draftComplete ? null : pickLabel(currentPick, setup.teams)}
        currentPick={currentPick}
        totalPicks={totalPicks}
        picksUntilTurn={untilTurn}
        nextOwnPickLabel={nextOwnPick === null ? null : pickLabel(nextOwnPick, setup.teams)}
        // Gated on the pick it actually removes, not on the map being non-empty.
        // `currentPick` is the first *empty* pick, so a restored board with a gap in it
        // offered an undo for an entry that did not exist and removed nothing when pressed.
        canUndo={Object.keys(picks).length > 0}
        onUndo={undo}
        onOpenSettings={() => setSettingsOpen(true)}
        // Every value below belongs to the setup the board was built for, which is not the
        // one the controls now show. The page says so rather than redrawing itself: see
        // `useStableQuery`.
        reloading={boardPending}
      />

      <SleeperSyncStatus
        sync={sleeper}
        reconciliation={sleeperReconciliation}
        message={sleeperMessage}
        players={poolPlayers}
        onRepair={repairSleeperIdentity}
        onUseProviderPick={useProviderConflictPick}
        onRetry={() => {
          setSleeperMessage("Retrying Sleeper now…");
          setSleeperRetry((attempt) => attempt + 1);
        }}
      />

      <NeedsStrip
        slots={starters}
        roster={myRoster}
        picksLeft={myRemainingPicks.length}
        draftComplete={draftComplete}
      />

      {/* Full width, above the columns. A draft board is fourteen columns of names; in the
          content column it sized itself to the longest one and scrolled sideways on a
          desktop with room to spare, which is the one thing a board must not do — the
          value of watching it is seeing the whole room at once. */}
      <section className="mt-4" aria-busy={boardPending}>
        <button
          type="button"
          onClick={() => setBoardOpen((open) => !open)}
          aria-expanded={boardOpen}
          aria-controls="draft-board-region"
          className="mb-2 flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          The board
          {boardOpen ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </button>
        <div id="draft-board-region">
        {boardOpen ? (
          <BoardGrid
            teams={setup.teams}
            slot={setup.slot}
            rounds={setup.rounds}
            picks={activePicks}
            playersById={poolById}
            currentPick={currentPick}
            onSelectPick={selectBoardPick}
          />
        ) : null}
        </div>
      </section>

      {/* One column on a phone, two from `lg`, three from `3xl`.

          The third column is a reflow, not a stretch. From `3xl` the shell is 104rem wide,
          and spending all of it on two columns makes a table whose widest cell is a
          player's name a thousand pixels across while the recommendation that decides the
          pick sits off the bottom of the screen. Splitting instead puts what to take, who
          is left, and what you have beside each other, so a pick needs no scrolling between
          the two panels it is decided from. Not the whole page on one screen — the board
          above it is 22rem, and 1792px wide is commonly 1080px tall — but the part a
          decision is actually made from, together.

          `3xl:contents` rather than a second grid: below that width these two panels share
          one column and stack, and `display: contents` promotes them to grid items of the
          outer grid without a wrapper element to lay out. The div carries no role and no
          styling of its own at that width, so removing its box removes nothing from the
          accessibility tree either. */}
      <div
        aria-busy={boardPending}
        className="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_21rem] 3xl:grid-cols-[minmax(0,30rem)_minmax(0,1fr)_21rem]"
      >
        <div className="flex min-w-0 flex-col gap-4 3xl:contents">
          <Recommendations
            state={recommender}
            scenarios={SCENARIOS}
            candidates={CANDIDATES}
            onTheClock={onTheClock && !draftComplete}
            draftComplete={draftComplete}
            onPick={record}
            waitPick={waitPick}
            waitPickLabel={waitPickLabel}
            unrankedAdp={unrankedAdp}
            basisFor={basisFor}
          />

          <PlayerPool
            players={poolPlayers}
            onTheClock={onTheClock && !draftComplete}
            actionLabel={turn.action}
            draftComplete={draftComplete}
            onRecord={record}
            queue={queue}
            onToggleQueue={toggleQueue}
            neededPositions={needs}
            waitPick={waitPick}
            waitPickLabel={waitPickLabel}
            unrankedAdp={unrankedAdp}
            focus={focus}
            teams={setup.teams}
            onOpenDetail={setDetailId}
          />
        </div>

        <aside className="flex flex-col gap-4">
          <MyTeam
            slots={starters}
            roster={myRoster}
            pickByPlayerId={rosterPicks}
            teams={setup.teams}
            // From `config`, not a second derivation of the same setting. The panel names
            // which byes fall in a playoff round and the simulation prices them; the two
            // disagreeing would be a screen contradicting the numbers beside it.
            playoffWeeks={config.playoffWeeks}
            basisFor={basisFor}
          />
          <QueuePanel
            queue={queue}
            playersById={poolById}
            onTheClock={onTheClock && !draftComplete}
            onRecord={record}
            onRemove={toggleQueue}
            onSwap={swapInQueue}
          />
          <Caveat
            freshness={freshness ?? null}
            boardSize={board.length}
            teams={setup.teams}
            config={config}
            pending={describesHeldBoard}
          />
        </aside>
      </div>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        onChange={applySettings}
        // Picks are a prefix of 1..n, so the rounds already touched is what the count
        // implies. Dropping below it would put recorded picks past the end of the draft.
        minRounds={Math.max(1, Math.ceil(Object.keys(activePicks).length / setup.teams))}
        onReset={resetDraft}
      />

      <PlayerDetail
        player={detailId === null ? null : (poolById.get(detailId) ?? null)}
        onClose={() => setDetailId(null)}
        onRecord={record}
        actionLabel={turn.action}
        canRecord={!draftComplete}
        // Drops the pick on the clock when it is yours. `remainingPicks` is filtered
        // `pick >= currentPick`, so on your own turn its first entry is the pick you are
        // making — and "45% chance he is still there at 3.04" for a player you are looking
        // at, available, at 3.04 is not a question anybody has. Same correction as
        // `waitPick`, applied to the same idea.
        remainingOwnPicks={onTheClock ? myRemainingPicks.slice(1) : myRemainingPicks}
        teams={setup.teams}
        unrankedAdp={unrankedAdp}
        scoringLabel={scoringLabel}
        // The dialog names the scoring format directly above the three estimates, and its
        // overlay covers the status bar's warning — so it is the one surface that would
        // put the new format's name on the old format's numbers with nothing to say so.
        pending={boardPending}
      />
    </PageShell>
  );
}

function SleeperConnect({
  draftId,
  message,
  onDraftIdChange,
  onConnect,
}: {
  draftId: string;
  message: string | null;
  onDraftIdChange: (value: string) => void;
  onConnect: () => void;
}) {
  return (
    <section className="rounded-xl border bg-card p-5 sm:p-6" aria-labelledby="sleeper-connect-title">
      <h2 id="sleeper-connect-title" className="text-sm font-medium">Connect Sleeper</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Paste the public draft ID from Sleeper. We prefill only an exact snake, roster, and
        PPR/Half PPR/Standard mapping; custom settings stay visible and are not approximated.
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <label className="sr-only" htmlFor="sleeper-draft-id">Sleeper draft ID</label>
        <input
          id="sleeper-draft-id"
          value={draftId}
          onChange={(event) => onDraftIdChange(event.target.value)}
          placeholder="Sleeper draft ID"
          className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm"
        />
        <Button type="button" onClick={onConnect}>Connect Sleeper</Button>
      </div>
      {message === null ? null : <p className="mt-2 text-xs text-muted-foreground" role="status">{message}</p>}
    </section>
  );
}

function SleeperSyncStatus({
  sync,
  reconciliation,
  message,
  players,
  onRepair,
  onUseProviderPick,
  onRetry,
}: {
  sync: PersistedSleeperSync | null;
  reconciliation: SleeperReconciliation | null;
  message: string | null;
  players: readonly PoolPlayer[];
  onRepair: (pickKey: string, boardPlayerId: string) => void;
  onUseProviderPick: (pickKey: string, overall: number) => void;
  onRetry: () => void;
}) {
  if (sync === null || reconciliation === null) return null;
  const unresolved = reconciliation.classifications.filter(
    (entry) => entry.state !== "matched",
  );
  const matchedByKey = new Map(
    reconciliation.classifications
      .filter(
        (entry): entry is Extract<(typeof reconciliation.classifications)[number], { state: "matched" }> =>
          entry.state === "matched",
      )
      .map((entry) => [entry.input.pickKey, entry.boardPlayerId]),
  );
  const freshness =
    sync.lastSyncedAt === null
      ? "Waiting for the first successful poll"
      : `Last received ${new Date(sync.lastSyncedAt).toLocaleTimeString()}`;
  const completeButUnresolved = sync.status.toLowerCase() === "complete" && !reconciliation.cleanCompletion;

  return (
    <section className="mt-3 rounded-xl border border-dashed p-3 text-sm" aria-labelledby="sleeper-sync-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="sleeper-sync-title" className="font-medium">Sleeper sync</h2>
          <p className="text-xs text-muted-foreground">
            {freshness} · provider status {sync.status || "unknown"} · {reconciliation.observedValidPickCount} of {reconciliation.expectedPickCount} valid provider picks
          </p>
        </div>
        <span className={reconciliation.cleanCompletion ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}>
          {reconciliation.cleanCompletion
            ? "Cleanly complete"
            : unresolved.length > 0
              ? `${unresolved.length} identity repair${unresolved.length === 1 ? "" : "s"} required`
              : "Reconciling"}
        </span>
      </div>
      {message === null ? null : (
        <p className="mt-2 text-xs text-muted-foreground" role="status">
          {message} <Button type="button" variant="link" size="sm" className="h-auto px-1 py-0" onClick={onRetry}>Retry now</Button>
        </p>
      )}
      {completeButUnresolved ? (
        <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-300">
          Sleeper says complete, but this draft is not clean: expected count, conflicts, and identity resolution must all agree.
        </p>
      ) : null}
      {reconciliation.conflicts.length > 0 ? (
        <div className="mt-3 space-y-2" role="alert">
          <p className="font-medium">Provider/local conflicts need a decision</p>
          {reconciliation.conflicts.map((conflict) => {
            const providerPlayerId = matchedByKey.get(conflict.pickKey);
            return (
              <div key={`${conflict.kind}:${conflict.pickKey}`} className="flex flex-wrap items-center gap-2 text-xs">
                <span>{conflict.kind.replaceAll("-", " ")} at pick {conflict.overall ?? "unknown"}.</span>
                {conflict.kind === "local-provider-disagreement" && conflict.overall !== null && providerPlayerId !== undefined ? (
                  <Button size="sm" variant="outline" onClick={() => onUseProviderPick(conflict.pickKey, conflict.overall!)}>Use provider match</Button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {unresolved.length > 0 ? (
        <div className="mt-3 space-y-3">
          <p className="font-medium">Resolve provider identities</p>
          {unresolved.map((entry) => (
            <div key={entry.input.pickKey} className="flex flex-col gap-2 rounded-md bg-muted/50 p-2 sm:flex-row sm:items-center">
              <span className="min-w-0 flex-1 text-xs">
                Pick {entry.input.pickKey}: {entry.input.name || "Unnamed Sleeper player"} ({entry.state})
              </span>
              <select
                defaultValue=""
                aria-label={`Match ${entry.input.name || "unresolved Sleeper player"}`}
                className="rounded-md border bg-background px-2 py-1 text-xs"
                onChange={(event) => {
                  if (event.target.value !== "") onRepair(entry.input.pickKey, event.target.value);
                }}
              >
                <option value="" disabled>Choose board player…</option>
                {players.map((player) => (
                  <option key={player.id} value={player.id}>{player.name} · {player.position} · {player.team ?? "FA"}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The page, in grey, before the first board has arrived.
 *
 * Shaped like what replaces it. A skeleton that is not the size of its content is a layout
 * shift with extra steps: the previous one was a single 10rem block, and the board that
 * landed on top of it was several times taller.
 *
 * It follows `started` because the two things that can follow are different shapes — the
 * setup form for a new draft, the board for a restored one. `started` is read from session
 * storage in an effect, so a restored draft shows the form shape for the frame before that
 * effect runs; that is one frame against several hundred milliseconds of query, and the
 * alternative is blocking paint on a synchronous storage read.
 */
function FirstLoadSkeleton({ started }: { started: boolean }) {
  const bar = "motion-safe:animate-pulse rounded-lg bg-muted";
  if (!started) {
    return (
      <div className="space-y-6" aria-hidden>
        <div className={cn(bar, "h-64")} />
        <div className={cn(bar, "h-40")} />
        <div className={cn(bar, "h-10 w-40")} />
      </div>
    );
  }
  return (
    <div className="space-y-4" aria-hidden>
      <div className={cn(bar, "h-14")} />
      {/* The board's own height, from the same steps `BoardGrid` caps itself at. */}
      <div className={cn(bar, "h-[13rem] sm:h-[18rem] lg:h-[22rem]")} />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_21rem] 3xl:grid-cols-[minmax(0,30rem)_minmax(0,1fr)_21rem]">
        <div className={cn(bar, "h-80")} />
        <div className={cn(bar, "h-96 3xl:h-80")} />
        <div className={cn(bar, "h-80 lg:col-start-2 3xl:col-start-3")} />
      </div>
    </div>
  );
}

/**
 * The starting slots still empty, always on screen.
 *
 * The one fact from the roster that changes a decision mid-draft. Putting it in the roster
 * panel alone means a manager on a phone has to scroll past two hundred players to learn
 * that they have no tight end, which is exactly the information that should have stopped
 * them taking a fourth receiver.
 */
function NeedsStrip({
  slots,
  roster,
  picksLeft,
  draftComplete,
}: {
  slots: ReturnType<typeof slotsForTemplate>;
  roster: readonly PlayerRisk[];
  picksLeft: number;
  draftComplete: boolean;
}) {
  const empty = useMemo(() => unfilledSlots(slots, roster), [slots, roster]);

  if (draftComplete) return null;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
      <span className="font-medium text-muted-foreground">
        {empty.length === 0 ? "Every starting slot is filled" : "Still to fill"}
      </span>
      {[...new Set(empty)].map((label) => (
        <span
          key={label}
          className="rounded bg-amber-500/12 px-1.5 py-0.5 font-semibold text-amber-700 ring-1 ring-amber-500/25 ring-inset dark:text-amber-300"
        >
          {label}
        </span>
      ))}
      <span className="text-muted-foreground tabular-nums">
        {picksLeft} {picksLeft === 1 ? "pick" : "picks"} left
      </span>
    </div>
  );
}

/**
 * How healthy the board is, in one prominent line above everything else.
 *
 * Separate from the small print below, and deliberately: a board whose last rebuild
 * *failed* looks entirely healthy in a timestamp — it is only hours old, because the failed
 * run left the previous one intact, which is the correct behaviour and exactly why the
 * failure is invisible. Somebody about to draft off it has to be told before they start,
 * not in a paragraph at the bottom of a sidebar.
 */
function BoardHealthNotice({
  freshness,
  pending,
}: {
  freshness: BoardFreshness | null;
  /** True while the freshness on hand belongs to a selection the controls have left. */
  pending: boolean;
}) {
  // `Date.now()` at mount rather than during render, for the same hydration reason the
  // formatted timestamp below has: a server render and a client render happen at different
  // instants and would disagree about how many hours old a board is.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), [freshness]);
  if (now === null) return null;
  // This notice sits above the line that marks held data, and `describeBoardHealth` names
  // no league shape — so during a reload it would state "no board has ever been built for
  // this league shape" about the shape the reader has just left, with nothing to say which
  // shape it meant. An existence claim is not worth making from data that is about to be
  // replaced; it renders for the board it actually describes, a moment later.
  if (pending) return null;

  const health = boardHealth({
    now,
    publishedAt: freshness?.computedAt ?? null,
    lastAttemptAt: freshness?.lastAttemptAt ?? null,
    lastAttemptFailed: freshness?.lastAttemptStatus === "failed",
    refreshing: freshness?.lastAttemptStatus === "running",
  });
  if (health === "fresh") return null;

  return (
    <p
      className="mb-4 rounded-lg border border-dashed p-3 text-sm"
      role={health === "refreshing" ? "status" : "alert"}
    >
      {describeBoardHealth(health, { now, publishedAt: freshness?.computedAt ?? null })}
    </p>
  );
}

function Caveat({
  freshness,
  boardSize,
  teams,
  config,
  pending,
}: {
  freshness: BoardFreshness | null;
  boardSize: number;
  teams: number;
  /**
   * The league the odds were actually computed for.
   *
   * This paragraph used to state "a 14-week regular season and a three-week bracket" as a
   * fixed fact, which was true while the board wrote those numbers out and false the
   * moment the season became a setting — for five of the six combinations the controls
   * offer. Worse, it sat beside a settings panel and a bye list that both described the
   * real one, so the screen contradicted itself. It is derived now for the same reason
   * every other number here is: nothing may be stated that the code did not compute.
   */
  config: LeagueConfig;
  /** True while `boardSize` and `freshness` belong to a selection `teams` has left. */
  pending: boolean;
}) {
  // Formatted after mount, never during render. `toLocaleString` reads the locale and
  // timezone of whoever runs it, so the server's rendering of this timestamp and the
  // browser's are different strings for the same instant, and React reports a hydration
  // mismatch. The board is client-fetched today, which is the only reason it has not
  // happened yet — that is a fact about the current data flow, not a property of this
  // component, and it should not be what keeps the page from erroring.
  const [builtAt, setBuiltAt] = useState<string | null>(null);
  useEffect(() => {
    setBuiltAt(
      freshness?.computedAt == null
        ? null
        : new Date(freshness.computedAt).toLocaleString(),
    );
  }, [freshness]);

  // The sentence comes from `adpSourceLabel` rather than being written again here. It was
  // written twice — once in the module that owns the fallback rule and once inline in this
  // component — which is a wording that can drift from the rule it describes, in the one
  // direction that matters: a derived board eventually described as a published one.
  // `adpSourceLabel` takes the *selected* size and the *held* board's ADP source, and
  // while those disagree it composes a sentence about neither: switching from an 11-team
  // board (derived, sourced from 10) to a 10-team one printed "market prices published for
  // 10-team leagues" over rows that had been rescaled — an approximation promoted to a
  // published price, stated flatly. Only this clause mixes the two, so only this clause
  // waits; the sentences around it are true of the board actually on screen.
  const provenance = pending
    ? "Where this board's market prices came from has not been re-read for this selection yet."
    : freshness?.computedAt == null
      ? "No board has been built for this league size yet."
      : adpSourceLabel(teams, freshness.adpSourceTeams);

  return (
    <p className="text-xs text-muted-foreground">
      {boardSize} players.{" "}
      {builtAt === null ? "Freshness unknown." : `Board built ${builtAt}.`} {provenance}{" "}
      Odds are for {describeSeason(config)}. Player values blend
      the market&rsquo;s price with our own projection; measured out-of-sample, the market
      ranks players better than our model does and no edge over it is claimed. Kickers and
      defenses carry the market&rsquo;s price alone: the model does not project either, so
      those numbers carry no model estimate — every such row is marked, so this sentence is
      a summary of the labels rather than the only place the limitation appears. Their weekly
      spread is measured, from historical scoring rather than from a projection. Scoring is
      limited to PPR, half PPR and standard. Opponents&rsquo; unfilled roster spots are
      completed by a simple best-available rule, so early-round odds lean on that assumption
      more than late ones.
    </p>
  );
}
