import { NextRequest, NextResponse } from "next/server";
import { importSleeperLineup } from "@/lib/sources/sleeper-lineup";

export const dynamic = "force-dynamic";

/** User-triggered, read-only import. No league, projection, or lineup writes. */
export async function GET(request: NextRequest) {
  const leagueId = request.nextUrl.searchParams.get("leagueId") ?? "";
  const ownerId = request.nextUrl.searchParams.get("ownerId") ?? "";
  const week = Number(request.nextUrl.searchParams.get("week"));
  if (!/^\d{1,30}$/.test(leagueId) || !/^\d{1,30}$/.test(ownerId) || !Number.isInteger(week) || week < 1 || week > 18) {
    return NextResponse.json({ error: "Supply valid Sleeper league and user IDs and a week from 1–18." }, { status: 400 });
  }
  try {
    const snapshot = await importSleeperLineup({ leagueId, ownerId, week, now: Date.now() });
    return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    return NextResponse.json({ error: cause instanceof Error ? cause.message : "Could not import this league." }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
