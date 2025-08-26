import { Card, CardContent, CardHeader } from "@/components/ui/card";
import AccuracyWidget from "@/components/accuracy-widget";
import WithEntitlement from "@/components/withEntitlement";

export default function ProjectionsPage() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-12 space-y-6">
      <h1 className="text-2xl font-semibold">Projections</h1>
      <WithEntitlement entitlement="accuracy_dashboard">
        <Card>
          <CardHeader>Accuracy comparison (GTO vs ESPN/Yahoo)</CardHeader>
          <CardContent>
            <AccuracyWidget />
          </CardContent>
        </Card>
      </WithEntitlement>
    </main>
  );
}


