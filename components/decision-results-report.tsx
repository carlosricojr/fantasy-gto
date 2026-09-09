"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import type { DecisionHistoryTransport } from "./decision-history";
import { appErrorMessage } from "../lib/errors";
import { DECISION_RESULTS_LIMIT, summarizeDecisionResults, type DecisionResultsInput, type DecisionResultsReport as Report, type DecisionResultsCohort } from "../lib/nfl/decision-results";

const labels: Record<DecisionResultsCohort, string> = {
  unrestricted: "No declared comparison limitations",
  limited: "Conditional or incomplete comparisons",
  experimental: "Experimental or unrecognized estimates",
};
const signed = (points: number) => `${points >= 0 ? "+" : ""}${points.toFixed(2)}`;

/** Explicit bounded reads only; no polling, upstream results refresh, writes or background scans. */
export function DecisionResultsReport({ transport, onSelect }: { transport: Pick<DecisionHistoryTransport, "list" | "detail">; onSelect: (id: string) => void }) {
  const [report, setReport] = useState<Report | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const busy = useRef(false);
  useEffect(() => () => { generation.current++; }, [transport]);

  async function load() {
    if (busy.current) return;
    busy.current = true;
    const current = ++generation.current;
    setLoading(true); setError(""); setReport(null);
    try {
      const batch = await transport.list(null);
      if (current !== generation.current) return;
      if (batch.page.length > DECISION_RESULTS_LIMIT) throw new Error("Unexpected review batch size.");
      const details: DecisionResultsInput[] = [];
      // Two in flight at most. Existing owner-scoped journal-read admission applies to each request.
      for (let i = 0; i < batch.page.length; i += 2) {
        const settled = await Promise.allSettled(batch.page.slice(i, i + 2).map(row => transport.detail(row._id)));
        if (current !== generation.current) return;
        const pair = settled.map(result => { if (result.status === "rejected") throw result.reason; return result.value; });
        for (let j = 0; j < pair.length; j++) {
          const detail = pair[j];
          if (detail === null || detail._id !== batch.page[i + j]._id) throw new Error("A decision became unavailable. Reload the review; no partial result was published.");
          details.push(detail);
        }
      }
      setReport(summarizeDecisionResults(details)); setHasOlder(!batch.isDone);
    } catch (cause) { if (current === generation.current) setError(appErrorMessage(cause, "Could not load the recent decision review.")); }
    // Invalidated requests still own the busy gate until their issued reads drain.
    // Releasing it here permits the replacement transport without overlapping batches.
    finally { busy.current = false; setLoading(false); }
  }

  return <section aria-label="Recent decision review" className="space-y-3 rounded-lg border p-4">
    <h2 className="font-semibold">Is the advice helping?</h2>
    <p className="text-sm text-muted-foreground">Review a recent batch of up to 20 saved decisions against the original starters. This uses stored observations, not new live results. Open a decision and check its observed results first, then reload this review.</p>
    <Button variant="outline" onClick={load} disabled={loading}>{loading ? "Reviewing saved observations…" : report ? "Reload recent review" : "Review recent decisions"}</Button>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {report && <DecisionResultsSummary report={report} hasOlder={hasOlder} onSelect={onSelect} />}
  </section>;
}

export function DecisionResultsSummary({ report, hasOlder, onSelect }: { report: Report; hasOlder: boolean; onSelect: (id: string) => void }) {
  return <div className="space-y-3 text-sm" aria-live="polite">
    <p>{report.inspected} recent records inspected · {report.rows.length} league/team/weeks retained · {report.revisions} older revisions excluded · {report.lateOrUnknownRecords} late or unknown-timing records excluded.</p>
    <p className="text-xs text-muted-foreground">Selection rule: latest receipt before the listed comparison kickoffs per league/team/week, selected without looking at outcomes. Independently late or incomplete results never fall back to an older winning recommendation.</p>
    {hasOlder && <p className="text-xs">Older saved records exist outside this bounded batch. This is not your complete season history.</p>}
    {report.invalidRecords > 0 && <p role="alert">{report.invalidRecords} unreadable or unsupported records. All comparisons are withheld because the latest revision cannot be established safely.</p>}
    {report.rows.length === 0 ? report.invalidRecords === 0 && <p>No eligible pre-listed-kickoff records in this batch.</p> : <>
      <p className="text-xs text-muted-foreground">Each summary stays within one league, team, season, scoring identity and limitation group. No combined cross-league point total.</p>
      <ul className="space-y-2">{report.cohorts.map((group, index) => <li key={group.key}><span className="font-medium">Group {index + 1}: {group.leagueName} · {group.season} · {labels[group.cohort]}</span>: {group.difference === null ? "No completed comparisons yet" : `${signed(group.difference)} points in total; ${signed(group.meanDifference!)} per comparison`} · {group.complete} completed comparisons across {group.weeks} distinct NFL weeks.<details className="mt-1 text-xs"><summary className="cursor-pointer">Group {index + 1} team and exact scoring</summary><p>Team owner ID: {group.teamId}</p><pre className="whitespace-pre-wrap break-all">{group.scoringId}</pre></details></li>)}</ul>
      <ul className="space-y-2">{report.rows.map(row => <li key={row.id}><button type="button" className="text-left underline underline-offset-4" onClick={() => onSelect(row.id)}>{row.leagueName} · {row.season} week {row.week}</button>: {row.status === "complete" ? `${signed(row.difference!)} points vs original starters` : row.status === "pending" ? "Pending / not checked" : row.status === "ineligible" ? "Not eligible after independent checks" : "Observation unavailable"} <span className="text-xs text-muted-foreground">· Group {report.cohorts.findIndex(group => group.scoringGroup === row.scoringGroup && group.cohort === row.cohort) + 1} · {labels[row.cohort]}</span></li>)}</ul>
    </>}
    <p className="text-xs text-muted-foreground">Included slots only; user-supplied inputs. Different scoring systems and limited comparisons are not directly comparable. Weeks and leagues can share players, so these are not independent trials. Saving decisions selectively can bias this sample. This descriptive review does not establish forecast accuracy, draft superiority, win probability, or that you submitted the advised lineup.</p>
  </div>;
}
