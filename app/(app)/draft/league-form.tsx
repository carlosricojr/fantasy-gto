"use client";

import { Lock } from "lucide-react";

import { SegmentedControl } from "@/components/ui/segmented-control";
import { ROSTER_TEMPLATES } from "@/lib/nfl/roster";
import { SCORING_PRESETS } from "@/lib/nfl/scoring/presets";
import { LEAGUE_SIZES, MAX_ROUNDS, PLAYOFF_FIELDS } from "./persistence";

/**
 * The league's shape, in one control set used before the draft and during it.
 *
 * Two copies of these controls is how the setup screen and the in-draft settings drifted
 * apart: the setup screen capped rounds at one number and the stored payload accepted
 * another, and a restored draft could hold a round count the interface could neither show
 * nor correct.
 *
 * Mid-draft, some of these cannot change and the reason is not cosmetic. League size and
 * draft slot decide which picks belong to whom, so changing either re-attributes every
 * pick already recorded — the exact failure that once handed a manager's whole draft to
 * another seat. They are shown, disabled, with the reason next to them rather than hidden:
 * a control that vanishes reads as a missing feature, and a manager who needs to fix a
 * wrongly-entered league size needs to be told to start over, not left looking for it.
 */

export interface LeagueSettings {
  teams: number;
  rounds: number;
  slot: number;
  playoffTeams: number;
  scoringId: string;
  templateId: string;
}

export function LeagueForm({
  value,
  onChange,
  /** True once picks are being recorded, which locks the two fields that re-attribute them. */
  inProgress = false,
  /** Rounds already drafted; the round count cannot drop below it without orphaning picks. */
  minRounds = 1,
}: {
  value: LeagueSettings;
  onChange: (patch: Partial<LeagueSettings>) => void;
  inProgress?: boolean;
  minRounds?: number;
}) {
  return (
    <div className="space-y-6">
      <Field
        label="Teams"
        hint={inProgress ? "Locked — it decides which picks are whose" : "Boards are built per league size"}
        locked={inProgress}
      >
        <SegmentedControl
          label="League size"
          value={value.teams}
          onChange={(teams) => onChange({ teams })}
          options={LEAGUE_SIZES.map((size) => ({
            value: size,
            label: String(size),
            disabled: inProgress,
          }))}
        />
      </Field>

      <Field
        label="Your draft slot"
        hint={
          inProgress
            ? "Locked — it decides which picks are yours"
            : `Seat 1 through ${value.teams}`
        }
        locked={inProgress}
      >
        <SegmentedControl
          label="Your draft slot"
          value={value.slot}
          onChange={(slot) => onChange({ slot })}
          options={Array.from({ length: value.teams }, (_, index) => ({
            value: index + 1,
            label: String(index + 1),
            disabled: inProgress,
          }))}
        />
      </Field>

      <Field label="Rounds" hint={inProgress ? `At least ${minRounds}, the rounds already drafted` : undefined}>
        <SegmentedControl
          label="Rounds"
          value={value.rounds}
          onChange={(rounds) => onChange({ rounds })}
          // The current value is always in the list. `parsePersistedDraft` accepts any
          // round count up to `MAX_ROUNDS`, and the old number box let one be typed, so a
          // restored 17-round draft would otherwise open a control with nothing selected —
          // and the first arrow key would jump it to 10.
          options={roundChoicesIncluding(value.rounds).map((rounds) => ({
            value: rounds,
            label: String(rounds),
            disabled: rounds < minRounds,
          }))}
        />
      </Field>

      <Field label="Scoring">
        <SegmentedControl
          label="Scoring"
          value={value.scoringId}
          onChange={(scoringId) => onChange({ scoringId })}
          options={SCORING_PRESETS.map((preset) => ({
            value: preset.id,
            label: preset.label,
          }))}
        />
      </Field>

      <Field
        label="Roster"
        hint={ROSTER_TEMPLATES.find((template) => template.id === value.templateId)?.description}
      >
        <SegmentedControl
          label="Roster shape"
          value={value.templateId}
          onChange={(templateId) => onChange({ templateId })}
          options={ROSTER_TEMPLATES.map((template) => ({
            value: template.id,
            label: template.label,
          }))}
        />
      </Field>

      <Field label="Playoff teams" hint="How many make the bracket, which is what the odds are odds of">
        <SegmentedControl
          label="Playoff teams"
          value={value.playoffTeams}
          onChange={(playoffTeams) => onChange({ playoffTeams })}
          options={PLAYOFF_FIELDS.filter((field) => field < value.teams).map((field) => ({
            value: field,
            label: String(field),
          }))}
        />
      </Field>
    </div>
  );
}

/**
 * Round counts offered.
 *
 * A list rather than a number box. The box accepted "1.5" and an empty string as a matter
 * of course and needed rounding, clamping and an empty-field exception to stay usable —
 * three guards protecting a control nobody wanted to type into. Real drafts are 13 to 18
 * rounds; the ceiling is the same `MAX_ROUNDS` the stored payload validates against, so
 * the interface can represent every draft it will accept back.
 */
const ROUND_CHOICES = [10, 12, 13, 14, 15, 16, 18, 20, MAX_ROUNDS].filter(
  (rounds, index, all) => all.indexOf(rounds) === index && rounds <= MAX_ROUNDS,
);

/** The offered counts, plus whatever the draft is actually set to. */
function roundChoicesIncluding(current: number): number[] {
  if (ROUND_CHOICES.includes(current)) return ROUND_CHOICES;
  return [...ROUND_CHOICES, current].sort((a, b) => a - b);
}

function Field({
  label,
  hint,
  locked,
  children,
}: {
  label: string;
  hint?: string;
  locked?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="flex items-center gap-1.5 text-sm font-medium">
        {label}
        {locked === true ? (
          <Lock className="size-3 text-muted-foreground" aria-label="Locked during a draft" />
        ) : null}
      </p>
      {hint === undefined ? null : (
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      )}
      <div className="mt-2">{children}</div>
    </div>
  );
}
