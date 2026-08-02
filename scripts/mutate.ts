import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Mutation testing.
 *
 * A passing test suite proves the tests agree with the code, not that either is right.
 * Mutation testing asks the sharper question: if the code were wrong, would anything
 * notice? Each mutant is a small deliberate defect — a comparison flipped, a constant
 * moved, a branch inverted — and a mutant that survives the suite is a defect the suite
 * cannot see.
 *
 * This exists because two tests in this repository were found passing for the wrong
 * reason: one asserted an inequality on a fixture where the mechanism could not occur, and
 * one claimed to separate two league formats but was satisfied by an unrelated string
 * differing. Both survived review and both looked convincing. Neither would have survived
 * this.
 *
 * Usage:
 *   pnpm mutate                 # the core logic files
 *   pnpm mutate lib/core/optimizer.ts
 *   pnpm mutate -- --limit 40   # cap mutants per file while iterating
 */

interface MutationSite {
  index: number;
  from: string;
  to: string;
}

interface Mutator {
  name: string;
  /**
   * Where this mutator could fire on a line.
   *
   * Given the line with string and template literals blanked out, so a swap can never
   * land inside a message. Positions are returned rather than mutated text, and the
   * replacement is applied to the untouched line at the same offset — the blanking
   * preserves length precisely so those offsets line up.
   */
  sites(masked: string): MutationSite[];
}

/** A textual swap, guarded so it cannot fire on a longer operator that contains it. */
/** Like `operator`, but only where the token is a whole word. */
function wordOperator(name: string, from: string, to: string): Mutator {
  // `.` blocks a boundary rather than being one: `flags.true` would otherwise match, and
  // the mutant would rewrite a property name instead of a boolean literal — producing
  // either a reference to something that does not exist, or a behaviour change for a
  // reason unrelated to the flip it claims to make. `numericLiteral` already blocks `.`
  // for the same reason.
  const blocksBoundary = (c: string | undefined): boolean =>
    c !== undefined && /[A-Za-z0-9_$.]/.test(c);
  return {
    name,
    sites(masked) {
      const out: MutationSite[] = [];
      let index = masked.indexOf(from);
      while (index !== -1) {
        const before = masked[index - 1];
        const after = masked[index + from.length];
        if (!blocksBoundary(before) && !blocksBoundary(after)) {
          out.push({ index, from, to });
        }
        index = masked.indexOf(from, index + 1);
      }
      return out;
    },
  };
}

function operator(
  name: string,
  from: string,
  to: string,
  forbidden: string[] = [],
): Mutator {
  return {
    name,
    sites(masked) {
      const out: MutationSite[] = [];
      let index = masked.indexOf(from);
      while (index !== -1) {
        // A guard token overlapping this position means the match is part of something
        // longer — `<` inside `<=`, or `>` inside the arrow of a lambda.
        const overlaps = forbidden.some((token) => {
          const window = masked.slice(
            Math.max(0, index - token.length + 1),
            index + token.length,
          );
          return window.includes(token);
        });
        if (!overlaps) out.push({ index, from, to });
        index = masked.indexOf(from, index + 1);
      }
      return out;
    },
  };
}

/** Perturbs a numeric literal, which catches constants nothing actually depends on. */
const numericLiteral: Mutator = {
  name: "number",
  sites(masked) {
    const out: MutationSite[] = [];
    for (const match of masked.matchAll(/(?<![\w.$])\d+(?:\.\d+)?(?![\w.])/g)) {
      if (match.index === undefined) continue;
      const value = Number(match[0]);
      // A distinctly different value rather than an increment: an off-by-one in a
      // tolerance is often invisible, while doubling it is not.
      const to = value === 0 ? "1" : value === 1 ? "0" : String(value * 2);
      out.push({ index: match.index, from: match[0], to });
    }
    return out;
  },
};

const MUTATORS: Mutator[] = [
  operator("lt->lte", "<", "<=", ["<=", "<<"]),
  operator("gt->gte", ">", ">=", [">=", "=>", ">>"]),
  operator("gte->gt", ">=", ">"),
  operator("lte->lt", "<=", "<"),
  operator("eq->neq", "===", "!=="),
  operator("neq->eq", "!==", "==="),
  operator("and->or", "&&", "||"),
  operator("or->and", "||", "&&"),
  operator("plus->minus", " + ", " - "),
  operator("minus->plus", " - ", " + "),
  operator("times->div", " * ", " / "),
  operator("max->min", "Math.max", "Math.min"),
  operator("min->max", "Math.min", "Math.max"),
  // Word-bounded: `true` and `false` also occur inside identifiers like `isTrueFlag` and
  // `trueValue`, and rewriting one mid-identifier produces an undeclared reference — or,
  // worse, a coincidentally valid one. Either way the mutant tests something other than
  // the boolean literal it claims to flip.
  wordOperator("true->false", "true", "false"),
  wordOperator("false->true", "false", "true"),
  operator("nullish->or", " ?? ", " || "),
  numericLiteral,
];

/**
 * The vitest binary, invoked directly.
 *
 * Going through `npx` costs seconds of resolution *per invocation*, and a mutation run
 * makes thousands of them — it turned a sub-second test file into eighteen seconds and put
 * a full run out of reach.
 */
const VITEST = join(process.cwd(), "node_modules", ".bin", "vitest");

/** Files whose logic is worth this. Tests, generated code, and adapters are excluded. */
const DEFAULT_TARGETS = [
  "lib/core/optimizer.ts",
  "lib/core/draft.ts",
  "lib/core/roster-utility.ts",
  "lib/core/season-sim.ts",
  "lib/core/draft-policy.ts",
  "lib/core/draft-speculation.ts",
  "lib/core/draft-memo.ts",
  "lib/core/rng.ts",
  "lib/nfl/model/project.ts",
  "lib/nfl/scoring/score.ts",
  "lib/nfl/season.ts",
  "lib/nfl/teams.ts",
  "lib/nfl/csv.ts",
  "lib/nfl/roster.ts",
  "lib/nfl/draft/value.ts",
  "lib/nfl/draft/match.ts",
  "lib/billing/entitlements.ts",
];

/**
 * Lines that must not be mutated.
 *
 * Comments are the obvious case. Import lines matter too: mutating one produces a module
 * that cannot load, which the suite reports as a failure — a kill that proves nothing
 * about the tests.
 */
function isMutableLine(line: string, inBlockComment: boolean): boolean {
  const trimmed = line.trim();
  if (inBlockComment) return false;
  if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("*")) return false;
  if (trimmed.startsWith("/*")) return false;
  if (trimmed.startsWith("import ") || trimmed.startsWith("export {")) return false;
  if (trimmed.startsWith("export type") || trimmed.startsWith("export interface")) {
    return false;
  }
  return true;
}

interface Mutant {
  file: string;
  line: number;
  mutator: string;
  before: string;
  after: string;
}

function mutantsFor(file: string, source: string): Mutant[] {
  const lines = source.split("\n");
  const out: Mutant[] = [];
  let inBlockComment = false;

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    const opensBlock = trimmed.startsWith("/*");
    const mutable = isMutableLine(line, inBlockComment || opensBlock);
    if (opensBlock && !trimmed.includes("*/")) inBlockComment = true;
    if (trimmed.includes("*/")) inBlockComment = false;
    if (!mutable) return;

    // Blanked to the same length, so offsets found here are valid in the real line.
    // Strings first, then any trailing `//` comment. Without the second step a comment
    // containing "true", "Math.min" or a number produced a mutant that edits only the
    // comment, which every test passes and which is then reported as a surviving gap —
    // noise that looks exactly like a real finding.
    const withoutStrings = line.replace(
      /"[^"]*"|'[^']*'|`[^`]*`/g,
      (m) => " ".repeat(m.length),
    );
    const commentAt = withoutStrings.indexOf("//");
    const masked =
      commentAt === -1
        ? withoutStrings
        : withoutStrings.slice(0, commentAt) +
          " ".repeat(withoutStrings.length - commentAt);

    for (const mutator of MUTATORS) {
      for (const site of mutator.sites(masked)) {
        const after =
          line.slice(0, site.index) + site.to + line.slice(site.index + site.from.length);
        if (after === line) continue;
        out.push({ file, line: index + 1, mutator: mutator.name, before: line, after });
      }
    }
  });
  return out;
}

/**
 * Test files that could possibly detect a change to this module.
 *
 * Running the whole suite for every mutant is the obvious approach and far too slow — most
 * of it cannot observe the file being mutated, and the simulation-heavy tests dominate the
 * clock. Selecting by import closure keeps every test that *can* see the change and drops
 * the ones that cannot, which is exactly the set whose silence is meaningful.
 *
 * A module's own test is always included, even when it imports through a barrel.
 *
 * `--own` restricts the set to that one file. The resulting score answers a narrower and
 * more useful question — does *this module's* suite pin its behaviour? — and is a lower
 * bound on the true score, because a mutant reported as surviving may still be caught by
 * another module's tests. It is also dramatically faster: the simulation-heavy suites take
 * seconds each, and running them for every mutant of an unrelated file dominated the clock
 * to the point of being unusable.
 */
function coveringTests(
  file: string,
  allTests: readonly string[],
  ownOnly: boolean,
): string[] {
  const moduleName = file.replace(/^.*\//, "").replace(/\.ts$/, "");
  const own = file.replace(/\.ts$/, ".test.ts");

  const covering = new Set<string>();
  if (allTests.includes(own)) covering.add(own);
  if (ownOnly) return [...covering];

  for (const test of allTests) {
    const source = readFileSync(join(process.cwd(), test), "utf8");
    // Any import whose path ends in this module's name, however it is spelled relatively.
    if (new RegExp(`from "[^"]*\\b${moduleName}"`).test(source)) covering.add(test);
  }
  return [...covering];
}

function listTestFiles(): string[] {
  const out = execFileSync(
    "git",
    // `--others --exclude-standard` includes files that exist but are not staged yet. A
    // test written and not yet added is exactly the case somebody runs this harness for,
    // and without it the module reports as having no tests and gets skipped.
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "lib/**/*.test.ts",
      "lib/*.test.ts",
      "app/**/*.test.ts",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  return out.split("\n").filter((line) => line.endsWith(".test.ts"));
}

/** The whole domain project, used once to establish the baseline. */
/**
 * Where a file's pristine contents are parked while it carries a mutant.
 *
 * Signal handlers are not enough on their own. The run spends nearly all of its time
 * blocked inside a synchronous child process, and Node cannot execute a handler while the
 * event loop is blocked — so a Ctrl-C during a test run, or any hard kill, leaves the
 * mutant on disk. A file on disk survives what a handler cannot, and the next run cleans
 * up after the last one.
 */
const BACKUP_SUFFIX = ".mutate-backup";

function backupPathFor(path: string): string {
  return `${path}${BACKUP_SUFFIX}`;
}

/**
 * Undoes a run that was killed before it could restore.
 *
 * Scans the whole tree rather than the current run's target list. A run killed while
 * mutating a file leaves its backup on disk, and if the next invocation happens to target
 * a narrower set — which is the normal way to work, broad sweep then focus — that file is
 * never looked at and stays mutated. `git status` would eventually show it, but only to
 * somebody looking; an unattended `git add -A` or a CI step would not.
 */
function recoverAbandonedMutants(): string[] {
  const recovered: string[] = [];
  for (const backup of backupsUnder(process.cwd())) {
    const path = backup.slice(0, -BACKUP_SUFFIX.length);
    writeFileSync(path, readFileSync(backup, "utf8"));
    rmSync(backup, { force: true });
    recovered.push(relative(process.cwd(), path));
  }
  return recovered;
}

/** Every `.mutate-backup` under `root`, skipping directories a mutant cannot be in. */
function backupsUnder(root: string): string[] {
  const skip = new Set(["node_modules", ".git", ".next", "dist", "coverage"]);
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (item.isDirectory()) {
        if (!skip.has(item.name)) walk(join(dir, item.name));
      } else if (item.name.endsWith(BACKUP_SUFFIX)) {
        found.push(join(dir, item.name));
      }
    }
  };
  walk(root);
  return found;
}

/**
 * Distinguishes a missing binary from a failing suite.
 *
 * Both arrive at the same `catch`, and reading one as the other is how this harness keeps
 * finding new ways to report a confident number for work it did not do — the `--silent`
 * bug, the `app/**` glob, `--limit abc`, the untracked-test gap, and now this. A vitest
 * that cannot be spawned makes every mutant look killed, which is a 100% score over
 * nothing.
 */
function assertVitestExists(): void {
  if (!existsSync(VITEST)) {
    throw new Error(
      `No vitest binary at ${VITEST}. That is a broken invocation, not a failing suite — ` +
        `run \`pnpm install\` or check the working directory.`,
    );
  }
}

function runAll(): boolean {
  assertVitestExists();
  try {
    execFileSync(VITEST, ["run", "--project", "domain", "--silent=true"], {
      cwd: process.cwd(),
      stdio: "pipe",
      timeout: 300_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs the given test files, returning whether they passed.
 *
 * `--silent=true` rather than `--silent`, and the distinction is not cosmetic: vitest
 * parses a bare `--silent` followed by a positional argument as *the flag's value*, so
 * `--silent path/to.test.ts` crashes on startup. Every invocation then exits non-zero,
 * every mutant looks killed, and the run reports a perfect score having tested nothing.
 * It did exactly that for 1,287 mutants before this was noticed.
 */
function runTests(files: readonly string[]): boolean {
  if (files.length === 0) return true;
  assertVitestExists();
  try {
    execFileSync(VITEST, ["run", "--project", "domain", "--silent=true", ...files], {
      cwd: process.cwd(),
      stdio: "pipe",
      timeout: 180_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const limitIndex = args.indexOf("--limit");
  const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : Infinity;
  // `Number(undefined)` and `Number("abc")` are both NaN, and `slice(0, NaN)` is empty —
  // so a typo in the flag ran zero mutants against every file, printed `score 0.0%`, and
  // exited 0. That is the third way this harness has found to publish a number for work it
  // did not do.
  if (!Number.isFinite(limit) && limit !== Infinity) {
    process.stderr.write(
      `--limit needs a positive whole number; got "${args[limitIndex + 1] ?? ""}".\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (limit < 1) {
    process.stderr.write(`--limit must be at least 1; got ${limit}.\n`);
    process.exitCode = 1;
    return;
  }
  const ownOnly = args.includes("--own");
  const failOnSurvivors = args.includes("--fail-on-survivors");
  const targets = args.filter((a) => a.endsWith(".ts"));
  const files = targets.length > 0 ? targets : DEFAULT_TARGETS;

  const recovered = recoverAbandonedMutants();
  if (recovered.length > 0) {
    process.stdout.write(
      `\nRecovered ${recovered.length} file(s) left mutated by an earlier run: ` +
        `${recovered.join(", ")}\n`,
    );
  }

  const allTests = listTestFiles();
  process.stdout.write("\nBaseline: the suite must be green before mutating.\n");
  if (!runAll()) {
    process.stdout.write("  suite is already failing — fix that first.\n");
    process.exitCode = 1;
    return;
  }

  // The same invocation the mutants use, on unmutated source. Without this the baseline
  // proves only that *some* way of running the tests works, and a broken per-mutant
  // command reports every mutant killed and a flawless score.
  const probe = files
    .map((file) => coveringTests(file, allTests, ownOnly))
    .find((tests) => tests.length > 0);
  if (probe !== undefined && !runTests(probe)) {
    process.stdout.write(
      `  the per-mutant command fails on unmutated source: ${probe.join(" ")}\n` +
        "  every mutant would report as killed. Fix the invocation.\n",
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write("  green, and the per-mutant command agrees.\n");

  const survivors: Mutant[] = [];
  const skipped: string[] = [];
  let killed = 0;
  let tested = 0;

  // The file currently carrying a mutant, so an interrupt restores that one and only that
  // one. The handlers are installed once.
  let inFlight: { path: string; original: string } | null = null;
  const restoreInFlight = (): void => {
    if (inFlight !== null) {
      writeFileSync(inFlight.path, inFlight.original);
      rmSync(backupPathFor(inFlight.path), { force: true });
    }
    inFlight = null;
  };
  process.on("SIGINT", () => {
    restoreInFlight();
    process.exit(130);
  });
  process.on("uncaughtException", (error) => {
    restoreInFlight();
    throw error;
  });

  for (const file of files) {
    const path = join(process.cwd(), file);
    const original = readFileSync(path, "utf8");
    const mutants = mutantsFor(file, original).slice(0, limit);
    const tests = coveringTests(file, allTests, ownOnly);
    process.stdout.write(
      `\n${file}  (${mutants.length} mutants, ${tests.length} covering test file(s))\n`,
    );
    if (tests.length === 0) {
      // Skipped rather than scored. Running the mutants anyway reports every one of them
      // as surviving, which reads as a coverage problem in the module when it is really a
      // discovery problem in this harness: `listTestFiles` globbed only `lib/**` for a
      // while after the vitest config started including `app/**`, and the file came back
      // at 0% having executed no test at all. A score computed over files whose tests were
      // never found is not a worse number, it is a meaningless one.
      process.stdout.write(
        "  SKIPPED — no test file found for this module, so nothing here was measured\n",
      );
      skipped.push(file);
      continue;
    }

    // The file on disk is deliberately corrupted between these two writes, so an
    // interrupt in the wrong millisecond would leave a mutant committed. Restoring from a
    // handler as well as a `finally` covers Ctrl-C and an unexpected throw alike.
    // Registered once for the whole run, not once per file. Adding a handler per file
    // accumulated them — the warning about eleven SIGINT listeners was the symptom — and
    // because `process.once` fires them all, an interrupt restored every file the run had
    // touched using whichever `original` each closure had captured. Correct by accident
    // for finished files, and wrong for the one actually being mutated if the order ever
    // changed. A single mutable pointer to the file in flight cannot get that wrong.

    for (const mutant of mutants) {
      const lines = original.split("\n");
      lines[mutant.line - 1] = mutant.after;
      let green = false;
      try {
        // Set immediately before the write and cleared by the restore, so the pointer is
        // non-null for exactly the window in which a file on disk is corrupted.
        // Backup first, mutate second. Between these two writes the file on disk is
        // wrong, and that is the only window a hard kill can land in.
        writeFileSync(backupPathFor(path), original);
        inFlight = { path, original };
        writeFileSync(path, lines.join("\n"));
        tested += 1;
        green = runTests(tests);
      } finally {
        restoreInFlight();
      }

      if (green) {
        survivors.push(mutant);
        process.stdout.write(`  SURVIVED  :${mutant.line} ${mutant.mutator}\n`);
        process.stdout.write(`            ${mutant.before.trim().slice(0, 96)}\n`);
        process.stdout.write(`         -> ${mutant.after.trim().slice(0, 96)}\n`);
      } else {
        killed += 1;
        process.stdout.write(".");
      }
    }
    process.stdout.write("\n");
  }

  const score = tested === 0 ? 0 : (killed / tested) * 100;
  process.stdout.write(
    `\n${"=".repeat(70)}\n` +
      `mutants ${tested}   killed ${killed}   survived ${survivors.length}   ` +
      `score ${score.toFixed(1)}%\n${"=".repeat(70)}\n`,
  );
  if (skipped.length > 0) {
    process.stdout.write(
      `\n${skipped.length} file(s) contributed nothing to that score because no test ` +
        `file was found:\n` +
        skipped.map((f) => `  ${f}\n`).join("") +
        "Either they are genuinely untested, or this harness cannot see their tests.\n",
    );
    process.exitCode = 1;
  }

  if (survivors.length > 0) {
    process.stdout.write("\nSurvivors, by file:\n");
    for (const s of survivors) {
      process.stdout.write(`  ${s.file}:${s.line}  ${s.mutator}\n`);
    }
    process.stdout.write(
      "\nA survivor is a change to the code that no test objected to. Some are\n" +
        "equivalent mutants that cannot change behaviour; the rest are gaps.\n",
    );
    // Survivors do not fail the run by default, and the distinction is deliberate: every
    // other non-zero exit in this file marks the harness having *malfunctioned* — a bad
    // `--limit`, a red baseline, a file whose tests could not be found — where the number
    // it printed means nothing. Survivors are a result. Some are equivalent mutants that
    // no test can kill, so a run that always exits non-zero would make the exit code as
    // uninformative as one that never does.
    //
    // `--fail-on-survivors` opts into gate behaviour for anything that wants it.
    if (failOnSurvivors) {
      process.stdout.write("\n--fail-on-survivors: exiting non-zero.\n");
      process.exitCode = 1;
    }
  }
}

void main();
