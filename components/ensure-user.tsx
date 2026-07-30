"use client";

import { useEffect, useRef } from "react";
import { useAuth } from "@clerk/nextjs";
import { useMutation } from "convex/react";

import { api } from "@/convex/_generated/api";

/**
 * Provisions a `users` row for the signed-in caller.
 *
 * Without this, the only path that creates a user is the Clerk `user.created` webhook. If
 * that webhook is not configured, is delayed, or failed once, the account has no row and
 * every `requireUser` guard throws — the user can sign in and then be unable to create a
 * league, with no way to recover from the interface.
 *
 * The mutation is idempotent and returns immediately when the row exists, so the cost of
 * calling it is one indexed lookup per session. It runs once per mount rather than on
 * every render, and failures are deliberately swallowed: a user who already has a row
 * loses nothing, and one who does not will retry on their next navigation.
 */
export function EnsureUser() {
  const { isSignedIn, isLoaded, userId } = useAuth();
  const ensure = useMutation(api.users.ensure);
  // Latched against the user id rather than a boolean: signing out and back in as someone
  // else would otherwise leave the flag set and skip provisioning the second account.
  const provisionedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !userId) return;
    if (provisionedFor.current === userId) return;
    provisionedFor.current = userId;
    void ensure({}).catch(() => {
      // Clear the latch so the next navigation retries.
      if (provisionedFor.current === userId) provisionedFor.current = null;
    });
  }, [isLoaded, isSignedIn, userId, ensure]);

  return null;
}
