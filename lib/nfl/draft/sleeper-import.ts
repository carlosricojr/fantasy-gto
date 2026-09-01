import { SUPPORTED_LEAGUE_SIZES } from "./league-size";
import { templateForRoster } from "../roster";

/** Structural view of the parsed adapter settings; no provider I/O belongs in this module. */
export interface SleeperImportSettings {
  teams: number;
  rounds: number;
  type: string;
  rosterSlots: Readonly<Record<string, number>>;
  pickTimerSeconds: number | null;
  scoring: { identity: string | null; metadata: Readonly<Record<string, unknown>> };
  unsupported: readonly string[];
}

export interface SleeperSetupImport {
  exact: boolean;
  settings: {
    teams: number;
    rounds: number;
    scoringId: "ppr" | "half_ppr" | "standard";
    templateId: string;
    pickTimerSeconds: number | null;
  } | null;
  /** Each field that prevented an exact local representation, shown rather than guessed. */
  unsupported: readonly string[];
}

const SLOT_MAP: Readonly<Record<string, string>> = {
  slots_qb: "QB",
  slots_rb: "RB",
  slots_wr: "WR",
  slots_te: "TE",
  slots_flex: "FLEX",
  slots_super_flex: "SUPERFLEX",
  slots_wr_te: "WR_TE",
  slots_rb_wr: "RB_WR",
  slots_k: "K",
  slots_def: "DST",
};

/**
 * Selects a local setup only when every imported setting is exactly represented.
 *
 * It intentionally does not approximate custom scoring, keeper rules, linear/auction
 * order, or unfamiliar roster slots. Those facts remain in the adapter result and the UI
 * must present this result's `unsupported` list before a draft can be synchronized.
 */
export function importSleeperSetup(source: SleeperImportSettings): SleeperSetupImport {
  const unsupported = [...source.unsupported];
  if (source.type !== "snake") unsupported.push(`draft type: ${source.type || "missing"}`);
  if (!SUPPORTED_LEAGUE_SIZES.includes(source.teams as (typeof SUPPORTED_LEAGUE_SIZES)[number])) {
    unsupported.push(`teams: ${source.teams}`);
  }

  const counts: Record<string, number> = {};
  for (const [key, count] of Object.entries(source.rosterSlots)) {
    if (key === "slots_bn") continue;
    const localSlot = SLOT_MAP[key];
    if (localSlot === undefined) {
      unsupported.push(`roster slot: ${key}`);
      continue;
    }
    counts[localSlot] = count;
  }
  const template = templateForRoster(counts, source.rounds);
  if (template === null) unsupported.push("roster slots/rounds");

  const scoringId =
    source.scoring.identity === "ppr" ||
    source.scoring.identity === "half_ppr" ||
    source.scoring.identity === "standard"
      ? source.scoring.identity
      : null;
  if (scoringId === null) {
    unsupported.push(`scoring: ${source.scoring.identity ?? "missing"}`);
  }

  const unique = [...new Set(unsupported)].sort();
  if (unique.length > 0 || template === null || scoringId === null) {
    return { exact: false, settings: null, unsupported: unique };
  }
  return {
    exact: true,
    settings: {
      teams: source.teams,
      rounds: source.rounds,
      scoringId,
      templateId: template.id,
      pickTimerSeconds: source.pickTimerSeconds,
    },
    unsupported: [],
  };
}
