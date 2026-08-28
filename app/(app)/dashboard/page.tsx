"use client";

import { useState } from "react";
import Link from "next/link";
import { useConvexAuth, useMutation, useQuery } from "convex/react";

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
import { describeLeagueCap, limit, planCapabilities } from "@/lib/billing/entitlements";
import { ROSTER_TEMPLATES, slotsForTemplate } from "@/lib/nfl/roster";
import { SCORING_PRESETS } from "@/lib/nfl/scoring/presets";
import { Skeleton } from "@/components/ui/skeleton";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SUPPORTED_LEAGUE_SIZES } from "@/lib/nfl/draft/league-size";
import { CHAMPIONSHIP_WEEKS, PLAYOFF_FIELDS } from "@/lib/nfl/league-rules";
import {
  dashboardSeasonSummary,
  DEFAULT_DASHBOARD_LEAGUE_RULES,
  persistedLeagueRules,
} from "./league-rules";

/**
 * League management.
 *
 * The free-tier cap is enforced server-side in the same transaction that creates a
 * league, so the error surfaced here is the real one rather than a client-side guess that
 * could be bypassed.
 */
export default function DashboardPage() {
  // Convex answers queries before Clerk's token arrives, and an unauthenticated
  // `users.me` resolves to the anonymous free-tier shape rather than staying undefined.
  // Checking `me !== undefined` alone therefore cannot tell "still loading" from
  // "answered as anonymous", and a Pro subscriber would be shown the free-tier cap and
  // "No leagues yet" for as long as clerk-js takes to load.
  const { isLoading: authLoading } = useConvexAuth();
  const leagues = useQuery(api.leagues.list, {});
  const season = useQuery(api.season.current, {});
  const me = useQuery(api.users.me, {});
  const createLeague = useMutation(api.leagues.create);
  const removeLeague = useMutation(api.leagues.remove);

  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState(ROSTER_TEMPLATES[0].id);
  const [teams, setTeams] = useState(DEFAULT_DASHBOARD_LEAGUE_RULES.teams);
  const [scoringId, setScoringId] = useState(
    DEFAULT_DASHBOARD_LEAGUE_RULES.scoringId,
  );
  const [playoffTeams, setPlayoffTeams] = useState(
    DEFAULT_DASHBOARD_LEAGUE_RULES.playoffTeams,
  );
  const [championshipWeek, setChampionshipWeek] = useState(
    DEFAULT_DASHBOARD_LEAGUE_RULES.championshipWeek,
  );
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
        ...persistedLeagueRules({
          teams,
          scoringId,
          playoffTeams,
          championshipWeek,
        }),
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

  // Read the cap from the entitlement table rather than repeating it in prose. The moment
  // the table changes, a hard-coded number would put /dashboard and /pricing in
  // disagreement and let a capped user submit a form the server rejects. `freeLeagues` is
  // the number for the comparison; `describeLeagueCap` supplies the phrase, so the copy
  // stays grammatical at a cap of one.
  const freePlan = planCapabilities("free");
  const freeLeagues = limit(freePlan, "league_count");
  const planKnown = !authLoading && me !== undefined;
  const leaguesKnown = !authLoading && leagues !== undefined;
  const atFreeLimit =
    planKnown && me.plan === "free" && (leagues?.length ?? 0) >= freeLeagues;

  const subtitle = !planKnown
    ? undefined
    : me.plan === "pro"
      ? `Pro — ${describeLeagueCap(planCapabilities("pro"))}`
      : `Free — up to ${describeLeagueCap(freePlan)}`;

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

      {error && (
        <p className="mb-4 rounded-lg border border-destructive/40 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {!leaguesKnown && (
        // The list that arrives, at its height. This one is a smaller shift than the other
        // two — a league row is 72px and most people have one or two — but it is the same
        // fix and the same reason.
        <div className="space-y-2" aria-busy>
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} className="h-[72px] rounded-lg" />
          ))}
          <p className="sr-only">Loading your leagues.</p>
        </div>
      )}

      {leaguesKnown && leagues.length === 0 && (
        <EmptyState
          title="No leagues yet"
          body="Create a league to record its scoring and roster format. Start/sit today lives in the optimizer, which works without a league."
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/lineup">Open the optimizer</Link>
            </Button>
          }
        />
      )}

      {leaguesKnown && leagues.length > 0 && (
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
              Free includes {describeLeagueCap(freePlan)}. Pro removes the limit.
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
              {/* htmlFor only binds to labelable elements, and a div is not one. The
                  group needs role + aria-labelledby or it has no accessible name. */}
              <span id="league-format-label" className="text-sm font-medium">
                Roster format
              </span>
              <div
                className="flex flex-wrap gap-2"
                role="group"
                aria-labelledby="league-format-label"
              >
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

            <div className="space-y-6">
              <DashboardField
                label="Teams"
                hint="Boards are built per league size"
              >
                <SegmentedControl
                  label="League size"
                  value={teams}
                  onChange={(nextTeams) => {
                    setTeams(nextTeams);
                    if (playoffTeams >= nextTeams) {
                      setPlayoffTeams(
                        PLAYOFF_FIELDS.find((field) => field < nextTeams)!,
                      );
                    }
                  }}
                  options={SUPPORTED_LEAGUE_SIZES.map((size) => ({
                    value: size,
                    label: String(size),
                  }))}
                />
              </DashboardField>

              <DashboardField label="Scoring">
                <SegmentedControl
                  label="Scoring"
                  value={scoringId}
                  onChange={setScoringId}
                  options={SCORING_PRESETS.map((preset) => ({
                    value: preset.id,
                    label: preset.label,
                  }))}
                />
              </DashboardField>

              <DashboardField
                label="Playoff teams"
                hint="How many make the bracket, which is what the odds are odds of"
              >
                <SegmentedControl
                  label="Playoff teams"
                  value={playoffTeams}
                  onChange={setPlayoffTeams}
                  options={PLAYOFF_FIELDS.filter((field) => field < teams).map(
                    (field) => ({
                      value: field,
                      label: String(field),
                    }),
                  )}
                />
              </DashboardField>

              <DashboardField
                label="Championship week"
                hint="The last week you play. Leagues often end early to keep the final out of the NFL weeks where teams rest starters."
              >
                <SegmentedControl
                  label="Championship week"
                  value={championshipWeek}
                  onChange={setChampionshipWeek}
                  options={CHAMPIONSHIP_WEEKS.map((week) => ({
                    value: week,
                    label: `Week ${week}`,
                  }))}
                />
                <p className="mt-2 text-xs text-muted-foreground tabular-nums">
                  {dashboardSeasonSummary({
                    teams,
                    scoringId,
                    playoffTeams,
                    championshipWeek,
                  })}
                </p>
              </DashboardField>
            </div>

            {!season && (
              <p className="text-sm text-muted-foreground">
                No NFL schedule has been ingested yet, so a league cannot be created. See
                the seeding steps in the README.
              </p>
            )}

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

function DashboardField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-sm font-medium">{label}</p>
      {hint === undefined ? null : (
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      )}
      <div className="mt-2">{children}</div>
    </div>
  );
}
