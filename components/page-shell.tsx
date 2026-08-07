import { APP_CONTAINER } from "@/components/app-container";
import { cn } from "@/lib/utils";

/** Shared page chrome, so every screen frames its title and empty states identically. */
export function PageShell({
  title,
  subtitle,
  actions,
  size = "default",
  children,
}: {
  title: string;
  /**
   * `ReactNode`, not `string`, so a screen that does not know its subtitle yet can reserve
   * the line with a skeleton. It was a string, and the two pages that load a season
   * rendered no subtitle at all while loading and one after — moving everything below them
   * down by the height of this paragraph at the exact moment their skeletons existed to
   * stop the page moving.
   */
  subtitle?: React.ReactNode;
  /** Controls that belong beside the title rather than in the content. */
  actions?: React.ReactNode;
  /**
   * `wide` opens the shell up to the width the display actually has, and the header and
   * the footer follow it — see `data-shell` below.
   *
   * Reading text wants a narrow measure, which is what the default is for. A draft board
   * is a grid of fourteen columns and is not read, it is scanned — squeezing it into a
   * prose column costs the one thing it exists to show.
   */
  size?: "default" | "wide";
  children: React.ReactNode;
}) {
  return (
    <main
      // Read by `[data-app-shell]:has(...)` in `app/globals.css`, which is how the header
      // and the footer end up inset by exactly as much as whatever page is under them,
      // without the layout having to hold a list of which routes are wide.
      data-shell={size}
      className={cn(
        size === "wide"
          ? `${APP_CONTAINER} px-4 py-6 sm:px-6`
          : "mx-auto max-w-3xl px-6 py-10",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">{title}</h1>
          {/* A `div`, not a `p`. The subtitle takes a `ReactNode` so a screen can reserve
              the line with a skeleton, and `p` may only contain phrasing content — today's
              skeleton is a `span` and legal, but the type now admits a `div`, and the
              failure that would produce is a hydration mismatch rather than a lint error.
              Nothing here depended on the paragraph semantics. */}
          {subtitle && <div className="mt-1 text-sm text-muted-foreground">{subtitle}</div>}
        </div>
        {actions}
      </div>
      <div className="mt-6">{children}</div>
    </main>
  );
}

/**
 * An explicit empty state.
 *
 * Used wherever data may legitimately be absent — during the offseason, before an ingest
 * has run, or for a week with no projections. Rendering nothing in those cases reads as a
 * bug, which is what the previous version did.
 */
export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed p-8 text-center">
      <p className="font-medium">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
