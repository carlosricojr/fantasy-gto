"use client";

import { Component, useState, type ReactNode } from "react";
import { SignInButton, useAuth } from "@clerk/nextjs";
import { useConvexAuth, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { PageShell } from "@/components/page-shell";
import { Button } from "@/components/ui/button";
import { appErrorMessage } from "@/lib/errors";
import { useStableQuery } from "@/components/use-stable-query";

/** Mount data-query consumers only after both the JWT and application user are ready. */
export function PrivateDataGate({ title, children }: { title: string; children?: ReactNode }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { userId } = useAuth();
  const { data: me, pending: accountPending } = useStableQuery(api.users.me, isAuthenticated ? {} : "skip");
  const ensure = useMutation(api.users.ensure);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A held account response is never authorization. Skip clears it on sign-out, and
  // pending blocks mounting consumers while a live answer is unavailable.
  if (isLoading || (isAuthenticated && (me === undefined || accountPending))) {
    return <PageShell title={title}><p role="status">Checking account access…</p></PageShell>;
  }
  if (!isAuthenticated) return <PageShell title={title}>
    <p className="text-sm text-muted-foreground">Sign in to your Fantasy GTO account to load data. Hosting access alone does not sign you into the app.</p>
    <SignInButton mode="modal"><Button className="mt-4">Sign in to load data</Button></SignInButton>
  </PageShell>;
  if (!me?.signedIn) return <PageShell title={title}>
    <p className="text-sm">Your sign-in is confirmed, but your app account is not ready yet. Data queries remain paused.</p>
    <Button className="mt-4" disabled={retrying} onClick={async () => {
      setRetrying(true);
      setError(null);
      try { await ensure({}); }
      catch (cause) { setError(appErrorMessage(cause, "Account setup failed. Please retry.")); }
      finally { setRetrying(false); }
    }}>{retrying ? "Setting up account…" : "Retry account setup"}</Button>
    {error === null ? null : <p role="alert" className="mt-2 text-sm">{error}</p>}
  </PageShell>;
  // Unmount on sign-out and reset the boundary on account changes, so cached page state
  // is not displayed as a currently authorized response for a different identity.
  return <PrivateReadBoundary key={userId} title={title}>{children}</PrivateReadBoundary>;
}

class PrivateReadBoundary extends Component<{ title: string; children: ReactNode }, { error: unknown | null }> {
  state: { error: unknown | null } = { error: null };
  static getDerivedStateFromError(error: unknown) { return { error }; }
  render() {
    if (this.state.error !== null) return <PageShell title={this.props.title}>
      <div role="alert">
        <h2 className="font-semibold">Data could not be loaded</h2>
        <p className="mt-2 text-sm">{appErrorMessage(this.state.error, "The data request failed. Try again or contact the operator.")}</p>
        <p className="mt-2 text-sm text-muted-foreground">No partial pool is being used for recommendations. Saved drafts have not been deleted.</p>
      </div>
      <Button className="mt-4" onClick={() => this.setState({ error: null })}>Retry data</Button>
    </PageShell>;
    return this.props.children;
  }
}
