# CodeRabbit PR Review Loop (Mandatory)

<!-- markdownlint-disable MD013 -->
<!-- CODERABBIT_REVIEW_LOOP_CANONICAL_VERSION: 2.1.1 -->
<!-- CANONICAL_SOURCE: https://github.com/ospina-company/alpha-core/blob/main/docs/agents/coderabbit-pr-review-loop.md -->
<!-- CANONICAL_BODY_SHA256: 75f13e94deae7e6a392b9c849ebd4c311119b146a6e6e226fa58754f1d3f8e40 -->
<!-- markdownlint-enable MD013 -->

This is the canonical workflow for any task that prepares, updates, or merges a
pull request. It shifts review left, spends review allowance deliberately, and
treats the GitHub App as the required final reviewer of the settled production
diff.

Copies of this document must remain byte-for-byte identical. To compare a copy
with the canonical source without triggering CI or a CodeRabbit review:

```bash
CANONICAL_API=repos/ospina-company/alpha-core/contents
CANONICAL_API=$CANONICAL_API/docs/agents/coderabbit-pr-review-loop.md
gh api -H 'Accept: application/vnd.github.raw+json' \
  "$CANONICAL_API?ref=main" | cmp - docs/agents/coderabbit-pr-review-loop.md
```

The version and body hash above are the lightweight drift-control marker. The
body hash is calculated with the `CANONICAL_BODY_SHA256` line omitted:

```bash
DOC=docs/agents/coderabbit-pr-review-loop.md
expected=$(sed -n \
  's/^<!-- CANONICAL_BODY_SHA256: \([0-9a-f]\{64\}\) -->$/\1/p' "$DOC")
actual=$(sed '/^<!-- CANONICAL_BODY_SHA256: [0-9a-f]\{64\} -->$/d' "$DOC" |
  shasum -a 256 | awk '{print $1}')
test -n "$expected"
test "$actual" = "$expected" || {
  printf 'canonical body hash mismatch: expected %s, got %s\n' \
    "$expected" "$actual" >&2
  exit 1
}
printf 'canonical body hash verified: %s\n' "$actual"
```

Do not add repository-specific text to a copy. Put truly local rules in
`AGENTS.md`, `CLAUDE.md`, or another local governance document and keep this
file canonical.

## Completion contract

A green CodeRabbit check is necessary when configured, but it is never
sufficient proof of review. A merge requires evidence that CodeRabbit actually
walked through and reviewed the relevant production diff.

A **completed review** has all of the following evidence:

- the reviewed commit SHA is known and appropriate for the production diff;
- CodeRabbit posted substantive review text or a completed Walkthrough for that
  diff;
- the CodeRabbit check/status reached a terminal successful state;
- comments, reviews, checks, and review threads were fetched fresh from GitHub;
- no message says the review was paused, skipped, ignored, rate-limited,
  transport-failed, quota-limited, or otherwise not performed; and
- zero unresolved actionable review threads remain.

Paused, skipped, ignored, rate-limited, transport-failed, quota-limited,
timed-out, or silent outcomes are **non-reviews**, even when a check is green. A
cached check, an old review on another SHA, a summary-only update, or the
absence of comments is also not evidence of a completed review. Record the
evidence in the PR before merge.

When the GitHub App review cannot be produced because CodeRabbit is adaptively
rate-limited, do not stall the PR indefinitely: the review of record may instead
come from the **Adaptive-limit escape ladder** below — a CodeRabbit CLI review of
the same settled diff, or, only as a last resort, a documented agent-CLI review.
A ladder review clears the same evidence bar (substantive findings against the
reviewed SHA/diff, fetched fresh, every finding addressed), and merge still
requires zero unresolved actionable threads and green required CI.

## Stage 0 — orient, scope, and protect user work

1. Read the repository's `AGENTS.md`, `CLAUDE.md`, applicable `.claude` rules,
   and tooling governance before editing. Read the changed code, tests, and
   nearby documentation.
2. Use a branch from the repository's integration branch and an isolated
   worktree. Never bundle unrelated working-tree changes. Some repositories
   promote `staging` to `main`; target `staging` for routine work when local
   rules say it is the integration branch.
3. Keep one PR to one objective. Use the repository's commit, title, merge, and
   release conventions. Do not add AI attribution or hand-edit generated release
   files.
4. Identify the production diff separately from tests, documentation, generated
   artifacts, and review-response changes. This distinction controls the
   current-head review gate.

## Stage 1 — local gates and adversarial review

1. Run the repository's relevant typecheck, lint, tests, and build. Use targeted
   gates for a small docs-only change when local policy intentionally skips
   expensive CI.
2. Review the complete diff adversarially for correctness, security, data
   integrity, repository constraints, regressions, performance, accessibility,
   and misleading copy. Verify every concern against current source before
   changing code. Run this pass with a headless agent CLI (`claude -p` or
   `codex exec`) on the org's paid plans so it is a rigorous independent model
   review, not a self-check; for a large or high-risk diff, fan out multiple
   adversarial lenses and verify each finding against source before acting.
3. Re-run affected gates after fixes. Save a concise record of commands and
   results for the PR body or a PR comment.

### Conditional local CodeRabbit CLI review

The CLI is normally an additional review layer run before the GitHub App; when
the App is adaptively rate-limited it becomes the preferred substitute (rung 1
of the escape ladder below), because it is the same CodeRabbit engine on a
separate, non-throttled review quota. Run it when all of these are true:

- repository and organization policy permit third-party local review;
- the execution environment authorizes the binary and outbound network access;
- an already-approved authentication method is valid; and
- running it will not enable usage billing or incur a paid per-file review
  charge.

Current CLI commands use the `cr` binary:

```bash
command -v cr
cr auth status --agent
cr doctor
cr review --base <integration-branch> --agent > /tmp/coderabbit-review.jsonl 2>&1
```

Capture the full output because terminal truncation can hide findings. Run one
full local review after the diff settles, not on every edit or commit. Never
pass `--api-key`, enable usage billing, buy reviews, or opt into paid per-file
review without explicit user approval.

Classify inability to run the CLI precisely:

- `CLI_REVIEW_SKIPPED_BINARY`: `cr` is absent or not reachable through `PATH`;
- `CLI_REVIEW_SKIPPED_AUTH`: authentication is missing, expired, or invalid;
- `CLI_REVIEW_SKIPPED_NETWORK`: authorized execution cannot reach the service;
- `CLI_REVIEW_SKIPPED_POLICY`: repository, organization, sandbox, or execution
  policy prohibits the review. Do not bypass or escalate around that
  restriction.

Record the classification and evidence in the PR. For any skipped CLI review,
compensate with the deep local diff review above plus a completed GitHub App
review. Authentication and network failures may be retried only within existing
authorization; policy failures must not be bypassed.

### Adaptive-limit escape ladder (throttled or unavailable App review)

The GitHub App review is the default and stays preferred. But when it cannot be
produced because CodeRabbit is adaptively rate-limited — a documented Fair-Usage
or adaptive-limit notice, with **no** review object bound to the current head
after a bounded wait (one deliberate full-review request plus the stated
cooldown, re-verified against fresh GraphQL evidence) — do not stall the PR
indefinitely. Escalate in order and stop at the first rung that yields a
completed review of the settled production diff. Never enable billing, pass
`--api-key`, or opt into paid per-file review to climb the ladder; never spend
money to escape an adaptive limit.

1. **CodeRabbit CLI review — preferred substitute.** `cr review` is the same
   CodeRabbit engine on a separate, non-throttled review quota, so it usually
   completes while the App is throttled. It runs on CodeRabbit's cloud (not
   local inference) and is a genuine CodeRabbit review. Scope it to the settled
   production diff and capture full output:

   ```bash
   cr review --base <integration-branch> --agent        # full diff vs base
   cr review --base-commit <last-reviewed-sha> --plain  # only the unreviewed delta
   ```

   Address every finding, re-run gates, and record it as the review of record in
   the PR: the reviewed range, the findings (or "no findings") and their
   resolutions, and the classification `APP_REVIEW_UNAVAILABLE_ADAPTIVE_LIMIT`
   (App throttled → CodeRabbit CLI substitute). This satisfies the completion
   contract — it is a CodeRabbit review of the production diff.

2. **Agent-CLI review of record — last resort.** Only if even the CodeRabbit CLI
   is unavailable (itself rate-limited, offline, or unauthenticated), a
   comprehensive review by a headless agent CLI on the org's paid plans may
   stand in:

   ```bash
   claude -p '<adversarial multi-lens review of the settled diff>'   # or
   codex exec '<adversarial multi-lens review of the settled diff>'
   ```

   It must be genuinely comprehensive — multiple adversarial lenses, every
   finding verified against current source, findings addressed — not a rubber
   stamp. It is **not** a CodeRabbit review: record it classified
   `NON_CODERABBIT_AGENT_REVIEW` with the reviewing model, the diff range, and
   the findings and resolutions. Use this rung only when rung 1 is genuinely
   blocked, and prefer waiting for a real CodeRabbit review when the change is
   high-risk or security-sensitive.

Record the rung used, its evidence, and the classification in the PR before
merge. A rung-1 or rung-2 review still requires zero unresolved actionable
threads and green required CI on the current head, and any later production-code
change re-opens the review requirement on the new diff.

## Stage 2 — open the PR without wasting review allowance

1. Push the scoped branch and open a PR to the integration branch. The body
   states what changed, why, risk/rollback, validation, local review evidence,
   and any CLI skip code.
2. Avoid triggering CodeRabbit on every push. If more iteration is expected, use
   a draft PR when supported by repository policy or comment
   `@coderabbitai pause` after the first automatic review starts. Do not put
   `@coderabbitai ignore` in the PR description for a PR that requires review.
3. Batch review-response fixes, re-run gates, and push a settled diff. When
   production code has settled, request exactly one complete GitHub App pass
   with a top-level PR comment:

   ```text
   @coderabbitai full review
   ```

   `@coderabbitai review` is incremental and does not replace a required full
   review of a production diff. `@coderabbitai resume` re-enables automatic
   reviews and can cause later pushes to spend additional allowance; prefer a
   deliberate full-review request.

4. Wait for all required CI and the review to finish. Fetch fresh evidence,
   verify every finding against source, fix actionable findings, and reply with
   evidence before resolving false positives. Keep review-response commits
   scoped.
5. If a fix changes production code, the new production diff requires another
   completed review. Pause while iterating, settle the production diff again,
   then request one full review. Never treat silence or an older Walkthrough as
   the re-review.

## Adaptive-limit exception for post-review tests/docs only

The normal rule is a completed review on the current head. Merge without a
redundant current-head review is allowed only when **all** of these conditions
are proven:

1. A completed CodeRabbit review exists for the commit containing the settled
   production diff, and its SHA and Walkthrough/review evidence are recorded.
2. Every later change was directly requested by that completed review.
3. Every later change is limited to tests and/or documentation and cannot change
   production behavior, runtime configuration, generated production artifacts,
   dependencies, build or deployment behavior.
4. The PR explicitly lists the post-review files and maps each change to the
   requesting CodeRabbit finding.
5. All required CI passes on the current head, and an adversarial local review
   of the exact post-review diff finds no actionable issue.
6. CodeRabbit cannot re-review because it posted a documented adaptive
   review-limit message. Save the exact message and URL. Do not infer a limit
   from silence or a green check.

Record the exception as `POST_REVIEW_TEST_DOCS_ADAPTIVE_LIMIT` in the PR.
Rate-limit, quota, skipped, paused, ignored, or transport failures remain
non-reviews and do not create a general bypass. This exception only bridges an
already completed production-diff review to a current head containing its
requested test/docs-only follow-up. **Any production-code change, however small,
still requires a fresh completed review.** Never spend money to escape an
adaptive limit.

## Fresh status, SHA, Walkthrough, and thread verification

Set the PR and repository explicitly. Capture the head first, then paginate each
capped GraphQL connection into an evidence file:

```bash
set -euo pipefail

PR=<number>
REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
OWNER=${REPO%/*}
NAME=${REPO#*/}
EVIDENCE_HEAD=$(gh pr view "$PR" --json headRefOid --jq .headRefOid)

gh api graphql --paginate \
  -F owner="$OWNER" -F name="$NAME" -F number="$PR" \
  -f query='query($owner:String!,$name:String!,$number:Int!,$endCursor:String){
    repository(owner:$owner,name:$name){pullRequest(number:$number){
      headRefOid url
      reviews(first:100,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{
        author{login} state body submittedAt url commit{oid}
      }}
    }}
  }' > /tmp/pr-reviews.jsonl

gh api graphql --paginate \
  -F owner="$OWNER" -F name="$NAME" -F number="$PR" \
  -f query='query($owner:String!,$name:String!,$number:Int!,$endCursor:String){
    repository(owner:$owner,name:$name){pullRequest(number:$number){
      headRefOid
      comments(first:100,after:$endCursor){pageInfo{hasNextPage endCursor}
        nodes{author{login} body createdAt updatedAt url}
      }
    }}
  }' > /tmp/pr-comments.jsonl

gh api graphql --paginate \
  -F owner="$OWNER" -F name="$NAME" -F number="$PR" \
  -f query='query($owner:String!,$name:String!,$number:Int!,$endCursor:String){
    repository(owner:$owner,name:$name){pullRequest(number:$number){
      headRefOid
      reviewThreads(first:100,after:$endCursor){
        pageInfo{hasNextPage endCursor}
        nodes{id isResolved isOutdated path line}
      }
    }}
  }' > /tmp/pr-threads.jsonl

: > /tmp/pr-thread-comments.jsonl
jq -rs -r '.[].data.repository.pullRequest.reviewThreads.nodes[].id' \
  /tmp/pr-threads.jsonl |
while IFS= read -r thread_id; do
  gh api graphql --paginate -F id="$thread_id" \
    -f query='query($id:ID!,$endCursor:String){node(id:$id){
      ... on PullRequestReviewThread{
        comments(first:100,after:$endCursor){
          pageInfo{hasNextPage endCursor}
          nodes{author{login} body createdAt url commit{oid}}
        }
      }
    }}' >> /tmp/pr-thread-comments.jsonl
done
```

Confirm every evidence page belongs to the captured head, then inspect the
paginated files rather than relying on a check color:

```bash
jq -s -e --arg head "$EVIDENCE_HEAD" \
  'all(.[]; .data.repository.pullRequest.headRefOid == $head)' \
  /tmp/pr-reviews.jsonl /tmp/pr-comments.jsonl /tmp/pr-threads.jsonl
jq -rs -e -r --arg head "$EVIDENCE_HEAD" '
  [.[].data.repository.pullRequest.reviews.nodes[] |
   select(.author.login|ascii_downcase|contains("coderabbit")) |
   select(.commit.oid == $head)] |
  sort_by(.submittedAt) | last as $review |
  if $review == null then
    error("no CodeRabbit review found for the captured head")
  else
    [$review.commit.oid,$review.state,$review.submittedAt,$review.url,
     (($review.body // "")|gsub("[\\r\\n]+";" ")|.[0:160])] | @tsv
  end' /tmp/pr-reviews.jsonl
jq -rs -r '.[].data.repository.pullRequest.comments.nodes[] |
  select(.author.login|ascii_downcase|contains("coderabbit")) |
  [.createdAt,.updatedAt,.url,(.body|gsub("[\\r\\n]+";" ")|.[0:240])] | @tsv' \
  /tmp/pr-comments.jsonl
jq -rs -r '.[].data.repository.pullRequest.reviewThreads.nodes[] |
  select(.isResolved|not) | [.id,.isOutdated,.path,.line] | @tsv' \
  /tmp/pr-threads.jsonl
jq -rs -r '.[].data.node.comments.nodes[] |
  [.author.login,.createdAt,.url,(.body|gsub("[\\r\\n]+";" ")|.[0:240])] |
  @tsv' /tmp/pr-thread-comments.jsonl
```

Search review text and comments case-insensitively for at least `pause`, `skip`,
`ignore`, `rate limit`, `quota`, `limit`, `failed`, `error`, and `retry`. Read
matches in context; keywords are indicators, not a substitute for semantic
inspection.

Bind the check query and final merge decision to the same captured head. Restart
the entire evidence pass if any equality test fails:

```bash
set -euo pipefail

CHECK_HEAD=$(gh pr view "$PR" --json headRefOid --jq .headRefOid)
test "$CHECK_HEAD" = "$EVIDENCE_HEAD"
gh pr checks "$PR" --json name,bucket,state,workflow,link \
  | tee /tmp/pr-checks.json
jq -e '
  [ .[] | select((.name // "") | ascii_downcase |
    contains("coderabbit")) ] as $coderabbit |
  ($coderabbit | length) > 0 and
  all($coderabbit[]; (.bucket | ascii_downcase) == "pass") and
  all(.[]; ((.bucket | ascii_downcase) == "pass" or
    (.bucket | ascii_downcase) == "skipping"))' /tmp/pr-checks.json
FINAL_HEAD=$(gh pr view "$PR" --json headRefOid --jq .headRefOid)
test "$FINAL_HEAD" = "$EVIDENCE_HEAD"
printf 'evidence and checks verified on: %s\n' "$FINAL_HEAD"
```

CodeRabbit check names vary, so match a case-insensitive `coderabbit` substring
rather than one exact name. A terminal `pass` only closes the check-state gate;
it does not prove the semantic review gate.

Resolve a thread only after addressing the finding or replying with evidence
that it is not actionable:

```bash
THREAD_ID=<graphql-review-thread-id>
gh api graphql -F id="$THREAD_ID" \
  -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){
    thread{id isResolved}
  }}'
```

Re-query after resolution. Merge requires zero unresolved actionable threads,
including actionable human threads; do not use a bulk resolve command as a
substitute for triage.

## Merge gates

Merge only when all applicable gates hold:

- required CI is successful on the current head;
- a completed CodeRabbit review covers the current production diff, proven by
  SHA plus substantive review/Walkthrough text — from the GitHub App, or, when
  the App is adaptively rate-limited, a documented **Adaptive-limit escape
  ladder** review (rung 1 CodeRabbit CLI, or rung 2 agent-CLI review of record);
  or the strict test/docs adaptive-limit exception is fully documented;
- CodeRabbit is not pending and no non-review outcome is being presented as
  success;
- zero unresolved actionable review threads remain;
- scope, risk, rollback, and repository-specific done criteria are satisfied;
  and
- the PR title and merge method follow repository policy.

Then merge with the repository's convention, for example:

```bash
gh pr merge "$PR" --merge --delete-branch \
  --match-head-commit "$FINAL_HEAD"
```

If branch protection requires an unavailable human approval, a required service
is down, or evidence cannot be established, leave the PR open and report the
exact blocker. Do not weaken protection, infer success, enable billing, or spend
money.

## UI polish checks

Apply these when a PR touches UI, layout, motion, or shared primitives:

- avoid broad `transition-all`; transition only intended properties;
- respect `prefers-reduced-motion`, including decorative and loading motion;
- make hover-revealed controls work with keyboard focus and touch;
- tie fixed/sticky offsets to live layout values or tokens;
- render first-viewport and LCP content in SSR HTML rather than hiding it behind
  hydration;
- cancel deferred callbacks, timers, smooth scroll, and animation-frame work
  safely; and
- use semantic design tokens instead of hardcoded app-surface colors.

## Operating notes

- CodeRabbit CLI and GitHub App reviews have different contexts and separate
  review quotas; neither proves the other ran, but that separate CLI quota is
  exactly why `cr review` is the preferred escape when the App is adaptively
  throttled.
- Prefer a real CodeRabbit review (App, then CLI) over an agent-CLI review of
  record; drop to the agent-CLI rung only when both CodeRabbit channels are
  genuinely unavailable, and never to avoid addressing findings.
- Automatic and manual PR reviews draw from review allowance. Pause active
  iteration and trigger deliberate reviews only after meaningful diff
  stabilization.
- API/network errors are retryable within authorization, but never count as
  completion.
- In zsh, avoid reserved variable names such as `status` and do not assume
  unquoted variables perform shell word splitting.
- If bounded polling times out, report the timeout and leave the PR unmerged.
