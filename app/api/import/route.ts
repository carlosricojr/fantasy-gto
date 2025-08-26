import { NextRequest, NextResponse } from "next/server";
import { encryptToken } from "@/lib/providers/espn";
import { cookies } from "next/headers";
import { redis } from "@/lib/cache/redis";

export const runtime = "nodejs";

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
      if (encrypted) {
        const key = `trial:${crypto.randomUUID()}`;
        await redis.set(key, JSON.stringify(encrypted), { ex: 60 * 60 * 24 });
        const cookieStore = await cookies();
        cookieStore.set("fgto_trial", key, { httpOnly: true, sameSite: "lax", secure: true, maxAge: 60 * 60 * 24 });
      }
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
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Import failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}


