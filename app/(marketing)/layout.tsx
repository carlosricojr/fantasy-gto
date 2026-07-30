import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ModeToggle } from "@/components/ui/theme-toggle";
import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";

export default function MarketingLayout({
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
              <Link href="/pricing" className="hover:underline">Pricing</Link>
              <Link href="/projections" className="hover:underline">Projections</Link>
              <Link href="/accuracy" className="hover:underline">Accuracy</Link>
            </nav>
          </div>
          <div className="flex items-center gap-2">
            <ModeToggle />
            <SignedOut>
              <SignInButton mode="modal">
                <Button size="sm" variant="outline">Sign in</Button>
              </SignInButton>
            </SignedOut>
            <SignedIn>
              <UserButton afterSignOutUrl="/" />
            </SignedIn>
          </div>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t py-6">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 text-sm text-foreground/60">
          <span>Fantasy GTO</span>
          <Link href="/accuracy" className="hover:text-foreground">
            How accurate is this?
          </Link>
        </div>
      </footer>
    </div>
  );
}


