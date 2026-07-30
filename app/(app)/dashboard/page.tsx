"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { EmptyState, PageShell } from "@/components/page-shell";
import { appErrorMessage } from "@/lib/errors";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ROSTER_TEMPLATES, slotsForTemplate } from "@/lib/nfl/roster";
import { SCORING_PRESETS } from "@/lib/nfl/scoring/presets";

/**
 * League management.
 *
 * The free-tier cap is enforced server-side in the same transaction that creates a
 * league, so the error surfaced here is the real one rather than a client-side guess that
 * could be bypassed.
 */
export default function DashboardPage() {
  const leagues = useQuery(api.leagues.list, {});
  const season = useQuery(api.season.current, {});
  const me = useQuery(api.users.me, {});
  const createLeague = useMutation(api.leagues.create);
  const removeLeague = useMutation(api.leagues.remove);

  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState(ROSTER_TEMPLATES[0].id);
  const [scoringId, setScoringId] = useState(SCORING_PRESETS[0].id);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Deleting a league also deletes its roster and cannot be undone, so it is confirmed
  // explicitly rather than fired straight from the list.
  const [pendingDelete, setPendingDelete] = useState<{ id: Id<"leagues">; name: string } | null>(
    null,
  );

  async function onCreate(event: React.FormEvent) {
    event.preventDefault();
    if (!season) return;
    setError(null);
    setBusy(true);
    try {
      await createLeague({
        name: name.trim() || "My league",
        season: season.season,
        platform: "manual",
        externalId: null,
        scoringId,
        slots: slotsForTemplate(templateId).map((slot) => ({
          slotId: slot.id,
          slotLabel: slot.label,
          eligiblePositions: [...slot.eligiblePositions],
          playerId: null,
        })),
      });
      setName("");
    } catch (cause) {
      // Read the ConvexError payload. A plain `error.message` would be the redacted
      // "Server Error" string on a production deployment.
      setError(appErrorMessage(cause, "Could not create that league."));
    } finally {
      setBusy(false);
    }
  }

  // `me` is undefined until the query resolves. Treating that as "free" would flash the
  // free-tier limit at a subscriber on every page load.
  const planKnown = me !== undefined;
  const atFreeLimit = planKnown && me.plan === "free" && (leagues?.length ?? 0) >= 3;

  const subtitle = !planKnown
    ? undefined
    : me.plan === "pro"
      ? "Pro — unlimited leagues"
      : "Free — up to 3 leagues";

  return (
    <PageShell title="My leagues" subtitle={subtitle}>
      {me?.graceRemainingMs != null && (
        <div className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          A payment did not go through. Pro features stay available for{" "}
          {Math.ceil(me.graceRemainingMs / (24 * 60 * 60 * 1000))} more day(s).{" "}
          <Link href="/pricing" className="underline underline-offset-4">
            Update payment
          </Link>
          .
        </div>
      )}

      {leagues === undefined && <p className="text-muted-foreground">Loading…</p>}

      {leagues?.length === 0 && (
        <EmptyState
          title="No leagues yet"
          body="Create a league to save a roster and get start/sit advice for it. You can also use the optimiser without one."
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/lineup">Open the optimiser</Link>
            </Button>
          }
        />
      )}

      {leagues !== undefined && leagues.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {leagues.map((league) => (
            <li key={league._id} className="flex items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{league.name}</p>
                <p className="text-xs text-muted-foreground">
                  {league.season} · {league.scoringId} · {league.platform}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setPendingDelete({ id: league._id, name: league.name })}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}

      <section className="mt-10">
        <h2 className="font-medium">Add a league</h2>

        {atFreeLimit ? (
          <div className="mt-3 rounded-lg border border-dashed p-6 text-center">
            <p className="text-sm text-muted-foreground">
              Free includes three leagues. Pro removes the limit.
            </p>
            <Button asChild size="sm" className="mt-3">
              <Link href="/pricing">See plans</Link>
            </Button>
          </div>
        ) : (
          <form onSubmit={onCreate} className="mt-3 space-y-4">
            <div className="space-y-1">
              <Label htmlFor="league-name">Name</Label>
              <Input
                id="league-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="My league"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="league-format">Roster format</Label>
              <div className="flex flex-wrap gap-2" id="league-format">
                {ROSTER_TEMPLATES.map((template) => (
                  <Button
                    key={template.id}
                    type="button"
                    size="sm"
                    variant={template.id === templateId ? "default" : "outline"}
                    aria-pressed={template.id === templateId}
                    onClick={() => setTemplateId(template.id)}
                    title={template.description}
                  >
                    {template.label}
                  </Button>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="league-scoring">Scoring</Label>
              <div className="flex flex-wrap gap-2" id="league-scoring">
                {SCORING_PRESETS.map((preset) => (
                  <Button
                    key={preset.id}
                    type="button"
                    size="sm"
                    variant={preset.id === scoringId ? "default" : "outline"}
                    aria-pressed={preset.id === scoringId}
                    onClick={() => setScoringId(preset.id)}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button type="submit" disabled={busy || !season}>
              {busy ? "Creating…" : "Create league"}
            </Button>
          </form>
        )}
      </section>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this league?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {pendingDelete?.name} and its roster will be removed. This cannot be undone.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={async () => {
                if (!pendingDelete) return;
                const target = pendingDelete;
                setPendingDelete(null);
                try {
                  await removeLeague({ leagueId: target.id });
                } catch (cause) {
                  setError(appErrorMessage(cause, "Could not delete that league."));
                }
              }}
            >
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
