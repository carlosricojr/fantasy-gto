import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PrivateDataGate } from "@/components/private-data-gate";

const state = vi.hoisted(() => ({
  auth: { isLoading: false, isAuthenticated: false },
  me: undefined as undefined | { signedIn: boolean },
  query: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => state.auth,
  useQuery: (...args: unknown[]) => { state.query(...args); return state.me; },
  useMutation: () => vi.fn(),
}));
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ userId: "account" }),
  SignInButton: ({ children }: { children: ReactNode }) => children,
}));

describe("private data page readiness", () => {
  beforeEach(() => { state.auth = { isLoading: false, isAuthenticated: false }; state.me = undefined; state.query.mockClear(); });
  function render() {
    const protectedContent = vi.fn(() => createElement("p", null, "Protected query consumers"));
    const html = renderToStaticMarkup(createElement(PrivateDataGate, { title: "Draft" }, createElement(protectedContent)));
    return { html, protectedContent };
  }
  it("does not mount protected queries or fetch account data when signed out", () => {
    const { html, protectedContent } = render();
    expect(html).toContain("Sign in to load data");
    expect(html).toContain("Hosting access alone");
    expect(protectedContent).not.toHaveBeenCalled();
    expect(state.query.mock.calls[0][1]).toBe("skip");
  });
  it("waits for token verification and for the application-user query", () => {
    state.auth = { isLoading: true, isAuthenticated: false };
    expect(render().protectedContent).not.toHaveBeenCalled();
    state.auth = { isLoading: false, isAuthenticated: true };
    expect(render().html).toContain("Checking account access");
    expect(render().protectedContent).not.toHaveBeenCalled();
  });
  it("offers explicit account recovery without mounting queries before provisioning", () => {
    state.auth.isAuthenticated = true;
    state.me = { signedIn: false };
    const { html, protectedContent } = render();
    expect(html).toContain("Retry account setup");
    expect(protectedContent).not.toHaveBeenCalled();
  });
  it("mounts protected content for the existing application account", () => {
    state.auth.isAuthenticated = true;
    state.me = { signedIn: true };
    expect(render().html).toContain("Protected query consumers");
  });
  it("wraps all four protected query-consuming pages before their hooks mount", () => {
    for (const page of ["draft", "projections", "lineup", "dashboard"]) {
      const source = readFileSync(`app/(app)/${page}/page.tsx`, "utf8");
      expect(source).toMatch(/export default function \w+\(\) \{\s*return <PrivateDataGate[^>]*><\w+Content \/><\/PrivateDataGate>;\s*\}/);
    }
  });
});
