import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function MarketingPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-4xl font-bold">Fantasy GTO</h1>
      <p className="mt-3 text-lg text-foreground/80">+8.2 points/week vs platform projections.</p>
      <div className="mt-8 flex gap-4">
        <Link href="/dashboard"><Button>Try free (no signup)</Button></Link>
        <Link href="/projections"><Button variant="outline">See projections</Button></Link>
      </div>
    </main>
  );
}


