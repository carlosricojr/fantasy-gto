"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";

import { api } from "@/convex/_generated/api";
import { EmptyState, PageShell } from "@/components/page-shell";
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

  const projections = useQuery(
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

  const players = useQuery(
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

      {projections === undefined && <p className="text-muted-foreground">Loading…</p>}

      {projections !== undefined && projections.length === 0 && (
        <EmptyState
          title="No projections for this week"
          body="Nothing has been computed for this week and ruleset yet."
        />
      )}

      <div className="space-y-2">
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
