"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";

import { Button } from "@/components/ui/button";
import { ModeToggle } from "@/components/ui/theme-toggle";
import { cn } from "@/components/ui/cn";
import { isActive, navFor, type NavVariant } from "./routes";

/**
 * The header, shared by both route groups.
 *
 * Previously `(app)` and `(marketing)` each had their own, offering different destinations
 * and neither showing which one you were on. One component now renders both, so the brand,
 * the account controls, and the active-state treatment cannot drift apart.
 *
 * On phones the two variants diverge, deliberately:
 *
 * - **App** hides the header links, because `BottomTabs` renders the same destinations
 *   within thumb reach. Keeping both would state the navigation twice.
 * - **Marketing** keeps them, wrapped onto their own full-width row. Hiding them would
 *   leave a phone with no way to reach `/pricing` at all — the landing page links to
 *   `/accuracy` and the two app surfaces, but never to pricing. A previous version of this
 *   header had that bug, fixed it, and left a comment saying so; this reintroduced it for
 *   exactly as long as it took to look at a screenshot.
 *
 * Neither variant scrolls horizontally, which is what the old mobile row did.
 */
export function SiteHeader({ variant }: { variant: NavVariant }) {
  const pathname = usePathname();
  const items = navFor(variant);
  const linksOnMobile = variant === "marketing";

  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div
        className={cn(
          "mx-auto flex max-w-6xl items-center gap-x-6 gap-y-1 px-4 sm:h-14 sm:flex-nowrap sm:px-6 sm:py-0",
          linksOnMobile ? "flex-wrap py-2" : "h-14",
        )}
      >
        <Link href="/" className="shrink-0 font-semibold tracking-tight">
          Fantasy GTO
        </Link>

        <nav
          aria-label="Primary"
          className={cn(
            "items-center gap-1",
            linksOnMobile
              ? "order-last flex w-full sm:order-none sm:w-auto"
              : "hidden sm:flex",
          )}
        >
          {items.map((item) => {
            const current = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  // The underline is always present and transparent when inactive, so the
                  // label does not shift by a pixel when it becomes the current page.
                  // Taller padding from `sm` up so the underline meets the header border;
                  // on the wrapped mobile row it hugs the text instead.
                  "border-b-2 px-3 py-1.5 text-sm transition-colors first:pl-0 sm:py-[1.15rem] sm:first:pl-3",
                  current
                    ? "border-brand font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2">
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
  );
}
