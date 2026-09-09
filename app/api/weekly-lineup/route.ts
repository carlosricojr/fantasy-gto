import { NextRequest, NextResponse } from "next/server";
import { importSleeperLineup } from "@/lib/sources/sleeper-lineup";
import { generateNflverseWeeklyProjections } from "@/lib/sources/nflverse-weekly-projections";
import { sleeperScoringFromId } from "@/lib/nfl/scoring/sleeper";
import { applyWeeklyModel } from "@/lib/nfl/weekly-lineup-inputs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** User-triggered, read-only import. No league, projection, or lineup writes. */
export async function GET(request: NextRequest) {
  const leagueId = request.nextUrl.searchParams.get("leagueId") ?? "";
  const ownerId = request.nextUrl.searchParams.get("ownerId") ?? "";
  const week = Number(request.nextUrl.searchParams.get("week"));
  if (!/^\d{1,30}$/.test(leagueId) || !/^\d{1,30}$/.test(ownerId) || !Number.isInteger(week) || week < 1 || week > 18) {
    return NextResponse.json({ error: "Supply valid Sleeper league and user IDs and a week from 1–18." }, { status: 400 });
  }
  try {
    let snapshot = await importSleeperLineup({ leagueId, ownerId, week, now: Date.now() });
    if (request.nextUrl.searchParams.get("estimates") === "nflverse") {
      const profile = sleeperScoringFromId(snapshot.scoringId);
      if (!profile) throw new Error("Imported scoring identity is invalid.");
      const result = await generateNflverseWeeklyProjections({ season: snapshot.season, week, profile, playerIds: snapshot.players.map((p) => p.id), now: Date.now() });
      if (!result.ok) snapshot = { ...snapshot, warnings: [...(snapshot.warnings ?? []), `Automatic estimates unavailable: ${result.reason}. You can enter weekly expected points manually.`] };
      else snapshot = applyWeeklyModel(snapshot, result.data);
    }
    return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    return NextResponse.json({ error: cause instanceof Error ? cause.message : "Could not import this league." }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
