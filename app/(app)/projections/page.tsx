"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";

import { api } from "@/convex/_generated/api";
import { EmptyState, PageShell } from "@/components/page-shell";
import { useStableQuery } from "@/components/use-stable-query";
import { ProjectionCard } from "@/components/projection-card";
import { Button } from "@/components/ui/button";
import { DEFAULT_SCORING, SCORING_PRESETS } from "@/lib/nfl/scoring/presets";
import { describeSeasonState } from "@/lib/nfl/season";

const FILTERABLE_POSITIONS = ["QB", "RB", "WR", "TE"] as const;

/**
 * The projections board.
 *
 * Every number here is real model output read from Convex, and every card expands to show
 * the contributions that produced it.
 *
 * Deliberately available without an account. The product's argument is that value should
 * be demonstrated before payment is requested, so the core read is not gated.
 */
export default function ProjectionsPage() {
  const [scoringId, setScoringId] = useState(DEFAULT_SCORING.id);
  const [position, setPosition] = useState<string | null>(null);

  const season = useQuery(api.season.current, {});

  // Held across a scoring or position change rather than blanked. A Convex result is keyed
  // by its arguments, so every one of those buttons sent this back to `undefined` and the
  // hundred cards below vanished for the length of a round trip before reappearing — the
  // page losing its whole height and the reader losing their scroll position, on a control
  // whose only job is to re-sort what is already there.
  const { data: projections, pending } = useStableQuery(
    api.projections.forWeek,
    season
      ? {
          season: season.season,
          week: season.week,
          scoringId,
          position: position ?? undefined,
          limit: 100,
        }
      : "skip",
  );

  const playerIds = useMemo(
    () => (projections ?? []).map((row) => row.playerId),
    [projections],
  );

  const { data: players } = useStableQuery(
    api.projections.playersByIds,
    playerIds.length > 0 ? { externalIds: playerIds } : "skip",
  );

  const playerById = useMemo(() => {
    const map = new Map<string, { name: string; team: string | null }>();
    for (const player of players ?? []) {
      map.set(player.externalId, { name: player.name, team: player.team });
    }
    return map;
  }, [players]);

  if (season === undefined) {
    return <PageShell title="Projections">Loading…</PageShell>;
  }

  if (season === null) {
    return (
      <PageShell title="Projections">
        <EmptyState
          title="No schedule loaded yet"
          body="Projections appear once NFL data has been ingested. Run the ingest job to populate them."
        />
      </PageShell>
    );
  }

  return (
    <PageShell title="Projections" subtitle={describeSeasonState(season)}>
      <div className="mb-4 flex flex-wrap gap-2">
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

      <div className="mb-6 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={position === null ? "secondary" : "ghost"}
          aria-pressed={position === null}
          onClick={() => setPosition(null)}
        >
          All
        </Button>
        {FILTERABLE_POSITIONS.map((code) => (
          <Button
            key={code}
            size="sm"
            variant={position === code ? "secondary" : "ghost"}
            aria-pressed={position === code}
            onClick={() => setPosition(code)}
          >
            {code}
          </Button>
        ))}
      </div>

      {scoringId !== DEFAULT_SCORING.id && (
        <p className="mb-4 rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
          The model&rsquo;s calibration, its floor/ceiling range, and the published accuracy
          figure were all measured under PPR. For {SCORING_PRESETS.find((p) => p.id === scoringId)?.label},
          projections are rescaled but that validation does not carry over.
        </p>
      )}

      {projections === undefined ? (
        // First load only; a later change keeps the cards. The blocks are the height of the
        // cards that replace them so the first paint settles rather than jumps.
        <>
          {/* The announcement is a *sibling* of the blocks, not a child. `aria-hidden`
              removes its whole subtree from the accessibility tree, live region included —
              so nested, the one element that exists to tell a screen reader user the page
              is loading was the one element guaranteed never to fire. */}
          <div className="space-y-2" aria-hidden>
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="h-20 motion-safe:animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
          <p className="sr-only" role="status">
            Loading projections.
          </p>
        </>
      ) : null}

      {/* Always present, empty when there is nothing to say — a live region introduced at
          the moment its message appears is often not announced. It replaces no layout: the
          cards below stay exactly where they are while the new ruleset loads. */}
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
            <span className="hidden sm:inline">Loading the new selection — the cards below are the previous one&rsquo;s.</span>
            <span className="sm:hidden">Cards are the previous selection&rsquo;s.</span>
          </>
        ) : null}
      </p>

      {projections !== undefined && projections.length === 0 && (
        <EmptyState
          title="No projections for this week"
          body="Nothing has been computed for this week and ruleset yet."
        />
      )}

      <div className="space-y-2" aria-busy={pending}>
        {(projections ?? []).map((row) => {
          const player = playerById.get(row.playerId);
          return (
            <ProjectionCard
              key={row._id}
              // Names arrive from a second query. Falling back to the upstream id would
              // render "00-0036900" as a player's name on every load and filter change.
              name={player?.name ?? null}
              position={row.position}
              team={row.team}
              subtitle={`vs ${row.opponent}`}
              mean={row.mean}
              floor={row.floor}
              ceiling={row.ceiling}
              contributions={row.contributions}
            />
          );
        })}
      </div>
    </PageShell>
  );
}
