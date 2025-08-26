import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { lineup } = body as { lineup?: Array<{ player: string; pos: string }> };
  if (!lineup) return NextResponse.json({ error: "Missing lineup" }, { status: 400 });
  const header = ["player", "pos"]; 
  const rows = lineup.map((r) => [r.player, r.pos]);
  const csv = [header, ...rows].map((r) => r.join(",")).join("\n");
  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": "attachment; filename=FantasyGTO-lineup.csv",
    },
  });
}


