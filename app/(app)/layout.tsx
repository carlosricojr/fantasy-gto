import Link from "next/link";
import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";

import { Button } from "@/components/ui/button";
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
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex items-center gap-4">
            <Link href="/" className="font-semibold">
              Fantasy GTO
            </Link>
            <nav className="hidden items-center gap-4 text-sm text-muted-foreground sm:flex">
              <Link href="/projections" className="hover:text-foreground">
                Projections
              </Link>
              <Link href="/lineup" className="hover:text-foreground">
                Lineup
              </Link>
              <SignedIn>
                <Link href="/dashboard" className="hover:text-foreground">
                  My leagues
                </Link>
              </SignedIn>
            </nav>
          </div>

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
