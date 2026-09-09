"use client";

import { useEffect, useMemo, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { useAction, useConvexAuth, useQuery } from "convex/react";
import Link from "next/link";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PageShell } from "@/components/page-shell";
import { DecisionHistory, type DecisionHistoryTransport } from "@/components/decision-history";
import { can } from "@/lib/billing/entitlements";

export default function DecisionsPage() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { user } = useUser();
  const me = useQuery(api.users.me, {});
  const list = useAction(api.decisionJournal.list);
  const detail = useAction(api.decisionJournal.detail);
  const refresh = useAction(api.decisionJournal.refreshOutcomes);
  const [initialId, setInitialId] = useState<string | null>(null);
  const [urlReady, setUrlReady] = useState(false);
  useEffect(() => {
    const ids = new URLSearchParams(window.location.search).getAll("record");
    setInitialId(ids.length === 1 && /^[a-zA-Z0-9]{1,100}$/.test(ids[0]) ? ids[0] : null);
    setUrlReady(true);
  }, []);
  const transport = useMemo<DecisionHistoryTransport>(() => ({
    list: (cursor) => list({ paginationOpts: { numItems: 20, cursor } }),
    detail: (id) => detail({ id: id as Id<"weeklyDecisions"> }),
    refreshOutcomes: (id) => refresh({ id: id as Id<"weeklyDecisions"> }),
  }), [list, detail, refresh]);
  return <PageShell title="Decision history" subtitle="Frozen inputs, receipt times and observed outcomes.">
    {isLoading || me === undefined || !urlReady ? <p role="status">Checking access…</p> : !isAuthenticated || !me.signedIn ? <p>Sign in to view private decision history.</p> : !can(me.entitlements, "performance_history") ? <p>Private decision history is not included in your current plan.</p> : <DecisionHistory key={user?.id ?? "pending-user"} transport={transport} initialId={initialId} />}
    <Link className="mt-6 inline-block text-sm underline" href="/lineup/weekly">Return to weekly lineup</Link>
  </PageShell>;
}
