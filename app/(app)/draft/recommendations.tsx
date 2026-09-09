"use client";

import { useState } from "react";
import { ChevronDown, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ChampionshipRecommendation } from "@/lib/core/draft-policy";
import { survivalProbability } from "@/lib/core/draft";
import { recommendationCaveat, type ValueBasis } from "@/lib/nfl/draft/provenance";
import { cn } from "@/lib/utils";
import { BasisBadge } from "./basis-badge";
import type { useRecommendations } from "./use-recommendations";
import { positionChipClass, positionLabel } from "./positions";

/** A drafted identity the board can record but cannot value as a normal candidate. */
export interface RecordOnlyRosterPlayer {
  id: string;
  name: string;
  position: string;
}

/**
 * What to take, and why.
 *
 * This is the only thing on the screen the market does not already tell a manager, so it
 * gets the loudest treatment on the page and the only chromatic colour that is not a
 * position. Everything it shows is a number the simulation produced: title odds with their
 * standard error, playoff odds, the gain over the best-available pick, and — the figure the
 * old panel omitted entirely — how likely the player is to still be there at your next
 * turn, which is what decides whether the recommendation has to be acted on now.
 *
 * It states its own uncertainty rather than presenting an ordering as resolved. Candidates
 * whose paired comparison with the leader spans zero are marked tied, because at a draft
 * clock's worth of scenarios they are, and a ranked list that hides that is the kind of
 * false precision this product exists not to ship. The tie is a label, not a sort key:
 * the list descends by title odds, so the top card is never a lower number than a row
 * beneath it (#88.2).
 */
export function Recommendations({
  state,
  scenarios,
  candidates,
  onTheClock,
  draftComplete,
  hasRemainingPick = true,
  onPick,
  waitPick,
  waitPickLabel,
  unrankedAdp,
  basisFor,
  ownRecordOnlyPlayers,
  decisionPick = null,
}: {
  state: ReturnType<typeof useRecommendations>;
  scenarios: number;
  /** How many the page asks for, so the loading skeleton is the height of the answer. */
  candidates: number;
  onTheClock: boolean;
  draftComplete: boolean;
  hasRemainingPick?: boolean;
  onPick: (playerId: string) => void;
  /** The user's next turn *after* this pick — the one "can I wait?" is about. */
  waitPick: number | null;
  waitPickLabel: string | null;
  unrankedAdp: number;
  /** Where a candidate's number came from, resolved against the board. */
  basisFor: (player: { id: string; position: string }) => ValueBasis;
  /** Your recorded players represented by a positional floor rather than their own value. */
  ownRecordOnlyPlayers: readonly RecordOnlyRosterPlayer[];
  /** Actual overall square being decided; not the count including future keepers. */
  decisionPick?: number | null;
}) {
  const [expanded, setExpanded] = useState(false);

  // Nothing is requested once the draft is over — the effect that drives the worker stops
  // — so what is in `state` is the answer for the board as it stood *before* the last
  // pick, with `stale` false because nothing superseded it. Rendering it anyway put "take
  // this player, 18.4% to win the league" under a status bar reading "Draft complete", for
  // a player somebody had usually just taken. Odds the code did not compute for the state
  // on screen are exactly what this project refuses to print.
  if (draftComplete) {
    return (
      <Panel>
        <p className="p-4 text-sm text-muted-foreground">
          The draft is over — every pick is recorded. Your team is on the right.
        </p>
        <RecordOnlyWarning players={ownRecordOnlyPlayers} completed />
      </Panel>
    );
  }

  if (!hasRemainingPick) {
    return (
      <Panel>
        <p className="p-4 text-sm text-muted-foreground" role="status">
          Your draft picks are complete. Other teams are still drafting.
        </p>
        <RecordOnlyWarning players={ownRecordOnlyPlayers} completed />
      </Panel>
    );
  }

  if (state.unavailable !== null) {
    return (
      <Panel>
        <p className="p-4 text-sm text-muted-foreground">
          {state.unavailable}, so recommendations are unavailable. The board and the player
          list still work.
        </p>
      </Panel>
    );
  }

  if (state.error !== null) {
    return (
      <Panel>
        <p className="p-4 text-sm text-muted-foreground">
          The recommendation failed: {state.error}
        </p>
      </Panel>
    );
  }

  if (state.stale) {
    return <Panel>
      <p className="p-4 text-sm text-muted-foreground" role="status">
        Picks changed. Recalculating for the current board; previous advice is withheld.
        You can still inspect and record available players in the player list.
      </p>
    </Panel>;
  }

  if (!state.loading && state.lastElapsedMs !== null && state.recommendations.length === 0) {
    return (
      <Panel>
        <p className="p-4 text-sm text-muted-foreground" role="status">
          No available candidates remain under the current draft forecast. Advice updates as picks arrive.
        </p>
      </Panel>
    );
  }

  if (state.loading || state.recommendations.length === 0) {
    // Shaped like the panel it stands in for, not three bars. This state is entered every
    // time the league changes — the answers belong to the previous scoring and are
    // discarded rather than shown — so a placeholder a fraction of the panel's height is a
    // page that jumps under the reader at the exact moment they are deciding a pick.
    //
    // Every region the loaded panel has, under the same condition it has it: the header,
    // the figures, the primary button *or* the "not your pick yet" line, the ranked rows
    // *or* the disclosure that reveals them, and the footer — which is six lines of body
    // copy in a 21rem column and was the largest thing missing from the first attempt. The
    // row count is the one the page asks for, so the two agree by construction.
    return (
      <Panel>
        <div className="space-y-2 border-b p-4" aria-hidden>
          <div className="h-3.5 w-24 motion-safe:animate-pulse rounded bg-muted" />
          <div className="h-6 w-56 max-w-full motion-safe:animate-pulse rounded bg-muted" />
          <div className="h-4 w-32 motion-safe:animate-pulse rounded bg-muted" />
        </div>
        <div className="border-b p-4" aria-hidden>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:flex sm:flex-wrap sm:gap-x-6 3xl:grid 3xl:gap-y-3">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="space-y-1.5">
                <div className="h-7 w-16 motion-safe:animate-pulse rounded bg-muted" />
                <div className="h-3 w-24 motion-safe:animate-pulse rounded bg-muted" />
              </div>
            ))}
          </div>
          {onTheClock ? (
            <div className="mt-3 h-9 motion-safe:animate-pulse rounded-md bg-muted" />
          ) : (
            // The "Not your pick yet…" line, which is `text-sm` over two lines in a
            // narrow column.
            <div className="mt-3 space-y-1.5">
              <div className="h-4 motion-safe:animate-pulse rounded bg-muted" />
              <div className="h-4 w-2/3 motion-safe:animate-pulse rounded bg-muted" />
            </div>
          )}
        </div>
        {onTheClock ? (
          <div className="divide-y" aria-hidden>
            {Array.from({ length: candidates - 1 }, (_, i) => (
              <div key={i} className="flex items-center gap-3 p-3">
                <div className="size-5 shrink-0 motion-safe:animate-pulse rounded bg-muted" />
                <div className="h-5 w-11 shrink-0 motion-safe:animate-pulse rounded bg-muted" />
                {/* Three lines, because a ranked row carries three: the name, the odds
                    with their interval, and the paired comparison against the leader. */}
                <div className="flex-1 space-y-1.5">
                  <div className="h-4 w-40 max-w-full motion-safe:animate-pulse rounded bg-muted" />
                  <div className="h-3 w-56 max-w-full motion-safe:animate-pulse rounded bg-muted" />
                  <div className="h-3 w-48 max-w-full motion-safe:animate-pulse rounded bg-muted" />
                </div>
              </div>
            ))}
          </div>
        ) : (
          // The disclosure that stands in for the rows when they are collapsed.
          <div className="p-2.5" aria-hidden>
            <div className="mx-auto h-4 w-48 max-w-full motion-safe:animate-pulse rounded bg-muted" />
          </div>
        )}
        {/* The footer is rendered unconditionally by the loaded panel, so it is here
            unconditionally too.

            A flat five lines, and deliberately not a per-breakpoint count. Its ~430
            characters wrap to about four lines in the widest column this panel gets, six in
            the 30rem column it becomes at `3xl` — which is the *narrowest* it is on a
            desktop, not the widest — and eight on a phone. A first attempt had that
            backwards and shortened the placeholder at exactly the width the real footer is
            tallest. No single count is right everywhere, so this takes the middle and the
            panel settles by a line or two either way. */}
        <div className="space-y-1.5 border-t p-3" aria-hidden>
          {Array.from({ length: 5 }, (_, i) => (
            <div
              key={i}
              className={cn("h-3 motion-safe:animate-pulse rounded bg-muted", i === 4 && "w-2/3")}
            />
          ))}
        </div>
        <p className="sr-only" role="status">
          Simulating the rest of the draft.
        </p>
      </Panel>
    );
  }

  const [leader, ...rest] = state.recommendations;
  const tiedAlternatives = rest.filter((rec) => rec.tiedWithLeader);
  const evenChance = state.teams === null ? null : 100 / state.teams;
  const tiedNames = tiedAlternatives.slice(0, 2).map((rec) => rec.player.name);
  const tiedNamesLabel =
    tiedAlternatives.length === 1
      ? tiedNames[0]
      : tiedAlternatives.length === 2
        ? `${tiedNames[0]} and ${tiedNames[1]}`
        : `${tiedNames.join(", ")}, and ${tiedAlternatives.length - tiedNames.length} more`;

  return (
    <Panel className={onTheClock ? "ring-2 ring-brand/40" : undefined}>
      <header className="flex items-start justify-between gap-3 border-b p-4">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-brand uppercase">
            <Sparkles className="size-3.5" aria-hidden />
            {onTheClock ? "Your pick" : "Forecast for your next pick"}
          </p>
          <h2 className="mt-1 break-words text-lg leading-tight font-semibold">
            Simulation leader: {leader.player.name}
          </h2>
          {/* Position and bye on the leader too, not only on the ranked rows beneath it.
              The one player this panel is actually recommending was the one player on it
              you could not tell the position of at a glance. */}
          <p className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
            <span
              className={cn(
                "inline-flex w-11 shrink-0 justify-center rounded px-1 py-0.5 text-[0.6875rem] font-semibold ring-1 ring-inset",
                positionChipClass(leader.player.position),
              )}
            >
              {positionLabel(leader.player.position)}
            </span>
            {leader.player.byeWeek === null ? "no bye listed" : `bye ${leader.player.byeWeek}`}
            <BasisBadge basis={basisFor(leader.player)} />
          </p>
        </div>
        {state.stale ? (
          <span className="shrink-0 text-xs text-muted-foreground">recalculating…</span>
        ) : null}
      </header>

      <div className="border-b p-4">
        <aside className="mb-3 rounded-lg border p-3 text-sm" aria-label="Experimental draft advice">
          <p className="font-medium">Experimental ranking — not a proven best pick</p>
          <p className="mt-1 text-muted-foreground">
            No demonstrated drafting edge over ADP. Compare market cost, roster needs, and
            alternatives before choosing; this order depends on one assumed opponent policy.
          </p>
        </aside>
        <MarketContext player={leader.player} decisionPick={decisionPick} showSource />
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-medium">Show conditional simulation results</summary>
        {/* Two columns on a phone rather than a wrapping row, which left the fourth
            figure alone on its own line with three-quarters of the width empty — and again
            from `3xl`, where this panel is a 30rem column beside the player list rather
            than the full width of the page, so the wrapping row has the same problem for
            the same reason. The breakpoint is the layout's, not this component's: it is the
            width at which the draft page splits into three columns. Only `display` and the
            row gap are restored: `grid-cols-2` was never overridden, only made inert, and
            the baseline alignment the `sm` row brings with it is worth keeping — it lines
            the large figure up with the ordinary-sized one beside it. */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:flex sm:flex-wrap sm:items-baseline sm:gap-y-1 3xl:grid 3xl:gap-y-3">
          <Figure
            value={`${(leader.championshipProbability * 100).toFixed(1)}%`}
            unit={`± ${(leader.standardError * 100).toFixed(1)} pp`}
            label="simulated title chance"
            note="sampling error only"
          />
          <Figure
            value={`${(leader.playoffProbability * 100).toFixed(0)}%`}
            label="to make the playoffs"
          />
          <Figure
            value={`${leader.deltaVsBaseline >= 0 ? "+" : ""}${(leader.deltaVsBaseline * 100).toFixed(1)}`}
            unit="pp"
            label="vs. default policy pick"
            note="not vs. equal odds"
          />
          <Figure
            value={leader.expectedPoints.toFixed(0)}
            label="points your team scores, season"
          />
        </div>
        <p className="mt-3 text-sm leading-5 text-muted-foreground">
          A conditional simulation estimate, not a team grade: it assumes this pick, the
          picks already recorded, and a default policy completing the rest of the draft.
        </p>
        </details>
        <RecordOnlyWarning players={ownRecordOnlyPlayers} />
        {tiedAlternatives.length > 0 ? (
          <aside
            className="mt-3 rounded-lg border border-brand/30 bg-brand/5 p-3 text-sm"
            aria-label="Viable alternatives"
          >
            <p className="font-medium">
              {tiedAlternatives.length === 1 ? "Viable alternative" : "Viable alternatives"}
            </p>
            <p className="mt-1 leading-5 text-muted-foreground">
              {tiedNamesLabel} {tiedAlternatives.length === 1 ? "is" : "are"} tied with {leader.player.name}
              {" "}in these simulations. The displayed order preserves the estimated title
              chance, but these simulations do not reliably separate the choices.
            </p>
          </aside>
        ) : null}
        {onTheClock ? (
          <Button className="mt-3 w-full" onClick={() => onPick(leader.player.id)}>
            Record {leader.player.name}
          </Button>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            Not your pick yet. Intervening picks follow the default policy in this forecast;
            advice updates as actual picks arrive.
          </p>
        )}
      </div>

      {/* Collapsed while somebody else is picking, because then this panel is a glance —
          "who is the pick if it comes back to me" — and ten rows of it push the board and
          the player list, which are what that turn is actually for, off the screen. It
          opens on its own the moment the pick is yours. */}
      {onTheClock || expanded ? (
        <ul className="divide-y">
          {rest.map((rec, index) => (
            <Row
              key={rec.player.id}
              rec={rec}
              rank={index + 2}
              onTheClock={onTheClock}
              onPick={onPick}
              waitPick={waitPick}
              waitPickLabel={waitPickLabel}
              unrankedAdp={unrankedAdp}
              basisFor={basisFor}
              decisionPick={decisionPick}
            />
          ))}
        </ul>
      ) : null}

      {onTheClock || rest.length === 0 ? null : (
        // A one-way disclosure is a trap: opened during an opponent's turn, the ten rows
        // stayed for the rest of the draft with no way back to the glance.
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          className="flex w-full items-center justify-center gap-1 p-2.5 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {expanded ? "Hide the other candidates" : `Show the next ${rest.length} candidates`}
          <ChevronDown
            className={cn("size-3.5 motion-safe:transition-transform", expanded && "rotate-180")}
          />
        </button>
      )}

      <footer className="border-t p-3 text-xs text-muted-foreground">
        <details>
          <summary className="cursor-pointer font-medium text-foreground">How to read these estimates</summary>
          <div className="mt-2 space-y-2 leading-5">
            {state.teams === null || evenChance === null ? null : (
              <p>
                An even pre-draft reference in a {state.teams}-team league is {evenChance.toFixed(1)}%
                (1 in {state.teams}), but that assumes identical teams. It is neither this panel&apos;s
                comparison nor a forecast of real-world title odds.
              </p>
            )}
            <p>
              The ± figure is one standard error from {scenarios} simulated seasons, not all
              uncertainty. Real outcomes and how managers actually finish the draft can differ
              from this simulation. The paired range compares each row with the top estimate;
              a viable alternative is one whose paired range spans zero.
            </p>
            <p>
              The pp figure compares this pick with the default policy&apos;s available pick under
              the same completion policy. It does not compare your team with an equal-chance
              baseline.
            </p>
          </div>
        </details>
        {state.lastElapsedMs === null
          ? null
          : ` Computed in ${state.lastElapsedMs}ms${state.lastFromCache ? " (cached)" : ""}.`}
      </footer>
    </Panel>
  );
}

function Row({
  rec,
  rank,
  onTheClock,
  onPick,
  waitPick,
  waitPickLabel,
  unrankedAdp,
  basisFor,
  decisionPick,
}: {
  rec: ChampionshipRecommendation;
  rank: number;
  onTheClock: boolean;
  onPick: (playerId: string) => void;
  waitPick: number | null;
  waitPickLabel: string | null;
  unrankedAdp: number;
  basisFor: (player: { id: string; position: string }) => ValueBasis;
  decisionPick: number | null;
}) {
  // The wait question, per candidate. A tied second choice who is 90% likely to last until
  // your next pick and a tied second choice who is 10% likely are not the same decision,
  // and nothing on the previous panel distinguished them.
  const survival =
    waitPick === null || rec.player.adp == null
      ? null
      : survivalProbability(
          { adp: rec.player.adp ?? null, adpStdev: rec.player.adpStdev ?? null },
          waitPick,
          unrankedAdp,
        );

  return (
    <li className="flex items-center gap-3 p-3">
      <span className="w-4 shrink-0 text-xs text-muted-foreground tabular-nums">{rank}</span>
      <span
        className={cn(
          "inline-flex w-11 shrink-0 justify-center rounded px-1 py-0.5 text-[0.6875rem] font-semibold ring-1 ring-inset",
          positionChipClass(rec.player.position),
        )}
      >
        {positionLabel(rec.player.position)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center text-sm font-medium">
          <span className="truncate">{rec.player.name}</span>
          <BasisBadge basis={basisFor(rec.player)} />
        </span>
        <MarketContext player={rec.player} decisionPick={decisionPick} />
        {rec.tiedWithLeader ? (
          <span className="mt-1 inline-flex rounded bg-brand/10 px-1.5 py-0.5 text-[0.6875rem] font-medium text-brand">
            Viable alternative · tied in this simulation
          </span>
        ) : null}
        <span className="block text-xs leading-4 text-muted-foreground tabular-nums">
          {(rec.championshipProbability * 100).toFixed(1)}% ±
          {(rec.standardError * 100).toFixed(1)} pp simulated title chance · sampling error only
          {survival === null ? "" : ` · estimated ${survival < 0.01 ? "<1" : survival > 0.99 ? ">99" : (survival * 100).toFixed(0)}% lasts to ${waitPickLabel}`}
        </span>
        {/* The paired comparison against the leader, which is the only interval on this
            panel that is the uncertainty of the *comparison* rather than of one number on
            its own. Descriptive, not inferential — the leader was chosen as the maximum of
            the same sample, and `draft-policy.ts` says so at length. */}
        {rec.vsLeader === null ? null : (
          <span className="block text-xs leading-4 text-muted-foreground tabular-nums">
            vs top estimate {rec.vsLeader.meanDifference >= 0 ? "+" : ""}
            {(rec.vsLeader.meanDifference * 100).toFixed(1)} pp; paired{" "}
            {rec.vsLeader.confidenceLevel}% range {(rec.vsLeader.interval[0] * 100).toFixed(1)} to{" "}
            {(rec.vsLeader.interval[1] * 100).toFixed(1)} pp
          </span>
        )}
        {/* The badge alone does not say that the number *above* it is the thing affected. */}
        {recommendationCaveat(rec.player.position) === null ? null : (
          <span className="block text-xs text-muted-foreground">
            {recommendationCaveat(rec.player.position)}
          </span>
        )}
      </span>
      {onTheClock ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => onPick(rec.player.id)}
          aria-label={`Record ${rec.player.name}`}
        >
          Record
        </Button>
      ) : null}
    </li>
  );
}

function MarketContext({ player, decisionPick, showSource = false }: {
  player: ChampionshipRecommendation["player"];
  decisionPick: number | null;
  showSource?: boolean;
}) {
  const adp = player.adp;
  const priced = adp != null && Number.isFinite(adp) && adp > 0;
  const gap = priced && decisionPick !== null ? adp - decisionPick : null;
  return <span className="mt-1 block text-xs leading-5 text-muted-foreground">
    {priced ? `Board ADP ${adp.toFixed(1)}` : "No board ADP — waiting estimate unavailable"}
    {gap === null ? "" : ` · overall pick ${decisionPick} · ${Math.abs(gap).toFixed(1)} picks ${gap > 0 ? "earlier" : "later"} than ADP`}
    {showSource ? <span className="block">Fantasy Football Calculator market; may differ from your draft platform. ADP is not a player projection.</span> : null}
    {gap !== null && gap >= 10 ? <span className="block font-medium text-foreground">Reach check: at least 10 picks ahead of this market. The simulation alone does not establish that this reach is worth it.</span> : null}
  </span>;
}

function Figure({
  value,
  unit,
  label,
  note,
  emphasis,
}: {
  value: string;
  unit?: string;
  label: string;
  /** A qualifier attached to this number, rather than a blanket disclaimer. */
  note?: string;
  emphasis?: boolean;
}) {
  return (
    <span className="block">
      <span
        className={cn(
          "font-semibold tabular-nums",
          emphasis ? "text-2xl text-brand" : "text-base",
        )}
      >
        {value}
      </span>
      {unit === undefined ? null : (
        <span className="ml-1 text-xs text-muted-foreground tabular-nums">{unit}</span>
      )}
      <span className="block text-xs text-muted-foreground">{label}</span>
      {note === undefined ? null : <span className="block text-xs text-muted-foreground">{note}</span>}
    </span>
  );
}

function RecordOnlyWarning({
  players,
  completed = false,
}: {
  players: readonly RecordOnlyRosterPlayer[];
  completed?: boolean;
}) {
  if (players.length === 0) return null;

  const names = players.map((player) => `${player.name} (${positionLabel(player.position)})`).join(", ");

  return (
    <aside
      className={cn(
        "rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm",
        completed ? "mx-4 mb-4" : "mt-3",
      )}
      role="alert"
      aria-label="Roster valuation warning"
    >
      <p className="font-medium text-foreground">
        {players.length === 1
          ? "Roster player without an active valuation"
          : "Roster players without active valuations"}
      </p>
      <p className="mt-1 leading-5 text-muted-foreground">
        {names} {players.length === 1 ? "is" : "are"} record-only on this board, without an active
        valuation. That can mean a player is unavailable or otherwise outside the valued pool. The
        simulation substitutes the lowest current value at each player&apos;s position when one is
        available (otherwise a fallback) as bookkeeping, not a personal projection. {completed
          ? "Any title estimate from this draft is incomplete rather than decision-ready until these roster values are resolved."
          : "Treat the title chance above as incomplete rather than pick-ready until these roster values are resolved."}
      </p>
    </aside>
  );
}

function Panel({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    // `min-w-0` for the same reason `PlayerPool`'s root has it: from `3xl` this panel is a
    // grid item, whose automatic minimum size is min-content unless it is told otherwise,
    // and the figures row and player names inside it are `nowrap`.
    <section className={cn("min-w-0 rounded-xl border bg-card", className)}>{children}</section>
  );
}
