"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useUser } from "@clerk/nextjs";
import { api } from "@/convex/_generated/api";
import { can } from "@/lib/billing/entitlements";
import { WeeklyDecisionSave } from "@/components/weekly-decision-save";
import { PageShell } from "@/components/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { planWeeklyLineup, type WeeklyLineupSnapshot } from "@/lib/nfl/weekly-lineup";
import { sleeperScoringFromId } from "@/lib/nfl/scoring/sleeper";
import { mergeWeeklyRefresh, selectWeeklyConditionalEstimates, selectWeeklyExperimentalEstimates } from "@/lib/nfl/weekly-lineup-inputs";
import { SleeperConnectionFinder } from "@/components/sleeper-connection-finder";
import { weeklyLineupPrefill } from "@/lib/nfl/sleeper-connection";
import { MANUAL_ESTIMATE_MAX_AGE, WEEKLY_MANUAL_STORAGE_KEY, parseWeeklyManual, restoreWeeklyManual, saveWeeklyManual, updateWeeklyManualStore } from "@/lib/nfl/weekly-lineup-storage";
import { groupWeeklyNotices, weeklyKickoffChecks, weeklyLineupActions } from "@/lib/nfl/weekly-lineup-presentation";
import { analyzeWeeklyLineupStability, type WeeklyStressPoints } from "@/lib/nfl/weekly-lineup-stability";
import { WeeklyStabilityPanel } from "./stability-panel";
import { WeeklyExperimentalNote } from "./experimental-estimate-note";

const PROJECTION_MAX_AGE = MANUAL_ESTIMATE_MAX_AGE;
const ROSTER_MAX_AGE = 15 * 60 * 1000;

export default function WeeklyLineupPage() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { user } = useUser();
  const scope = isLoading || (isAuthenticated && !user?.id) ? null : user?.id ?? "anonymous";
  // Remount synchronously, before children render under a different account.
  // A passive state reset can expose the prior snapshot to the new account's Save.
  return <ScopedWeeklyLineup key={scope ?? "auth-pending"} storageScope={scope} />;
}

function ScopedWeeklyLineup({ storageScope }: { storageScope: string | null }) {
  const { isLoading: authLoading, isAuthenticated } = useConvexAuth();
  const { user } = useUser();
  const me = useQuery(api.users.me, {});
  const saveDecision = useMutation(api.decisionJournal.create);
  const storageKey = `${WEEKLY_MANUAL_STORAGE_KEY}:${storageScope}`;
  const mounted = useRef(true);
  const [leagueId, setLeagueId] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [week, setWeek] = useState("");
  const [snapshot, setSnapshot] = useState<WeeklyLineupSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [holdUnpriced, setHoldUnpriced] = useState(false);
  const [compareAvailable, setCompareAvailable] = useState(false);
  const [includeConditional, setIncludeConditional] = useState(false);
  const [includeExperimental, setIncludeExperimental] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [publication, setPublication] = useState("");
  const [source, setSource] = useState("User-entered expected points");
  const [storageMessage, setStorageMessage] = useState("");
  const [checkedGames, setCheckedGames] = useState<string[]>([]);
  const [stressPoints, setStressPoints] = useState<WeeklyStressPoints>(1);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const prefill = weeklyLineupPrefill(window.location.search);
    setLeagueId(prefill.leagueId); setOwnerId(prefill.ownerId);
    if (prefill.week) setWeek(prefill.week);
  }, []);

  useEffect(() => {
    if (!snapshot || snapshot.refreshFailed || storageScope === null) return;
    try {
      const entry = saveWeeklyManual(snapshot, source, publication, Date.now());
      window.localStorage.setItem(storageKey, JSON.stringify(updateWeeklyManualStore(parseWeeklyManual(window.localStorage.getItem(storageKey)), entry)));
    } catch { setStorageMessage("Browser storage is unavailable. Entries remain only in this open page."); }
  }, [snapshot, source, publication, storageKey, storageScope]);

  // Kickoff and freshness gates keep advancing while the page is open.
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, 1000);
    window.addEventListener("focus", tick);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", tick); };
  }, []);

  async function refresh(withEstimates = true) {
    if (authLoading || !isAuthenticated) { setError("Sign in to import league data. Free includes roster-only imports; model estimates require Pro."); return; }
    const prior = snapshot;
    setBusy(true); setError(""); setSnapshot(null);
    try {
      let selectedWeek = week;
      if (!selectedWeek) {
        const lookup = await fetch("/api/sleeper-connections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: ownerId, leagueInput: leagueId }), cache: "no-store" });
        const lookupBody = await lookup.json();
        if (!mounted.current) return;
        if (!lookup.ok) throw new Error(lookupBody.error ?? "Could not resolve the current week.");
        selectedWeek = String(lookupBody.week); setWeek(selectedWeek);
      }
      const params = new URLSearchParams({ leagueId, ownerId, week: selectedWeek });
      if (withEstimates) params.set("estimates", "nflverse");
      if (withEstimates && includeConditional) params.set("conditional", "active-at-kickoff");
      if (withEstimates && includeExperimental) params.set("experimental", "coverage-baselines");
      const response = await fetch(`/api/weekly-lineup?${params}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not import the roster.");
      if (!mounted.current) return;
      const incoming = body as WeeklyLineupSnapshot;
      // A successful roster response can still report failed model generation.
      if (withEstimates && !incoming.model) setIncludeExperimental(false);
      const merged = mergeWeeklyRefresh(prior, incoming);
      let next = merged.snapshot;
      if (!merged.sameContext) {
        setPublication(""); setSource("User-entered expected points"); setCompareAvailable(false); setHoldUnpriced(false);
        // Honor deliberate consent before the first import, but not a newly
        // returned season/scoring context on an existing imported roster.
        if (prior !== null) setIncludeExperimental(false);
        if (storageScope === null) setStorageMessage("Browser identity is not ready. Entries stay only in this open page and private saving is unavailable.");
        else try {
          const restored = restoreWeeklyManual(next, parseWeeklyManual(window.localStorage.getItem(storageKey)), Date.now());
          next = restored.snapshot;
          if (restored.source !== undefined) setSource(restored.source);
          if (restored.publication !== undefined) setPublication(restored.publication);
          setStorageMessage(`${restored.restored} saved manual entries restored with original timestamps.${restored.discarded ? ` ${restored.discarded} expired, departed or changed-matchup entries discarded.` : ""}`);
        } catch { setStorageMessage("Browser storage is unavailable. Entries remain only in this open page."); }
      }
      setSnapshot(next); setCheckedGames([]);
      setNow(Date.now());
    } catch (cause) {
      if (!mounted.current) return;
      setIncludeExperimental(false);
      setError(cause instanceof Error ? cause.message : "Import failed.");
      if (prior !== null) setSnapshot({ ...prior, refreshFailed: true });
    }
    finally { if (mounted.current) setBusy(false); }
  }

  const input = useMemo(() => snapshot === null ? null : {
    ...selectWeeklyExperimentalEstimates(selectWeeklyConditionalEstimates(snapshot, includeConditional, now), includeExperimental, now), source: snapshot.model ? `${snapshot.model.source}; manual overrides: ${source}` : source,
    projectionUpdatedAt: publication === "" ? null : Date.parse(publication),
  }, [snapshot, source, publication, includeConditional, includeExperimental, now]);
  const plan = useMemo(() => input === null ? null : planWeeklyLineup(input, {
    now, maxProjectionAgeMs: PROJECTION_MAX_AGE, maxRosterAgeMs: ROSTER_MAX_AGE,
    holdUnpricedPositions: holdUnpriced ? ["K", "DST"] : [],
    compareAvailableEstimates: compareAvailable,
    allowConditionalEstimates: includeConditional,
    allowExperimentalEstimates: includeExperimental,
  }), [input, now, holdUnpriced, compareAvailable, includeConditional, includeExperimental]);
  const profile = snapshot === null ? null : sleeperScoringFromId(snapshot.scoringId);
  const names = new Map(snapshot?.players.map((p) => [p.id, p.name]));
  const actions = input && plan ? weeklyLineupActions(input, plan) : [];
  const starterActions = actions.filter((action) => action.kind !== "slot");
  const stability = useMemo(() => analyzeWeeklyLineupStability(input, plan, stressPoints), [input, plan, stressPoints]);

  return <PageShell title="Weekly lineup" subtitle="Your current starters, your league scoring, and kickoff locks.">
    <p className="mb-6 text-sm text-muted-foreground">Import your Sleeper roster and generate weekly skill-position estimates from nflverse history, or supply your own expected points. Automatic estimates can omit scoring terms and players; those gaps stay visible. This planner maximizes included estimates and cannot guarantee the highest actual score. It does not submit a lineup to Sleeper.</p>
    <p className="mb-4 text-sm text-muted-foreground">Source requests are rate limited. Free includes roster-only import and league lookup; Pro adds model estimates, waiver comparisons and private decision history. Static and local tools remain public.{!isAuthenticated && <> <Link href="/sign-in" className="underline">Sign in</Link> to request league data.</>}</p>
    <fieldset disabled={busy} className="mb-5"><SleeperConnectionFinder onSelect={(connection, currentWeek) => { setLeagueId(connection.leagueId); setOwnerId(connection.ownerId); setWeek(String(currentWeek)); setSnapshot(null); setCompareAvailable(false); setHoldUnpriced(false); setIncludeExperimental(false); setCheckedGames([]); setError(""); }} /></fieldset>
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="text-sm">Sleeper league ID<Input value={leagueId} disabled={busy} onChange={(e) => { setLeagueId(e.target.value); setSnapshot(null); setIncludeExperimental(false); }} inputMode="numeric" /></label>
      <label className="text-sm">Sleeper user ID<Input value={ownerId} disabled={busy} onChange={(e) => { setOwnerId(e.target.value); setSnapshot(null); setIncludeExperimental(false); }} inputMode="numeric" /></label>
      <label className="text-sm">Current week<Input type="number" min={1} max={18} value={week} disabled={busy} placeholder="Current Sleeper week" onChange={(e) => { setWeek(e.target.value); setSnapshot(null); setIncludeExperimental(false); }} /></label>
    </div>
    <label className="mt-3 flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={includeConditional} onChange={(e) => setIncludeConditional(e.target.checked)} />Generate provisional forecasts assuming players are active at kickoff when their team injury report is missing. These are not availability-adjusted expected points. Refresh after enabling; disable to remove them immediately.</label>
    <label className="mt-3 flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={includeExperimental} onChange={(e) => setIncludeExperimental(e.target.checked)} />Include experimental week-one coverage baselines for eligible returning players and kickers. These assume active at kickoff, are not validated or availability-adjusted forecasts, and can omit scoring terms. This is independent of provisional forecasts. Refresh after enabling; disable to remove them immediately.</label>
    <div className="mt-3 flex flex-wrap gap-2"><Button onClick={() => refresh(true)} disabled={busy || !leagueId || !ownerId}>{busy ? "Importing and calculating…" : snapshot ? "Refresh roster and model estimates" : "Import roster and generate estimates"}</Button><Button variant="outline" onClick={() => refresh(false)} disabled={busy || !leagueId || !ownerId}>Import roster only</Button></div>
    <p className="mt-2 text-xs text-muted-foreground">Reads public league data from Sleeper and statistics, rosters, injuries and schedule from nflverse. No Sleeper projection download. Manual entries are saved in this browser for up to 24 hours under the same league, owner, season, week, exact scoring and matchup. Reloading still requires a fresh import; dates and consent never refresh automatically.</p>
    {storageMessage && <p className="mt-2 text-xs text-muted-foreground" role="status">{storageMessage}</p>}
    {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
    {snapshot && <div className="mt-8 space-y-6">
      <div>
        <h2 className="font-semibold">{snapshot.leagueName} · {snapshot.season}, week {snapshot.week}</h2>
        <p className="text-xs text-muted-foreground">Roster retrieved {new Date(snapshot.rosterRetrievedAt).toLocaleString()}. Refresh after 15 minutes or a roster change.</p>
        <details className="mt-3 text-sm"><summary className="cursor-pointer">Exact league scoring coefficients</summary><div className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-3">{Object.entries(profile?.coefficients ?? {}).map(([key, points]) => <span key={key}>{key}: {points}</span>)}</div></details>
      </div>
      {plan && <section className="rounded-lg border p-4" aria-live="polite">
        <h2 className="font-semibold">{plan.status === "blocked" ? "Next: resolve the input checks below" : starterActions.length ? `${starterActions.length} start/bench actions to review` : actions.length ? "Keep your current starters; review slot flexibility" : "Keep your current starters"}</h2>
        {plan.status !== "blocked" && <><p className="mt-1 text-sm">{plan.gain === null ? "Scoped comparison" : `${plan.gain >= 0 ? "+" : ""}${plan.gain.toFixed(2)} included-estimate points`} · {plan.status === "conditional" ? "conditional on the disclosed inputs" : "under supplied estimates"}. Make any changes yourself in Sleeper.</p><ul className="mt-3 space-y-2">{actions.map((action) => <li key={action.playerId} className="text-sm"><span className="font-medium">{action.text}</span><p className="text-xs text-muted-foreground">{action.reason}</p></li>)}</ul></>}
        {groupWeeklyNotices(plan.problems).map((group) => <details key={group.title} className="mt-3 text-sm"><summary className="cursor-pointer font-medium">{group.title} · {group.messages.length} checks</summary><p className="mt-1 text-xs text-muted-foreground">{group.messages[0]}</p><ul className="mt-2 list-disc space-y-1 pl-5">{group.messages.slice(1).map((message) => <li key={message}>{message}</li>)}</ul></details>)}
      </section>}
      {plan && plan.status !== "blocked" && <WeeklyStabilityPanel analysis={stability} stressPoints={stressPoints} onStressChange={setStressPoints} hasExperimentalInputs={input?.players.some((p) => p.projectionOrigin === "experimental" && p.projectedPoints !== null)} />}
      {snapshot.model && <div className="rounded-lg border p-4 text-sm">
        <h2 className="font-semibold">{snapshot.model.source}</h2>
        <p className="mt-1">Generated {snapshot.model.coverage.projected} ordinary estimates for {snapshot.model.coverage.requested} rostered players at {new Date(snapshot.model.computedAt).toLocaleString()}. Source publication time is unknown.</p>
        <p className="mt-1">Currently using {snapshot.players.filter((p) => p.projectionOrigin === "model" && p.projectedPoints !== null).length} model estimates. Typing a value makes that row a manual override.</p>
        <p className="mt-1">{input?.players.filter((p) => p.projectionOrigin === "model-conditional").length ?? 0} additional provisional forecasts selected, assuming active at kickoff. Ordinary coverage above excludes them.</p>
        <p className="mt-1">{input?.players.filter((p) => p.projectionOrigin === "experimental" && p.projectedPoints !== null).length ?? 0} experimental baselines selected. Ordinary coverage and ordinary-model accuracy exclude these; exploratory evidence does not validate their use for this week.</p>
        {snapshot.model.excludedRules.length > 0 && <p className="mt-2 text-amber-700 dark:text-amber-300">Incomplete league scoring: automatic estimates omit {snapshot.model.excludedRules.join(", ")}. These are not full custom-scoring projections.</p>}
      </div>}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">Manual projection source<Input value={source} onChange={(e) => setSource(e.target.value)} /></label>
        <label className="text-sm">Manual source publication time, if known<Input type="datetime-local" value={publication} onChange={(e) => setPublication(e.target.value)} /><span className="text-xs text-muted-foreground">Your local time. Leave blank if unknown. This does not date the automatic model’s source.</span></label>
      </div>
      <p className="text-sm text-muted-foreground">Enter this week’s expected points under the exact rules above. Blank means missing. Zero means an actual zero-point estimate. Season totals and historical averages are not weekly expected-point projections; opt-in experimental rows are explicitly labelled baselines, not validated forecasts.</p>
      <Button size="sm" variant="outline" disabled={storageScope === null} onClick={() => {
        try { window.localStorage.removeItem(storageKey); setStorageMessage("Saved manual entries removed from this browser session's storage. Current open-page entries are unchanged until edited or refreshed."); } catch { setStorageMessage("Could not clear browser storage."); }
      }}>Clear saved browser entries</Button>
      <div className="relative overflow-x-auto rounded-lg border"><table className="w-full text-left text-sm"><thead className="border-b bg-muted/40"><tr><th className="p-3">Player / current slot</th><th className="p-3">Status / kickoff</th><th className="p-3">Supplied points / provenance</th></tr></thead><tbody>{(input?.players ?? snapshot.players).map((player) => <tr key={player.id} className="border-b last:border-0">
        <td className="p-3">{player.name}<div className="text-xs text-muted-foreground">{player.positions.join("/")} · {snapshot.slots.find((s) => s.id === player.currentSlotId)?.label ?? "Bench"}</div></td>
        <td className="p-3">{player.availability}<div className="text-xs text-muted-foreground">{player.kickoffAt === null ? "No verified kickoff" : `${new Date(player.kickoffAt).toLocaleString()}${player.kickoffAt <= now ? " · Locked" : ""}`}</div></td>
        <td className="p-3"><Input className="min-w-24" type="number" step="0.01" aria-label={`Supplied points for ${player.name}`} value={player.projectedPoints ?? ""} onChange={(e) => {
          const value = e.target.value;
          const enteredAt = Date.now();
          setNow(enteredAt);
          setSnapshot((old) => old === null ? null : { ...old, players: old.players.map((p) => p.id === player.id ? { ...p, projectedPoints: value === "" ? null : Number(value), projectionOrigin: "manual", projectionMissingReason: null, projectionEnteredAt: enteredAt } : p) });
        }} /><div className="mt-1 max-w-56 text-xs text-muted-foreground">{player.projectedPoints === null ? player.projectionMissingReason ?? (player.projectionOrigin === "manual" ? "Manual override cleared" : "No estimate supplied") : player.projectionOrigin === "manual" ? "Manual override" : player.projectionOrigin === "model-conditional" ? "Provisional · assumes active at kickoff · not availability-adjusted" : player.projectionOrigin === "experimental" ? "Experimental baseline · not a validated forecast" : "Model estimate · see source limits"}</div><WeeklyExperimentalNote player={player} />{player.projectionOrigin === "manual" && player.projectionEnteredAt !== undefined && <p className="mt-1 max-w-56 text-xs text-muted-foreground">Entered {new Date(player.projectionEnteredAt).toLocaleString()} · expires {new Date(player.projectionEnteredAt + PROJECTION_MAX_AGE).toLocaleString()}</p>}</td>
      </tr>)}</tbody></table></div>
      <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={holdUnpriced} onChange={(e) => setHoldUnpriced(e.target.checked)} />Hold unpriced K and D/ST in their current slots; compare only the other positions.</label>
      <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={compareAvailable} onChange={(e) => setCompareAvailable(e.target.checked)} />Compare incomplete estimates. Keep every unpriced player in their current place, and exclude their values and omitted scoring terms from the comparison. I will verify final active lists where injury-report coverage is missing.</label>
      {plan && <section aria-live="polite" className="rounded-lg border p-4">
        <h2 className="font-semibold">{plan.status === "blocked" ? "Inputs needed before a recommendation" : plan.status === "conditional" ? "Conditional lineup comparison" : "Highest expected-points lineup"}</h2>
        {groupWeeklyNotices(plan.warnings).map((group) => <details key={group.title} className="mt-3 text-sm text-amber-700 dark:text-amber-300"><summary className="cursor-pointer">{group.title} · {group.messages.length} source notes</summary><ul className="mt-2 list-disc space-y-1 pl-5">{group.messages.map((message) => <li key={message}>{message}</li>)}</ul></details>)}
        {plan.status !== "blocked" && <>
          <p className="mt-4 text-sm">{compareAvailable || plan.excludedSlotIds.length ? "Included estimates only" : "Projected lineup"}: {plan.projectedPoints?.toFixed(2)} points{plan.gain === null ? "" : ` · ${plan.gain >= 0 ? "+" : ""}${plan.gain.toFixed(2)} vs included current starters`}. Estimates are rounded to cents for assignment.</p>
          <div className="mt-3 space-y-2">{plan.assignments.map((a) => <div key={a.slotId} className="flex justify-between gap-3 text-sm"><span>{snapshot.slots.find((s) => s.id === a.slotId)?.label}: {a.playerId === null ? "Empty" : names.get(a.playerId)}{a.fixed ? " · Fixed" : ""}</span><span>{a.points === null ? "Not valued" : a.points.toFixed(2)}</span></div>)}</div>
          <p className="mt-4 text-xs text-muted-foreground">Equal-point choices put later games in flexible slots when possible. Check final injury designations and make any changes in Sleeper before kickoff.</p>
        </>}
      </section>}
      {input && <WeeklyDecisionSave key={user?.id ?? "anonymous"} snapshot={input} preferences={{ holdUnpricedPositions: holdUnpriced ? ["K", "DST"] : [], compareAvailableEstimates: compareAvailable, allowConditionalEstimates: includeConditional, allowExperimentalEstimates: includeExperimental }} disabled={busy || plan?.status === "blocked"} access={authLoading || me === undefined ? "loading" : !isAuthenticated || !me.signedIn ? "signed-out" : can(me.entitlements, "performance_history") ? "enabled" : "unavailable"} save={(args) => saveDecision(args)} />}
      <section className="rounded-lg border p-4"><h2 className="font-semibold">Kickoff checklist</h2><p className="mt-1 text-sm text-muted-foreground">Recheck final active lists around 90 minutes before each kickoff, refresh this roster, and confirm changes in Sleeper. Checks are personal reminders, not verified availability, and reset on refresh. No push notifications or automatic submissions.</p><div className="mt-3 space-y-3">{weeklyKickoffChecks(snapshot, now).map((game) => <label key={game.gameId} className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" disabled={game.locked} checked={checkedGames.includes(game.gameId)} onChange={(e) => setCheckedGames((old) => e.target.checked ? [...old, game.gameId] : old.filter((id) => id !== game.gameId))} /><span>{game.locked ? "Locked — do not move" : `Recheck ${new Date(game.checkAt).toLocaleString()}`}<span className="block text-xs text-muted-foreground">Kickoff {new Date(game.kickoffAt).toLocaleString()} · {game.players.join(", ")}</span></span></label>)}</div></section>
    </div>}
    <Link href="/lineup" className="mt-8 inline-block text-sm underline">Manual preset optimizer</Link>
  </PageShell>;
}
