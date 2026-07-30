import Link from "next/link";
import { PricingTable } from "@clerk/nextjs";

import { UNIMPLEMENTED_FEATURES, limit, planCapabilities } from "@/lib/billing/entitlements";

/**
 * Pricing.
 *
 * The plan cards come from Clerk, which is configured outside this repository. What is
 * written here is what the code can actually vouch for: the capability table is read
 * directly from `lib/billing/entitlements.ts`, so this page cannot drift from what a
 * subscription really unlocks.
 *
 * The "not built yet" list is rendered from `UNIMPLEMENTED_FEATURES` for the same reason.
 * This is the page where money changes hands, so it is the last place a gap between the
 * marketing and the product should be allowed to hide.
 */

const FEATURE_LABELS: Record<string, string> = {
  start_sit: "Start/sit advice",
  league_count: "Leagues",
  daily_refresh: "Daily projection refreshes",
  waivers_faab: "Waiver and FAAB guidance",
  dst_streamer: "Defense streamer",
  alerts: "Alerts",
  accuracy_dashboard: "Accuracy dashboard",
  import_export: "Lineup import and export",
  performance_history: "Season performance history",
};

export default function PricingPage() {
  const pro = planCapabilities("pro");
  // Read the cap from the entitlement table rather than writing a number in prose. A
  // hard-coded "3" would keep claiming three the day the table changes.
  const freeLeagues = limit(planCapabilities("free"), "league_count");
  // What Pro adds *over free*. Filtering on `pro[key] === true` alone would list
  // start/sit, which the free tier grants too — that is not something Pro includes.
  const free = planCapabilities("free");
  const proOnly = Object.keys(FEATURE_LABELS).filter(
    (key) =>
      key !== "league_count" &&
      pro[key as keyof typeof pro] === true &&
      free[key as keyof typeof free] !== true,
  );

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Choose your plan</h1>
      <p className="mt-3 text-muted-foreground">
        Projections and the lineup optimiser are free and need no account. Pro removes the
        {" "}{freeLeagues}-league limit. What else it adds is listed below — derived from
        the same table the server authorises against, so this page cannot promise more than
        the code delivers.
      </p>

      <div className="mt-10">
        <PricingTable />
      </div>

      <section className="mt-12 grid gap-8 sm:grid-cols-2">
        <div>
          <h2 className="font-medium">What Pro adds today</h2>
          <ul className="mt-3 space-y-1.5 text-sm text-muted-foreground">
            <li>Unlimited leagues (free includes {freeLeagues})</li>
            {proOnly.map((key) => (
              <li key={key}>{FEATURE_LABELS[key]}</li>
            ))}
          </ul>
          {proOnly.length === 0 && (
            <p className="mt-3 text-sm text-muted-foreground">
              That is the whole list. Unlimited leagues is currently the only thing a Pro
              subscription unlocks. Everything else on the roadmap is below.
            </p>
          )}
        </div>

        <div>
          <h2 className="font-medium">Not a Pro feature yet</h2>
          <ul className="mt-3 space-y-1.5 text-sm text-muted-foreground">
            {UNIMPLEMENTED_FEATURES.map((key) => (
              <li key={key}>{FEATURE_LABELS[key]}</li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-muted-foreground">
            Some of these do not exist yet; others exist but are free to everyone — the
            accuracy dashboard is a public page, and projections are refreshed daily for
            all users. Either way a Pro subscription does not unlock them, which is the
            part that matters when deciding whether to pay.
          </p>
        </div>
      </section>

      <p className="mt-12 text-sm text-muted-foreground">
        Before subscribing, it is worth reading{" "}
        <Link href="/accuracy" className="underline underline-offset-4">
          how accurate the projections actually are
        </Link>
        . The measured edge is real but small.
      </p>
    </main>
  );
}
