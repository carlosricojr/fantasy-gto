# Draft player-identity coverage

This is the readiness seam for live provider draft picks; it is not a polling or
reconciliation implementation. `lib/nfl/draft/provider-identity.ts` is pure and classifies
every input pick as exactly one of `matched`, `ambiguous`, or `unmatched`.

The classifier uses a Sleeper player ID when it maps to exactly one board player. Only when
that bridge is unavailable does it use the shared draft name normalizer with an exact,
normalized name + position + team key. A short alias, changed team, duplicate key, or missing
field is explicit unresolved state, not a guessed selection.

Operator repairs are separate append-only records keyed by the provider pick. Replaying a
repair returns a new matched classification while retaining the source pick; duplicate repairs,
unknown board players, attempts to replace an already matched pick, and attempts to reuse an
already assigned board player are rejected. A future UI can persist those repair records beside
draft history without mutating history itself.

Run the live coverage audit with:

```bash
pnpm identity-coverage
```

It fetches the public production board, current nflverse roster bridge, and current Sleeper
universe afresh. The command prints all matched / ambiguous / unmatched numerators and
denominators, rookie subsets, and concrete unresolved identities. `UNRESOLVED — not clean`
means an operator repair or later board/provider correction is still required; it also exits
with status 1 so unattended readiness checks cannot mistake unresolved coverage for success.

## Mutation evidence

`pnpm mutate lib/nfl/draft/provider-identity.ts` generated 45 parseable mutants: 37 were
killed and eight survived as equivalent mutants. Four replace `??` with `||` where the only
non-nullish values are arrays or strings with the same empty fallback. Four change `> 1` after
the preceding `=== 1` return to `>= 1` or `> 0`; that branch is reachable only for counts
greater than one. The corresponding invariants are documented next to the code.
