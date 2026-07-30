/**
 * Reading application errors on the client.
 *
 * Convex redacts the message of any non-`ConvexError` exception on a production
 * deployment, so server code throws `ConvexError` carrying a data payload
 * (`convex/lib/auth.ts`). This is the matching reader.
 *
 * It falls back to a generic sentence rather than surfacing a redacted
 * `"[CONVEX M(...)] Server Error"` string, which tells a user nothing and looks like a
 * crash at exactly the moment they are being asked to upgrade.
 */

export interface AppErrorShape {
  code: "unauthenticated" | "entitlement" | "not_found" | "invalid";
  message: string;
  feature?: string;
}

function isAppErrorShape(value: unknown): value is AppErrorShape {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.code === "string" && typeof candidate.message === "string";
}

/**
 * Extracts a user-facing message from a thrown value.
 *
 * `ConvexError` exposes its payload as `.data`, which survives to the client. Anything
 * else is treated as unexpected and gets the fallback.
 */
export function appErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "data" in error) {
    const data = (error as { data: unknown }).data;
    if (isAppErrorShape(data)) return data.message;
    if (typeof data === "string" && data.trim() !== "") return data;
  }
  return fallback;
}

/** The structured code, when present. Lets the interface react to *why* it failed. */
export function appErrorCode(error: unknown): AppErrorShape["code"] | null {
  if (typeof error === "object" && error !== null && "data" in error) {
    const data = (error as { data: unknown }).data;
    if (isAppErrorShape(data)) return data.code;
  }
  return null;
}
