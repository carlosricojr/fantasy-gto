"use client";

import { ChevronDown, ChevronUp, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PoolPlayer } from "./pool-view";
import { positionChipClass, positionLabel } from "./positions";

/**
 * The players you are watching, in the order you want them.
 *
 * A draft clock is short and a board is long, so the work of deciding is done between
 * turns, not during them. A queue is where that decision is kept. This one deliberately
 * does not auto-pick: nothing on this screen takes a player without being told to, because
 * the board here is a record of a draft happening elsewhere and an automatic pick would be
 * a claim about the world rather than a note about it.
 *
 * Players drafted by anyone drop out on their own — a queue that keeps offering a player
 * who is gone is worse than an empty one.
 */
export function QueuePanel({
  queue,
  playersById,
  onTheClock,
  onRecord,
  onRemove,
  onSwap,
}: {
  queue: readonly string[];
  playersById: ReadonlyMap<string, PoolPlayer>;
  onTheClock: boolean;
  onRecord: (playerId: string) => void;
  onRemove: (playerId: string) => void;
  /**
   * Exchanges two entries by id, not by index.
   *
   * The panel hides anyone already drafted, and it drops ids the board no longer carries —
   * a player can disappear between sessions. So "one place up" in what is on screen is not
   * always one place up in the stored list, and a move by index would leave the arrows
   * doing nothing for a click. The two rows being exchanged are named explicitly.
   */
  onSwap: (a: string, b: string) => void;
}) {
  const rows = queue
    .map((id) => playersById.get(id))
    .filter((player): player is PoolPlayer => player !== undefined && player.draftedAt === null);

  return (
    <section className="rounded-xl border bg-card">
      <header className="flex items-baseline justify-between gap-3 border-b p-3">
        <h2 className="text-sm font-semibold">Queue</h2>
        <span className="text-xs text-muted-foreground tabular-nums">{rows.length}</span>
      </header>

      {rows.length === 0 ? (
        <p className="p-3 text-xs text-muted-foreground">
          Star a player in the list to keep them here. Anyone drafted drops out on their own.
        </p>
      ) : (
        <>
          {onTheClock ? (
            <div className="border-b p-3">
              <Button className="w-full" size="sm" onClick={() => onRecord(rows[0].id)}>
                Take {rows[0].name}
              </Button>
            </div>
          ) : null}
          <ol className="divide-y">
            {rows.map((player, index) => {
              // Resolved here rather than indexed inside the handlers. `rows[index - 1].id`
              // is only safe because `IconButton` returns early, which makes a guard in one
              // component load-bearing for an expression in another — the kind of coupling
              // that turns into a TypeError the next time either is touched.
              const above = rows[index - 1];
              const below = rows[index + 1];
              return (
              <li key={player.id} className="flex items-center gap-2 px-3 py-2">
                <span className="w-3 shrink-0 text-xs text-muted-foreground tabular-nums">
                  {index + 1}
                </span>
                <span
                  className={cn(
                    "inline-flex w-9 shrink-0 justify-center rounded px-1 py-0.5 text-[0.625rem] font-semibold ring-1 ring-inset",
                    positionChipClass(player.position),
                  )}
                >
                  {positionLabel(player.position)}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">{player.name}</span>
                <span className="flex shrink-0 items-center">
                  {/* `aria-disabled` rather than `disabled`, for the reason the status
                      bar's Undo carries: moving an entry to the end of the queue disables
                      its own down arrow on the same commit, and a focused element that
                      becomes `disabled` is dropped from the tab order — so a keyboard user
                      is returned to <body> by the act of using the control. */}
                  <IconButton
                    label={`Move ${player.name} up the queue`}
                    unavailable={above === undefined}
                    onClick={() => {
                      if (above !== undefined) onSwap(player.id, above.id);
                    }}
                  >
                    <ChevronUp className="size-3.5" />
                  </IconButton>
                  <IconButton
                    label={`Move ${player.name} down the queue`}
                    unavailable={below === undefined}
                    onClick={() => {
                      if (below !== undefined) onSwap(player.id, below.id);
                    }}
                  >
                    <ChevronDown className="size-3.5" />
                  </IconButton>
                  <IconButton
                    label={`Remove ${player.name} from the queue`}
                    onClick={() => onRemove(player.id)}
                  >
                    <X className="size-3.5" />
                  </IconButton>
                </span>
              </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}

function IconButton({
  label,
  unavailable,
  onClick,
  children,
}: {
  label: string;
  /** Announced as disabled and styled as such, but still focusable and still a no-op. */
  unavailable?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-disabled={unavailable}
      onClick={() => {
        if (unavailable === true) return;
        onClick();
      }}
      className={cn(
        "rounded p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
        unavailable === true && "opacity-30 hover:text-muted-foreground",
      )}
    >
      {children}
    </button>
  );
}
