"use client";

import Link from "next/link";
import { SignInButton } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { PageShell } from "@/components/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WAIVER_CANDIDATE_LIMIT, WAIVER_ROSTER_MAX_AGE_MS, type WaiverComparison } from "@/lib/nfl/waiver-planner";
import { selectWeeklyConditionalEstimates } from "@/lib/nfl/weekly-lineup-inputs";
import { sleeperScoringFromId } from "@/lib/nfl/scoring/sleeper";
import type { WaiverImport } from "@/lib/sources/sleeper-waivers";

export default function WaiversPage() {
  const [leagueId, setLeagueId] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [week, setWeek] = useState("1");
  const [pool, setPool] = useState<WaiverImport | null>(null);
  const [comparisonData, setComparisonData] = useState<WaiverImport | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [includeConditional, setIncludeConditional] = useState(false);
  const [compareAvailable, setCompareAvailable] = useState(false);
  const [evaluatedAt, setEvaluatedAt] = useState(0);
  const [now, setNow] = useState(0);
  const [calculation, setCalculation] = useState<{ data: WaiverImport; evaluatedAt: number; includeConditional: boolean; compareAvailable: boolean; result?: WaiverComparison; error?: string } | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (/^\d{1,30}$/.test(params.get("leagueId") ?? "")) setLeagueId(params.get("leagueId")!);
    if (/^\d{1,30}$/.test(params.get("ownerId") ?? "")) setOwnerId(params.get("ownerId")!);
    if (/^(?:[1-9]|1[0-8])$/.test(params.get("week") ?? "")) setWeek(params.get("week")!);
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 1000);
    window.addEventListener("focus", tick);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", tick); };
  }, []);
  function clearContext() { setPool(null); setComparisonData(null); setSelected([]); setError(""); }
  async function refresh(compare: boolean) {
    setBusy(true); setError(""); setComparisonData(null);
    if (!compare) { setPool(null); setSelected([]); }
    try {
      const params = new URLSearchParams({ leagueId, ownerId, week });
      if (compare) params.set("candidates", selected.join(","));
      if (compare && includeConditional) params.set("conditional", "active-at-kickoff");
      const response = await fetch(`/api/waivers?${params}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not import the league pool.");
      const incoming = data as WaiverImport;
      if (incoming.roster.leagueId !== leagueId || incoming.roster.ownerId !== ownerId || incoming.roster.week !== Number(week)) throw new Error("Response does not match the requested league, manager and week.");
      setPool(incoming);
      if (compare) { setComparisonData(incoming); setEvaluatedAt(Date.now()); }
      setNow(Date.now());
    } catch (cause) {
      setPool(null); setSelected([]);
      setError(cause instanceof Error ? cause.message : "Import failed. Refresh before comparing.");
    } finally { setBusy(false); }
  }
  useEffect(() => {
    if (comparisonData === null) return;
    const context = { data: comparisonData, evaluatedAt, includeConditional, compareAvailable };
    let worker: Worker;
    try { worker = new Worker(new URL("./compare.worker.ts", import.meta.url)); }
    catch { setCalculation({ ...context, error: "Background comparison is unavailable in this browser." }); return; }
    const combined = selectWeeklyConditionalEstimates({ ...comparisonData.roster, players: [...comparisonData.roster.players, ...comparisonData.candidates] }, includeConditional, evaluatedAt);
    const own = new Set(comparisonData.ownership.ownPlayerIds);
    const timer = window.setTimeout(() => { worker.terminate(); setCalculation({ ...context, error: "Comparison exceeded the 15-second calculation budget. Select fewer candidates and compare again." }); }, 15000);
    worker.onmessage = (event: MessageEvent<{ result?: WaiverComparison; error?: string }>) => { window.clearTimeout(timer); setCalculation({ ...context, ...event.data }); worker.terminate(); };
    worker.onerror = () => { window.clearTimeout(timer); setCalculation({ ...context, error: "Background comparison failed. Refresh before deciding." }); worker.terminate(); };
    worker.postMessage({ input: { ...comparisonData, roster: { ...combined, players: combined.players.filter((p) => own.has(p.id)) }, candidates: combined.players.filter((p) => !own.has(p.id)) }, options: { now: evaluatedAt, compareAvailableEstimates: compareAvailable, allowConditionalEstimates: includeConditional } });
    return () => { window.clearTimeout(timer); worker.terminate(); };
  }, [comparisonData, evaluatedAt, compareAvailable, includeConditional]);
  const currentCalculation = calculation?.data === comparisonData && calculation?.evaluatedAt === evaluatedAt && calculation?.includeConditional === includeConditional && calculation?.compareAvailable === compareAvailable ? calculation : null;
  const comparison = currentCalculation?.result ?? null;
  // Advancing the clock invalidates, rather than expensively re-solving all pairs each second.
  const expiresAt = comparisonData === null ? 0 : Math.min(comparisonData.ownership.retrievedAt + WAIVER_ROSTER_MAX_AGE_MS,
    ...[...comparisonData.roster.players, ...comparisonData.candidates].flatMap((p) => p.kickoffAt !== null && p.kickoffAt > evaluatedAt ? [p.kickoffAt] : []));
  const expired = comparisonData !== null && now >= expiresAt;
  const visible = pool?.availablePlayers.filter((p) => `${p.name} ${p.positions.join(" ")} ${p.id}`.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  const names = new Map([...(pool?.roster.players ?? []), ...(pool?.availablePlayers ?? [])].map((p) => [p.id, p.name]));
  const profile = pool === null ? null : sleeperScoringFromId(pool.roster.scoringId);
  const weeklyHref = pool === null ? "/lineup/weekly" : `/lineup/weekly?${new URLSearchParams({ leagueId: pool.roster.leagueId, ownerId: pool.roster.ownerId, week: String(pool.roster.week) })}`;

  return <PageShell title="Waiver comparison" subtitle="One week. One addition and one drop. No transactions submitted.">
    <p className="mb-5 text-sm text-muted-foreground">Choose up to 12 unrostered players to compare against your current roster’s best projected lineup. The result measures included lineup points, not the player’s raw projection, season-long value, or a guarantee of improvement. It does not calculate bids or waiver priority.</p>
    <p className="mb-4 text-sm">Sign-in and waiver-comparison access are required. <SignInButton mode="modal"><button className="underline">Sign in</button></SignInButton> · <Link className="underline" href="/pricing">Plan details</Link>. FAAB remains unimplemented.</p>
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="text-sm">Sleeper league ID<Input value={leagueId} disabled={busy} inputMode="numeric" onChange={(e) => { clearContext(); setLeagueId(e.target.value); }} /></label>
      <label className="text-sm">Sleeper user ID<Input value={ownerId} disabled={busy} inputMode="numeric" onChange={(e) => { clearContext(); setOwnerId(e.target.value); }} /></label>
      <label className="text-sm">Current week<Input value={week} disabled={busy} type="number" min={1} max={18} onChange={(e) => { clearContext(); setWeek(e.target.value); }} /></label>
    </div>
    <Button className="mt-3" disabled={busy || !leagueId || !ownerId} onClick={() => refresh(false)}>{busy ? "Loading…" : "Load verified league pool"}</Button>
    <p className="mt-2 text-xs text-muted-foreground">Personal, read-only use of documented Sleeper league/player data and <a className="underline" href="https://github.com/nflverse/nflverse-data">nflverse data (CC BY 4.0)</a>. No Sleeper projection download. No paid data or billing changes.</p>
    {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
    {pool && <div className="mt-6 space-y-5">
      <section className="rounded-lg border p-4 text-sm">
        <h2 className="font-semibold">{pool.roster.leagueName} · {pool.roster.season}, week {pool.roster.week}</h2>
        <p className="mt-1">All {pool.ownership.rosterCount} rosters checked at {new Date(pool.ownership.retrievedAt).toLocaleString()}. Every rostered, reserve and taxi holding is excluded.</p>
        <p className="mt-1 text-muted-foreground">{pool.availableCount} unrostered directory candidates; {pool.directoryExcludedCount} other unrostered directory entries are malformed, unavailable or ineligible. Directory designations can be cached for a day. Unrostered does not mean immediately claimable: verify waiver clearance, roster restrictions, final active lists and your intended drop in Sleeper.</p>
        <details className="mt-3"><summary className="cursor-pointer">Exact league scoring coefficients</summary><p className="mt-2">{Object.entries(profile?.coefficients ?? {}).map(([key, value]) => `${key}: ${value}`).join(" · ")}</p></details>
      </section>
      <section>
        <h2 className="font-semibold">Select candidates · {selected.length}/{WAIVER_CANDIDATE_LIMIT}</h2>
        <label className="mt-2 block text-sm">Search unrostered names, positions or IDs<Input value={query} onChange={(e) => setQuery(e.target.value)} /></label>
        <p className="mt-1 text-xs text-muted-foreground">Alphabetical search, not an ADP or value ranking. Showing {Math.min(visible.length, 50)} of {visible.length} matching names; refine the search for others.</p>
        <div className="relative mt-3 grid max-h-72 gap-2 overflow-y-auto rounded-lg border p-3 sm:grid-cols-2">{visible.slice(0, 50).map((p) => <label key={p.id} className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={selected.includes(p.id)} disabled={busy || (!selected.includes(p.id) && selected.length >= WAIVER_CANDIDATE_LIMIT)} onChange={(e) => { setComparisonData(null); setSelected(e.target.checked ? [...selected, p.id] : selected.filter((id) => id !== p.id)); }} /><span>{p.name} · {p.positions.join("/")}<span className="block text-xs text-muted-foreground">Directory: {p.availability} · ID {p.id}</span></span></label>)}</div>
        {selected.length > 0 && <p className="mt-2 text-sm">Selected: {selected.map((id) => names.get(id)).join(", ")}. <button className="underline" disabled={busy} onClick={() => { setSelected([]); setComparisonData(null); }}>Clear selection</button></p>}
      </section>
      <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={includeConditional} disabled={busy} onChange={(e) => setIncludeConditional(e.target.checked)} />Generate provisional forecasts assuming active at kickoff when team injury reports are missing. These are not availability-adjusted expected points. Compare again after enabling; disabling removes them immediately.</label>
      <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={compareAvailable} disabled={busy} onChange={(e) => setCompareAvailable(e.target.checked)} />Compare incomplete estimates explicitly. Hold unpriced rostered players in place and never drop them; exclude their values and missing scoring terms. Unknown values could reverse the full-roster decision. I will verify final active lists.</label>
      <Button disabled={busy || selected.length === 0} onClick={() => refresh(true)}>{busy ? "Refreshing ownership and estimates…" : "Refresh and compare selected candidates"}</Button>
      <p className="text-xs text-muted-foreground">At most 12 candidates × 24 rostered players, with up to 10 starting slots. One combined projection request; missing values remain unknown. Compare again after any league transaction.</p>
      {comparisonData && !currentCalculation && <p role="status" className="text-sm">Comparing included lineups in the background…</p>}
      {currentCalculation?.error && <p role="alert" className="text-sm text-destructive">{currentCalculation.error}</p>}
      {comparison && <section aria-live="polite" className="rounded-lg border p-4 text-sm">
        <h2 className="font-semibold">{expired ? "Comparison expired — refresh before deciding" : comparison.status === "blocked" ? "Inputs needed before comparison" : comparison.status === "unknown" ? "No comparable add/drop pairs — improvement unknown" : comparison.status === "no-improvement" ? "No positive included-lineup gain among compared pairs" : "Positive included-lineup gain among compared pairs"}</h2>
        {!expired && <>
          {comparison.problems.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5">{comparison.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">{comparison.warnings.map((p, i) => <li key={i}>{p}</li>)}</ul>
          {comparison.baseline?.projectedPoints !== null && comparison.baseline?.projectedPoints !== undefined && <p className="mt-4">Keep your roster and optimize the included lineup: {comparison.baseline.projectedPoints.toFixed(2)} points. This is the no-transaction baseline (0.00 marginal points), not your current starter arrangement.</p>}
          <p className="mt-2">{comparison.coverage.evaluatedPairs} pairs compared; {comparison.coverage.unknownPairs} pairs unknown. {comparison.coverage.eligibleAdds} of {comparison.coverage.selected} selected additions usable; {comparison.coverage.eligibleDrops} drops considered.</p>
          {comparison.choices.length > 0 && <div className="mt-4 space-y-3">{comparison.choices.slice(0, 20).map((choice) => <details key={`${choice.addId}/${choice.dropId}`} className="rounded border p-3"><summary className="cursor-pointer">Add {names.get(choice.addId)} / drop {names.get(choice.dropId)}: {choice.marginalPoints >= 0 ? "+" : ""}{choice.marginalPoints.toFixed(2)} included points</summary><p className="mt-2">Reoptimized included lineup: {choice.lineup.projectedPoints?.toFixed(2)}. Future value of the dropped player is not assessed. Equal one-week gains do not make drops equivalent over the season.</p><ul className="mt-2 space-y-1">{choice.lineup.assignments.map((a) => <li key={a.slotId}>{pool.roster.slots.find((s) => s.id === a.slotId)?.label}: {a.playerId === null ? "Empty" : names.get(a.playerId)}{a.fixed ? " · Fixed" : ""} · {a.points === null ? "Not valued" : a.points.toFixed(2)}</li>)}</ul><ul className="mt-2 list-disc pl-5 text-muted-foreground">{choice.lineup.warnings.filter((w) => !comparison.warnings.includes(w)).map((w, i) => <li key={i}>{w}</li>)}</ul></details>)}</div>}
          {comparison.choices.length > 20 && <p className="mt-2 text-xs">Showing the first 20 of {comparison.choices.length} compared pairs, sorted by included gain, then player ID for ties.</p>}
          {comparison.excluded.length > 0 && <details className="mt-4"><summary className="cursor-pointer">Excluded additions and drops</summary><ul className="mt-2 space-y-1">{comparison.excluded.map((p) => <li key={`${p.role}/${p.playerId}`}>{p.role === "add" ? "Add" : "Drop"} {names.get(p.playerId)}: {p.reason}</li>)}</ul></details>}
          {comparisonData?.roster.model && <p className="mt-4 text-xs text-muted-foreground">{comparisonData.roster.model.source}; {comparisonData.roster.model.coverage.projected}/{comparisonData.roster.model.coverage.requested} ordinary estimates across your roster and selected candidates. Calculated {new Date(comparisonData.roster.model.computedAt).toLocaleString()}; provider publication time unknown. PPR calibration does not validate custom scoring or conditional forecasts.</p>}
        </>}
      </section>}
    </div>}
    <Link href={weeklyHref} className="mt-8 inline-block text-sm underline">Weekly lineup planner</Link>
  </PageShell>;
}
