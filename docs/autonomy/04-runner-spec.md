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
