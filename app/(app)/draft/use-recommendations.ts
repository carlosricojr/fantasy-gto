"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ChampionshipRecommendation, DraftPolicyState } from "@/lib/core/draft-policy";
import type { LeagueConfig } from "@/lib/core/season-sim";
import type { RecommendRequest, RecommendResponse } from "./recommend.worker";
import {
  type ReplyGateState,
  applied,
  initialGate,
  isStale,
  nextRequest,
  retarget,
  verdictFor,
} from "./reply-gate";

/**
 * Recommendations from the worker, with the staleness made visible.
 *
 * The board changes faster than the simulation finishes — a pick lands, then another
 * before the first reply arrives. Two things follow, and both matter more than they
 * sound:
 *
 * Replies are matched by request id and anything older is dropped. Without that, a slow
 * answer for a two-picks-ago board arrives last and overwrites the current one, and the
 * user is looking at advice for a position that no longer exists.
 *
 * And while a request is outstanding the previous answer stays on screen, marked stale
 * rather than blanked. A draft board that empties every time somebody picks is unusable,
 * but so is one that presents an old answer as current.
 *
 * A *third* case is not staleness at all and needed its own rule. When the league itself
 * changes — scoring, roster shape, size — every outstanding reply and everything already on
 * screen belongs to a different game. Request ids cannot see that, because they keep counting
 * up and the newest reply is still the newest. The previous league's recommendations sat
 * there unmarked for as long as the query took. `reply-gate.ts` decides all three, and is
 * pure so it can be tested without driving a component.
 *
 * What this hook does *not* police is a request built from the wrong board. It cannot: a
 * `DraftPolicyState` carries players, not the league they were priced under. That used to
 * be guaranteed by accident — the board query returned `undefined` while it reloaded, so
 * the page had no state to send — and the page now holds the previous board to keep itself
 * mounted. `page.tsx` therefore withholds the request explicitly while the board is the
 * previous league's. If that guard is removed, this gate will stamp the answer as current,
 * because from here it is indistinguishable from one.
 */

export interface RecommendationState {
  recommendations: ChampionshipRecommendation[];
  /** True while a newer request is outstanding, so what is shown is out of date. */
  stale: boolean;
  /** True before the first answer has ever arrived. */
  loading: boolean;
  error: string | null;
  lastElapsedMs: number | null;
  lastFromCache: boolean;
}

const IDLE: RecommendationState = {
  recommendations: [],
  stale: false,
  loading: false,
  error: null,
  lastElapsedMs: null,
  lastFromCache: false,
};

export function useRecommendations(): RecommendationState & {
  request: (
    state: DraftPolicyState,
    config: LeagueConfig,
    seed: number,
    candidateLimit?: number,
  ) => void;
  /** Discards everything belonging to a league that is no longer selected. */
  retargetTo: (fingerprint: string) => void;
  /**
   * Why recommendations are unavailable, or `null` when they are not.
   *
   * A reason rather than a capability flag. Three different things used to set
   * `supported: false` — no `Worker` constructor, a constructor that threw, and a worker
   * that died — and the page rendered "this browser has no Web Worker support" for all
   * three. Two of them are not about the browser at all: a Content Security Policy without
   * `worker-src` and a bundle missing the worker chunk both produce a browser that supports
   * workers perfectly well. Telling somebody their browser is at fault when it is not sends
   * them to change something that will not help.
   */
  unavailable: string | null;
} {
  const workerRef = useRef<Worker | null>(null);
  const gate = useRef<ReplyGateState>(initialGate(""));
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [state, setState] = useState<RecommendationState>(IDLE);

  useEffect(() => {
    if (typeof Worker === "undefined") {
      setUnavailable("This browser has no Web Worker support");
      return;
    }

    // `typeof Worker === "undefined"` catches an environment with no constructor. It does
    // not catch a constructor that throws, which is what a Content Security Policy without
    // `worker-src` does, and what a bundle missing the worker chunk does. Unhandled, that
    // exception leaves the effect and reaches the error boundary, taking down a draft board
    // that would otherwise still work — the page already explains itself when
    // recommendations are unavailable, so a failure belongs on that path.
    let worker: Worker;
    try {
      worker = new Worker(new URL("./recommend.worker.ts", import.meta.url), {
        type: "module",
      });
    } catch {
      // The browser has workers; this one could not be constructed.
      setUnavailable("The recommendation worker could not be started");
      return;
    }
    workerRef.current = worker;

    worker.addEventListener("message", (event: MessageEvent<RecommendResponse>) => {
      const reply = event.data;
      // Out-of-order replies are discarded rather than rendered, and so are replies for a
      // league the user has since changed away from.
      if (verdictFor(gate.current, reply.id) !== "apply") return;
      gate.current = applied(gate.current, reply.id);

      // A superseded reply carries no answer, because the worker skipped a request a newer
      // one had already replaced. Applying it would blank the panel for the gap until that
      // newer answer lands; the right thing is to keep what is on screen and keep waiting.
      // The newest request in a burst is never superseded, so something always arrives.
      if (reply.superseded === true) return;

      setState({
        recommendations: reply.error === undefined ? reply.recommendations : [],
        stale: isStale(gate.current, reply.id),
        loading: false,
        error: reply.error ?? null,
        lastElapsedMs: reply.elapsedMs,
        lastFromCache: reply.cached,
      });
    });

    worker.addEventListener("error", (event) => {
      // An `error` event from a module worker means the script failed to load or threw at
      // the top level, so the worker is dead. Leaving `workerRef` set meant every later
      // request posted into the void: no reply ever came, the previous answer stayed on
      // screen marked stale for ever, and the next request cleared the error message that
      // was the only sign anything was wrong. Dropping the reference routes it to the
      // unavailable path, which the page already explains — naming the real cause rather
      // than blaming the browser.
      workerRef.current = null;
      setUnavailable("The recommendation worker stopped");
      setState((previous) => ({
        ...previous,
        loading: false,
        stale: false,
        error: event.message || "The recommendation worker failed.",
      }));
    });

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const request = useCallback(
    (
      draftState: DraftPolicyState,
      config: LeagueConfig,
      seed: number,
      candidateLimit?: number,
    ) => {
      const worker = workerRef.current;
      if (worker === null) return;

      const taken = nextRequest(gate.current);
      gate.current = taken.gate;
      const id = taken.id;

      setState((previous) => ({
        ...previous,
        // Keep the previous answer on screen, but say it is out of date.
        stale: previous.recommendations.length > 0,
        loading: previous.recommendations.length === 0,
        error: null,
      }));

      const message: RecommendRequest = {
        id,
        state: draftState,
        config,
        seed,
        candidateLimit,
      };
      worker.postMessage(message);
    },
    [],
  );

  /**
   * Points the hook at a different league, clearing anything belonging to the previous one.
   *
   * Called on every render with the current league's fingerprint; a no-op when it has not
   * changed, so it does not blank the panel each time the component re-renders. It has to
   * run whether or not a request follows — the case it exists for is the one where the board
   * is still loading and no request *can* follow.
   */
  const retargetTo = useCallback((fingerprint: string) => {
    const moved = retarget(gate.current, fingerprint);
    if (!moved.changed) return;
    gate.current = moved.gate;
    setState(IDLE);
  }, []);

  return { ...state, request, retargetTo, unavailable };
}
