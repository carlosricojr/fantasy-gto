import { describe, expect, it } from "vitest";
import { missingDraftPlayerIds, missingSleeperSnapshotPicks, sleeperRecommendationBlock, sleeperSetupFingerprint } from "./sleeper-readiness";
import { reconcileSleeperDraft, type SleeperSyncPick } from "./sleeper-sync";

const reconciliation = reconcileSleeperDraft({
  prior: { providerPicks: [], repairs: [] }, incoming: [], board: [], localPicks: {},
  expectedPickCount: 204, providerStatus: "drafting",
});
const setup = { teams: 12, rounds: 17, scoringId: "ppr", templateId: "two_flex" };
const setupKey = sleeperSetupFingerprint(setup);
const ready = { connected: true, verifiedAt: 1000, verifiedSetup: setupKey, currentSetup: setupKey, now: 1001, error: null, reconciliation };
const pick: SleeperSyncPick = {
  pickKey: "181", overall: 181, draftSlot: 1, playerName: "Unlisted back", position: "RB",
  team: null, playerId: "provider-id", isKeeper: false,
};

describe("Sleeper recommendation readiness", () => {
  it("leaves manual drafts alone and accepts a fresh reconciled poll", () => {
    expect(sleeperRecommendationBlock({ ...ready, connected: false, verifiedAt: null })).toBeNull();
    expect(sleeperRecommendationBlock(ready)).toBeNull();
  });
  it("requires a live poll after restoring a saved session", () => {
    expect(sleeperRecommendationBlock({ ...ready, verifiedAt: null })).toMatch(/this session/);
  });
  it("blocks setup edits synchronously until a matching configuration is verified", () => {
    const edited = sleeperSetupFingerprint({ ...setup, rounds: 18 });
    expect(sleeperRecommendationBlock({ ...ready, currentSetup: edited })).toMatch(/Local setup changed/);
    expect(sleeperRecommendationBlock({ ...ready, currentSetup: edited, verifiedSetup: edited })).toBeNull();
    expect(missingDraftPlayerIds({ 1: "unlisted:Kareem Hunt", 2: "known" }, new Map([["known", {}]]))).toEqual(["unlisted:Kareem Hunt"]);
  });
  it("pauses at the freshness boundary, even without another provider event", () => {
    expect(sleeperRecommendationBlock({ ...ready, now: 20_999 })).toBeNull();
    expect(sleeperRecommendationBlock({ ...ready, now: 21_000 })).toMatch(/20 seconds/);
    expect(sleeperRecommendationBlock({ ...ready, now: 21_001, verifiedAt: 21_001 })).toBeNull();
  });
  it("pauses immediately on provider, ownership or settings errors", () => {
    expect(sleeperRecommendationBlock({ ...ready, error: "Settings changed" })).toBe("Settings changed");
  });
  it("never recommends through an unresolved identity or conflict", () => {
    expect(sleeperRecommendationBlock({ ...ready, reconciliation: { ...reconciliation, unresolvedCount: 1 } })).toMatch(/unmatched/);
    expect(sleeperRecommendationBlock({ ...ready, reconciliation: { ...reconciliation, conflicts: [{ kind: "invalid-provider-pick", pickKey: "bad", overall: null }] } })).toMatch(/conflicts/);
  });
  it("does not demand continued polling after verified clean completion", () => {
    expect(sleeperRecommendationBlock({ ...ready, now: 1e9, reconciliation: { ...reconciliation, cleanCompletion: true } })).toBeNull();
  });
  it("blocks missing intermediate picks but allows future keeper squares", () => {
    const withGap = { ...reconciliation, acceptedPicks: { 2: "id" }, history: { ...reconciliation.history, providerPicks: [{ ...pick, overall: 2 }] } };
    expect(sleeperRecommendationBlock({ ...ready, reconciliation: withGap })).toMatch(/pick 1 is missing/);
    expect(sleeperRecommendationBlock({ ...ready, reconciliation: { ...withGap, history: { ...withGap.history, providerPicks: [{ ...pick, overall: 2, isKeeper: true }] } } })).toBeNull();
    expect(sleeperRecommendationBlock({ ...ready, providerComplete: true })).toMatch(/expected picks/);
  });
});

describe("whole-list rollback detection", () => {
  it("detects removed and replaced picks, but accepts reordering and repeated polls", () => {
    expect(missingSleeperSnapshotPicks([pick], [])).toEqual([181]);
    expect(missingSleeperSnapshotPicks([pick], [{ ...pick, playerId: "different" }])).toEqual([181]);
    expect(missingSleeperSnapshotPicks([pick], [pick])).toEqual([]);
    expect(missingSleeperSnapshotPicks([pick], [{ ...pick, overall: 182 }, pick])).toEqual([]);
  });
});
