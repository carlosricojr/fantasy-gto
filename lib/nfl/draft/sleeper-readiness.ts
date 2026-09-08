import type { SleeperReconciliation, SleeperSyncPick } from "./sleeper-sync";

/** Operational freshness guard: five missed four-second polls, not model uncertainty. */
export const SLEEPER_STALE_AFTER_MS = 20_000;

export function sleeperSetupFingerprint(setup: { teams: number; rounds: number; scoringId: string; templateId: string; playoffTeams?: number; championshipWeek?: number; extraMedianMatchup?: boolean }): string {
  return JSON.stringify([setup.teams, setup.rounds, setup.scoringId, setup.templateId, setup.playoffTeams ?? 6, setup.championshipWeek ?? 17, setup.extraMedianMatchup === true]);
}

export function missingDraftPlayerIds(picks: Readonly<Record<number, string>>, known: ReadonlyMap<string, unknown>): string[] {
  return [...new Set(Object.values(picks).filter((id) => !known.has(id)))];
}

/** A saved receipt is not proof of a successful poll in this browser session. */
export function sleeperRecommendationBlock(input: {
  connected: boolean;
  verifiedAt: number | null;
  verifiedSetup: string | null;
  currentSetup: string;
  now: number;
  error: string | null;
  providerComplete?: boolean;
  reconciliation: SleeperReconciliation | null;
}): string | null {
  if (!input.connected) return null;
  if (input.error !== null) return input.error;
  if (input.verifiedAt === null || input.reconciliation === null) {
    return "Waiting for a successful Sleeper poll in this session.";
  }
  if (input.verifiedSetup !== input.currentSetup) return "Local setup changed. Waiting for Sleeper to verify this exact configuration.";
  const state = input.reconciliation;
  if (state.unresolvedCount > 0) return "Resolve the unmatched Sleeper picks before using recommendations.";
  if (state.conflicts.length > 0 || state.rejectedRepairs.length > 0) {
    return "Resolve the Sleeper pick conflicts before using recommendations.";
  }
  if (input.providerComplete === true && !state.cleanCompletion) return "Sleeper reports complete, but the expected picks have not all reconciled.";
  const lastRegularPick = Math.max(0, ...state.history.providerPicks.flatMap((pick) =>
    pick.isKeeper !== true && pick.overall !== null && pick.overall <= state.expectedPickCount ? [pick.overall] : [],
  ));
  for (let overall = 1; overall <= lastRegularPick; overall += 1) {
    if (state.acceptedPicks[overall] === undefined) return `Sleeper pick ${overall} is missing before a later observed pick. Wait for the complete snapshot.`;
  }
  if (!state.cleanCompletion && input.now - input.verifiedAt >= SLEEPER_STALE_AFTER_MS) {
    return "Sleeper has not refreshed for 20 seconds. Check the draft room and retry sync.";
  }
  return null;
}

/**
 * REST is a whole-list snapshot. A shorter list can be a rollback or a stale cache; neither
 * licenses silently keeping a removed pick and advising from it. Wait for reconciliation.
 * Compare source identities, not repair labels or our locally appended conflict suffixes.
 */
export function missingSleeperSnapshotPicks(
  prior: readonly SleeperSyncPick[],
  incoming: readonly SleeperSyncPick[],
): number[] {
  return [...new Set(prior.flatMap((pick) =>
    pick.overall !== null && !incoming.some((next) =>
      next.overall === pick.overall && next.playerId === pick.playerId,
    ) ? [pick.overall] : [],
  ))].sort((a, b) => a - b);
}
