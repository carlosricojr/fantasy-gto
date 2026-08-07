"use client";

import { useRef } from "react";
import { useQuery } from "convex/react";
import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
} from "convex/server";

import { type StableQueryState, stableQueryState } from "./stable-query";

/**
 * `useQuery`, without the blank frame when the arguments change.
 *
 * `convex/react` returns `undefined` for a subscription it has no local result for, and a
 * result is keyed by the arguments — so changing one is indistinguishable, at the call
 * site, from having never loaded at all. Screens branch on that and unmount themselves:
 * one click on a scoring format took the draft board, the player pool, the roster, the
 * queue and the open settings dialog off the screen, dropped the document from 4,551px to
 * 913px — both measured — so the browser clamped the scroll position, and put them all
 * back a few hundred milliseconds later with their state reset.
 *
 * This holds the last value that arrived and reports that it is doing so. It is the
 * pattern Convex documents for React; the Svelte client has `keepPreviousData` built in and
 * the React one does not. `useDeferredValue` cannot do this job — React keeps stale content
 * across an update only when the background render *suspends*, and `useQuery` returns
 * `undefined` rather than suspending. `useQuery_experimental` in 1.42 reports a `status`
 * but still carries no previous value.
 *
 * The ref is written during render, which is what the documented pattern does and is safe
 * here for the reason that makes it safe generally: the write does not read the ref, so a
 * render React discards cannot leave it holding anything except some value the query
 * genuinely returned.
 *
 * @example
 * const { data: board, pending } = useStableQuery(api.draft.board, { season, scoringId });
 * if (board === undefined) return <FirstLoad />;   // only before anything has ever loaded
 * return <Board rows={board} reloading={pending} />;
 */
export function useStableQuery<Query extends FunctionReference<"query">>(
  query: Query,
  args: FunctionArgs<Query> | "skip",
): StableQueryState<FunctionReturnType<Query>> {
  const live = useQuery(query, args);
  const held = useRef<FunctionReturnType<Query> | undefined>(undefined);

  const skipped = args === "skip";
  const state = stableQueryState(live, held.current, skipped);
  held.current = state.data;

  return state;
}
