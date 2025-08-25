import { Card, CardContent, CardHeader } from "@/components/ui/card";

export default function ProjectionsPage() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-12 space-y-6">
      <h1 className="text-2xl font-semibold">Projections</h1>
      <Card>
        <CardHeader>Accuracy comparison (GTO vs ESPN/Yahoo)</CardHeader>
        <CardContent>
          <p className="text-sm text-foreground/70">Coming soon. Benchmarked weekly.</p>
        </CardContent>
      </Card>
    </main>
  );
}


