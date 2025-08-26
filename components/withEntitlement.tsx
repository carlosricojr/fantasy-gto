"use client";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import Paywall from "@/components/paywall";

export default function WithEntitlement({ entitlement, children }: { entitlement: string; children: React.ReactNode }) {
  const entitlements = useQuery(api.functions.auth.getEntitlements, {});
  if (!entitlements) return null;
  const has = entitlements.some((e) => e.key === entitlement && e.active);
  if (has) return <>{children}</>;
  return <Paywall entitlement={entitlement} expectedValue={"+6–10 pts next 2 weeks"} />;
}


