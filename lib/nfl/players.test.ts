import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseCsv } from "./csv";
import { ageAt, pfrBridge, toPlayerProfile, toPlayerProfiles } from "./players";

/**
 * The player directory, parsed against a byte-exact slice of the real file.
 *
 * The fixture is nine rows lifted verbatim from upstream's 25,037, chosen to include the
 * cases that decide whether this parse is safe: a complete row, a skill player with **no**
 * `pfr_id` (which is how the snap-count bridge fails), and a row with **no** `birth_date`
 * (which is how an age feature fails). Inventing those rows rather than slicing them would
 * test a shape upstream may not actually produce.
 */
const FIXTURE = readFileSync(
  join(__dirname, "../../tests/fixtures/players_sample.csv"),
  "utf8",
);

const profiles = toPlayerProfiles(parseCsv(FIXTURE));
const byId = new Map(profiles.map((p) => [p.playerId, p]));

describe("toPlayerProfiles", () => {
  it("parses the fixture without losing a row", () => {
    // Every fixture row carries a gsis_id, so none is dropped. If upstream ever ships a row
    // without one this count changes and the reason is visible rather than silent.
    expect(profiles).toHaveLength(9);
  });

  it("reads a complete row exactly", () => {
    const player = byId.get("00-0032104");
    expect(player).toBeDefined();
    expect(player?.name).toBe("Ameer Abdullah");
    expect(player?.position).toBe("RB");
    expect(player?.birthDate).toBe("1993-06-13");
    expect(player?.pfrId).toBe("AbduAm00");
  });

  it("reports a missing pfr_id as null rather than an empty string", () => {
    // An empty string is a truthy-looking key: it would enter the bridge map, collide with
    // every other player who also lacks one, and turn "cannot be joined" into "joined to
    // whoever happened to be last".
    const player = byId.get("00-0023322");
    expect(player?.name).toBe("Rob Abiamiri");
    expect(player?.pfrId).toBeNull();
    expect(player?.birthDate).toBe("1982-12-21");
  });

  it("reports a missing birth_date as null rather than a parseable zero", () => {
    const player = byId.get("ALL656106");
    expect(player?.birthDate).toBeNull();
    // The rest of the row still parses; a missing birth date is not a corrupt player.
    expect(player?.pfrId).toBe("AlleZa00");
  });

  it("handles a row missing both identifiers people join on", () => {
    const player = byId.get("00-0026141");
    expect(player?.pfrId).toBeNull();
    expect(player?.birthDate).toBeNull();
  });

  it("drops a row with no gsis_id rather than keeping an unjoinable profile", () => {
    const header = FIXTURE.split("\n")[0];
    const blank = `${header}\n${header.split(",").map(() => "").join(",")}\n`;
    expect(toPlayerProfiles(parseCsv(blank))).toHaveLength(0);
  });

  it("keeps a draft record only when all three parts are present", () => {
    // A round without a pick is not a usable draft record, and defaulting the gap to zero
    // would price an undrafted player as the first selection of the draft.
    const row = { gsis_id: "x", draft_year: "2019", draft_round: "3", draft_pick: "" };
    expect(toPlayerProfile(row)?.draft).toBeNull();
    expect(
      toPlayerProfile({ ...row, draft_pick: "78" })?.draft,
    ).toEqual({ year: 2019, round: 3, pick: 78 });
  });
});

describe("pfrBridge", () => {
  it("indexes only the players that carry a pfr_id", () => {
    const bridge = pfrBridge(profiles);
    expect(bridge.get("AbduAm00")?.name).toBe("Ameer Abdullah");
    // Three fixture rows have no pfr_id, so they cannot appear — which is what makes an
    // unmatched snap-count row countable instead of silently zero.
    expect(bridge.size).toBe(profiles.filter((p) => p.pfrId !== null).length);
    expect(bridge.has("")).toBe(false);
  });
});

describe("ageAt", () => {
  it("counts whole years elapsed", () => {
    expect(ageAt("1993-06-13", "2024-09-08")).toBe(31);
    expect(ageAt("1993-06-13", "2024-06-13")).toBe(31);
  });

  it("has not counted the birthday until it arrives", () => {
    // The day before, they are still the younger age. Off by one here shifts every player
    // in an aging curve by up to a year in the direction of the season start.
    expect(ageAt("1993-06-13", "2024-06-12")).toBe(30);
    expect(ageAt("1993-12-31", "2024-01-01")).toBe(30);
  });

  it("is exact across a leap day", () => {
    // Someone born on 29 February. Differencing timestamps and dividing by 365.25 puts this
    // a day out in three years of four; comparing calendar fields does not.
    expect(ageAt("2000-02-29", "2024-02-28")).toBe(23);
    expect(ageAt("2000-02-29", "2024-02-29")).toBe(24);
    expect(ageAt("2000-02-29", "2023-02-28")).toBe(22);
    // In a non-leap year the birthday is conventionally 1 March, and this returns 23 on
    // 28 February 2023 — one day "early" by that convention. Recorded rather than fixed:
    // no fantasy decision turns on a single day, and inventing a rule upstream does not
    // state would be a judgement dressed as a measurement.
    expect(ageAt("2000-02-29", "2023-03-01")).toBe(23);
  });

  it("spans a season boundary correctly", () => {
    // Week 1 of one season and week 17 of the next are more than a year apart, so a player
    // must age exactly once across them.
    const born = "1996-10-20";
    expect(ageAt(born, "2023-09-10")).toBe(26);
    expect(ageAt(born, "2023-12-31")).toBe(27);
    expect(ageAt(born, "2024-09-08")).toBe(27);
  });

  it("returns null rather than a number when it cannot know", () => {
    // A zero here would read as a newborn and an aging curve would fit to it.
    expect(ageAt(null, "2024-09-08")).toBeNull();
    expect(ageAt("", "2024-09-08")).toBeNull();
    expect(ageAt("not-a-date", "2024-09-08")).toBeNull();
    expect(ageAt("1993-06-13", "")).toBeNull();
    expect(ageAt("1993-13-01", "2024-09-08")).toBeNull();
    expect(ageAt("1993-06-32", "2024-09-08")).toBeNull();
  });

  it("reads the clock it is given and nothing else", () => {
    // The property the whole file exists for: replaying week 6 of 2017 has to produce the
    // age the player was then. A function reading the wall clock would give every
    // historical row today's age and destroy any curve fitted on it.
    expect(ageAt("1990-01-01", "2017-10-15")).toBe(27);
    expect(ageAt("1990-01-01", "2024-10-15")).toBe(34);
  });
});
