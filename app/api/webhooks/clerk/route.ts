import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { Webhook } from "svix";

export const runtime = "edge";

export async function POST(req: Request) {
  const body = await req.text();
  const hdrs = await headers();
  const svixId = hdrs.get("svix-id");
  const svixTimestamp = hdrs.get("svix-timestamp");
  const svixSignature = hdrs.get("svix-signature");
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!svixId || !svixTimestamp || !svixSignature || !secret) {
    return NextResponse.json({ error: "Missing webhook headers/secret" }, { status: 400 });
  }
  try {
    const wh = new Webhook(secret);
    const evt = wh.verify(body, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    });
    // TODO: call Convex billing.applyEvent with evt
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}


