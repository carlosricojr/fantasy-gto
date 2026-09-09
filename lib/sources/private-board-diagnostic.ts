/** Read-only operator diagnostics. No login, token discovery or administrator bypass. */
export const DIAGNOSTIC_CONVEX_URL = "https://limitless-elk-261.convex.cloud";

export function authenticatedBoardReader(
  token: string | undefined,
  deployment = DIAGNOSTIC_CONVEX_URL,
  fetcher: typeof fetch = fetch,
) {
  // Validate before returning the reader, so scripts can fail before any provider I/O.
  if (!token || token.length > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("Live board diagnostics require FANTASY_GTO_CLERK_TOKEN: a short-lived JWT for an already authenticated app user. No provider requests were started.");
  }
  let target: URL;
  try { target = new URL(deployment); }
  catch { throw new Error("Unsupported diagnostic Convex URL."); }
  if (target.origin !== DIAGNOSTIC_CONVEX_URL || target.username || target.password || target.search || target.hash || target.pathname !== "/") {
    throw new Error("Diagnostic credentials may only be sent to the configured production Convex host.");
  }
  return async (args: { season: number; scoringId: string; teams: number }): Promise<Response> => {
    let response: Response;
    try {
      response = await fetcher(`${DIAGNOSTIC_CONVEX_URL}/api/query`, {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ path: "draft:board", args, format: "json" }),
      });
    } catch {
      // Do not echo transport exceptions: custom fetchers can include request headers.
      throw new Error("Authenticated board request failed; check connectivity and the configured host.");
    }
    if (!response.ok) throw new Error(`Authenticated board request failed (HTTP ${response.status}); check app access and token expiry.`);
    return response;
  };
}
