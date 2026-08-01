"use client";

import { useEffect } from "react";

import { Button } from "@/components/ui/button";

/**
 * The last line of defence for the signed-in surfaces.
 *
 * Without one of these, a throw during render replaces the whole page with Next's client
 * exception screen and the only way back is a reload. That is exactly what happened when a
 * decimal typed into a draft slot reached a function that had just been given an integer
 * guard: a defensible guard, in a place with nothing above it to catch the result.
 *
 * The specific input bug is fixed at the source, and the domain functions still refuse
 * nonsense rather than inventing an answer. This exists because the next one has not been
 * found yet — a draft board is used once a year, under time pressure, and losing the
 * screen mid-draft is the worst moment for it.
 *
 * Deliberately no stack trace or error text in the body. It would be meaningless to
 * somebody trying to make a pick, and the message can carry internals.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Goes to the browser console and, in production, to Vercel's log drain. A boundary
    // that swallows the cause silently trades one debugging problem for a worse one.
    console.error("Unhandled error in the application shell", error);
  }, [error]);

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Something broke</h1>
      <p className="mt-3 text-muted-foreground">
        This screen hit an error it could not recover from on its own. Nothing you entered
        has been sent anywhere, and trying again usually works — a draft in progress is
        held in this tab, so reloading will lose the picks you have recorded, while the
        button below will not.
      </p>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button onClick={reset}>Try again</Button>
        <Button variant="outline" onClick={() => window.location.reload()}>
          Reload the page
        </Button>
      </div>
      {error.digest === undefined ? null : (
        <p className="mt-6 text-xs text-muted-foreground">
          Reference: {error.digest}
        </p>
      )}
    </main>
  );
}
