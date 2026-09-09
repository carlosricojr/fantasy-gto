/** Manifest checks for a separate promotion review, never a ranking or selection policy. */
export const DRAFT_PROMOTION_VERSION = "draft-promotion-v1";

export interface DraftPromotionEvidence {
  version: string;
  kind: "descriptive-reused-cases" | "independent-evaluation";
  protocol: null | {
    id: string;
    artifact: string;
    registeredAt: number;
    minimumCases: number;
    minimumImprovement: number;
    confidenceLevel: number;
    maximumMissingFraction: number;
    maximumP95Ms: number;
    minimumLatencySamples: number;
  };
  evaluation: null | {
    protocolId: string;
    artifact: string;
    startedAt: number;
    completedAt: number;
    cases: number;
    independent: boolean;
    reusedCases: number;
    externalOutcomes: boolean;
  };
  comparisons: readonly {
    baseline: "guarded-adp" | "roster-needs-adp";
    cases: number;
    lowerBound: number;
    confidenceLevel: number;
    uncertainty: "independent-cases" | "simulation-draws";
  }[];
  rosters: null | { cases: number; teamsChecked: number; illegal: number; unresolved: number };
  missingness: null | { cases: number; expected: number; missing: number; excluded: number; documented: boolean };
  latency: null | { environment: string; p95Ms: number; samples: number; includesStartup: boolean; artifact: string };
}

export interface DraftPromotionCheck {
  id: "version" | "preregistration" | "independence" | "comparisons" | "rosters" | "missingness" | "latency";
  label: string;
  passed: boolean;
}

const count = (n: number, minimum = 0) => Number.isSafeInteger(n) && n >= minimum;
const nonempty = (s: string) => typeof s === "string" && s.trim().length > 0;
const fraction = (n: number) => Number.isFinite(n) && n >= 0 && n < 1;

/**
 * Evidence authenticity and scope still require review of the linked artifacts.
 * Even a passing manifest only earns review eligibility, never automatic promotion.
 */
export function draftPromotionGate(evidence: DraftPromotionEvidence | null | undefined): {
  version: typeof DRAFT_PROMOTION_VERSION;
  status: "not-promoted" | "eligible-for-review";
  checks: DraftPromotionCheck[];
} {
  const p = evidence?.protocol;
  const e = evidence?.evaluation;
  const protocol = !!p && !!e && nonempty(p.id) && nonempty(p.artifact) && nonempty(e.artifact) &&
    e.protocolId === p.id && Number.isFinite(p.registeredAt) && p.registeredAt > 0 &&
    Number.isFinite(e.startedAt) && Number.isFinite(e.completedAt) &&
    p.registeredAt < e.startedAt && e.startedAt <= e.completedAt &&
    count(p.minimumCases, 2) && Number.isFinite(p.minimumImprovement) && p.minimumImprovement >= 0 &&
    Number.isFinite(p.confidenceLevel) && p.confidenceLevel >= 0.95 && p.confidenceLevel < 1 &&
    fraction(p.maximumMissingFraction) && Number.isFinite(p.maximumP95Ms) && p.maximumP95Ms > 0 &&
    count(p.minimumLatencySamples, 2);
  const independent = protocol && evidence?.kind === "independent-evaluation" && !!e && !!p && e.independent === true && e.externalOutcomes === true &&
    e.reusedCases === 0 && count(e.cases, p.minimumCases);
  const comparisons = independent && !!p && !!e && Array.isArray(evidence?.comparisons) && evidence.comparisons.length === 2 &&
    (["guarded-adp", "roster-needs-adp"] as const).every(baseline => {
      const rows = evidence.comparisons.filter(row => row != null && row.baseline === baseline);
      return rows.length === 1 && rows[0].cases === e.cases && rows[0].uncertainty === "independent-cases" &&
        rows[0].confidenceLevel === p.confidenceLevel && Number.isFinite(rows[0].lowerBound) && rows[0].lowerBound > p.minimumImprovement;
    });
  const r = evidence?.rosters;
  const legal = independent && !!r && !!e && r.cases === e.cases && count(r.teamsChecked, e.cases * 2) && r.illegal === 0 && r.unresolved === 0;
  const m = evidence?.missingness;
  const covered = independent && !!m && !!e && !!p && m.cases === e.cases && m.documented === true &&
    count(m.expected, e.cases) && count(m.missing) && count(m.excluded) && m.missing + m.excluded <= m.expected &&
    (m.missing + m.excluded) / m.expected <= p.maximumMissingFraction;
  const l = evidence?.latency;
  const timely = protocol && !!l && !!p && l.environment === "browser-worker-mobile" && l.includesStartup === true &&
    nonempty(l.artifact) && count(l.samples, p.minimumLatencySamples) && Number.isFinite(l.p95Ms) && l.p95Ms > 0 && l.p95Ms <= p.maximumP95Ms;
  const checks: DraftPromotionCheck[] = [
    { id: "version", label: "Recognized evidence-gate version", passed: evidence?.version === DRAFT_PROMOTION_VERSION },
    { id: "preregistration", label: "Protocol and thresholds registered before evaluation", passed: protocol },
    { id: "independence", label: "Independent, unreused cases scored outside the simulator", passed: independent },
    { id: "comparisons", label: "Paired improvement over both ADP baselines", passed: comparisons },
    { id: "rosters", label: "Complete legal rosters for all evaluated cases", passed: legal },
    { id: "missingness", label: "Documented missing and excluded inputs within the registered limit", passed: covered },
    { id: "latency", label: "Browser/mobile latency within the registered budget", passed: timely },
  ];
  return { version: DRAFT_PROMOTION_VERSION, status: checks.every(check => check.passed) ? "eligible-for-review" : "not-promoted", checks };
}

/** The frozen September 9 diagnostic is descriptive, not independent promotion evidence. */
export const CURRENT_DRAFT_EVIDENCE: DraftPromotionEvidence = {
  version: DRAFT_PROMOTION_VERSION,
  kind: "descriptive-reused-cases",
  protocol: null,
  evaluation: null,
  comparisons: [],
  rosters: null,
  missingness: null,
  latency: null,
};
