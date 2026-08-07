"use client";

import { useMemo } from "react";

import { type RosterSlot, solveLineup } from "@/lib/core/optimizer";
import type { PlayerRisk } from "@/lib/core/roster-utility";
import { cn } from "@/lib/utils";
import { pickLabel } from "./board-view";
import { positionChipClass, positionLabel } from "./positions";

/**
 * The roster, by slot.
 *
 * The old panel was a flat list of names, which cannot answer the question a manager asks
 * between every pick: *what am I still missing*. Three running backs read as depth in a
 * list and as one empty receiver slot in a lineup, and only one of those is true.
 *
 * The assignment is solved by the same maximum-weight matching that decides a weekly
 * lineup, so flex is handled exactly rather than by counting positions against slot names.
 * That solver is this product's one provable claim, and until now the draft screen — the
 * place its answer is most actionable — did not use it.
 */
export function MyTeam({
  slots,
  roster,
  pickByPlayerId,
  teams,
}: {
  slots: readonly RosterSlot[];
  roster: readonly PlayerRisk[];
  /** Which pick each player was taken at, for the line under their name. */
  pickByPlayerId: ReadonlyMap<string, number>;
  /** League size, so a pick is named "3.04" here as it is everywhere else. */
  teams: number;
}) {
  const byId = useMemo(() => new Map(roster.map((player) => [player.id, player])), [roster]);

  const solution = useMemo(
    () =>
      solveLineup(
        slots,
        roster.map((player) => ({
          id: player.id,
          name: player.name,
          position: player.position,
          // Points in a week he plays, which is what `weeklyMean` is. The starters' total
          // below is therefore "a week they all play", and it says so.
          projectedPoints: player.weeklyMean,
          availability: "active" as const,
        })),
      ),
    [slots, roster],
  );

  const bench = solution.benchedIds
    .map((id) => byId.get(id))
    .filter((player): player is PlayerRisk => player !== undefined);

  const filled = solution.assignments.filter((a) => a.competitorId !== null).length;

  return (
    <section className="rounded-xl border bg-card">
      <header className="flex items-baseline justify-between gap-3 border-b p-3">
        <h2 className="text-sm font-semibold">Your team</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {filled}/{slots.length} starters
        </span>
      </header>

      <ul className="divide-y">
        {solution.assignments.map((assignment) => {
          const player =
            assignment.competitorId === null ? undefined : byId.get(assignment.competitorId);
          return (
            <li key={assignment.slotId} className="flex items-center gap-2.5 px-3 py-2">
              <span className="w-11 shrink-0 text-xs font-semibold text-muted-foreground">
                {assignment.slotLabel}
              </span>
              {player === undefined ? (
                <span className="text-sm text-muted-foreground">Empty</span>
              ) : (
                <PlayerLine
                  player={player}
                  pick={pickByPlayerId.get(player.id)}
                  teams={teams}
                />
              )}
            </li>
          );
        })}
      </ul>

      {bench.length === 0 ? null : (
        <>
          <p className="border-t px-3 pt-2 text-xs font-semibold text-muted-foreground">
            Bench
          </p>
          <ul className="divide-y pb-1">
            {bench.map((player) => (
              <li key={player.id} className="flex items-center gap-2.5 px-3 py-2">
                <span className="w-11 shrink-0 text-xs font-semibold text-muted-foreground">
                  BN
                </span>
                <PlayerLine
                  player={player}
                  pick={pickByPlayerId.get(player.id)}
                  teams={teams}
                />
              </li>
            ))}
          </ul>
        </>
      )}

      {roster.length === 0 ? null : (
        <footer className="border-t p-3 text-xs text-muted-foreground">
          Starters project {solution.totalPoints.toFixed(1)} points in a week they all play.
          The slot assignment is solved exactly — no legal arrangement of these players
          scores higher.
        </footer>
      )}

      <ByeCollisions roster={roster} />
    </section>
  );
}

function PlayerLine({
  player,
  pick,
  teams,
}: {
  player: PlayerRisk;
  pick: number | undefined;
  teams: number;
}) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span
        className={cn(
          "inline-flex w-9 shrink-0 justify-center rounded px-1 py-0.5 text-[0.625rem] font-semibold ring-1 ring-inset",
          positionChipClass(player.position),
        )}
      >
        {positionLabel(player.position)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{player.name}</span>
        <span className="block truncate text-xs text-muted-foreground tabular-nums">
          {player.byeWeek === null ? "no bye listed" : `bye ${player.byeWeek}`}
          {pick === undefined ? "" : ` · pick ${pickLabel(pick, teams)}`}
        </span>
      </span>
    </span>
  );
}

/**
 * Bye collisions.
 *
 * The thing a points-based board cannot show: two backs on the same bye means a week
 * fielding one fewer of them, and no ranking of season totals expresses that. The
 * simulation prices it already — this is the same fact made visible while there is still
 * time to draft around it.
 */
function ByeCollisions({ roster }: { roster: readonly PlayerRisk[] }) {
  const crowded = useMemo(() => {
    const byWeek = new Map<number, string[]>();
    for (const player of roster) {
      if (player.byeWeek === null) continue;
      byWeek.set(player.byeWeek, [
        ...(byWeek.get(player.byeWeek) ?? []),
        positionLabel(player.position),
      ]);
    }
    return [...byWeek.entries()]
      .filter(([, positions]) => positions.length > 1)
      .sort((a, b) => a[0] - b[0]);
  }, [roster]);

  if (crowded.length === 0) return null;

  return (
    <div className="border-t p-3">
      <p className="text-xs font-semibold">Bye weeks doubled up</p>
      <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
        {crowded.map(([week, positions]) => (
          <li key={week} className="tabular-nums">
            Week {week}: {positions.join(", ")}
          </li>
        ))}
      </ul>
    </div>
  );
}
