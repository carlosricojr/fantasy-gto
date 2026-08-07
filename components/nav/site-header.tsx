"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";

import { APP_CONTAINER } from "@/components/app-container";
import { Button } from "@/components/ui/button";
import { ModeToggle } from "@/components/ui/theme-toggle";
import { cn } from "@/components/ui/cn";
import { isActive, navFor, type NavItem, type NavVariant } from "./routes";

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
 * - **Marketing** keeps them, on a second row. Hiding them would leave a phone with no way
 *   to reach `/pricing` at all — the landing page links to `/accuracy` and the two app
 *   surfaces, but never to pricing. A previous version of this header had that bug, fixed
 *   it, and left a comment saying so; this reintroduced it for exactly as long as it took
 *   to look at a screenshot.
 *
 * That second row is a separate element placed after the account controls in the DOM,
 * rather than the same nav reordered with `order-last`. Reordering is what a first pass
 * did, and CSS `order` moves an element visually without moving it in the tab sequence:
 * focus jumped from the brand down to the second row and then back up to Sign in. The two
 * rows are exact complements — `hidden sm:flex` against `sm:hidden` — so only one is ever
 * in the accessibility tree, and within each, reading order and focus order agree.
 */
export function SiteHeader({ variant }: { variant: NavVariant }) {
  const pathname = usePathname();
  const items = navFor(variant);
  const linksOnMobile = variant === "marketing";

  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      {/* The app shell widens on large displays and the marketing site does not, so the
          header follows whichever it is sitting on top of. A brand pinned to the far edge
          of a 104rem bar above a 48rem article reads as a broken page; above the draft
          board, which is that wide, it reads as the app frame it is. */}
      <div
        className={
          variant === "app"
            ? `${APP_CONTAINER} px-4 sm:px-6`
            : "mx-auto max-w-6xl px-4 sm:px-6"
        }
      >
        <div className="flex h-14 items-center gap-6">
          <Link href="/" className="shrink-0 font-semibold tracking-tight">
            Fantasy GTO
          </Link>

          <nav aria-label="Primary" className="hidden items-center gap-1 sm:flex">
            {items.map((item) => (
              <HeaderLink key={item.href} item={item} pathname={pathname} />
            ))}
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

        {linksOnMobile && (
          <nav aria-label="Primary" className="flex items-center gap-1 pb-2 sm:hidden">
            {items.map((item) => (
              <HeaderLink key={item.href} item={item} pathname={pathname} compact />
            ))}
          </nav>
        )}
      </div>
    </header>
  );
}

function HeaderLink({
  item,
  pathname,
  compact = false,
}: {
  item: NavItem;
  pathname: string;
  compact?: boolean;
}) {
  const current = isActive(pathname, item.href);
  return (
    <Link
      href={item.href}
      aria-current={current ? "page" : undefined}
      className={cn(
        // The underline is always present and transparent when inactive, so the label does
        // not shift by a pixel when it becomes the current page.
        "border-b-2 px-3 text-sm transition-colors",
        compact ? "py-1.5 first:pl-0" : "py-[1.15rem]",
        current
          ? "border-brand font-medium text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {item.label}
    </Link>
  );
}
