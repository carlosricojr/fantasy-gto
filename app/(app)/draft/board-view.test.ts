import { describe, expect, it } from "vitest";

import { pickOwnership, seatForTeamIndex } from "@/lib/core/draft";
import {
  boardColumns,
  boardGrid,
  describeTurn,
  nextPickFor,
  pickLabel,
  picksUntilTurn,
} from "./board-view";

/**
 * What the board draws.
 *
 * Every failure this file guards against is silent. A grid that puts a pick under the
 * wrong column still renders; a countdown that disagrees with the grid still shows a
 * number; a status line that names the wrong seat still reads as a sentence. The only way
 * to catch any of them is to check them against the ownership map the rest of the product
 * uses, which is what these do.
 */

describe("boardColumns", () => {
  it("seats the manager being advised at their own slot and nobody else", () => {
    const columns = boardColumns(10, 4);
    expect(columns).toHaveLength(10);
    expect(columns.filter((column) => column.teamIndex === 0)).toEqual([
      { seat: 4, teamIndex: 0, label: "You" },
    ]);
    expect(new Set(columns.map((column) => column.teamIndex)).size).toBe(10);
  });

  it("names every other column by the seat it occupies", () => {
    // Announcing a manager by their array index instead named every seat below the user's
    // one higher than it really is.
    for (const column of boardColumns(12, 5)) {
      if (column.teamIndex === 0) continue;
      expect(column.label).toBe(`Seat ${seatForTeamIndex(column.teamIndex, 5)}`);
    }
  });
});

describe("boardGrid", () => {
  it("agrees with the ownership map on every single cell", () => {
    // The invariant that matters: the manager a cell is drawn under is the manager who
    // owns that pick. Checked for every league shape the product offers, not by example.
    for (const teams of [8, 10, 12, 14]) {
      for (let slot = 1; slot <= teams; slot += 1) {
        const owners = pickOwnership(teams, slot, 15);
        for (const row of boardGrid(teams, slot, 15)) {
          for (const cell of row) {
            expect(owners.get(cell.pick)).toBe(cell.teamIndex);
          }
        }
      }
    }
  });

  it("snakes: odd rounds run left to right, even rounds right to left", () => {
    const grid = boardGrid(4, 1, 3);
    expect(grid[0].map((cell) => cell.pick)).toEqual([1, 2, 3, 4]);
    expect(grid[1].map((cell) => cell.pick)).toEqual([8, 7, 6, 5]);
    expect(grid[2].map((cell) => cell.pick)).toEqual([9, 10, 11, 12]);
  });

  it("returns cells in column order whichever way the round runs", () => {
    // The caller renders a row straight into a CSS grid, so the array order is the visual
    // order. An even round returned in pick order would draw itself backwards.
    for (const row of boardGrid(10, 3, 6)) {
      expect(row.map((cell) => cell.seat)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    }
  });

  it("covers the whole draft exactly once", () => {
    const picks = boardGrid(12, 7, 15)
      .flat()
      .map((cell) => cell.pick);
    expect(new Set(picks).size).toBe(12 * 15);
    expect(Math.min(...picks)).toBe(1);
    expect(Math.max(...picks)).toBe(12 * 15);
  });
});

describe("pickLabel", () => {
  it("reads the way a draft room does", () => {
    expect(pickLabel(1, 10)).toBe("1.01");
    expect(pickLabel(10, 10)).toBe("1.10");
    expect(pickLabel(11, 10)).toBe("2.01");
    expect(pickLabel(27, 12)).toBe("3.03");
  });
});

describe("nextPickFor and picksUntilTurn", () => {
  const owners = pickOwnership(10, 3, 15);

  it("finds the next pick a seat owns, counting the clock itself", () => {
    // Pick 3 belongs to the user in a ten-team draft from seat three, and it is on the
    // clock — "next" has to include it or the countdown reads one turn ahead of the board.
    expect(nextPickFor(owners, 0, 3)).toBe(3);
    expect(picksUntilTurn(owners, 0, 3)).toBe(0);
  });

  it("counts the picks in between", () => {
    // Seat three picks 3rd and 18th, so from pick 4 there are fourteen picks to wait.
    expect(nextPickFor(owners, 0, 4)).toBe(18);
    expect(picksUntilTurn(owners, 0, 4)).toBe(14);
  });

  it("does not count locked keeper squares as picks that still have to be made", () => {
    const open = new Map(owners);
    // The user's first two squares are already filled. Their next decision is pick 23, and
    // only the twenty still-open picks 1–22 will happen before it.
    open.delete(3);
    open.delete(18);
    expect(nextPickFor(open, 0, 1)).toBe(23);
    expect(picksUntilTurn(open, 0, 1)).toBe(20);
  });

  it("says so when a seat has no picks left", () => {
    expect(nextPickFor(owners, 0, 10 * 15 + 1)).toBeNull();
    expect(picksUntilTurn(owners, 0, 10 * 15 + 1)).toBeNull();
  });
});

describe("describeTurn", () => {
  const base = { totalPicks: 120, teams: 12, slot: 4 };

  it("asks for something on your turn", () => {
    const turn = describeTurn({ ...base, currentPick: 4, owner: 0 });
    expect(turn.mine).toBe(true);
    expect(turn.who).toBe("You");
    expect(turn.summary).toBe("Pick 1.04 — you are on the clock.");
    expect(turn.action).toBe("Take");
  });

  it("asks for something on everybody else's turn too", () => {
    // Eleven picks in twelve belong to somebody else, and during every one of them the
    // only thing this screen can do is be told what that person took. "Pick 1.05 — Seat 5."
    // states a fact and asks for nothing.
    const turn = describeTurn({ ...base, currentPick: 5, owner: 4 });
    expect(turn.mine).toBe(false);
    expect(turn.who).toBe("Seat 5");
    expect(turn.summary).toBe("Pick 1.05 — Seat 5 on the clock. Record their pick.");
    expect(turn.action).toBe("Record for Seat 5");
  });

  it("names seats the way the rest of the product does", () => {
    // Seat four is the user, so team index four sits in seat five.
    expect(describeTurn({ ...base, currentPick: 5, owner: 4 }).who).toBe("Seat 5");
    expect(describeTurn({ ...base, currentPick: 2, owner: 2 }).who).toBe("Seat 2");
  });

  it("stops asking once every pick is in", () => {
    // `currentPick` runs one past the last pick when the draft is complete, and the old
    // heading read "Record pick 181 — Nobody" over a search that could attribute nothing.
    const turn = describeTurn({ ...base, currentPick: 121, owner: undefined });
    expect(turn.complete).toBe(true);
    expect(turn.mine).toBe(false);
    expect(turn.summary).toBe("Draft complete — every pick is recorded.");
  });

  it("treats an unowned pick as the end rather than throwing", () => {
    // A render can happen between a league-size change and the effect that clamps it, and
    // an owner map that does not yet cover the clock must not take the page down.
    expect(describeTurn({ ...base, currentPick: 5, owner: undefined }).complete).toBe(true);
  });
});
