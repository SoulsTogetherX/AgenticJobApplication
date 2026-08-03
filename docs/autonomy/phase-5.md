### Phase 5 — The runner

**Capability:** the machine sends applications unattended, at the volume the lead supply allows,
and survives every way it can be interrupted.

> **STATUS 2026-08-03: W1 LANDED. W2 IS BUILT AND GATED ON ITS CORPUS. W3 and W4 are
> outstanding, though W4's breaker landed early because W2's own check names it.**
>
> #### What W2 added, and the one thing it cannot finish
>
> - **`raiseStop` has its scope** (`company | board | run | global`, §4.9). Only the four §4.6
>   invariant breaches take `global`. The orphan halt, the ledger collision and the incomplete
>   record now brake ONE COMPANY; the profile-drift alarm brakes ONE RUN, which is a correction —
>   §4.6 classes `fact-base-changed` as a deferral, and a global brake there halted every future
>   night because the user answered a `save-answer.mjs` prompt. **The protection is not weaker:
>   the damage the orphan brake exists to prevent is a second application to the same employer,
>   and a company brake blocks exactly that, durably, with no code path that clears it.**
> - **`classify.mjs`** — pure `(url, html) -> typed outcome`, `unclassified` by default.
> - **`reconcile.mjs`** and the `reconciled-not-sent` terminal outcome, which is the only outcome
>   that releases the `(slug, mode)` claim and one of only two that spend no cap budget.
> - **`breaker.mjs`** — §4.6's three N-invariant rules, with transient retry and probe
>   re-admission. W2's check (reCAPTCHA resubmit -> board pause, **not** a run STOP) passes.
> - **The fixture's post-submit leg**: seven pages and a real submit endpoint, GET form / POST
>   result on one URL.
>
> **W2 IS NOT CLOSED, AND THE MISSING PIECE IS NOT CODE.** §4.10 requires the classifier's corpus
> to be REAL pages from attended applies. There are none, so every shipped rule is
> fixture-sourced and `ruleApplies()` refuses to fire a fixture rule off loopback — **so every
> real board classifies as `unclassified` today, which hard-STOPs after the click.** That is the
> safe direction and the honest one. `npm test` reports it as a named skip rather than a pass.
> `scripts/apply/capture-post-submit.mjs` is the unblocking path (stage -> review -> promote,
> redaction checked rather than assumed); it needs the user to run attended applies.
>
> `scripts/auto/` now holds `trust.mjs`, `submit.mjs`, `job.mjs`, `pool.mjs` and `auto-apply.mjs`.
> **The invariant this project has stated for months — "nothing in this repository contains a
> click" — is no longer true, deliberately, and the replacement invariant is mechanical:**
> `.click(` appears under `scripts/auto/` only in `submit.mjs`, exactly once, asserted by
> `tests/auto/click-surface.test.mjs` and canaried (a file with a click added to `scripts/auto/`
> turns it red). Gate 1967 full / 262 security, two consecutive runs on a quiescent tree.
>
> **Still true, and it is the operative fact:** `auto_apply.enabled` is `false` in the user's file,
> and there is no `board_allowlist` in it, so **the trust gate refuses every board and nothing can
> be submitted.** The click is reachable only in `mode === 'live'`, which requires the user to set
> both keys themselves. The user is still on the submit button for every application.
>
> #### What the plan got wrong, recorded where it said it
>
> - **W1's own falsifiable check contradicts a measured fact from Phase 4.** It asks for
>   `--board greenhouse` to leave `auto_queue` holding one row in `submitted`. Phase 4 measured
>   that this fixture carries a consent tickbox, so `--board greenhouse` gives `defer_rate = 1.0`
>   **by construction** and can never produce a `submitted` row. The check as written is
>   unsatisfiable. It is discharged instead by `tests/auto/runner-resume.test.mjs` and
>   `tests/auto/job.test.mjs`, which drive the same path with the fixture's consent field absent.
>   Wiring `bench-runner.mjs` to drive the runner instead of its own pool — which its header
>   already names as the correct move once the runner lands — is **not done**, and is W3's, where
>   concurrency is the thing being measured.
> - **`queue.mjs` was not created, and should not be.** §4.1's module table assigns it "enqueue,
>   claim, transition, resume-select, derive counters". Every one of those already exists in
>   `scripts/lib/db.mjs`, put there by Phase 1 next to the schema and its healing logic. A second
>   module over the same table would be a second opinion about what a claim means, and that is the
>   drift that produced `check-applied.mjs`.
> - **"SIGKILL at each of the 8 states" — there are nine.** `AUTO_QUEUE_STATES` is queued,
>   claimed, planned, authorized, attempted, submitted, challenged, deferred, failed. All nine are
>   covered; the ninth is not dropped to match the sentence.
> - **`raiseStop` still has no `scope`.** §4.9 requires `company | board | run | global`, so any
>   hard STOP still halts every future invocation until a human deletes a file. Unbuilt, and it
>   blocks W2 rather than W1: the classifier is what produces the `unclassified` STOP.
> - **`audit.mjs`'s `pendingAttempt` is a single slot per run, and that is a W3 blocker.**
>   `beginSubmit` raises STOP when a _different_ slug's attempt is open — correct for a
>   single-threaded run and fatal at concurrency 8, where two workers legitimately hold attempts at
>   once. Named now rather than discovered during W3: the fix is a map keyed by slug, keeping the
>   per-slug overwrite detector.
> - **Per-document user approval has no durable record anywhere in the tree.** Precondition 11
>   therefore enforces "verified against a user-approved fact base" — a passing `verifications` row
>   for exactly these bytes plus `profile.meta.approved_by_user` — and **not** "the user approved
>   this document", because hard rule 5's approval happens in a chat message and leaves no row.
>   Stated in `submit.mjs`'s own header rather than papered over with a field that always reads true.
> - **The stale-claim lease is the only thing governing resume latency**, which a test found rather
>   than a reading. `readResumableAutoJobs` returns every non-terminal row while `claimAutoJob` only
>   takes a row still in `queued`, so a job crashed at `planned` is offered and then refused until
>   `releaseStaleAutoClaims` has moved it back — 30 minutes at the default. It is now a parameter
>   (`staleClaimMs`); shortening it is safe (the `(slug, mode)` insert refuses the loser) and merely
>   costs duplicated planning.
> - **`recordRehearsal()` was added to `audit.mjs`.** A dry run passes every precondition including
>   the durable write, and then needs to resolve that row. `recordSubmission` raises STOP without a
>   `confirmation_url`, which a rehearsal will never have; `abandonAttempt` writes an outcome that
>   does **not** count toward caps, contradicting the schema's deliberate "dry-run rows count on
>   purpose". Neither verb was right, so there is a third.
> - **The `auto-apply.mjs` CLI does not launch Chromium.** The stages are injected and the only
>   caller supplying real ones is a harness against the loopback fixture. Wiring a browser in before
>   W2 has a post-click classifier would give the command a live path nobody has exercised.
>
> #### What W2 is gated on, and it is not code
>
> §4.10 requires the classifier's corpus to be **real** confirmation, identity-verification,
> bot-challenge, email-code, error and not-a-confirmation pages, and names their only lawful
> source: attended applies capturing the post-submit page. **No such capture exists today and
> none can be manufactured** — a synthetic corpus would train the classifier on this repository's
> idea of what Greenhouse says after a submit, which is exactly the guess §4.6 says must not be
> made. `submit.mjs` therefore takes `classify` as an injected dependency and **refuses a live
> submit without one** (`ClassifierRequired`), so the gap is a refusal rather than a stub.

Full specification in §4. **Four** widenings, each gated on the previous, each with its own check.

| Widening | Shape                                                                                                                                                                                                 | Owner         | Falsifiable check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **W1**   | One job, `dry_run: true`, concurrency 1, one board (greenhouse), loopback fixture, **fixture DB path** (C8).                                                                                          | `implementer` | `bench-runner --apps 1 --concurrency 1 --board greenhouse --db <fixture>` completes; `auto_queue` holds one row in `submitted` with `mode='dry_run'`; `auto_submissions` holds one row keyed `(slug,'dry_run')`; `model_turns === 0`; `spawns_per_app === 0`. `SIGKILL` at each of the 8 states, one test per state, leaves a resumable DB and never a duplicate. The runner **refuses** to start when the fixture flag and `jobs/leads.db` are both given.                                                  |
| **W2**   | **NEW (C10). Live-against-fixture.** A real click, real navigation, real classification, real `attempted → submitted` transition — against the loopback fixture's submit endpoint, never an employer. | `implementer` | The classifier is a **pure function over `(url, html)`** with a committed corpus of real confirmation, identity-verification, bot-challenge, email-code, error and not-a-confirmation pages, and a test asserts the correct typed outcome for each. A run kills the process **between click-return and the acknowledgement write**, and `reconcile.mjs` resolves the orphan without a human. A fixture page returning the reCAPTCHA resubmit shape yields `bot-challenge` → board pause, **not** a run STOP. |
| **W3**   | N pages/contexts, one board, `dry_run`, 50 jobs across ≥8 fixture employers. Multi-page precondition (C7) enforced via §4.2c.                                                                         | `implementer` | 50 jobs at concurrency 8 with **observed max-in-flight === 8**; `durable_attempted_rows === apps_that_reached_authorized`; zero orphans; a test asserting **two concurrent tabs on the same origin cannot see each other's storage** (the C9 regression test); and a test asserting a form whose page-3 fields are unresolvable **abandons the draft explicitly** rather than leaving a partial record.                                                                                                      |
| **W4**   | N boards, at most one in-flight job per **origin**. Still `dry_run` until the user enables.                                                                                                           | `implementer` | A run across 3 fixture boards where board 2 fails every job: board 2 pauses **with `board-paused` written to every stranded job**, boards 1 and 3 complete every queued job, the run does **not** STOP, and a probe re-admission after the backoff clears the pause on one success. This is the check that the breaker is not a throttle.                                                                                                                                                                    |

**Nothing here turns auto-apply on.** `auto_apply.enabled` stays `false` and `dry_run` stays `true`
in `docs/application-limits.yaml`, which is the user's file. The runner ships fully built and fully
off, and the user enables it after reading a dry-run report they trust.

**And the report must say what it cannot know.** Added on review: `dry_run` structurally cannot
observe challenge incidence, silent dismissal, per-IP reputation effects or confirmation-email
delivery. §8 states this, and the live run report carries challenge-incidence-per-board,
post-submit classification distribution and (if §6.7 is adopted) confirmation-email-received as
**first-class columns from night one** — so the enable decision is informed rather than implied.
This is instrumentation, not a smaller launch.

---
