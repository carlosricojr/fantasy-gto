import { execFileSync } from "node:child_process";
import ts from "typescript";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

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

/** A textual swap, guarded so it cannot fire on a longer operator that contains it. */
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
function isMutableLine(line: string): boolean {
  const trimmed = line.trim();
  // Comments no longer need testing for here — `maskNonCode` blanks them, so a comment line
  // simply yields no sites. What is left is the lines that *are* code and still must not be
  // touched.
  if (trimmed === "") return false;
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

/**
 * Blanks every comment and every string or template *text* in a file, keeping offsets.
 *
 * Offsets found in the result are valid in the real source, so a mutator can search the
 * masked text and edit the original. Anything masked is text rather than code: a comment
 * containing "true", "Math.min" or a number used to produce a mutant that edits the comment
 * and nothing else, which every test passes and which is then reported as a surviving gap —
 * noise indistinguishable from a real finding.
 *
 * The parser does this, rather than a hand-rolled scan of one line at a time. Three
 * versions of that scan shipped and each missed a case the next had to add: a trailing
 * `//`, a balanced `/* ... *\/` beside code, a `/*` that opens after code. Rewriting it as
 * a single stateful pass fixed the third and still could not see a template literal
 * spanning lines — the text on its second line reads as code, so `true` inside a message
 * becomes a mutant nothing can object to.
 *
 * `createSourceFile` knows all of it, including which parts of a template are text and
 * which are substituted expressions. `${...}` stays mutable, which the line-at-a-time
 * version could not manage either: it blanked whole templates and lost every site inside
 * one.
 */
function maskNonCode(source: string): string {
  const masked: string[] = source.split("").map((c) => (c === "\n" ? "\n" : " "));
  const file = ts.createSourceFile(
    "mask.ts",
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );

  // Text inside these is not code, whatever it looks like. `TemplateHead`, `Middle` and
  // `Tail` are the literal parts of a template; the `${...}` between them are ordinary
  // expressions and arrive as their own tokens, so they stay.
  const isText = (kind: ts.SyntaxKind): boolean =>
    kind === ts.SyntaxKind.StringLiteral ||
    kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
    kind === ts.SyntaxKind.RegularExpressionLiteral ||
    kind === ts.SyntaxKind.TemplateHead ||
    kind === ts.SyntaxKind.TemplateMiddle ||
    kind === ts.SyntaxKind.TemplateTail;

  // Written as "blank everything, then copy the tokens back" rather than "find the comments
  // and blank them". Comments are trivia: they are not in the tree, so they cannot be
  // enumerated from it, and a standalone `ts.createScanner` cannot be trusted to find them
  // either — it has no parser context, so a template literal desynchronises it and it runs
  // to the end of the file. Measured on `draft-memo.ts`: 7 comments found out of dozens,
  // and mutants that edited comment text were reported as survivors.
  //
  // Everything the parser did *not* claim as a token is whitespace or a comment, and
  // blanking whitespace changes nothing. So the complement is exactly the right mask, and
  // it cannot miss a comment by construction.
  const keep = (node: ts.Node): void => {
    // JSDoc is trivia that the parser nevertheless puts in the tree, so the walk would
    // copy a `/** ... */` block back as though it were code — and ` * ` in its margin is a
    // `times->div` site, which is how a mutant came to rewrite the first line of this
    // file's own docstring and be reported as surviving.
    if (
      node.kind >= ts.SyntaxKind.FirstJSDocNode &&
      node.kind <= ts.SyntaxKind.LastJSDocNode
    ) {
      return;
    }
    const children = node.getChildren(file);
    if (children.length === 0) {
      if (isText(node.kind)) return;
      const start = node.getStart(file);
      for (let i = start; i < node.getEnd(); i += 1) masked[i] = source[i];
      return;
    }
    for (const child of children) keep(child);
  };
  keep(file);

  return masked.join("");
}

function mutantsFor(file: string, source: string): Mutant[] {
  const lines = source.split("\n");
  const maskedLines = maskNonCode(source).split("\n");
  const out: Mutant[] = [];

  lines.forEach((line, index) => {
    const masked = maskedLines[index];
    if (!isMutableLine(line)) return;

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
  // Escaped before it becomes a pattern. The name comes from a CLI path, and a
  // metacharacter in it either changes what the regex matches or throws outright — either
  // way `coveringTests` comes back empty, the module reports SKIPPED, and the run exits 1
  // for a reason that has nothing to do with test coverage.
  const modulePattern = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const own = file.replace(/\.ts$/, ".test.ts");

  const covering = new Set<string>();
  if (allTests.includes(own)) covering.add(own);
  if (ownOnly) return [...covering];

  for (const test of allTests) {
    const source = readFileSync(join(process.cwd(), test), "utf8");
    // Any import whose path ends in this module's name, however it is spelled relatively.
    if (new RegExp(`from "[^"]*\\b${modulePattern}"`).test(source)) covering.add(test);
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
/**
 * One run at a time, repository-wide.
 *
 * Recovery restores every backup it finds, which is right for a run that died and wrong for
 * a run that is still going: a second `pnpm mutate` started mid-run would restore the
 * first's source, delete its backup, and leave it testing pristine code and reporting every
 * remaining mutant as surviving. `wx` on the backup does not prevent that, because the
 * recovery has already removed the file the flag would have collided with.
 *
 * The lock holds a pid. An existing lock whose owner is alive is a reason to stop; one
 * whose owner is gone is the stale marker that makes recovery safe, which is exactly the
 * situation recovery exists for.
 */
const LOCK_PATH = join(process.cwd(), ".mutate-lock");

let ownsRunLock = false;

function acquireRunLock(): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(LOCK_PATH, String(process.pid), { flag: "wx" });
      ownsRunLock = true;
      return true;
    } catch {
      // Read defensively: another process can clear a stale lock between the failed write
      // above and this read, and an unguarded `readFileSync` would then throw ENOENT out of
      // here and reject `main` with a raw filesystem error instead of simply retrying.
      let owner = Number.NaN;
      try {
        owner = Number(readFileSync(LOCK_PATH, "utf8").trim());
      } catch {
        continue;
      }
      if (Number.isInteger(owner) && owner > 0 && isAlive(owner)) {
        process.stderr.write(
          `Another mutation run is active (pid ${owner}). Two runs share one checkout and\n` +
            `would restore each other's source mid-test, so this one is stopping. If that\n` +
            `process is gone, delete ${relative(process.cwd(), LOCK_PATH)}.\n`,
        );
        return false;
      }
      // Stale: its owner is gone. Clear it and try once more.
      rmSync(LOCK_PATH, { force: true });
    }
  }
  // Both attempts lost the race to another starting run. Said out loud, because `main`
  // only sets a non-zero exit code — a silent failure here reads as a run that did nothing
  // for no reason.
  process.stderr.write(
    `Could not take ${relative(process.cwd(), LOCK_PATH)}: another run took it first, ` +
      `twice.\nNothing was measured. Try again.\n`,
  );
  return false;
}

/** Whether a pid is a live process. Signal 0 checks without delivering anything. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to somebody else, which still counts as alive.
    return (error as { code?: string }).code === "EPERM";
  }
}

function releaseRunLock(): void {
  // Only the process that took it may remove it. Without this test the lock was worse than
  // nothing: a second run refused the lock, returned, and its `finally` deleted the *first*
  // run's file — so a third run would start recovery in the middle of the first, which is
  // the exact race this was added to prevent.
  if (!ownsRunLock) return;
  ownsRunLock = false;
  rmSync(LOCK_PATH, { force: true });
}

function recoverAbandonedMutants(): string[] {
  const recovered: string[] = [];
  for (const backup of backupsUnder(process.cwd())) {
    const path = backup.slice(0, -BACKUP_SUFFIX.length);
    if (!isInsideRepo(backup) || !isInsideRepo(path)) {
      process.stdout.write(
        `  refusing to restore through ${relative(process.cwd(), backup)}: it or its ` +
          `target resolves outside the repository.\n`,
      );
      continue;
    }
    writeFileSync(path, readFileSync(backup, "utf8"));
    rmSync(backup, { force: true });
    recovered.push(relative(process.cwd(), path));
  }
  return recovered;
}

/**
 * Whether a path is a real file inside the checkout, following no links.
 *
 * Recovery writes to a path derived from a filename it found on disk, so the filename
 * decides where the write lands. A `something.ts.mutate-backup` that is a symlink — or
 * whose `something.ts` is one — would have this restoring through it to wherever it points,
 * which for a checkout somebody else prepared is any file this process can write.
 *
 * `lstatSync` rather than `statSync`, because the question is whether the entry *is* a
 * link, not what it resolves to. A path that does not exist yet is inside the repository if
 * its parent is, which is what lets a backup be created for a file that has none.
 */
function isInsideRepo(path: string): boolean {
  const root = realpathSync(process.cwd());
  // A parent that cannot be resolved is not inside the repository, and resolving it would
  // throw ENOENT out of here — past the caller's named refusal and out through `main`, so a
  // mistyped target ended the run with a filesystem stack trace instead of being told which
  // path was refused. Every other non-zero exit in this file names its cause.
  let parent: string;
  try {
    parent = realpathSync(dirname(path));
  } catch {
    return false;
  }
  if (parent !== root && !parent.startsWith(root + sep)) return false;
  return !existsSync(path) || !lstatSync(path).isSymbolicLink();
}

/**
 * Every `.mutate-backup` under `root`, skipping directories a mutant cannot be in.
 *
 * Symlinks are skipped in both roles: `isDirectory()` is already false for a linked
 * directory so the walk never follows one, and a linked file is not collected, so recovery
 * is never handed a path whose name and destination disagree.
 */
function backupsUnder(root: string): string[] {
  const skip = new Set(["node_modules", ".git", ".next", "dist", "coverage"]);
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (item.isSymbolicLink()) continue;
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

/** The file with one mutant applied. */
function applyMutant(original: string, mutant: Mutant): string {
  const lines = original.split("\n");
  lines[mutant.line - 1] = mutant.after;
  return lines.join("\n");
}

/**
 * Whether a mutated source still parses as TypeScript.
 *
 * A mutant that does not parse is not a mutant. `<` inside a generic — `Set<string>`
 * becoming `Set<=string>` — is the common case, and it used to be counted as a *kill*:
 * vitest cannot load the module, exits non-zero, and `runTests` reads a non-zero exit as
 * the tests having objected. Every one inflated the score for a change no test ever saw.
 *
 * Uses the compiler's own parser rather than a heuristic, because the cases that matter are
 * exactly the ones a textual rule gets wrong: `a <= b` is valid and `Set<=string>` is not,
 * and both come from the same mutator on the same character.
 */
function parses(source: string): boolean {
  const file = ts.createSourceFile(
    "mutant.ts",
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  // `parseDiagnostics` is not on the public type, but it is what the parser fills in and
  // there is no public accessor for syntax-only errors.
  return (file as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length === 0;
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
/**
 * Whether the tests passed — or whether they got to answer at all.
 *
 * `red` means the suite ran and objected. `inconclusive` means it never finished: a
 * timeout, an out-of-memory kill, a signal. Those are not the same thing, and collapsing
 * them was silently inflating the score. Every failure used to read as "mutant killed", so
 * on a loaded machine — a build in another checkout, anything holding the CPU — a run that
 * timed out counted as a test objecting to the mutation. The busier the machine, the better
 * the code looked.
 */
type TestOutcome = "green" | "red" | "inconclusive";

function runTests(files: readonly string[]): TestOutcome {
  if (files.length === 0) return "green";
  assertVitestExists();
  try {
    execFileSync(VITEST, ["run", "--project", "domain", "--silent=true", ...files], {
      cwd: process.cwd(),
      stdio: "pipe",
      timeout: 180_000,
    });
    return "green";
  } catch (error) {
    // `execFileSync` reports a process-level timeout or a signal kill through
    // `signal`/`code`, and a test failure through a non-zero `status`. Anything without a
    // numeric status never produced a verdict.
    const failure = error as {
      status?: number | null;
      signal?: string | null;
      code?: string;
      stdout?: Buffer | string;
      stderr?: Buffer | string;
    };
    if (typeof failure.status !== "number") return "inconclusive";

    // A non-zero status is not enough on its own, because vitest's *own* per-test timeout
    // exits with status 1 — the same code as an assertion that failed. On a loaded machine
    // a test that normally takes four seconds takes thirty-five, and the mutant it was
    // running against is then recorded as caught by a test that never reached an assertion.
    // That is the inflation this distinction exists to prevent, arriving through the one
    // door an exit code cannot see.
    //
    // Conservative on purpose: a run containing a timeout is discarded even if something
    // else in it genuinely failed. Discarding costs a mutant; the other direction costs the
    // number its meaning.
    const output = `${String(failure.stdout ?? "")}${String(failure.stderr ?? "")}`;
    if (/timed out in \d+ms/i.test(output)) return "inconclusive";
    return "red";
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
  if (limit !== Infinity && !Number.isInteger(limit)) {
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

  // Before recovery, which is the operation two concurrent runs corrupt each other with.
  if (!acquireRunLock()) {
    process.exitCode = 1;
    return;
  }

  // Targets come from the command line and decide where this reads and writes. `../..`
  // resolves outside the checkout, and a run interrupted there leaves both the mutated file
  // and its backup somewhere recovery does not look.
  const outside = files.filter((f) => !isInsideRepo(join(process.cwd(), f)));
  if (outside.length > 0) {
    process.stderr.write(
      `Refusing target(s) outside the repository, or reached through a link: ` +
        `${outside.join(", ")}\n`,
    );
    releaseRunLock();
    process.exitCode = 1;
    return;
  }

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

  // Every distinct per-mutant invocation, on unmutated source. Without this the baseline
  // proves only that *some* way of running the tests works, and a broken per-mutant
  // command reports every mutant killed and a flawless score.
  //
  // Every *distinct* one, not the first: different files select different test sets, and
  // checking one of them left the rest unproven. The periodic re-check inside the run does
  // not close that either — it fires every 25 mutants, so a file with fewer than 25 is
  // never re-confirmed at all, and a set that was red from the start would report a clean
  // sweep of kills. This is the same shape of mistake as checking a suite once and calling
  // it measured, which is what the rest of this file exists to avoid.
  const commands = new Map<string, readonly string[]>();
  for (const file of files) {
    const tests = coveringTests(file, allTests, ownOnly);
    if (tests.length > 0) commands.set([...tests].sort().join(" "), tests);
  }
  for (const tests of commands.values()) {
    if (runTests(tests) !== "green") {
      process.stdout.write(
        `  the per-mutant command fails on unmutated source: ${tests.join(" ")}\n` +
          "  every mutant measured with it would report as killed. Fix the invocation.\n",
      );
      process.exitCode = 1;
      return;
    }
  }
  process.stdout.write(
    `  green, and all ${commands.size} per-mutant command(s) agree.\n`,
  );

  const survivors: Mutant[] = [];
  const skipped: string[] = [];
  const unmeasured: Mutant[] = [];
  let killed = 0;
  let unparseable = 0;
  let tested = 0;
  // How many mutants have run since the baseline was last confirmed. It is checked once
  // before the run, which proves the invocation worked *then* and says nothing about an
  // hour later on a machine that has since filled up. Re-confirming periodically is what
  // makes the score a statement about the tests rather than about the load average.
  let sinceBaseline = 0;
  const BASELINE_EVERY = 25;

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
    releaseRunLock();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    restoreInFlight();
    releaseRunLock();
    process.exit(143);
  });
  process.on("uncaughtException", (error) => {
    restoreInFlight();
    releaseRunLock();
    throw error;
  });

  for (const file of files) {
    const path = join(process.cwd(), file);
    const original = readFileSync(path, "utf8");
    // Parse-filtered *before* the limit is applied, so `--limit N` means N mutants that
    // actually run. Slicing first let discarded ones eat the budget: on lib/nfl/teams.ts
    // the first six generated mutants are all generic brackets, so `--limit 6` tested
    // nothing and then reported "no mutable sites" for a file with 19 mutants, eleven of
    // them fine. The count of what was dropped is known here rather than accumulated.
    const generated = mutantsFor(file, original);
    const parseable = generated.filter((m) => parses(applyMutant(original, m)));
    unparseable += generated.length - parseable.length;
    const mutants = parseable.slice(0, limit);
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
      const mutatedSource = applyMutant(original, mutant);
      let outcome: TestOutcome = "green";
      try {
        // Set immediately before the write and cleared by the restore, so the pointer is
        // non-null for exactly the window in which a file on disk is corrupted.
        // Backup first, mutate second. Between these two writes the file on disk is
        // wrong, and that is the only window a hard kill can land in.
        // `wx`: fails if anything is already there rather than writing through it. The
        // only thing that should ever sit at this path is a backup from a run that died,
        // and `recoverAbandonedMutants` has already cleared those — so a collision here is
        // either a concurrent run or a file somebody else put in the way, and both are
        // reasons to stop rather than to overwrite.
        try {
          writeFileSync(backupPathFor(path), original, { flag: "wx" });
        } catch (cause) {
          // Named rather than left as a raw EEXIST. Every other stop in this file says what
          // went wrong on the way out; this one propagated a filesystem error through
          // `main` and ended the run with a stack trace.
          throw new Error(
            `Something is already at ${relative(process.cwd(), backupPathFor(path))}. ` +
              `Recovery cleared every backup at startup and the run lock is held, so this ` +
              `is a file left in the way rather than another run. Nothing in ${file} was ` +
              `mutated.`,
            { cause },
          );
        }
        inFlight = { path, original };
        writeFileSync(path, mutatedSource);
        outcome = runTests(tests);
        // One retry: a single unlucky run is the common case, and re-running costs less
        // than discarding a mutant.
        if (outcome === "inconclusive") outcome = runTests(tests);
      } finally {
        restoreInFlight();
      }

      if (outcome === "inconclusive") {
        // Scored in neither direction. Calling it killed is the failure this distinction
        // exists to prevent, and calling it survived would invent a gap.
        unmeasured.push(mutant);
        process.stdout.write("?");
        continue;
      }

      tested += 1;
      if (outcome === "green") {
        survivors.push(mutant);
        process.stdout.write(`  SURVIVED  :${mutant.line} ${mutant.mutator}\n`);
        process.stdout.write(`            ${mutant.before.trim().slice(0, 96)}\n`);
        process.stdout.write(`         -> ${mutant.after.trim().slice(0, 96)}\n`);
      } else {
        killed += 1;
        process.stdout.write(".");
      }

      sinceBaseline += 1;
      if (sinceBaseline >= BASELINE_EVERY) {
        sinceBaseline = 0;
        if (runTests(tests) !== "green") {
          process.stdout.write(
            `\n\nThe unmutated baseline stopped passing part-way through ${file}.\n` +
              "Everything measured since the last confirmation is unreliable, so no score\n" +
              "is printed. Re-run when the machine is quiet.\n",
          );
          process.exitCode = 1;
          return;
        }
      }
    }
    process.stdout.write("\n");
  }

  // A run that produced no mutants at all is not a 0% result, it is a run that measured
  // nothing — a target that is only types and re-exports, a filter that matched no file, a
  // limit that excluded everything. Printing a score for it is the sixth version of the
  // mistake this file already guards against five times.
  if (tested === 0) {
    // Three different causes, and naming the wrong one sends the reader to the wrong place.
    // Skipped files come first because they are the only cause that is about the *targets*
    // rather than about this harness, and the list of them is the answer — without it the
    // output says nothing was measured and not which modules or why.
    const cause =
      skipped.length > 0
        ? `Nothing was measured: no test file was found for ${skipped.length} of the ` +
          `${files.length} target(s):\n` +
          skipped.map((f) => `  ${f}\n`).join("") +
          `Either they are genuinely untested, or this harness cannot see their tests.\n`
        : unmeasured.length > 0
          ? `Nothing was measured: all ${unmeasured.length} mutant(s) were run and none of\n` +
            `them produced a verdict. The test command is timing out or being killed — this\n` +
            `is a machine or configuration problem, not a result.\n`
          : unparseable > 0
            ? `Nothing was measured: all ${unparseable} generated mutant(s) failed to parse\n` +
              `and were discarded. With --limit, raise it — the discarded ones are often\n` +
              `clustered at the top of a file.\n`
            : `No mutants were generated, so nothing was measured. Check the targets: a\n` +
              `file of only types and re-exports has no mutable sites.\n`;
    process.stdout.write(`\n${"=".repeat(70)}\n${cause}${"=".repeat(70)}\n`);
    process.exitCode = 1;
    return;
  }

  const score = (killed / tested) * 100;
  process.stdout.write(
    `\n${"=".repeat(70)}\n` +
      `mutants ${tested}   killed ${killed}   survived ${survivors.length}   ` +
      `score ${score.toFixed(1)}%\n` +
      (unmeasured.length > 0
        ? `${unmeasured.length} mutant(s) never produced a verdict — the test run was ` +
          `killed by a\ntimeout or a signal, twice each. They are excluded from the score ` +
          `rather than\ncounted as killed. A run with many of these was measured on a busy ` +
          `machine and\nthe score above is over the rest:\n` +
          unmeasured.map((m) => `  ${m.file}:${m.line}  ${m.mutator}\n`).join("")
        : "") +
      (unparseable > 0
        ? `${unparseable} generated mutant(s) did not parse and were discarded rather ` +
          `than scored.\n`
        : "") +
      `${"=".repeat(70)}\n`,
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

// The lock must go however this exits: a normal return, a throw, or a signal. Left behind,
// it makes the next run refuse to start for a process that is no longer there — recoverable
// (the pid is checked) but confusing, and the pid could since have been reused.
void main().finally(releaseRunLock);
