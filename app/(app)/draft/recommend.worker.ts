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
}

const store = new LruMemoStore(256);

self.addEventListener("message", (event: MessageEvent<RecommendRequest>) => {
  const { id, state, config, seed, candidateLimit } = event.data;
  const startedAt = Date.now();

  try {
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
});
