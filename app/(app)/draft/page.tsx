"use client";

import { useEffect, useMemo, useState } from "react";

import {
  DRAFT_STORAGE_KEY,
  type PersistedDraft,
  parsePersistedDraft,
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
import { DEFAULT_SCORING, SCORING_PRESETS } from "@/lib/nfl/scoring/presets";
import { matchName } from "@/lib/nfl/draft/match";
import { perGameRate } from "@/lib/nfl/draft/value";
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

/**
 * League sizes a board is built for.
 *
 * ADP is published per league size, so a board is not transferable and offering a size
 * that was never built is a dead end on the first screen. Mirrors
 * `DRAFT_BOARD_LEAGUE_SIZES` in `convex/ingest.ts`.
 */
const LEAGUE_SIZES = [8, 10, 12, 14] as const;

const PLAYOFF_FIELDS = [4, 6] as const;

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
  // which reinitialises every `useState` above — without this, retrying after a crash
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
  const season =
    seasonState === undefined
      ? null
      : seasonState === null
        ? null
        : seasonState.isComplete
          ? seasonState.season + 1
          : seasonState.season;

  const board = useQuery(
    api.draft.board,
    season === null ? "skip" : { season, scoringId, teams },
  );
  const freshness = useQuery(
    api.draft.boardFreshness,
    season === null ? "skip" : { season, scoringId, teams },
  );

  const recommender = useRecommendations();

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

  useEffect(() => {
    if (setup.slot !== slot) setSlot(setup.slot);
    if (setup.rounds !== rounds) setRounds(setup.rounds);
  }, [setup, slot, rounds]);

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

  // Everything downstream reads the normalised setup, not the raw inputs. A mid-keystroke
  // value that disagrees with the ownership map produces picks nobody owns, and a player
  // recorded against one of those is never marked as taken — he stays on the board and
  // keeps being recommended after he is gone.
  const totalPicks = setup.teams * setup.rounds;
  const currentPick = useMemo(() => {
    for (let pick = 1; pick <= totalPicks; pick += 1) {
      if (picks[pick] === undefined) return pick;
    }
    return totalPicks + 1;
  }, [picks, totalPicks]);

  const onTheClock = pickOwners.get(currentPick) === 0;

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
    recommender.request(draftState, config, SEED, 10);
    // `recommender.request` is stable; depending on the whole object would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, draftState, config]);

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

  const drafted = useMemo(() => new Set(Object.values(picks)), [picks]);

  function record(playerId: string): void {
    // A stale recommendation panel keeps a live Pick button next to a player who has just
    // been taken, and a double tap on a phone is the ordinary way to hit it twice. Without
    // this the same player lands on two rosters and is scored twice, while the player
    // actually taken at that pick is never recorded and stays on the board.
    if (drafted.has(playerId)) return;
    if (currentPick > totalPicks) return;
    setPicks((previous) => ({ ...previous, [currentPick]: playerId }));
    setSearch("");
  }

  function undo(): void {
    setPicks((previous) => {
      const next = { ...previous };
      delete next[currentPick - 1];
      return next;
    });
  }

  if (season === null || board === undefined) {
    return (
      <PageShell title="Draft" subtitle="Loading the board…">
        <div className="h-40 animate-pulse rounded-lg bg-muted" aria-hidden />
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
              <NumberPicker label="Rounds" value={rounds} onChange={setRounds} min={1} max={30} />
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

  return (
    <PageShell
      title="Draft"
      subtitle={
        currentPick > totalPicks
          ? "Draft complete."
          : onTheClock
            ? `Pick ${currentPick} — you are on the clock.`
            : `Pick ${currentPick} — ${clockLabel}.`
      }
    >
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div>
          {!recommender.supported ? (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              This browser has no Web Worker support, so recommendations are unavailable.
              The board below still works.
            </p>
          ) : null}

          {recommender.error !== null ? (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              The recommendation failed: {recommender.error}
            </p>
          ) : null}

          <Recommendations
            state={recommender}
            onPick={record}
            onTheClock={onTheClock}
            clockLabel={clockLabel}
          />

          <section className="mt-6">
            <h2 className="text-sm font-medium">
              Record pick {currentPick} &mdash; {clockLabel}
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
            {Object.keys(picks).length > 0 ? (
              <Button className="mt-3" size="sm" variant="outline" onClick={undo}>
                Undo pick {currentPick - 1}
              </Button>
            ) : null}
          </section>
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
  clockLabel,
}: {
  state: ReturnType<typeof useRecommendations>;
  onPick: (id: string) => void;
  onTheClock: boolean;
  clockLabel: string;
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
              <p className="text-xs text-muted-foreground">
                {(rec.championshipProbability * 100).toFixed(1)}% title ±
                {(rec.standardError * 100).toFixed(1)} ·{" "}
                {(rec.playoffProbability * 100).toFixed(0)}% playoffs
                {rec.tiedWithLeader && rec.player.id !== leader.player.id
                  ? " · tied with the leader"
                  : ""}
              </p>
            </div>
            {/*
              The button only records *your* pick, and only when the pick belongs to you.
              It used to render regardless: during an opponent's turn the panel says "if
              the board holds, take X", and tapping it wrote X as that opponent's pick —
              so you did not get the player, and whoever they really took stayed on the
              board and kept being recommended.
            */}
            {onTheClock ? (
              <Button size="sm" variant="outline" onClick={() => onPick(rec.player.id)}>
                Draft
              </Button>
            ) : (
              <span className="shrink-0 text-xs text-muted-foreground">
                {clockLabel} picks next
              </span>
            )}
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
  return (
    <p className="mt-6 text-xs text-muted-foreground">
      {boardSize} players.{" "}
      {freshness === null
        ? "Freshness unknown."
        : `Board built ${new Date(freshness.computedAt).toLocaleString()}.`}{" "}
      Odds assume a 14-week regular season and a three-week bracket. Player values blend
      the market&rsquo;s price with our own projection; measured out-of-sample, the market
      ranks players better than our model does and no edge over it is claimed. Kickers and
      defences carry the market&rsquo;s price alone. Scoring is limited to PPR, half PPR and
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
        const next = Math.round(Number(event.target.value));
        if (Number.isFinite(next)) onChange(Math.min(Math.max(next, min), max));
      }}
    />
  );
}
