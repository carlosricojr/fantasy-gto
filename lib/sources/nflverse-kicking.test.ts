import { expect, it, vi } from "vitest";
import { NFLVERSE_KICKING_COUNTERS, nflverseKickingBaseline, parseNflverseKickingWeeks } from "./nflverse-kicking";
import { NflverseProvider } from "./nflverse";
import { parseSleeperScoring } from "../nfl/scoring/sleeper";

const row = (week = 1): Record<string, string> => ({ player_id: "k", season: "2025", season_type: "REG", week: String(week), position: "K", team: "LA",
  fg_made_0_19: "0", fg_made_20_29: "1", fg_made_30_39: "1", fg_made_40_49: "1", fg_made_50_59: "1", fg_made_60_: "1", fg_made: "5", fg_missed: "1", pat_made: "2", pat_missed: "1" });
const rules = (overrides = {}) => {
  const parsed = parseSleeperScoring({ fgm_0_19: 3, fgm_20_29: 3, fgm_30_39: 3, fgm_40_49: 4, fgm_50_59: 5, fgm_60p: 6, fgmiss: -1, xpm: 1, xpmiss: -1, pass_td: 4, st_ff: 1, rec: 0.5, ...overrides });
  if (!parsed.ok) throw new Error("Invalid fixture");
  return parsed.profile;
};
const target = { season: 2026, index: 1 };
const weeks = () => Array.from({ length: 9 }, (_, i) => row(i + 10));

it("scores all nine explicit kicking counters under imported rules and names every enabled offensive omission", () => {
  const baseline = nflverseKickingBaseline(parseNflverseKickingWeeks(weeks(), 2025), "k", target, rules());
  expect(baseline).toMatchObject({ points: 21, historyGames: 9, lastPlayed: { season: 2025, index: 18 }, calibration: "none", excludedRules: ["pass_td", "rec", "st_ff"] });
  expect(baseline).not.toHaveProperty("variance");
});
it.each(Object.values(NFLVERSE_KICKING_COUNTERS))("never imputes missing %s as zero or silently drops an incomplete appearance", column => {
  for (const invalid of [undefined, "", "NaN", "-1", "0.5", "Infinity"]) {
    const rows = weeks();
    if (invalid === undefined) delete rows[0][column]; else rows[0][column] = invalid;
    const parsed = parseNflverseKickingWeeks(rows, 2025);
    expect(parsed).toHaveLength(9);
    expect(nflverseKickingBaseline(parsed, "k", target, rules())).toBeNull();
  }
});
it("rejects inconsistent totals, malformed season/week, duplicates, too little history and later-season reuse", () => {
  for (const patch of [{ fg_made: "6" }, { fg_made: "" }, { season: "2024" }, { week: "" }, { week: "19" }] as Record<string, string>[]) {
    expect(nflverseKickingBaseline(parseNflverseKickingWeeks([{ ...row(10), ...patch }, ...weeks().slice(1)], 2025), "k", target, rules())).toBeNull();
  }
  const history = parseNflverseKickingWeeks(weeks(), 2025);
  expect(nflverseKickingBaseline([...history, history[0]], "k", target, rules())).toBeNull();
  expect(nflverseKickingBaseline(history.slice(0, 7), "k", target, rules())).toBeNull();
  expect(nflverseKickingBaseline(history, "unknown", target, rules())).toBeNull();
  expect(nflverseKickingBaseline(history, "k", { ...target, index: 2 }, rules())).toBeNull();
  expect(nflverseKickingBaseline(history, "k", { ...target, season: 2027 }, rules())).toBeNull();
});
it("retains valid signed/zero means, excludes later history and rejects mismatched scoring identity", () => {
  const history = parseNflverseKickingWeeks(weeks(), 2025);
  const penalties = parseSleeperScoring({ fgmiss: -1 });
  if (!penalties.ok) throw new Error("Invalid fixture");
  expect(nflverseKickingBaseline(history, "k", target, penalties.profile)?.points).toBe(-1);
  const zero = history.map(week => ({ ...week, counts: { ...week.counts!, fgmiss: 0 } }));
  expect(nflverseKickingBaseline(zero, "k", target, penalties.profile)?.points).toBe(0);
  expect(nflverseKickingBaseline([...history, ...history.map(week => ({ ...week, period: { season: 2026, index: 1 } }))], "k", target, rules())?.points).toBe(21);
  expect(nflverseKickingBaseline(history, "k", target, { ...rules(), coefficients: { xpm: 100 } })).toBeNull();
});
it("shares the existing statistics request and preserves strict evidence alongside legacy parsed rows", async () => {
  const fields = Object.keys(row());
  const csv = [fields.join(","), ...weeks().map(row => fields.map(field => row[field]).join(","))].join("\n");
  const fetch = vi.fn().mockResolvedValue(csv);
  const provider = new NflverseProvider(fetch);
  const [general, kicking] = await Promise.all([provider.playerWeeks(2025), provider.kickingWeeks(2025)]);
  expect(general.ok && general.data.length).toBe(9);
  expect(kicking.ok && kicking.data.length).toBe(9);
  await provider.kickingWeeks(2025);
  expect(fetch).toHaveBeenCalledTimes(1);
});
