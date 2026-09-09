import { expect, it } from "vitest";
import { assertWaiverProjectionIdentity, parseWaiverRosterEvidence, waiverRosterMembership } from "./waiver-pool-evidence";
import { waiverComparisonHref } from "./waiver-pool";
import type { WeeklyPlayer } from "./weekly-lineup";
const row = { season: "2026", week: "1", game_type: "REG", sleeper_id: "7", gsis_id: "gsis7", team: "BAL", position: "RB", status: "ACT" };
const player: WeeklyPlayer = { id: "7", name: "Synthetic", positions: ["RB"], availability: "questionable", projectedPoints: null, currentSlotId: null, kickoffAt: null };
it("accepts a unique active transaction destination without using stale directory team or clearing injury status", () => {
  const evidence = parseWaiverRosterEvidence([{ ...row, status: "TRD", team: "KC" }, row], 2026, 1);
  expect(waiverRosterMembership(player, evidence)).toEqual({ ok: true, team: "BAL" });
  expect(player.availability).toBe("questionable");
});
it.each([{ team: "KC" }, { gsis_id: "different" }, { position: "WR" }])("rejects conflicting active evidence %j independent of order", (patch) => {
  for (const rows of [[row, { ...row, ...patch }], [{ ...row, ...patch }, row]]) expect(waiverRosterMembership(player, parseWaiverRosterEvidence(rows, 2026, 1))).toEqual({ ok: false, reason: "conflicting" });
});
it("keeps unknown/nonactive statuses out, and does not fabricate missing identity membership", () => {
  for (const status of ["CUT", "RES", "INA", "DEV", "NEW_CODE", ""]) {
    const evidence = parseWaiverRosterEvidence([row, { ...row, sleeper_id: "8", status }], 2026, 1);
    expect(waiverRosterMembership({ ...player, id: "8" }, evidence).ok).toBe(false);
    expect(waiverRosterMembership({ ...player, id: "9" }, evidence)).toEqual({ ok: false, reason: "missing" });
  }
});
it("requires a currently reported team for defenses, not a player ID join", () => {
  const evidence = parseWaiverRosterEvidence([row], 2026, 1);
  expect(waiverRosterMembership({ ...player, id: "BAL", positions: ["DST"] }, evidence)).toEqual({ ok: true, team: "BAL" });
  expect(waiverRosterMembership({ ...player, id: "KC", positions: ["DST"] }, evidence).ok).toBe(false);
});
it("hands off exactly the saved league/owner without inventing a current week", () => {
  expect(waiverComparisonHref({ leagueId: "123", ownerId: "456" })).toBe("/waivers?leagueId=123&ownerId=456");
  expect(() => waiverComparisonHref({ leagueId: "../123", ownerId: "456" })).toThrow();
});
it("retains explicit identity contradictions even when a producer withholds points and game context", () => {
  const evidence = parseWaiverRosterEvidence([row], 2026, 1);
  expect(() => assertWaiverProjectionIdentity(player, { gsisId: "other" }, evidence, false)).toThrow("identity evidence disagrees");
  expect(() => assertWaiverProjectionIdentity(player, { gsisId: null }, evidence, false)).not.toThrow();
  expect(() => assertWaiverProjectionIdentity({ ...player, team: "KC" }, { gsisId: "gsis7" }, evidence)).toThrow("identity evidence disagrees");
});
