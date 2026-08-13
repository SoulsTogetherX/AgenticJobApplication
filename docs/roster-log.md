# Roster log

Every hire, fire, ownership ruling and staffing decision, dated with its
reason. Split out of [team-roster.md](team-roster.md) on 2026-07-31 (R6),
where it was over half the bytes every agent read at session start.

The roster proper answers "who owns this path?". This file answers "why?",
which is a question worth being able to answer and not worth paying for on
every turn.

| Date       | Change                                                             | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-07-30 | Hired the initial 11 (3 innovators, 6 workers, 2 QA)               | Autonomy build kickoff; file sets carved disjoint from the plan's phases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-07-30 | Added `cicd` and `scribe` as **distinct roles**                    | User decision: CI/CD and documentation are their own disciplines, not worker sidelines                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2026-07-30 | `w6-documents` gave up `docs/` and `.claude/skills/`               | Collided with `doc-scribe`. w6 keeps the user's résumé pipeline; the scribe takes the prose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2026-07-30 | `ci-engineer` took `package.json` and `.gitignore`                 | Previously unowned. Single owner because uncoordinated edits leak personal data                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2026-07-30 | Adopted the cross-check protocol                                   | User decision: agents keep each other in check. Prompted by a run reporting `completed` over six errored agents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2026-07-31 | `w2-engine` took the three `apply-job/*.js` files                  | Unowned in the original carve-up. They are eval'd browser code, not docs; `doc-scribe` keeps `SKILL.md` there                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2026-07-31 | **`w2-engine` runs BEFORE `w3-resolution`**, not beside it         | User decision. 147eb68 is the evidence: run concurrently, w2's spec cannot reach w3 in time and the RCE survived a green suite                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2026-07-31 | Tie-break invoked: `w2-engine` vs `qa-adversary` on `labelExact`   | First use of the third-lens rule. `innov-resilience` ruled **patch, not structural**, and proved it by running `buildPlan` rather than arguing. Neither side was overruled by the manager                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2026-07-31 | Hired `innov-resilience` mid-wave                                  | Worker-vs-QA disagreement needed a third lens; announced late, which is the gap the announce rule now closes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-07-31 | Hired `doc-scribe` mid-wave                                        | Three documents had begun describing behaviour the code no longer had, and drift is invisible to its author                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2026-07-31 | Roster changes must be **announced**; agents may **request hires** | User decisions. A silent change leaves workers with a stale map; a worker blocked outside its file set had no route but to work around it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2026-07-31 | Hired `researcher` as a **seventh role**; role floor 6 → 7         | User decision. Every other non-manager role reads this repository; nobody was reading the market it operates in. Owns the new `docs/research/`, so no file set was taken from anyone                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-07-31 | `qa-breaker` took `tests/dev/` and `scripts/dev/flake-rate.mjs`    | Previously unowned and flagged by its author. Flake rate measures test reliability, a QA property, so it is not an `innov-perf` `bench-*` file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2026-07-31 | **Hire request from `qa-breaker`: browser-leg agent — DEFERRED**   | Need is real (6 quantities and 2 fixtures need a browser) but blocked three ways: no `playwright-core` until Phase 3.1, the agent registry is fixed at session start, and "no non-manager gets Playwright" is a plan-level rule the user must amend. File set pre-approved for when it unblocks                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2026-07-31 | **Hard rule 6 rewritten: auto-submit permitted, off by default**   | User decision. Was "never auto-submit". Now: submit on a board passing a mechanical trust gate when nothing needed a judgement, defer everything else **with a stated reason**. Ships `enabled: false, dry_run: true`; none of it is built. Manager edited `CLAUDE.md` DIRECTLY, which is `doc-scribe`'s file — an exception taken knowingly because a hard-rule rewrite is a policy record, not documentation, and paraphrase risk on a safety rule outweighs the ownership ceremony. `doc-scribe` owes a sweep of dependent docs                                                                                                                                                                                                                                 |
| 2026-07-31 | `.claude/settings*.json` left `ci-engineer` for the user           | Follows the guardrail sealing above. Hook and permission changes now come to the user                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2026-07-31 | Manager owns advancing `package.json`'s `phases.current`           | `ci-engineer` flagged it unowned: the scaffolding reaper compares `remove_after` against it, so nothing ever expires until it moves. The manager owns the decision to ship a phase, so the marker follows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2026-07-31 | Manager **clears a full agent's context between jobs**             | User decision. Resuming keeps context, which is right mid-job and wrong between jobs; four agents died on session limits at once, one partway through an owned file set. A cleared agent is owed a handoff — ownership belongs to the role, not the instance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-07-31 | **Ownership violation KEPT on merit**: w3 → `fill-plan.test.mjs`   | `w3-resolution` edited `qa-breaker`'s test file while landing the value-carrying-act rule. Assessed rather than reverted, per the escalation rule, and **kept**: it rewrote exactly the two assertions that hard-coded the pre-rule policy (`"the EEO radio group must still auto-check"`), preserved their original intent — proving the new guard is not a repaint of the class gate — and added the `readiness` vs `submitReadiness` split the rule creates. Reverting would have restored an assertion that is now factually wrong. **The boundary was re-stated to w3 and the file handed back to `qa-breaker` with the remaining six failures.** A violation that produced correct work is still a violation; the ruling is on the artifact, not the conduct |
| 2026-07-31 | Handoff resumption assumption **did not hold**                     | The previous session left the tree red and unreverted specifically so `SendMessage` could resume the mid-edit agents from their transcripts. Agents do not survive a main-session restart, so all six were dispatched **fresh with written handoffs** instead. The uncommitted work was still the right call — it carried the design; only the delivery mechanism was wrong. Recorded so the next handoff does not budget on resumption                                                                                                                                                                                                                                                                                                                            |
| 2026-07-31 | **`scripts/applications/*` → `w4-autonomy`** (was unowned)         | Flagged by `doc-scribe`. Goes to the owner of `scripts/lib/db.mjs` because the behaviour these scripts describe lives there — the inherited defect is a comment in `check-applied.mjs` describing `resolveApplicationSource()` in `db.mjs`. Separating a reader from the schema it reads is what let them drift. Ruling: **correct the comment, do not build the mtime fallback it describes** — letting a stale generated export win on mtime is worse than the bug                                                                                                                                                                                                                                                                                               |
| 2026-07-31 | **`.claude/agents/*` → `build-manager`** (was unowned)             | Flagged by `doc-scribe`. Agent definitions are the roster made executable, so they belong with the file recording who exists and what they own. Ruling on the `job-worker` return-cap contradiction: **the agent's own definition governs and the skill follows it** — the definition is what the agent reads at runtime, the skill only documents a caller's expectation, so a disagreeing skill is wrong by construction                                                                                                                                                                                                                                                                                                                                         |
| 2026-07-31 | Reaper's third key `owner:` documented                             | `doc-scribe` found the scaffolding reaper reading a key neither this file nor `CLAUDE.md` mentioned. Omitted, the report reads `UNASSIGNED` — which is how a scaffolding artifact reaches its expiry with nobody to remove it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2026-07-31 | **R6 (split `CLAUDE.md`) approved as its own wave — DEFERRED**     | `doc-scribe` requested it and reported against itself that `CLAUDE.md` GREW 481 → 517 lines under its own sweep. Granted, but not while six agents are live: it is the file every agent re-reads at session start, so restructuring it mid-wave invalidates briefs in flight. It gets a wave where `CLAUDE.md` is quiet and the split is the task. Logged so the request cannot vanish                                                                                                                                                                                                                                                                                                                                                                             |
| 2026-07-31 | Manager corrected `autonomy-plan.md`'s Phase 2 table directly      | `doc-scribe`'s file, edited by the manager as a knowing exception under the new "do not spawn a fresh agent for a follow-up smaller than its own context rebuild" rule. Six of nine rows were already implemented and the table did not say so, which cost two full agent jobs to discover. The correction is a **status record with measured numbers the manager already held**, not prose — hiring a scribe to retype facts from two reports would have been the exact waste the rule was written to stop. `doc-scribe` owns any later rewrite of the surrounding text                                                                                                                                                                                           |
| 2026-07-31 | `lock.mjs` + `tests/lib/lock.test.mjs` → `w1-security`, TEMPORARY  | Moved from `w4-autonomy` for one job, under the "widen a brief rather than hire" rule. `innov-resilience` ruled that `lock.mjs` must adopt `save-answer.mjs`'s age-only semantics and **never the reverse** — the two implementations diverged precisely because two agents built locking independently, and splitting the convergence across two owners again would reproduce that. `w1-security` authored the correct implementation and holds the measurements. **Reverts to `w4-autonomy` when the job lands**; `w4` keeps `scripts/auto/*`, `lib/db.mjs`, `automatability.mjs`, `auth-sync.mjs` and `tests/auto/` throughout                                                                                                                                  |
| 2026-07-31 | `lock.mjs` + `tests/lib/lock.test.mjs` → back to `w4-autonomy`     | The temporary move above is **spent**; the job landed green (1350 tests, 0 fail) and ownership reverts as stated when it was granted. It worked: the pid probe is gone, and `readLock`/`breakStale`/`isRetryableCreateError` are single-sourced from `lock.mjs` instead of existing twice. **Binding on the next owner** — `save-answer.mjs` keeps its own acquire loop deliberately, because full adoption regresses a committed `AJ_LOCK_TIMEOUT_MS=200` contract; do not "finish" the adoption without resolving the ordering-invariant question recorded in that commit                                                                                                                                                                                        |

## Contested paths and unowned sets, resolved

_Moved out of `team-roster.md` 2026-08-01. Every conclusion below is already
reflected in that file's **Current roster** table, which stays authoritative;
this is the reasoning behind each, kept so the same disputes are not
re-litigated._

#### Contested paths, resolved

- `scripts/apply/fill-plan.mjs` — **`w3-resolution`**. `w2-engine` delivers the
  replacement `buildDriverSource()` as a spec.
- `.claude/skills/apply-job/scan-page.js`, `scan.driver.mjs`, `fill-page.js` —
  **`w2-engine`**, not `doc-scribe`. They live under `.claude/skills/` but they
  are executable code eval'd in a browser, not prose; the scribe owns `SKILL.md`
  in that directory and nothing else. `scan-page.js` is the single source of
  truth for the scan, so it belongs with the engine that consumes it.
- `scripts/leads/risk.mjs` — **`w5-leads`**. `w1-security` sends the
  `injection_attempt` spec.
- `scripts/documents/verify-claims.mjs` — **`w1-security`**, not
  `w6-documents`, because its evidence corpus is a security control.
- `package.json` and `.gitignore` — **`ci-engineer`**, and this one is a safety
  rule, not bookkeeping: `.gitignore` is what keeps `profile/` and `.env` out of
  the history, and `package.json` is where a dependency enters the project.
  `w4-autonomy` **requests** `playwright-core`; it does not add it.
- `docs/` splits four ways — `measurements.md` to `innov-perf`, this file and
  `agent-protocol.md` to `build-manager`, `candidates/` to `w5-leads`, the rest
  to `doc-scribe`.
- `docs/application-limits.yaml` — **the user's file. No agent edits it.**
  Propose values; the user approves. `researcher` reads it constantly (it is
  the scope of every market question) and edits it never.
- `scripts/dev/flake-rate.mjs` and `tests/dev/` — **`qa-breaker`**, which built
- `scripts/dev/bench-apply.mjs` — **`qa-breaker`**, and this resolves a real
  collision: line 138 gave `innov-perf` the whole `bench-*` glob while line 149
  named this one file to `qa-breaker`. **The specific line wins over the glob.**
  `qa-breaker` built the gate matrix, found the `BANK_ID_RE` defect that made a
  `CONFIRM` structurally unreachable, and wired the `--browser` leg; the shapes
  it benchmarks are its own edge cases. `innov-perf` keeps `docs/measurements.md`
  — the **ledger** — and every other `bench-*`. That split is the point: the
  agent that takes a measurement does not also own the record of what the
  project believes, so a number has to survive a second party to become fact.
  Flagged independently by `qa-breaker` and by the manager's brief to
  `innov-perf`, which had already told it not to edit that file.
- `tests/auto/` — **`w4-autonomy`**, not `qa-breaker`. It mirrors
  `scripts/auto/`, which `w4` built from nothing and tested as it went.
  `qa-breaker` never wrote there and **flagged the contradiction rather than
  claiming it**, which is the behaviour this section exists to reward.
  `tests/auto/auth-sync.test.mjs` is a deliberate mirror exception: the script
  lives at `scripts/apply/auth-sync.mjs` but is autonomy work, and splitting it
  from its siblings to satisfy the convention would cost more than it buys.
- `scripts/dev/flake-rate.mjs` and `tests/dev/` — **`qa-breaker`**, which built
  them and flagged them as unclaimed. `innov-perf` owns `scripts/dev/bench-*`,
  and flake rate is not a `bench-*` file: it measures **test reliability**, a QA
  property, rather than product speed. `tests/dev/` is the one-for-one mirror of
  `scripts/dev/`, so it follows its author.
- `docs/research/*` — **`researcher`**, a new directory so nothing was taken
  from anyone. Findings only. `docs/tailoring-rules.md` stays with `doc-scribe`
  and `scripts/lib/keywords.mjs` stays with `w1-security`: the researcher says
  what the lexicon is missing, the owner decides what goes in it. That split is
  deliberate — it keeps a claim sourced from the open web from becoming a term
  this pipeline will place in a résumé without an owner having agreed to it.
- `.claude/hooks/*` and `.claude/settings*.json` — **nobody. The user's alone**
  (user decision 2026-07-31). `protect-profile.js` always denied writes to its
  own directory on the Edit/Write path; the manager then probed the SHELL path
  and found it open — `"probe" | Out-File .claude/hooks/__probe.txt` succeeded,
  so an agent could have rewritten the guard denying it. Both hooks were
  extended: the shell guard now covers `.claude/hooks/` and
  `.claude/settings*.json`, and `protect-profile.js` now covers
  `settings*.json` too.

  `settings.json` is in scope for a reason that is easy to miss: it **wires**
  every hook, so a guard is disabled by deleting one line there without ever
  touching a protected file. Flagged independently by `ci-engineer` and by
  `guard-profile-shell.mjs`'s own residuals note — two confirmations.

  **Cost, accepted knowingly:** `ci-engineer` can no longer wire a hook, add a
  permission or change a matcher; those come to the user. That is the trade,
  because `settings.json` is precisely where a guardrail gets switched off.
  Known false positive: `git commit -m` whose MESSAGE names a guarded path and
  contains `rm`/`install` is denied — use `git commit -F <file>`.

- **Comments** — owned by whoever owns the file, _except_ in a post-merge
  comment window granted to `doc-scribe`, who may then edit comments and
  docstrings only, never executable code.

#### `tests/auto/` — resolved 2026-07-31 to `w4-autonomy`

Flagged independently by **both** parties, which is why it was easy to settle:
`w4-autonomy`'s agent definition grants it `tests/auto/`, this file's roster
line gave it to `qa-breaker`, `w4` wrote there on the strength of its
definition, and `qa-breaker` declined to touch it and asked for a ruling
rather than claiming it.

**Ruled to `w4-autonomy`, and the roster line is the thing that was wrong.**
Three things agree against one: `tests/` mirrors `scripts/` one-for-one
(`CLAUDE.md`, Structure), and `tests/auto/` mirrors `scripts/auto/`, which
`w4-autonomy` owns and built from nothing; its agent definition already
granted it; and it is the actual author of all 71 tests there. Only the roster
line disagreed, so the roster line is corrected rather than the work moved.

This does **not** contradict the `job-worker` ruling above, and the difference
is worth stating because the two look alike. That one was about **runtime
behaviour** — the caps an agent reads and obeys — where the definition governs
because it is the text the agent actually executes against. This one is about
**file ownership**, where this file is normally authoritative. It goes the same
way only because the definition, the mirror convention and the authorship all
point one way and a single stale line pointed the other.

`qa-breaker` keeps `tests/apply/` (not `fill-page.*`), `tests/dev/`,
`scripts/dev/bench-apply.mjs` and `scripts/dev/flake-rate.mjs`.

#### Two file sets that had no owner, resolved 2026-07-31

Both were found by `doc-scribe`, which flagged them rather than picking a
winner unilaterally — the correct move, because an unowned set is an error and
guessing at an owner hides it.

- **`scripts/applications/*`** — **`w4-autonomy`**. check-applied,
  log-application, update-application, follow-ups, applications.mjs. It goes
  here and not to a new owner because the behaviour these scripts describe
  lives in `scripts/lib/db.mjs`, which `w4-autonomy` already owns: the defect
  below is a comment in `check-applied.mjs` describing
  `resolveApplicationSource()` in `db.mjs`. Splitting a reader from the schema
  it reads is exactly what let the two drift apart unnoticed.

  **The live defect it inherits.** `check-applied.mjs:40-41` says the read
  "falls back to the YAML automatically if that file has been edited more
  recently." **There is no mtime comparison anywhere in the tree** —
  `resolveApplicationSource()` (`db.mjs:454`) falls back to YAML only when
  `jobs/leads.db` does not exist. Verified by reading both. A user who trusts
  that comment and hand-edits `profile/applications.yaml` has the edit
  silently ignored for as long as the database exists.

  **Ruling on the fix: correct the comment, do NOT implement the mtime
  fallback.** `db.mjs`'s own header states the design — `applications.yaml` is
  a one-way generated export, never read back except to bootstrap a database
  that does not exist. Making a hand-edit win on mtime would let a stale export
  silently override the store of record, which is a worse failure than the one
  being fixed. The comment is what is wrong. **`doc-scribe` additionally owes
  the user-facing half**: the real recovery path (how a hand-edit _is_ made to
  take effect) is currently documented nowhere, and rule 2 makes that file the
  user's, so "your edit is ignored" cannot be the whole answer.

#### A third unowned set, resolved 2026-08-01

`autonomy-plan-v2.md` §0.3 found that **`scripts/status.mjs` and
`scripts/maintenance/*` appear in no ownership row at all** — `grep -n
"status\.mjs\|maintenance" docs/team-roster.md` returned nothing before this
entry. Phase 1.7 (`migrate.mjs` rebuild path for `auto_queue`), Phase 1.8
(workspace retention, a `prune-jobs`/`archive` concern) and Phase 4.2 (the auto
section of the progress digest) all require edits to them, so this had to be
settled before Phase 1 opens rather than discovered by two agents writing the
same file.

**Ruled to `w4-autonomy`**, on the same reasoning that sent `scripts/applications/*`
there: both are readers of `scripts/lib/db.mjs`, which `w4-autonomy` owns, and
splitting a reader from its schema is precisely what let `check-applied.mjs`
drift for weeks. `status.mjs` under Phase 4.2 becomes overwhelmingly a reader of
`auto_queue`; `maintenance/prune-jobs.mjs` and `archive.mjs` decide what happens
to the workspace directory that grows fastest under this plan.

**The one cost of the ruling, stated rather than hidden:** `w4-autonomy` now
owns more paths than any other worker, and `status.mjs` is a whole-pipeline
digest whose other sections belong to nobody in particular. If the digest work
turns out to be its own job rather than a section, split `status.mjs` out to a
fresh owner then — do not quietly grow `w4-autonomy` further.

- **`.claude/agents/*`** — **`build-manager`**. Agent definitions are the roster
  made executable; they belong with the file that records who exists and what
  they own, not with the prose scribe. `doc-scribe` keeps `SKILL.md`.

  **Ruling on the contradiction it found** (`job-worker.md` caps returns at
  `summary ≤40 / next_step ≤25`; `pipeline-jobs/SKILL.md` says `≤50 / ≤30`, for
  the same agent): **the agent's own definition governs, and the skill follows
  it.** The definition is the text the agent actually reads at runtime; the
  skill documents a caller's expectation. When they disagree the skill is
  wrong by construction, because it cannot change what the agent was told.
  So `40/25` stands and `SKILL.md` is corrected — filed to `doc-scribe`.
