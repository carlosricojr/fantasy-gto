"use client";

import Link from "next/link";
import { useQuery } from "convex/react";

import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import type { FeatureKey } from "@/lib/billing/entitlements";

/**
 * Client-side feature gating.
 *
 * This controls **presentation only**. Every gated capability is also enforced in Convex
 * (`convex/lib/auth.ts`), because anything decided in a browser can be bypassed. If this
 * component were removed entirely, no paid feature would become reachable.
 */

interface EntitlementGateProps {
  feature: FeatureKey;
  /** What the user gets. Shown on the upgrade prompt. */
  benefit: string;
  children: React.ReactNode;
}

export function EntitlementGate({ feature, benefit, children }: EntitlementGateProps) {
  const me = useQuery(api.users.me, {});

  // Undefined means the query is still loading. Rendering the upgrade prompt here would
  // flash a paywall at subscribers on every page load.
  if (me === undefined) {
    return <div className="h-24 animate-pulse rounded-lg bg-muted" aria-hidden />;
  }

  if (me.entitlements[feature] === true) {
    return <>{children}</>;
  }

  return <UpgradePrompt benefit={benefit} />;
}

/**
 * The upgrade prompt.
 *
 * States what the feature does. It deliberately does not promise a points gain, because
 * no measurement supports a per-feature figure — see the honesty ledger in the README.
 */
export function UpgradePrompt({ benefit }: { benefit: string }) {
  return (
    <div className="rounded-lg border border-dashed p-6 text-center">
      <p className="text-sm text-muted-foreground">{benefit}</p>
      <p className="mt-1 text-sm font-medium">Included with Pro.</p>
      <Button asChild className="mt-4" size="sm">
        <Link href="/pricing">See plans</Link>
      </Button>
    </div>
  );
}

/** Reads the caller's entitlements. Returns undefined while loading. */
export function useEntitlements() {
  const me = useQuery(api.users.me, {});
  return me?.entitlements;
}
