"use client";

import { Button } from "@/components/ui/button";
import type { PlayerRisk } from "@/lib/core/roster-utility";

export function MarketFirstCard({ player, onPick }: { player: PlayerRisk; onPick: (id: string) => void }) {
  return <section className="rounded-xl border p-4" aria-label="Market-first legal option">
    <h2 className="text-sm font-semibold">Market-first legal option</h2>
    <p className="mt-2 text-lg font-semibold">{player.name} <span className="text-sm font-normal text-muted-foreground">· {player.position}</span></p>
    <p className="mt-1 text-sm">Board ADP {player.adp?.toFixed(1)} · FantasyFootballCalculator</p>
    <p className="mt-2 text-xs text-muted-foreground">Lowest ADP among current options allowed by the roster-completion guard. This is a simple comparator, not a proven best pick. Future opponents can still take needed players. FFC prices may differ from Sleeper.</p>
    <Button variant="outline" className="mt-3 w-full" onClick={() => onPick(player.id)}>Record {player.name}</Button>
  </section>;
}
