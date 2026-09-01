import { describe, expect, it } from "vitest";

import { appendSleeperIdentityRepair, reconcileSleeperDraft, type SleeperSyncPick } from "./sleeper-sync";
import type { PlayerIdentity } from "./provider-identity";

const board: PlayerIdentity[] = [
  { id: "a", providerId: "s-a", name: "Alpha Back", position: "RB", team: "ATL", rookie: false },
  { id: "b", providerId: "s-b", name: "Beta Wideout", position: "WR", team: "BUF", rookie: false },
];
const pick = (overrides: Partial<SleeperSyncPick> = {}): SleeperSyncPick => ({
  pickKey: "draft:1:s-a:1",
  overall: 1,
  draftSlot: 1,
  playerName: "Alpha Back",
  position: "RB",
  team: "ATL",
  playerId: "s-a",
  isKeeper: null,
  ...overrides,
});
const empty = { providerPicks: [], repairs: [] };

describe("reconcileSleeperDraft", () => {
  it("is idempotent across repeated and out-of-order whole-list polls", () => {
    const first = reconcileSleeperDraft({ prior: empty, incoming: [pick(), pick({ pickKey: "draft:2:s-b:2", overall: 2, draftSlot: 2, playerName: "Beta Wideout", position: "WR", team: "BUF", playerId: "s-b" })], board, localPicks: {}, expectedPickCount: 2, providerStatus: "drafting" });
    const second = reconcileSleeperDraft({ prior: first.history, incoming: [...first.history.providerPicks].reverse(), board, localPicks: {}, expectedPickCount: 2, providerStatus: "drafting" });
    expect(second.history.providerPicks.map((entry) => entry.overall)).toEqual([1, 2]);
    expect(second.acceptedPicks).toEqual({ 1: "a", 2: "b" });
    expect(second.conflicts).toEqual([]);
  });

  it("keeps unmatched and ambiguous provider picks visible until #60 repairs them", () => {
    const result = reconcileSleeperDraft({ prior: empty, incoming: [pick({ playerId: null, playerName: "Unknown", pickKey: "unknown" }), pick({ overall: 2, playerId: null, pickKey: "ambiguous" })], board: [...board, { ...board[0], id: "a-duplicate", providerId: null }], localPicks: {}, expectedPickCount: 2, providerStatus: "complete" });
    expect(result.classifications.map((entry) => entry.state)).toEqual(["unmatched", "ambiguous"]);
    expect(result.history.providerPicks).toHaveLength(2);
    expect(result.cleanCompletion).toBe(false);
  });

  it("surfaces a local/provider disagreement without overwriting either side", () => {
    const result = reconcileSleeperDraft({ prior: empty, incoming: [pick()], board, localPicks: { 1: "b" }, expectedPickCount: 1, providerStatus: "complete" });
    expect(result.acceptedPicks).toEqual({});
    expect(result.conflicts).toMatchObject([{ kind: "local-provider-disagreement", localPlayerId: "b" }]);
    expect(result.cleanCompletion).toBe(false);
  });

  it("retains conflicting same-key source records and never calls the complete poll clean", () => {
    const result = reconcileSleeperDraft({
      prior: empty,
      incoming: [pick(), pick({ playerId: "s-b", playerName: "Beta Wideout", position: "WR", team: "BUF" })],
      board,
      localPicks: {},
      expectedPickCount: 1,
      providerStatus: "complete",
    });
    expect(result.history.providerPicks).toHaveLength(2);
    expect(result.conflicts.some((conflict) => conflict.kind === "conflicting-provider-pick-key")).toBe(true);
    expect(result.cleanCompletion).toBe(false);
  });

  it("does not accept zero provider coordinates as a local draft pick", () => {
    const result = reconcileSleeperDraft({ prior: empty, incoming: [pick({ overall: 0, draftSlot: 0 })], board, localPicks: {}, expectedPickCount: 1, providerStatus: "complete" });
    expect(result.acceptedPicks).toEqual({});
    expect(result.conflicts).toMatchObject([{ kind: "invalid-provider-pick" }]);
  });

  it("only calls a completed draft clean after identity resolution and exact expected count", () => {
    const unresolved = reconcileSleeperDraft({ prior: empty, incoming: [pick({ playerId: null, playerName: "A. Back", pickKey: "repair-me" })], board, localPicks: {}, expectedPickCount: 1, providerStatus: "complete" });
    const repaired = reconcileSleeperDraft({ prior: appendSleeperIdentityRepair(unresolved.history, { repairId: "r1", pickKey: "repair-me", boardPlayerId: "a" }), incoming: [], board, localPicks: {}, expectedPickCount: 1, providerStatus: "complete" });
    expect(unresolved.cleanCompletion).toBe(false);
    expect(repaired.cleanCompletion).toBe(true);
  });
});
