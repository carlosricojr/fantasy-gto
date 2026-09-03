"use client";

import { memo, useEffect, useMemo, useRef } from "react";

import { cn } from "@/lib/utils";
import { boardColumns, boardGrid, boardPickOwner, pickLabel } from "./board-view";
import type { PoolPlayer } from "./pool-view";
import { positionBarClass, positionLabel } from "./positions";

/**
 * The draft board.
 *
 * The thing this screen was missing. A draft is a shared board: what has gone, who took
 * it, how the snake turns, and how far away your next pick is are all *spatial* facts, and
 * the previous interface expressed none of them — it tracked every team's picks because
 * the simulation needs them, and then showed the manager only their own roster. You could
 * not tell whether you had recorded the last three picks correctly, and you could not see
 * a run on a position starting, which is the single most actionable pattern in a draft.
 *
 * Drawn from `boardGrid`, whose arithmetic is proven against `snakePicks` in the domain
 * core, so a cell cannot end up under the wrong manager.
 */
export function BoardGrid({
  teams,
  slot,
  rounds,
  picks,
  playersById,
  currentPick,
  pickOwners,
  onSelectPick,
}: {
  teams: number;
  slot: number;
  rounds: number;
  picks: Readonly<Record<number, string>>;
  playersById: ReadonlyMap<string, PoolPlayer>;
  currentPick: number;
  /** Actual current owner by overall pick, including provider-reported trades. */
  pickOwners: ReadonlyMap<number, number>;
  /** Jumps the pool to whoever is in a cell, so a mis-recorded pick can be checked. */
  onSelectPick?: (pick: number) => void;
}) {
  // Memoized on the league shape alone. Both derivations allocate one object per cell —
  // 420 of them for a fourteen-team, thirty-round board — and they were being rebuilt on
  // every render of the page, including ones the board cannot be affected by: starring a
  // player, opening a dialog, typing in the pool's search box.
  const columns = useMemo(() => boardColumns(teams, slot), [teams, slot]);
  const rows = useMemo(() => boardGrid(teams, slot, rounds), [teams, slot, rounds]);
  const scroller = useRef<HTMLDivElement | null>(null);
  const clockCell = useRef<HTMLDivElement | null>(null);

  // Follows the clock down the board, inside the board's own scroller.
  //
  // Scoped to this element rather than `scrollIntoView`, which scrolls every ancestor
  // including the page: on a phone, moving the board to round nine would take the pool and
  // the record controls off the screen with it. The board tracks the draft; the page stays
  // where the reader put it.
  useEffect(() => {
    const container = scroller.current;
    const cell = clockCell.current;
    if (container === null || cell === null) return;
    // Measured against the two elements' own boxes rather than `offsetTop`. `offsetTop` is
    // relative to the nearest *positioned* ancestor, and the cells are `relative` for the
    // position bar inside them — so it resolved against the page, produced a number in the
    // thousands, and pinned the board to its last round from the first render. Bounding
    // rects are relative to the viewport, and their difference is the distance between the
    // two regardless of which ancestors happen to be positioned.
    const offset =
      cell.getBoundingClientRect().top - container.getBoundingClientRect().top;
    const top =
      container.scrollTop + offset - container.clientHeight / 2 + cell.clientHeight / 2;
    container.scrollTo({
      top: Math.max(0, top),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  }, [currentPick]);

  return (
    <div
      ref={scroller}
      // A group rather than a bare div, so the cells below are announced as part of
      // something named. The grid itself stays presentational: `role="row"` needs a row
      // element, a row element breaks the CSS grid, and `display: contents` with a role on
      // it is exactly the sort of thing that works in one browser. Ownership is carried in
      // each cell's accessible name instead, which is honest and needs no plumbing.
      role="group"
      aria-label={`Draft board, ${teams} teams, ${rounds} rounds`}
      // Focusable, so the arrow keys can scroll it. Before any pick is recorded every cell
      // is a plain span, so the region has no focusable child at all and a keyboard user
      // cannot reach the later rounds — a scrollable region with no keyboard route into it.
      tabIndex={0}
      // `relative` for the reason `player-pool.tsx` records at length: a scroll container
      // that is not a containing block does not clip absolutely positioned descendants, and
      // `sr-only` is absolute. This one escapes it today only by accident — every cell is
      // `relative` for its position bar — and an sr-only span added anywhere else in the
      // grid would silently add its offset to the height of the page.
      className="relative max-h-[13rem] overflow-auto overscroll-contain rounded-xl border bg-card sm:max-h-[18rem] lg:max-h-[22rem]"
    >
      <div
        className="grid text-xs"
        style={{
          // A fixed round gutter, then one equal column per seat. `minmax` rather than
          // `1fr` alone so a fourteen-team board scrolls sideways instead of squeezing
          // every name into three characters — and no `min-w-max`, which sized the tracks
          // to the longest name on the board and made a ten-team grid scroll sideways on a
          // desktop with room to spare.
          gridTemplateColumns: `2.5rem repeat(${teams}, minmax(5.5rem, 1fr))`,
        }}
      >
        {/* z-20 at most inside the board. These are sticky in the page's root stacking
            context, so anything higher paints over the page's sticky status bar (`z-30`) as
            the board scrolls under it, and the header cells are opaque.

            What keeps them in that context is the scroller's `z-index: auto`, not its
            position: it used to be static, and is `relative` now for clipping (see the
            class list above). `relative` with `z-index: auto` creates no stacking context,
            so **do not put a `z-*` utility on the scroller** — that, and not the position,
            is what would trap these behind the status bar. */}
        <div className="sticky top-0 left-0 z-20 border-r border-b bg-card" />
        {columns.map((column) => (
          // Two boxes, not one. The tint marking your own column is translucent, and a
          // *sticky* translucent box composites over whatever scrolls underneath it — so
          // the first round's names read straight through the header. The outer box is
          // opaque; the tint sits inside it.
          <div key={column.seat} className="sticky top-0 z-10 border-b bg-card">
            <div
              className={cn(
                "px-2 py-2 text-center font-medium",
                column.teamIndex === 0 ? "bg-brand/10 text-brand" : "text-muted-foreground",
              )}
            >
              {column.label}
            </div>
          </div>
        ))}

        {rows.map((row) => (
          <MemoRound
            key={row[0].round}
            row={row}
            picks={picks}
            playersById={playersById}
            currentPick={currentPick}
            teams={teams}
            slot={slot}
            pickOwners={pickOwners}
            clockRef={clockCell}
            onSelectPick={onSelectPick}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One round of cells.
 *
 * Memoized: the page re-renders on every keystroke in the pool's search box, and without
 * this each one reconciled the whole board.
 */
const MemoRound = memo(Round);

function Round({
  row,
  picks,
  playersById,
  currentPick,
  teams,
  slot,
  pickOwners,
  clockRef,
  onSelectPick,
}: {
  row: ReturnType<typeof boardGrid>[number];
  picks: Readonly<Record<number, string>>;
  playersById: ReadonlyMap<string, PoolPlayer>;
  currentPick: number;
  teams: number;
  slot: number;
  pickOwners: ReadonlyMap<number, number>;
  clockRef: React.RefObject<HTMLDivElement | null>;
  onSelectPick?: (pick: number) => void;
}) {
  return (
    <>
      <div
        className="sticky left-0 z-10 flex items-center justify-center border-r bg-card font-medium text-muted-foreground tabular-nums"
        aria-hidden
      >
        {row[0].round}
      </div>
      {row.map((cell) => {
        const playerId = picks[cell.pick];
        const player = playerId === undefined ? undefined : playersById.get(playerId);
        const onTheClock = cell.pick === currentPick;
        const owner = boardPickOwner(pickOwners, cell.pick, slot);
        const mine = owner?.teamIndex === 0;
        const traded = owner !== null && owner.teamIndex !== cell.teamIndex;

        return (
          <div
            key={cell.pick}
            ref={onTheClock ? clockRef : undefined}
            className={cn(
              "relative min-h-[3.25rem] border-r border-b p-1.5 last:border-r-0",
              mine && "bg-brand/[0.06]",
              onTheClock && "bg-brand/15 ring-2 ring-brand ring-inset",
            )}
          >
            {player === undefined ? (
              <span
                className={cn(
                  // Full-strength muted. `/70` over the card measures about 2.9:1, and a
                  // pick number is ordinary-sized text that has to clear 4.5:1.
                  "font-medium tabular-nums",
                  onTheClock ? "text-brand" : "text-muted-foreground",
                )}
              >
                <span aria-hidden>{pickLabel(cell.pick, teams)}</span>
                {/* Whose empty cell this is. Sighted readers get it from the column; a
                    screen reader user reading the grid linearly gets it from nowhere. */}
                <span className="sr-only">
                  Pick {pickLabel(cell.pick, teams)}, {owner === null ? "ownership unknown" : seatName(owner.teamIndex, owner.seat)}
                  {onTheClock ? ", on the clock" : ", not yet picked"}
                </span>
                {traded ? (
                  <span className="mt-0.5 block text-[0.625rem] text-brand">
                    {owner.teamIndex === 0 ? "Owned by you" : `Owned by Seat ${owner.seat}`}
                  </span>
                ) : null}
              </span>
            ) : (
              <CellPlayer
                player={player}
                pick={cell.pick}
                owner={owner}
                teams={teams}
                traded={traded}
                onSelect={onSelectPick}
              />
            )}
            {onTheClock && playerId === undefined ? (
              // Hidden from assistive technology: the sr-only sentence above already ends
              // "on the clock", and without this a screen reader hears it twice.
              <span className="mt-1 block font-medium text-brand" aria-hidden>
                On the clock
              </span>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

/** "You" or the seat, matching every other surface's name for a manager. */
function seatName(teamIndex: number, seat: number): string {
  return teamIndex === 0 ? "your pick" : `Seat ${seat}`;
}

function CellPlayer({
  player,
  pick,
  owner,
  teams,
  traded,
  onSelect,
}: {
  player: PoolPlayer;
  pick: number;
  owner: { teamIndex: number; seat: number } | null;
  teams: number;
  traded: boolean;
  onSelect?: (pick: number) => void;
}) {
  const body = (
    <>
      <span
        className={cn(
          "absolute inset-y-1.5 left-0 w-1 rounded-r",
          positionBarClass(player.position),
        )}
        aria-hidden
      />
      <span className="block truncate pl-1.5 font-medium">{player.name}</span>
      <span className="block truncate pl-1.5 text-muted-foreground">
        {positionLabel(player.position)}
        {player.team === null ? "" : ` · ${player.team}`}
      </span>
      <span
        className="block pl-1.5 text-[0.625rem] text-muted-foreground tabular-nums"
        aria-hidden
      >
        {pickLabel(pick, teams)}
      </span>
      {traded ? (
        <span className="block pl-1.5 text-[0.625rem] text-brand">
          {owner?.teamIndex === 0 ? "Owned by you" : `Owned by Seat ${owner?.seat}`}
        </span>
      ) : null}
    </>
  );

  if (onSelect === undefined) return <div className="relative">{body}</div>;
  return (
    <button
      type="button"
      onClick={() => onSelect(pick)}
      className="relative block w-full rounded-sm text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      // Names the pick and the manager as well as the player. "Bijan Robinson" repeated
      // across a board of two hundred buttons tells a screen reader user neither where
      // they are nor whose roster they are looking at — and who took what is the entire
      // reason this board exists.
      aria-label={`Pick ${pickLabel(pick, teams)}, ${owner === null ? "ownership unknown" : seatName(owner.teamIndex, owner.seat)}: ${player.name}, ${positionLabel(player.position)}. Show in the player list.`}
    >
      {body}
    </button>
  );
}
