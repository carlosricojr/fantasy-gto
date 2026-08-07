import Link from "next/link";

import { MARKETING_CONTAINER } from "@/components/app-container";
import { SiteHeader } from "@/components/nav/site-header";

/**
 * Marketing chrome.
 *
 * Same header component as the signed-in surfaces, with its own link set: a visitor who
 * has not seen the product wants Projections, Accuracy, and Pricing, not a Draft board.
 * What is shared is everything about how it behaves — brand placement, active state,
 * account controls — so crossing from `/pricing` into `/lineup` does not feel like
 * arriving at a different site, which it did when these were two hand-maintained headers.
 *
 * No bottom tab bar here. These pages are read top to bottom and end in their own calls to
 * action; a persistent tab bar would cover that copy to offer navigation the visitor has
 * not asked for yet.
 */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader variant="marketing" />

      {/* A div, not a main: each page supplies its own <main>, and a nested landmark
          gives screen readers two "main" regions with skip-to-content landing on the
          wrapper rather than the content. The (app) layout does the same. */}
      <div className="flex-1">{children}</div>

      <footer className="border-t py-6">
        <div
          className={`${MARKETING_CONTAINER} flex flex-wrap items-center justify-between gap-3 px-4 text-sm text-muted-foreground sm:px-6`}
        >
          <span>Fantasy GTO</span>
          <Link href="/accuracy" className="hover:text-foreground">
            How accurate is this?
          </Link>
        </div>
      </footer>
    </div>
  );
}
