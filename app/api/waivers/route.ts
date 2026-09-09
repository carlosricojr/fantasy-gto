import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { fetchAction } from "convex/nextjs";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { importSleeperWaivers, parseWaiverRequest } from "@/lib/sources/sleeper-waivers";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Fixed server-owned endpoint; never supplied by the client. It derives subscription
// access using the backend clock. Missing deployment/auth fails closed before source I/O.
const authorizeWaivers = makeFunctionReference<"action", Record<string, never>, null>("personalTools:authorizeWaiverComparison");

/** Documented public source data, behind the narrow waiver-comparison entitlement. */
export async function GET(request: Request) {
  let parsed;
  try { parsed = parseWaiverRequest(new URL(request.url).searchParams, Date.now()); }
  catch (cause) { return NextResponse.json({ error: cause instanceof Error ? cause.message : "Invalid request." }, { status: 400, headers: { "Cache-Control": "no-store" } }); }
  try {
    const session = await auth();
    if (!session.userId) return NextResponse.json({ error: "Sign in before using waiver comparisons." }, { status: 401, headers: { "Cache-Control": "no-store" } });
    const token = await session.getToken({ template: "convex" });
    if (!token) return NextResponse.json({ error: "Your session could not authorize this comparison. Sign in again." }, { status: 401, headers: { "Cache-Control": "no-store" } });
    await fetchAction(authorizeWaivers, {}, { token });
  } catch (cause) {
    const code = cause instanceof ConvexError && cause.data !== null && typeof cause.data === "object" && "code" in cause.data ? cause.data.code : null;
    const status = code === "entitlement" ? 403 : code === "unauthenticated" ? 401 : 503;
    return NextResponse.json({ error: status === 403 ? "One-week waiver comparisons require the waiver-comparison entitlement. No data was fetched." : status === 401 ? "Sign in before using waiver comparisons." : "Waiver access could not be verified. No source data was fetched; try again later." }, { status, headers: { "Cache-Control": "no-store" } });
  }
  try { return NextResponse.json(await importSleeperWaivers(parsed), { headers: { "Cache-Control": "no-store" } }); }
  catch (cause) { return NextResponse.json({ error: cause instanceof Error ? cause.message : "Waiver import failed." }, { status: 502, headers: { "Cache-Control": "no-store" } }); }
}
