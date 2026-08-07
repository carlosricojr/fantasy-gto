import { describe, expect, it } from "vitest";

import {
  applied,
  initialGate,
  isStale,
  leagueFingerprint,
  nextRequest,
  retarget,
  verdictFor,
} from "./reply-gate";

/**
 * Which worker replies survive.
 *
 * The behaviour worth pinning is the one the hook could not express: a reply for a *different
 * league* is not merely old, and neither is the answer already on screen when the league
 * changes. Both have to disappear, and they have to disappear before the new board finishes
 * loading rather than after.
 */

const LEAGUE = {
  season: 2026,
  scoringId: "ppr",
  templateId: "standard",
  teams: 10,
  rounds: 15,
  playoffTeams: 6,
  championshipWeek: 17,
};

describe("out-of-order replies", () => {
  it("applies each reply in turn while they arrive in order", () => {
    let gate = initialGate(leagueFingerprint(LEAGUE));
    for (let i = 0; i < 3; i += 1) {
      const taken = nextRequest(gate);
      gate = taken.gate;
      expect(verdictFor(gate, taken.id)).toBe("apply");
      gate = applied(gate, taken.id);
    }
  });

  it("drops a slow reply for an older board", () => {
    let gate = initialGate(leagueFingerprint(LEAGUE));
    const first = nextRequest(gate);
    gate = first.gate;
    const second = nextRequest(gate);
    gate = second.gate;

    // The second answer lands first, which is the ordinary case on a fast draft.
    gate = applied(gate, second.id);
    expect(verdictFor(gate, first.id)).toBe("superseded");
  });

  it("still applies a reply that arrives after one of equal id", () => {
    // `<` rather than `<=`: a reply must be applicable when it is the newest applied one,
    // because that is what the first reply of every request is.
    let gate = initialGate(leagueFingerprint(LEAGUE));
    const only = nextRequest(gate);
    gate = applied(only.gate, only.id);
    expect(verdictFor(gate, only.id)).toBe("apply");
  });

  it("marks what is on screen stale while a newer request is outstanding", () => {
    let gate = initialGate(leagueFingerprint(LEAGUE));
    const first = nextRequest(gate);
    gate = first.gate;
    expect(isStale(gate, first.id)).toBe(false);
    const second = nextRequest(gate);
    gate = second.gate;
    expect(isStale(gate, first.id)).toBe(true);
    expect(isStale(gate, second.id)).toBe(false);
  });
});

describe("changing the league", () => {
  it("discards every outstanding reply in one step", () => {
    let gate = initialGate(leagueFingerprint(LEAGUE));
    const a = nextRequest(gate);
    gate = a.gate;
    const b = nextRequest(gate);
    gate = b.gate;

    const moved = retarget(gate, leagueFingerprint({ ...LEAGUE, scoringId: "standard" }));
    expect(moved.changed).toBe(true);
    gate = moved.gate;

    // Both are answers to a question nobody is asking now.
    expect(verdictFor(gate, a.id)).toBe("wrong-league");
    expect(verdictFor(gate, b.id)).toBe("wrong-league");
  });

  it("lets the next request through", () => {
    // The failure the off-by-one here would cause is worse than showing a stale answer: the
    // panel would never update again.
    let gate = initialGate(leagueFingerprint(LEAGUE));
    gate = nextRequest(gate).gate;
    gate = retarget(gate, leagueFingerprint({ ...LEAGUE, teams: 12 })).gate;
    const next = nextRequest(gate);
    expect(verdictFor(next.gate, next.id)).toBe("apply");
  });

  it("invalidates what is already applied, not only what is outstanding", () => {
    // The case the request-id rule cannot see. The user changes scoring, the board query
    // goes back to loading, no new request goes out — and the previous league's answer was
    // sitting on screen unmarked for as long as that took.
    let gate = initialGate(leagueFingerprint(LEAGUE));
    const shown = nextRequest(gate);
    gate = applied(shown.gate, shown.id);
    expect(verdictFor(gate, shown.id)).toBe("apply");

    gate = retarget(gate, leagueFingerprint({ ...LEAGUE, templateId: "two_flex" })).gate;
    expect(verdictFor(gate, shown.id)).toBe("wrong-league");
  });

  it("does nothing at all for the same league", () => {
    // Run on every render, so a no-op has to be a no-op. Clearing the panel each time the
    // component re-rendered would be worse than the defect being fixed.
    let gate = initialGate(leagueFingerprint(LEAGUE));
    const only = nextRequest(gate);
    gate = applied(only.gate, only.id);
    const again = retarget(gate, leagueFingerprint({ ...LEAGUE }));
    expect(again.changed).toBe(false);
    expect(again.gate).toBe(gate);
    expect(verdictFor(again.gate, only.id)).toBe("apply");
  });
});

describe("leagueFingerprint", () => {
  it("changes when anything that changes the board, the lineup or the season changes", () => {
    const base = leagueFingerprint(LEAGUE);
    const variants = [
      { ...LEAGUE, season: 2025 },
      { ...LEAGUE, scoringId: "half_ppr" },
      { ...LEAGUE, templateId: "two_flex" },
      { ...LEAGUE, teams: 12 },
      { ...LEAGUE, rounds: 16 },
      // Neither of these re-queries the board, so a request goes out at once and the old
      // answer is superseded a moment later — which is why they were left out and why that
      // was wrong. A championship probability is the probability of surviving a particular
      // bracket over particular weeks, so an answer computed for another one is not an old
      // answer to this question; it is a confident answer to a different question, and it
      // must leave the screen when the question does.
      { ...LEAGUE, playoffTeams: 4 },
      { ...LEAGUE, championshipWeek: 15 },
    ];
    for (const variant of variants) {
      expect(leagueFingerprint(variant)).not.toBe(base);
    }
    expect(new Set(variants.map(leagueFingerprint)).size).toBe(variants.length);
  });

  it("discards the answer on screen when the season shape changes", () => {
    // End to end through the gate, not just the string: a reply outstanding when the
    // championship week changes must be refused, and what is already displayed must go with
    // it rather than lingering under the new setting.
    let gate = initialGate(leagueFingerprint(LEAGUE));
    const outstanding = nextRequest(gate);
    gate = applied(outstanding.gate, outstanding.id);
    expect(verdictFor(gate, outstanding.id)).toBe("apply");

    const moved = retarget(gate, leagueFingerprint({ ...LEAGUE, championshipWeek: 15 }));
    expect(moved.changed).toBe(true);
    expect(verdictFor(moved.gate, outstanding.id)).toBe("wrong-league");
  });

  it("is the same string for the same league", () => {
    expect(leagueFingerprint(LEAGUE)).toBe(leagueFingerprint({ ...LEAGUE }));
  });

  it("distinguishes a missing season from a real one", () => {
    expect(leagueFingerprint({ ...LEAGUE, season: null })).not.toBe(
      leagueFingerprint(LEAGUE),
    );
  });

  it("cannot be collided by moving a boundary between two components", () => {
    // The collision a separator-joined fingerprint has: `("a", "b|c")` and `("a|b", "c")`
    // join to the same string, and two leagues sharing a fingerprint means each keeps the
    // other's stale answers. The ids shipped today contain no separator, so this would not
    // fire on real input — which is exactly why it would survive review.
    const a = leagueFingerprint({ ...LEAGUE, scoringId: "a", templateId: "b|c" });
    const b = leagueFingerprint({ ...LEAGUE, scoringId: "a|b", templateId: "c" });
    expect(a).not.toBe(b);

    // And the same for a quote, which is the character the serialized form has to escape.
    expect(
      leagueFingerprint({ ...LEAGUE, scoringId: 'a","b', templateId: "c" }),
    ).not.toBe(leagueFingerprint({ ...LEAGUE, scoringId: "a", templateId: 'b","c' }));
  });
});
