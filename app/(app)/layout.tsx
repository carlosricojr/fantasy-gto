import Link from "next/link";
import { ModeToggle } from "@/components/ui/theme-toggle";
import { UserButton } from "@clerk/nextjs";

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-dvh flex flex-col">
      <header className="w-full border-b">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/" className="font-semibold">Fantasy GTO</Link>
            <nav className="hidden sm:flex items-center gap-4 text-sm text-foreground/80">
              <Link href="/dashboard" className="hover:underline">Dashboard</Link>
              <Link href="/projections" className="hover:underline">Projections</Link>
              <Link href="/lineup" className="hover:underline">Lineup</Link>
            </nav>
          </div>
          <div className="flex items-center gap-2">
            <ModeToggle />
            <UserButton afterSignOutUrl="/" />
          </div>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t py-6 text-center text-sm text-foreground/60">© {new Date().getFullYear()} Fantasy GTO</footer>
    </div>
  );
}


