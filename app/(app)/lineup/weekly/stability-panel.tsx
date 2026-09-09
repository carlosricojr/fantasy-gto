import { WEEKLY_STRESS_POINTS, type WeeklyLineupStability, type WeeklyStressPoints } from "@/lib/nfl/weekly-lineup-stability";

export function WeeklyStabilityPanel({ analysis, stressPoints, onStressChange }: {
  analysis: WeeklyLineupStability;
  stressPoints: WeeklyStressPoints;
  onStressChange: (points: WeeklyStressPoints) => void;
}) {
  return <section className="rounded-lg border p-4" aria-labelledby="weekly-stability-heading">
    <h2 id="weekly-stability-heading" className="font-semibold">Sensitivity versus your current starters</h2>
    {analysis.status !== "compared" ? <p className="mt-2 text-sm">{analysis.reason}</p> : <>
      <p className="mt-2 text-sm">{analysis.eraseAdvantagePoints === 0 ? "The included estimates already tie versus your current starters." : <>About <strong>±{analysis.eraseAdvantagePoints.toFixed(2)} points per changed player</strong> can erase the included advantage versus your current starters.</>}</p>
      <label className="mt-3 flex flex-wrap items-center gap-2 text-sm">Stress each changed player’s estimate by
        <select className="rounded-md border bg-background px-2 py-1 text-foreground" value={stressPoints} onChange={(event) => {
          const value = Number(event.target.value);
          const allowed = WEEKLY_STRESS_POINTS.find((points) => points === value);
          if (allowed !== undefined) onStressChange(allowed);
        }}>{WEEKLY_STRESS_POINTS.map((points) => <option value={points} key={points}>±{points} points</option>)}</select>
      </label>
      <p className="mt-2 text-sm">{analysis.adverseMargin > 0 ? `The included advantage versus your current starters remains +${analysis.adverseMargin.toFixed(2)} points under this stress.` : analysis.adverseMargin === 0 ? "This stress can erase the included advantage versus your current starters (a tie)." : `This stress can reverse the included advantage versus your current starters by ${Math.abs(analysis.adverseMargin).toFixed(2)} points.`}</p>
      <p className="mt-2 text-xs text-muted-foreground">{analysis.variablePlayerIds.length} changed players with variable included estimates: proposed-only starters move down and current-only starters move up together. Common starters, fixed/unpriced values and known-unavailable zeros do not vary. The threshold is rounded up to a whole cent per player; changes may go below zero.</p>
    </>}
    <p className="mt-2 text-xs text-muted-foreground">This is an assumed stress, not a measured error range or confidence level. It compares only these two starter sets, not every alternative lineup. Eligibility, kickoff locks, availability assumptions and omitted scoring terms remain unchanged; it says nothing about actual future scores. Recheck the displayed source limitations before changing your lineup.</p>
  </section>;
}
