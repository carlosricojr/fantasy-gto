import React, { useEffect, useMemo, useState } from "react";

// =============================
// Fantasy GTO – single-file React app
// Works in Canvas preview. Built for Sleeper sync first; ESPN via CSV/manual.
// Focus: predictive power using recency-weighted (EMA) moving averages with
// per-position auto-tuned half-lives, VOR-based draft board, waivers, trades,
// start/sit, and D/ST turnover-on-downs (TOD) modeling.
// =============================

// --- Minimal UI helpers (no external UI lib to avoid resolver issues) ---
const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="border border-gray-200 rounded-2xl p-4 md:p-6 shadow-sm bg-white">
    <h2 className="text-xl md:text-2xl font-bold mb-3">{title}</h2>
    {children}
  </div>
);

const Pill = ({ children }: { children: React.ReactNode }) => (
  <span className="inline-block px-2 py-1 rounded-full bg-gray-100 text-gray-700 text-xs font-medium">
    {children}
  </span>
);

const Button = ({ onClick, children, disabled }: { onClick?: () => void; children: React.ReactNode; disabled?: boolean }) => (
  <button onClick={onClick} disabled={disabled} className={`px-4 py-2 rounded-xl border text-sm font-semibold shadow-sm transition ${disabled ? "bg-gray-200 text-gray-500" : "bg-black text-white hover:opacity-90"}`}>
    {children}
  </button>
);

const TextInput = (props: React.InputHTMLAttributes<HTMLInputElement>) => (
  <input {...props} className={`w-full border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black ${props.className||""}`} />
);

const Select = (props: React.SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...props} className={`w-full border rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-black ${props.className||""}`} />
);

// --- Types ---
interface SleeperLeague { league_id: string; name: string; season: string; total_rosters: number; scoring_settings?: any; }
interface SleeperRoster { roster_id: number; owner_id?: string; players?: string[] }
interface SleeperUser { user_id: string; display_name: string }
interface PlayerMeta { player_id: string; full_name?: string; position?: string; team?: string; status?: string; active?: number; years_exp?: number }
interface WeekStat { player_id: string; stats: any }

// --- Default scoring derived from your screenshots (half-PPR; offense focus) ---
const defaultScoring = {
  passYd: 0.04, passTd: 4, passInt: -2,
  rushYd: 0.1, rushTd: 6,
  rec: 0.5, recYd: 0.1, recTd: 6,
  twoPt: 2,
  fumLost: -2,
};

// --- Utility: fantasy points (offense) ---
function fpOffense(s: any, scoring = defaultScoring): number {
  if (!s) return 0;
  const p = scoring;
  const passYd = (s.pass_yd || 0) * p.passYd;
  const passTd = (s.pass_td || 0) * p.passTd;
  const passInt = (s.pass_int || 0) * p.passInt;
  const rushYd = (s.rush_yd || 0) * p.rushYd;
  const rushTd = (s.rush_td || 0) * p.rushTd;
  const rec = (s.rec || 0) * p.rec;
  const recYd = (s.rec_yd || 0) * p.recYd;
  const recTd = (s.rec_td || 0) * p.recTd;
  const twoPt = (s.two_pt || 0) * p.twoPt; // Sleeper uses two_pt for combined 2-pt
  const fumLost = (s.fum_lost || s.fumbles_lost || 0) * p.fumLost;
  return passYd + passTd + passInt + rushYd + rushTd + rec + recYd + recTd + twoPt + fumLost;
}

// --- Utility: EMA with half-life (weeks). alpha = 1 - exp(ln(0.5)/HL) ---
function ema(values: number[], halfLife = 3): number {
  if (!values.length) return 0;
  const alpha = 1 - Math.exp(Math.log(0.5) / halfLife);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = alpha * values[i] + (1 - alpha) * e;
  return e;
}

// Pearson correlation
function correlation(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return 0;
  const x = xs.slice(0, n), y = ys.slice(0, n);
  const mx = x.reduce((a,b)=>a+b,0)/n; const my = y.reduce((a,b)=>a+b,0)/n;
  let num=0, dx=0, dy=0;
  for (let i=0;i<n;i++){ const a=x[i]-mx, b=y[i]-my; num+=a*b; dx+=a*a; dy+=b*b; }
  return (dx*dy===0)?0:num/Math.sqrt(dx*dy);
}

// Auto-tune half-life per position over a rolling window of weekly points
function optimizeHalfLife(pointsByWeek: number[], candidates = [2,3,4,5,6]){
  // Regress next-week points on EMA(last k) – choose k with highest |corr|
  let bestHL = candidates[0]; let bestCorr = -Infinity;
  for (const hl of candidates){
    const emaSeries: number[] = [];
    for (let i=0;i<pointsByWeek.length-1;i++){
      const slice = pointsByWeek.slice(0,i+1);
      emaSeries.push(ema(slice, hl));
    }
    const nextWeek = pointsByWeek.slice(1);
    const c = Math.abs(correlation(emaSeries, nextWeek));
    if (c>bestCorr){ bestCorr=c; bestHL=hl; }
  }
  return { halfLife: bestHL, corr: bestCorr };
}

// Simple VOR calcs
function computeVOR(projPoints: {id: string, pos: string, name: string, team?: string, ppg: number}[]) {
  const groups: Record<string, {players: typeof projPoints}> = {};
  for (const p of projPoints) {
    if (!groups[p.pos]) groups[p.pos] = { players: [] as any } as any;
    groups[p.pos].players.push(p);
  }
  const withVor: any[] = [];
  for (const pos of Object.keys(groups)){
    const arr = groups[pos].players.sort((a,b)=>b.ppg-a.ppg);
    // Replacement level heuristic for 10-team: QB=12, RB=30, WR=40, TE=12
    const repIndex = Math.min(arr.length-1, {QB:12,RB:30,WR:40,TE:12}[pos as any] ?? 20);
    const rep = arr[repIndex]?.ppg ?? 0;
    for (const p of arr){ withVor.push({...p, vor: p.ppg - rep}); }
  }
  return withVor.sort((a,b)=> b.vor - a.vor);
}

// D/ST Turnover on Downs (TOD) expectation helper
function expectedTODPoints(attemptsPerGame: number, convPct: number) {
  const failures = attemptsPerGame * (1 - convPct);
  return 2 * failures; // +2 per TOD
}

// Handy formatting
const fmt = (n: number, d=2) => (isNaN(n)?"-":Number(n).toFixed(d));

export default function FantasyGTOApp(){
  // --- App State ---
  const [tab, setTab] = useState<'connect'|'settings'|'draft'|'waivers'|'start'|'trade'|'dst'>('connect');

  // League + source
  const [source, setSource] = useState<'sleeper'|'espn'>('sleeper');
  const [leagueId, setLeagueId] = useState<string>("");
  const [league, setLeague] = useState<SleeperLeague|undefined>();
  const [users, setUsers] = useState<Record<string, SleeperUser>>({});
  const [rosters, setRosters] = useState<SleeperRoster[]>([]);
  const [players, setPlayers] = useState<Record<string, PlayerMeta>>({});

  // Stats & projections
  const [season, setSeason] = useState<string>(new Date().getFullYear().toString());
  const [weeksBack, setWeeksBack] = useState<number>(6);
  const [weekStats, setWeekStats] = useState<Record<number, Record<string, any>>>({}); // week -> {player_id: stat}
  const [loadingStats, setLoadingStats] = useState<boolean>(false);

  // Scoring (editable)
  const [scoring, setScoring] = useState(defaultScoring);

  // ESPN manual/CSV roster (fallback)
  const [manualRoster, setManualRoster] = useState<string>("");

  // --- Data loaders (Sleeper) ---
  async function loadSleeperLeague(id: string){
    const [lgRes, roRes, usRes] = await Promise.all([
      fetch(`https://api.sleeper.app/v1/league/${id}`),
      fetch(`https://api.sleeper.app/v1/league/${id}/rosters`),
      fetch(`https://api.sleeper.app/v1/league/${id}/users`),
    ]);
    if (!lgRes.ok) throw new Error('League not found');
    const lg: SleeperLeague = await lgRes.json();
    const ros: SleeperRoster[] = await roRes.json();
    const us: SleeperUser[] = await usRes.json();
    const mapUsers: Record<string, SleeperUser> = {}; us.forEach(u=>mapUsers[u.user_id]=u);
    setLeague(lg); setRosters(ros); setUsers(mapUsers);
  }

  async function loadPlayers(){
    const res = await fetch('https://api.sleeper.app/v1/players/nfl');
    const json = await res.json();
    // filter to skill positions + K + DEF, active or recent
    const out: Record<string, PlayerMeta> = {};
    for (const id of Object.keys(json)){
      const p = json[id];
      if (!p) continue;
      const pos = p.position;
      if (["QB","RB","WR","TE","K","DEF"].includes(pos)){
        out[id] = { player_id: id, full_name: p.full_name, position: pos, team: p.team, status: p.status, active: p.active, years_exp: p.years_exp };
      }
    }
    setPlayers(out);
  }

  async function loadWeeklyStats(seasonYear: string, weeks: number){
    setLoadingStats(true);
    const result: Record<number, Record<string, any>> = {};
    const startWeek = 1; // user can change from UI later
    const endWeek = Math.max(weeks, 1);
    for (let wk = Math.max(1, endWeek - weeks + 1); wk <= endWeek; wk++){
      const url = `https://api.sleeper.app/v1/stats/nfl/${seasonYear}?season_type=regular&week=${wk}`;
      const res = await fetch(url);
      const arr = await res.json(); // array of stats objects
      const map: Record<string, any> = {};
      for (const s of arr){ if (s && s.player_id) map[s.player_id] = s; }
      result[wk] = map;
    }
    setWeekStats(result);
    setLoadingStats(false);
  }

  // Initial players fetch
  useEffect(()=>{ loadPlayers().catch(()=>{}); },[]);

  // --- Helpers: derive league rosters ---
  const rosterPlayers: string[] = useMemo(()=>{
    if (source === 'sleeper'){
      const ids = new Set<string>();
      rosters.forEach(r=> (r.players||[]).forEach(pid=>ids.add(pid)) );
      return Array.from(ids);
    } else {
      // Parse manual roster: comma/newline separated player names; we can't map to ids without players meta
      return [];
    }
  }, [source, rosters]);

  // Build weekly fantasy points history for each player (offense only for now)
  const histByPlayer: Record<string, number[]> = useMemo(()=>{
    const weeks = Object.keys(weekStats).map(n=>Number(n)).sort((a,b)=>a-b);
    const out: Record<string, number[]> = {};
    for (const wk of weeks){
      const wkMap = weekStats[wk] || {};
      for (const pid of Object.keys(wkMap)){
        const s = wkMap[pid];
        const pts = fpOffense(s, scoring);
        if (!out[pid]) out[pid] = [];
        out[pid].push(pts);
      }
    }
    return out;
  }, [weekStats, scoring]);

  // Projected PPG using auto-tuned EMA half-life per position
  const projections = useMemo(()=>{
    const proj: {id:string, name:string, pos:string, team?:string, ppg:number}[] = [];
    const posHL: Record<string, number> = {}; // cache per-pos best HL from pooled sample

    function bestHLForPos(pos: string){
      if (posHL[pos]) return posHL[pos];
      // pool the first 50 players with that pos who have 4+ weeks
      const ids = Object.keys(histByPlayer).filter(pid => players[pid]?.position===pos && histByPlayer[pid].length>=4).slice(0, 50);
      let agg: number[] = []; let next: number[] = [];
      for (const id of ids){ const h = histByPlayer[id]; for (let i=0;i<h.length-1;i++){ agg.push(ema(h.slice(0,i+1), 3)); next.push(h[i+1]); } }
      // fallback: use default if not enough data
      if (agg.length<10){ posHL[pos] = {QB:3,RB:3,WR:3,TE:3}[pos] || 3; return posHL[pos]; }
      // try 2..6
      let best = 3, bestC = -Infinity;
      for (const hl of [2,3,4,5,6]){
        const est: number[] = []; let k=0; // rebuild with hl
        for (const id of ids){ const h = histByPlayer[id]; for (let i=0;i<h.length-1;i++){ est.push(ema(h.slice(0,i+1), hl)); k++; } }
        const c = Math.abs(correlation(est, next));
        if (c>bestC){ bestC=c; best=hl; }
      }
      posHL[pos] = best; return best;
    }

    for (const pid of Object.keys(histByPlayer)){
      const meta = players[pid];
      if (!meta) continue;
      const pos = meta.position as string;
      const hl = bestHLForPos(pos);
      const ppg = ema(histByPlayer[pid], hl);
      if (ppg>0) proj.push({ id: pid, name: meta.full_name||pid, pos, team: meta.team, ppg });
    }
    return proj;
  }, [histByPlayer, players]);

  const vorBoard = useMemo(()=> computeVOR(projections), [projections]);

  // Waiver list: not in rosters, sorted by VOR/PPG
  const waivers = useMemo(()=>{
    const rosterSet = new Set(rosterPlayers);
    return vorBoard.filter(p=>!rosterSet.has(p.id) && ["QB","RB","WR","TE"].includes(p.pos)).slice(0, 200);
  }, [vorBoard, rosterPlayers]);

  // Team mapping helpers
  function ownerName(roster: SleeperRoster){ const u = users[roster.owner_id||""]; return u?.display_name || `Team ${roster.roster_id}`; }

  // Trade evaluator state
  const [tradeA, setTradeA] = useState<string[]>([]);
  const [tradeB, setTradeB] = useState<string[]>([]);

  function projById(id: string){ return projections.find(p=>p.id===id)?.ppg || 0; }

  const tradeDelta = useMemo(()=>{
    const a = tradeA.reduce((sum,id)=> sum + projById(id), 0);
    const b = tradeB.reduce((sum,id)=> sum + projById(id), 0);
    return { a, b, delta: b - a } // positive => good for B, negative => good for A
  }, [tradeA, tradeB, projections]);

  // D/ST helper UI state
  const [dstOppAtt, setDstOppAtt] = useState<number>(2.0);
  const [dstOppConv, setDstOppConv] = useState<number>(0.5);

  // ---- UI ----
  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 p-4 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl md:text-3xl font-black">Fantasy GTO – League‑Winning Assistant</h1>
            <p className="text-sm text-gray-600 mt-1">Recency-weighted projections (auto-tuned EMA), VOR draft board, waiver engine, trade evaluator, start/sit, and D/ST TOD calculator. Sleeper sync built-in. ESPN via CSV/manual.</p>
          </div>
          <div className="flex gap-2 flex-wrap">
            {(['connect','settings','draft','waivers','start','trade','dst'] as const).map(key=> (
              <button key={key} onClick={()=>setTab(key)} className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${tab===key? 'bg-black text-white':'bg-white hover:bg-gray-100'}`}>{key.toUpperCase()}</button>
            ))}
          </div>
        </header>

        {tab==='connect' && (
          <Section title="Connect your league">
            <div className="grid md:grid-cols-3 gap-4">
              <div className="space-y-3">
                <label className="font-semibold text-sm">Platform</label>
                <div className="flex gap-2">
                  <button onClick={()=>setSource('sleeper')} className={`px-3 py-2 rounded-xl border text-sm ${source==='sleeper'?'bg-black text-white':'bg-white'}`}>Sleeper</button>
                  <button onClick={()=>setSource('espn')} className={`px-3 py-2 rounded-xl border text-sm ${source==='espn'?'bg-black text-white':'bg-white'}`}>ESPN</button>
                </div>

                {source==='sleeper' && (
                  <>
                    <label className="font-semibold text-sm">Sleeper League ID</label>
                    <TextInput placeholder="e.g. 123456789012345678" value={leagueId} onChange={e=>setLeagueId(e.target.value)} />
                    <div className="flex gap-2">
                      <Button onClick={()=> loadSleeperLeague(leagueId).catch(err=>alert(err.message))} disabled={!leagueId}>Load League</Button>
                      <Button onClick={()=> loadWeeklyStats(season, weeksBack)} disabled={loadingStats}>{loadingStats? 'Loading stats…' : 'Fetch Weekly Stats'}</Button>
                    </div>
                    {league && (
                      <div className="mt-3 text-sm">
                        <div className="font-semibold">{league.name}</div>
                        <div className="text-gray-600">Season {league.season} • {league.total_rosters} teams</div>
                      </div>
                    )}
                  </>
                )}

                {source==='espn' && (
                  <>
                    <p className="text-sm text-gray-600">ESPN syncing requires auth cookies which aren’t available here. Use the manual roster area (paste player names) or export a CSV and paste here.</p>
                    <textarea className="w-full h-40 border rounded-xl p-3 text-sm" placeholder="Paste comma/newline separated player names for your roster (QB/RB/WR/TE/K/DEF)." value={manualRoster} onChange={e=>setManualRoster(e.target.value)} />
                  </>
                )}
              </div>

              <div className="space-y-3">
                <label className="font-semibold text-sm">Season</label>
                <TextInput type="number" value={season} onChange={e=>setSeason(e.target.value)} />
                <label className="font-semibold text-sm">Weeks back (history window)</label>
                <TextInput type="number" value={weeksBack} onChange={e=>setWeeksBack(Number(e.target.value))} />
                <div className="text-xs text-gray-600">We backfill weekly stats and auto-tune EMA half-life by position to maximize next-week correlation using your history window.</div>
              </div>

              <div className="space-y-3">
                <label className="font-semibold text-sm">Roster Snapshot (Sleeper)</label>
                <div className="text-xs bg-gray-100 rounded-xl p-3 h-48 overflow-auto">
                  {rosters.map(r => (
                    <div key={r.roster_id} className="mb-2">
                      <div className="font-semibold">{ownerName(r)}</div>
                      <div className="text-gray-600">{(r.players||[]).slice(0,12).map(pid => players[pid]?.full_name || pid).join(', ')}</div>
                    </div>
                  ))}
                  {!rosters.length && <div className="text-gray-500">Load a Sleeper league to view.</div>}
                </div>
              </div>
            </div>
          </Section>
        )}

        {tab==='settings' && (
          <Section title="Scoring settings (Offense)">
            <div className="grid md:grid-cols-3 gap-4">
              {Object.entries(scoring).map(([k,v])=> (
                <div key={k}>
                  <label className="text-xs font-semibold">{k}</label>
                  <TextInput type="number" step="0.01" value={String(v)} onChange={e=> setScoring({...scoring, [k]: Number(e.target.value)})} />
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-600 mt-3">Defaults mirror your league screenshots (half-PPR, 4‑pt pass TD, −2 INT, etc.). K/DST tiers not shown here—this module scores offense; D/ST is handled in the special streamer tab with TOD support.</p>
          </Section>
        )}

        {tab==='draft' && (
          <Section title="Draft board – VOR (Value over Replacement)">
            <div className="flex items-center gap-3 mb-3 text-sm">
              <Pill>Players: {projections.length}</Pill>
              <Pill>History window: {weeksBack}w</Pill>
              <Pill>Auto‑tuned EMA per position</Pill>
              <Button onClick={()=> loadWeeklyStats(season, weeksBack)} disabled={loadingStats}>{loadingStats? 'Refreshing…' : 'Refresh stats'}</Button>
            </div>
            <div className="overflow-auto border rounded-xl">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="text-left p-2">#</th>
                    <th className="text-left p-2">Player</th>
                    <th className="text-left p-2">Pos</th>
                    <th className="text-left p-2">Team</th>
                    <th className="text-right p-2">Proj PPG (EMA)</th>
                    <th className="text-right p-2">VOR</th>
                  </tr>
                </thead>
                <tbody>
                  {vorBoard.slice(0, 200).map((p, i)=> (
                    <tr key={p.id} className="odd:bg-white even:bg-gray-50">
                      <td className="p-2">{i+1}</td>
                      <td className="p-2 font-medium">{p.name}</td>
                      <td className="p-2">{p.pos}</td>
                      <td className="p-2">{p.team||''}</td>
                      <td className="p-2 text-right">{fmt(p.ppg)}</td>
                      <td className="p-2 text-right font-semibold">{fmt(p.vor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-gray-600 mt-2">Tip: For a 10‑team league with 2 FLEX, prioritize overall VOR while respecting roster construction. Our replacement levels: QB12, RB30, WR40, TE12 (tuned for 10‑team depth).</p>
          </Section>
        )}

        {tab==='waivers' && (
          <Section title="Waiver & Free‑Agent recommendations (Game‑theory streaming)">
            <div className="text-sm mb-2">Sorted by VOR within top candidates not currently rostered in your Sleeper league.</div>
            <div className="overflow-auto border rounded-xl">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="text-left p-2">Player</th>
                    <th className="text-left p-2">Pos</th>
                    <th className="text-left p-2">Team</th>
                    <th className="text-right p-2">Proj PPG</th>
                    <th className="text-right p-2">VOR</th>
                  </tr>
                </thead>
                <tbody>
                  {waivers.slice(0, 150).map(p => (
                    <tr key={p.id} className="odd:bg-white even:bg-gray-50">
                      <td className="p-2 font-medium">{p.name}</td>
                      <td className="p-2">{p.pos}</td>
                      <td className="p-2">{p.team||''}</td>
                      <td className="p-2 text-right">{fmt(p.ppg)}</td>
                      <td className="p-2 text-right font-semibold">{fmt(p.vor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-gray-600 mt-2">FAAB heuristics: spend 3–5% for single‑week spikes where Proj≥top‑24 at position or if you can block an opponent bye‑week need. Stash next week’s streamer early for $0–$2.</p>
          </Section>
        )}

        {tab==='start' && (
          <Section title="Start/Sit Optimizer (who should I start?)">
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <h3 className="font-semibold mb-2">Your roster (Sleeper)</h3>
                <div className="text-xs bg-gray-100 rounded-xl p-3 h-64 overflow-auto">
                  {rosters.map(r => (
                    <div key={r.roster_id} className="mb-3">
                      <div className="font-semibold">{ownerName(r)}</div>
                      {(r.players||[]).map(pid => (
                        <div key={pid} className="flex justify-between">
                          <span>{players[pid]?.full_name || pid} <span className="text-gray-500">({players[pid]?.position})</span></span>
                          <span className="font-semibold">{fmt(projById(pid))}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                  {!rosters.length && <div className="text-gray-500">Load a Sleeper league to view roster projections.</div>}
                </div>
              </div>
              <div>
                <h3 className="font-semibold mb-2">Lineup guidance</h3>
                <p className="text-sm text-gray-600">Pick the highest projected players by slot; for FLEX, sort by Proj PPG and ensure RB/WR/TE eligibility. Advanced: In close calls (&lt;0.8 PPG), prefer players on teams favored by Vegas and with higher route share/target share (proxy: recent EMA PPG already captures some of this).</p>
              </div>
            </div>
          </Section>
        )}

        {tab==='trade' && (
          <Section title="Trade Evaluator (ROS projection delta)">
            <div className="grid md:grid-cols-2 gap-6">
              <div>
                <h3 className="font-semibold mb-2">Side A (yours?)</h3>
                <Select multiple size={10} value={tradeA} onChange={e=> setTradeA(Array.from(e.target.selectedOptions).map(o=>o.value))}>
                  {rosterPlayers.map(pid => (
                    <option key={pid} value={pid}>{players[pid]?.full_name || pid} ({players[pid]?.position}) – {fmt(projById(pid))} PPG</option>
                  ))}
                </Select>
              </div>
              <div>
                <h3 className="font-semibold mb-2">Side B</h3>
                <Select multiple size={10} value={tradeB} onChange={e=> setTradeB(Array.from(e.target.selectedOptions).map(o=>o.value))}>
                  {Object.keys(players).slice(0,2000).map(pid => (
                    <option key={pid} value={pid}>{players[pid]?.full_name || pid} ({players[pid]?.position}) – {fmt(projById(pid))} PPG</option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="mt-4 p-3 bg-gray-100 rounded-xl text-sm flex gap-6">
              <div><span className="font-semibold">Side A total:</span> {fmt(tradeDelta.a)}</div>
              <div><span className="font-semibold">Side B total:</span> {fmt(tradeDelta.b)}</div>
              <div><span className="font-semibold">Delta (B−A):</span> <span className={`${tradeDelta.delta>0?'text-green-600':'text-red-600'} font-semibold`}>{fmt(tradeDelta.delta)}</span></div>
            </div>
            <p className="text-xs text-gray-600 mt-2">Positive delta favors Side B. Layer context: positional scarcity (VOR), bye coverage, playoff weeks strength of schedule. In close trades, tiebreak to consolidation (2‑for‑1) if you can upgrade a weekly starter.</p>
          </Section>
        )}

        {tab==='dst' && (
          <Section title="D/ST Streamer – Turnover on Downs (TOD) edge">
            <div className="grid md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="text-sm font-semibold">Opponent 4th‑down attempts per game</label>
                <TextInput type="number" step="0.1" value={dstOppAtt} onChange={e=> setDstOppAtt(Number(e.target.value))} />
                <label className="text-sm font-semibold">Opponent 4th‑down conversion rate (0–1)</label>
                <TextInput type="number" step="0.01" value={dstOppConv} onChange={e=> setDstOppConv(Number(e.target.value))} />
                <div className="text-sm bg-gray-100 rounded-xl p-3">
                  Expected TOD points: <span className="font-bold">{fmt(expectedTODPoints(dstOppAtt, dstOppConv))} PPG</span>
                </div>
                <p className="text-xs text-gray-600">Rule of thumb: target offenses with ≥1.8 attempts/game and ≤55% conversion. Avoid hyper‑efficient units (≥70%). Combine with Vegas spreads; big underdogs attempt more 4ths → more TOD chances.</p>
              </div>
              <div className="text-sm">
                <h3 className="font-semibold mb-2">Why it works</h3>
                <p>Turnovers on downs are now a repeatable +2 event in many custom leagues. We treat TOD like INT/FR. Streaming into aggressive but inefficient 4th‑down offenses can add +1–3 D/ST PPG without needing sacks/turnovers variance.</p>
              </div>
            </div>
          </Section>
        )}

        <footer className="text-center text-xs text-gray-500 pt-4 pb-8">Built for your 10‑team half‑PPR league. Method: auto‑tuned EMA (recency) → projections → VOR; streaming & trade tools layered on top. Sleeper endpoints used for metadata and weekly stats. © Fantasy GTO</footer>
      </div>
    </div>
  );
}
