"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Star, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { survivalProbability } from "@/lib/core/draft";
import { cn } from "@/lib/utils";
import { BasisBadge } from "./basis-badge";
import { pickLabel } from "./board-view";
import {
  POOL_SORTS,
  type PoolFilter,
  type PoolPlayer,
  type PoolSort,
  filterPool,
  positionCounts,
  sortPool,
} from "./pool-view";
import { POSITIONS, positionChipClass, positionLabel } from "./positions";

/**
 * The player pool.
 *
 * One surface for both jobs this screen has. On your turn it is how you take a player; on
 * everybody else's — eleven picks in twelve — it is how you record what they took. That is
 * deliberately the *same* list with the same rows: the previous design had two separate
 * panels that swapped position depending on whose turn it was, and reordering the page
 * under the reader turned out to need three attempts at a focus-restoration dance to stay
 * usable. A single list whose action label changes needs none of it, and it is what every
 * draft room already understands.
 *
 * The action button says what it does. "Take" when the pick is yours, "Record for Seat 7"
 * when it is not. A single "Draft" button on somebody else's turn is how a tester ended up
 * with an opponent's players on their own roster.
 */

/** Rows rendered before the list asks to be extended. */
const PAGE = 60;

export function PlayerPool({
  players,
  onTheClock,
  actionLabel,
  draftComplete,
  onRecord,
  queue,
  onToggleQueue,
  neededPositions,
  waitPick,
  waitPickLabel,
  unrankedAdp,
  focus,
  teams,
  onOpenDetail,
}: {
  players: readonly PoolPlayer[];
  onTheClock: boolean;
  /** How the row button phrases itself, from `describeTurn`. */
  actionLabel: string;
  draftComplete: boolean;
  onRecord: (playerId: string) => void;
  queue: readonly string[];
  onToggleQueue: (playerId: string) => void;
  neededPositions: ReadonlySet<string>;
  /**
   * The pick the "still there?" column asks about: the user's next turn *after* the one
   * being decided now. On your own turn `nextPickFor` returns the pick you are making, and
   * the column then answered "how likely is this player to survive until the moment you
   * take him", which is not a question anybody has.
   */
  waitPick: number | null;
  /** That pick as "3.04". Overall numbers and round labels must not be mixed on one screen. */
  waitPickLabel: string | null;
  unrankedAdp: number;
  /**
   * A request to reveal one player, from a click on the board.
   *
   * A fresh object rather than a bare id, and it carries whether the player is drafted so
   * this component need not consult `players` to act on it. The previous version keyed the
   * effect on `[focusPlayerId, players]`, and `players` is rebuilt on every recorded pick
   * — so pressing Undo re-ran it and silently cleared the search box and position filter a
   * manager was in the middle of using. Object identity is what makes clicking the same
   * cell twice ask twice.
   */
  focus: { playerId: string; drafted: boolean } | null;
  /** League size, so a pick is named "3.04" here as it is everywhere else. */
  teams: number;
  /** Opens the working behind a player's number. */
  onOpenDetail: (playerId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState<string | null>(null);
  const [filter, setFilter] = useState<PoolFilter>("available");
  const [sort, setSort] = useState<PoolSort>("value");
  const [visible, setVisible] = useState(PAGE);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  /**
   * The exact request object this list has already scrolled to.
   *
   * Compared by identity. A sequence number was tried and was wrong in two ways: it
   * restarted at 1 whenever the page cleared the focus, so an earlier request numbered 1
   * suppressed a later one for ever.
   */
  const handledFocus = useRef<object | null>(null);

  // Counted over the rows this filter actually selects. Counting availability
  // unconditionally made the tabs read "RB 41" over a list of 168 drafted players, and hid
  // the K tab entirely once the last available kicker went — leaving the drafted ones
  // unreachable by any filter.
  const scoped = useMemo(
    () =>
      players.filter((player) =>
        filter === "drafted" ? player.draftedAt !== null : player.draftedAt === null,
      ),
    [players, filter],
  );
  const counts = useMemo(() => positionCounts(scoped), [scoped]);

  const rows = useMemo(
    () => sortPool(filterPool(players, { filter, position, query }), sort),
    [players, filter, position, query, sort],
  );

  // A position whose tab has gone cannot stay selected. The tabs only offer positions with
  // rows behind them, so taking the last available kicker removed the K tab while `position`
  // still held "K" — an empty list, no tab showing as selected, and nothing on screen naming
  // the filter that was hiding everything.
  useEffect(() => {
    if (position !== null && (counts[position] ?? 0) === 0) setPosition(null);
  }, [counts, position]);

  // Back to the top of the list whenever what the list *is* changes. Without this, typing
  // a search after paging deep left the count expanded at 300 rows for a two-row result,
  // and clearing it dumped the reader 300 rows down a list they had not scrolled.
  useEffect(() => setVisible(PAGE), [filter, position, query, sort]);

  // A board cell was clicked. Show that player wherever they are — including in the
  // drafted list, which is the case that motivated this: the only way to check a pick was
  // recorded against the right player is to go and look at them.
  useEffect(() => {
    if (focus === null) return;
    setQuery("");
    setPosition(null);
    setFilter(focus.drafted ? "drafted" : "available");
  }, [focus]);

  // ...and extend the page far enough to actually contain them. `visible` resets to `PAGE`
  // whenever the filter changes, which the effect above always does — so revealing a
  // player sitting at row 140 of the drafted list switched the filter, rendered the first
  // 60 rows, and stopped. The row never mounted, the scroll never happened, and clicking a
  // cell on the board looked like a dead control.
  useEffect(() => {
    if (focus === null) return;
    const index = rows.findIndex((player) => player.id === focus.playerId);
    if (index < 0) return;
    setVisible((current) => (index < current ? current : index + PAGE));
  }, [focus, rows]);

  const shown = rows.slice(0, visible);

  // Brings the revealed row into view *inside this list*, not by scrolling the page.
  //
  // `scrollIntoView` moves every scrollable ancestor, which on a phone takes the search
  // box and the record controls off the screen with it — the same reason `board-grid.tsx`
  // does its own arithmetic.
  //
  // It retries rather than firing once. Two renders separate a board click from the row
  // being on screen: the effect above switches the filter, and only the render after that
  // contains the row. Keyed on `[focus, visible]` alone the effect ran on the first of
  // those, found nothing, and never ran again — so a click on the board changed the filter
  // and left the reader wherever they were. `rows` changes when the filter applies, and
  // the sequence number stops it re-scrolling on every later keystroke.
  useEffect(() => {
    if (focus === null || handledFocus.current === focus) return;
    // Not until the reset above has actually committed. Both effects run against the same
    // commit, so on the first pass this one still sees the *previous* filter — and if the
    // reader had narrowed the list to the very player being revealed, the row was already
    // on screen, it scrolled a one-row list, marked the request handled, and then sat out
    // the re-render that moved the player hundreds of rows down the unfiltered list.
    const settled =
      query === "" &&
      position === null &&
      filter === (focus.drafted ? "drafted" : "available");
    if (!settled) return;
    const container = scroller.current;
    const row = container?.querySelector<HTMLElement>('[data-focused="true"]');
    if (container == null || row == null) return;
    handledFocus.current = focus;
    const offset = row.getBoundingClientRect().top - container.getBoundingClientRect().top;
    container.scrollTo({
      top: Math.max(
        0,
        container.scrollTop + offset - container.clientHeight / 2 + row.clientHeight / 2,
      ),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  }, [focus, rows, visible, query, position, filter]);

  return (
    <section className="flex min-h-0 flex-col rounded-xl border bg-card">
      <header className="flex flex-col gap-3 border-b p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[11rem] flex-1">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search players"
              aria-label="Search players"
              className="pl-8"
            />
            {query === "" ? null : (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  searchRef.current?.focus();
                }}
                aria-label="Clear search"
                className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <SegmentedControl
            label="Show"
            size="sm"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "available", label: "Available" },
              { value: "drafted", label: "Drafted" },
            ]}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <SegmentedControl
            label="Position"
            size="sm"
            value={position ?? "ALL"}
            onChange={(next) => setPosition(next === "ALL" ? null : next)}
            options={[
              { value: "ALL", label: "All", hint: String(scoped.length) },
              ...POSITIONS.filter((code) => (counts[code] ?? 0) > 0).map((code) => ({
                value: code as string,
                label: positionLabel(code),
                hint: String(counts[code] ?? 0),
              })),
            ]}
          />
          <SegmentedControl
            label="Sort by"
            size="sm"
            value={sort}
            onChange={setSort}
            options={POOL_SORTS.map((option) => ({ value: option.id, label: option.label }))}
          />
        </div>
      </header>

      {rows.length === 0 ? (
        <p className="p-8 text-center text-sm text-muted-foreground">
          {filter === "drafted"
            ? "Nothing has been recorded yet."
            : `No available player matches ${query === "" ? "that filter" : `“${query}”`}.`}
        </p>
      ) : (
        <>
          <div
            ref={scroller}
            className="max-h-[70dvh] min-h-0 overflow-y-auto overscroll-contain lg:max-h-[34rem]"
          >
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b text-xs text-muted-foreground">
                  <th scope="col" className="w-8 py-2 pl-3">
                    <span className="sr-only">Queue</span>
                  </th>
                  {/* `w-full max-w-0` on the flexible column.
                      A table lays itself out to its content, and `truncate` sets
                      `white-space: nowrap` — so the name and the line under it were sized
                      at their full length, the table grew past the viewport, and the whole
                      page scrolled sideways on a phone with every card clipped at the right
                      edge. Zero max-width plus full width makes this the column that takes
                      whatever is left, which is what lets the truncation inside it work. */}
                  <th scope="col" className="w-full max-w-0 py-2 pl-2 text-left font-medium">
                    Player
                  </th>
                  <th
                    scope="col"
                    className="hidden py-2 pr-3 text-right font-medium whitespace-nowrap sm:table-cell"
                  >
                    ADP
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">
                    <abbr title="Projected season points under this league's scoring" className="no-underline">
                      Proj
                    </abbr>
                  </th>
                  <th
                    scope="col"
                    className="hidden py-2 pr-3 text-right font-medium whitespace-nowrap lg:table-cell"
                  >
                    {waitPickLabel === null ? "Lasts" : `Lasts to ${waitPickLabel}`}
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">
                    <span className="sr-only">Record</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((player) => (
                  <PoolRow
                    key={player.id}
                    player={player}
                    onTheClock={onTheClock}
                    actionLabel={actionLabel}
                    draftComplete={draftComplete}
                    onRecord={onRecord}
                    queued={queue.includes(player.id)}
                    onToggleQueue={onToggleQueue}
                    needed={neededPositions.has(player.position.toUpperCase())}
                    waitPick={waitPick}
                    unrankedAdp={unrankedAdp}
                    teams={teams}
                    focused={player.id === focus?.playerId}
                    onOpenDetail={onOpenDetail}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <footer className="flex items-center justify-between gap-3 border-t p-3 text-xs text-muted-foreground">
            <span>
              {shown.length === rows.length
                ? `${rows.length} ${rows.length === 1 ? "player" : "players"}`
                : `${shown.length} of ${rows.length}`}
            </span>
            {shown.length === rows.length ? null : (
              <Button size="sm" variant="outline" onClick={() => setVisible((n) => n + PAGE * 2)}>
                Show more
              </Button>
            )}
          </footer>
        </>
      )}
    </section>
  );
}

function PoolRow({
  player,
  onTheClock,
  actionLabel,
  draftComplete,
  onRecord,
  queued,
  onToggleQueue,
  needed,
  waitPick,
  unrankedAdp,
  teams,
  focused,
  onOpenDetail,
}: {
  player: PoolPlayer;
  onTheClock: boolean;
  actionLabel: string;
  draftComplete: boolean;
  onRecord: (playerId: string) => void;
  queued: boolean;
  onToggleQueue: (playerId: string) => void;
  needed: boolean;
  waitPick: number | null;
  unrankedAdp: number;
  teams: number;
  focused: boolean;
  onOpenDetail: (playerId: string) => void;
}) {
  const drafted = player.draftedAt !== null;

  // The probability the market leaves him on the board until your next turn. This is the
  // question a draft actually asks — "can I wait?" — and `survivalProbability` has been
  // able to answer it since the market model was written, with nothing on screen calling
  // it. Shown only when there is a later pick to wait for, and never for a player already
  // gone, where it would be a statement about the past.
  const survival =
    waitPick === null || drafted
      ? null
      : survivalProbability(player, waitPick, unrankedAdp);

  return (
    <tr
      // Read by the list's scroll effect above, which scrolls its own container rather
      // than every ancestor of this row.
      data-focused={focused ? "true" : undefined}
      className={cn(
        "border-b last:border-b-0",
        focused && "bg-brand/10",
        !focused && "hover:bg-muted/50",
      )}
    >
      <td className="py-1.5 pl-3 align-middle">
        {drafted ? null : (
          <button
            type="button"
            onClick={() => onToggleQueue(player.id)}
            aria-pressed={queued}
            aria-label={queued ? `Remove ${player.name} from your queue` : `Queue ${player.name}`}
            className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <Star className={cn("size-4", queued && "fill-brand text-brand")} />
          </button>
        )}
      </td>

      <td className="w-full max-w-0 py-1.5 pl-2 align-middle">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex w-11 shrink-0 justify-center rounded px-1 py-0.5 text-[0.6875rem] font-semibold ring-1 ring-inset",
              positionChipClass(player.position),
            )}
          >
            {positionLabel(player.position)}
          </span>
          <span className="min-w-0">
            {/* The name opens the working behind the number beside it. A projection a
                reader cannot interrogate is a number to be taken on trust, which is the
                one thing this product says it will not ask for. */}
            <button
              type="button"
              onClick={() => onOpenDetail(player.id)}
              className={cn(
                "block max-w-full truncate rounded text-left font-medium hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                drafted && "text-muted-foreground line-through",
              )}
              aria-label={`${player.name} — projection, market price and availability`}
            >
              {player.name}
            </button>
            <span className="block truncate text-xs text-muted-foreground">
              {player.team ?? "FA"}
              {player.byeWeek === null ? "" : ` · bye ${player.byeWeek}`}
              {drafted ? ` · ${player.draftedBy}` : ""}
              {needed && !drafted ? (
                <span className="ml-1 text-brand">· fills a starting slot</span>
              ) : null}
              {/* Beside the number it qualifies, not two screens above it. */}
              <BasisBadge basis={player.basis} />
            </span>
          </span>
        </div>
      </td>

      <td className="hidden pr-3 text-right align-middle whitespace-nowrap tabular-nums sm:table-cell">
        {player.adp === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          player.adp.toFixed(1)
        )}
      </td>

      <td className="pr-3 text-right align-middle font-medium whitespace-nowrap tabular-nums">
        {player.seasonPoints.toFixed(0)}
      </td>

      <td className="hidden pr-3 text-right align-middle whitespace-nowrap tabular-nums lg:table-cell">
        {survival === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className={cn(survival < 0.25 && "text-amber-600 dark:text-amber-400")}>
            {(survival * 100).toFixed(0)}%
          </span>
        )}
      </td>

      <td className="py-1.5 pr-3 text-right align-middle whitespace-nowrap">
        {drafted || draftComplete ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            {drafted && player.draftedAt !== null ? pickLabel(player.draftedAt, teams) : ""}
          </span>
        ) : (
          <Button
            size="sm"
            variant={onTheClock ? "default" : "outline"}
            onClick={() => onRecord(player.id)}
            // The visible label is short so the column stays narrow; the accessible name
            // carries who the pick is for, because that is the part that goes wrong.
            aria-label={`${actionLabel}: ${player.name}`}
            title={`${actionLabel} — ${player.name}`}
          >
            {onTheClock ? "Take" : "Record"}
          </Button>
        )}
      </td>
    </tr>
  );
}
