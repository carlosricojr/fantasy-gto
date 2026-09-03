import { normalizeMarketPosition } from "./config";
import { normalizeName } from "./match";
import { normalizeTeam } from "../teams";

/**
 * A player as known by either the board or a provider.
 *
 * `id` is local to the supplied collection. `providerId` is the stable bridge (for
 * Sleeper, its player id). Names are deliberately a secondary bridge: they are useful
 * when an upstream mapping is incomplete, but are not unique identities.
 */
export interface PlayerIdentity {
  id: string;
  providerId: string | null;
  name: string;
  position: string;
  team: string | null;
  rookie: boolean;
}
/** Source context retained even when the identity cannot be resolved. */
export interface ProviderPickIdentity {
  /** Stable within the provider draft/history; an operator repair attaches to this key. */
  pickKey: string;
  providerPlayerId: string | null;
  name: string;
  position: string | null;
  team: string | null;
}

export interface IdentityCandidate {
  boardPlayerId: string;
  providerId: string | null;
  name: string;
  position: string;
  team: string | null;
  rookie: boolean;
}

type UnmatchedReason =
  | "missing-name-position-or-team"
  | "no-provider-id-or-fallback-match";
type AmbiguousReason =
  | "provider-id-collision"
  | "defense-team-collision"
  | "fallback-collision";

export type PickIdentityClassification =
  | {
      state: "matched";
      input: ProviderPickIdentity;
      boardPlayerId: string;
      matchedBy:
        | "provider-id"
        | "defense-team"
        | "name-position-team"
        | "operator-repair";
      repairId?: string;
    }
  | {
      state: "ambiguous";
      input: ProviderPickIdentity;
      reason: AmbiguousReason;
      candidates: readonly IdentityCandidate[];
    }
  | {
      state: "unmatched";
      input: ProviderPickIdentity;
      reason: UnmatchedReason;
    };

function clean(value: string | null | undefined): string | null {
  // `value?.trim()` is only a string or undefined. Its only falsy string is `""`, the
  // fallback itself, so the mutation `??` → `||` is equivalent (documented by the #60
  // mutation run rather than left looking like an untested branch).
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

function normalizedPosition(value: string | null | undefined): string | null {
  const raw = clean(value);
  return raw === null ? null : normalizeMarketPosition(raw);
}

function normalizedTeam(value: string | null | undefined): string | null {
  const raw = clean(value);
  return raw === null ? null : normalizeTeam(raw);
}

function fallbackKey(
  name: string,
  position: string | null | undefined,
  team: string | null | undefined,
): string | null {
  const nameKey = normalizeName(name);
  const positionKey = normalizedPosition(position);
  const teamKey = normalizedTeam(team);
  if (nameKey === "" || positionKey === null || teamKey === null) return null;
  return `${nameKey}|${positionKey}|${teamKey}`;
}

/**
 * A defense is the NFL team, not a person. Providers legitimately name that same entity
 * differently (for example, Sleeper's "Los Angeles Rams" and our "LA Rams Defense"),
 * while the normalized team and DST position identify it exactly.
 */
function defenseTeamKey(
  position: string | null | undefined,
  team: string | null | undefined,
): string | null {
  const positionKey = normalizedPosition(position);
  const teamKey = normalizedTeam(team);
  return positionKey === "DST" && teamKey !== null ? `DST|${teamKey}` : null;
}

function candidate(player: PlayerIdentity): IdentityCandidate {
  return {
    boardPlayerId: player.id,
    providerId: player.providerId,
    name: player.name,
    position: player.position,
    team: player.team,
    rookie: player.rookie,
  };
}

function insert(
  index: Map<string, PlayerIdentity[]>,
  key: string,
  player: PlayerIdentity,
): void {
  const existing = index.get(key);
  if (existing === undefined) index.set(key, [player]);
  else existing.push(player);
}

function sortedCandidates(
  players: readonly PlayerIdentity[],
): IdentityCandidate[] {
  return [...players]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(candidate);
}

interface BoardIndex {
  byProviderId: ReadonlyMap<string, readonly PlayerIdentity[]>;
  byDefenseTeam: ReadonlyMap<string, readonly PlayerIdentity[]>;
  byFallback: ReadonlyMap<string, readonly PlayerIdentity[]>;
}

function buildBoardIndex(board: readonly PlayerIdentity[]): BoardIndex {
  const byProviderId = new Map<string, PlayerIdentity[]>();
  const byDefenseTeam = new Map<string, PlayerIdentity[]>();
  const byFallback = new Map<string, PlayerIdentity[]>();
  for (const player of board) {
    const providerId = clean(player.providerId);
    if (providerId !== null) insert(byProviderId, providerId, player);
    const defenseKey = defenseTeamKey(player.position, player.team);
    if (defenseKey !== null) insert(byDefenseTeam, defenseKey, player);
    const key = fallbackKey(player.name, player.position, player.team);
    if (key !== null) insert(byFallback, key, player);
  }
  return { byProviderId, byDefenseTeam, byFallback };
}

function classifyOne(
  pick: ProviderPickIdentity,
  index: BoardIndex,
): PickIdentityClassification {
  const providerId = clean(pick.providerPlayerId);
  if (providerId !== null) {
    // This index inserts arrays only when it inserts at least one player, so `??` → `||`
    // is equivalent here. The same invariant holds for the fallback and repair indexes.
    const providerMatches = index.byProviderId.get(providerId) ?? [];
    if (providerMatches.length === 1) {
      return {
        state: "matched",
        input: pick,
        boardPlayerId: providerMatches[0].id,
        matchedBy: "provider-id",
      };
    }
    // The length-one return above makes `> 1`, `>= 1`, and `> 0` equivalent at this point;
    // those two surviving mutations are recorded as equivalent, not ignored coverage gaps.
    if (providerMatches.length > 1) {
      // An ID collision is an identity conflict. Do not use a reassuring-looking name
      // match to hide it: the provider ID is the stronger evidence and needs repair.
      return {
        state: "ambiguous",
        input: pick,
        reason: "provider-id-collision",
        candidates: sortedCandidates(providerMatches),
      };
    }
  }

  const defenseKey = defenseTeamKey(pick.position, pick.team);
  if (defenseKey !== null) {
    const defenseMatches = index.byDefenseTeam.get(defenseKey) ?? [];
    if (defenseMatches.length === 1) {
      return {
        state: "matched",
        input: pick,
        boardPlayerId: defenseMatches[0].id,
        matchedBy: "defense-team",
      };
    }
    if (defenseMatches.length > 1) {
      return {
        state: "ambiguous",
        input: pick,
        reason: "defense-team-collision",
        candidates: sortedCandidates(defenseMatches),
      };
    }
  }

  const key = fallbackKey(pick.name, pick.position, pick.team);
  if (key === null) {
    return {
      state: "unmatched",
      input: pick,
      reason: "missing-name-position-or-team",
    };
  }
  // See the provider-index equivalent-mutant note above.
  const fallbackMatches = index.byFallback.get(key) ?? [];
  if (fallbackMatches.length === 1) {
    return {
      state: "matched",
      input: pick,
      boardPlayerId: fallbackMatches[0].id,
      matchedBy: "name-position-team",
    };
  }
  // The single-candidate return above makes the `>= 1` and `> 0` mutations equivalent.
  if (fallbackMatches.length > 1) {
    return {
      state: "ambiguous",
      input: pick,
      reason: "fallback-collision",
      candidates: sortedCandidates(fallbackMatches),
    };
  }
  return {
    state: "unmatched",
    input: pick,
    reason: "no-provider-id-or-fallback-match",
  };
}

/**
 * Classifies every input pick. The one-to-one `map` is intentional: an unfamiliar or
 * duplicated identity is represented as unresolved, never discarded from draft history.
 */
export function classifyProviderPicks(
  picks: readonly ProviderPickIdentity[],
  board: readonly PlayerIdentity[],
): PickIdentityClassification[] {
  const index = buildBoardIndex(board);
  return picks.map((pick) => classifyOne(pick, index));
}

export interface IdentityRepair {
  repairId: string;
  pickKey: string;
  boardPlayerId: string;
}

export interface RejectedIdentityRepair {
  repair: IdentityRepair;
  reason:
    | "duplicate-pick-repair"
    | "pick-not-unresolved"
    | "board-player-not-found"
    | "board-player-already-assigned";
}

export interface IdentityRepairApplication {
  classifications: PickIdentityClassification[];
  rejected: RejectedIdentityRepair[];
}

/**
 * Replays append-only operator decisions over classified history.
 *
 * The raw provider pick remains in every classification. A repair is a separate record,
 * so correcting an ambiguous/unmatched identity never rewrites or removes the original
 * draft event. Duplicate repairs are rejected rather than taking whichever one happened
 * to be iterated last.
 */
export function applyIdentityRepairs(
  classifications: readonly PickIdentityClassification[],
  board: readonly PlayerIdentity[],
  repairs: readonly IdentityRepair[],
): IdentityRepairApplication {
  const byPick = new Map<string, IdentityRepair[]>();
  for (const repair of repairs) {
    const existing = byPick.get(repair.pickKey);
    if (existing === undefined) byPick.set(repair.pickKey, [repair]);
    else existing.push(repair);
  }
  const boardIds = new Set(board.map((player) => player.id));
  // A repair may only fill an unassigned slot. Seed this with prior resolved draft history,
  // then extend it as repairs are accepted so neither path can assign one board player twice.
  const assignedBoardPlayerIds = new Set(
    classifications
      .filter(
        (classification): classification is Extract<
          PickIdentityClassification,
          { state: "matched" }
        > => classification.state === "matched",
      )
      .map((classification) => classification.boardPlayerId),
  );
  const rejected: RejectedIdentityRepair[] = [];
  const classificationsWithRepairs = classifications.map((classification) => {
    // `byPick` only contains non-empty arrays, so its `??` → `||` mutation is equivalent.
    const candidates = byPick.get(classification.input.pickKey) ?? [];
    if (candidates.length === 0) return classification;
    if (candidates.length > 1) {
      rejected.push(
        ...candidates.map((repair) => ({
          repair,
          reason: "duplicate-pick-repair" as const,
        })),
      );
      return classification;
    }
    const repair = candidates[0];
    if (classification.state === "matched") {
      // A deterministic matcher can improve after an operator repaired an older build.
      // When it now reaches the exact same target, the append-only repair is corroborating
      // history, not a conflict. Rejecting it would turn a previously clean completed draft
      // yellow on the deployment that made matching better. A different target remains a
      // real disagreement and is still refused below.
      if (repair.boardPlayerId === classification.boardPlayerId) return classification;
      rejected.push({ repair, reason: "pick-not-unresolved" });
      return classification;
    }
    if (!boardIds.has(repair.boardPlayerId)) {
      rejected.push({ repair, reason: "board-player-not-found" });
      return classification;
    }
    if (assignedBoardPlayerIds.has(repair.boardPlayerId)) {
      rejected.push({ repair, reason: "board-player-already-assigned" });
      return classification;
    }
    assignedBoardPlayerIds.add(repair.boardPlayerId);
    return {
      state: "matched" as const,
      input: classification.input,
      boardPlayerId: repair.boardPlayerId,
      matchedBy: "operator-repair" as const,
      repairId: repair.repairId,
    };
  });
  const classifiedPickKeys = new Set(
    classifications.map((entry) => entry.input.pickKey),
  );
  for (const repair of repairs) {
    if (!classifiedPickKeys.has(repair.pickKey)) {
      rejected.push({ repair, reason: "pick-not-unresolved" });
    }
  }
  return { classifications: classificationsWithRepairs, rejected };
}

export interface CoverageCounts {
  total: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
  unresolved: readonly Exclude<
    PickIdentityClassification,
    { state: "matched" }
  >[];
}

function counts(
  classifications: readonly PickIdentityClassification[],
): CoverageCounts {
  const unresolved = classifications.filter(
    (
      classification,
    ): classification is Exclude<
      PickIdentityClassification,
      { state: "matched" }
    > => classification.state !== "matched",
  );
  return {
    total: classifications.length,
    matched: classifications.length - unresolved.length,
    ambiguous: unresolved.filter((entry) => entry.state === "ambiguous").length,
    unmatched: unresolved.filter((entry) => entry.state === "unmatched").length,
    unresolved,
  };
}

function asPicks(
  identities: readonly PlayerIdentity[],
): ProviderPickIdentity[] {
  return identities.map((identity) => ({
    pickKey: identity.id,
    providerPlayerId: identity.providerId,
    name: identity.name,
    position: identity.position,
    team: identity.team,
  }));
}

export interface IdentityCoverageAudit {
  /** Board identities measured against the provider universe. */
  board: CoverageCounts;
  /** Provider identities measured against the board. */
  provider: CoverageCounts;
  boardRookies: CoverageCounts;
  providerRookies: CoverageCounts;
}

/** Coverage is clean only when every identity in both directions is matched. */
export function hasUnresolvedIdentityCoverage(
  audit: IdentityCoverageAudit,
): boolean {
  return (
    audit.board.unresolved.length > 0 || audit.provider.unresolved.length > 0
  );
}

/**
 * Measures both directions with the exact same classifier used for live picks.
 *
 * Reversing the collections is deliberate: provider-only players and board-only players
 * have different denominators, and collapsing them would make a one-sided gap invisible.
 */
export function auditIdentityCoverage(
  board: readonly PlayerIdentity[],
  provider: readonly PlayerIdentity[],
): IdentityCoverageAudit {
  const boardClassifications = classifyProviderPicks(asPicks(board), provider);
  const providerClassifications = classifyProviderPicks(
    asPicks(provider),
    board,
  );
  const boardRookieIds = new Set(
    board.filter((identity) => identity.rookie).map((identity) => identity.id),
  );
  const providerRookieIds = new Set(
    provider.filter((identity) => identity.rookie).map((identity) => identity.id),
  );
  const boardRookieClassifications = boardClassifications.filter((entry) =>
    boardRookieIds.has(entry.input.pickKey),
  );
  const providerRookieClassifications = providerClassifications.filter(
    (entry) => providerRookieIds.has(entry.input.pickKey),
  );
  return {
    board: counts(boardClassifications),
    provider: counts(providerClassifications),
    boardRookies: counts(boardRookieClassifications),
    providerRookies: counts(providerRookieClassifications),
  };
}
