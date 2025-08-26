"use client";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useState } from "react";

export default function DashboardPage() {
  const [res, setRes] = useState<string | null>(null);
  async function onSubmit(formData: FormData) {
    const leagueId = String(formData.get("leagueId") || "").trim();
    const season = Number(formData.get("season") || 2024);
    const s2 = String(formData.get("s2") || "").trim() || undefined;
    const swid = String(formData.get("swid") || "").trim() || undefined;
    const resp = await fetch("/api/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leagueId, season, s2, swid }),
    });
    const json = await resp.json();
    setRes(JSON.stringify(json));
  }
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="mt-2 text-foreground/80">Import your ESPN league to get started.</p>
      <div className="mt-6 flex gap-3">
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline">Import League</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Import ESPN League</DialogTitle>
            </DialogHeader>
            <form action={onSubmit} className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="leagueId">League ID</Label>
                <Input id="leagueId" name="leagueId" required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="season">Season</Label>
                <Input id="season" name="season" defaultValue="2024" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="s2">ESPN S2 (optional)</Label>
                <Input id="s2" name="s2" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="swid">ESPN SWID (optional)</Label>
                <Input id="swid" name="swid" />
              </div>
              <Button type="submit">Start Import</Button>
            </form>
            {res && <pre className="mt-3 text-xs text-foreground/70">{res}</pre>}
          </DialogContent>
        </Dialog>
        <Link href="/projections"><Button>View Projections</Button></Link>
      </div>
    </main>
  );
}


