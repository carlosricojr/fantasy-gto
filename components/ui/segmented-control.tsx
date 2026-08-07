"use client";

import { useRef } from "react";

import { cn } from "@/lib/utils";

/**
 * A segmented control: one choice from a short, fixed list.
 *
 * The draft screen makes about a dozen of these choices — league size, scoring, roster
 * shape, which position the pool is filtered to, how it is sorted — and every one of them
 * was previously a row of outline buttons that looked identical to the row of *action*
 * buttons next to it. A control that sets state and a control that does something should
 * not look the same.
 *
 * Radio semantics rather than `aria-pressed` toggles. A group of buttons each announcing
 * "pressed" or "not pressed" makes a screen reader user check all of them to learn which
 * one is on; a radio group announces "3 of 6" in one go, and arrow keys move between the
 * options the way they do in every native segmented control.
 */

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: string;
  /** Small second line, used for counts and units. */
  hint?: string;
  disabled?: boolean;
}

export function SegmentedControl<T extends string | number>({
  label,
  options,
  value,
  onChange,
  size = "default",
  className,
}: {
  /** Names the group for assistive technology. Visible labels live outside. */
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (next: T) => void;
  size?: "default" | "sm";
  className?: string;
}) {
  const index = options.findIndex((option) => option.value === value);
  // The button that holds the group's single tab stop. Normally the selected one — but
  // `value` can briefly name an option that is not in the list, on a render between a
  // setting changing and the effect that clamps it. Every button then carried
  // `tabIndex={-1}` and the whole group dropped out of the tab order, which is a worse
  // failure than the transient it came from. `aria-checked` still answers strictly: no
  // radio is checked when nothing matches.
  const tabStop =
    index >= 0 ? index : Math.max(0, options.findIndex((option) => option.disabled !== true));
  // Focus has to travel with the selection. Arrow keys changed `value` and returned, so
  // the roving `tabIndex` below moved to a button nobody was standing on: the ring stayed
  // on the old option, the new one was announced by nothing, and the next Tab left the
  // group from a control marked `tabIndex={-1}`. Native radio groups move focus, which is
  // the behaviour this component claims.
  const buttons = useRef(new Map<string, HTMLButtonElement | null>());

  function move(delta: number): void {
    const count = options.length;
    if (count === 0) return;
    // `index` is -1 when the current value is not in the list, which happens for a render
    // between a value changing and the options catching up. Starting from 0 there beats
    // doing nothing.
    const from = index < 0 ? 0 : index;
    // Skips disabled options rather than landing on them, and gives up after a full lap so
    // an all-disabled group cannot spin forever.
    for (let step = 1; step <= count; step += 1) {
      const next = options[(((from + delta * step) % count) + count) % count];
      if (next !== undefined && next.disabled !== true) {
        onChange(next.value);
        buttons.current.get(String(next.value))?.focus();
        return;
      }
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "inline-flex flex-wrap gap-1 rounded-lg bg-muted p-1",
        className,
      )}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          event.preventDefault();
          move(1);
        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          event.preventDefault();
          move(-1);
        }
      }}
    >
      {options.map((option, position) => {
        const selected = option.value === value;
        const locked = option.disabled === true;
        return (
          <button
            key={option.value}
            ref={(node) => {
              buttons.current.set(String(option.value), node);
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            // The *selected* option of a locked group keeps `tabIndex` and stays in the
            // accessible tree; only the others get the `disabled` attribute. A group where
            // every option is `disabled` is a keyboard dead zone, so a manager using a
            // screen reader could not read their own league size off the one screen that
            // shows it — which is the whole reason locked settings are displayed at all.
            disabled={locked && !selected}
            aria-disabled={locked || undefined}
            // Only the selected option is in the tab order, so Tab moves past the whole
            // group rather than through every option in it — the behaviour of a native
            // radio group, and the reason arrow keys are wired above.
            tabIndex={position === tabStop ? 0 : -1}
            onClick={() => {
              if (locked) return;
              onChange(option.value);
            }}
            className={cn(
              "relative rounded-md font-medium transition-colors outline-none",
              "focus-visible:ring-[3px] focus-visible:ring-ring/50",
              "disabled:pointer-events-none",
              // Dimmed only when it is *not* the current value. A locked group still has
              // to say what the setting is — greying the selected option along with the
              // rest left a manager unable to read their own league size off the one
              // screen that shows it.
              locked && !selected && "opacity-40",
              size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm",
              selected
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
            {option.hint === undefined ? null : (
              <span
                className={cn(
                  // Full-strength muted, not a further-dimmed variant: `/70` over the card
                  // measures about 2.9:1 in light mode, below the 4.5:1 these counts need
                  // as ordinary-sized text.
                  "ml-1.5 text-muted-foreground tabular-nums",
                )}
              >
                {option.hint}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
