import { NextRequest, NextResponse } from "next/server";
import { encryptToken } from "@/lib/providers/espn";

export const runtime = "edge";

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const body = await req.json();
      const { leagueId, season, s2, swid } = body as {
        leagueId: string; season: number; s2?: string; swid?: string;
      };
      if (!leagueId || !season) return NextResponse.json({ error: "Missing leagueId/season" }, { status: 400 });
      const encrypted = s2 && swid ? { s2: encryptToken(s2), swid: encryptToken(swid) } : undefined;
      // TODO: enqueue Convex job to fetch league/roster and store minimal trial state
      return NextResponse.json({ ok: true, leagueId, season, tokens: Boolean(encrypted) });
    }
    // CSV fallback
    if (contentType.includes("text/csv") || contentType.includes("multipart/form-data")) {
      // Parse CSV lines and return a normalized roster payload for import
      const text = await req.text();
      const rows = text.trim().split(/\r?\n/).map((l) => l.split(","));
      const header = rows.shift() || [];
      const items = rows.map((r) => Object.fromEntries(r.map((v, i) => [header[i] || `col${i}`, v])));
      return NextResponse.json({ ok: true, items });
    }
    return NextResponse.json({ error: "Unsupported content-type" }, { status: 415 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Import failed" }, { status: 500 });
  }
}


