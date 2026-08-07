"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import {
  DRAFT_STORAGE_KEY,
  LEAGUE_SIZES,
  MAX_ROUNDS,
  PLAYOFF_FIELDS,
  type PersistedDraft,
  parsePersistedDraft,
  nextPick,
  recordPick,
  undoPick,
} from "./persistence";
import { useQuery } from "convex/react";

import { api } from "@/convex/_generated/api";
import { PageShell } from "@/components/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  normalizeLeagueSetup,
  pickOwnership,
  seatForTeamIndex,
  snakePicks,
} from "@/lib/core/draft";
import type { DraftPolicyState, DraftTeam } from "@/lib/core/draft-policy";
import type { PlayerRisk } from "@/lib/core/roster-utility";
import type { LeagueConfig } from "@/lib/core/season-sim";
import { ROSTER_TEMPLATES, slotsForTemplate } from "@/lib/nfl/roster";
import { draftSeasonFor } from "@/lib/nfl/season";
import { DEFAULT_SCORING, SCORING_PRESETS } from "@/lib/nfl/scoring/presets";
import { matchName } from "@/lib/nfl/draft/match";
import { perGameRate } from "@/lib/nfl/draft/value";
import {
  leadingPanel,
  nextArmed,
  panelOrder,
  shouldRevealLead,
  type Panel,
} from "./panel-order";
import { useRecommendations } from "./use-recommendations";

/**
 * The draft board.
 *
 * Tracks every team's picks, not only yours, because the objective is the probability of
 * winning the league and that depends on who your opponents actually drafted. Entering a
 * pick is one click; the board is the source of truth and nothing is inferred.
 *
 * What it will not do is claim to know better than the market which players are good. That
 * was measured and it is not true — see `/accuracy` and `docs/draft-validation.md`. What it
 * does is answer the question average draft position structurally cannot: given *your*
 * roster, *your* league's slots and *your* remaining picks, which player leaves you most
 * likely to win.
 */

const SEED = 20260731;

/** Scenarios per recommendation. 600 resolves the ordering; 300 leaves the top few tied. */
const SCENARIOS = 600;

interface BoardPlayer {
  playerId: string;
  name: string;
  position: string;
  team: string | null;
  blendedPoints: number;
  marketPoints: number | null;
  adp: number | null;
  adpStdev: number | null;
  byeWeek: number | null;
  availability: number;
  p10: number;
  p90: number;
}

export default function DraftPage() {
  const [teams, setTeams] = useState(12);
  const [rounds, setRounds] = useState(15);
  const [slot, setSlot] = useState(1);
  const [scoringId, setScoringId] = useState(DEFAULT_SCORING.id);
  const [templateId, setTemplateId] = useState(ROSTER_TEMPLATES[0].id);
  const [started, setStarted] = useState(false);
  const [search, setSearch] = useState("");

  /** Overall pick number to the team index that made it. Index 0 is always the user. */
  const [picks, setPicks] = useState<Record<number, string>>({});

  const [playoffTeams, setPlayoffTeams] = useState<number>(6);

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
      setTemplateId(stored.templateId);
      setPlayoffTeams(stored.playoffTeams);
      setStarted(stored.started);
      setPicks(stored.picks);
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
      templateId,
      playoffTeams,
      started,
      picks,
    };
    try {
      window.sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // A full or disabled store is not worth taking the board down for. The draft still
      // works; it just will not survive a remount.
    }
  }, [restored, teams, rounds, slot, scoringId, templateId, playoffTeams, started, picks]);

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
        { minTeams: LEAGUE_SIZES[0], maxTeams: LEAGUE_SIZES[LEAGUE_SIZES.length - 1] },
      ),
    [teams, slot, rounds],
  );

  // `setup.teams` rather than `teams`. A restored draft carries whatever whole number was
  // stored, and while `setup` clamps it for ownership, pick counts and rosters, the board
  // query read the raw value — so an out-of-range league fetched one board shape and drew
  // the seats of another.
  const board = useQuery(
    api.draft.board,
    season === null ? "skip" : { season, scoringId, teams: setup.teams },
  );
  const freshness = useQuery(
    api.draft.boardFreshness,
    season === null ? "skip" : { season, scoringId, teams: setup.teams },
  );

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
  const currentPick = useMemo(() => nextPick(picks, totalPicks), [picks, totalPicks]);

  const onTheClock = pickOwners.get(currentPick) === 0;
  const draftComplete = currentPick > totalPicks;

  const lead = leadingPanel({ onTheClock, draftComplete });

  // The two panels, and only the two panels. The scroll target is read from this
  // container rather than tracked separately, so the page cannot scroll to something that
  // is not one of them — the two failure notices above are siblings of the group, not of
  // the panels.
  const panelsRef = useRef<HTMLDivElement | null>(null);

  // The element focus was on when the order last changed. Read from a listener rather
  // than during render, because by the time the effect runs the answer is already <body>.
  //
  // Scoped to the panels. A document-wide listener remembers the header's nav links and
  // theme toggle too, and the `activeElement === body` test below only establishes that
  // *something* lost focus — not that the reorder is what lost it. On a browser that does
  // not focus a button on tap, a toggle touched earlier in the draft stayed remembered,
  // and the next turn change handed focus back to it: off-screen in the header, with the
  // next Tab walking the primary nav instead of the record controls.
  const lastFocused = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const remember = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      lastFocused.current =
        panelsRef.current?.contains(target) === true ? target : null;
    };
    document.addEventListener("focusin", remember);
    return () => document.removeEventListener("focusin", remember);
  }, []);

  const previousLead = useRef<Panel | null>(null);
  useEffect(() => {
    const reveal = shouldRevealLead({
      settled: restored,
      previous: previousLead.current,
      current: lead,
    });
    previousLead.current = nextArmed({
      settled: restored,
      previous: previousLead.current,
      current: lead,
    });
    if (!reveal) return;

    // Keys stop the swap remounting these panels; they do not stop it blurring them.
    // React 19 reorders with `insertBefore` and has no `moveBefore`, so the node is
    // detached and reattached, and the DOM drops focus when a focused node is removed.
    // Pressing Undo flips the order, which moves the section holding the button that was
    // just pressed — leaving a keyboard user back at <body>, tabbing from the top of the
    // page to reach it again. Only reclaimed if the move is what lost it.
    const wasFocused = lastFocused.current;
    const active = document.activeElement;
    if (
      wasFocused !== null &&
      wasFocused.isConnected &&
      (active === null || active === document.body)
    ) {
      // No `preventScroll`: the browser brings it into view, and the scroll below is
      // skipped. The panel that loses focus is always the one being *demoted* — React
      // flags the previously-first child for placement — so scrolling to the promoted
      // panel instead would park the viewport at the top of the page with the focus ring
      // two or three screens below it, off-screen and with nothing marking where the
      // keyboard is. Following focus is the only reading of "reveal" that serves someone
      // who is not looking at the scrollbar.
      wasFocused.focus();
      lastFocused.current = null;
      return;
    }
    // Consumed either way. Restoring focus fires `focusin`, which would otherwise write
    // this same element straight back and leave it armed for a swap the user had nothing
    // to do with: tap something unfocusable, and the next lead change drops focus into a
    // panel you never touched. Anything the user actually focuses re-arms it.
    lastFocused.current = null;

    // Whichever panel now leads, not whichever one we guessed would. Guarding this on
    // "the record panel leads" suppressed it on the turn coming back to you — where the
    // recommendations, two or three screens of them, are inserted above where you are
    // standing and nothing tells you the page grew upward.
    //
    // Reached when there was no focus to reclaim, which is the ordinary case: recording a
    // pick unmounts the control that was clicked — every Draft button when the turn leaves
    // you, the search results when `record` clears the query — so by the time this runs
    // the remembered node is already gone.
    //
    // The first *rendered* panel, which is not always the leading one: `Recommendations`
    // renders nothing when it has no candidates, so a lead of "recommendations" can leave
    // the record section first in the DOM. Revealing what the reader will actually see
    // first is the behavior wanted in that case anyway.
    const leadingNode = panelsRef.current?.firstElementChild;
    if (!(leadingNode instanceof HTMLElement)) return;
    leadingNode.scrollIntoView({
      block: "start",
      // Honor the OS setting rather than animating over it.
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  }, [restored, lead]);

  const clockOwner = pickOwners.get(currentPick);
  const clockLabel =
    clockOwner === undefined
      ? "Nobody"
      : clockOwner === 0
        ? "You"
        : `Seat ${seatForTeamIndex(clockOwner, setup.slot)}`;

  const draftState = useMemo<DraftPolicyState | null>(() => {
    if (pool.length === 0) return null;
    const rosters: PlayerRisk[][] = Array.from({ length: setup.teams }, () => []);
    const taken = new Set<string>();
    for (const [pick, playerId] of Object.entries(picks)) {
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
  }, [pool, picks, pickOwners, byId, setup, currentPick]);

  const config = useMemo<LeagueConfig>(
    () => ({
      slots: starters,
      weeks: Array.from({ length: 14 }, (_, i) => i + 1),
      playoffWeeks: [15, 16, 17],
      playoffTeams,
      scenarios: SCENARIOS,
      meanAbsenceWeeks: 3,
    }),
    [starters, playoffTeams],
  );

  // Recompute whenever the board changes, including while opponents are picking — the
  // answer for a future position is worth having before the turn arrives.

  useEffect(() => {
    if (!started || draftState === null) return;
    if (draftState.available.length === 0) return;
    // A finished draft still changes `draftState` on the last pick, and the pool is never
    // empty — drafted players are a small slice of the board — so without this the worker
    // ran a full season simulation for a draft that was over, and the panel went on
    // advising a pick for a clock nobody is on.
    if (draftComplete) return;
    recommender.request(draftState, config, SEED, 10);
    // `recommender.request` is stable; depending on the whole object would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, draftState, config, draftComplete]);

  const myRoster = draftState?.teams[0].roster ?? [];

  const searchResults = useMemo(() => {
    const available = draftState?.available ?? [];
    if (search.trim().length < 2) return [];
    const match = matchName(search, available, 0.55);
    const prefix = available
      .filter((p) => p.name.toLowerCase().includes(search.trim().toLowerCase()))
      .slice(0, 8);
    const seen = new Set(prefix.map((p) => p.id));
    if (match !== null && !seen.has(match.candidate.id)) prefix.push(match.candidate);
    return prefix.slice(0, 8);
  }, [search, draftState]);

  // Both of these do their work inside the updater, on the state it is handed. Reading
  // `currentPick` from this render instead let two clicks arriving before a re-render write
  // the same key: the second player overwrote the first, and the first stayed on the board.
  function record(playerId: string): void {
    setPicks((previous) => recordPick(previous, playerId, totalPicks));
    setSearch("");
  }

  function undo(): void {
    setPicks((previous) => undoPick(previous, totalPicks));
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

  if (season === null || board === undefined) {
    return (
      <PageShell title="Draft" subtitle="Loading the board…">
        <div className="h-40 animate-pulse rounded-lg bg-muted" aria-hidden />
      </PageShell>
    );
  }

  // A restored draft arrives with `started: true` and goes straight past the setup screen,
  // where the empty-board message lives. If no board exists for that season, scoring and
  // size — a shape that was never built, or one whose rows have not landed yet — the user
  // met "Record pick 1 — You" over a search box that could never match anything, with
  // nothing to explain it and no control to change the league.
  if (started && board.length === 0) {
    return (
      <PageShell title="Draft" subtitle="No board for this league">
        <p className="text-sm text-muted-foreground">
          No {season} board has been built for {setup.teams}-team{" "}
          {scoringId.replace("_", " ")} yet, so there is nothing to draft from. Boards
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
        subtitle="Set your league up once. Everything after that is one click per pick."
      >
        <section className="rounded-lg border p-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Teams">
              <div className="flex flex-wrap gap-2" role="group" aria-label="League size">
                {LEAGUE_SIZES.map((size) => (
                  <Button
                    key={size}
                    size="sm"
                    variant={size === teams ? "default" : "outline"}
                    aria-pressed={size === teams}
                    onClick={() => setTeams(size)}
                  >
                    {size}
                  </Button>
                ))}
              </div>
            </Field>
            <Field label="Rounds">
              <NumberPicker
                label="Rounds"
                value={rounds}
                onChange={setRounds}
                min={1}
                max={MAX_ROUNDS}
              />
            </Field>
            <Field label="Your draft slot">
              <NumberPicker
                label="Your draft slot"
                value={slot}
                onChange={setSlot}
                min={1}
                max={teams}
              />
            </Field>
            <Field label="Playoff teams">
              <div className="flex flex-wrap gap-2" role="group" aria-label="Playoff teams">
                {PLAYOFF_FIELDS.filter((field) => field < teams).map((field) => (
                  <Button
                    key={field}
                    size="sm"
                    variant={field === playoffTeams ? "default" : "outline"}
                    aria-pressed={field === playoffTeams}
                    onClick={() => setPlayoffTeams(field)}
                  >
                    {field}
                  </Button>
                ))}
              </div>
            </Field>
            <Field label="Scoring">
              <div className="flex flex-wrap gap-2" role="group" aria-label="Scoring">
                {SCORING_PRESETS.map((preset) => (
                  <Button
                    key={preset.id}
                    size="sm"
                    variant={preset.id === scoringId ? "default" : "outline"}
                    aria-pressed={preset.id === scoringId}
                    onClick={() => setScoringId(preset.id)}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
            </Field>
          </div>

          <div className="mt-4">
            <Field label="Roster">
              <div className="flex flex-wrap gap-2" role="group" aria-label="Roster shape">
                {ROSTER_TEMPLATES.map((template) => (
                  <Button
                    key={template.id}
                    size="sm"
                    variant={template.id === templateId ? "default" : "outline"}
                    aria-pressed={template.id === templateId}
                    onClick={() => setTemplateId(template.id)}
                  >
                    {template.label}
                  </Button>
                ))}
              </div>
            </Field>
          </div>

          <p className="mt-4 text-sm text-muted-foreground">
            Your picks:{" "}
            {snakePicks(setup.slot, setup.teams, setup.rounds).slice(0, 6).join(", ")}
            {rounds > 6 ? "…" : ""}
          </p>

          {board.length === 0 ? (
            // Deliberately inside the form rather than replacing it. Unmounting the setup
            // screen took the Teams control away with it, leaving no way back except a
            // full reload — and told an end user to run an internal CLI command.
            <p className="mt-6 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              No {season} board has been built for {teams}-team{" "}
              {scoringId.replace("_", " ")} yet. Pick another size or scoring format above;
              boards exist for {LEAGUE_SIZES.join(", ")}-team leagues.
            </p>
          ) : (
            <Button className="mt-6" onClick={() => setStarted(true)}>
              Start draft
            </Button>
          )}
        </section>

        <Caveat freshness={freshness ?? null} boardSize={board.length} />
      </PageShell>
    );
  }

  const recommendationsPanel = draftComplete ? (
    <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
      The draft is over &mdash; every pick is recorded. Your roster is below.
    </p>
  ) : (
    <Recommendations state={recommender} onPick={record} onTheClock={onTheClock} />
  );

  const recordPanel = (
    <section>
      {/* The *controls* are hidden once every pick is in — not the section, which still
          has to carry Undo. `currentPick` runs one past the last pick when the draft is
          complete, so the heading below read "Record pick 181 — Nobody" over a search
          that could not attribute anything to a seat. Undo sits outside this wrapper
          because correcting a mistaken *last* pick is exactly when it is needed, and
          hiding the whole section made it unreachable at that moment. */}
      <div className={draftComplete ? "hidden" : undefined}>
        {/* Names whose pick this is. "Record pick 2 — Seat 2" reads as a label for a
            row of data; the reader has to work out that it is asking them for
            something. */}
        <h2 className="text-sm font-medium">
          {onTheClock
            ? `Record pick ${currentPick} — your pick`
            : `Record pick ${currentPick} — what ${clockLabel} took`}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Every pick, not only yours. Opponents&rsquo; rosters decide the odds, so a
          missing one makes every number after it wrong.
        </p>
        <Input
          className="mt-3"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search a player…"
          aria-label="Search a player to record as drafted"
        />
        <ul className="mt-2 space-y-1">
          {searchResults.map((player) => (
            <li key={player.id}>
              <button
                className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm hover:bg-muted"
                onClick={() => record(player.id)}
              >
                <span>
                  {player.name}{" "}
                  <span className="text-muted-foreground">
                    {player.position}
                    {player.byeWeek === null ? "" : ` · bye ${player.byeWeek}`}
                  </span>
                </span>
                <span className="text-muted-foreground">
                  {player.adp == null ? "unranked" : `ADP ${player.adp.toFixed(1)}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {/* Gated on the pick it actually removes, not on the map being non-empty.
          `currentPick` is the first *empty* pick, so a restored board with a gap in it
          offered "Undo pick N" for an entry that does not exist and removed nothing
          when pressed. */}
      {picks[currentPick - 1] !== undefined ? (
        <Button className="mt-3" size="sm" variant="outline" onClick={undo}>
          Undo pick {currentPick - 1}
        </Button>
      ) : null}
    </section>
  );

  // One sentence for both the subtitle and the live region below, so the thing announced
  // and the thing shown cannot drift apart.
  const turnSummary = draftComplete
    ? "Draft complete."
    : onTheClock
      ? `Pick ${currentPick} — you are on the clock.`
      : // Not `Pick 2 — Seat 2.`, which states a fact and asks for nothing. Eleven picks
        // in twelve belong to somebody else, and during every one of them the only thing
        // this screen can do is be told what that person took.
        `Pick ${currentPick} — ${clockLabel} on the clock. Record their pick below.`;

  return (
    <PageShell title="Draft" subtitle={turnSummary}>
      {/* The turn changing rearranges this page under the reader: the two panels swap, and
          the viewport moves to whichever now leads. Sighted users see that happen. Without
          this, nobody else was told — the subtitle that names whose pick it is is a plain
          paragraph, so a screen reader would announce nothing at all and leave the user on
          a page whose running order had silently changed beneath them.

          `polite`, so it waits for a pause rather than cutting across whatever is being
          read, and it is the same sentence the subtitle shows rather than a second wording
          to keep in step. */}
      <p className="sr-only" role="status" aria-live="polite">
        {turnSummary}
      </p>

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="flex flex-col gap-6">
          {recommender.unavailable !== null ? (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              {recommender.unavailable}, so recommendations are unavailable. The board below
              still works.
            </p>
          ) : null}

          {recommender.error !== null ? (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              The recommendation failed: {recommender.error}
            </p>
          ) : null}

          {/*
            Which of these comes first depends on whose turn it is, because on a phone the
            first thing on the screen is the only thing on the screen.

            The recommendation panel is a header, ten candidate rows and a footer — two or
            three screens on a handset. Rendering it first put the recording controls below
            all of it, so on an opponent's turn the entire visible page was a list of
            players you cannot draft yet, and the control for the only action available was
            somewhere past the fold. A tester with the board open on a phone concluded there
            was no way to enter an opponent's pick at all.

            That is what this ordering exists to prevent, and it is not cosmetic: a draft
            recorded with only your own picks produces recommendations against a board that
            does not exist, confidently and with nothing to say so.

            Reordered in the DOM rather than with CSS `order`, so that what a screen reader
            announces and where the tab sequence goes both match what is on the screen.
          */}
          {/* Its own element so that "the panel that leads" is exactly this container's
              first child — which is what the effect above scrolls to. The two notices
              above are siblings of this group, not of the panels, so a failed
              recommendation cannot become the thing the page scrolls to.

              Keyed, so React moves these two nodes rather than tearing both down and
              building them again. Rendered as bare fragments the children reconcile by
              index, the element type at each index changes on every turn, and both
              subtrees remount. Keys do not preserve focus across the move — the effect
              above handles that — and they are not what keeps the search box's contents
              either, since `search` is state on this component and survives regardless.
              What they hold is what lives in the DOM rather than in React: caret and
              selection inside that input, an in-flight IME composition, and the scroll
              offset of anything inside the panels. */}
          <div ref={panelsRef} className="flex flex-col gap-6">
            {panelOrder({ onTheClock, draftComplete }).map((panel) => (
              <Fragment key={panel}>
                {panel === "record" ? recordPanel : recommendationsPanel}
              </Fragment>
            ))}
          </div>
        </div>

        <aside>
          <h2 className="text-sm font-medium">Your roster</h2>
          {myRoster.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">Nothing drafted yet.</p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm">
              {myRoster.map((player) => (
                <li key={player.id} className="flex justify-between">
                  <span>{player.name}</span>
                  <span className="text-muted-foreground">
                    {player.position}
                    {player.byeWeek === null ? "" : ` · ${player.byeWeek}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <ByeSummary roster={myRoster} />
          <Caveat freshness={freshness ?? null} boardSize={board.length} />
        </aside>
      </div>
    </PageShell>
  );
}

function Recommendations({
  state,
  onPick,
  onTheClock,
}: {
  state: ReturnType<typeof useRecommendations>;
  onPick: (id: string) => void;
  onTheClock: boolean;
}) {
  if (state.loading) {
    return <div className="h-32 animate-pulse rounded-lg bg-muted" aria-hidden />;
  }
  if (state.recommendations.length === 0) return null;

  const leader = state.recommendations[0];

  return (
    <section className="rounded-lg border">
      <header className="flex items-baseline justify-between gap-4 border-b p-4">
        <div>
          <h2 className="font-medium">
            {onTheClock ? "Take" : "If the board holds, take"} {leader.player.name}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Ranked by the probability of winning the league, simulated over {SCENARIOS}{" "}
            seasons against the rosters your opponents have actually drafted.
          </p>
        </div>
        {state.stale ? (
          <span className="shrink-0 text-xs text-muted-foreground">recalculating…</span>
        ) : null}
      </header>

      <ul className="divide-y">
        {state.recommendations.map((rec) => (
          <li key={rec.player.id} className="flex items-center justify-between gap-4 p-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {rec.player.name}{" "}
                <span className="font-normal text-muted-foreground">
                  {rec.player.position}
                  {rec.player.byeWeek === null ? "" : ` · bye ${rec.player.byeWeek}`}
                </span>
              </p>
              {/*
                Two uncertainties, named apart, because they answer different questions and
                are not interchangeable. The first is how well this candidate's *own* title
                probability is pinned down. The second is how well these scenarios separate
                him from the leader — a paired quantity, since every candidate is simulated
                over the same seasons, and emphatically not the sum of two marginal errors.
                Reporting one number invited reading it as both.
              */}
              <p className="text-xs text-muted-foreground">
                {(rec.championshipProbability * 100).toFixed(1)}% title ±
                {(rec.standardError * 100).toFixed(1)} ·{" "}
                {(rec.playoffProbability * 100).toFixed(0)}% playoffs
              </p>
              {rec.vsLeader === null ? null : (
                <p className="text-xs text-muted-foreground">
                  vs leader {rec.vsLeader.meanDifference >= 0 ? "+" : ""}
                  {(rec.vsLeader.meanDifference * 100).toFixed(1)} pts of title odds,{" "}
                  {rec.vsLeader.confidenceLevel}% range{" "}
                  {(rec.vsLeader.interval[0] * 100).toFixed(1)} to{" "}
                  {(rec.vsLeader.interval[1] * 100).toFixed(1)}
                  {rec.tiedWithLeader ? " — not separated" : ""}
                </p>
              )}
            </div>
            {/*
              The button only records *your* pick, and only when the pick belongs to you.
              It used to render regardless: during an opponent's turn the panel says "if
              the board holds, take X", and tapping it wrote X as that opponent's pick —
              so you did not get the player, and whoever they really took stayed on the
              board and kept being recommended.
            */}
            {/*
              Nothing in this slot on an opponent's turn. It held "Seat 2 picks next",
              repeated down all ten rows, which read as the app waiting on the opponent
              rather than on you to say what they took — the opposite of what the page
              needs next. The heading above the panel already names whose pick it is.
            */}
            {onTheClock ? (
              <Button size="sm" variant="outline" onClick={() => onPick(rec.player.id)}>
                Draft
              </Button>
            ) : null}
          </li>
        ))}
      </ul>

      <footer className="border-t p-3 text-xs text-muted-foreground">
        Candidates within a couple of standard errors of each other are statistically tied
        and are ordered by playoff probability, which resolves at this sample size when
        title odds do not.
        {state.lastElapsedMs === null
          ? null
          : ` Computed in ${state.lastElapsedMs}ms${state.lastFromCache ? " (cached)" : ""}.`}
      </footer>
    </section>
  );
}

/** Bye collisions are the thing a points-based board cannot show, so it is shown. */
function ByeSummary({ roster }: { roster: readonly PlayerRisk[] }) {
  const byWeek = new Map<number, string[]>();
  for (const player of roster) {
    if (player.byeWeek === null) continue;
    byWeek.set(player.byeWeek, [...(byWeek.get(player.byeWeek) ?? []), player.position]);
  }
  const crowded = [...byWeek.entries()]
    .filter(([, positions]) => positions.length > 1)
    .sort((a, b) => a[0] - b[0]);

  if (crowded.length === 0) return null;

  return (
    <div className="mt-4 rounded-md border border-dashed p-3">
      <p className="text-xs font-medium">Bye weeks doubled up</p>
      <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
        {crowded.map(([week, positions]) => (
          <li key={week}>
            Week {week}: {positions.join(", ")}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Caveat({
  freshness,
  boardSize,
}: {
  freshness: { computedAt: number } | null;
  boardSize: number;
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
      freshness === null ? null : new Date(freshness.computedAt).toLocaleString(),
    );
  }, [freshness]);

  return (
    <p className="mt-6 text-xs text-muted-foreground">
      {boardSize} players.{" "}
      {builtAt === null ? "Freshness unknown." : `Board built ${builtAt}.`}{" "}
      Odds assume a 14-week regular season and a three-week bracket. Player values blend
      the market&rsquo;s price with our own projection; measured out-of-sample, the market
      ranks players better than our model does and no edge over it is claimed. Kickers and
      defenses carry the market&rsquo;s price alone. Scoring is limited to PPR, half PPR and
      standard. Opponents&rsquo; unfilled roster spots are completed by a simple
      best-available rule, so early-round odds lean on that assumption more than late ones.
    </p>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-sm font-medium">{label}</p>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function NumberPicker({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
}) {
  return (
    <Input
      type="number"
      aria-label={label}
      value={value}
      min={min}
      max={max}
      onChange={(event) => {
        // Rounded, not merely clamped. `<input type="number">` happily yields "1.5", and
        // every consumer here counts seats and rounds — whole things. A fractional slot
        // used to produce odd pick numbers; since `snakePicks` started rejecting one it
        // throws during render instead, and there is no error boundary under `app/`, so
        // the setup screen is replaced by a crash page that only a reload clears.
        //
        // An empty field is a keystroke in the middle of retyping, not a request for the
        // minimum. `Number("")` is 0, which rounds to 0 and is finite, so clamping it
        // immediately snapped the box to `min` the moment the user deleted the last digit
        // — and because the input is controlled, "15" could never be replaced by "12",
        // only appended to.
        const raw = event.target.value.trim();
        if (raw === "") return;
        const next = Math.round(Number(raw));
        if (Number.isFinite(next)) onChange(Math.min(Math.max(next, min), max));
      }}
    />
  );
}
