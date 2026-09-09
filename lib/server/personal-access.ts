import { auth } from "@clerk/nextjs/server";
import { fetchAction } from "convex/nextjs";
import { makeFunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { appErrorCode } from "../errors";

/** Must complete before upstream I/O. Backend absence or auth outages fail closed. */
export async function personalSourceAccess(kind: "connection" | "roster" | "model"): Promise<NextResponse | null> {
  try {
    const session = await auth();
    if (!session.userId) return failure(401, "Sign in to import league data. Free includes roster-only imports and connection lookup.");
    const token = await session.getToken({ template: "convex" });
    if (!token) return failure(401, "Sign in again to verify access. No source request was sent.");
    if (kind === "connection") await fetchAction(makeFunctionReference<"action", Record<string, never>, null>("personalTools:authorizeConnectionLookup"), {}, { token });
    else await fetchAction(makeFunctionReference<"action", { model: boolean }, null>("personalTools:authorizeWeeklyImport"), { model: kind === "model" }, { token });
    return null;
  } catch (cause) {
    const code = appErrorCode(cause);
    if (code === "unauthenticated") return failure(401, "Sign in again to verify access. No source request was sent.");
    if (code === "entitlement") return failure(403, "Model estimates require Pro. Choose Import roster only to use Free access.");
    if (code === "rate_limit") {
      const data = (cause as { data?: { retryAfterSeconds?: unknown } }).data;
      const retry = typeof data?.retryAfterSeconds === "number" && Number.isFinite(data.retryAfterSeconds) ? Math.max(1, Math.min(86400, Math.ceil(data.retryAfterSeconds))) : undefined;
      return failure(429, `This operation's allowance is temporarily exhausted.${retry ? ` Retry in ${retry} seconds.` : " Try again later."} No source request was sent.`, retry);
    }
    return failure(503, "Access verification is unavailable. No source request was sent.");
  }
}
function failure(status: number, error: string, retry?: number) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store", ...(retry ? { "Retry-After": String(retry) } : {}) } });
}
