"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";

import { api } from "@/convex/_generated/api";
import { EmptyState, PageShell } from "@/components/page-shell";
import { useStableQuery } from "@/components/use-stable-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  type OptimizableCompetitor,
  solveLineup,
} from "@/lib/core/optimizer";
import { ROSTER_TEMPLATES, slotsForTemplate } from "@/lib/nfl/roster";
import { DEFAULT_SCORING, SCORING_PRESETS } from "@/lib/nfl/scoring/presets";
import { describeSeasonState } from "@/lib/nfl/season";

/**
 * The lineup optimizer.
 *
 * Runs entirely in the browser against projections read from Convex, so it works with no
 * account and no league connected. The solver is the same pure function the server uses
 * (`lib/core/optimizer.ts`), which is what lets it run here at all.
 *
 * The headline number is the gain over filling slots greedily by projection. That
 * comparison is honest and checkable: greedy is what a person does by hand, and the
 * difference is real points.
 */
export default function LineupPage() {
  const [templateId, setTemplateId] = useState(ROSTER_TEMPLATES[0].id);
  const [scoringId, setScoringId] = useState(DEFAULT_SCORING.id);
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");

  const season = useQuery(api.season.current, {});

  // Deliberately unlimited.
  //
  // A ranked board can be capped; a roster picker cannot. With `limit: 300` against a week
  // of ~468 projected players, roughly 168 real players could not be added at all, and
  // searching for one rendered "No players match that search" — which reads as "this
  // player does not exist" on the path the README calls the working one. A single week of
  // a single ruleset is a few hundred rows.
  // Held across a ruleset change. Changing the scoring format keyed a different query, so
  // this went back to `undefined` and the solved lineup was replaced by a "Recalculating"
  // box — the answer to the same roster under slightly different rules, thrown away and
  // rebuilt from nothing on every click.
  const { data: projections, pending } = useStableQuery(
    api.projections.forWeek,
    season ? { season: season.season, week: season.week, scoringId } : "skip",
  );

  // Selected players are fetched by id as well as through the board.
  //
  // With `forWeek` uncapped this is belt-and-braces rather than load-bearing: the board
  // already contains every row for the week and ruleset. It stays because the failure it
  // prevents is silent and severe — a selected player missing from the pool disappears
  // from the optimizer's input while their roster chip keeps rendering a placeholder, and
  // the page still calls the answer the best arrangement the roster allows. Anything that
  // reintroduces a cap on the board should not also be able to reintroduce that.
  const { data: selectedProjections } = useStableQuery(
    api.projections.forPlayers,
    season && selected.length > 0
      ? { playerIds: selected, season: season.season, week: season.week, scoringId }
      : "skip",
  );

  const playerIds = useMemo(() => {
    const ids = new Set((projections ?? []).map((row) => row.playerId));
    for (const row of selectedProjections ?? []) ids.add(row.playerId);
    return [...ids];
  }, [projections, selectedProjections]);
  const { data: players } = useStableQuery(
    api.projections.playersByIds,
    playerIds.length > 0 ? { externalIds: playerIds } : "skip",
  );

  const pool = useMemo(() => {
    const byId = new Map((players ?? []).map((p) => [p.externalId, p]));
    // Ranked board first, then any selected player it did not include.
    const rows = [...(projections ?? [])];
    const present = new Set(rows.map((r) => r.playerId));
    for (const row of selectedProjections ?? []) {
      if (!present.has(row.playerId)) rows.push(row);
    }
    return rows.map((row) => {
      const player = byId.get(row.playerId);
      return {
        id: row.playerId,
        name: player?.name ?? null,
        position: row.position,
        // The projection's own team, not the player record's: a mid-season trade would
        // make the two disagree, and the projection was computed for the former.
        team: row.team,
        opponent: row.opponent,
        projectedPoints: row.mean,
      };
    });
  }, [projections, selectedProjections, players]);

  const slots = useMemo(() => slotsForTemplate(templateId), [templateId]);

  const roster: OptimizableCompetitor[] = useMemo(
    () =>
      pool
        .filter((p) => selected.includes(p.id))
        .map((p) => ({
          id: p.id,
          name: p.name ?? p.id,
          position: p.position,
          projectedPoints: p.projectedPoints,
          // Safe to hardcode: a projection is only written for a player whose team plays
          // that week, so everyone in this pool has a game. Bye-week players are absent
          // from `projections` entirely rather than being filtered here.
          availability: "active" as const,
        })),
    [pool, selected],
  );

  const solution = useMemo(() => solveLineup(slots, roster), [slots, roster]);

  /**
   * Greedy comparison: highest projection into the first slot it fits.
   *
   * This is what a person does filling a lineup by hand, and it is the baseline the
   * optimizer's headline number is measured against.
   */
  const greedyTotal = useMemo(() => {
    const taken = new Set<string>();
    let total = 0;
    for (const player of [...roster].sort((a, b) => b.projectedPoints - a.projectedPoints)) {
      const slot = slots.find(
        (s) => !taken.has(s.id) && s.eligiblePositions.includes(player.position),
      );
      if (!slot) continue;
      taken.add(slot.id);
      total += player.projectedPoints;
    }
    return Math.round(total * 100) / 100;
  }, [roster, slots]);

  const gain = Math.round((solution.totalPoints - greedyTotal) * 100) / 100;

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return pool
      .filter((p) => !selected.includes(p.id))
      .filter((p) => term === "" || (p.name ?? "").toLowerCase().includes(term))
      .slice(0, 40);
  }, [pool, selected, search]);

  const nameById = useMemo(
    () => new Map(pool.map((p) => [p.id, p.name])),
    [pool],
  );

  if (season === undefined) {
    // The shape of what actually arrives on a cold load, which is not the solved lineup:
    // `selected` starts empty and is not persisted, so the resolved page shows the empty
    // state and the picker under it. A skeleton shaped like the *solved* section stood for
    // a section that had never rendered.
    //
    // The control row is one chip per control — nine roster templates and three scoring
    // presets — each carrying its own label invisibly, so a chip is the width of the button
    // it stands for and the row wraps where the real row wraps. One chip per control with a
    // guessed width was 150px wider in total, which is a wrapped line's worth on a phone.
    return (
      <PageShell title="Lineup optimizer" subtitle={<Skeleton className="h-5 w-64 max-w-full" />}>
        {/* `h-5`, which is `text-sm`'s 1.25rem line box — not `h-4`, which was the
              first guess and four pixels short of the paragraph it stands in for.

              One line, and it can only reserve one. `describeSeasonState` returns a
              sentence whose length depends on where the season is — 76 characters in the
              offseason, a dozen in week 3 — so on a narrow phone the real subtitle
              sometimes wraps to two and this still gives up a line. A fixed reserve cannot
              track that, and reserving two lines everywhere would over-reserve in season. */}
        <div className="mb-4 flex flex-wrap gap-2">
          {ROSTER_TEMPLATES.map((template) => (
            <Skeleton key={template.id} className="h-8 px-3 text-sm">
              {template.label}
            </Skeleton>
          ))}
          {/* The separator the real row carries between the two groups. */}
          <span className="mx-1 w-px" aria-hidden />
          {SCORING_PRESETS.map((preset) => (
            <Skeleton key={preset.id} className="h-8 px-3 text-sm">
              {preset.label}
            </Skeleton>
          ))}
        </div>
        {/* The always-present status line the resolved page keeps empty, then the empty
            state, then the picker. */}
        <div className="mb-3 h-4" />
        <Skeleton className="h-[9.5rem] rounded-lg" />
        {/* `mt-8` and 8rem, matching the picker as it renders at the moment the season
            resolves — not as it settles. `projections` is still `"skip"`-ed at that instant,
            so the section is its heading row, the search input, "Loading players…" and an
            empty bordered list: about 126px, not the 256px a filled picker occupies. The
            block above this one was rewritten for exactly this reason and this one was left
            aimed at the settled page. */}
        <Skeleton className="mt-8 h-32 rounded-lg" />
        {/* Ordinary off-screen text rather than a live region, for the reason recorded on
            the projections page: a region that mounts with its content has no change to
            announce. */}
        <p className="sr-only">Loading the optimizer.</p>
      </PageShell>
    );
  }

  if (season === null) {
    // The same title as the loading branch and the resolved one. It read "Lineup" here and
    // "Lineup optimizer" everywhere else, so a deployment with no ingest run retitled the
    // page as it resolved — the same handoff shift the loading skeleton exists to remove.
    return (
      <PageShell title="Lineup optimizer">
        <EmptyState
          title="No schedule loaded yet"
          body="The optimizer needs projections. Run the ingest job to populate them."
        />
      </PageShell>
    );
  }

  return (
    <PageShell title="Lineup optimizer" subtitle={describeSeasonState(season)}>
      <div className="mb-4 flex flex-wrap gap-2">
        {ROSTER_TEMPLATES.map((template) => (
          <Button
            key={template.id}
            size="sm"
            variant={template.id === templateId ? "default" : "outline"}
            aria-pressed={template.id === templateId}
            onClick={() => setTemplateId(template.id)}
            title={template.description}
          >
            {template.label}
          </Button>
        ))}
        <span className="mx-1 w-px bg-border" aria-hidden />
        {SCORING_PRESETS.map((preset) => (
          <Button
            key={preset.id}
            size="sm"
            variant={preset.id === scoringId ? "secondary" : "ghost"}
            aria-pressed={preset.id === scoringId}
            onClick={() => setScoringId(preset.id)}
          >
            {preset.label}
          </Button>
        ))}
      </div>

      {/* The lineup itself no longer disappears while a ruleset loads, so this says what is
          happening in one line instead of replacing the answer with a box. Always in the
          DOM and empty when idle, for the same live-region reason as the draft's status
          bar; a fixed height so it cannot move the lineup by appearing. */}
      <p
        className="mb-3 h-4 truncate text-xs font-medium text-amber-700 dark:text-amber-300"
        role="status"
      >
        {pending ? (
          <>
            {/* Two lengths and a `truncate` backstop, the same treatment the draft's status
                bar needs for the same reason: at 12px the long sentence runs about 470px,
                which is wider than a phone's content column, and a fixed-height box with a
                sentence wrapping inside it does not push the page down — it renders the
                second line straight over whatever comes next. */}
            <span className="hidden sm:inline">Loading the new ruleset — the points below are the previous one&rsquo;s.</span>
            <span className="sm:hidden">Points are the previous ruleset&rsquo;s.</span>
          </>
        ) : null}
      </p>

      {roster.length === 0 && selected.length > 0 && projections === undefined ? (
        <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">
          Loading the projections&hellip;
        </div>
      ) : roster.length === 0 ? (
        <EmptyState
          title="Add players to get started"
          body="Pick the players on your roster below. The optimal lineup is calculated as you go — no account needed."
        />
      ) : (
        <section className="rounded-lg border">
          <header className="flex items-baseline justify-between gap-4 border-b p-4">
            <div>
              <h2 className="font-medium">Optimal lineup</h2>
              <p className="text-xs text-muted-foreground">
                {gain > 0
                  ? `${gain.toFixed(2)} points better than filling slots greedily.`
                  : "Filling greedily happens to be optimal for this roster."}
              </p>
            </div>
            <span className="text-2xl font-semibold tabular-nums">
              {solution.totalPoints.toFixed(1)}
            </span>
          </header>

          <ul className="divide-y">
            {solution.assignments.map((assignment) => (
              <li
                key={assignment.slotId}
                className="flex items-center gap-3 px-4 py-2 text-sm"
              >
                <span className="w-20 shrink-0 text-xs font-medium text-muted-foreground">
                  {assignment.slotLabel}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {assignment.competitorId
                    ? (nameById.get(assignment.competitorId) ?? "\u2026")
                    : <span className="text-muted-foreground">empty</span>}
                </span>
                <span className="shrink-0 tabular-nums">
                  {assignment.projectedPoints.toFixed(1)}
                </span>
              </li>
            ))}
          </ul>

          {solution.benchedIds.length > 0 && (
            <footer className="border-t px-4 py-3">
              <p className="text-xs font-medium text-muted-foreground">Bench</p>
              <p className="mt-1 text-sm">
                {solution.benchedIds
                  .map((id) => nameById.get(id) ?? "\u2026")
                  .join(", ")}
              </p>
            </footer>
          )}
        </section>
      )}

      <section className="mt-8">
        <div className="mb-3 flex items-center gap-3">
          <h2 className="font-medium">Your roster</h2>
          {selected.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
              Clear
            </Button>
          )}
        </div>

        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search players…"
          aria-label="Search players"
        />

        {selected.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-2">
            {selected.map((id) => (
              <li key={id}>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setSelected((ids) => ids.filter((x) => x !== id))}
                >
                  {nameById.get(id) ?? "\u2026"} ✕
                </Button>
              </li>
            ))}
          </ul>
        )}

        {projections === undefined && (
          <p className="mt-4 text-sm text-muted-foreground">Loading players…</p>
        )}

        <ul className="mt-4 divide-y rounded-lg border">
          {filtered.map((player) => (
            <li key={player.id}>
              <button
                type="button"
                onClick={() => setSelected((ids) => [...ids, player.id])}
                className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-muted/50"
              >
                <span className="w-10 shrink-0 text-xs font-medium text-muted-foreground">
                  {player.position}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {player.name ?? <Skeleton className="inline-block h-3 w-28 align-middle" />}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {player.team} vs {player.opponent}
                </span>
                <span className="w-12 shrink-0 text-right tabular-nums">
                  {player.projectedPoints.toFixed(1)}
                </span>
              </button>
            </li>
          ))}
          {projections !== undefined && filtered.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">
              No players match that search.
            </li>
          )}
        </ul>
      </section>
    </PageShell>
  );
}
