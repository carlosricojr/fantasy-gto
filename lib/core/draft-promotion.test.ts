import { describe, expect, it } from "vitest";
import { CURRENT_DRAFT_EVIDENCE, DRAFT_PROMOTION_VERSION, draftPromotionGate, type DraftPromotionEvidence } from "./draft-promotion";

/** Synthetic qualifying manifest; these numbers are not measured product results. */
function qualifying(): DraftPromotionEvidence {
  return { version: DRAFT_PROMOTION_VERSION, kind: "independent-evaluation",
    protocol: { id: "test-protocol", artifact: "test-protocol-artifact", registeredAt: 1, minimumCases: 30,
      minimumImprovement: 1, confidenceLevel: 0.95, maximumMissingFraction: 0.05, maximumP95Ms: 2000, minimumLatencySamples: 100 },
    evaluation: { protocolId: "test-protocol", artifact: "test-evaluation-artifact", startedAt: 2, completedAt: 3,
      cases: 30, independent: true, reusedCases: 0, externalOutcomes: true },
    comparisons: ["guarded-adp", "roster-needs-adp"].map(baseline => ({ baseline: baseline as "guarded-adp" | "roster-needs-adp",
      cases: 30, lowerBound: 2, confidenceLevel: 0.95, uncertainty: "independent-cases" })),
    rosters: { cases: 30, teamsChecked: 300, illegal: 0, unresolved: 0 },
    missingness: { cases: 30, expected: 1000, missing: 20, excluded: 10, documented: true },
    latency: { environment: "browser-worker-mobile", p95Ms: 1500, samples: 100, includesStartup: true, artifact: "test-latency-artifact" } };
}

describe("versioned draft promotion gate", () => {
  it("keeps current descriptive reused-case evidence and absent evidence not promoted", () => {
    for (const evidence of [CURRENT_DRAFT_EVIDENCE, null, undefined]) expect(draftPromotionGate(evidence).status).toBe("not-promoted");
  });
  it("only grants review eligibility, never changes a ranking or automatically promotes", () => {
    const evidence = qualifying();
    const before = JSON.stringify(evidence);
    expect(draftPromotionGate(evidence).status).toBe("eligible-for-review");
    expect(draftPromotionGate(evidence).checks.every(check => check.passed)).toBe(true);
    expect(JSON.stringify(evidence)).toBe(before);
  });
  it.each(["version", "protocol", "evaluation", "comparisons", "rosters", "missingness", "latency"] as const)("fails closed without %s", key => {
    const evidence = qualifying();
    if (key === "version") evidence.version = "future-version";
    else if (key === "comparisons") evidence.comparisons = [];
    else evidence[key] = null;
    expect(draftPromotionGate(evidence).status).toBe("not-promoted");
  });
  it("rejects retrospective registration, reused/simulator-only evidence and insufficient registered case counts", () => {
    const mutations: ((e: DraftPromotionEvidence) => void)[] = [
      e => { e.protocol!.registeredAt = e.evaluation!.startedAt; }, e => { e.protocol!.artifact = " "; },
      e => { e.evaluation!.protocolId = "different"; }, e => { e.evaluation!.reusedCases = 1; },
      e => { e.evaluation!.independent = false; }, e => { e.evaluation!.externalOutcomes = false; },
      e => { e.kind = "descriptive-reused-cases"; },
      e => { e.evaluation!.cases = 29; }, e => { e.protocol!.minimumCases = 0; },
      e => { e.protocol!.minimumImprovement = NaN; }, e => { e.protocol!.maximumMissingFraction = 1; },
    ];
    for (const mutate of mutations) { const evidence = qualifying(); mutate(evidence); expect(draftPromotionGate(evidence).status).toBe("not-promoted"); }
  });
  it("requires both unique paired baselines and uncertainty across independent cases", () => {
    for (const comparisons of [undefined, null, {}, [null, null]]) {
      expect(draftPromotionGate({ ...qualifying(), comparisons } as unknown as DraftPromotionEvidence).status).toBe("not-promoted");
    }
    for (const patch of [{ lowerBound: 1 }, { lowerBound: NaN }, { cases: 29 }, { confidenceLevel: 0.9 }, { uncertainty: "simulation-draws" as const }]) {
      const evidence = qualifying(); evidence.comparisons = [evidence.comparisons[0], { ...evidence.comparisons[1], ...patch }];
      expect(draftPromotionGate(evidence).status).toBe("not-promoted");
    }
    const evidence = qualifying(); evidence.comparisons = [evidence.comparisons[0], evidence.comparisons[0]];
    expect(draftPromotionGate(evidence).status).toBe("not-promoted");
  });
  it("rejects incomplete roster, missingness or real-device latency evidence", () => {
    const mutations: ((e: DraftPromotionEvidence) => void)[] = [
      e => { e.rosters!.illegal = 1; }, e => { e.rosters!.unresolved = 1; }, e => { e.rosters!.cases = 29; },
      e => { e.rosters!.teamsChecked = 0; }, e => { e.missingness!.documented = false; }, e => { e.missingness!.expected = 0; },
      e => { e.missingness!.missing = 51; }, e => { e.missingness!.excluded = -1; }, e => { e.missingness!.cases = 29; },
      e => { e.latency!.environment = "desktop-node"; }, e => { e.latency!.includesStartup = false; },
      e => { e.latency!.p95Ms = 2001; }, e => { e.latency!.samples = 99; }, e => { e.latency!.artifact = ""; },
    ];
    for (const mutate of mutations) { const evidence = qualifying(); mutate(evidence); expect(draftPromotionGate(evidence).status).toBe("not-promoted"); }
  });
});
