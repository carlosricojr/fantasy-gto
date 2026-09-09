"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { Button } from "./ui/button";
import { appErrorMessage } from "../lib/errors";
import type { WeeklyLineupSnapshot } from "../lib/nfl/weekly-lineup";
import type { WeeklyDecisionPreferences } from "../lib/nfl/decision-journal-inputs";

export interface DecisionSaveInput { snapshotJson: string; preferencesJson: string; requestId: string }

/** The backend owns authentication, receipt time, recomputation and idempotency. */
export function WeeklyDecisionSave({ snapshot, preferences, disabled, access, save }: {
  snapshot: WeeklyLineupSnapshot;
  preferences: WeeklyDecisionPreferences;
  disabled: boolean;
  access: "loading" | "signed-out" | "unavailable" | "enabled";
  save: (input: DecisionSaveInput) => Promise<string>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<{ id: string; payload: string } | null>(null);
  const retry = useRef<{ payload: string; requestId: string } | null>(null);
  const snapshotJson = JSON.stringify(snapshot);
  const preferencesJson = JSON.stringify(preferences);
  const payload = `${snapshotJson}\n${preferencesJson}`;

  async function record() {
    if (busy || disabled || access !== "enabled") return;
    setBusy(true); setError("");
    if (retry.current?.payload !== payload) retry.current = { payload, requestId: crypto.randomUUID() };
    try {
      const id = await save({ snapshotJson, preferencesJson, requestId: retry.current.requestId });
      setSaved({ id, payload });
      retry.current = null;
    } catch (cause) { setError(appErrorMessage(cause, "Could not save this decision. Retry uses the same request ID.")); }
    finally { setBusy(false); }
  }

  return <section className="rounded-lg border p-4" aria-label="Save weekly decision">
    <h2 className="font-semibold">Keep a decision record</h2>
    <p className="mt-2 text-sm text-muted-foreground">Save these inputs, your current starters and this recommendation privately. The server timestamps receipt. After the week closes, compare the two frozen lineups with observed points—no hindsight substitutions.</p>
    <p className="mt-2 text-xs text-muted-foreground">Inputs remain user supplied, including forecasts and roster state. Source gaps stay attached. This does not change your Sleeper lineup.</p>
    {access === "signed-out" ? <p className="mt-3 text-sm">Sign in to save private decisions.</p> : access === "unavailable" ? <p className="mt-3 text-sm">Decision history is not included in your current plan.</p> : <Button className="mt-3" variant="outline" onClick={record} disabled={busy || disabled || access !== "enabled"}>{busy ? "Saving…" : access === "loading" ? "Checking access…" : "Save this decision"}</Button>}
    {disabled && <p className="mt-2 text-xs text-muted-foreground">Resolve blocked inputs and refresh the roster before saving.</p>}
    {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    {saved?.payload === payload && <p role="status" className="mt-3 text-sm">Saved. <Link className="underline" href={`/decisions?record=${encodeURIComponent(saved.id)}`}>View the record</Link>.</p>}
    <Link href="/decisions" className="mt-3 block text-sm underline">Decision history</Link>
  </section>;
}
