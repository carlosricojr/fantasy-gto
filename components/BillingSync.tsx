"use client";
import { useEffect, useRef } from "react";
import { useAuth } from "@clerk/nextjs";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { toast } from "sonner";

export default function BillingSync() {
  const { isSignedIn } = useAuth();
  const sync = useAction(api.functions.billing.syncEntitlements);
  const ran = useRef(false);

  useEffect(() => {
    if (!isSignedIn) return;
    if (ran.current) return;
    ran.current = true;
    const last = Number(localStorage.getItem("fgto_last_billing_sync") || 0);
    const now = Date.now();
    if (now - last < 60_000) return; // throttle 1m
    sync({})
      .then((r) => {
        localStorage.setItem("fgto_last_billing_sync", String(now));
        if (r?.updated) toast.success("Entitlements updated");
      })
      .catch(() => {});
  }, [isSignedIn, sync]);
  return null;
}


