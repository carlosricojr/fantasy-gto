"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { PageShell } from "@/components/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { planWeeklyLineup, type WeeklyLineupSnapshot } from "@/lib/nfl/weekly-lineup";
import { sleeperScoringFromId } from "@/lib/nfl/scoring/sleeper";
import { mergeWeeklyRefresh } from "@/lib/nfl/weekly-lineup-inputs";

const PROJECTION_MAX_AGE = 24 * 60 * 60 * 1000;
const ROSTER_MAX_AGE = 15 * 60 * 1000;

export default function WeeklyLineupPage() {
  const [leagueId, setLeagueId] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [week, setWeek] = useState("1");
  const [snapshot, setSnapshot] = useState<WeeklyLineupSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [holdUnpriced, setHoldUnpriced] = useState(false);
  const [compareAvailable, setCompareAvailable] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [publication, setPublication] = useState("");
  const [source, setSource] = useState("User-entered expected points");

  // Kickoff and freshness gates keep advancing while the page is open.
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, 1000);
    window.addEventListener("focus", tick);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", tick); };
  }, []);

  async function refresh(withEstimates = true) {
    const prior = snapshot;
    setBusy(true); setError(""); setSnapshot(null);
    try {
      const params = new URLSearchParams({ leagueId, ownerId, week });
      if (withEstimates) params.set("estimates", "nflverse");
      const response = await fetch(`/api/weekly-lineup?${params}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not import the roster.");
      const incoming = body as WeeklyLineupSnapshot;
      const merged = mergeWeeklyRefresh(prior, incoming);
      setSnapshot(merged.snapshot);
      if (!merged.sameContext) { setPublication(""); setCompareAvailable(false); setHoldUnpriced(false); }
      setNow(Date.now());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Import failed.");
      if (prior !== null) setSnapshot({ ...prior, refreshFailed: true });
    }
    finally { setBusy(false); }
  }

  const input = useMemo(() => snapshot === null ? null : {
    ...snapshot, source: snapshot.model ? `${snapshot.model.source}; manual overrides: ${source}` : source,
    projectionUpdatedAt: publication === "" ? null : Date.parse(publication),
  }, [snapshot, source, publication]);
  const plan = useMemo(() => input === null ? null : planWeeklyLineup(input, {
    now, maxProjectionAgeMs: PROJECTION_MAX_AGE, maxRosterAgeMs: ROSTER_MAX_AGE,
    holdUnpricedPositions: holdUnpriced ? ["K", "DST"] : [],
    compareAvailableEstimates: compareAvailable,
  }), [input, now, holdUnpriced, compareAvailable]);
  const profile = snapshot === null ? null : sleeperScoringFromId(snapshot.scoringId);
  const names = new Map(snapshot?.players.map((p) => [p.id, p.name]));

  return <PageShell title="Weekly lineup" subtitle="Your current starters, your league scoring, and kickoff locks.">
    <p className="mb-6 text-sm text-muted-foreground">Import your Sleeper roster and generate weekly skill-position estimates from nflverse history, or supply your own expected points. Automatic estimates can omit scoring terms and players; those gaps stay visible. This planner maximizes included estimates and cannot guarantee the highest actual score. It does not submit a lineup to Sleeper.</p>
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="text-sm">Sleeper league ID<Input value={leagueId} onChange={(e) => setLeagueId(e.target.value)} inputMode="numeric" /></label>
      <label className="text-sm">Sleeper user ID<Input value={ownerId} onChange={(e) => setOwnerId(e.target.value)} inputMode="numeric" /></label>
      <label className="text-sm">Current week<Input type="number" min={1} max={18} value={week} onChange={(e) => setWeek(e.target.value)} /></label>
    </div>
    <div className="mt-3 flex flex-wrap gap-2"><Button onClick={() => refresh(true)} disabled={busy || !leagueId || !ownerId}>{busy ? "Importing and calculating…" : snapshot ? "Refresh roster and model estimates" : "Import roster and generate estimates"}</Button><Button variant="outline" onClick={() => refresh(false)} disabled={busy || !leagueId || !ownerId}>Import roster only</Button></div>
    <p className="mt-2 text-xs text-muted-foreground">Reads public league data from Sleeper and statistics, rosters, injuries and schedule from nflverse. No Sleeper projection download. Manual overrides survive a refresh only for the same league, team, week and scoring rules.</p>
    {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
    {snapshot && <div className="mt-8 space-y-6">
      <div>
        <h2 className="font-semibold">{snapshot.leagueName} · {snapshot.season}, week {snapshot.week}</h2>
        <p className="text-xs text-muted-foreground">Roster retrieved {new Date(snapshot.rosterRetrievedAt).toLocaleString()}. Refresh after 15 minutes or a roster change.</p>
        <details className="mt-3 text-sm"><summary className="cursor-pointer">Exact league scoring coefficients</summary><div className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-3">{Object.entries(profile?.coefficients ?? {}).map(([key, points]) => <span key={key}>{key}: {points}</span>)}</div></details>
      </div>
      {snapshot.model && <div className="rounded-lg border p-4 text-sm">
        <h2 className="font-semibold">{snapshot.model.source}</h2>
        <p className="mt-1">Generated {snapshot.model.coverage.projected} of {snapshot.model.coverage.requested} player estimates at {new Date(snapshot.model.computedAt).toLocaleString()}. Source publication time is unknown.</p>
        <p className="mt-1">Currently using {snapshot.players.filter((p) => p.projectionOrigin === "model" && p.projectedPoints !== null).length} model estimates. Typing a value makes that row a manual override.</p>
        {snapshot.model.excludedRules.length > 0 && <p className="mt-2 text-amber-700 dark:text-amber-300">Incomplete league scoring: automatic estimates omit {snapshot.model.excludedRules.join(", ")}. These are not full custom-scoring projections.</p>}
      </div>}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">Manual projection source<Input value={source} onChange={(e) => setSource(e.target.value)} /></label>
        <label className="text-sm">Manual source publication time, if known<Input type="datetime-local" value={publication} onChange={(e) => setPublication(e.target.value)} /><span className="text-xs text-muted-foreground">Your local time. Leave blank if unknown. This does not date the automatic model’s source.</span></label>
      </div>
      <p className="text-sm text-muted-foreground">Enter this week’s expected points under the exact rules above. Blank means missing. Zero means an actual zero-point estimate. Season totals and historical averages are not weekly projections.</p>
      <div className="relative overflow-x-auto rounded-lg border"><table className="w-full text-left text-sm"><thead className="border-b bg-muted/40"><tr><th className="p-3">Player / current slot</th><th className="p-3">Status / kickoff</th><th className="p-3">Expected points</th></tr></thead><tbody>{snapshot.players.map((player) => <tr key={player.id} className="border-b last:border-0">
        <td className="p-3">{player.name}<div className="text-xs text-muted-foreground">{player.positions.join("/")} · {snapshot.slots.find((s) => s.id === player.currentSlotId)?.label ?? "Bench"}</div></td>
        <td className="p-3">{player.availability}<div className="text-xs text-muted-foreground">{player.kickoffAt === null ? "No verified kickoff" : `${new Date(player.kickoffAt).toLocaleString()}${player.kickoffAt <= now ? " · Locked" : ""}`}</div></td>
        <td className="p-3"><Input className="min-w-24" type="number" step="0.01" aria-label={`Expected points for ${player.name}`} value={player.projectedPoints ?? ""} onChange={(e) => {
          const value = e.target.value;
          const enteredAt = Date.now();
          setNow(enteredAt);
          setSnapshot((old) => old === null ? null : { ...old, players: old.players.map((p) => p.id === player.id ? { ...p, projectedPoints: value === "" ? null : Number(value), projectionOrigin: "manual", projectionMissingReason: null, projectionEnteredAt: enteredAt } : p) });
        }} /><div className="mt-1 max-w-56 text-xs text-muted-foreground">{player.projectedPoints === null ? player.projectionMissingReason ?? (player.projectionOrigin === "manual" ? "Manual override cleared" : "No estimate supplied") : player.projectionOrigin === "manual" ? "Manual override" : "Model estimate · see source limits"}</div></td>
      </tr>)}</tbody></table></div>
      <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={holdUnpriced} onChange={(e) => setHoldUnpriced(e.target.checked)} />Hold unpriced K and D/ST in their current slots; compare only the other positions.</label>
      <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={compareAvailable} onChange={(e) => setCompareAvailable(e.target.checked)} />Compare incomplete estimates. Keep every unpriced player in their current place, and exclude their values and omitted scoring terms from the comparison. I will verify final active lists where injury-report coverage is missing.</label>
      {plan && <section aria-live="polite" className="rounded-lg border p-4">
        <h2 className="font-semibold">{plan.status === "blocked" ? "Inputs needed before a recommendation" : plan.status === "conditional" ? "Conditional lineup comparison" : "Highest expected-points lineup"}</h2>
        {plan.problems.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{plan.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        {plan.warnings.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-700 dark:text-amber-300">{plan.warnings.map((p) => <li key={p}>{p}</li>)}</ul>}
        {plan.status !== "blocked" && <>
          <p className="mt-4 text-sm">{compareAvailable || plan.excludedSlotIds.length ? "Included estimates only" : "Projected lineup"}: {plan.projectedPoints?.toFixed(2)} points{plan.gain === null ? "" : ` · ${plan.gain >= 0 ? "+" : ""}${plan.gain.toFixed(2)} vs included current starters`}. Estimates are rounded to cents for assignment.</p>
          <div className="mt-3 space-y-2">{plan.assignments.map((a) => <div key={a.slotId} className="flex justify-between gap-3 text-sm"><span>{snapshot.slots.find((s) => s.id === a.slotId)?.label}: {a.playerId === null ? "Empty" : names.get(a.playerId)}{a.fixed ? " · Fixed" : ""}</span><span>{a.points === null ? "Not valued" : a.points.toFixed(2)}</span></div>)}</div>
          <p className="mt-4 text-xs text-muted-foreground">Equal-point choices put later games in flexible slots when possible. Check final injury designations and make any changes in Sleeper before kickoff.</p>
        </>}
      </section>}
    </div>}
    <Link href="/lineup" className="mt-8 inline-block text-sm underline">Manual preset optimizer</Link>
  </PageShell>;
}
