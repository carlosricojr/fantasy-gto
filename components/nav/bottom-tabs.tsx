"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/components/ui/cn";
import { APP_NAV, isActive } from "./routes";

/**
 * Primary navigation on phones, for the signed-in surfaces.
 *
 * The manifest declares `display: standalone`, so this sits directly above the home
 * indicator on an installed PWA and needs the safe-area inset — without it the labels are
 * under the gesture bar on every modern iPhone.
 *
 * Hidden from `sm` up with `sm:hidden`, which is `display: none` and therefore removes it
 * from the accessibility tree as well as the layout. That is deliberate: the header renders
 * the same destinations at that width, and two simultaneous "Primary" navigations would be
 * announced as duplicates.
 *
 * Every tab renders in both auth states, including "My leagues", which is behind
 * `middleware.ts` and sends a signed-out visitor to sign-in. Gating it on Clerk's
 * `<SignedIn>` would be more literal, but that resolves after hydration, so the bar would
 * visibly reflow from three tabs to four on load. A stable bar whose last tab prompts for
 * an account is the better trade on a surface people open cold.
 */
export function BottomTabs() {
  const pathname = usePathname();
  const items = APP_NAV;

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background pb-[env(safe-area-inset-bottom)] sm:hidden"
    >
      <ul className="mx-auto flex max-w-lg items-stretch">
        {items.map((item) => {
          const current = isActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  // 56px tall clears the 44px minimum touch target with room to spare.
                  "relative flex h-14 flex-col items-center justify-center gap-1 text-[0.6875rem] transition-colors",
                  current
                    ? "font-medium text-brand"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {/* Color alone would fail 1.4.1, so the current tab also carries a bar. */}
                <span
                  aria-hidden
                  className={cn(
                    "absolute inset-x-3 top-0 h-0.5 rounded-full",
                    current ? "bg-brand" : "bg-transparent",
                  )}
                />
                <Icon aria-hidden className="size-5" strokeWidth={current ? 2.25 : 1.75} />
                {item.shortLabel ?? item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
