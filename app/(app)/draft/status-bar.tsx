"use client";

import { RotateCcw, Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TurnDescription } from "./board-view";

/**
 * Whose pick it is, how far along the draft is, and the two controls that must never be
 * more than one tap away.
 *
 * Sticky, because it answers the question the reader asks after every single pick and the
 * answer used to live in a page subtitle that scrolled away. Undo is here rather than
 * beside the list for the same reason: the moment it is needed is the moment a wrong name
 * has just been recorded, and hunting for it costs the clock.
 *
 * There is no pick timer. This board records a draft happening somewhere else, so a
 * countdown here would be a number the product cannot actually produce — it would be
 * counting its own clock, not the room's.
 */
export function StatusBar({
  turn,
  pickLabel,
  currentPick,
  totalPicks,
  picksUntilTurn,
  nextOwnPickLabel,
  canUndo,
  onUndo,
  onOpenSettings,
}: {
  turn: TurnDescription;
  /** "3.07" for the pick on the clock. */
  pickLabel: string | null;
  currentPick: number;
  totalPicks: number;
  /** Picks before your next turn; 0 when it is yours, `null` when you have none left. */
  picksUntilTurn: number | null;
  nextOwnPickLabel: string | null;
  canUndo: boolean;
  onUndo: () => void;
  onOpenSettings: () => void;
}) {
  const made = Math.min(currentPick - 1, totalPicks);
  const progress = totalPicks === 0 ? 0 : (made / totalPicks) * 100;

  return (
    // The offset is the header token, not a pixel literal repeated here. `--app-header-h`
    // is the browser-measured height that `scroll-padding-top` was also set from; the last
    // time this number was reasoned about from class names instead of measured it was
    // three pixels wrong at phone width, and focus rings were clipped by exactly that.
    <div className="sticky top-[var(--app-header-h)] z-30 -mx-4 border-b bg-background/85 px-4 backdrop-blur sm:-mx-6 sm:px-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2">
            {turn.complete ? null : (
              <span
                className={cn(
                  "inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums",
                  // `text-background`, not `text-white`. The brand is a *dark* green in
                  // light mode and a *light* green in dark mode, so white type on it goes
                  // from 4.6:1 to about 1.5:1 the moment the theme flips — unreadable on
                  // the one chip that says whose pick it is. The page background inverts
                  // with the brand, so it is legible against both.
                  turn.mine ? "bg-brand text-background" : "bg-muted text-muted-foreground",
                )}
              >
                {pickLabel}
              </span>
            )}
            <span className={cn("truncate font-semibold", turn.mine && "text-brand")}>
              {turn.complete
                ? "Draft complete"
                : turn.mine
                  ? "You are on the clock"
                  : `${turn.who} on the clock`}
            </span>
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground tabular-nums">
            {made} of {totalPicks} picks recorded
            {picksUntilTurn === null || turn.complete
              ? ""
              : picksUntilTurn === 0
                ? " · your turn now"
                : ` · your next pick ${nextOwnPickLabel} — ${picksUntilTurn} away`}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* `aria-disabled`, not `disabled`. Undoing the only recorded pick flips
              `canUndo` false on the same commit, and a focused element that becomes
              `disabled` is dropped from the tab order — the browser moves focus to
              <body> and the next Tab restarts at the top of the page, right after a
              keyboard user has pressed the button. `undoPick` already returns the state
              unchanged when there is nothing to remove, so the no-op is safe. */}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (!canUndo) return;
              onUndo();
            }}
            aria-disabled={!canUndo}
            className={cn(!canUndo && "opacity-50")}
          >
            <RotateCcw />
            <span className="hidden sm:inline">Undo</span>
            <span className="sr-only sm:hidden">Undo the last pick</span>
          </Button>
          <Button size="sm" variant="ghost" onClick={onOpenSettings}>
            <Settings2 />
            <span className="hidden sm:inline">Settings</span>
            <span className="sr-only sm:hidden">Draft settings</span>
          </Button>
        </div>
      </div>

      <div className="h-0.5 w-full rounded-full bg-muted" aria-hidden>
        <div
          className="h-full rounded-full bg-brand transition-[width] duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}
