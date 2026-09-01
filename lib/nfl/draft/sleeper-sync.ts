import {
  applyIdentityRepairs,
  classifyProviderPicks,
  type IdentityRepair,
  type PickIdentityClassification,
  type PlayerIdentity,
} from "./provider-identity";

/** The provider-pick data reconciliation needs, deliberately free of HTTP or framework code. */
export interface SleeperSyncPick {
  pickKey: string;
  overall: number | null;
  draftSlot: number | null;
  playerName: string;
  position: string | null;
  team: string | null;
  playerId: string | null;
  isKeeper: boolean | null;
}

export interface SleeperSyncHistory {
  /** Every provider event observed so far. History only grows across polls. */
  providerPicks: readonly SleeperSyncPick[];
  /** Operator decisions are append-only and replayed through #60. */
  repairs: readonly IdentityRepair[];
}

export interface ProviderPickConflict {
  kind:
    | "invalid-provider-pick"
    | "duplicate-provider-overall"
    | "provider-history-replaced"
    | "local-provider-disagreement";
  pickKey: string;
  overall: number | null;
  localPlayerId?: string;
  providerPlayerId?: string | null;
}

export interface SleeperReconciliation {
  history: SleeperSyncHistory;
  classifications: readonly PickIdentityClassification[];
  rejectedRepairs: ReturnType<typeof applyIdentityRepairs>["rejected"];
  /** Only resolved provider picks that do not conflict with local state are applicable. */
  acceptedPicks: Readonly<Record<number, string>>;
  conflicts: readonly ProviderPickConflict[];
  unresolvedCount: number;
  expectedPickCount: number;
  observedValidPickCount: number;
  /** Completion is clean only when provider count, identities and reconciliation all agree. */
  cleanCompletion: boolean;
}

function sortedUniqueHistory(
  existing: readonly SleeperSyncPick[],
  incoming: readonly SleeperSyncPick[],
): SleeperSyncPick[] {
  const byKey = new Map<string, SleeperSyncPick>();
  for (const pick of existing) byKey.set(pick.pickKey, pick);
  for (const pick of incoming) {
    // The first observed event is preserved. A same-key change from a provider is handled
    // as a visible history conflict below, not silently accepted as a replacement.
    if (!byKey.has(pick.pickKey)) byKey.set(pick.pickKey, pick);
  }
  return [...byKey.values()].sort(
    (left, right) =>
      (left.overall ?? Number.MAX_SAFE_INTEGER) - (right.overall ?? Number.MAX_SAFE_INTEGER) ||
      left.pickKey.localeCompare(right.pickKey),
  );
}

function identityInput(pick: SleeperSyncPick) {
  return {
    pickKey: pick.pickKey,
    providerPlayerId: pick.playerId,
    name: pick.playerName,
    position: pick.position,
    team: pick.team,
  };
}

/**
 * Reconciles whole-list Sleeper polls without deciding between competing facts.
 *
 * The #60 classifier and repair applier are the sole identity boundary. This function only
 * decides whether a resolved provider event can occupy a local overall pick; it never
 * changes matching heuristics, overwrites local state, or removes source history.
 */
export function reconcileSleeperDraft(input: {
  prior: SleeperSyncHistory;
  incoming: readonly SleeperSyncPick[];
  board: readonly PlayerIdentity[];
  localPicks: Readonly<Record<number, string>>;
  expectedPickCount: number;
  providerStatus: string;
}): SleeperReconciliation {
  const providerPicks = sortedUniqueHistory(input.prior.providerPicks, input.incoming);
  const previousByKey = new Map(input.prior.providerPicks.map((pick) => [pick.pickKey, pick]));
  const conflicts: ProviderPickConflict[] = [];
  for (const pick of input.incoming) {
    const previous = previousByKey.get(pick.pickKey);
    if (
      previous !== undefined &&
      (previous.overall !== pick.overall || previous.playerId !== pick.playerId || previous.draftSlot !== pick.draftSlot)
    ) {
      conflicts.push({
        kind: "provider-history-replaced",
        pickKey: pick.pickKey,
        overall: pick.overall,
        providerPlayerId: pick.playerId,
      });
    }
  }

  const repaired = applyIdentityRepairs(
    classifyProviderPicks(providerPicks.map(identityInput), input.board),
    input.board,
    input.prior.repairs,
  );
  const acceptedPicks: Record<number, string> = {};
  const byOverall = new Map<number, SleeperSyncPick>();
  for (const [index, pick] of providerPicks.entries()) {
    const classification = repaired.classifications[index];
    if (pick.overall === null || pick.draftSlot === null || pick.overall > input.expectedPickCount) {
      conflicts.push({ kind: "invalid-provider-pick", pickKey: pick.pickKey, overall: pick.overall });
      continue;
    }
    const sameOverall = byOverall.get(pick.overall);
    if (sameOverall !== undefined) {
      conflicts.push({ kind: "duplicate-provider-overall", pickKey: pick.pickKey, overall: pick.overall });
      continue;
    }
    byOverall.set(pick.overall, pick);
    if (classification.state !== "matched") continue;
    const localPlayerId = input.localPicks[pick.overall];
    if (localPlayerId !== undefined && localPlayerId !== classification.boardPlayerId) {
      conflicts.push({
        kind: "local-provider-disagreement",
        pickKey: pick.pickKey,
        overall: pick.overall,
        localPlayerId,
        providerPlayerId: pick.playerId,
      });
      continue;
    }
    acceptedPicks[pick.overall] = classification.boardPlayerId;
  }

  const unresolvedCount = repaired.classifications.filter(
    (classification) => classification.state !== "matched",
  ).length;
  const observedValidPickCount = byOverall.size;
  const cleanCompletion =
    input.providerStatus.trim().toLowerCase() === "complete" &&
    observedValidPickCount === input.expectedPickCount &&
    providerPicks.length === input.expectedPickCount &&
    unresolvedCount === 0 &&
    repaired.rejected.length === 0 &&
    conflicts.length === 0;

  return {
    history: { providerPicks, repairs: input.prior.repairs },
    classifications: repaired.classifications,
    rejectedRepairs: repaired.rejected,
    acceptedPicks,
    conflicts,
    unresolvedCount,
    expectedPickCount: input.expectedPickCount,
    observedValidPickCount,
    cleanCompletion,
  };
}

/** A repair is appended rather than mutating provider history or a previous decision. */
export function appendSleeperIdentityRepair(
  history: SleeperSyncHistory,
  repair: IdentityRepair,
): SleeperSyncHistory {
  return { ...history, repairs: [...history.repairs, repair] };
}
