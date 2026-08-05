/// <reference lib="webworker" />

import { LruMemoStore, recommendMemoized } from "@/lib/core/draft-memo";
import type { ChampionshipRecommendation, DraftPolicyState } from "@/lib/core/draft-policy";
import type { LeagueConfig } from "@/lib/core/season-sim";

/**
 * The recommendation, off the main thread.
 *
 * A recommendation takes on the order of a second — comfortable against a draft clock, but
 * not on the thread painting the board. Run inline it freezes the interface at exactly the
 * moment the user is deciding, and every keystroke in the player search stalls behind it.
 *
 * The memo lives here rather than in the page. A worker outlives a React render, so a
 * position solved for one pick is still solved when the board changes and changes back —
 * which happens constantly as picks are corrected.
 */

export interface RecommendRequest {
  id: number;
  state: DraftPolicyState;
  config: LeagueConfig;
  seed: number;
  candidateLimit?: number;
}

export interface RecommendResponse {
  id: number;
  recommendations: ChampionshipRecommendation[];
  cached: boolean;
  elapsedMs: number;
  error?: string;
  /** Set when a newer request arrived before this one ran, so nothing was computed. */
  superseded?: boolean;
}

const store = new LruMemoStore(256);

/**
 * The newest request id this worker has been handed.
 *
 * Every `draftState` change posts a request and each one is computed to completion, so a
 * run of quick picks queues a simulation per pick and the board's *current* answer waits
 * behind all of them. Three picks in a second is three seconds before the panel is right,
 * and every one of those seconds is spent on a position the user has already left.
 *
 * The queue cannot be inspected, so the skip happens the only way it can: the handler
 * records the id and defers the work by a task, which lets every already-queued message
 * take its turn first. By the time the deferred work runs, `latestId` is the newest request
 * there is, and anything older than it can be answered without being computed.
 *
 * A superseded request still gets a reply. `use-recommendations` sets `loading` on send and
 * clears it on receipt, so a request that is silently dropped leaves the panel spinning for
 * ever — the same failure the catch below exists to prevent.
 */
let latestId = -1;

self.addEventListener("message", (event: MessageEvent<RecommendRequest>) => {
  const incoming = (event.data as Partial<RecommendRequest> | null)?.id;
  if (typeof incoming === "number" && Number.isFinite(incoming) && incoming > latestId) {
    latestId = incoming;
  }
  setTimeout(() => handle(event), 0);
});

function handle(event: MessageEvent<RecommendRequest>): void {
  const startedAt = Date.now();
  // Destructured inside the guard, not above it. A malformed message threw here, before
  // the try, so the worker posted no reply at all and the requester sat on `loading: true`
  // for ever — the one outcome the catch below exists to prevent.
  let id = -1;

  try {
    const request = event.data as Partial<RecommendRequest> | null;
    if (typeof request !== "object" || request === null) {
      throw new Error("The worker received a message it could not read.");
    }
    if (typeof request.id !== "number" || !Number.isFinite(request.id)) {
      // Without a usable id the reply cannot be matched to a request, and
      // `use-recommendations` would drop it as out of order. Nothing can be answered.
      throw new Error("The worker received a request with no usable id.");
    }
    id = request.id;
    // `state` and `config` fail loudly anyway, because `memoKey` dereferences them. `seed`
    // is the one field that passes straight through: it lands in the memo key as
    // `seed=undefined` and reaches the sampler as NaN, and the worker then replies with a
    // normal response carrying no error — a degenerate ranking presented as a valid one.
    if (typeof request.seed !== "number" || !Number.isFinite(request.seed)) {
      throw new Error("The worker received a request with no usable seed.");
    }
    // Same rule as `seed`, and the same failure without it: a non-numeric limit reaches
    // `Math.max(candidateLimit, 1)` as NaN, `slice(0, NaN)` returns nothing, and the reply
    // is a normal response carrying an empty ranking and no error.
    if (
      request.candidateLimit !== undefined &&
      (typeof request.candidateLimit !== "number" ||
        !Number.isFinite(request.candidateLimit))
    ) {
      throw new Error("The worker received a request with an unusable candidate limit.");
    }
    const { state, config, seed, candidateLimit } = request as RecommendRequest;

    // Superseded while it waited. Answered rather than dropped, and answered emptily rather
    // than staleley: `use-recommendations` compares ids and will discard this the moment
    // the newer reply lands, but it has to land *something* to clear the loading flag.
    if (id < latestId) {
      const superseded: RecommendResponse = {
        id,
        recommendations: [],
        cached: false,
        elapsedMs: Date.now() - startedAt,
        superseded: true,
      };
      self.postMessage(superseded);
      return;
    }

    const result = recommendMemoized(
      store,
      state,
      config,
      seed,
      candidateLimit,
    );
    const response: RecommendResponse = {
      id,
      recommendations: result.recommendations,
      cached: result.cached,
      elapsedMs: Date.now() - startedAt,
    };
    self.postMessage(response);
  } catch (error) {
    // A thrown worker is a silent worker: the page would wait forever for a reply that
    // never comes. The failure is reported so the interface can say so and offer a retry.
    const response: RecommendResponse = {
      id,
      recommendations: [],
      cached: false,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
}
