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
kept, not merged away, so the wrong reasoning stays legible.

**EXISTS — the pointers are placed** (`doc-scribe`, 2026-08-01). ``grep -c 'autonomy-plan-v2.md` §1.4' docs/autonomy-plan.md``
returns `9`: **eight** inline `> **Superseded …**` blocks — one per correction C1-C7, plus a second
C4 pointer at risk item 6 under §"Risks, ranked", which asserted the 26h heartbeat as an existing
control in a second place a reader can reach without passing the first — and **one** banner under
the title saying the document is v1. (A tenth `Superseded` marker in `autonomy-plan.md`, the one
dated 2026-07-31, is `innov-resilience`'s and is unrelated to C1-C7.) **C8-C13 are
deliberately not marked in `autonomy-plan.md`** — they correct revision 1 of _this_ document, and
marking them there would attribute revision 1's errors to v1.

**C1 — `autonomy-plan.md` §3.5, "The honest limitation", is wrong.**
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
Worse, the same comment block warns that caps count dry-run rows **on purpose** (`db.mjs`, the
comment above `companySubmissionBreakdown`), so a 999-job rehearsal against the real DB would
exhaust `per_day_max` and
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
**Replaced by:** Phase **0.11** — one sweep, owned by `implementer`, reporting qualifying leads per
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
