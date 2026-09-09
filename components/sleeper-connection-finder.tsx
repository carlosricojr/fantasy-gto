"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { weeklyLineupHref, type SleeperConnection } from "@/lib/nfl/sleeper-connection";

export function SleeperConnectionFinder({ onSelect, saveConnection }: { onSelect?: (connection: SleeperConnection, week: number) => void; saveConnection?: (connection: SleeperConnection) => Promise<void> }) {
  const [username, setUsername] = useState("");
  const [leagueInput, setLeagueInput] = useState("");
  const [found, setFound] = useState<{ connections: SleeperConnection[]; week: number; warnings: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  return <section className="rounded-lg border p-4">
    <h2 className="font-semibold">Find your Sleeper team</h2>
    <p className="mt-1 text-sm text-muted-foreground">Enter your username to find current leagues, or paste a league link and choose your team. Public lookup does not authenticate a Sleeper account.</p>
    <form className="mt-3 space-y-3" onSubmit={async (event) => {
      event.preventDefault(); setBusy(true); setMessage(""); setFound(null);
      try {
        const response = await fetch("/api/sleeper-connections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, leagueInput }), cache: "no-store" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Lookup failed.");
        setFound(body);
      } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Lookup failed."); }
      finally { setBusy(false); }
    }}>
      <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Sleeper username or user ID<Input value={username} onChange={(e) => setUsername(e.target.value)} maxLength={40} placeholder="Your username" /></label><label className="text-sm">League URL or ID (optional with username)<Input value={leagueInput} onChange={(e) => setLeagueInput(e.target.value)} maxLength={300} placeholder="https://sleeper.com/leagues/…" /></label></div>
      <Button size="sm" disabled={busy || (!username.trim() && !leagueInput.trim())}>{busy ? "Looking up…" : "Find teams"}</Button>
    </form>
    {message && <p role="status" className="mt-3 text-sm">{message}</p>}
    {found && <div className="mt-4 space-y-2">{found.warnings.map((warning) => <p key={warning} className="text-sm text-amber-700 dark:text-amber-300">{warning}</p>)}{found.connections.map((connection) => <div key={`${connection.leagueId}:${connection.ownerId}`} className="flex flex-wrap items-center justify-between gap-2 rounded border p-3 text-sm"><span>{connection.leagueName} · {connection.username} · {connection.season}</span><div className="flex gap-2">{onSelect ? <Button size="sm" variant="outline" onClick={() => onSelect(connection, found.week)}>Use this team</Button> : <Button asChild size="sm" variant="outline"><Link href={weeklyLineupHref(connection, found.week)}>Open weekly lineup</Link></Button>}{saveConnection && <Button size="sm" disabled={busy} onClick={async () => { setBusy(true); setMessage(""); try { await saveConnection(connection); setMessage("Saved privately to My leagues."); } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Could not save connection."); } finally { setBusy(false); } }}>Save connection</Button>}</div></div>)}</div>}
  </section>;
}
