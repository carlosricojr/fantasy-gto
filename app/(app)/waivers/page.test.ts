import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import WaiversPage from "./page";

// Clerk's modal needs the mounted Next router; only that external infrastructure is stubbed.
vi.mock("@clerk/nextjs", () => ({ SignInButton: ({ children, mode }: { children: ReactNode; mode: string }) => {
  expect(mode).toBe("modal");
  return children;
} }));

describe("waiver comparison entry contract", () => {
  it("server-renders scope, discovery and no-transactions notice without fetching by navigation", () => {
    const html = renderToStaticMarkup(createElement(WaiversPage));
    expect(html).toContain("Waiver comparison");
    expect(html).toContain("One week. One addition and one drop. No transactions submitted.");
    expect(html).toContain("Choose up to 12 unrostered players");
    expect(html).toContain("Load verified league pool");
    expect(html).toContain("not the player’s raw projection");
    expect(html).toContain("No paid data");
    expect(html).toContain("Weekly lineup planner");
    expect(html).not.toContain("Positive included-lineup gain");
    expect(html).not.toContain('href="/sign-in"');
    expect(html).toContain('<button class="underline"');
  });
});
