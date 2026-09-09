import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { authenticatedBoardReader, DIAGNOSTIC_CONVEX_URL } from "./private-board-diagnostic";

const token = "test.payload.signature";
const shape = { season: 2026, scoringId: "ppr", teams: 10 };

describe("authenticated operator board diagnostics", () => {
  it("rejects missing or malformed credentials before any I/O", () => {
    const fetcher = vi.fn();
    for (const value of [undefined, "", "invalid", "a.b.c\n", "x".repeat(16_385)]) {
      expect(() => authenticatedBoardReader(value, DIAGNOSTIC_CONVEX_URL, fetcher)).toThrow("FANTASY_GTO_CLERK_TOKEN");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("pins the bearer token to the exact expected host and disables redirects", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}"));
    for (const target of ["https://example.com", "http://limitless-elk-261.convex.cloud", `${DIAGNOSTIC_CONVEX_URL}.evil.test`, `${DIAGNOSTIC_CONVEX_URL}/other`, `${DIAGNOSTIC_CONVEX_URL}?redirect=elsewhere`, "https://user@limitless-elk-261.convex.cloud", "not a URL"]) {
      expect(() => authenticatedBoardReader(token, target, fetcher)).toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
    await authenticatedBoardReader(token, DIAGNOSTIC_CONVEX_URL, fetcher)(shape);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`${DIAGNOSTIC_CONVEX_URL}/api/query`, {
      method: "POST", redirect: "error", cache: "no-store",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ path: "draft:board", args: shape, format: "json" }),
    });
  });
  it("does not expose credentials through error messages", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error(`transport echoed ${token}`));
    await expect(authenticatedBoardReader(token, undefined, fetcher)(shape)).rejects.toThrow("Authenticated board request failed");
    try { await authenticatedBoardReader(token, undefined, fetcher)(shape); }
    catch (error) { expect(String(error)).not.toContain(token); }
  });
  it("both live script entrypoints reject absent credentials before provider I/O", () => {
    const env = { ...process.env };
    delete env.FANTASY_GTO_CLERK_TOKEN;
    for (const script of ["identity-coverage", "sleeper-rehearsal"]) {
      const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
        globalThis.fetch = async () => { console.error("UNEXPECTED_PROVIDER_IO"); throw new Error("I/O forbidden in test"); };
        process.argv = [process.execPath, "script", "https://sleeper.com/leagues/123", "456"];
        await import("./scripts/${script}.ts");
      `], { cwd: process.cwd(), env, encoding: "utf8", timeout: 10_000 });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("FANTASY_GTO_CLERK_TOKEN");
      expect(run.stderr + run.stdout).not.toContain("UNEXPECTED_PROVIDER_IO");
    }
  });
});
