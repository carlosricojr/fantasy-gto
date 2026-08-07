"use client";

import { useMemo } from "react";

import type { RosterSlot } from "@/lib/core/optimizer";
import type { PlayerRisk } from "@/lib/core/roster-utility";
import type { ValueBasis } from "@/lib/nfl/draft/provenance";
import { cn } from "@/lib/utils";
import { BasisBadge } from "./basis-badge";
import { pickLabel } from "./board-view";
import { byeGaps, solveRoster } from "./pool-view";
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
  basisFor,
}: {
  slots: readonly RosterSlot[];
  roster: readonly PlayerRisk[];
  /** Which pick each player was taken at, for the line under their name. */
  pickByPlayerId: ReadonlyMap<string, number>;
  /** League size, so a pick is named "3.04" here as it is everywhere else. */
  teams: number;
  /** Where each player's number came from, so a market-only starter is marked here too. */
  basisFor: (player: { id: string; position: string }) => ValueBasis;
}) {
  const byId = useMemo(() => new Map(roster.map((player) => [player.id, player])), [roster]);

  // The shared mapping, not a third copy of it. What this panel displays and what
  // `byeGaps` computes have to come from the same solve of the same inputs, or the empty
  // slots listed here and the byes blamed below them can disagree. Points are per week
  // played, which is what `weeklyMean` is — so the starters' total is "a week they all
  // play", and the footer says exactly that.
  const solution = useMemo(() => solveRoster(slots, roster), [slots, roster]);

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
                  basisFor={basisFor}
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
                  basisFor={basisFor}
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

      <ByeGaps slots={slots} roster={roster} />
    </section>
  );
}

function PlayerLine({
  player,
  pick,
  teams,
  basisFor,
}: {
  player: PlayerRisk;
  pick: number | undefined;
  teams: number;
  basisFor: (player: { id: string; position: string }) => ValueBasis;
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
        <span className="flex min-w-0 items-center text-sm">
          <span className="truncate">{player.name}</span>
          <BasisBadge basis={basisFor(player)} />
        </span>
        <span className="block truncate text-xs text-muted-foreground tabular-nums">
          {player.byeWeek === null ? "no bye listed" : `bye ${player.byeWeek}`}
          {pick === undefined ? "" : ` · pick ${pickLabel(pick, teams)}`}
        </span>
      </span>
    </span>
  );
}

/**
 * Bye weeks that cost a starting slot.
 *
 * The thing a points-based board cannot show, and the reason it is worth its own block:
 * the cost is not "two players share a week", it is "this slot has nobody to fill it that
 * week". `byeGaps` answers that by solving the lineup again without the week's players,
 * which is the same exact matching the panel above uses, so the two cannot disagree.
 */
function ByeGaps({
  slots,
  roster,
}: {
  slots: readonly RosterSlot[];
  roster: readonly PlayerRisk[];
}) {
  const gaps = useMemo(() => byeGaps(slots, roster), [slots, roster]);
  if (gaps.length === 0) return null;

  return (
    <div className="border-t p-3">
      <p className="text-xs font-semibold">Byes that leave a slot empty</p>
      <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
        {gaps.map((gap) => (
          <li key={gap.week} className="tabular-nums">
            Week {gap.week}: no {gap.slots.join(", ")}
          </li>
        ))}
      </ul>
    </div>
  );
}
