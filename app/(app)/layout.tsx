import Link from "next/link";
import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";

import { Button } from "@/components/ui/button";
import { EnsureUser } from "@/components/ensure-user";
import { ModeToggle } from "@/components/ui/theme-toggle";

/**
 * Application chrome.
 *
 * Renders for signed-out visitors too, because projections and the lineup optimiser are
 * open. The header therefore has to handle both states rather than assuming a user, which
 * the previous version did by rendering a bare `UserButton`.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <EnsureUser />
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 sm:h-14 sm:flex-nowrap sm:px-6 sm:py-0">
          <Link href="/" className="font-semibold">
            Fantasy GTO
          </Link>

          {/*
            Below `sm` the nav wraps onto its own full-width row instead of being hidden.
            Hiding it left a phone with no navigation at all beyond the brand link, on a
            product whose primary surface is a phone. `mr-auto` from `sm` up keeps the
            desktop layout as it was: brand and nav left, account controls right.
          */}
          <nav
            aria-label="Primary"
            className="order-last flex w-full items-center gap-4 overflow-x-auto text-sm text-muted-foreground sm:order-none sm:mr-auto sm:w-auto sm:overflow-visible"
          >
            <Link href="/projections" className="hover:text-foreground">
              Projections
            </Link>
            <Link href="/lineup" className="hover:text-foreground">
              Lineup
            </Link>
            <Link href="/draft" className="hover:text-foreground">
              Draft
            </Link>
            <SignedIn>
              <Link href="/dashboard" className="hover:text-foreground">
                My leagues
              </Link>
            </SignedIn>
          </nav>

          <div className="flex items-center gap-2">
            <ModeToggle />
            <SignedOut>
              <SignInButton mode="modal">
                <Button size="sm" variant="outline">
                  Sign in
                </Button>
              </SignInButton>
            </SignedOut>
            <SignedIn>
              <UserButton />
            </SignedIn>
          </div>
        </div>
      </header>

      <div className="flex-1">{children}</div>

      <footer className="border-t py-6">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 text-sm text-muted-foreground">
          <span>Fantasy GTO</span>
          <Link href="/accuracy" className="hover:text-foreground">
            How accurate is this?
          </Link>
        </div>
      </footer>
    </div>
  );
}
