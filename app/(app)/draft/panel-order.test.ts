import { describe, expect, it } from "vitest";

import {
  leadingPanel,
  nextArmed,
  panelOrder,
  shouldRevealLead,
  type Panel,
} from "./panel-order";

describe("leadingPanel", () => {
  it("leads with recording when the pick belongs to somebody else", () => {
    expect(leadingPanel({ onTheClock: false, draftComplete: false })).toBe(
      "record",
    );
  });

  it("leads with recommendations on your own turn", () => {
    expect(leadingPanel({ onTheClock: true, draftComplete: false })).toBe(
      "recommendations",
    );
  });

  // Eleven picks in twelve belong to somebody else. If this ever inverts, the whole
  // visible page on a handset becomes a list of players you cannot draft yet and the
  // control for the only available action sits past the fold — which is the bug this
  // module exists because of.
  it("leads with recording for most of a draft", () => {
    const seats = 12;
    const leads = Array.from({ length: seats }, (_, seat) =>
      leadingPanel({ onTheClock: seat === 0, draftComplete: false }),
    ).filter((panel) => panel === "record").length;
    expect(leads).toBe(seats - 1);
  });
});

describe("panelOrder", () => {
  it("puts the leader first and names both panels exactly once", () => {
    for (const onTheClock of [true, false]) {
      for (const draftComplete of [true, false]) {
        const state = { onTheClock, draftComplete };
        const order = panelOrder(state);
        expect(order[0]).toBe(leadingPanel(state));
        expect(new Set(order)).toEqual(
          new Set<Panel>(["record", "recommendations"]),
        );
        expect(order).toHaveLength(2);
      }
    }
  });
});

describe("shouldRevealLead", () => {
  it("reveals the new leader when the lead changes", () => {
    expect(
      shouldRevealLead({
        settled: true,
        previous: "recommendations",
        current: "record",
      }),
    ).toBe(true);
  });

  // The transition that matters most, and the one an earlier fix suppressed: the turn
  // coming back to you leaves you scrolled at the record panel while the recommendations
  // — two or three screens of them — are inserted above.
  it("reveals when the turn comes back to you", () => {
    expect(
      shouldRevealLead({
        settled: true,
        previous: "record",
        current: "recommendations",
      }),
    ).toBe(true);
  });

  it("stays put when the lead has not changed", () => {
    expect(
      shouldRevealLead({ settled: true, previous: "record", current: "record" }),
    ).toBe(false);
  });

  // Arming, not a transition. This is the restore-after-a-crash case.
  it("does not reveal on the first settled render", () => {
    expect(
      shouldRevealLead({ settled: true, previous: null, current: "record" }),
    ).toBe(false);
  });

  it("does not reveal before the stored draft has been read back", () => {
    expect(
      shouldRevealLead({
        settled: false,
        previous: "recommendations",
        current: "record",
      }),
    ).toBe(false);
  });
});

describe("the transitions a draft actually makes", () => {
  /**
   * Replays a sequence of turn states through exactly what the component runs.
   *
   * `nextArmed` rather than a local `if (settled) previous = current`. That line used to
   * be written out here as well as in the effect, and a copy cannot fail: dropping the
   * guard in the component left every test in this file green while the restore-after-a-
   * crash bug came straight back.
   */
  function reveals(states: readonly (TurnStateInput & { settled?: boolean })[]) {
    let previous: Panel | null = null;
    const revealed: boolean[] = [];
    for (const state of states) {
      const current = leadingPanel(state);
      const settled = state.settled ?? true;
      revealed.push(shouldRevealLead({ settled, previous, current }));
      previous = nextArmed({ settled, previous, current });
    }
    return revealed;
  }
  interface TurnStateInput {
    onTheClock: boolean;
    draftComplete: boolean;
  }

  // Completing the draft takes `onTheClock` from true to false exactly as passing the
  // turn does, because `currentPick` runs one past the last pick and nobody owns it. An
  // earlier version keyed on that and scrolled to a section whose contents are hidden, at
  // the moment nothing needed recording.
  it("does not move the page when your own last pick ends the draft", () => {
    expect(
      reveals([
        { onTheClock: true, draftComplete: false },
        { onTheClock: false, draftComplete: true },
      ]),
    ).toEqual([false, false]);
  });

  it("reveals the closing notice when an opponent's last pick ends the draft", () => {
    expect(
      reveals([
        { onTheClock: false, draftComplete: false },
        { onTheClock: false, draftComplete: true },
      ]),
    ).toEqual([false, true]);
  });

  it("stays put across a run of opponents", () => {
    expect(
      reveals([
        { onTheClock: false, draftComplete: false },
        { onTheClock: false, draftComplete: false },
        { onTheClock: false, draftComplete: false },
      ]),
    ).toEqual([false, false, false]);
  });

  // Mount with the defaults (pick one is yours), then the stored board lands with an
  // opponent on the clock. Only the settled render arms.
  it("does not move the page when a stored board is restored under it", () => {
    expect(
      reveals([
        { onTheClock: true, draftComplete: false, settled: false },
        { onTheClock: false, draftComplete: false },
        { onTheClock: false, draftComplete: false },
      ]),
    ).toEqual([false, false, false]);
  });

  it("reveals once per turn change, not once per pick", () => {
    expect(
      reveals([
        { onTheClock: true, draftComplete: false },
        { onTheClock: false, draftComplete: false },
        { onTheClock: false, draftComplete: false },
        { onTheClock: false, draftComplete: false },
        { onTheClock: true, draftComplete: false },
      ]),
    ).toEqual([false, true, false, false, true]);
  });
});

describe("nextArmed", () => {
  it("remembers the current lead once the board is settled", () => {
    expect(
      nextArmed({ settled: true, previous: null, current: "record" }),
    ).toBe("record");
  });

  // The guard that stops a restore looking like a turn change. Removing it is the
  // regression the replay above could not see while it kept its own copy of this rule.
  it("remembers nothing from an unsettled render", () => {
    expect(
      nextArmed({ settled: false, previous: null, current: "recommendations" }),
    ).toBeNull();
  });

  it("holds the previous lead rather than the unsettled one", () => {
    expect(
      nextArmed({ settled: false, previous: "record", current: "recommendations" }),
    ).toBe("record");
  });
});

describe("leadingPanel once the draft is over", () => {
  // `currentPick` runs one past the last pick, so nobody owns it and `onTheClock` is
  // false. Without the draftComplete term the record panel would lead a draft with
  // nothing left to record.
  it("leads with recommendations, where the closing notice sits", () => {
    expect(leadingPanel({ onTheClock: false, draftComplete: true })).toBe(
      "recommendations",
    );
  });
});
