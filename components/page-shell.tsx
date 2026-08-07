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
  subtitle?: string;
  /** Controls that belong beside the title rather than in the content. */
  actions?: React.ReactNode;
  /**
   * `wide` matches the header's own `max-w-6xl`.
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
      className={cn(
        "mx-auto",
        size === "wide" ? "max-w-6xl px-4 py-6 sm:px-6" : "max-w-3xl px-6 py-10",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
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
