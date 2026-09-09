import type { WeeklyPlayer } from "@/lib/nfl/weekly-lineup";

/** Preserve method and omitted-term evidence even when an overlay is disabled. */
export function WeeklyExperimentalNote({ player }: { player: WeeklyPlayer }) {
  const estimate = player.experimentalEstimate;
  if (!estimate) return null;
  const selected = player.projectionOrigin === "experimental" && player.projectedPoints !== null;
  return <div className="mt-2 max-w-64 space-y-1 text-xs text-muted-foreground">
    <p>{selected ? "Experimental input selected" : "Experimental input not selected"}: {estimate.method === "kicker-prior-season-game-mean" ? "Prior-season kicking-event points per game; kicking events only; no calibration." : "Frozen model applied to returning-player history; this use is unvalidated. The model’s existing calibration is PPR-only."}</p>
    <p>{estimate.historyGames} historical games; last observed {estimate.lastPlayed.season}, week {estimate.lastPlayed.index}. History gap: {estimate.historyGapWeeks} regular-season weeks. Week-one use only, assuming active at kickoff; not availability-adjusted.</p>
    <p>Omitted scoring rules: {estimate.excludedRules.length ? estimate.excludedRules.join(", ") : "none in this supported subset"}. Evidence is exploratory development/tuning only, not prospective validation.</p>
    {!selected && <p>Not included in supplied points. Manual overrides take priority; a blank manual override does not opt into this baseline.</p>}
  </div>;
}
