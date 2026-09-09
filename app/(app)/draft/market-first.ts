import type { DraftPolicyState } from "@/lib/core/draft-policy";
import { guardDraftCompletion } from "@/lib/core/draft-feasibility";
import type { RosterSlot } from "@/lib/core/optimizer";
import type { PlayerRisk } from "@/lib/core/roster-utility";

/** A transparent comparator at the current own turn, never a future availability forecast. */
export function marketFirstOption(state: DraftPolicyState, slots: readonly RosterSlot[]): PlayerRisk | null {
  const own = state.teams[state.myTeamIndex];
  if (!own || slots.length === 0) return null;
  const picks = [...own.remainingPicks].sort((a, b) => a - b);
  const allPicks = state.teams.flatMap(team => team.remainingPicks);
  if (picks.length === 0 || picks[0] !== Math.min(...allPicks)) return null;
  const room = (own.draftRosterSize ?? state.rosterSize) - own.roster.length;
  const remaining = Math.min(room, picks.length);
  if (remaining <= 0) return null;
  const held = new Set(state.teams.flatMap(team => team.roster.map(player => player.id)));
  const intervening = state.teams.flatMap((team, index) => index === state.myTeamIndex ? [] : team.remainingPicks)
    .filter(pick => pick > picks[0] && pick < (picks[1] ?? Infinity)).length;
  const guard = guardDraftCompletion(own.roster, state.available.filter(player => !held.has(player.id)), slots, remaining, intervening);
  if (!guard.canComplete) return null;
  return [...guard.candidates].filter(player => player.adp != null && Number.isFinite(player.adp) && player.adp > 0)
    .sort((a, b) => a.adp! - b.adp! || a.id.localeCompare(b.id))[0] ?? null;
}
