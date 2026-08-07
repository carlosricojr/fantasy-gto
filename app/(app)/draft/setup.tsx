"use client";

import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { snakePicks } from "@/lib/core/draft";
import { cn } from "@/lib/utils";
import { LeagueForm, type LeagueSettings } from "./league-form";

/**
 * Setting the league up.
 *
 * One screen, asked once, and then never again unless something is wrong — so it is worth
 * making it legible rather than compact. The previous version was six rows of identical
 * outline buttons in a two-column grid, which gave a league size, a playoff field and a
 * scoring format the same visual weight and no sense of what any of them would do.
 *
 * The preview is the part that earns its space. A manager knows their seat; what they do
 * not know, and cannot work out under a clock, is that seat four in a twelve-team draft
 * picks 4th, 21st, 28th, 45th — that the wait between the first two picks is seventeen
 * players long. Showing it here is the difference between a form and a briefing.
 */
export function DraftSetup({
  settings,
  onChange,
  onStart,
  boardSize,
  season,
  leagueSizes,
  scoringConfirmed,
  children,
}: {
  settings: LeagueSettings;
  onChange: (patch: Partial<LeagueSettings>) => void;
  onStart: () => void;
  boardSize: number;
  season: number;
  leagueSizes: readonly number[];
  /** False until the scoring format has been chosen rather than merely preselected. */
  scoringConfirmed: boolean;
  /** The board provenance note, rendered underneath. */
  children?: React.ReactNode;
}) {
  const picks =
    settings.slot <= settings.teams
      ? snakePicks(settings.slot, settings.teams, settings.rounds)
      : [];

  return (
    <div className="space-y-6">
      <section className="rounded-xl border bg-card p-5 sm:p-6">
        <LeagueForm
          value={settings}
          onChange={onChange}
          scoringConfirmed={scoringConfirmed}
        />
      </section>

      <section className="rounded-xl border bg-card p-5 sm:p-6">
        <h2 className="text-sm font-medium">Your picks</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Seat {settings.slot} of {settings.teams}, snake order.
          {/* Only when there is a second pick to measure to. A one-round draft has no gap,
              and the sentence reported it as "0 players" — a number about something that
              does not exist. */}
          {picks.length > 1
            ? ` The gap between your first two picks is ${picks[1] - picks[0] - 1} players.`
            : ""}
        </p>
        <ol className="mt-3 flex flex-wrap gap-1.5">
          {picks.map((pick, index) => (
            <li
              key={pick}
              className={cn(
                "rounded-md px-2 py-1 text-xs font-medium tabular-nums",
                index === 0 ? "bg-brand/15 text-brand" : "bg-muted text-muted-foreground",
              )}
            >
              <span className="sr-only">Round {index + 1}, pick </span>
              {pick}
            </li>
          ))}
        </ol>
      </section>

      {boardSize === 0 ? (
        // Deliberately beside the form rather than replacing it. Unmounting the setup
        // screen took the controls away with it, leaving no way back except a reload — and
        // told an end user to run an internal command.
        <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
          No {season} board has been built for {settings.teams}-team{" "}
          {settings.scoringId.replaceAll("_", " ")} yet, so there is nothing to draft from.
          Choose another size or scoring format above; boards exist for{" "}
          {leagueSizes.join(", ")}-team leagues.
        </p>
      ) : (
        <div className="sticky bottom-20 z-10 sm:static">
          {/* Named rather than left to a disabled control with no explanation — a button
              that does nothing and says nothing is the worst of the three states. */}
          <Button
            size="lg"
            className="w-full sm:w-auto"
            disabled={!scoringConfirmed}
            aria-describedby="scoring-confirmation-hint"
            onClick={onStart}
          >
            Start draft
            <ArrowRight />
          </Button>
        </div>
      )}

      {children}
    </div>
  );
}
