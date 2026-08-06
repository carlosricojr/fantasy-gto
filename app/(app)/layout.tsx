import Link from "next/link";

import { EnsureUser } from "@/components/ensure-user";
import { BottomTabs } from "@/components/nav/bottom-tabs";
import { SiteHeader } from "@/components/nav/site-header";

/**
 * Application chrome.
 *
 * Renders for signed-out visitors too, because projections and the lineup optimizer are
 * open. The header therefore has to handle both states rather than assuming a user.
 *
 * Navigation is a header on tablet and up and a bottom tab bar on phones, both driven by
 * `APP_NAV`. The bottom bar is fixed, so the content column reserves space for it below
 * `sm` — otherwise the last rows of a long projections table sit underneath it and cannot
 * be scrolled clear.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <EnsureUser />
      <SiteHeader variant="app" />

      {/* A div, not a main: each page supplies its own <main>, and a nested landmark
          gives screen readers two "main" regions with skip-to-content landing on the
          wrapper rather than the content. */}
      <div className="flex-1 pb-[calc(3.5rem+env(safe-area-inset-bottom))] sm:pb-0">
        {children}
      </div>

      <footer className="border-t py-6 pb-[calc(1.5rem+3.5rem+env(safe-area-inset-bottom))] sm:pb-6">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 text-sm text-muted-foreground">
          <span>Fantasy GTO</span>
          <Link href="/accuracy" className="hover:text-foreground">
            How accurate is this?
          </Link>
        </div>
      </footer>

      <BottomTabs />
    </div>
  );
}
