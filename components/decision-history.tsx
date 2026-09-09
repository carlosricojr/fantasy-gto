"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { appErrorMessage } from "../lib/errors";
import type { WeeklyDecisionRecord, WeeklyDecisionEvaluation, WeeklyDecisionOutcomes } from "../lib/nfl/decision-journal";

export interface DecisionSummary { _id: string; recordedAt: number; leagueName: string; season: number; week: number; timing: string }
export interface DecisionObservation { observedAt: number; outcomeJson: string; evaluationJson: string }
export interface DecisionDetail { _id: string; recordJson: string; observations: DecisionObservation[] }
export interface DecisionHistoryTransport {
  list: (cursor: string | null) => Promise<{ page: DecisionSummary[]; isDone: boolean; continueCursor: string }>;
  detail: (id: string) => Promise<DecisionDetail | null>;
  refreshOutcomes: (id: string) => Promise<unknown>;
}

export function DecisionHistory({ transport, initialId }: { transport: DecisionHistoryTransport; initialId: string | null }) {
  const [rows, setRows] = useState<DecisionSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [detail, setDetail] = useState<DecisionDetail | null>(null);
  const [selected, setSelected] = useState<string | null>(initialId);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);

  useEffect(() => {
    let active = true;
    transport.list(null).then(result => {
      if (!active) return;
      setRows(result.page); setCursor(result.continueCursor); setMore(!result.isDone);
    }).catch(cause => { if (active) setError(appErrorMessage(cause, "Could not load private decisions.")); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [transport]);

  useEffect(() => {
    const current = ++generation.current;
    setDetail(null); setError("");
    if (selected === null) return;
    transport.detail(selected).then(result => {
      if (generation.current !== current) return;
      setDetail(result);
      if (result === null) setError("That record is unavailable or does not belong to this account.");
    }).catch(cause => { if (generation.current === current) setError(appErrorMessage(cause, "Could not load that decision.")); });
    return () => { generation.current += 1; };
  }, [selected, transport]);

  async function loadMore() {
    if (!more || loading) return;
    setLoading(true); setError("");
    try {
      const result = await transport.list(cursor);
      setRows(prior => [...new Map([...prior, ...result.page].map(row => [row._id, row])).values()]);
      setCursor(result.continueCursor); setMore(!result.isDone);
    } catch (cause) { setError(appErrorMessage(cause, "Could not load more decisions.")); }
    finally { setLoading(false); }
  }

  async function observe() {
    if (selected === null || refreshing) return;
    const current = generation.current;
    const id = selected;
    setRefreshing(true); setError("");
    try {
      await transport.refreshOutcomes(id);
      const updated = await transport.detail(id);
      if (current === generation.current) setDetail(updated);
    } catch (cause) { if (current === generation.current) setError(appErrorMessage(cause, "Could not observe results. The original record is unchanged.")); }
    finally { setRefreshing(false); }
  }

  return <div className="space-y-6">
    <p className="text-sm text-muted-foreground">Private receipt-dated records, not proof that submitted forecasts or roster state were independently verified. Each result compares saved advice with the starters saved at that moment. Multiple records in one week are revisions, not independent trials.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {loading && rows.length === 0 ? <p role="status">Loading your decisions…</p> : rows.length === 0 ? <p>No saved decisions yet. Save a weekly recommendation before kickoff to begin.</p> : <ul className="space-y-2">{rows.map(row => <li key={row._id}><button className={`w-full rounded-lg border p-3 text-left text-sm focus-visible:outline focus-visible:outline-2 ${row._id === selected ? "bg-muted" : "hover:bg-muted/40"}`} onClick={() => setSelected(row._id)} aria-pressed={row._id === selected}><span className="font-medium">{row.leagueName} · {row.season}, week {row.week}</span><span className="mt-1 block text-xs text-muted-foreground">Received {new Date(row.recordedAt).toLocaleString()} · {row.timing === "before-listed-kickoffs" ? "Before listed comparison kickoffs" : "Not verified pre-kickoff"}</span></button></li>)}</ul>}
    {more && <Button variant="outline" onClick={loadMore} disabled={loading}>{loading ? "Loading…" : "Load more"}</Button>}
    {selected !== null && detail === null && !error && <p role="status">Loading saved inputs…</p>}
    {detail && <><DecisionRecordView detail={detail} /><Button variant="outline" onClick={observe} disabled={refreshing}>{refreshing ? "Checking observed results…" : "Check observed results"}</Button><p className="text-xs text-muted-foreground">Results remain pending until Sleeper moves past the week and independent schedule results are posted. Missing player scores remain missing. Checking again appends an observation; stat corrections never overwrite the original decision.</p></>}
  </div>;
}

export function DecisionRecordView({ detail }: { detail: DecisionDetail }) {
  let record: WeeklyDecisionRecord;
  let evaluation: WeeklyDecisionEvaluation | null = null;
  let outcomes: WeeklyDecisionOutcomes | null = null;
  try {
    record = JSON.parse(detail.recordJson) as WeeklyDecisionRecord;
    if (record.version !== 1 || !Array.isArray(record.snapshot.players) || !Array.isArray(record.plan.assignments)) throw new Error("Unsupported record");
    if (detail.observations[0]) {
      evaluation = JSON.parse(detail.observations[0].evaluationJson) as WeeklyDecisionEvaluation;
      outcomes = JSON.parse(detail.observations[0].outcomeJson) as WeeklyDecisionOutcomes;
    }
  } catch { return <p role="alert">This record format is unavailable. It has not been modified.</p>; }
  const names = new Map(record.snapshot.players.map(player => [player.id, player.name]));
  const excluded = new Set(record.plan.excludedSlotIds);
  return <section aria-label="Frozen decision" className="rounded-lg border p-4">
    <h2 className="font-semibold">{record.snapshot.leagueName} · week {record.snapshot.week}</h2>
    <p className="mt-1 text-xs text-muted-foreground">Server receipt {new Date(record.recordedAt).toLocaleString()} · User-supplied inputs</p>
    <p className="mt-3 text-sm">Saved expected-point difference: {record.plan.gain === null ? "Unavailable" : `${record.plan.gain >= 0 ? "+" : ""}${record.plan.gain.toFixed(2)}`} · included estimates only.</p>
    <div className="relative mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-2">Slot</th><th className="p-2">Original starter</th><th className="p-2">Saved advice</th></tr></thead><tbody>{record.snapshot.slots.map(slot => {
      const original = record.snapshot.players.find(player => player.currentSlotId === slot.id);
      const recommended = record.plan.assignments.find(assignment => assignment.slotId === slot.id)?.playerId;
      return <tr key={slot.id} className="border-t"><td className="p-2">{slot.label}{excluded.has(slot.id) ? " · Excluded" : ""}</td><td className="p-2">{original?.name ?? "Empty"}</td><td className="p-2">{recommended ? names.get(recommended) ?? "Unknown" : "Empty"}</td></tr>;
    })}</tbody></table></div>
    <div className="mt-4 text-sm" aria-live="polite">
      <h3 className="font-medium">Observed comparison</h3>
      {evaluation === null ? <p className="mt-1">Not checked yet.</p> : evaluation.status !== "complete" ? <p className="mt-1">{evaluation.status === "pending" ? "Pending" : "Not eligible for prospective evaluation"}: {evaluation.reason}</p> : <><p className="mt-1">Saved advice {evaluation.recommendedActualPoints?.toFixed(2)} · original starters {evaluation.originalActualPoints?.toFixed(2)} · difference {evaluation.actualDifference! >= 0 ? "+" : ""}{evaluation.actualDifference?.toFixed(2)} points.</p><p className="mt-1 text-xs text-muted-foreground">Included slots only. One observed comparison is not an established advantage.</p>{evaluation.forecastErrors.map(group => <p key={group.origin} className="mt-2 text-xs">{group.origin === "model" ? "Full-scoring model" : group.origin === "manual" ? "Manual" : "Unspecified source"} mean absolute forecast error: {group.meanAbsoluteError.toFixed(2)} points across {group.count} recorded forecasts.</p>)}{evaluation.unevaluatedForecastCount > 0 && <p className="mt-1 text-xs">{evaluation.unevaluatedForecastCount} forecasts excluded from accuracy: conditional, incomplete-scoring, late or missing outcomes.</p>}</>}
      {evaluation && evaluation.missingPlayerIds.length > 0 && <p className="mt-2 text-xs">Missing completion, kickoff or score evidence: {evaluation.missingPlayerIds.map(id => names.get(id) ?? id).join(", ")}.</p>}
      {outcomes && <p className="mt-3 text-xs text-muted-foreground">Observed {new Date(outcomes.fetchedAt).toLocaleString()}. {outcomes.source}.</p>}
    </div>
    <details className="mt-4 text-sm"><summary className="cursor-pointer">Frozen source, scoring and limitations</summary><p className="mt-2">{record.snapshot.source}</p><pre className="mt-2 whitespace-pre-wrap break-all text-xs">{record.snapshot.scoringId}</pre><ul className="mt-2 list-disc space-y-1 pl-5">{record.plan.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>
  </section>;
}
