import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  SUPPORTED_LEAGUE_SIZES,
  adpSourceFor,
} from "../nfl/draft/league-size";

import { AdpProvider, adpFormatFor, adpUrl, parseAdp } from "./adp";

/**
 * Average draft position.
 *
 * The fixture is a byte-exact slice of a real response, so the parser is tested against
 * the shape upstream actually sends rather than the shape it is documented to send.
 */
const payload = readFileSync(
  join(__dirname, "../../tests/fixtures/adp_ppr_2026_sample.json"),
  "utf8",
);

describe("adpUrl", () => {
  it("maps our ruleset ids onto the endpoint's format names", () => {
    // `half_ppr` is spelled `half-ppr` upstream. Sending our spelling returns the wrong
    // board rather than an error, which is the kind of mismatch that never surfaces.
    expect(adpUrl("half_ppr", 12, 2026)).toContain("/half-ppr?");
    expect(adpUrl("standard", 12, 2026)).toContain("/standard?");
    expect(adpUrl("ppr", 12, 2026)).toContain("/ppr?");
  });

  it("carries league size, which changes every survival probability", () => {
    expect(adpUrl("ppr", 10, 2026)).toContain("teams=10");
    expect(adpUrl("ppr", 14, 2026)).toContain("teams=14");
  });

  // The unknown-ruleset case used to assert a fallback to PPR here. That fallback was the
  // defect, not the behavior — see "unmapped scoring" at the end of this file.
});

describe("parseAdp", () => {
  it("reads a real response", () => {
    const entries = parseAdp(JSON.parse(payload));
    expect(entries).not.toBeNull();
    expect(entries!.length).toBe(12);

    const first = entries![0];
    expect(first.name).toBe("Jahmyr Gibbs");
    expect(first.position).toBe("RB");
    expect(first.team).toBe("DET");
    expect(first.adp).toBeCloseTo(1.6, 6);
    expect(first.stdev).toBeCloseTo(0.8, 6);
    expect(first.timesDrafted).toBe(589);
  });

  it("returns null for the error envelope, which arrives with a 200", () => {
    // The endpoint answers a season it has no data for with `{"status":"Error"}` and HTTP
    // 200. Reading that as success would produce a board where nobody has an ADP and
    // every player looks certain to last, which is worse than failing.
    expect(parseAdp({ status: "Error", players: [] })).toBeNull();
    expect(parseAdp({ status: "Error" })).toBeNull();
  });

  it("returns null rather than throwing on junk", () => {
    expect(parseAdp(null)).toBeNull();
    expect(parseAdp("nope")).toBeNull();
    expect(parseAdp({ status: "Success" })).toBeNull();
  });

  it("skips rows it cannot use instead of emitting a broken entry", () => {
    const entries = parseAdp({
      status: "Success",
      players: [
        { name: "Real Player", position: "RB", team: "KC", adp: 10, stdev: 3 },
        { name: "", position: "RB", adp: 11 },
        { name: "No ADP", position: "WR" },
        { name: "Zero ADP", position: "WR", adp: 0 },
      ],
    });
    expect(entries!.map((e) => e.name)).toEqual(["Real Player"]);
  });

  it("tolerates numbers sent as strings", () => {
    const entries = parseAdp({
      status: "Success",
      players: [{ name: "Stringy", position: "TE", adp: "42.5", stdev: "9" }],
    });
    expect(entries![0].adp).toBeCloseTo(42.5, 6);
    expect(entries![0].stdev).toBeCloseTo(9, 6);
  });

  it("keeps a missing spread as zero for the caller to default", () => {
    // Deliberately not defaulted here: the survival model owns that choice, and burying
    // it in the parser would hide which players had no dispersion published.
    const entries = parseAdp({
      status: "Success",
      players: [{ name: "No Spread", position: "QB", adp: 55 }],
    });
    expect(entries![0].stdev).toBe(0);
  });
});

describe("AdpProvider", () => {
  const provider = (body: string | Error) =>
    new AdpProvider(async () => {
      if (body instanceof Error) throw body;
      return body;
    });

  it("returns entries for a season that has data", async () => {
    const result = await provider(payload).forSeason(2026, "ppr", 12);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toHaveLength(12);
  });

  it("fails with an explanation when the season has no board yet", async () => {
    const result = await provider('{"status":"Error"}').forSeason(2031, "ppr", 12);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/No average draft position/);
  });

  it("fails rather than throwing when upstream is unreachable", async () => {
    const result = await provider(new Error("network down")).forSeason(2026, "ppr", 12);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Could not load/);
  });

  it("fails on malformed JSON", async () => {
    const result = await provider("<html>rate limited</html>").forSeason(2026, "ppr", 12);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not valid JSON/);
  });
});

describe("bye weeks", () => {
  const one = (bye: unknown) =>
    parseAdp({ players: [{ name: "A Player", position: "RB", adp: 10, bye }] })?.[0];

  it("keeps a real bye week", () => {
    expect(one(9)?.bye).toBe(9);
    expect(one("9")?.bye).toBe(9);
  });

  it("treats a published zero as absent rather than as week zero", () => {
    // Weeks are numbered from one, so a zero here means "not stated". Carried through it
    // reaches the board, which prints "bye 0" beside the player and — worse — groups
    // every such player into a phantom week-0 collision in the bye-clash summary, which
    // skips only null. The season simulation happens to be immune, because it compares
    // against 1-based week numbers that never equal zero.
    expect(one(0)?.bye).toBeNull();
    expect(one("0")?.bye).toBeNull();
  });

  it("rejects a negative bye week", () => {
    expect(one(-1)?.bye).toBeNull();
  });

  it("leaves a missing bye week null", () => {
    expect(one(undefined)?.bye).toBeNull();
    expect(one("not a week")?.bye).toBeNull();
  });
});

describe("unmapped scoring", () => {
  it("refuses rather than serving another format's board", () => {
    // The fallback to PPR was silent and produced a board that looked entirely normal —
    // a half-PPR league priced off a PPR market, which reorders receivers against backs
    // all the way down. A missing board is visible; a wrong one is not.
    expect(() => adpUrl("dynasty-2qb", 12, 2026)).toThrow(/No average-draft-position/);
    expect(adpUrl("half_ppr", 12, 2026)).toContain("half-ppr");
  });

  it("reports it as a provider failure rather than throwing at the caller", async () => {
    const provider = new AdpProvider(async () => "{}");
    const result = await provider.forSeason(2026, "dynasty-2qb", 12);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/No average-draft-position/);
  });
});

describe("team codes", () => {
  const one = (team: unknown) =>
    parseAdp({ players: [{ name: "A Player", position: "RB", adp: 10, team }] })?.[0];

  it("normalizes alias spellings to the same code the roster uses", () => {
    // Left raw, an alias is a different key from the roster's canonical one and the two
    // sources stop agreeing about which team a player is on.
    expect(one("OAK")?.team).toBe("LV");
    expect(one("STL")?.team).toBe("LA");
    expect(one("WFT")?.team).toBe("WAS");
  });

  it("passes a canonical code through unchanged", () => {
    expect(one("SF")?.team).toBe("SF");
  });

  it("leaves a missing or blank team null", () => {
    expect(one(undefined)?.team).toBeNull();
    expect(one("   ")?.team).toBeNull();
  });
});

describe("prototype keys are not scoring formats", () => {
  it("refuses an inherited property name", () => {
    // `scoringId` reaches here from stored state. A plain index lookup resolves
    // `constructor` and `toString` through the prototype to something truthy, which would
    // pass the null check and be interpolated straight into the endpoint URL.
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(adpFormatFor(key)).toBeNull();
      expect(() => adpUrl(key, 12, 2026)).toThrow(/No average-draft-position/);
    }
  });

  it("still resolves the real ones", () => {
    expect(adpFormatFor("half_ppr")).toBe("half-ppr");
  });
});

describe("position whitespace", () => {
  it("trims a published position before uppercasing it", () => {
    // Untrimmed it becomes " RB", which `normalizeMarketPosition` does not map — so the
    // market index key is `name|" RB"` and the position-qualified lookup misses the
    // player entirely. `name` and `team` were already trimmed; this was the odd one out.
    const entry = parseAdp({
      players: [{ name: "A Player", position: "  rb ", adp: 10 }],
    })?.[0];
    expect(entry?.position).toBe("RB");
  });
});

describe("the board's own boundaries", () => {
  it("serves a board with one player on it", async () => {
    // `entries.length === 0` is the empty check. Moved by one it reports a single-player
    // board as "empty", which is what a season's first published board looks like.
    const provider = new AdpProvider(async () =>
      JSON.stringify({
        status: "Success",
        players: [{ name: "Only Player", position: "RB", team: "KC", adp: 1, stdev: 1 }],
      }),
    );
    const result = await provider.forSeason(2026, "ppr", 12);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toHaveLength(1);
  });

  it("skips a null row instead of dying on it", () => {
    // `typeof item !== "object" || item === null`. `typeof null` is "object", so with `&&`
    // the first test is false for a null row, the guard never fires, and the next line
    // reads a property off null — a TypeError out of a parser whose whole contract is to
    // return null rather than throw.
    const entries = parseAdp({
      status: "Success",
      players: [
        null,
        undefined,
        "a string",
        42,
        { name: "Real Player", position: "RB", team: "KC", adp: 10 },
      ],
    });
    expect(entries?.map((e) => e.name)).toEqual(["Real Player"]);
  });

  it("keeps the first overall pick, and drops a zero", () => {
    // `adp <= 0`. One step either way and the board loses its first pick or gains a player
    // the market never priced.
    const entries = parseAdp({
      status: "Success",
      players: [
        { name: "First Overall", position: "RB", adp: 1 },
        { name: "Half A Pick", position: "WR", adp: 0.5 },
        { name: "Unpriced", position: "TE", adp: 0 },
        { name: "Negative", position: "QB", adp: -2 },
      ],
    });
    expect(entries?.map((e) => e.name)).toEqual(["First Overall", "Half A Pick"]);
  });

  it("keeps week one as a bye week", () => {
    // `value <= 0 ? null`. Week one is a real bye in some seasons and the first value the
    // guard could swallow if it moved.
    const bye = (value: unknown) =>
      parseAdp({ players: [{ name: "A Player", position: "RB", adp: 10, bye: value }] })?.[0]
        .bye;
    expect(bye(1)).toBe(1);
    expect(bye(0)).toBeNull();
    expect(bye(-1)).toBeNull();
  });
});

/**
 * Not asking the provider for the same board twice.
 *
 * The board-refresh action builds three scoring formats across eleven league sizes, each
 * from the target season plus two prior ones. Without a cache that is ninety-nine requests
 * to somebody else's server for thirty-six distinct answers, inside one action — the kind of
 * thing that gets an application blocked rather than the kind that costs money.
 */
describe("AdpProvider caches", () => {
  const board = JSON.stringify({
    status: "Success",
    players: [
      {
        name: "Jahmyr Gibbs",
        position: "RB",
        team: "DET",
        adp: 1.4,
        stdev: 0.6,
        bye: 6,
      },
    ],
  });

  function counting() {
    const urls: string[] = [];
    const provider = new AdpProvider(async (url: string) => {
      urls.push(url);
      return board;
    });
    return { provider, urls };
  }

  it("asks once per season, scoring and league size", async () => {
    const { provider, urls } = counting();
    for (let i = 0; i < 4; i += 1) {
      const result = await provider.forSeason(2026, "ppr", 12);
      expect(result.ok).toBe(true);
    }
    expect(urls).toHaveLength(1);
  });

  it("keeps different boards apart", async () => {
    const { provider, urls } = counting();
    await provider.forSeason(2026, "ppr", 12);
    await provider.forSeason(2026, "ppr", 10);
    await provider.forSeason(2026, "standard", 12);
    await provider.forSeason(2025, "ppr", 12);
    expect(new Set(urls).size).toBe(4);
    expect(urls).toHaveLength(4);
  });

  it("makes one request for two concurrent callers", async () => {
    // The in-flight share, not the result cache. Two builds starting together would
    // otherwise both miss and both fetch.
    const { provider, urls } = counting();
    const [a, b] = await Promise.all([
      provider.forSeason(2026, "ppr", 12),
      provider.forSeason(2026, "ppr", 12),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(urls).toHaveLength(1);
  });

  it("does not cache a failure", async () => {
    // One provider serves a whole refresh run. Caching a transient network blip would make
    // every later call for that board fail for the lifetime of the action.
    let attempts = 0;
    const provider = new AdpProvider(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("network");
      return board;
    });
    expect((await provider.forSeason(2026, "ppr", 12)).ok).toBe(false);
    expect((await provider.forSeason(2026, "ppr", 12)).ok).toBe(true);
    expect(attempts).toBe(2);
  });

  it("bounds the whole refresh matrix to one request per distinct board", async () => {
    // The measurement the issue asks for. Eleven sizes collapse onto four published boards,
    // three scoring formats, three seasons each: 4 x 3 x 3 = 36 requests, against the 99 an
    // uncached provider would make.
    const { provider, urls } = counting();
    for (const scoringId of ["ppr", "half_ppr", "standard"]) {
      for (const teams of SUPPORTED_LEAGUE_SIZES) {
        const source = adpSourceFor(teams).sourceTeams;
        for (const season of [2026, 2025, 2024]) {
          await provider.forSeason(season, scoringId, source);
        }
      }
    }
    expect(urls).toHaveLength(36);
    expect(new Set(urls).size).toBe(36);
  });
});
