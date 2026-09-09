import { NextRequest, NextResponse } from "next/server";
import { findSleeperConnections } from "@/lib/sources/sleeper-connections";
import { JsonBodyTooLargeError, readBoundedJson } from "@/lib/sources/bounded-json";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** User-triggered public lookup; no private connection is written here. */
export async function POST(request: NextRequest) {
  try {
    const parsed = await readBoundedJson(request.body, 1000);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Supply a Sleeper username or league link.");
    const body = parsed as Record<string, unknown>;
    if (Object.keys(body).some((key) => key !== "username" && key !== "leagueInput") || (body.username !== undefined && (typeof body.username !== "string" || body.username.length > 40)) || (body.leagueInput !== undefined && (typeof body.leagueInput !== "string" || body.leagueInput.length > 300))) throw new Error("Supply only a Sleeper username or league link.");
    return NextResponse.json(await findSleeperConnections(body as { username?: string; leagueInput?: string }), { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    return NextResponse.json({ error: cause instanceof Error ? cause.message : "Could not find Sleeper leagues." }, { status: cause instanceof JsonBodyTooLargeError ? 413 : 400, headers: { "Cache-Control": "no-store" } });
  }
}
