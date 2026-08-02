# Autonomy plan v2 — unlimited volume

**Supersedes phases 3 and 4 of [`docs/autonomy-plan.md`](autonomy-plan.md).** Everything in
that document before `## Phase 3 — Autonomy` (context, decisions taken, the design principle,
the team, the rewrite backlog, phases 1 and 2) still stands. Where this document contradicts
it, this document wins, and the contradiction is recorded in §1.4 rather than edited away.

**Author:** `innov-architect`, 2026-08-01, at `fa192a1` plus a dirty working tree (§0.2).
**Revision 2, 2026-08-01**, after adversarial review by `attack:correctness`,
`attack:feasibility` and `attack:outside-reality`. Every correction the review forced is
recorded in place, in §0.0 and in the marked notes it points at.

---

## 0.0 What review changed

The attack stage did real work. It found **six fatal defects**, all six accepted, three of which
would each on their own have produced a runner that either never submits, submits the wrong
document, or stops the user's campaign on its first healthy night.

| #   | Found by        | Defect                                                                                                                                                                                                                                                                                                                                                                                                                                       | Where the fix lands                                          |
| --- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| F1  | correctness     | Slug-keyed `auto_submissions` + dry-run rows written to the same table means every rehearsed slug pre-consumes its own claim, so `submitOnce`'s precondition 7 refuses **forever** after the rehearsal. The plan as drafted produced a runner that could never submit anything live.                                                                                                                                                         | §1.4 **C8**, Phase 1.2, §4.10 item 7                         |
| F2  | correctness     | "One persistent context is forced" is false (`browser.mjs:169-170` has a non-persistent branch), and the mitigation for its stated cost was keyed on `board_key`, which is **tenant**-scoped, while cookies and storage are **origin**-scoped. Eight concurrent Greenhouse tenants share one cookie jar; a résumé upload token from one tab can be spent by another.                                                                         | §1.4 **C9**, §4.2 rewritten                                  |
| F3  | correctness     | Every validation widening was `dry_run`, and `dry_run` never clicks. The click, the confirmation classifier, the `attempted → submitted` transition and two of the four hard STOPs would all execute for the first time against a real employer.                                                                                                                                                                                             | §1.4 **C10**, Phase 5 **W2** (new)                           |
| F4  | feasibility     | The harness that would judge the plan's perf-sensitive changes was built in Phase 4, **after** five changes had landed on the fill path — so the first fill baseline would silently absorb every un-budgeted change before it. This is the 24s-of-`waitForTimeout` failure with the calendar rearranged.                                                                                                                                     | §1.4 **C11**, Phase 0.9/0.10, budgets in every affected item |
| F5  | feasibility     | The supply arithmetic does not close, by an order of magnitude, using the plan's own screening rate — and the measurement that would have said so on day one was scheduled last and made non-gating.                                                                                                                                                                                                                                         | §1.4 **C12**, Phase 0.11, §2, Phase 6.1 numeric criterion    |
| F6  | outside-reality | Hard STOP #1 ("post-submit page is not a confirmation") is **wrong about the launch board**. Greenhouse documents Invisible reCAPTCHA on careers-page integrations 1-4, analysing mouse and typing patterns, which may dismiss a submission or demand an email code. A Playwright fill emits near-zero input events, so a non-confirmation page is an **expected environmental outcome whose probability rises with N** — C2 one layer down. | §1.4 **C13**, §4.6, §4.10 classifier                         |

Material defects accepted and fixed: the heartbeat single-flight non-sequitur (§4.3, now
deleted rather than replaced); the breaker's missing retry/backoff/re-admission (§4.6); stranded
`board-paused` jobs invisible to the taxonomy (§4.6, Phase 4.1); reconcile-to-`failed` dead-ending
against the slug claim (§4.9); the multi-page "resolve before the first keystroke" requirement
being unsatisfiable without a navigate verb (§4.2c, a new module and a real cost); a mid-run
fact-base edit mass-deferring every remaining job (§4.6, new kind); Phase 3's network-egress
check being green by construction (Phase 3 check rewritten); the CI gate's
`durable_attempted_rows != apps_started` contradicting its own state machine (§Phase 4 gate);
`model_turns` and `round_trips` being **derived** from a static PROTOCOL list rather than
observed, which makes the one no-override gate the one that can never fire (Phase 4.7); the
fixture forcing concurrency 1 in the two commands used as proof of concurrency 8 (Phase 4.6);
the N=8 knee being transplanted from a workload 76× shorter and then proposed to the user as
measured (§6.1, number withdrawn); per-edge spacing stated as "seconds" with no number and no
crossover (§4.2b); §5.3's factually false basis for rejecting human-pacing (decision kept,
grounds corrected); §6.4's "majority of current leads" (measured: 39%, §6.4); the SmartRecruiters
precision fix (§6.5); and the provenance failure in the plan's own credibility table (§0.2,
which cited one function that does not exist yet and another already deleted, under one sha).

Added from "missing entirely": arrival shaping across the day bounded by the recency SLA
(§4.2b); the confirmation email as an evidence channel (§6.7, a consent decision); green-tier
prevalence measured from stored scans before anything is built (Phase 0.12); storage growth and
workspace retention at volume (Phase 1.8, Phase 4.2); a taken-down posting as its own outcome
(§4.6); STOP's blast radius across the new resumable shape (§4.9); per-job failure rate `p` as a
tracked column (Phase 4.7); ledger-writing as an actual work item (Phase 4.8).

**Rejected, with reasons, in one line each** — full reasoning at each site: descoping multi-page
boards instead of building a navigate verb (§4.2c); deleting the orphan row in reconciliation
rather than giving it a terminal outcome (§4.9); re-deriving the runner's requirements downward
from a ~100/day supply ceiling (§1.4 C12); and one arithmetic correction to a critic
(median halt is job 292, not 380 — the critic is right, the draft was wrong, §1.4 C2).

**Nothing in the review touched the thesis (§2), the refusal to model-resolve `UNKNOWN` fields,
the `submitOnce` precondition list, Phase 0.1's origin binding, Phase 1.3's `profile_sha256`
clause, or the deletion list.** All were specifically endorsed by at least one critic against
artifacts. They are not churned here.

---

## 0. How to read this document

### 0.1 The tense convention, and why it is a rule

The v1 plan wrote specifications in the indicative. Three times, a control that did not exist
was believed in because a plan sentence described it as though it did — `INBOX.md`, the 26h
staleness heartbeat, and the "guards are structurally unskippable" claim in
`scripts/auto/guard.mjs:20-22`. All three read as descriptions of the system. All three were
descriptions of an intention.

So, in this document:

- **EXISTS** — the thing is in the tree, followed by the command that settles it and **the tree
  state that command was run against**. If the command comes back empty, the claim is false and
  this document is wrong.
- **SHALL** — the thing does not exist. Every unbuilt component is written as "shall", with no
  exceptions, including ones that feel inevitable.

A sentence in this plan is never evidence that code exists. The command next to it is.

### 0.2 Status of this document, and its gaps — stated first

**CORRECTION (review, F-material, `attack:feasibility` and `attack:correctness` concurring).**
Revision 1's table was stamped "at `fa192a1`" and was run against a **dirty, partly untracked
tree**. Two of its citations describe code in a tree state that exists nowhere: §4.9 cited
`assertNoOrphanAttempts` at `audit.mjs:189-217`, which does **not** exist at `fa192a1`; §4.10
argued at length about `preSubmitCheck`, which exists at `fa192a1` and has **already been
deleted** by the in-flight wave. A document that makes provenance a rule in §0.1 and then breaks
it in the table that establishes its credibility is worse than one that never claimed it. The
table is re-run and re-marked below. I verified each row this pass; the command and the tree
state are both stated.

| Claim                                                                  | Command                                                                                    | Tree                       | Result                                                                                                                                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `auto_submissions` is keyed `(run_id, slug)`                           | `sed -n '232,246p' scripts/lib/db.mjs`                                                     | worktree **and** `fa192a1` | `PRIMARY KEY (run_id, slug)` — confirmed in both                                                                                                                                           |
| Dry-run rows go in the same table and **count toward caps on purpose** | `sed -n '210,231p' scripts/lib/db.mjs`; `sed -n '866,902p' scripts/lib/db.mjs`             | worktree (`M`)             | "A dry-run row is recorded too, with mode `dry_run`"; "The cap counts dry-run rows on purpose" — this is F1                                                                                |
| `AUTO_RUN_LOCK` has zero callers                                       | `grep -rn "AUTO_RUN_LOCK" --include=*.mjs scripts/ tests/`                                 | worktree                   | one line: `scripts/lib/lock.mjs:176`, its own definition                                                                                                                                   |
| `INBOX_PATH` has zero writers and zero readers                         | `grep -rn "INBOX" --include=*.mjs scripts/ tests/`                                         | worktree                   | one line: `scripts/auto/guard.mjs:65`, its own definition                                                                                                                                  |
| `status.mjs` surfaces nothing about the auto path                      | `grep -c "auto_runs\|INBOX" scripts/status.mjs`                                            | worktree                   | `0`                                                                                                                                                                                        |
| `hasVerifiedResume` is file-existence, not verification                | `sed -n '450,478p' scripts/apply/automatability.mjs`                                       | worktree                   | `fs.existsSync(resume)`; comment admits "verify-claims writes nothing durable"                                                                                                             |
| A non-persistent browser branch exists                                 | `grep -n "newContext\|launchPersistentContext\|chromium.launch" scripts/apply/browser.mjs` | worktree                   | `:167` persistent, **`:169-170` `chromium.launch` + `browser.newContext()`** — this is F2                                                                                                  |
| `boardKey` is tenant-scoped, not origin-scoped                         | `sed -n '120,140p' scripts/apply/automatability.mjs`                                       | worktree                   | hostname + first path segment + `for=` employer param — F2                                                                                                                                 |
| `fill-engine` cannot express a button click                            | `sed -n '98,106p' scripts/apply/fill-engine.mjs`                                           | worktree                   | "there is deliberately no verb that clicks a button… a thing it cannot express"                                                                                                            |
| The fixture has exactly one greenhouse route                           | `sed -n '104,118p' tests/fixtures/boards/server.mjs`                                       | worktree                   | one path, `/boards.greenhouse.io/fixture-widgets/jobs/1000001` — one `board_key` for every fixture job                                                                                     |
| Lead host distribution                                                 | `node -e` over `jobs/leads.db` (read-only, `node:sqlite`), parsing `leads.doc`             | worktree DB, 2026-08-01    | 141 leads, 116 dismissed (82.3%); adzuna 47, greenhouse 34, ashby 17, coinbase 10, oraclecloud 7, igt 7, smartrecruiters 5, jobicy 5, samsara 4, lever 4, myworkdayjobs 1, **recruitee 0** |
| The user's caps                                                        | `grep -n "auto_apply" -A 6 docs/application-limits.yaml`                                   | worktree                   | `enabled:false dry_run:true per_run_max:999 per_day_max:999 per_company_max_per_week:5`                                                                                                    |

**Rows that are WORKING TREE ONLY — line numbers will move when the in-flight wave commits.**
`git status --porcelain scripts/auto scripts/lib/db.mjs` returns `M audit.mjs`, `M guard.mjs`,
`M db.mjs`, `?? authorize.mjs`. Therefore:

- **`scripts/auto/authorize.mjs` is untracked.** Every citation of it in this document
  (`:305-315`, `:427`, `:443-480`) is against an uncommitted, actively-edited file.
- **`assertNoOrphanAttempts` is worktree-only** (`grep -n` → `:136`, `:189`;
  `git show fa192a1:scripts/auto/audit.mjs | grep -n` → absent).
- **`preSubmitCheck` exists at `fa192a1:240` and is gone from the worktree.** §4.10's
  rationale is restated against the shape that will actually exist, not against the one being
  deleted.

`doc-scribe` **shall** re-run this table with `file_sha1` beside the commit sha — the mechanism
`bench-apply.mjs`'s `provenance()` and `MEASURED_FILES` already use, which exists in this repo
precisely because M2 and M6 were both caused by an uncommitted edit landing mid-measurement —
once the in-flight wave commits, and **before** Phase 1 opens.

**What I did not verify.** Every number in §2 and §7 that came from the survey — the browser and
SQLite timings, the market and ATS-behaviour findings, the concurrency knee at N=8 — is another
agent's measurement, and I re-ran none of it. I ran no tests and opened no board. I could **not**
reproduce `attack:feasibility`'s ~28 leads/day figure: `leads.doc` carries no `first_seen` or
`discovered_at` key and my query bucketed all 141 rows under an empty date. Their lead **count**
and **dismissal rate** I reproduced exactly; their **daily rate** I take on their word and it is
the reason Phase 0.11 exists. The 999 × 45s ÷ 8 composite in revision 1 is **withdrawn**, not
revised — F2 invalidated its isolation model and F4 showed the fill leg is unmeasured, so there
is currently no defensible wall-clock estimate in this document at all.

### 0.3 An unowned file set — flagged, not resolved

`docs/team-roster.md` assigns every path I checked **except two**: `scripts/status.mjs` and
`scripts/maintenance/*` appear nowhere in the roster (`grep -n "status\.mjs\|maintenance"
docs/team-roster.md` returns no ownership row). This plan requires edits to both — the progress
digest in Phase 4, the `migrate.mjs` rebuild path in Phase 1, and now **workspace retention at
volume** (Phase 1.8), which is a `prune-jobs`/`archive` concern and is the directory that grows
fastest under this plan. **`build-manager` must assign them before Phase 1 opens.** My
recommendation is unchanged and now has a third reason: both to `w4-autonomy`, on the reasoning
the roster used for `scripts/applications/*` — they are readers of `scripts/lib/db.mjs`, which
`w4-autonomy` already owns, and splitting a reader from its schema is what let
`check-applied.mjs` drift.

---

## 1. What changed, and what it invalidates

### 1.1 The decision

The user, 2026-08-01: the auto-applier is to apply to an **unlimited** number of jobs. The
configured caps are `per_run_max: 999`, `per_day_max: 999`, `per_company_max_per_week: 5`.
Their words: _"If it's being limited, then that's a bug to be corrected."_

**Unlimited volume is a requirement, not a risk to be managed.** Volume throttles,
acknowledgement gates, human-in-the-loop batching and "start small and ramp" are rejected in
advance and this plan proposes none of them. A proposal that reintroduces one under another name
is to be struck. Two things in this revision sit near that line and are named explicitly so a
reader can check them rather than trust them: per-edge spacing (§4.2b) and arrival shaping across
the day (§4.2b). Both have a stated crossover point, a stated test that distinguishes them from a
cap, and a bypass that fires before either can cost an application.

### 1.2 What is retained, and why it is not a throttle

**The anomaly circuit breaker stops the run on proof of malfunction.** Stopping because the
machine is provably broken is categorically different from stopping because it did too much work.
The distinction is kept crisp throughout, and §4.6 re-specifies the breaker so that it is
**invariant in N** — a healthy run of 999 must be no likelier to halt than a healthy run of 3.
The v1 breaker was not (C2). Revision 1's replacement fixed the _rate_ rules and left a
_single-sample_ rule whose trigger probability also scales with N (C13, F6). Both are corrections,
not softenings.

**Deferrals are also not throttles.** A deferred application is one the machine could not do
correctly. The only sanctioned way to raise throughput is to make fewer things defer by making the
machine understand more — never by lowering the bar. Phase 4's defer taxonomy exists to make that
lever measurable instead of intuitive, and revision 2 closes the hole where a job stranded by a
board pause showed up in no bucket at all.

### 1.3 The design question, inverted

It is no longer _"how do we make unattended applying safe by doing less of it"_. It is:

> **What must this system become to correctly and quickly send hundreds of genuinely good
> applications, unattended, without corrupting its own state or the user's reputation?**

### 1.4 Corrections, recorded in place

C1-C7 correct `docs/autonomy-plan.md`. **C8-C13 correct revision 1 of this document** and are
kept, not merged away, so the wrong reasoning stays legible. `doc-scribe` shall add a pointer at
each superseded site reading "superseded — see `autonomy-plan-v2.md` §1.4 C_n".

**C1 — `autonomy-plan.md:882-890`, "§3.5 The honest limitation", is wrong.**
It says: _"The runner cannot tailor — tailoring needs a model. So the 12h loop is sweep, then
apply to what's already prepped."_ The premise is false. Rule 1 already restricts a résumé to
facts from the fact base; `buildFactIndex` (`scripts/lib/lib.mjs:147-183`) already stores ready
bullet text per fact id; `buildPlan` (`scripts/documents/keyword-plan.mjs:242-301`) already
computes the term selection deterministically and already returns `blocked` — exactly the set R6
rejects. The model's remaining contribution to a résumé is **rephrasing**, which is the only step
that can introduce a violation. v1 encoded its own binding constraint as a design. Replaced by
Phase 3.

**C2 — the "two consecutive job failures" breaker is arithmetically a volume throttle.**
At an independent per-job failure rate of 5%, `P(halt)` is 0.49% at N=3 and **90.79%** at N=999.
Replaced by the correlation-keyed breaker, §4.6.
**Revision-2 correction:** revision 1 said the median halt was around job 380.
`attack:feasibility` recomputed the recurrence and puts the median at **job 292** — `P(halt by
380)` is 59.6%, already past the median. Their figure is right and I take it. The conclusion is
unaffected; the count-based breaker stays deleted.

**C3 — `-ExecutionTimeLimit 01:00` and one-invocation-is-one-campaign cannot fit the
requirement.** Sleep, a Chromium crash and a scheduler kill all produce the same need, and a
longer limit covers one of three. Replaced by resumability from a durable ledger, Phase 1 and §4.5.

**C4 — the "warns when the last run is over 26h old" heartbeat does not exist and is the wrong
statistic anyway.** `grep -c "auto_runs\|INBOX" scripts/status.mjs` returns `0`. Once runs are
resumable and frequent, a run that starts, fails at job 1 and exits is indistinguishable from a
healthy one under a recency test. Replaced by a **progress** digest, Phase 4.

**C5 — R6 (split `CLAUDE.md`) is demoted off this critical path.** The runner has no model in it
by construction, so R6 is a developer-session cost, not a runner cost.

**C6 — R3 (typed intents) is promoted from a backlog item to a shipping prerequisite.** A polarity
bug produces the same wrong answer on every form that asks. At 3 applications that is an
embarrassment; at 999 it is one systematic misstatement signed hundreds of times in the user's
name. Phase 2.

**C7 — "half-filled abandoned applications" is no longer an acceptable cost.** At 999 attempts
with a 5% multi-page defer rate that is ~50 partial records under the user's name in employers'
ATSs — the one reputational cost that scales linearly through the **defer** path. Phase 5 W3.

---

**C8 — revision 1's Phase 1.2 made the runner unable to ever submit. (F1.)**
It re-keyed `auto_submissions` to `PRIMARY KEY (slug)` with `ON CONFLICT DO NOTHING`, while
§4.10 item 7 makes the click conditional on that insert reporting **1 change**. But dry-run rows
go into the same table — verified, `db.mjs:216`: _"A dry-run row is recorded too, with mode
`dry_run`"_ — and all of Phase 5's ladder was `dry_run`. After the rehearsal, every rehearsed
slug already holds a row, the live insert reports 0 changes, and `submitOnce` refuses forever.
Worse, the same comment block warns that caps count dry-run rows **on purpose**
(`db.mjs:866-874`), so a 999-job rehearsal against the real DB would exhaust `per_day_max` and
every company window before the first live click.
**Replaced by:** claim key `(slug, mode)`; cap queries continue to read both modes, unchanged;
and every Phase 5 rehearsal runs against a **fixture DB path** the runner refuses to combine with
`jobs/leads.db`. Phase 1.2 and §4.10 item 7 rewritten; W1-W4 checks state the DB path.

**C9 — revision 1's "one persistent context is forced, not chosen" is false, and its mitigation
did not bound the hazard it named. (F2.)**
`browser.mjs` has a non-persistent branch in the same function — verified,
`:169-170`: `browser = await chromium.launch(common); context = await browser.newContext()`.
And the mitigation, "at most one in-flight job per `board_key`", is keyed on a value that is
**tenant**-scoped — verified, `automatability.mjs:126-138`: hostname + first path segment +
`for=` employer param — while cookies and `localStorage` are **origin**-scoped. Eight Greenhouse
tenants are eight `board_key`s and **one** origin, one cookie jar, one storage area. Greenhouse's
embed flow holds upload and draft state per origin, so tab 3's résumé upload token is overwritable
by tab 6's, and the failure mode is the Coinbase application submitted carrying the Tebra-tailored
résumé — irreversible, signed with the user's name, and undetectable because nothing is read back
out of the page. That the plan _named_ the cost and then mitigated it on the wrong key is exactly
the "wrong axis" failure this role exists to catch, and revision 1 committed it.
**Replaced by:** §4.2, rewritten. The in-flight-exclusion key becomes the **registrable origin**
of `apply_url`. Concurrency is recovered structurally, not by sharing state: the cookie-free
allowlist boards (§6.4) launch **non-persistently** with one `browser.newContext()` per job —
genuine per-job storage isolation, no profile copy, using a branch that already exists.
`AUTO_PROFILE` is reserved for boards that genuinely need a session, capped at one in flight per
origin. The wall-clock composite that depended on the old isolation model is withdrawn.

**C10 — revision 1's validation ladder never executed the post-click path before a real employer
did. (F3.)**
§4.10 states _"if `mode !== 'live'` it returns after every check above without clicking"_, and
W1-W3 were all `dry_run`. So the click, the navigation, the typed confirmation classifier, the
`confirmation_url` write, the `attempted → submitted` transition, and two of the four
single-sample hard STOPs would all run for the first time on the user's first real application.
The plan's own sequencing principle — _"everything after the first real click is irreversible"_ —
was violated by its own test strategy.
**Replaced by:** a required **live-against-fixture** mode and a new widening **W2**, plus the
confirmation classifier refactored into a pure function over `(url, html)` gated on a committed
corpus (§4.10, Phase 5).

**C11 — revision 1 scheduled the measurement harness after the changes it was meant to judge.
(F4.)**
`bench-apply.mjs`'s browser arm measures nav, CDP round trip, scan, label resolution, page-side
probe and CSP — and **no fill leg and no upload**. So there is zero clocked data on the fill path
through a real browser, which is the largest term in any per-application estimate. Revision 1
built that leg in Phase 4.5, _after_ 0.2, 0.5, 0.7, 2.1-2.3 and 3.4 had all landed on the fill
path — and 3.4 was written as an explicit optimisation with no before/after and no budget. The
first fill baseline would have absorbed every un-budgeted change as "normal".
**Replaced by:** 4.5 and 4.6 hoisted into Phase 0 as **0.9** and **0.10**; baseline **B1**
captured at a clean `git worktree` of `fa192a1` and written to `docs/measurements.md` with the
`file_sha1` of `fill-plan.mjs`, `answer-bank.mjs` and `field-cache.mjs`; and a **declared budget
required in the work item before it is picked up** for 0.2, 0.5, 0.7, 2.1-2.3 and 3.4.

**C12 — revision 1's supply arithmetic does not close, and its own remedy does not close it.
(F5.)**
`attack:feasibility` measured ~28 leads/day across 24 producing boards, ~82% dismissed, giving
~5 qualifying leads/day and ~1.2 leads/board/day. Scaling to 400 boards yields ~85 qualifying
leads/day — roughly **100 applications/day against a target of 999**, an order of magnitude
short, delivered by the plan's own remedy. Revision 1's Phase 6 check ("qualifying leads per
sweep, tracked over four sweeps") carried **no numeric target**, so it could not go red, and
Phase 6 was scheduled last and non-gating.
**Replaced by:** Phase **0.11** — one sweep, owned by `w5-leads`, reporting qualifying leads per
board per sweep and extrapolating the board count needed for 999/day **as a number in this plan**
— and a numeric completion criterion for 6.1 derived from it.
**Partially rejected:** the critic's suggestion to "re-derive the runner's requirements against
the real N" is declined for the runner's _correctness_ requirements and accepted only for its
_tuning_ parameters. Resumability, the durable ledger, the origin-scoped isolation and the claim
protocol are correctness properties — a crash duplicating an application is bad at N=5. What the
real N legitimately re-opens is concurrency, the scheduling window and the breaker's calibration,
and those are already withdrawn pending measurement (§6.1, §6.3, Phase 4.7). Supply is the thing
to fix, not the requirement to lower.

**C13 — revision 1's hard STOP #1 fires on a healthy run, and its probability scales with N.
(F6, and it is C2 one layer down.)**
Greenhouse's own support documentation (article 115005448066, retrieved 2026-08-01) states that
Invisible reCAPTCHA is built into careers-page integration options 1-4, that it analyses "mouse
movements and typing patterns", and that on suspicion it may **dismiss** the submission or demand
an email verification code, with tenant-configurable strictness. A Playwright-side fill emits
near-zero input events. So a post-submit page that is not a confirmation is an **expected
environmental outcome at automation volume** — the board challenging the submitter, not the
machine malfunctioning — and its incidence rises with N and with IP concentration. Revision 1's
invariant ("a healthy run of 999 must be no likelier to halt than a healthy run of 3") was
violated by revision 1's own rule.
**Replaced by:** two new typed post-click outcomes, `bot-challenge` and `email-code-challenge`,
which are **deferrals feeding the correlated board pause**, never a run STOP (§4.6, §4.10). Hard
STOP is retained for genuinely `unclassified` pages only.
**And a second consequence the fix must carry:** §4.5's "attempted counts as submitted"
presumption is calibrated on a ~1% crash window, **not** on systematic silent dismissal. A
`bot-challenge` row is therefore recorded as `challenged` — it still counts toward company caps
(never under-count; a duplicate is irreversible) but is reported as **unconfirmed, not sent**, so
the user is never told 400 went out when far fewer did.

---

## 2. The thesis

**This is not an auto-applier. It is a provenance machine that happens to submit.**

Every comparable service surveyed **generates**: a model writes plausible résumé prose and a bot
pushes it through a form. That architecture has one failure mode and it is fatal at volume — the
output degrades exactly when attention is scarcest, which is precisely when volume is high.
Jobright's dominant complaint pattern is hallucinated metrics; LazyApply sits at 2.5/5 with
wrong-field fills; the one honest volume self-report is 819 applications for a 0.6% interview rate.

This repository **selects**. Content is drawn verbatim from an approved fact base, each résumé
sentence carries a fact id, `verify-claims` R6 rejects anything the base cannot back, the fill
pipeline has no model on the critical path (`package.json` carries no LLM SDK — deps are `js-yaml`
and `marked`), and a hostile posting is rejected at screening rather than argued with.

The property that follows is the edge, and it is real:

> **Per-application quality is invariant to volume.** Quality is a function of the fact base and
> the gates, not of how much attention was available that night. The 400th application of the
> night is byte-for-byte the standard of the first.

**CORRECTION (review, `attack:outside-reality`, accepted).** That claim holds for document
**content** and does **not** hold for submission **behaviour**. The behavioural layer is exactly
where volume degrades outcome: reCAPTCHA scoring consumes IP reputation and event-stream absence,
both of which worsen with concentration; a burst of hundreds of submissions from one residential
IP inside two hours is the canonical mass-application fingerprint. So the honest thesis is
**quality-of-content invariant to volume, quality-of-outcome contingent on submission shape** —
which is why §4.2b (arrival shaping, bounded by the recency SLA) and Phase 4.4 (challenge
incidence as a first-class measured column) exist. Saying it the other way would have been the
same class of error as the fatal above: mistaking a property of the documents for a property of
the system.

That matters now in a way it did not two years ago. Greenhouse's Real Talent quality-tiers
applications and blocklists by IP and email domain; Ashby reports 300+ applications per opening.
The market is building a filter whose input is _"does this look mass-produced"_. A pipeline whose
documents are assembled from one real person's verified facts, tailored per posting, is the shape
that survives that filter. The honesty rule and the efficacy argument point the same way, which is
rare and worth saying out loud: keyword stuffing, the classic gaming move, is explicitly listed by
employer-side tooling as a spam signal.

Two capabilities nobody in the surveyed field has, both already latent here: **a deferral with a
stated reason**, and **a local store of record** the user keeps if the project dies. Add the
volume decision and a third becomes available: at hundreds of applications a day the system
generates enough outcome data to _learn_ what it should be targeting. Volume stops being spray and
becomes measurement.

**The direction, in one sentence:** the only job-application system that can send 500 applications
and, for every one of them, name the fact behind each sentence, the reason it declined the ones it
declined, and the durable record of exactly what went out.

**The two binding constraints, stated together.** First, the model is still on the document path,
so until Phase 3 lands the runner can never apply to more jobs than a human sat through a model
batch for. Second — and this is new in revision 2 — **lead supply is very likely the harder
constraint**: the measured yield implies an achievable ceiling closer to ~100 applications/day than
999 even after board expansion (C12). Neither is engineered around by lowering the requirement.
Phase 0.11 measures the second one **before** six phases are built on an assumption about it.

**The sequencing principle:** everything before the first real click is cheap and reversible;
everything after it is irreversible and signed with the user's name. Order accordingly — state
before behaviour, correctness-of-content before volume-of-content, volume last, because volume
multiplies whatever is true when it arrives. **And measure before you build on the number** — F4
and F5 were both this principle applied to measurement, which revision 1 exempted from it.

---

## 3. The phases

Seven phases. Each states its goal **as a capability**, its work items with the owning agent from
`docs/team-roster.md`, and a **falsifiable check** — a command or test that can go red. A phase
whose check is "the code is written" is not acceptable and none appear below.

Phases 0-4 are sequential. Phase 5 is gated on 0-4. Phase 6 may start any time after Phase 3 and
does not gate the runner — **except 0.11, which is hoisted into Phase 0 precisely because it
gates the plan's own arithmetic.**

---

### Phase 0 — Class removers, and the measurements everything else is priced against

**Capability:** whole classes of failure become unreachable, and the three numbers the rest of the
plan spends are taken **before** anything is changed. Every item here is hours, not days, and each
becomes materially more expensive to retrofit once the runner is written against today's contracts.

| #        | Work item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Owner                                   | State     |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | --------- |
| 0.1      | `consumeSubmitToken` **shall** take a required `pageUrl` and throw `TokenError` unless its origin equals `token.apply_url`'s origin. The token already carries `apply_url` and nothing compares it.                                                                                                                                                                                                                                                                                                                                                                     | `w4-autonomy`                           | SHALL     |
| 0.2      | `submitReadiness` **shall** return false when any plan item or defer entry carries a `labelFlag`, and `authorizeSubmit` **shall** mirror the key beside its existing `plan_defer` check, so relaxing one cannot widen the gate. **Budget: declare before pickup** (§0.9).                                                                                                                                                                                                                                                                                               | `w3-resolution`, `w4-autonomy`          | SHALL     |
| 0.3      | Page-derived labels **shall** pass through `sanitizeUntrusted` before entering a defer reason or the run JSONL. Today `authorize.mjs:305-315` (untracked file, §0.2) builds the reason from the raw third-party label.                                                                                                                                                                                                                                                                                                                                                  | `w4-autonomy`                           | SHALL     |
| 0.4      | `auth-sync`'s copy filter **shall** be inverted from a denylist of caches to an allowlist (Cookies, Local Storage, Local State, minimal Preferences). Today `SKIP_DIRS` (`auth-sync.mjs:119-141`) excludes only caches, so saved site passwords (`Login Data`), autofill payment cards (`Web Data`), History and Bookmarks are copied into a profile that will visit hundreds of third-party pages.                                                                                                                                                                     | `w4-autonomy`                           | SHALL     |
| 0.5      | The field-cache fingerprint **shall** include the registrable host. Today `field-cache.mjs:54-60` builds `atsId + "\|" + labels.join("\n")`, cross-tenant by construction. **Budget: declare before pickup — this invalidates every existing cache entry and forces a re-probe on the next application per board, and nobody currently knows whether a probe costs 87.89ms or 6.8s.**                                                                                                                                                                                   | `w3-resolution`                         | SHALL     |
| 0.6      | An **identity-verification wall** (Real Talent / CLEAR selfie, quality-tier challenge) **shall** be a named defer kind, distinct from CAPTCHA, distinct from failed-fill, and explicitly **not** a malfunction.                                                                                                                                                                                                                                                                                                                                                         | `w3-resolution`                         | SHALL     |
| 0.7      | Name/email/phone **shall** be emitted byte-identically on every form, sourced from `profile.yaml` only, asserted by a test that fails on format drift or plus-aliasing. **Budget: declare before pickup.**                                                                                                                                                                                                                                                                                                                                                              | `w3-resolution`, `qa-breaker`           | SHALL     |
| 0.8      | The in-flight wave — `authorize.mjs` capability token, durable attempted row, `LEADS_LOCK` in `find-jobs.mjs`, dead consent-allowlist grant branch deleted — **lands here.** Do not re-propose it; build on it. **`doc-scribe` re-runs §0.2's table with `file_sha1`s once it commits.**                                                                                                                                                                                                                                                                                | `w4-autonomy`, `w5-leads`, `doc-scribe` | IN FLIGHT |
| **0.9**  | **NEW (C11).** `bench-apply.mjs` **shall** gain a `--browser-fill` leg running `fill-engine.mjs` through the existing `clockedPage()` recorder against the loopback fixture, including one real file upload, reporting fill wall, unconditional sleep and post-upload remount as **separate columns** — and fixing M6, where a run reporting `ok:2 failed:1 deferred:3` still passes. Baseline **B1** captured at a clean `git worktree` of `fa192a1` and written to `docs/measurements.md` with `file_sha1` for `fill-plan.mjs`, `answer-bank.mjs`, `field-cache.mjs`. | `qa-breaker`                            | SHALL     |
| **0.10** | **NEW (C11).** `ashby-step1.scan.json` and `lever-step1.scan.json` **shall** be committed so the accounted arm stops throwing at `bench-apply.mjs:1215`, plus an Ashby remount leg. The fixture server **shall** gain a declared latency model (`--latency`, default ~300ms nav / 150ms XHR) reported as a **separate column never merged with loopback**, and a **parameterised employer segment** (`/boards.greenhouse.io/fixture-emp-<n>/jobs/<id>`) so a 50-app run spans ≥8 distinct origins/tenants instead of one.                                               | `qa-adversary`                          | SHALL     |
| **0.11** | **NEW (C12).** One `find-jobs` sweep across the current 46 boards, reporting **qualifying leads per board per sweep**, and an extrapolation stating the board count required for 999 qualifying leads/day **as a number written into §7 R-8 and §2**.                                                                                                                                                                                                                                                                                                                   | `w5-leads`                              | SHALL     |
| **0.12** | **NEW (review, missing).** Green-tier prevalence **by widget shape**, computed from the **already-stored scans** of the 141 leads: what fraction of real launch-board forms can reach green at all, given that a required work-auth or demographic question rendered as a radio group defers permanently under the settled `confirm-widget` rule. This costs no new browsing and it gates the supply math as hard as 0.11 does.                                                                                                                                         | `w3-resolution`                         | SHALL     |
| **0.13** | **NEW (review, F6 follow-on).** `apply_url` canonicalization at enrichment: aggregator links and embedded careers pages **shall** be resolved to the underlying ATS-hosted URL where one exists. Measured today: 47/141 leads carry `adzuna.com` and 10 carry `coinbase.com` (an embedded board whose real ATS is not the recorded registrable domain), so the trust gate as specified rejects them even when the underlying form is Greenhouse.                                                                                                                        | `w5-leads`                              | SHALL     |

**Falsifiable check.** All of the following go red on regression:
`node --test "tests/auto/**/*.test.mjs"` includes a case where `consumeSubmitToken` is called with
a `pageUrl` on a different origin from `token.apply_url` and asserts `TokenError`; a case where a
plan carrying `labelFlag` yields `submitReadiness === false`; a case asserting a defer reason built
from a hostile label contains no instruction-shaped substring. A test asserts the synced profile
directory contains no file named `Login Data` or `Web Data`.
`tests/apply/field-cache.test.mjs` asserts two different hosts with identical label sets produce
different fingerprints. **B1 exists in `docs/measurements.md` with three `file_sha1`s and a
reproducible command**, and `node scripts/dev/bench-apply.mjs --board ashby` exits 0 instead of
throwing at `:1215`. **0.11 and 0.12 each produce a number in this document**; a phase check that
produced no number has not been done.

---

### Phase 1 — State: a durable ledger, and a real definition of "verified"

**Capability:** the run stops being the unit of anything. A kill at application #437 of 999 loses
nothing, duplicates nobody, and the next invocation resumes at 437 by reading the database.
Separately: no document reaches the submit path on the strength of a file merely existing.

**Why now.** No per-application state exists anywhere. `auto_runs` holds counters and
`auto_submissions` gets a row only at click time, so a crash at #437 leaves no queryable answer to
"which 436 were done". And the idempotency key is wrong by construction — `PRIMARY KEY (run_id,
slug)` (verified, `db.mjs:232-246`, both at `fa192a1` and in the worktree) means the same slug can
be submitted once **per run** with no conflict, and `ON CONFLICT DO UPDATE` overwrites rather than
refuses. That is exactly backwards for a row whose job is to be a claim.

| #       | Work item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Owner                        | State |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ----- |
| 1.1     | `auto_queue(slug PRIMARY KEY, run_id, board_key, origin, state, attempt_no, plan_sha256, reason_kind, reason_detail, claimed_at, updated_at)` **shall** exist, with states `queued → claimed → planned → authorized → attempted → submitted \| challenged \| deferred \| failed`. The claim is `INSERT ... ON CONFLICT DO NOTHING`; **0 changes means another worker owns it and this one must not click.** `origin` is added for §4.2's exclusion key.                                                                                       | `w4-autonomy`                | SHALL |
| 1.2     | **REVISED (C8).** `auto_submissions` **shall** be re-keyed `PRIMARY KEY (slug, mode)` with `ON CONFLICT DO NOTHING` — **not `(slug)`**, because dry-run rows live in the same table and a rehearsal would otherwise pre-consume the live claim forever. `countAutoSubmissions` and `companySubmissionBreakdown` **shall** keep reading both modes: `db.mjs:866-874` counts rehearsals toward caps deliberately and that is correct. `plan_sha256` is copied into the claim row so a retry with a _different_ plan is a visibly different act. | `w4-autonomy`                | SHALL |
| 1.3     | `verify-claims` **shall** write a durable row `(slug, doc_sha256, mode, verdict, profile_sha256, verified_at)`. `hasVerifiedResume` **shall** mean "a passing row exists whose `doc_sha256` matches the file on disk **and** whose `profile_sha256` matches the current fact base". Today a résumé verified against yesterday's fact base is still "verified" after the user edits `profile.yaml`.                                                                                                                                            | `w1-security`, `w4-autonomy` | SHALL |
| 1.4     | The file-existence heuristic at `automatability.mjs:454-473` **shall** be deleted outright, and the model-written `context.json` `resume_status` **shall** stop being load-bearing for tier classification.                                                                                                                                                                                                                                                                                                                                   | `w4-autonomy`                | SHALL |
| 1.5     | `updateApplication` (`db.mjs:589-597`) **shall** wrap its SELECT → parse → merge → upsert in one transaction or lock. Today two concurrent callers lose one patch entirely — a manual outcome update made during a multi-hour run is silently discarded.                                                                                                                                                                                                                                                                                      | `w4-autonomy`                | SHALL |
| 1.6     | The durable `attempted` row write — **and only it** — **shall** be wrapped in a bounded retry on `SQLITE_BUSY`. Change nothing else about the SQLite configuration.                                                                                                                                                                                                                                                                                                                                                                           | `w4-autonomy`                | SHALL |
| 1.7     | `migrate.mjs` **shall** gain a rebuild path for `auto_queue`, and the `documents` table's no-on-disk-source status **shall** be restated in its header.                                                                                                                                                                                                                                                                                                                                                                                       | owner per §0.3               | SHALL |
| **1.8** | **NEW (review, missing).** A retention policy for the two things that grow per application: `auto_submissions.doc` (verify block, consent labels, screenshots) and `jobs/<slug>/`. **Shall** state a measured per-row and per-workspace byte cost, a 30-day projection at the rate 0.11 establishes, and a `prune-jobs`/`archive` cadence. §6.5's per-run DB copy is priced against that projection, not against today's size.                                                                                                                | owner per §0.3               | SHALL |

**Explicitly out of scope for Phase 1:** connection pooling, WAL tuning, and reordering the
`busy_timeout` / `journal_mode` pragmas. **Note on the evidence, accepted from
`attack:feasibility`:** the cited concurrency measurement is 3-4 writers, and this project's own
settled lesson is that the lock defect was invisible at 6 and needed 20 to show — so that evidence
is thin. The conclusion survives on independent arithmetic: 8 workers × 7 durable transitions per
job ÷ ~45s per job ≈ 1.24 writes/s against a cited 0.24ms/write, three orders of magnitude of
headroom. Out of scope, on the better argument.

**Falsifiable check.** A test in `tests/auto/` that inserts 50 queue rows, processes 20, simulates
process death mid-job, reopens the DB, and asserts the resume selection is exactly the 30
unprocessed slugs and zero of the 20 done. A second that two workers racing one slug produce
exactly one successful claim and the loser returns without clicking. A third that a `resume.md`
whose `doc_sha256` has no passing verification row classifies as `blocked`, and that editing
`profile.yaml` invalidates an existing verification. **A fourth (C8): a slug with a `dry_run` row
still admits a `live` attempted insert reporting 1 change, and a second `live` insert on the same
slug reports 0.**

---

### Phase 2 — Typed intents (R3)

**Capability:** an answer whose truth value is wrong can no longer be produced, because the matcher
returns a typed intent rather than a string that happens to contain the right concept.

**Why it is a prerequisite and not a priority.** This is C6. A fuzzy match can find the right
concept with the wrong polarity — "authorized to work _without_ sponsorship" — and the same form
question appears on hundreds of boards. It is the single item whose _severity class_, not merely
its ordering, the user's decision altered.

| #   | Work item                                                                                                                                                                                                                                                                                                                                                                             | Owner           | State |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ----- |
| 2.1 | The answer-bank ladder **shall** be replaced by typed intents per `autonomy-plan.md:433-454`, such that a resolution carries `{concept, polarity, class, provenance}` and a polarity that cannot be established **defers**, never inverts. **Budget: declare before pickup** (C11).                                                                                                   | `w3-resolution` | SHALL |
| 2.2 | Bank-sourced **free-text** answers over a length threshold **shall** defer on the unattended path. `SKIP_TYPES` (`answer-bank.mjs:402`) skips only `file` and `richtext`, so a textarea labelled "Anything else we should know?" is a fillable target today. This defers a **field**, not an application. **Budget: declare before pickup.**                                          | `w3-resolution` | SHALL |
| 2.3 | A per-form **disclosure declaration**: the plan **shall** name the bank ids it will disclose, and an unusual set defers. The read side of the fact base is currently a lookup keyed on an attacker-chosen string (`answer-bank.mjs:712`, `normalizeQuestion` over the page's own label) and nothing counts how many distinct facts one form pulls. **Budget: declare before pickup.** | `w3-resolution` | SHALL |
| 2.4 | The prohibition **shall** be written into `CLAUDE.md` rule 6: unattended throughput may rise **only** through deterministic understanding — adapters, probed option lists, banked answers via `save-answer.mjs` — and **never** through model resolution of an `UNKNOWN` field.                                                                                                       | `doc-scribe`    | SHALL |

**On 2.4, and why it costs a paragraph now.** The unlimited-volume requirement creates direct
pressure to shrink the defer list, and the cheapest-looking reading of "make fewer things defer" is
"let a model resolve the UNKNOWNs" — which is the single change that puts attacker text and the
fact base in one context window on an unattended path. Naming it now costs a paragraph; discovering
it after a wave costs the rule. _(Endorsed by `attack:correctness` as the one place the plan
resists volume pressure correctly. Unchanged.)_

**Falsifiable check.** `tests/apply/` gains a polarity corpus: for each of ≥12 question pairs
differing only in negation, assert the resolution is either the correct typed intent or a defer —
**never** a confident inversion. The test asserts a count so an empty run cannot pass.
`grep -n "UNKNOWN" scripts/auto/*.mjs` shows no model call anywhere on that path, and `node -e`
over `package.json` shows no LLM SDK in dependencies.

---

### Phase 3 — Deterministic document assembly

**Capability:** documents are produced without a human in the session. The ceiling on applications
stops being "how many documents a supervised model batch produced" and becomes "how many leads
exist". **This is the phase that lifts the first binding constraint of §2.**

**The one property this buys that patching cannot:** the pipeline becomes unattended along its
entire length, and the only operation in the document pipeline that _can_ lie is removed rather
than checked.

| #   | Work item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Owner                         | State |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ----- |
| 3.1 | `scripts/documents/assemble-resume.mjs` **shall** exist: `(job.json, profile.yaml, answers.yaml)` → `buildPlan`'s `must_use` → select fact ids by coverage under a length budget → emit each fact's text **verbatim** with its `<!-- fact:ID -->` annotation, in the `good-resume.md` shape. Passes R1-R7 by construction. Zero model turns. Only `keyword-plan` reads the posting and it already sanitizes.                                                                                                                                                                                                      | `w6-documents`                | SHALL |
| 3.2 | A model rephrase pass **shall** remain available as an **optional, re-verified** step in attended sessions — never as the only path, and never on the unattended path.                                                                                                                                                                                                                                                                                                                                                                                                                                            | `w6-documents`                | SHALL |
| 3.3 | Cover letters **shall** stay model-authored and **shall** be authored per reuse cluster, not per job (`scripts/leads/cluster.mjs` EXISTS). Do not degrade the letter to a template: the only field experiment (ResumeGo, n=7,287, ~2020) puts tailored letters at 16.4% callbacks against 12.5% generic. If letter throughput is the bottleneck, scale the clustering, not the quality. **Shall** state a per-cluster token/dollar estimate — this is the only remaining model cost in the system and it is currently unpriced.                                                                                   | `w6-documents`                | SHALL |
| 3.4 | `verify-claims.mjs` and `reuse-check.mjs` **shall** be refactored from top-level scripts into exported pure functions with thin CLI wrappers (`grep -c "^export"` returns `0` on both today). The fact index **shall** be built once per run; each workspace's tech-stack set **shall** be cached in the DB so `reuse-check` becomes a join rather than a readdir plus a lexicon scan of every sibling on every call. **This is a signature change, not a rewrite.** **Budget: declare a target before pickup** — this item is sold as a speed-up and currently has no number attached in either direction (C11). | `w1-security`, `w6-documents` | SHALL |
| 3.5 | Hard rule 5's approval message **shall** become a mechanical selection diff — which fact ids were included, which dropped, and why — rather than a model's self-report of what it emphasised.                                                                                                                                                                                                                                                                                                                                                                                                                     | `w6-documents`, `doc-scribe`  | SHALL |

**Cost, stated plainly.** ~250 lines plus a golden-file test per profile section, plus 3.4's
signature change, plus **a register change the user must accept**: résumés will read in the user's
own approved sentences rather than posting-matched prose. That is Open question §6.2.

**The honest risk.** This requires that profile bullets are usable verbatim in a résumé.
`buildFactIndex` (`lib.mjs:147-183`) stores exactly that shape, and the passing fixture
(`tests/fixtures/good-resume.md:13`) is a profile fact's text plus its annotation. But the user's
real `profile.yaml` is gitignored and I have not read it. If its bullets are note-shaped rather
than résumé-shaped, this becomes a one-time fact-base editing pass **by the user** — never by the
agent, rule 2 — and that pass is on the critical path.

**Falsifiable check. REVISED (review, both critics concurring).** Revision 1 asked for "the absence
of any network egress", which is green by construction — `assemble-resume.mjs` is a pure local
script and `package.json` carries no LLM SDK, so the check could never go red for the property it
claimed to establish, and it would stay green if a later change routed rephrasing through an
`execFileSync` of a model CLI in the _caller_. Replaced by three checks that can fail:

1. For ≥6 job fixtures spanning different tech stacks, the assembler's output is **byte-identical
   to a committed golden file**, passes `verify-claims resume <out>` with exit 0, and every
   sentence appears verbatim in `profile.yaml` or `answers.yaml`.
2. A **static assertion on the import graph** of `assemble-resume.mjs`: no `child_process`, no
   `fetch`/`undici`, no LLM SDK — plus a runtime spawn counter via a monkeypatched
   `child_process` in the test.
3. **A throughput number**: documents-per-hour for the assembler versus the current attended path,
   recorded as a ledger entry in `docs/measurements.md`. This is the number Phase 3 exists to move
   and it is currently unmeasured in both directions.

Plus the rule-0 check, unchanged: for a posting containing an instruction-shaped payload, the
assembled résumé is byte-identical to the one assembled from the same posting with the payload
removed. **The campaign-level `model_turns === 0` assertion moves to Phase 4.7's runner harness,
where it can actually observe the whole path.**

---

### Phase 4 — Observability, the defer taxonomy, and the measurement gate

**Capability:** the user can tell, in one command, whether the machine is working — and engineering
effort is allocated by measured application-loss rather than intuition.

**Deferral-driven development.** Every deferral already carries a reason. Type those reasons,
aggregate them across a campaign, and the defer log becomes the product's own backlog generator:
_"`unprobed-dropdown` on Workday cost 61 applications this week; building the Workday option-probe
unlocks them."_ The only sanctioned throughput lever — the machine understanding more — becomes a
measured, prioritised list. This requires the reasons to be **typed values, not strings**. A
free-text reason cannot be aggregated and will be reworded past on the first try; that is string
matching where a type belongs, and it is why 4.1 comes before 4.2.

| #       | Work item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Owner                      | State |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ----- |
| 4.1     | A closed **defer/failure taxonomy** (§4.6) **shall** be defined as typed kinds with a `stage` and a `board_key`, written to `auto_queue.reason_kind`, with the sanitised human detail in `reason_detail`. **Including `board-paused`**, written to every job a board pause strands — revision 1 left those jobs in `queued` with no kind, so the largest single loss bucket in a degraded run was invisible to the digest and to the defer-rate gate that the whole phase rests on (`attack:feasibility`, accepted).                                                                                                                  | `w4-autonomy`              | SHALL |
| 4.2     | `status.mjs` **shall** gain an auto section reporting **progress, not recency**: submissions in the last 24h, deferrals grouped by `reason_kind`, orphan count, STOP set yes/no with its reason, `posted_at → submitted_at` p50/p95, **and — added on review — queue depth and age p95 for `queued`/`claimed`, the list of currently paused `board_key`s with their held counts, `challenged` (unconfirmed) count, and a WARN when any row has been queued longer than one scheduler cadence.** A queue depth that is not falling is the single most informative number the auto path has, and revision 1's digest could not show it. | owner per §0.3             | SHALL |
| 4.3     | `INBOX.md` **shall** become an append-only alert channel that `raiseStop` and every security-class finding writes to, **kept separate from STOP's brake.** `raiseStop`'s first-reason-wins rule is correct for the run record and wrong for notification: a benign STOP at job 3 buries a credential-exposure STOP at job 400. A Windows toast **shall** fire on STOP.                                                                                                                                                                                                                                                                | `w4-autonomy`              | SHALL |
| 4.4     | **Challenge incidence** — CAPTCHA, `bot-challenge`, `email-code-challenge` — **shall** be aggregated per board per run, and a challenge appearing on a previously challenge-free board **shall** be an anomaly-breaker input. Employer-side flagging is silent, so rising challenge incidence is the only applicant-observable proxy for being scored down.                                                                                                                                                                                                                                                                           | `w4-autonomy`              | SHALL |
| 4.5     | _(Moved to Phase 0.9 — C11.)_                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | —                          | MOVED |
| 4.6     | _(Moved to Phase 0.10 — C11.)_                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | —                          | MOVED |
| 4.7     | `scripts/dev/bench-runner.mjs` **shall** exist and track **nine** numbers: **submitted**-applications-per-hour and **deferred**-applications-per-hour reported separately, defer-rate by reason class, model-turns-per-application, unconditional-sleep-ms-per-application, edge-spacing-wait-ms-per-application, p95 per-application wall, spawns-per-application, round-trips-per-application, and **per-job failure rate `p` per board**.                                                                                                                                                                                          | `qa-breaker`, `innov-perf` | SHALL |
| **4.8** | **NEW (review, missing).** Every number this plan produces **shall** land in `docs/measurements.md` as a ledger entry with its command, its legs and its shas. Revision 1 had seven phases, a CI gate, six tracked columns and a user-facing concurrency proposal, and not one work item that wrote a ledger entry — which is exactly how the 7.74/7.92 knee, the 240ms/1823ms SQLite figures and the 87.89ms probe reached this document with no command attached to any of them.                                                                                                                                                    | `innov-perf`               | SHALL |

**On 4.7, and why the column list changed. (`attack:feasibility`, accepted.)** In this repo
`model_turns` and `round_trips` are **derived, not observed**: `bench-apply.mjs:228-231` computes
`model_turns` as `PROTOCOL.filter(s => s.when(c)).length`, a static model of the prescribed MCP
flow, and `docs/measurements.md:88-95` records this as a standing caveat — M4 further records that
11 of 15 PROTOCOL citations had gone stale. Making a **derived** column the one hard, no-override
gate means the criterion the plan calls absolute is the one that can never fire. So `bench-runner`
**shall clock these, not derive them**: `model_turns` from an observed count (process spawns plus
outbound HTTP to any non-loopback host, both trivially instrumentable in-process), `round_trips`
from `clockedPage`'s existing `cdp_calls` counter (`bench-apply.mjs:1653`). Every column in the
harness output **shall** be labelled `measured` or `derived`, as `bench-apply` already does.

**Applications-per-hour alone is the wrong primary metric because it is gameable: deferring more
raises it, since a deferral is fast.** Revision 2 goes further and requires submitted and deferred
throughput as **separate columns**, because "how fast is a deferral" was never measured and without
it nobody can tell whether a defer-rate change moved the number for good reasons or bad ones.

**The CI gate, implementable as written** (`ci-engineer` wires it, `qa-breaker` owns the harness):

```
node scripts/dev/bench-runner.mjs --apps 50 --concurrency 8 --board greenhouse --runs 3 --json
```

against the loopback fixture in `dry_run` with a fixture submit endpoint, **against the
parameterised employer segment from Phase 0.10** — without it, every fixture job shares one
`board_key` and one origin, the exclusion rule serialises all 50, and the command reports N=1
throughput under the label N=8 (verified: `tests/fixtures/boards/server.mjs:104-113` defines a
single greenhouse path). `bench-runner` **shall** assert that observed max-in-flight equals the
requested concurrency and fail the run if it does not.

**FAIL** on: `sleep_ms_per_app > baseline × 1.10` unless the PR body carries
`perf-budget: sleep_ms +N`; `model_turns > 0` on any green-tier lead (hard, no override — green is
_defined_ as removing the model, and 4.7 makes this column observed so the gate can actually fire);
`round_trips_per_app > baseline` (budget-overridable); `defer_rate > baseline + 2pp`;
**`durable_attempted_rows === apps_that_reached_authorized`** and **`rows_in_state('attempted') === 0`
at run end**. **WARN ONLY** on `wall_ms_p95 > baseline × 1.25`. Each gated column **shall** state
which statistic it compares on (mean, min or p50) — unstated for all five in revision 1, and
`--runs 3` gives variance control on `wall_ms` only, since derived columns repeat identically.
Refuse to compare across a dirty `MEASURED_FILES` tree.

**CORRECTION (review, `attack:feasibility`, accepted).** Revision 1's gate contained
`durable_attempted_rows != apps_started` as a hard FAIL, which contradicts its own state machine:
deferrals exit at `planned` or `authorized`, **before** the attempted row is written, and the
taxonomy lists 14 pre-attempt kinds. The gate would have been red on every run by construction —
and within a week the team would be passing it with an override line, which is the exact failure
mode the plan reasons about correctly for `wall_ms_p95` and then reintroduced here.

**Falsifiable check.** `node scripts/status.mjs --json` emits an `auto` object with every field in
4.2, and a test asserts a fixture DB containing an orphan, a paused board with stranded jobs, and a
STOP produces all three in the output. The CI gate is proven by a deliberately-regressed branch: a
PR adding a `waitForTimeout(200)` to `fill-engine.mjs` must turn the gate red without a
`perf-budget` line, **and** a PR adding a real model call to the fill path must turn the
`model_turns` gate red — the second check exists because revision 1's derived column would have
stayed green.

---

### Phase 5 — The runner

**Capability:** the machine sends applications unattended, at the volume the lead supply allows,
and survives every way it can be interrupted.

Full specification in §4. **Four** widenings, each gated on the previous, each with its own check.

| Widening | Shape                                                                                                                                                                                                 | Owner                      | Falsifiable check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **W1**   | One job, `dry_run: true`, concurrency 1, one board (greenhouse), loopback fixture, **fixture DB path** (C8).                                                                                          | `w4-autonomy`              | `bench-runner --apps 1 --concurrency 1 --board greenhouse --db <fixture>` completes; `auto_queue` holds one row in `submitted` with `mode='dry_run'`; `auto_submissions` holds one row keyed `(slug,'dry_run')`; `model_turns === 0`; `spawns_per_app === 0`. `SIGKILL` at each of the 8 states, one test per state, leaves a resumable DB and never a duplicate. The runner **refuses** to start when the fixture flag and `jobs/leads.db` are both given.                                                  |
| **W2**   | **NEW (C10). Live-against-fixture.** A real click, real navigation, real classification, real `attempted → submitted` transition — against the loopback fixture's submit endpoint, never an employer. | `w4-autonomy`, `w2-engine` | The classifier is a **pure function over `(url, html)`** with a committed corpus of real confirmation, identity-verification, bot-challenge, email-code, error and not-a-confirmation pages, and a test asserts the correct typed outcome for each. A run kills the process **between click-return and the acknowledgement write**, and `reconcile.mjs` resolves the orphan without a human. A fixture page returning the reCAPTCHA resubmit shape yields `bot-challenge` → board pause, **not** a run STOP. |
| **W3**   | N pages/contexts, one board, `dry_run`, 50 jobs across ≥8 fixture employers. Multi-page precondition (C7) enforced via §4.2c.                                                                         | `w4-autonomy`, `w2-engine` | 50 jobs at concurrency 8 with **observed max-in-flight === 8**; `durable_attempted_rows === apps_that_reached_authorized`; zero orphans; a test asserting **two concurrent tabs on the same origin cannot see each other's storage** (the C9 regression test); and a test asserting a form whose page-3 fields are unresolvable **abandons the draft explicitly** rather than leaving a partial record.                                                                                                      |
| **W4**   | N boards, at most one in-flight job per **origin**. Still `dry_run` until the user enables.                                                                                                           | `w4-autonomy`              | A run across 3 fixture boards where board 2 fails every job: board 2 pauses **with `board-paused` written to every stranded job**, boards 1 and 3 complete every queued job, the run does **not** STOP, and a probe re-admission after the backoff clears the pause on one success. This is the check that the breaker is not a throttle.                                                                                                                                                                    |

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

### Phase 6 — Supply and the outcome loop

**Capability:** the lead supply can feed the runner, and the pipeline gets better at targeting with
every hundred applications sent.

**Why last, and why it is nonetheless the largest number in the system.** Supply solved _first_
buys nothing — leads that cannot become documents unattended are leads that sit. Documents first
(Phase 3) gives a working unattended loop that scales linearly the moment boards are added.
**But its measurement is hoisted to Phase 0.11 (C12), because revision 1 scheduled six phases of
build ahead of the number that says whether they reach the target.**

| #       | Work item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Owner                     | State |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ----- |
| 6.1     | `discover-boards.mjs` / `find-boards.mjs` **shall** scale board discovery from 46 toward the count 0.11 derives. **Completion criterion is numeric: qualifying leads per 12h sweep ≥ X, sustained over 4 sweeps**, where X comes from 0.11 — revision 1's "tracked over four sweeps" carried no target and therefore could not go red. Greenhouse + Ashby + Lever direct boards are both trust-gate-friendly and ban-free.                                                                                                                                                                                                                                                                                                                                                       | `w5-leads`                | SHALL |
| 6.2     | Recruitee boards **shall** be added, and Recruitee's documented, unauthenticated Careers Site submit endpoint (`POST /offers/:offer_slug/candidates`, verified at docs.recruitee.com 2026-08-01, explicitly "from candidate perspective") **shall** be the pilot no-browser submit lane. **Zero Recruitee leads exist today** (measured, §0.2), so this pays off only after 6.1. As the only lane with zero bot-scoring exposure it is, if anything, undersold.                                                                                                                                                                                                                                                                                                                  | `w5-leads`, `w4-autonomy` | SHALL |
| 6.3     | When multiple green leads share a company, `recommend.mjs` **shall** order them by title-similarity to the profile target before the weekly window fills. This spends the user's chosen 5/week on the strongest set **without lowering any cap.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `w5-leads`                | SHALL |
| 6.4     | Outcomes recorded via `update-application.mjs` **shall** feed back as priors into `fit.mjs` scoring.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `w5-leads`, `w4-autonomy` | SHALL |
| **6.5** | **REVISED (review).** `researcher` **shall** record in `docs/research/`: the ToS posture (candidate self-automation on ATS-hosted forms is contractually unaddressed; LinkedIn/Indeed prohibit it and stay out of the submit path); that competitor-blog "reviews" are marketing and must not be cited as user evidence; **the Greenhouse reCAPTCHA doc as a vendor-primary source (article 115005448066)**; **that SmartRecruiters documents a public Application API (`POST /postings/:uuid/candidates`) which is customer-token-gated and therefore not candidate-usable** — recorded so nobody re-surveys it and concludes the survey was sloppy; and **MyGreenhouse's "quickly apply" flow as an unresearched possible candidate-side lane**, assigned rather than assumed. | `researcher`              | SHALL |
| **6.6** | **NEW (review, missing).** Outcome recording at volume. §6.4's priors depend entirely on data the plan has no mechanism to collect once the user is receiving hundreds of responses. **Shall** specify at minimum a bulk outcome-entry path; the confirmation-email ingestion option is §6.7 and is the user's consent decision, not an assumption.                                                                                                                                                                                                                                                                                                                                                                                                                              | `w4-autonomy`             | SHALL |

**Falsifiable check.** 6.1: **qualifying leads per sweep against the numeric X from 0.11**, tracked
over four sweeps. 6.3: a test that ten same-company green leads yield the five most title-similar
first. 6.4: a backtest asserting that priors derived from a fixture outcome set change `fit.mjs`'s
ranking in the expected direction on held-out leads.

**6.4 costs time, not code.** It needs several hundred applications with recorded outcomes before
the signal is worth anything. That is why it is last, and why the volume decision is what makes it
possible at all.

---

## 4. The runner specification

**Nothing described in this section exists.** The check that settles it:
`grep -rn "\.click(" scripts/ --include=*.mjs` today returns only `fill-engine.mjs`,
`scan-engine.mjs` and `bench-apply.mjs`, and nothing under `scripts/auto/` (re-verified this pass).
When that grep returns a line in `scripts/auto/submit.mjs`, the runner exists.

### 4.1 Module structure

| File                          | Responsibility                                                                                                     | Contains a click?                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `scripts/auto/auto-apply.mjs` | Entry point. Parses args, opens the DB, launches the browser, drives the pool, closes down, writes the run record. | **No**                                           |
| `scripts/auto/queue.mjs`      | The `auto_queue` ledger. Enqueue, claim, transition, resume-select, derive counters.                               | **No**                                           |
| `scripts/auto/pool.mjs`       | N workers, partitioned by **origin** (§4.2).                                                                       | **No**                                           |
| `scripts/auto/job.mjs`        | The per-job state machine — **this is R1's state machine, and it is the worker, not the top level.**               | **No**                                           |
| `scripts/auto/trust.mjs`      | The trust gate (§4.8).                                                                                             | **No**                                           |
| `scripts/auto/classify.mjs`   | **NEW (C10).** Pure function `(url, html) → typed post-click outcome`. No browser, no I/O.                         | **No**                                           |
| `scripts/auto/advance.mjs`    | **NEW (§4.2c).** `advanceOnce()` — clicks a control whose scanned role is `next`, **never** `submit`.              | **Yes — one, and it is not a submit**            |
| `scripts/auto/submit.mjs`     | Exports exactly one function, `submitOnce()`.                                                                      | **Yes — the only submit**                        |
| `scripts/auto/reconcile.mjs`  | Settles orphaned attempts (§4.9).                                                                                  | No — navigates and reads, never clicks a control |

**The runner shall `import` its stages, never `execFileSync` them.** A bare `node -e 0` spawn costs
~49.6ms median (independently re-measured on this machine by `attack:feasibility`, 15 samples, min
45.3 max 59.0 — corroborating the 47ms this plan used); four spawns per application over 999
applications is ~198s of pure process startup, and Node is single-threaded so it serialises behind
every tab. `spawns_per_app` is a tracked column and the harness asserts it is `0`.

### 4.2 Concurrency and isolation — REWRITTEN (C9)

**Revision 1 said "one Chromium process, one persistent context, N pages — forced, not chosen".
That was wrong on both the forcing and the mitigation.** `browser.mjs:169-170` has a non-persistent
branch (`chromium.launch` + `browser.newContext()`) in the same function, and `boardKey`
(`automatability.mjs:126-138`) is **tenant**-scoped while cookies and `localStorage` are
**origin**-scoped — so "one in-flight job per `board_key`" permitted eight concurrent same-origin
tabs sharing one cookie jar and one storage area, which is precisely the hazard the sentence above
it named. The consequence is not theoretical: Greenhouse's embed flow holds upload and draft state
per origin, so one tab's résumé upload token is overwritable by another's, and the Coinbase
application goes out carrying the Tebra-tailored résumé, irreversibly, undetectably.

**The replacement:**

- **The in-flight exclusion key is the registrable origin of `apply_url`, not `board_key`.** At
  most one job in flight per origin, always. `auto_queue.origin` (Phase 1.1) carries it.
- **Cookie-free boards** — the §6.4 allowlist, chosen precisely because they need no session —
  launch **non-persistently**, one `browser.newContext()` per job. Genuine per-job storage
  isolation, no profile copy, no on-disk cookie exposure, using a branch that already exists.
  Concurrency is recovered **structurally** rather than by sharing state.
- **`AUTO_PROFILE` is reserved for boards that genuinely need a session**, capped at one job in
  flight per origin, and Chromium's own exclusive on-disk profile lock is the enforcement.
- The per-job **disposal** unit is the context (non-persistent lane) or the page (persistent lane),
  created and unconditionally closed per job. The **recovery** unit for a crash is the browser.
  **The run is never a recovery unit again.**

**N is a resource limit the user owns, never a volume limit.** Every queued job is still applied
to; only the rate at which work is driven is bounded.

**The N=8 knee is withdrawn as a proposal.** It was measured on a scan-only, loopback, zero-latency
workload with a per-job service time of 592ms — 76× shorter than an application — where the process
saturated at ~7.7 jobs/s. At ~45s per application, N=8 offers 0.178 jobs/s, roughly 43× less
pressure, so the real knee is almost certainly far above 8 and the resulting wall-clock estimate
was self-imposed rather than measured. §6.1 now proposes the **mechanism** and no number. Whatever
number is eventually proposed lands as a ledger entry with its command, both legs and its sha
(Phase 4.8) — the withdrawn one had none of the three.

### 4.2b Rate courtesy and arrival shaping — both bounded, both testable

Two things here are not volume limits, and each states the point at which it would become one so a
reader can check rather than trust.

**Per-vendor-edge spacing.** Submits to the same vendor edge shall be spaced. Lever's own
`postings-api` README documents 429 above **2 application POSTs/second** — a primary source, quoted
correctly. **Revision 1 said "seconds" with no number and called it "nearly free" without doing the
arithmetic.** The number and the crossover, stated: **spacing binds when
`spacing_s > per_app_seconds / concurrency`.** At ~45s and concurrency 8, arrivals at one edge are
one per 5.6s, so a 5s spacing is invisible and a 6s spacing is the binding constraint. **Proposed
value: 3s**, with `edge_spacing_wait_ms` as its own tracked column (Phase 4.7) so it is visible the
moment it starts costing throughput rather than inferred from a missing number. If concurrency
later rises, this number is re-derived from the formula, not defended.

**Arrival shaping across the day. NEW (review, accepted with a bound).** §6.3 already proposes
hourly resumable invocations. The queue shall drain **across the available slots** rather than at
first opportunity — the same daily total, arriving as a steady rate instead of a burst. The reason
is §2's corrected thesis: hundreds of submissions from one residential IP inside two hours is the
canonical mass-application fingerprint that v3-class scoring consumes, and the cost lands as
challenges and silent dismissals, i.e. as **lost applications**.

**The bound that keeps this from becoming a throttle, and it is not optional.** Shaping is bypassed
entirely — the queue drains at full rate — whenever a queued green lead is within 6h of its 24h
recency SLA (§4.7). **Total daily submissions are unchanged; no application is dropped, deferred or
carried to the next day by shaping.** The falsifiable check: a fixture run of 200 jobs with shaping
on and shaping off submits the **same 200**, and a run seeded with leads near their SLA boundary
submits them at full rate. If either check fails, the shaper is a cap and must be deleted.

### 4.2c The multi-page problem, and the module it costs — NEW (C7 resolution)

**The defect (`attack:correctness`, accepted).** C7/W3 requires a multi-page form's fields to be
resolved "before the first keystroke", but multi-page ATS forms only reveal page 2+ after page 1 is
filled and Next is clicked — and no module in §4.1 could click Next. `fill-engine.mjs:103-104` is
explicit and was endorsed by the same critic as a property to preserve verbatim: _"there is
deliberately no verb that clicks a button. 'Never click submit' is not a rule this engine follows —
it is a thing it cannot express."_ So revision 1's requirement was satisfiable **only** by deferring
every multi-page form — a volume loss dressed as a correctness win, with the CI gate's
`defer_rate + 2pp` as the only signal it had happened.

**The adjudication.** The critic offered two fixes; I take the first and **reject the second**.
Descoping multi-page boards removes real, winnable applications and hides the loss in the defer log
— which is exactly the move §1.2 forbids. So:

- `scripts/auto/advance.mjs` **shall** exist and export one function, `advanceOnce()`. It clicks a
  control **whose scanned role is `next`**, never `submit`, under the same origin binding and the
  same token discipline as `submitOnce`. It refuses if the scan offers no unambiguous `next`.
- **`fill-engine.mjs` is not touched.** Its inexpressibility property is preserved verbatim; the
  navigate verb lives outside it, in the auto path, where it is one small file with one function
  and a test asserting it never actuates a submit control.
- W3 resolves pages incrementally: fill page k, resolve page k+1's fields, and on any unresolvable
  field **abandon the draft explicitly** where the ATS supports it, rather than walking away.
- The §4.11 invariant becomes: `.click(` appears in `scripts/auto/` **only** in `submit.mjs` and
  `advance.mjs`, asserted by a test, with `advance.mjs` additionally asserted to refuse any control
  whose role is `submit`.

**Cost, stated:** one new module, one new test class, and one more place a click can occur — which
is a real widening of the surface this project has kept at zero, and it is why it is written down
here rather than absorbed into W3.

### 4.3 Run single-flight — DELETED (review, accepted)

**Revision 1 replaced the lockfile with "a heartbeat column on the `auto_runs` row", justified as
"a durable, restart-surviving fact rather than an mtime the OS can freeze". That is a
non-sequitur.** An mtime is also durable and restart-surviving. The defect in `lock.mjs` was never
durability — it was that **a frozen process cannot emit liveness**, and a `setInterval` writing a DB
column is frozen by suspend in exactly the same way `touch()` is. Revision 1 re-derived the failure
it had just diagnosed, in a new column. The pid-liveness probe that would distinguish suspended from
dead is deleted permanently and correctly (it fired 112/112) and shall never be reintroduced.

**Therefore run-level single-flight is deleted, not replaced.** The correctness boundary is already:

1. the **per-job claim** — `INSERT ... ON CONFLICT DO NOTHING`, 0 changes means not mine; and
2. the **`(slug, mode)`-keyed attempted row**, which refuses the loser of any race.

Profile exclusivity on the persistent lane is enforced by **Chromium's own on-disk profile lock** —
an OS lock, not an age heuristic. On the non-persistent lane there is no profile to protect.

**And the thing that would otherwise carry weight it cannot bear:** §4.5's stale-claim predicate is
also age-only and inherits the same flaw. It is safe **only** because the attempted-row insert
refuses the loser, and that is stated here explicitly rather than left implicit. `AUTO_RUN_LOCK` is
deleted (§5.2).

### 4.4 The per-job state machine

```
queued
  → claimed      (INSERT ... ON CONFLICT DO NOTHING; 0 changes ⇒ another worker owns it, return)
  → planned      (scan + fill-plan; plan_sha256 written)
  → authorized   (trust gate + authorizeSubmit token minted)
  → attempted    (durable (slug, mode) row written BEFORE the click)
  → submitted | challenged | deferred | failed
```

Every transition is a durable write. **Nothing may live in process memory across a job boundary
except what can be re-derived from the DB.**

### 4.5 Resumability

A run is a **cursor** over `auto_queue`. Resume-after-crash is
`SELECT ... WHERE state IN ('queued','claimed','planned','authorized')` with a stale-claim predicate
on `claimed_at` — safe only because of the attempted-row refusal (§4.3). There is no log replay:
nothing in the tree reads the JSONL for state, and nothing shall.

**Tokens are deliberately not resumed.** `liveNonces` is a process-local `Set`, so a restarted
invocation must re-mint every token, which re-reads STOP, caps, trust and `submitReadiness`. **That
is correct behaviour, not a defect to work around.**

A row in `attempted` at resume time is an **orphan** and goes to §4.9. It counts toward the company
cap. The presumption that "attempted counts as submitted" is **retained for the crash case**: the
crash window is the ~100-500ms between click-return and record, roughly 1% of a job, so a handful of
hard deaths per campaign yields well under one false attempt per 999 — while a duplicate application
is irreversible.

**But the presumption does not extend to `challenged` (C13).** A `bot-challenge` or
`email-code-challenge` outcome is **evidence the submission may not have landed**, not a crash
window. Those rows count toward caps (never under-count) and are reported as **unconfirmed, not
sent**, so the user is never told 400 went out when far fewer did.

### 4.6 Failure taxonomy, and the anomaly circuit breaker

Two disjoint categories. **The distinction is the whole design.**

**`deferred` — the machine did not understand something, or the environment declined. Not a
malfunction. Never trips a run STOP.** Kinds: `confirm-field`, `confirm-widget`, `consent-tickbox`,
`unknown-field`, `unprobed-dropdown`, `fill-failed`, `identity-verification`, `captcha`,
**`bot-challenge`** (C13), **`email-code-challenge`** (C13), `multipage-unresolvable`,
`freetext-disclosure`, `doc-unverified`, **`fact-base-changed`** (below), `board-untrusted`,
`l3-rejected`, `cap-company`, **`posting-gone`** (below), **`board-paused`** (below).

**`failed` — the machine malfunctioned.** Kinds: `nav-timeout`, `browser-crash`, `token-refused`,
`origin-mismatch`, `post-submit-unclassified`, `db-write-failed`, `plan-error`.

Each record carries `{kind, stage, board_key, origin, detail}` where `detail` is **sanitised**
(Phase 0.3). A deferral without a stated, actionable reason is a silent skip and a rule-6 violation.

**Three kinds added on review, each because it was being miscategorised as a malfunction:**

- **`bot-challenge` / `email-code-challenge` (C13, F6).** Greenhouse documents Invisible reCAPTCHA
  on integrations 1-4, analysing mouse and typing patterns, which may dismiss a submission or demand
  an emailed code. A Playwright fill emits near-zero input events, so this is the **board working as
  designed against automation**, and its incidence rises with N. Treating it as malfunction violates
  the plan's own N-invariance. Both feed the **correlated board pause**, never a run STOP.
- **`fact-base-changed`.** `auto_runs` already carries `profile_sha_start`/`profile_sha_end` because
  a mid-run edit is an alarm (`db.mjs:184-188`). Under Phase 1.3 a user answering a `save-answer.mjs`
  prompt at 21:40 during a long run invalidates **every** remaining verification at once, and
  revision 1 would have reported that as a large clean deferral bucket — telling the user the machine
  "understood less" when in fact they edited a file. **Specified behaviour:** finish the run against
  the snapshot in `profile_sha_start`, report the drift once, and re-verify affected documents in-run
  where Phase 3.4 has made `verify-claims` a cheap pure function.
- **`posting-gone`.** A 404 or a redirect to the jobs index between screening and submit is a routine
  event at hundreds of leads. Revision 1 had no kind for it, so it would have landed in
  `unclassified` and hard-STOPped the run.
- **`board-paused`.** Written to every job a pause strands, so the loss is in the taxonomy rather
  than sitting invisibly in `queued`.

**The breaker, re-specified (C2 and C13).**

_Immediate hard STOP — proof of a broken invariant, no rate needed:_

1. `submitReadiness` fails after a green classification;
2. a token is refused for `origin-mismatch`;
3. the durable `attempted` write fails after its bounded retry;
4. a post-submit page the classifier returns as **`unclassified`** — genuinely unrecognised, after
   `confirmation`, `identity-verification`, `bot-challenge`, `email-code-challenge`, `posting-gone`
   and `error` have all been ruled out.

**Revision 1's rule "the post-submit page is not a confirmation ⇒ hard STOP" is deleted.** It was
C2 one layer down: a single-sample rule whose trigger probability scales with N and with IP
concentration, so `P(at least one across hundreds of tenants) ≈ 1`. It would have fired on healthy
runs every night, and R-3's feared weakening of the single-sample proofs would then have been
inevitable. Fixing the taxonomy is the fix; loosening the proof is not.

_Correlated stop — N-invariant, never a count over the whole run:_

- **same signature twice consecutively** — identical `(kind, stage)` — pauses that **board**;
- **same `board_key` failing ≥3 of its last 5** pauses that **board**;
- **≥8 of the last 10 attempts across ≥2 distinct boards failed** stops the **run**.

**Added on review (`attack:feasibility`, accepted): retry, backoff, and re-admission.** Revision 1's
rule had none, and its N-invariance was argued from an _independent_ failure model while the rule's
fire rate is dominated by _correlated_ failures — `nav-timeout` and `browser-crash` cluster in time
by nature. A 20-second wifi drop at job 41 would have paused Greenhouse for the rest of a run
holding 900 Greenhouse leads, and reported outcome `ok`. So:

- **transient kinds (`nav-timeout`, `browser-crash`) get a bounded job-level retry with backoff
  _before_ they are eligible to count toward a signature;**
- **a pause is a timed backoff with probe re-admission** — one job; success clears it — **never
  terminal for the run**, and never persisted across invocations without re-probing;
- **paused boards and their held job counts are a first-class run outcome**, reported as a number,
  not as an absence.

**Measured behaviour of the replacement, from `attack:feasibility`'s simulation** (20,000 trials at
N=3, 2,000 at N=999, jobs distributed ≤5 per `board_key` to match `per_company_max_per_week`): the
run-level stop fires **0.00% at both N=3 and N=999 at p=5%**, and 0.45% at p=15%. The N-invariance
claim holds. The cost the simulation exposed and revision 1 could not see: ~2 boards pause per
999-job run at p=5%, stranding ~3 applications (**0.3%**); at p=15% it is ~16 boards and ~28
applications (**2.8%**). **Those numbers are stated here so a run exceeding them is detectable**,
and `p` itself becomes a tracked column (Phase 4.7) because the entire calibration rests on a number
nobody has measured.

**A run must never halt because one board is broken, and a healthy run of 999 must be no likelier to
halt than a healthy run of 3.** W4's check is exactly this.

### 4.7 Wall clock — no estimate, and why

**Revision 1's composite (999 × ~45s ÷ 8 ≈ 1.5-2h) is withdrawn, not revised.** Two things
invalidated it: C9 changed the isolation model the arithmetic assumed, and C11 established that the
fill leg — the largest term — has never been clocked through a real browser at all. The concurrency
divisor was itself transplanted from a workload 76× shorter (§4.2). **There is currently no
defensible wall-clock number in this document, and putting one here would repeat the exact failure
§0.1 exists to prevent.** Phase 0.9's B1 baseline and Phase 4.7's harness produce the first real one.

Known cost worth attacking once `--browser-fill` exists: 93% of the 14-combo per-application cost is
unconditional sleep, and reordering `plan.comboStrategies` to try `type-click` (conditional,
measured ~86ms) before `type-enter` (`page.waitForTimeout(500)`, `fill-engine.mjs:317`) is worth
~414ms per combo. It must land with a before/after **and** a real-DOM correctness check, budget
declared as "correctness-neutral or revert". Owner `w2-engine`; not on the runner's critical path.

**Recency SLA:** green-tier leads submitted within 24h of `posted_at`, reported per run and checkable
in SQL. This SLA is what bounds §4.2b's arrival shaping. Minutes-level continuous sweeping is **not**
built — the "apply within 10 minutes" evidence is 2018 folklore, several popular timing statistics
contradict each other, and burst speed increases pattern visibility for no evidenced gain.

### 4.8 The trust gate

**Does not exist.** `grep -rn "trust" scripts/auto/` returns nothing implementing it. It shall be
`scripts/auto/trust.mjs`, and it shall be **mechanical, never a model's impression of a page**. A
board is trusted iff **all** of:

1. the registrable domain of the **canonicalized** `apply_url` (Phase 0.13) is on the user's
   allowlist in `docs/application-limits.yaml` (user-owned; propose values, never edit);
2. an `apply/ats/` adapter matches that domain;
3. the lead cleared every screening stage L0-L3 with no `isDisqualifying` finding;
4. `apply_url` is `https`;
5. the origin of `apply_url` equals the origin recorded for the lead at screening time.

**Its header shall state its own limit, so the next author does not add a third pattern list.** Every
Greenhouse tenant is same-origin with every other Greenhouse tenant and with the cookie holding the
user's Greenhouse session (`ats/greenhouse.mjs:9` matches `(^|\.)greenhouse\.io`), and ATS tenancy is
self-service. So the allowlist answers _"is this the vendor's software"_ while the gate is asked _"is
this party safe to submit to unattended"_. **The allowlist can never be load-bearing against a
hostile tenant.** The two controls that survive that are structural: **carry no session cookie for
boards that do not need one** — which §4.2's non-persistent lane now makes an architectural fact
rather than a hope — and **never read anything back out of the page**, which is already true and must
stay true.

### 4.9 Reconciliation, and scoping the STOP blast radius

`assertNoOrphanAttempts` (worktree-only, `audit.mjs:189`, §0.2) raises STOP at `RUN_START` and
throws, halting **every future run** on a single unresolved attempt, clearable only by a human
deleting STOP — and nothing surfaces STOP to the user. Right at N=3, wrong at N=999 for the same
reason: the blast radius of the halt scaled and the trigger did not.

**Do not weaken the protection. Make it mechanically resolvable, and scope the halt.**

- `reconcile.mjs` **shall** re-open the orphan's `apply_url` in the appropriate context and read the
  board's already-applied or confirmation state, resolving the row to `submitted` or
  `reconciled-not-sent`. It never clicks a control.
- **REVISED (C-material, `attack:correctness`).** Revision 1 specified the resolution but not what it
  does to the row. Under a `(slug, mode)`-keyed claim with `DO NOTHING`, resolving to `failed` while
  leaving the attempted row in place means precondition 7 can never report 1 change again — that slug
  fails as `db-write-failed` every hour forever, and after two in a row the board pauses. The row
  **shall** be transitioned to a terminal outcome **`reconciled-not-sent`**, excluded from claim
  uniqueness and excluded from cap counting, in the **same transaction** that sets the queue state.
  **The critic's alternative — DELETE the row — is rejected:** `auto_submissions` is the store of
  record for what was aimed at an employer, and deleting evidence to unblock a retry is the exact
  shape rule 2 forbids for applications. A terminal outcome achieves the same unblocking and keeps
  the history.
- An orphan the reconciler cannot decide **shall** block **that company only** — the schema already
  carries `apply_url` and `confirmation_url` for exactly this — reported loudly via `INBOX.md` and
  `status.mjs`. Blocking one company preserves the real protection at 1/999th of the cost.
- **STOP's own blast radius, added on review.** Scoping the _orphan_ stop is not enough: any single
  hard-STOP input still halts every future hourly invocation until a human deletes a file — the same
  unbounded radius, moved from orphans to the classifier. **`raiseStop` shall carry a scope —
  `company | board | run | global` — and only the four §4.6 invariant breaches take `global`.**
  Everything else pauses what it has evidence about.

**Honest limit, and it is worse than revision 1 admitted (`attack:outside-reality`, accepted).**
Reconciliation by re-reading the board works only where the board exposes application state to a
candidate. On the recommended launch allowlist that is **close to none of it**: Lever and Ashby
hosted boards have no candidate login and expose no already-applied state (checked against Lever's
`postings-api` README and Ashby's docs; searches for candidate-visible application status returned
nothing), and Greenhouse exposes it only via a **MyGreenhouse account** — which requires exactly the
logged-in session §6.4 excluded as its structural security control. Revision 1's "honest limit"
paragraph admitted the dependency without noticing it covered ~100% of the launch surface.
**Therefore `reconcile.mjs` ships descoped to the boards that can answer, and §6.7 puts the
confirmation email — the only applicant-observable submission proof on these three boards — to the
user as a consent decision.** Where neither is available, a human adjudicates **one slug**, not a
run, and `status.mjs` says so by name.

### 4.10 `submitOnce()` — the only function permitted to contain a submit click

`scripts/auto/submit.mjs` exports exactly one function. **No other file in `scripts/auto/` may
contain a submit click, and `advance.mjs` (§4.2c) may click only a `next`-role control. A test
asserts both** (§4.11).

```
submitOnce(page, { token, slug, planSha, mode, pageUrl, queueRow }) → { outcome, confirmationUrl }
```

It **shall** refuse, throwing before any interaction, unless **every one** of these holds:

1. `token` is a submit token minted by `authorizeSubmit()` **in this process**, and its nonce is live
   (single-use; a resumed invocation must re-mint, which re-reads STOP, caps and trust);
2. `token.slug === slug`;
3. `token.planSha === planSha`, and `planSha` is the sha256 of the plan actually about to be
   submitted;
4. `token.mode === mode`;
5. **`new URL(pageUrl).origin === new URL(token.apply_url).origin`** — Phase 0.1. Without this an
   attacker-controlled redirect moves the browser to another origin and the token is still spendable
   there;
6. `queueRow.state === 'authorized'` and the row is claimed by this worker;
7. **the `auto_submissions` insert keyed `(slug, mode)` with `outcome='attempted'` reported 1
   change** — the durable record exists **before** the click, not after. **(C8: the key includes
   `mode`, so a dry-run rehearsal cannot consume the live claim.)**
8. `plan.defer` is empty, `submitReadiness` is true, and no plan item or defer entry carries a
   `labelFlag`;
9. STOP is not set at `global` or at this job's `board`/`company` scope;
10. the board passes `trust.mjs`, and the lead carries no L3 rejection;
11. the document has a passing verification row matching both `doc_sha256` and `profile_sha256`, and
    the user approved it.

If `mode !== 'live'` it returns **after every check above** without clicking. Dry run exercises the
whole gate; that is the point of it — **and it is also why W2 exists, because dry run exercises
nothing after it** (C10).

**Rationale for item 7, restated against the tree that will exist (§0.2).** Revision 1 argued this
against `preSubmitCheck`, which exists at `fa192a1:240` and has **already been deleted** by the
in-flight wave. The correct standing rationale is the schema's own: `db.mjs` states _"The outcome
column exists because the row is written BEFORE the click, not after it"_ and _"An attempt is a
submission until proven otherwise."_ Item 7 makes that comment enforceable by making the write a
**precondition** rather than an epilogue — the only control in the design a crash or a claim-race
cannot walk past.

After the click it navigates and classifies the resulting page with `classify.mjs`, a **pure typed
function over `(url, html)`** returning
`confirmation | identity-verification | bot-challenge | email-code-challenge | posting-gone | error |
unclassified`, writes `confirmation_url`, and transitions the queue row. Only `unclassified` is a
hard STOP (§4.6). No model is involved at any point, and nothing is read back out of the page for a
_decision_ other than this classification.

**The classifier's corpus is the gating artifact, and it has a source that does not require
submitting.** The user is on the submit button for every application today; attended applies
**shall** capture the post-submit page into the corpus. Phase 5 W2 is gated on that corpus existing.

### 4.11 What must be true of the runner, as tests

Owned by `w4-autonomy` (`tests/auto/` is theirs), cross-checked by `qa-adversary`:

1. `grep -rn "\.click(" scripts/auto/` returns lines only in `submit.mjs` and `advance.mjs` —
   asserted by a test, not by a habit — and `advance.mjs` refuses any control whose scanned role is
   `submit`.
2. Each of the 11 preconditions above, one test per precondition, each asserting the click did not
   happen.
3. `SIGKILL` at each of the 8 queue states leaves a resumable DB and never a duplicate, **including a
   kill between click-return and the acknowledgement write, resolved by `reconcile.mjs` without a
   human** (C10).
4. One req cross-listed in multiple cities/boards resolves to **exactly one** application. This
   exercises `dedupeLeads` (`find-jobs.mjs:515`), `cluster.mjs` and `repostSightings` together. The
   defences exist and have **never once been exercised by an unattended runner**; the comparable
   failure — Sonara sending 15+ applications to one job — is the most reputation-destroying on
   record. Owner `w5-leads`.
5. A board failing every job pauses that board, strands its jobs **with `board-paused` written**, and
   does not stop the run; a probe re-admission clears it (W4).
6. `model_turns === 0` (**observed, not derived** — Phase 4.7) and `spawns_per_app === 0` on every
   green-tier application.
7. **Two concurrent jobs on the same origin cannot observe each other's cookies or `localStorage`**
   (C9). This is the test revision 1 had no reason to write and most needed.
8. A `dry_run` row for a slug does not prevent a later `live` attempt on that slug; a second `live`
   attempt is refused (C8).

---

## 5. What we are deleting

### 5.1 From the plan

| Deleted                                                                            | Reason                                                                                  |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| §3.5's premise, "the runner cannot tailor"                                         | False. C1.                                                                              |
| The count-based circuit breaker                                                    | Arithmetically a volume throttle at N=999 (median halt job 292). C2.                    |
| `-ExecutionTimeLimit 01:00` and one-invocation-is-one-campaign                     | Cannot fit the requirement; a longer limit covers one of three interruption causes. C3. |
| The 26h recency heartbeat as the health signal                                     | Never built, and the wrong statistic once runs are resumable. C4.                       |
| R6 (split `CLAUDE.md`) from this critical path                                     | The runner has no model in it. C5.                                                      |
| "Half-filled applications are an accepted cost"                                    | The one reputational cost that scales with volume, arriving through the defer path. C7. |
| **Revision 1's `PRIMARY KEY (slug)` claim**                                        | Dry-run rows would have pre-consumed the live claim forever. C8.                        |
| **Revision 1's "one persistent context is forced" and its `board_key` mitigation** | The branch exists; the key is tenant-scoped and the hazard is origin-scoped. C9.        |
| **Revision 1's all-dry-run validation ladder**                                     | Never exercised the post-click path before a real employer did. C10.                    |
| **Revision 1's Phase-4 placement of the fill harness**                             | Baseline would have absorbed five un-budgeted fill-path changes. C11.                   |
| **Revision 1's non-gating, target-free supply check**                              | The arithmetic misses by an order of magnitude and nothing could have said so. C12.     |
| **Revision 1's "post-submit page is not a confirmation ⇒ hard STOP"**              | Expected environmental outcome on the launch board, with probability rising in N. C13.  |
| **Revision 1's heartbeat single-flight**                                           | A non-sequitur that re-derives the frozen-process failure in a new column. §4.3.        |
| **Revision 1's wall-clock composite**                                              | Its isolation model and its divisor were both invalidated. §4.7.                        |
| **Revision 1's §6.1 concurrency proposal of 8**                                    | Transplanted from a workload 76× shorter and presented to the user as measured. §6.1.   |

### 5.2 From the codebase

| Deleted                                                                         | Where                        | Reason                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTO_RUN_LOCK`                                                                 | `lock.mjs:176`               | Zero callers (verified) **and the wrong shape** — a single global run mutex is what a worker pool must not have. Leaving it invites someone to "complete" it into the thing that caps concurrency at 1. Extends R8. |
| The file-existence `hasVerifiedResume` block                                    | `automatability.mjs:454-473` | Makes any `resume.md` on disk green, verified or not. A rule-1 hole reachable by accident, on the auto path.                                                                                                        |
| `auto_runs`' `planned` / `deferred` / `failed` counters                         | `db.mjs:189-204`             | Counters with no rows behind them — a database with no source of truth. Derived from `auto_queue`.                                                                                                                  |
| `auto_submissions` `PRIMARY KEY (run_id, slug)` and its `ON CONFLICT DO UPDATE` | `db.mjs:232-246`, `785-813`  | Backwards for a row whose job is to be a claim. Replaced by `(slug, mode)` + `DO NOTHING`.                                                                                                                          |
| `auth-sync`'s `SKIP_DIRS` denylist                                              | `auth-sync.mjs:119-141`      | An allowlist costs the same and removes the class.                                                                                                                                                                  |
| The dead consent-allowlist grant branch                                         | in flight                    | Already landing. Dead code is a lie about intent.                                                                                                                                                                   |

### 5.3 Never build

- **LinkedIn Easy Apply submission.** The one vector that demonstrably gets comparable tools' users
  restricted, and LinkedIn's ToS prohibits automated systems simulating human activity. This
  pipeline's direct-to-ATS architecture structurally avoids it. If LinkedIn is ever used, discovery
  only.
- **Internal-endpoint replay** for Greenhouse/Ashby/Lever. Not a documented API; it bypasses the
  vendor's client-side integrity signals. **Strengthened on review:** Greenhouse's submit path
  carries a reCAPTCHA token, so replay without the browser trips exactly the integrity signal this
  entry predicted. Recruitee's documented lane is the clean version of the same idea.
- **Model resolution of `UNKNOWN` fields on the unattended path.** Written into rule 6 by Phase 2.4.
- **Human-pacing theatrics** (randomised typing speed, mouse jitter). **CORRECTION (review,
  accepted): revision 1's stated basis for this was factually false.** It claimed typing-speed
  detection claims "come exclusively from competing auto-apply vendors' blogs, with no
  vendor-primary source" — but Greenhouse's own support documentation says its bot detection analyses
  "mouse movements and typing patterns" on the flagship launch board. **The decision stands on
  correct grounds:** jitter theatrics are unlikely to beat v3-class scoring whose dominant inputs are
  IP reputation, Google cookies and event-stream absence, and building on a defeated countermeasure
  is worse than not building. Detection is handled as a **measured per-board incidence** (Phase 4.4),
  not as a nonexistent threat. Left uncorrected, this entry would have been cited in six months as
  evidence that behavioural detection does not exist on the boards we submit to.
- **Email plus-aliasing or any identity variation.** Fragments the candidate across Workday profiles
  and intersects Real Talent's email-domain screening.
- **Minutes-level continuous sweep.** §4.7.

---

## 6. Open questions for the user

Seven decisions that are genuinely yours. Each is a concrete choice with a recommendation and the
consequence of each option. **None of these edit your files; they propose values.**

### 6.0 — ANSWERED by the user, 2026-08-01. Three of the seven are settled.

Recorded by `build-manager` at the moment they were given, because a decision that lives only in
a chat transcript is re-litigated by the next session that cannot see it. **Do not reopen these.**

- **6.2 Résumé register — ACCEPTED, deterministic assembly.** The user chose plain deterministic
  assembly, **not** the variant that retains model rephrasing for attended sessions. So the
  register decision is uniform across both paths: tailored documents are composed of the user's
  own approved sentences, verbatim, selected and ordered for the posting. This makes Phase 3
  load-bearing rather than optional — it is now the thing that lifts the document-path cap, and
  §2's first binding constraint is scheduled to be removed rather than lived with.
  **One action is the user's alone and blocks nothing else:** if `profile.yaml` bullets turn out
  to be note-shaped rather than résumé-shaped, they need a one-time editing pass **by the user**.
  Hard rule 2 means no agent may make it. Phase 3 must therefore **measure and report** the
  shape of the existing bullets before it assumes they are usable, and say plainly which ones
  are not.
- **6.3 Scheduling — ACCEPTED as recommended.** Hourly resumable invocations against a durable
  queue, `-ExecutionTimeLimit 04:00`, `-StartWhenAvailable`, **no run-level lock** (§4.3; per-job
  claims are the correctness boundary). The 1h single-campaign shape and its ~60-90 application
  ceiling are struck. `register-task.ps1` is still **run once by the user** — creating a standing
  scheduled task is theirs to authorise, and that has not changed.
- **6.7 Confirmation mail — ACCEPTED, scoped and revocable.** Read access limited to confirmation
  mail. This makes §4.9's reconciler viable on Lever and Ashby, gives C13's silent-dismissal
  detection an applicant-observable signal, and unblocks the Phase 6.6 outcome loop.
  **Three constraints follow and are not optional.** First, hard rule 0 applies at full force to
  mailbox content — a confirmation email is third-party text and an attacker can send one; it is
  evidence about **delivery**, never an instruction, and never a fact about the user.
  Second, it is read-only: nothing in this project sends, replies to, deletes or files mail.
  Third, the scope is confirmation mail and nothing else; the design must fail closed if it
  cannot restrict itself, and the user must be able to revoke it without touching this codebase.

**Still open: 6.1 (concurrency — deliberately unproposed until Phase 4.7 measures the fill leg),
6.4 (allowlist and whether to fund canonicalization), 6.5 (backup cadence), 6.6 (Recruitee lane).**

**6.1 — Concurrency. NO NUMBER IS PROPOSED YET, and revision 1's was withdrawn.**
_Recommendation:_ add the **mechanism** — `auto_apply.concurrency`, a resource limit, not a volume
limit — and leave the value unset until Phase 4.7 measures the fill leg.
_Consequence:_ revision 1 proposed 8 on a scan-only, loopback, zero-latency measurement where each
job took 592ms; a real application is ~76× longer and overwhelmingly wait rather than CPU, so the
real knee is probably far above 8. Proposing 8 now and revising it later would mean re-opening a
decision that was presented to you as measured, on a file only you may edit. Whatever number is
eventually proposed will arrive with its command, its legs and its sha in `docs/measurements.md`.
**Either way, every queued job is still applied to.**

**6.2 — The résumé register.** Deterministic assembly (Phase 3) means your tailored résumé is
composed of **your own approved sentences, verbatim**, selected and ordered for the posting — rather
than a model's rephrasing of them.
_Recommendation:_ accept. Keep model rephrasing available in attended sessions as an optional,
re-verified step.
_Consequence:_ accepting makes the whole pipeline unattended and removes the only operation that can
introduce an untrue claim; the cost is that documents read in your voice rather than the posting's.
Declining keeps the current register and **caps applications at what a supervised model batch
produces**. If your `profile.yaml` bullets are note-shaped rather than résumé-shaped, this needs a
one-time editing pass **by you** (rule 2 — the agent cannot do it).

**6.3 — Scheduling shape.** Replace the single 1h campaign with hourly resumable invocations against
a durable queue.
_Recommendation:_ `-ExecutionTimeLimit 04:00`, hourly, `-StartWhenAvailable`, **no run-level lock**
(§4.3 — per-job claims are the correctness boundary).
_Consequence:_ a run interrupted by sleep, crash or a scheduler kill resumes where it stopped instead
of restarting or stalling. Keeping the 1h limit caps a campaign at roughly 60-90 applications
regardless of what the queue holds. This is also the substrate §4.2b's arrival shaping uses.

**6.4 — The trust-gate allowlist. REVISED with measured numbers.**
_Recommendation:_ start with `greenhouse.io`, `ashbyhq.com`, `lever.co` — public forms, no login, no
account creation — **and fund Phase 0.13's canonicalization**, which is where the volume actually is.
_Consequence:_ **revision 1 claimed these three cover "the majority of current leads". Measured, they
do not: 55/141 = 39%** (greenhouse 34, ashby 17, lever 4). Another **47/141 are `adzuna.com`
aggregator URLs and 10 are `coinbase.com`** — an embedded careers page whose underlying ATS is not
the recorded registrable domain — and the gate as specified rejects all 57 even where the underlying
form is Greenhouse. Without canonicalization, expanding supply will look like a supply problem when
it is a URL-resolution problem. Including gated boards (Workday, Oracle, SuccessFactors) means
carrying a live candidate account into unattended browsing for a small tail, and it forfeits the
no-session-cookie control that §4.2's non-persistent lane is built on.

**6.5 — `leads.db` backup cadence.** `jobs/leads.db` is the store of record and the `documents` table
has **no on-disk source** — `migrate.mjs` rebuilds every other table and never that one.
_Recommendation:_ a copy before each run plus a daily copy to a path you choose, retained 14 days —
**priced against Phase 1.8's 30-day size projection, not against today's file.** Hourly invocations
(§6.3) mean "before each run" is hourly, and `auto_submissions.doc` holds screenshots.
_Consequence:_ without it, one corrupt file loses your whole application history — which is precisely
what Sonara's shutdown did to its users.

**6.6 — The Recruitee no-browser lane.** Recruitee documents an unauthenticated, candidate-intended
submit endpoint — verified 2026-08-01, and the only one of its kind across six ATSes surveyed
(SmartRecruiters documents a public Application API but it is customer-token-gated and therefore not
candidate-usable).
_Recommendation:_ yes, but after Phase 5 W4, and only once `w5-leads` has added Recruitee boards —
**there are zero Recruitee leads today** (measured).
_Consequence:_ it gives the runner a second lane shape to be generic over, removes the browser from
the critical path for one board family, and is the only lane with zero bot-scoring exposure.

**6.7 — NEW. May the agent read your mailbox for confirmation emails?**
_What it solves, all three at once:_ (a) §4.9 reconciliation on Lever and Ashby, which expose no
candidate-visible application state at all, so the reconciler is otherwise dead code on two of your
three launch boards; (b) detection of reCAPTCHA **silent dismissals** (C13) — the confirmation email
is the only applicant-observable proof a submission was actually accepted; (c) the outcome-recording
bottleneck this plan names in Phase 6.6 and cannot otherwise solve at volume.
_Recommendation:_ decide this before Phase 5 W4, because §4.9's descoping depends on the answer.
_Consequence:_ declining is entirely reasonable — it is your mailbox — and the cost is that orphans on
Lever and Ashby are adjudicated by you, one company at a time, and that a silently dismissed
submission is recorded as `challenged`/unconfirmed rather than resolved. Accepting means read access
scoped to confirmation mail, and it should be scoped and revocable.

---

## 7. Risks, ranked

**R-1 — The user's real `profile.yaml` bullets are not résumé-shaped, and Phase 3 stalls.** Phase 3
rests on a file I have not read and cannot read. _Mitigation:_ `w6-documents` runs the assembler
against the real fact base **as the first task of Phase 3**, before writing selection logic, and
reports the gap as a list of bullets needing the user's edit. **Owner: `w6-documents`; the edit is
the user's.**

**R-2 — A systematically wrong answer goes out hundreds of times.** _Mitigation:_ Phase 2 is a
shipping prerequisite, with the ≥12-pair polarity corpus as its gate; typed intents defer rather than
invert. **Owner: `w3-resolution`; gate `qa-breaker`.**

**R-3 — The breaker halts healthy runs, and the response is to weaken it.** _Mitigation:_ §4.6's
correlation keying is N-invariant (simulated: 0.00% run-stop at both N=3 and N=999 at p=5%), the
remaining single-sample proofs are invariant breaches rather than environmental outcomes (C13), and
transient kinds now retry before they can count. **Owner: `w4-autonomy`; verified by
`innov-resilience`.** _Residual, now quantified:_ board pauses strand ~0.3% of applications at p=5%
and ~2.8% at p=15%, and **`p` has never been measured** — Phase 4.7 tracks it.

**R-4 — A duplicate application to one cross-listed req.** _Mitigation:_ §4.11 test 4, on a
multi-location fixture, before the runner goes live. **Owner: `w5-leads`.**

**R-5 — The user's saved passwords and payment cards sit in the profile that visits hundreds of
third-party pages.** _Mitigation:_ Phase 0.4's allowlist, **and** §4.2's non-persistent lane, which
means the recommended launch boards touch no user profile at all. **Owner: `w4-autonomy`.**

**R-6 — Attacker text reaches a model through the deferral report.** The first convenience feature
that breaks rule 0 unattended is named and not hypothetical: _"summarise last night's run."_
_Mitigation:_ Phase 0.3 sanitises before the string is written. **Owner: `w4-autonomy`; corpus
`w1-security`.**

**R-7 — A silent STOP blocks every future run and nobody sees it.** _Mitigation:_ Phase 4.2 and 4.3,
plus §4.9's **scoped** `raiseStop` — only the four invariant breaches take `global`. **Owner:
`w4-autonomy` and the `status.mjs` owner per §0.3.**

**R-8 — Lead supply never reaches the volume the runner can handle. PROMOTED: this is now the most
likely reason the requirement is missed.** 141 leads lifetime, 82.3% dismissed; the measured
per-board yield implies an achievable ceiling closer to ~100 applications/day than 999 even after
board expansion (C12). _Mitigation:_ **Phase 0.11 measures it before six phases are built on an
assumption about it**, Phase 0.12 measures what fraction of real forms can reach green at all, Phase
0.13 recovers the 40% of leads currently lost to aggregator and embedded URLs, and Phase 6.1 gets a
numeric completion criterion. **Owner: `w5-leads`.** _Accepted:_ the runner will be idle-capable
before supply catches up, and that is the correct order.

**R-9 — Silent quality-tiering by the employer side, and challenge incidence rising with volume.**
_Mitigation:_ the fact-grounded, per-posting-tailored document is exactly what survives a
quality-scoring inbox — that is the thesis, not a hedge — plus Phase 4.4's challenge incidence as the
applicant-observable proxy, Phase 0.7's identity-field invariance, and §4.2b's arrival shaping
bounded by the recency SLA. **Owner: `w3-resolution`, `w4-autonomy`, `researcher`.** _Unresolved and
honest:_ whether Real Talent aggregates spam signals **across** customers is not answered by any
public document. Nobody should claim it is settled.

**R-10 — ~50 half-filled applications sit under the user's name.** _Mitigation:_ §4.2c's navigate
verb plus explicit draft abandonment in W3 — **not** by deferring every multi-page form, which would
have been a volume loss dressed as a correctness win. **Owner: `w3-resolution`, `w2-engine`.**

**R-11 — Ashby and Lever remain unmeasurable.** `bench-apply --board ashby` dies at
`bench-apply.mjs:1215`; all fixture scans are greenhouse- or shape-derived. Ashby's nonce CSP and
700ms remount is the worst latency case the runner will meet. _Mitigation:_ Phase 0.10, now **before**
anything touches the fill path. **Owner: `qa-adversary`.**

**R-12 — A runner baseline is frozen against a broken measurement.** Today's greenhouse browser run
reports `fill_report ok:2 failed:1 deferred:3` — the fill aborted — and the harness passes; `--gate`
still charges +4 model turns when the ruling was +1. _Mitigation:_ M6 and M2 fixed in Phase 0.9,
**before any fill-path change lands, not merely before the runner baseline** (C11). **Owner:
`qa-breaker`; ledger `innov-perf`.**

**R-13 — NEW. Cross-tenant state leakage between concurrent tabs sends the wrong document.** The
failure C9 describes is silent, irreversible, and invisible to a design that never reads anything back
out of the page. _Mitigation:_ origin-scoped exclusion, per-job contexts on the cookie-free lane, and
§4.11 test 7 — the isolation regression test. **Owner: `w4-autonomy`, `w2-engine`.**

**R-14 — NEW. The classifier corpus is thin and the first live night is where it is tested.** W2
reduces this to "thin corpus" from "no corpus", but a corpus assembled from attended applies will
under-represent tenant-configured strictness variants. _Mitigation:_ `unclassified` is the one
remaining hard STOP precisely because an unrecognised page is the case that must stop; every
classification is recorded so the corpus grows from real runs. **Owner: `w4-autonomy`;
`qa-adversary` cross-checks.**

---

## 8. What is still off

`docs/application-limits.yaml` ships `auto_apply.enabled: false, dry_run: true`. It is the user's
file; this plan proposes values in §6 and edits nothing.

**The invariant to check is not which files are present but this: nothing in this repository opens a
browser unattended, and nothing on the auto path contains a click.** It is true at `fa192a1` and in
the current working tree — `grep -rn "\.click(" scripts/ --include=*.mjs` returns only
`fill-engine.mjs`, `scan-engine.mjs` and `bench-apply.mjs`, re-verified this pass — and it stays true
until Phase 5 W1 lands `scripts/auto/submit.mjs` and §4.2c lands `scripts/auto/advance.mjs`. Guards
existing is not the capability existing.

**And one thing the enable decision must be told, added on review:** `dry_run` **structurally cannot
observe** challenge incidence, silent dismissal, per-IP reputation effects or confirmation-email
delivery, because it never clicks. A clean dry-run report is evidence that the machine's internal
contracts hold. It is not evidence about the external world, and the first live night is the first
measurement of that dimension — which is why those columns are first-class in the live run report
from night one (Phase 5), and why W2 exists so that at least the _code path_ has run before an
employer sees it.

Until the runner ships **and** the user enables it, the user is on the submit button for every
application. That is the operative rule today, not a preference.
