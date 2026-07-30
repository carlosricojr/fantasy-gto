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
  const included = Object.keys(FEATURE_LABELS).filter(
    (key) =>
      key !== "league_count" &&
      pro[key as keyof typeof pro] === true,
  );

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Choose your plan</h1>
      <p className="mt-3 text-muted-foreground">
        Projections and the lineup optimiser are free and need no account. Pro removes the
        {" "}{freeLeagues}-league limit and adds the tools below.
      </p>

      <div className="mt-10">
        <PricingTable />
      </div>

      <section className="mt-12 grid gap-8 sm:grid-cols-2">
        <div>
          <h2 className="font-medium">What Pro includes today</h2>
          <ul className="mt-3 space-y-1.5 text-sm text-muted-foreground">
            <li>Unlimited leagues (free includes {freeLeagues})</li>
            {included.map((key) => (
              <li key={key}>{FEATURE_LABELS[key]}</li>
            ))}
          </ul>
        </div>

        <div>
          <h2 className="font-medium">Not built yet</h2>
          <ul className="mt-3 space-y-1.5 text-sm text-muted-foreground">
            {UNIMPLEMENTED_FEATURES.map((key) => (
              <li key={key}>{FEATURE_LABELS[key]}</li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-muted-foreground">
            These are planned but not implemented, so a Pro subscription does not unlock
            them today. They are listed here rather than omitted, because charging for
            something that does not exist is worse than admitting it is not ready.
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
