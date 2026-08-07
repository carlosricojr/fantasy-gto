"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { survivalProbability } from "@/lib/core/draft";
import { cn } from "@/lib/utils";
import { basisExplanation } from "@/lib/nfl/draft/provenance";
import { pickLabel } from "./board-view";
import type { PoolPlayer } from "./pool-view";
import { positionChipClass, positionLabel } from "./positions";

/**
 * One player, with the working shown.
 *
 * The board carries a great deal more about each player than a row can hold — our own
 * season projection, what the market's price implies, the blend of the two that the
 * ranking uses, the dispersion of that price, and the modelled share of weeks he is fit —
 * and until now every one of those was fetched, kept in memory, and never displayed. A
 * product whose stated purpose is projections that show their working cannot make the user
 * take the ranking on trust.
 *
 * It also says, on the same screen as the numbers, that the blend does not beat the market
 * out of sample. That belongs here rather than only in a footnote, because here is where
 * somebody is deciding how much weight to put on it.
 */
export function PlayerDetail({
  player,
  onClose,
  onRecord,
  actionLabel,
  canRecord,
  remainingOwnPicks,
  teams,
  unrankedAdp,
  scoringLabel,
  pending = false,
}: {
  player: PoolPlayer | null;
  onClose: () => void;
  onRecord: (playerId: string) => void;
  actionLabel: string;
  canRecord: boolean;
  /** The user's upcoming picks, ascending, for the "will he last?" table. */
  remainingOwnPicks: readonly number[];
  /** League size, so these picks are named the way every other surface names them. */
  teams: number;
  unrankedAdp: number;
  scoringLabel: string;
  /** True while the figures shown are the previous selection's — see `useStableQuery`. */
  pending?: boolean;
}) {
  return (
    <Dialog open={player !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-md">
        {player === null ? null : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <span
                  className={cn(
                    "inline-flex w-11 shrink-0 justify-center rounded px-1 py-0.5 text-[0.6875rem] font-semibold ring-1 ring-inset",
                    positionChipClass(player.position),
                  )}
                >
                  {positionLabel(player.position)}
                </span>
                <span className="min-w-0 truncate">{player.name}</span>
              </DialogTitle>
              <DialogDescription>
                {player.team ?? "No team listed"}
                {player.byeWeek === null ? "" : ` · bye week ${player.byeWeek}`}
                {player.draftedAt === null
                  ? ` · board rank ${player.overallRank}`
                  : ` · taken at pick ${pickLabel(player.draftedAt, teams)} by ${player.draftedBy}`}
              </DialogDescription>
            </DialogHeader>

            <section>
              <h3 className="text-sm font-medium">Projected season points</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {/* Not "under {scoringLabel}" while the board is still loading: these three
                    numbers are the previous selection's, and this dialog's overlay covers
                    the status bar that says so everywhere else.

                    It names the *selection*, not the format. The board is keyed on season,
                    scoring and league size, so changing only the size sets the same flag —
                    and "the previous scoring" would then be a wrong explanation of a
                    correct warning. */}
                {pending
                  ? "These are the previous selection\u2019s figures — the board you have selected is still loading."
                  : `Under ${scoringLabel} scoring.`}{" "}
                Two independent estimates and the blend the board is ranked by.
              </p>
              <dl className="mt-3 space-y-2">
                <Estimate
                  term="Market"
                  detail="What this player's average draft position has historically been worth, fitted per position."
                  value={player.marketPoints}
                />
                <Estimate
                  term="Our model"
                  detail="From his own per-game production and how many games he is expected to play."
                  value={player.modelPoints}
                />
                <Estimate term="Blend" detail="What the ranking uses." value={player.seasonPoints} emphasis />
              </dl>
              <p className="mt-3 text-xs text-muted-foreground">{basisExplanation(player.basis)}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                Measured out of sample, the market ranks players better than our model does
                and the blend does not beat the market. It is kept because it wins on total
                points among each method&rsquo;s top 24 and one evaluation season cannot
                settle the disagreement. No ranking edge over the market is claimed.
              </p>
            </section>

            <section className="border-t pt-4">
              <h3 className="text-sm font-medium">Where the market drafts him</h3>
              <p className="mt-1 text-sm tabular-nums">
                {player.adp === null ? (
                  <span className="text-muted-foreground">
                    The market has no published position for him, so he is treated as going
                    after everyone it has priced.
                  </span>
                ) : (
                  <>
                    Pick {player.adp.toFixed(1)}
                    {player.adpStdev === null || player.adpStdev <= 0
                      ? " — no spread published, so a default one is assumed"
                      : `, give or take ${player.adpStdev.toFixed(1)} picks`}
                  </>
                )}
              </p>

              {player.draftedAt !== null || remainingOwnPicks.length === 0 ? null : (
                <>
                  <p className="mt-3 text-xs text-muted-foreground">
                    Chance he is still on the board at each of your remaining picks. ADP is a
                    mean with real dispersion, not a deadline.
                  </p>
                  <ul className="mt-2 space-y-1.5">
                    {remainingOwnPicks.slice(0, 4).map((pick) => {
                      const chance = survivalProbability(player, pick, unrankedAdp);
                      return (
                        <li key={pick} className="flex items-center gap-3 text-xs">
                          <span className="w-16 shrink-0 text-muted-foreground tabular-nums">
                            Pick {pickLabel(pick, teams)}
                          </span>
                          <span className="h-1.5 flex-1 rounded-full bg-muted" aria-hidden>
                            <span
                              className="block h-full rounded-full bg-brand"
                              style={{ width: `${Math.round(chance * 100)}%` }}
                            />
                          </span>
                          <span className="w-9 shrink-0 text-right tabular-nums">
                            {(chance * 100).toFixed(0)}%
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </section>

            <section className="border-t pt-4">
              <h3 className="text-sm font-medium">Availability</h3>
              <p className="mt-1 text-sm">
                Modelled fit in{" "}
                <span className="font-medium tabular-nums">
                  {(player.availability * 100).toFixed(0)}%
                </span>{" "}
                of weeks, from his own games played shrunk toward the league rate. This is
                what turns a season total into points per game he actually plays, and it is
                what makes a bench worth something in the simulation.
              </p>
            </section>

            {player.draftedAt !== null || !canRecord ? null : (
              <Button
                className="mt-2 w-full"
                onClick={() => {
                  onRecord(player.id);
                  onClose();
                }}
              >
                {actionLabel}
              </Button>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * One estimate.
 *
 * A single wrapping `div` between the `dl` and its `dt`/`dd`, which is the one level HTML
 * allows. Nested two deep — a flex row holding a column holding the term — the terms were
 * not `dl` content at all, so assistive technology paired none of them with their value.
 * A grid places the number opposite the term without a second wrapper.
 */
function Estimate({
  term,
  detail,
  value,
  emphasis,
}: {
  term: string;
  detail: string;
  value: number | null;
  emphasis?: boolean;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4">
      <dt className={cn("text-sm", emphasis === true && "font-medium")}>{term}</dt>
      <dd
        className={cn(
          "row-span-2 self-start tabular-nums",
          emphasis === true ? "text-lg font-semibold text-brand" : "text-sm",
        )}
      >
        {value === null ? <span className="text-muted-foreground">—</span> : value.toFixed(1)}
      </dd>
      <dd className="text-xs text-muted-foreground">{detail}</dd>
    </div>
  );
}
