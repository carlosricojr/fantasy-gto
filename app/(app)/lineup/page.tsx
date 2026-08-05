"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";

import { api } from "@/convex/_generated/api";
import { EmptyState, PageShell } from "@/components/page-shell";
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
  const projections = useQuery(
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
  const selectedProjections = useQuery(
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
  const players = useQuery(
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

  if (season === undefined) return <PageShell title="Lineup">Loading…</PageShell>;

  if (season === null) {
    return (
      <PageShell title="Lineup">
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

      {roster.length === 0 && selected.length > 0 && projections === undefined ? (
        <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">
          Recalculating for the new ruleset&hellip;
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
                  {player.name ?? <span className="inline-block h-3 w-28 animate-pulse rounded bg-muted align-middle" />}
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
