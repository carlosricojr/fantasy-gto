import { Button } from "@/components/ui/button";
import Link from "next/link";

export default function DashboardPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="mt-2 text-foreground/80">Import your ESPN league to get started.</p>
      <div className="mt-6 flex gap-3">
        <Link href="/api/import"><Button variant="outline">Import League</Button></Link>
        <Link href="/(app)/projections"><Button>View Projections</Button></Link>
      </div>
    </main>
  );
}


