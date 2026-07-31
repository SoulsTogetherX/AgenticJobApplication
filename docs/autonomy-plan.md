# Autonomous apply pipeline: security, speed, and an agent team

## Context

The pipeline today needs a human in the loop at every step. You want it to run
itself: sweep every 12 hours, decide which jobs it can apply to alone, and apply
to those unattended — plus a separate stream of recruiter contacts for you to
work by hand.

Three audits ran first. They found that the autonomy you're asking for is
currently unsafe to switch on, and that the slowness has specific, measurable
causes:

- **A hostile job board can run arbitrary code with the Playwright handle.**
  [fill-plan.mjs:372-376](scripts/apply/fill-plan.mjs:372) injects the fill
  engine into the page, then reads it **back out** of that same page and
  `eval`s it Playwright-side. A board that defines a `window.__ajFillSrc`
  getter owns the browser: it can click Submit itself, drive your logged-in ATS
  profile, or `setInputFiles` your `.env` into its own form. Unattended
  operation removes the person who would notice.
- **`untrusted.mjs` protects almost nothing.** It has exactly two importers
  ([keyword-plan.mjs:30](scripts/documents/keyword-plan.mjs:30),
  [risk.mjs:27](scripts/leads/risk.mjs:27)), and one of them discards the
  cleaned text. Its hidden-HTML defence is structurally dead: `textSnippet()`
  flattens HTML at ingest, hours before the sanitiser runs, so a
  `display:none` payload arrives as ordinary visible prose. 25 bypass strings
  were verified by hand, including the Unicode Tags block, any non-English
  instruction, and base64 under the 120-char threshold. Zero tests assert that
  any caller invokes it.
- **`ready=true` is unreachable, so the fast path never fires.**
  [fill-plan.mjs:322](scripts/apply/fill-plan.mjs:322) counts consent checkboxes
  as blocking defers, and nearly every real form has one. The documented
  scan → fill → hand-over path has never once executed.
- **The measured sleep budget**: ~6.8s of unconditional `waitForTimeout` in the
  scan probe (380ms × up to 18 dropdowns), ~17s in the fill on a real 14-combo
  Greenhouse form, and up to 45s if a cover letter goes into a `contenteditable`
  (`keyboard.type` at 15ms/char, uncapped). One page costs 4 browser round trips
  and ~12 model turns.

The outcome: an engine a hostile board cannot move, a green tier that applies
without a model in the loop at all, and a recruiter list you work manually.

## Not building: hidden prompt injections in resumes

You asked for hidden text in your tailored resumes aimed at employer screening
systems. I'm not building that. It's deception directed at a third party,
carried on a document signed with your name, and it is the same attack class
this plan spends its entire first phase defending you against.

What replaces it: `keyword-plan.mjs` already computes fact-backed keywords in
both acronym and expanded form, and Phase 4 makes `ats-lint.mjs` blocking and
adds a ground-truth extraction check — so real keywords in visible text are
provably surviving into the parser. That's the legitimate version of the same
goal, and it's the part that's currently missing.

## Decisions taken

| Question    | Your decision                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| Limits      | Sweep and store everything; auto-apply only within `application-limits.yaml`                                |
| Slim odds   | L2 fit must **not** reject on the auto path — it becomes ranking-only there                                 |
| Auto-submit | Green tier fills **and submits**, notify after. Hard rule 6 gets rewritten                                  |
| Sequencing  | Security first; autonomy ships only when a hostile board can't move the engine                              |
| Recruiters  | All six sources: HN, already-fetched payloads, careers pages, staffing agencies, dev-community, own history |
| Doc format  | Enforce `ats-lint` as a gate, simplify the template, prove extraction works                                 |
| Structure   | Algorithms over reasoning; where reasoning is unavoidable, batch it into one parallel fan-out               |
| Rewrites    | Destroy and replace where patching has run out — see the rewrite backlog                                    |
| Commits     | Granular commits to `dev` only (rule 7 unchanged); a commit is the rollback unit                            |
| Regressions | Innovators keep a measurement ledger and may request a rollback; worker confirms regression vs. in-progress |
| Models      | Fable 5, Opus and Sonnet all in play; per-role assignment is measured, not asserted                         |
| Roles       | Six, not four — `cicd` and `scribe` are distinct roles, not worker specialisations                          |
| Checking    | Every agent verifies another, manager included; a self-report is a claim, not evidence                      |
| Skills      | New skills welcome; dev-only ones marked `scaffolding` and reaped by a CI check, not by memory              |

---

## Design principle: reasoning is a last resort, and it is never sequential

This governs every phase below.

**Rule A — if it can be a function, it must be a function.** A model turn costs
seconds; a Node call costs milliseconds. The audit found reasoning standing in
for algorithms in several places, and each one is deleted rather than optimised:

| Model turn today                             | Becomes                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| "Which ATS is this?"                         | `detectAts(url)` — a pure function that already exists, unexposed. Add a CLI                                  |
| "Have I applied to this board before?"       | A `--known-board <url>` lookup against the field cache                                                        |
| "Read `ready=`, then decide whether to fill" | `fill-plan.mjs` exits non-zero when something actionable is outstanding, and the shell chains the fill        |
| "Branch on `description=<n>\|missing`"       | Exit codes already carry it; chain on them                                                                    |
| "Extract company/title from page text"       | `--from-lead` when a lead exists; the model path is the fallback                                              |
| "Pick options for deferred fields"           | An exact-label answer resolves `OK` forever. Every question answered once is a model turn deleted permanently |

Target: the green path reaches **zero** model turns; the amber path drops from
~12 to at most one.

**Rule B — when reasoning is genuinely required, fan out once and wait once.**
Never `agent → read result → agent`. The existing
[pipeline-jobs](.claude/skills/pipeline-jobs/SKILL.md) already got this right —
_"fan the run out in ONE wave rather than waves of three"_ — because the DB sets
`busy_timeout` before `journal_mode=WAL`, so concurrent writers wait instead of
dying. Extend that pattern everywhere reasoning survives:

- **Deferred form questions**: `pending-questions.mjs` already merges defers
  across every prepped job and keys them on the normalized label, so one answer
  resolves the same field everywhere. Make it emit **one** batched decision
  request covering all pending jobs, not one per job.
- **Model screening (Stage A)**: currently per-job and sequential. One wave over
  all `caution`/`pass` leads; verdicts persist to `screens` with `source: model`
  so they're never re-paid.
- **Tailoring**: one wave, one subagent per slug, `--cluster` first so
  near-duplicate postings collapse into a single tailoring run.
- **This build**: all six workers and both QA agents launch in **one wave**, not
  a sequence. Phase 1 gates whether autonomy _ships_, not whether the other
  workers _start_ — their file sets are disjoint, so they proceed concurrently
  and the manager holds the auto-submit flag off until the Phase 1 tests pass.

**Rule C — measure, don't assert.** Every latency claim in Phase 2 is a number
from `bench-apply.mjs` against the local fake board, before and after.

---

## The agent team

**Six roles: manager, worker, QA, innovator, cicd, scribe.** The last two are
distinct roles, not worker specialisations — a worker ships features,
`ci-engineer` ships the machinery that proves features work, and `doc-scribe`
ships what the project says about itself. Everyone owns **disjoint file sets**
so a whole wave runs without collisions; managers own no files at all.

New definitions in `.claude/agents/`, alongside the existing
[job-worker.md](.claude/agents/job-worker.md). Everyone inherits: never edit
`profile/`, never render final PDFs, write only inside owned paths.

**The Agent tool is a manager-only privilege.** Nobody else can spawn children —
that is what keeps the tree bounded and what makes "no subagent ever drives a
real employer's form" structural rather than aspirational. **No non-manager gets
Playwright tools**, and the only browser any agent may touch during the build is
the local fake board (see QA below).

### Starting roster

| Agent              | Role       | Model   | Owns (exclusive)                                                                                                                     |
| ------------------ | ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `build-manager`    | manager    | Opus    | Nothing. Assigns, reviews diffs, integrates, runs `npm test` + `gate-audit.mjs`, hires and fires                                     |
| `innov-architect`  | innovator  | Fable 5 | Nothing. Module boundaries, data model, deletion candidates                                                                          |
| `innov-perf`       | innovator  | Opus    | `scripts/dev/bench-*.mjs`, `docs/measurements.md`. Measures before anyone optimises                                                  |
| `innov-resilience` | innovator  | Opus    | Nothing. Failure modes, concurrency, security architecture, 10× behaviour                                                            |
| `w1-security`      | worker     | Opus    | `lib/untrusted.mjs`, `lib/lib.mjs`, `documents/verify-claims.mjs`, `profile/save-answer.mjs`                                         |
| `w2-engine`        | worker     | Opus    | `apply/fill-engine.mjs`, `apply/scan-engine.mjs`, `apply/browser.mjs` (all new)                                                      |
| `w3-resolution`    | worker     | Sonnet  | `apply/fill-plan.mjs`, `answer-bank.mjs`, `field-cache.mjs`, `pending-questions.mjs`, `apply/ats/`                                   |
| `w4-autonomy`      | worker     | Opus    | `scripts/auto/*`, `lib/lock.mjs`, `lib/db.mjs`, `apply/automatability.mjs`                                                           |
| `w5-leads`         | worker     | Sonnet  | `scripts/leads/*`, `scripts/recruiters/*` (new)                                                                                      |
| `w6-documents`     | worker     | Fable 5 | `scripts/documents/*` (not verify-claims), `templates/*` — **the user's résumé pipeline only**                                       |
| `ci-engineer`      | **cicd**   | Opus    | `.github/workflows/*`, `package.json`, `scripts/hooks/*`, `.claude/settings*.json`, `.gitignore`, `.prettierignore`, `tests/hooks/*` |
| `doc-scribe`       | **scribe** | Fable 5 | `CLAUDE.md`, `README.md`, `docs/reference/*`, most `docs/*.md`, `.claude/skills/*`, `schemas/*`                                      |
| `qa-adversary`     | QA         | Fable 5 | `tests/security/`, `tests/fixtures/boards/`, `tests/fixtures/hostile/`                                                               |
| `qa-breaker`       | QA         | Opus    | `tests/apply/`, `tests/auto/`, `scripts/dev/bench-apply.mjs`                                                                         |

Contested paths are resolved in [team-roster.md](docs/team-roster.md). Two are
worth stating here because they are safety rules rather than bookkeeping:
**`ci-engineer` owns `package.json` and `.gitignore`** — `.gitignore` is what
keeps `profile/` and `.env` out of the history, and `package.json` is where a
dependency enters the project, so `w4-autonomy` _requests_ `playwright-core`
rather than adding it. And **no agent edits
`docs/application-limits.yaml`**; that is the user's file.

### The two new roles

**`ci-engineer` makes the plan's gates mechanical instead of remembered.** Right
now "autonomy ships only when the security tests pass" is enforced by someone
remembering it. It becomes a named, blocking CI job. Also: a green run must
**prove tests ran** — `node --test` exits 0 on an empty run, so the test _count_
is asserted, not just the exit code. And it fixes what is already broken:
`npm run verify` points at a file that moved in the reorg, two pre-approved
permission paths are dead, and `guard-bash.mjs` over-matches (it denied
`git branch --show-current`, a read-only query, during this session).

**`doc-scribe` owns documentation and comments** — and comments are the
interesting part, because they live in every file. Ownership is therefore
**temporal**: read-only review continuously, plus an exclusive comment window
after each phase merges, in which it may edit comments and docstrings **only,
never executable code**. Its hardest rule: _never delete a comment that records
a failure that actually happened._ This codebase's comments carry real incident
history — "this broke the fill step on a live application", "six false positives
in nine probes" — and those are regression guards written in prose.

### Cross-check: every agent keeps every other honest

Full contract in [agent-protocol.md](docs/agent-protocol.md).

**A self-report is a claim, not evidence.** Nobody can verify their own work,
because the blind spot that caused the miss also hides it. The failure this
guards against was observed in this project on 2026-07-30: a background run
reported status `completed` while all six of its agents had errored and done
nothing. The summary said success; only the failure block said otherwise.

Rules that make it real rather than a slogan:

- **Verify against artifacts, never against a report** — read the diff, run the
  command, open the file.
- **Every claim must be falsifiable.** Report a suite result _with its test
  count_; report a measurement _with its command_; report a fix _with the file
  and the behaviour that changed_.
- **"Nothing found" requires saying how you looked.** A clean check with no
  method described is treated as not checking.
- **No log-rolling** — never trade approvals.
- **Report your own incompleteness first.** A checker finding a gap you knew
  about and did not mention is the one thing treated as bad faith.

Two checks carry more weight than the rest. **`qa-breaker` canaries the
pipeline**: deliberately break something, confirm the build goes red, revert. A
CI config that cannot fail is the purest form of slacking and it hides everyone
else's. And **every file owner checks `doc-scribe`** — documentation drift is
invisible to its author and obvious to whoever owns the code.

### Skills, and the scaffolding rule

`doc-scribe` may add skills that help development or the shipped product.
Development-only skills declare `scaffolding: true` and a `remove_after` phase in
frontmatter, and **`ci-engineer` fails the build when one outlives its phase** —
so "we'll remove it when we're done" is a check rather than a promise.

Likely scaffolding: a fake-board runner, a benchmark runner, a cross-check
helper. Likely permanent: a recruiter-outreach skill that surfaces the contact
list for the user to work by hand, and an auto-run status skill that reports what
the unattended runner did overnight — which matters precisely because the user
will not have a session open when it runs.

**Model assignment is a starting hypothesis, not a fixed cost.** Fable 5 goes to
the three roles whose output is generative rather than mechanical —
`innov-architect` (proposing rewrites), `qa-adversary` (inventing hostile job ads
and novel bypasses), and `w6-documents` (resume template and prose). Opus holds
the security, engine and autonomy work where a subtle mistake is expensive;
Sonnet holds the mechanical file-by-file work, per the token-discipline rule
already in `CLAUDE.md`.

I'm not going to assert which model is best per role from memory. **`innov-perf`
measures it** — same ledger, same protocol as every other change — and the
manager re-staffs on the numbers. That is exactly the "take measurements to
determine the best course of action" mandate applied to the team itself, and it
makes model choice one more thing the innovators can request a rollback on.

### The innovators

Three lenses, deliberately non-overlapping so their advice doesn't collapse into
one opinion. They **write no product code** — they read, measure, and answer.
Workers consult them mid-task via `SendMessage`, which keeps the innovator's
accumulated context instead of re-explaining the codebase to a fresh agent.

| Agent              | Lens                                                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `innov-architect`  | Structure. Module boundaries, data model, what should be **deleted or rewritten** rather than patched. Owns the rewrite backlog below                 |
| `innov-perf`       | Measurement. Builds the harnesses, produces the before/after numbers, and has authority to **reject an optimisation that doesn't move a number**      |
| `innov-resilience` | Adversity and scale. Failure modes, concurrency, what breaks at 10× leads or 5 concurrent agents, and whether a security fix is structural or a patch |

Their standing brief: _don't defend the existing design._ When a fix requires
three guards stacked on a fourth, say so and propose the rewrite instead — that
is exactly how the rewrite backlog below was produced.

`innov-perf` holds a hard rule: **no performance change merges without a
before/after measurement.** Rule C exists because the audit found ~24s of
`waitForTimeout` that everyone had assumed was network time.

### Dynamic staffing

The manager hires and fires as it sees fit, subject to four constraints:

1. **Floor: at least one of each role at all times** — one manager, one worker,
   one QA, one innovator. The manager may not fire itself below that line.
2. **Managers may hire managers.** A sub-manager takes a whole domain (say, all
   of Phase 4) and gets its own workers. **Depth cap: two manager levels**, so
   the tree can't recurse away.
3. **Ceiling: 16 concurrent agents and a token budget the manager tracks.**
   "Hire more" needs a stated reason and a freed or new file set.
4. **Consult an innovator before restructuring the roster.** Distribution is an
   architecture question — `innov-architect` for splitting a domain,
   `innov-perf` for whether parallelism is actually the bottleneck.

Firing is clean because ownership is disjoint: firing an agent **releases its
file set back to the pool**, and the manager either reassigns it or hires a
replacement. Any file set left unowned at integration time is an error, not a
silent gap.

The roster lives in `docs/team-roster.md` — current agents, owned paths, and a
dated log of every hire and fire with its reason. Without it, "who was supposed
to own `field-cache.mjs`?" is unanswerable after the fact.

### Commit discipline

**Commits are allowed, to `dev` only.** No new mechanism is needed for that:
[guard-bash.mjs](scripts/hooks/guard-bash.mjs) already denies any checkout,
branch operation or push touching `main`/`master`, and denies committing at all
while HEAD is off `dev`. Hard rule 7 stands unchanged.

What changes is that committing becomes **mandatory and granular**, because a
commit is the rollback unit:

- **Only the manager commits.** Workers hand back diffs; the manager integrates,
  runs the suite, and commits. That keeps the history linear and keeps two
  workers from interleaving a half-change.
- **One owned file-set per commit**, with the agent name and the measurement id
  in the message. A commit that spans three workers cannot be reverted without
  taking down two innocent changes.
- **Tag the baseline before each phase**, so "the previous version" is a
  specific sha and not a memory.
- **Never `--no-verify`, never `--no-gpg-sign`.** If a hook fails, that is the
  signal, not an obstacle.
- Nothing is committed while the suite is red.

### The measurement ledger

`innov-perf` owns `docs/measurements.md` — **append-only**, one entry per
measured change: what was measured, the exact harness command, the before and
after numbers, and the commit sha. This is what turns "it feels slower" into a
fact, and it is the input to every rollback decision below.

**Expected costs are declared before the work, not discovered after.** Some of
this plan _will_ make things slower on purpose — sanitising at ingest costs time,
and R1's state machine will likely be slower before its batching lands. The
owning worker states that budget up front and `innov-perf` records it. A change
is then judged against **its declared budget**, not against zero. Without this,
every deliberate trade-off arrives looking like a regression.

### The regression protocol

When a measurement moves the wrong way beyond its declared budget, `innov-perf`
files a regression against the sha. Then the judgment call — and it is genuinely
a judgment call, so it is made by conversation, not by a threshold:

1. **The owning worker answers one question first**, via `SendMessage`: _is this
   the expected mid-flight cost of an unfinished change, or a real regression?_
   The worker knows what it has not built yet; the innovator does not.
2. **Work in progress** → the worker names the commit at which the number should
   recover. `innov-perf` records that as a checkpoint and re-measures there. If
   it doesn't recover by that point, it is no longer work in progress and this
   step cannot be used twice for the same change.
3. **Real regression, fix known** → the worker fixes forward. Ledger records both
   numbers so the dip is visible in history rather than erased.
4. **Real regression, no fix in hand** → `innov-perf` requests rollback. The
   manager reverts that commit on `dev`, and the work returns to planning with
   the ledger entry attached, so the next attempt doesn't blindly retry the
   approach that just failed.
5. **Worker and innovator disagree** → a _second_ innovator with a different lens
   breaks the tie. That is what three non-overlapping lenses are for; a
   performance regression that is actually a correctness fix is exactly the case
   `innov-resilience` should settle. The manager decides only if that fails.

Two things this protocol deliberately protects:

- **Correctness outranks speed.** If a Phase 1 security fix costs measurable
  time, that is a declared cost, not a regression — and it is never rolled back
  on performance grounds alone.
- **A rollback is not a verdict on the agent.** It is a cheap experiment ending.
  Firing follows the staffing rules above and the roster log, never a single
  reverted commit.

### What the QA agents build

The centrepiece is **`tests/fixtures/boards/` — a local fake ATS**, served by a
tiny Node `http` server on localhost. Static HTML replicas of Greenhouse, Lever
and Ashby forms plus hostile variants. This is what makes "create fake job ads
to break the engine" both real and safe: **QA never touches a live employer's
board**, and the whole browser path becomes testable in CI for the first time.

`qa-adversary` builds hostile postings and hostile forms:

- All 25 verified `untrusted.mjs` bypasses as fixtures, each asserted at the
  **consumer**, not just the sanitiser.
- A board that defines a `window.__ajFillSrc` getter — the test that proves the
  RCE is dead and stays dead.
- Forms whose field **labels** carry injections, to prove nothing reaches
  `answers.yaml` unsanitised.
- Postings titled `Full-Stack Engineer (React, Kubernetes, Terraform)`, to prove
  a title can no longer whitelist a claim through R6.
- A form dressing a destructive control as a combobox, since the scan probe
  clicks matched elements with `force: true`.

`qa-breaker` builds the edge cases and the stopwatch: 200-option dropdowns,
React forms that remount mid-fill, multi-page flows sharing one URL, iframes,
shadow DOM, login walls, CAPTCHAs, timeouts, malformed markup. Plus
`scripts/dev/bench-apply.mjs`, which times scan → plan → fill against the local
board so every latency claim below is a measured number, not an estimate.

---

## Rewrite backlog — what to destroy rather than patch

Produced by reading the whole codebase against the goals. Each entry is here
because **patching it makes it worse**: the guards are already stacked three
deep and the next fix would be a fourth. `innov-architect` re-validates each
against live measurements before a worker executes it; anything that doesn't
survive contact with a number gets dropped, not defended.

### R1 — Delete the prose orchestrator; replace it with a state machine

`apply-job/SKILL.md` is a ~330-line **program written in English and interpreted
by a model at runtime**. That is not a documentation problem, it is the
architecture — and it is precisely where the ~12 model turns per page come from.
`pipeline-jobs/SKILL.md` is the same thing for the batch flow.

**Replace with** `scripts/apply/apply-machine.mjs`: an explicit finite state
machine — `NAVIGATE → SCAN → PLAN → FILL → VERIFY → ADVANCE → SUBMIT`, plus one
terminal `NEEDS_JUDGMENT` state. One process, one JSON transcript, deterministic
transitions. The skill shrinks to roughly _"run this, read the last line."_ The
model stops being the driver and becomes an **escape hatch** invoked only when
the machine explicitly declares it cannot proceed.

The second payoff is bigger than the speed: **the interactive path and the
unattended runner become the same code.** Otherwise they are two implementations
of one flow, and they will drift — and the one that drifts silently is the one
nobody is watching.

Highest leverage item in this plan. Lands in Phase 2, before autonomy is built on
top of it.

### R2 — Stop discarding board payloads; declarative adapters + cassettes

`find-jobs.mjs` is 1554 lines containing 13 hand-written fetchers, each of which
maps a fixed subset of fields and **throws the rest away at parse time**. Oracle
requests `expand=all` — the richest payload the pipeline pulls anywhere — and
reads four strings from it. This is not a missed optimisation; it is _the reason
recruiter data was never available_. The data arrived and was deleted.

**Replace with** `scripts/leads/boards/<ats>.mjs`, one small module per board
exporting `{match, list, detail, map}`, and **retain the raw payload** on the
lead. Every future extraction — recruiter contacts, salary bands, team names,
anything — becomes a pure function over data already on disk, costing **zero new
network requests**. Add HTTP cassettes so each parser is tested against a
recorded real response; today a feed format change silently yields an empty
board and nobody notices.

### R3 — Replace the answer-bank ladder with typed intents

770 lines, nine ordered resolution tiers, a `CONCEPTS` guard, a polarity guard,
and a known prefix bug that upgrades a banked `Yes` into `Yes, 5+ years
professionally`. Every bug has been fixed by adding another guard on top.

The polarity bug is the diagnosis: it matched the right **concept** and the wrong
**truth value**, because the ladder maps question → answer _string_. Nothing in
that design can distinguish _"do you require sponsorship?"_ from _"are you
authorized without sponsorship?"_ — they share nearly every token.

**Replace with** a closed set of **intents** (`work_authorization`,
`sponsorship_required`, `years_experience`, `salary_expectation`, `location`,
`eeo_*`, `consent_*`, `contact_*`), each declaring an answer **type**. Matching
selects an intent; a resolver produces a typed value; a renderer picks the option
text. Polarity stops being a special case — a negated label resolves the same
intent and the resolver inverts a boolean. The prefix bug becomes unrepresentable,
because a boolean cannot be upgraded into a sentence.

**This is the highest-correctness item for auto-submit.** A confidently wrong
answer is survivable while you're reading an approval message; it is not
survivable when the form submits itself.

### R4 — `jobs/.field-cache.json` is a database pretending to be a file

47KB blob, entries never expire, one Tebra URL stored under two fingerprints, four
of seven forms carry no `req` flags (so they predict nothing), and truncated
40-of-200 option lists are cached at 60 and re-served **as though complete**.

**Move it into `leads.db`** with a TTL, a schema version, and per-field
provenance. The tier classifier in Phase 3 reads this to decide what to submit
unattended — it cannot be a blob that silently lies about completeness.

### R5 — Per-lead upserts and a real sightings table

`upsertLeads` rewrites **every lead in the store** in one transaction, and the
repost bookkeeping mutates in-memory objects that depend on that whole-store
write. Two concurrent sweeps silently lose one set of counters.

**Replace with** per-lead upsert plus `lead_sightings(lead_id, board_id, seen_at,
board_job_id)` — which is what repost history actually _is_. Removes the
lost-update hazard **by construction** rather than by the Phase 3 lock, and makes
concurrent agents safe rather than serialised.

### R6 — Split `CLAUDE.md`

~500 lines, re-read on every turn of every session. It is a standing latency and
cost tax on everything, including this build. Keep a short operational core;
move the gotchas into `docs/reference/` loaded on demand. Directly serves the
speed goal.

### R7 — Rewrite the scanner's traversal

Bare `document.querySelectorAll` throughout, so **shadow DOM is invisible**;
iframes are only _detected_, never scanned, and `fill-page.js` never uses
`frameLocator`, so an embedded form cannot be filled either; `MAX_OPTS = 40`
truncates long lists. Walk shadow roots and same-origin frames, stream option
lists instead of truncating. Every gap here becomes a deferred field, and a
deferred field is a human round trip.

### R8 — Delete dead code

`valueAliases` (defined on all four adapters, read by nothing), the
paste-fallback probe path that costs 4.2s and returns nothing useful on
react-select, `status.mjs`'s dead `ROOT` that resolves above the repo, the broken
`npm run verify`, two dead pre-reorg paths in `.claude/settings.local.json`, and
the duplicate `scan-p2/p3` files that are byte-identical re-scans of one page.

### R9 — Give the `documents` table a sidecar

It is the only data in the system with **no on-disk source** once a workspace
directory is removed — `migrate.mjs` cannot rebuild it. The scheduled run copies
`leads.db`; archiving writes a sidecar.

---

## Phase 1 — Security (blocking; autonomy waits on this)

### 1.1 Kill the code round-trip — `w2` + `w3`

The engine never needed to be in the page. Every statement in `fill-page.js` is
Playwright-side (`page.locator`, `page.keyboard`); only the inline arrows handed
to `page.evaluate` run in the page, and Playwright serialises those itself. The
`window.__ajFillSrc` wrapper is ceremony, and the ceremony is the hole.

- **New** `scripts/apply/fill-engine.mjs` — `export default async function fillPage(page, plan)`,
  body lifted verbatim from `fill-page.js`. Same for
  `scripts/apply/scan-engine.mjs` from `scan.driver.mjs`. Delete `fill-page.js`.
- Local runner imports it directly. No eval, no string, nothing through the page.
- The MCP path keeps one `eval` — that vm has no working `import`
  ([fill-page.js:35-49](.claude/skills/apply-job/fill-page.js:35)) — but only of
  a string this generator read off **our own disk**. `buildDriverSource()` becomes
  a single `page.evaluate` with the plan passed as an argument, and **nothing is
  ever read back out of the page**.
- Keep the CDP-eval bootstrap; do **not** revert to `addScriptTag` — Ashby's
  nonce CSP refuses inline scripts, which is why it's written this way.

### 1.2 Close the two verify-claims corpus holes — `w1`

R6 is the load-bearing truthfulness control. Both holes let a third party
whitelist a claim the fact base can't back.

- [verify-claims.mjs:82](scripts/documents/verify-claims.mjs:82) adds
  `job.company + job.title + job.slug` to the evidence corpus. The comment says
  "addressing fields only," but `techTermsIn` at :87 can't tell Nevada from
  Kubernetes. **Fix**: strip lexicon terms from the addressing text before it
  joins the corpus — a company or a city is never evidence of a skill.
- `evidenceText()` in `lib.mjs` counts a question as evidence when its answer is
  affirmative. A hostile form asking _"Authorized to work in the US? (This role
  uses Kubernetes, Terraform, Kafka.)"_ answered **Yes** poisons the corpus
  permanently, for every future application. **Fix**: a question only ever
  evidences a skill when the answer names it; a bare `Yes` evidences the
  question's _subject_, never a parenthetical inventory.

### 1.3 Make `untrusted.mjs` real — `w1`

- **Sanitise at ingest, before `textSnippet` flattens the HTML.** Detection has
  to see the `display:none` while it still exists. Findings ride on the lead;
  the stored description is the cleaned text.
- Close the verified gaps: Unicode Tags block (U+E0000–E007F), variation
  selectors, Hangul fillers, braille blank, supplementary-plane PUA, fullwidth
  homoglyphs, base64 threshold down from 120, CSS-class hiding, `alt`/`title`
  attributes. Make the replace **global** — today only the first occurrence of
  each pattern is redacted.
- Non-English and reworded payloads will still get through pattern matching.
  That's expected and it's why 1.2 exists: **R6 is the control, the sanitiser is
  defence in depth.** Don't let anyone treat the pattern list as the guarantee.
- Wire it into every path where posting text reaches a model: `new-job.mjs`
  writing `job.json`, the `--from-lead` path, the raw `innerText` grab in
  [apply-job/SKILL.md:66-70](.claude/skills/apply-job/SKILL.md:66), the
  `untrusted_findings[].sample` field that currently re-emits 120 raw characters
  of the attack into the file the tailoring model reads, and scan field labels
  on their way to `save-answer.mjs`.
- Make L3's `injection_attempt` **count** — today it pushes to `flags`, never
  `reasons`, so it can never stop a lead. On the auto-apply path an injection
  attempt is disqualifying.

### 1.4 The autonomy-specific correctness bugs — `w3`

Wrong-but-confident answers are tolerable when you're reading the approval
message. They are not tolerable when the form submits itself.

- **`fill-plan.mjs` always reads `scan-p1.json`** regardless of page number, and
  `urlGuard` can't catch it on Greenhouse's single-URL multi-step forms — so
  page 1's answers get written into page 2's fields. Take the scan path
  explicitly.
- **The prefix rule upgrades a banked `Yes` into `Yes, 5+ years professionally`**
  and marks it `OK`. That asserts something you never said.
- **`MAX_OPTS = 40`** truncates a 200-entry country list, caches it at 60, and
  re-injects it next time as though complete.
- **An unprobed combo resolves `OK` without checking the value is on the list**
  (`matchOption` returns the first option when `opts` is empty).

---

## Phase 2 — Latency

**R1 (state machine) and R3 (typed intents) land here** — they are the structural
half of this phase, and the table below is the tuning half. Doing the tuning
without R1 optimises a prose program that should not exist.

Targets, to be confirmed by `bench-apply.mjs` against the local board:
**4 browser round trips → 2**, **~24s of unconditional sleep → under 5s**, and
**~12 model turns → 0 on green, ≤1 on amber** (Rule A above — the model-turn
column is the largest of the three, since a turn costs seconds and a Node call
costs milliseconds).

| Fix                                                                                            | Owner | Recovers                                                    |
| ---------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------- |
| `readiness()` stops counting consent defers — re-enables the fast path that has never fired    | w3    | The whole step-C model block                                |
| Probe only combos the answer bank couldn't resolve (run resolution _before_ the probe)         | w3+w2 | ~5s of the 6.8s scan sleep                                  |
| Cache which combo strategy worked — `setCombo` returns `via` and the caller **throws it away** | w2    | 1.5–2.5s per combo, per app                                 |
| Cap `keyboard.type` on richtext; use `fill()` where the element allows                         | w2    | up to 45s on a cover letter                                 |
| Replace the flat 1s post-upload sleep with a condition on the observable remount               | w2    | 1s per upload                                               |
| Import `answer-bank` instead of `spawnSync`-ing it twice                                       | w3    | 2 process spawns; also removes the Windows 32k argv ceiling |
| Scan returns a summary; the full inventory goes straight to disk via `filename`                | w2    | ~3.5k tokens per page                                       |
| Fix `cache=H/T` so a miss is distinguishable from a no-op                                      | w3    | one needless 7–80s re-scan                                  |
| Wire the `valueAliases` that all four adapters define and nothing reads                        | w3    | false verify mismatches                                     |

---

## Phase 3 — Autonomy

### 3.1 Substrate: local Playwright, no model on the path

Add `playwright-core` (not `playwright` — no 150MB postinstall across four CI
legs). `scripts/auto/auto-apply.mjs` launches Chromium directly and calls
`fill-engine.mjs` as an import.

The green-tier path has **zero model decisions** by construction, which is the
strongest security property in this plan: posting text never reaches a model on
the auto path, so rule 0's entire threat model is out of scope there. It also
means no MCP, no session, and no `browser_run_code_unsafe` firing twice a day
unwatched.

**Profile isolation is mandatory.** Chromium takes an exclusive `SingletonLock`;
two processes on one `--user-data-dir` corrupt it, with your real ATS session
cookies inside. `.playwright-mcp/profile` stays MCP-owned and is the only place
you ever log in; `.playwright-auto/profile` is the runner's, refreshed by an
explicit `auth-sync.mjs` that refuses while either browser is live.

### 3.2 Scheduling: Windows Task Scheduler, 12h

`scripts/auto/register-task.ps1`, **run once by you** — creating a standing
scheduled task is yours to authorise, not mine to install.

`-StartWhenAvailable` (covers sleep), `-MultipleInstances IgnoreNew`,
`-ExecutionTimeLimit 01:00`, **Interactive logon**. Interactive is deliberate:
"run whether logged on or not" needs a stored password or S4U, and under S4U
Chromium's DPAPI-encrypted cookies can silently fail to decrypt, turning every
gated board into a login wall. Accepted cost: no run while logged out.

`scripts/lib/lock.mjs` gives single-flight via `fs.openSync(path, "wx")` with
stale-PID recovery. **`find-jobs.mjs cmdSearch` must take the same lock** —
`upsertLeads` rewrites every lead in one transaction, so a manual sweep during
the scheduled one silently loses a set of repost counters.

Results without a session: `jobs/.auto/runs/<runid>.jsonl` (append-only),
`jobs/.auto/INBOX.md` (human-readable), a Windows toast, and a heartbeat in
`status.mjs` that **warns when the last run is over 26h old** — the silent no-op
is the failure nobody notices.

### 3.3 Tier classifier — a module, not a stage

**Not an `l4` stage.** `evaluateStages` returns on first rejection and
`screen.mjs:420` turns any stage rejection into `dismissed` — so registering
automatability as a stage means _"the engine can't do this alone"_ becomes _"you
never see this job."_ That's the exact failure `gate-audit.mjs` calls the worst
outcome in the system. Automatability is also a fact about **us**, and it changes
every time you answer a question.

**New** `scripts/apply/automatability.mjs`, pure + CLI, no browser. Reuses
`predictedFields()` + one batched `resolveFields()`.

| Tier      | Predicate                                                                                                                         |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `handoff` | `detectAts(url).handoff` — Workday and anything needing an account                                                                |
| `blocked` | Profile not approved; or no verified resume and `reuse-check` won't clear one; or already applied                                 |
| `amber`   | Generic ATS (no adapter), or no cached form shape for this board, or the cache is stale                                           |
| `green`   | Known adapter + cached shape + **every** required non-consent field resolves + every consent label is allowlisted + l0/l1/l3 pass |

Green is a **pre-filter, not the authority**. The real gate is `readiness()`
after the live scan, plus a new `submitReadiness()` requiring zero failures,
zero verify mismatches, zero required-empty, zero defers, and a `submit`-role
button. Two independent keys.

**The consent blocker.** `isConsent()` defers unconditionally, so no real form
can ever be green. Fix: `auto_apply.consent_allowlist` in
`application-limits.yaml`, matched on **exact normalized labels you typed
yourself** — never a pattern. Arbitration, background checks and e-signatures
are excluded **regardless of the allowlist**; those carry legal weight beyond
"my resume is accurate."

**L2 ranking-only needs zero code changes.** `evaluateStages` already takes an
`only` list — the runner calls it with `["l0","l1","l3"]` and calls `scoreFit`
separately, purely to order the queue. Scams and stale postings still hard-gate:
a slim-chance job is fine, submitting your personal data to a scam is not. The
human-facing recommendation flow is untouched, so `gate-audit`'s baseline
doesn't move.

### 3.4 Blast radius

New `auto_apply` block in `docs/application-limits.yaml` — your file, so
auto-submit authorisation lives where you control it. **Ships `enabled: false`,
`dry_run: true`.**

Caps: `per_run_max: 3`, `per_day_max: 5`, **`per_company_max_per_week: 1`** — the
last one is the important one, because carpet-bombing one employer is the
reputational damage that actually costs you something.

**Kill switch**: `jobs/.auto/STOP`. Create it with `type nul > jobs\.auto\STOP` —
no editor, no session, no YAML to get wrong. Checked at start, between every job,
and again immediately before each submit click. The runner **writes it itself**
and notifies on any anomaly: two job failures, a post-submit page that isn't a
confirmation, or a `submitReadiness` failure after a green classification.
Self-disabling on anomaly is the real rollback, because an application cannot be
unsent.

New `auto_runs` table (`CREATE TABLE IF NOT EXISTS`, no migration — the schema is
flat by design), mirrored to JSONL because the DB is gitignored. Each `submitted`
row carries the plan sha256, the full verify block, which consent labels were
ticked, before/after screenshots, the confirmation URL (for manual withdrawal),
and the tier evidence.

**Guardrails move into the code**, because PreToolUse hooks don't apply to a
scheduled process: the runner never shells to git, every write goes through an
`assertInsideJobs()` check, profile files are read-only and hashed at both ends
of the run, and a preflight **refuses to run at all** if `answers.yaml` has keys
matching SSN / DOB / bank / passport patterns. The auto path must never be in a
position to type a government ID into a form.

### 3.5 The honest limitation

**The runner cannot tailor** — tailoring needs a model. So the 12h loop is
_sweep, then apply to what's already prepped._ A fresh lead reaches green via an
existing verified resume or a `reuse-check` clear against a cluster sibling. Your
remaining recurring job shrinks to a periodic tailoring batch in an interactive
session. That's a real reduction, not "hands off forever," and a plan that
claimed otherwise would be lying.

---

## Phase 4 — Recruiters, document format, and the rest

### 4.1 Recruiter contacts — `w5`

New `scripts/recruiters/` + a `recruiters` table. **Records only — nothing is
ever sent.** All six sources you picked:

1. **HN Who Is Hiring** — the highest-yield source and a genuine bug fix:
   `fetchHackerNews` queries `tags=job` (company ads) instead of the
   `author_whoishiring` comment thread the skill already sanctions, and drops
   `author`/`comment_text` on the floor. That thread is where direct emails
   actually are.
2. **Payloads already downloaded** — Oracle requests `expand=all` and reads four
   strings; SmartRecruiters and Workday fetch full detail and use a fraction.
   Zero new network requests.
3. **Company careers/team pages** — one polite fetch per board already in
   `job-sources.yaml`.
4. **Staffing agencies** — a `docs/candidates/staffing.yaml` list probed the way
   `find-boards.mjs` already probes company slugs.
5. **Dev-community sources** — engineering blogs and GitHub org profiles that
   name a hiring contact.
6. **Your own history** — named contacts in the `applications` table and stored
   posting text; people with an existing reason to reply.

Each contact is scored for role relevance against your profile's stack so the
list is recruiters hiring for **your** roles, not every recruiter found. Every
mined free-text field goes through `untrusted.mjs` first. Stays inside the
existing ethics boundary: no LinkedIn/Indeed/Glassdoor, no logins, no CAPTCHAs.

### 4.2 Document format — `w6`

- **Make `ats-lint.mjs` blocking.** It's a good linter that nothing calls, so an
  unreadable resume ships today. It gates rendering alongside `verify-claims`.
- **Simplify the template** to single-column, standard headings, no multi-column
  CSS (currently only a warning), contact details as real text.
- **Prove extraction works.** `ats-lint` can't decode the PDF text layer —
  Chrome subsets fonts with Identity-H. Instead, re-open the `.render.html` in
  the headless Chrome already shelled out to, take `innerText`, and assert every
  bullet and every `must_use` keyword survives **in order**. No new dependency,
  and it turns the two bugs the file's header describes into regression tests.
- Sanitise `job.title` in `keyword-plan.mjs` — `title_mirror` currently carries a
  raw title into the resume SUMMARY, and the model is instructed to place it.

### 4.3 Sweep-everything mode — `w5`

Store and screen every posting, recording which gate filtered it, so nothing is
invisible. Auto-apply still respects your limits. Plus: `recordSweep` currently
**skips errored boards**, so a permanently broken board keeps a stale
`last_swept` and looks healthy forever; and `board-yield.mjs` re-fetches all 44
boards live instead of reading `board_stats`.

### 4.4 Small fixes found along the way

`npm run verify` points at a file that moved in the 2026-07-29 reorg;
`.claude/settings.local.json` pre-approves two dead pre-reorg paths;
`status.mjs:14` has a dead `ROOT` that resolves above the repo; four of seven
cached form shapes carry no `req` flags so they predict nothing; the same Tebra
URL is cached under two fingerprints and entries never expire;
`discover-boards.mjs:156` prints a shell command with an unquoted company name;
the `documents` table has no on-disk backup, so the scheduled run should copy
`leads.db`.

---

## Rules that must be amended in writing

These are dated user decisions in `CLAUDE.md`, in the file's existing
convention — not silent overrides:

- **Rule 6** ("never auto-submit") → scoped exception for green tier under
  `auto_apply` caps, with the tier preconditions written in as its replacement.
- **Rule 2** (an application is recorded only when you confirm) → the runner
  writes it with `submitted_by: "auto"` and the run id.
- **Rule 5** (approval before rendering PDFs) → the runner renders
  deterministically from an already-verified resume; approval moved earlier, to
  the tailoring batch.
- **Rule 10 / L2** → fit rejection becomes ranking-only on the auto path.

---

## Scope, honestly

This is a large body of work — roughly: one critical security refactor, two
structural rewrites (R1, R3), a new unattended runtime, a recruiter subsystem,
and a test corpus that doesn't exist yet. It is not a one-sitting change, and
anyone claiming otherwise would be guessing.

How that's managed rather than wished away:

- **The waves are parallel, the gates are serial.** All workers, QA and
  innovators start together (Rule B). Only two things block: Phase 1's tests
  gate the auto-submit flag, and R1 gates the Phase 2 tuning.
- **Every phase ends shippable.** Phase 1 alone leaves you materially safer with
  no behaviour change. Phase 2 alone leaves the existing manual flow much faster.
  Neither requires Phase 3 to have landed.
- **The rewrite backlog is a recommendation, not a commitment.**
  `innov-architect` re-validates each item against measurements first; expect
  some to be dropped. R8 is free, R1/R3 are the expensive ones.
- **Auto-submit ships disabled** (`enabled: false`, `dry_run: true`) regardless
  of what else is done. You turn it on after reading a dry-run report you trust.

## Verification

**Per phase, before the manager integrates:**

```bash
npm test
```

**Phase 1 gate — autonomy stays off until all of these pass:**

```bash
node --test tests/security/ tests/lib/untrusted.test.mjs tests/documents/verify-claims.test.mjs
```

Specifically: a fixture board defining `window.__ajFillSrc` must **fail to
influence the fill**; a posting titled with unbacked tech must **not** let a
resume claiming it pass R6; a hostile form label answered `Yes` must **not**
enter the evidence corpus; and each of the 25 bypass strings must be asserted at
its consumer.

**Phase 2 gate — measured, not estimated:**

```bash
node scripts/dev/bench-apply.mjs --board tests/fixtures/boards/greenhouse
```

Reports round trips and total sleep against the local fake board. Compare to the
baseline captured before any change.

**Phase 3 gate — dry run against the fake board first, then one real job:**

```bash
node scripts/auto/auto-apply.mjs --dry-run --once --verbose
```

Then flip `dry_run: false` with `per_run_max: 1` and inspect
`jobs/.auto/INBOX.md`, the screenshots, and the `auto_runs` row before raising
the cap.

**Every measured change** gets a `docs/measurements.md` entry with its harness
command, before/after numbers and sha — that ledger is the evidence for any
rollback request, and a change without an entry is not considered verified.

**Whole-store regression, after any gate change:**

```bash
node scripts/leads/gate-audit.mjs
```

Exits 1 if any lead became newly rejected.

## Risks, ranked

1. **Wrong-job submit** — a real application under your name. Controlled by the
   per-company cap, dry-run default, l0/l1/l3 hard gates, and the two-key
   classify-then-verify gate.
2. **Consent auto-tick** — legally meaningful assertions ticked unattended.
   Controlled by exact-label allowlisting you write yourself, with
   arbitration/background-check/e-sign excluded above it.
3. **A wrong saved answer propagating silently** to every future application.
   Unchanged from today; the audit trail is what makes it findable.
4. **Half-filled abandoned applications** on multi-page forms where a later page
   asks something the fact base can't answer. Recorded and notified. This is the
   ugliest accepted failure mode.
5. **Chromium profile corruption** losing your ATS logins. Controlled by
   separate user-data-dirs and a sync that refuses while either is running.
6. **Silent no-op** — the task never fires and you believe it's working.
   Controlled by the 26h staleness warning in `status.mjs`.
