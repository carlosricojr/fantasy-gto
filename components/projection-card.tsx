"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";

/**
 * A projection with its explanation.
 *
 * The contribution breakdown is the product's main claim to being trustworthy, so it is
 * shown in the interface rather than hidden in a tooltip. Contributions sum exactly to the
 * mean by construction, so the arithmetic a user checks by hand always balances.
 */

export interface ProjectionContribution {
  key: string;
  label: string;
  points: number;
  detail: string;
}

export interface ProjectionCardProps {
  /** `null` while the name query is still resolving; never the raw upstream id. */
  name: string | null;
  position: string;
  team: string | null;
  mean: number;
  floor: number;
  ceiling: number;
  contributions: readonly ProjectionContribution[];
  /** Rendered alongside the name, e.g. an opponent. */
  subtitle?: string;
}

function formatPoints(value: number): string {
  return value.toFixed(1);
}

function formatSigned(value: number): string {
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}`;
}

export function ProjectionCard({
  name,
  position,
  team,
  mean,
  floor,
  ceiling,
  contributions,
  subtitle,
}: ProjectionCardProps) {
  const [expanded, setExpanded] = useState(false);
  const largest = Math.max(...contributions.map((c) => Math.abs(c.points)), 1);

  return (
    <div className="rounded-lg border">
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-4 p-4 text-left"
      >
        <span className="w-11 shrink-0 rounded bg-muted px-2 py-1 text-center text-xs font-medium">
          {position}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">
            {name ?? (
              <span
                className="inline-block h-4 w-32 animate-pulse rounded bg-muted align-middle"
                aria-label="Loading player name"
              />
            )}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {[team, subtitle].filter(Boolean).join(" · ") || "Free agent"}
          </span>
        </span>

        <span className="shrink-0 text-right">
          <span className="block text-lg font-semibold tabular-nums">
            {formatPoints(mean)}
          </span>
          <span className="block text-xs tabular-nums text-muted-foreground">
            {formatPoints(floor)}&ndash;{formatPoints(ceiling)}
          </span>
        </span>
      </button>

      {expanded && (
        <div className="border-t px-4 py-3">
          <p className="mb-3 text-xs text-muted-foreground">
            These add up to the projection. The range is the 10th to 90th percentile of
            outcomes measured for this position.
          </p>
          <ul className="space-y-2">
            {contributions.map((contribution) => (
              <li key={contribution.key}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm">{contribution.label}</span>
                  <span
                    className={cn(
                      "shrink-0 text-sm tabular-nums",
                      contribution.points >= 0 ? "text-emerald-600" : "text-amber-600",
                    )}
                  >
                    {formatSigned(contribution.points)}
                  </span>
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded bg-muted">
                  <div
                    className={cn(
                      "h-full",
                      contribution.points >= 0 ? "bg-emerald-500/60" : "bg-amber-500/60",
                    )}
                    style={{
                      width: `${(Math.abs(contribution.points) / largest) * 100}%`,
                    }}
                  />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{contribution.detail}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
