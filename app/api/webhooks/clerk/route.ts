import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { Webhook } from "svix";
import { getConvexServerClient, api } from "@/lib/convexServerClient";

export const runtime = "nodejs";

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
    }) as unknown as { type?: string; data?: unknown };
    const convex = getConvexServerClient();
    await convex.action(api.functions.billing.applyEvent, { event: evt });
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Webhook verification failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


