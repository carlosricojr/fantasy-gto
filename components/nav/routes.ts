import {
  BarChart3,
  ClipboardList,
  CreditCard,
  ListChecks,
  Target,
  Trophy,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  /** Full label, used in the header and as the accessible name everywhere. */
  label: string;
  /** Shorter form for the bottom bar, where four labels share the screen width. */
  shortLabel?: string;
  icon: LucideIcon;
}

/**
 * The two navigations, defined once.
 *
 * The header and the bottom bar render from the same arrays, so a route cannot appear in
 * one and be forgotten in the other — which is how the previous chrome ended up offering
 * different destinations depending on whether you were on a marketing page or an app page.
 */
export const APP_NAV: readonly NavItem[] = [
  { href: "/projections", label: "Projections", shortLabel: "Proj", icon: BarChart3 },
  { href: "/lineup", label: "Lineup", icon: ListChecks },
  { href: "/draft", label: "Draft", icon: ClipboardList },
  { href: "/dashboard", label: "My leagues", shortLabel: "Leagues", icon: Trophy },
];

export const MARKETING_NAV: readonly NavItem[] = [
  { href: "/projections", label: "Projections", shortLabel: "Proj", icon: BarChart3 },
  { href: "/accuracy", label: "Accuracy", icon: Target },
  { href: "/pricing", label: "Pricing", icon: CreditCard },
];

export type NavVariant = "app" | "marketing";

/**
 * Resolved inside the client components rather than passed in from the layouts.
 *
 * `icon` holds a component, and a Server Component cannot hand a function to a Client
 * Component — the layouts render on the server, so passing these arrays as props failed at
 * runtime with "Functions cannot be passed directly to Client Components". Typecheck and
 * the whole suite were green; only loading a page surfaced it. A variant string crosses
 * that boundary fine, and the array is looked up on the client side of it.
 */
export function navFor(variant: NavVariant): readonly NavItem[] {
  return variant === "app" ? APP_NAV : MARKETING_NAV;
}

/**
 * Whether a nav item is the current page.
 *
 * Prefix matching so a future `/lineup/[id]` still lights its tab, but only on a segment
 * boundary — a plain `startsWith` would mark `/draft` active on a hypothetical
 * `/draft-history`.
 */
export function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
