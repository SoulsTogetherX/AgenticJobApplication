# Measurement ledger

Owned by `innov-perf`. **Append-only** — never rewrite history; a dip that got
fixed should stay visible.

One hard rule: **no performance change merges without a before/after
measurement.** This exists because an audit found ~24 seconds of
`waitForTimeout` in the apply path that everyone had assumed was network time.
Assumption is the failure mode.

## How to read an entry

- **budget** — what the owning worker declared **before** starting. Some changes
  are meant to cost time (sanitising at ingest; a state machine before its
  batching lands). A change is judged against **its declared budget, not against
  zero**. "none declared" is recorded as-is and never invented retroactively.
- **numbers** — reported in three separate columns. A model turn costs seconds
  and a Node call costs milliseconds; collapsing them hides the largest term.
- **inconclusive** is a legitimate verdict. Two samples are not a trend.

## Measuring honestly

Same machine, same fixture, warm and cold runs distinguished. **Never measure
against a live employer's board** — use the local fake board under
`tests/fixtures/boards/`. Live boards vary and you would be measuring their
weather.

## Entry template

```
## <id> — <what changed>
- agent:    <owning agent>
- harness:  <exact command, copy-pasteable>
- baseline: <sha> — round_trips=<n> sleep_ms=<n> model_turns=<n> wall_ms=<n>
- after:    <sha> — round_trips=<n> sleep_ms=<n> model_turns=<n> wall_ms=<n>
- budget:   <declared up front, or "none declared">
- verdict:  improved | within budget | REGRESSION | inconclusive
- note:     <= 40 words
```

## Regression protocol

When a number moves the wrong way beyond its declared budget, `innov-perf`
files it against the sha and asks the owning worker one question: _is this the
expected mid-flight cost of an unfinished change, or a real regression?_

1. **Work in progress** → the worker names the commit where it should recover;
   re-measure there. This answer cannot be used twice for the same change.
2. **Real regression, fix known** → fix forward. Both numbers stay in the
   ledger so the dip is visible rather than erased.
3. **Real regression, no fix in hand** → request rollback. The manager reverts;
   the work returns to planning **with the ledger entry attached**, so the next
   attempt does not blindly retry the approach that just failed.
4. **Disagreement** → a second innovator with a different lens breaks the tie.

**Correctness outranks speed.** A declared security cost is never rolled back on
performance grounds alone.

---

## Baselines

### B0 — pre-autonomy baseline

- sha: `d7fc28d` (tag `baseline-pre-autonomy`)
- suite: **639 tests, 0 failures, 37.6s** (`npm test`)
- apply path: not yet instrumented — `qa-breaker` captures the first real
  numbers with `scripts/dev/bench-apply.mjs` before `w2-engine` or
  `w3-resolution` change anything.

Audit estimates to reproduce or refute (these are **estimates**, not
measurements, and become numbers only once the harness exists):

| Quantity                            | Estimate                        |
| ----------------------------------- | ------------------------------- |
| Scan probe sleep                    | ~9.1s (380ms × ≤24 dropdowns)   |
| Fill sleep, 14-combo form           | ~17s                            |
| Cover letter into `contenteditable` | up to 45s (15ms/char, uncapped) |
| Browser round trips per page        | 4                               |
| Model turns per page                | ~12                             |

---

## Standing caveats — read before quoting any number below

1. **The tree is shared and moves under a measurement.** Every entry records the
   sha AND the dirty state of `MEASURED_FILES` (`bench-apply.mjs:1617`) at run
   time, because a sha alone is not provenance during a wave. M2 below was taken
   twice, at two different shas, for exactly this reason.
2. **`round_trips` and `model_turns` are DERIVED, not clocked** — computed from
   `bench-apply.mjs`'s `PROTOCOL` list plus this run's own plan output. They are
   deterministic. `--runs 7` therefore gives **one** sample of those two columns
   repeated seven times, not seven samples. Only `wall_ms` and the leg timings
   vary across runs. Do not read a repetition count as variance control on a
   derived column.
3. **A derived column is only as good as its citations**, and as of 2026-07-31
   eleven of the fifteen were stale — see M4.

---

## Entries

## M1 — harness defect: the class gate had never once run

- agent: `qa-breaker` (owns `scripts/dev/bench-apply.mjs`)
- harness: `node scripts/dev/bench-apply.mjs --gate --runs 7`
- baseline: n/a — this entry records an INVALIDATION, not a change
- after: `64ff80d` — gate now reachable; `gate-confirm` yields `confirm=1`
- budget: none declared (a harness fix, not a product change)
- verdict: **inconclusive → prior numbers withdrawn**
- note: `writeBenchAnswers` emitted ids `bench-001`; `resolveFields` only
  classifies a source matching `fill-plan.mjs`'s
  `BANK_ID_RE = /^(a-\d+)@/`. A `CONFIRM` was structurally
  unreachable, so the pre-existing class gate measured as free
  **because it never ran**.

**What this invalidates.** Every apply-path latency number taken before `64ff80d`
that touched the answer bank. Not "suspect pending recheck" — _withdrawn_. A
harness that cannot reproduce a gate is not evidence the gate is cheap, and the
zero it printed was the shape of a working measurement. Cited here so no later
entry can quietly rest on one.

Verified independently: `writeBenchAnswers` now bases ids at `a-900`
(`bench-apply.mjs:794`), and `gate-confirm` reports `confirm=1` in both runs
below. Method: read the diff at `64ff80d`, then ran the matrix twice.

## M2 — value-carrying-act rule: does a required confirm-widget cost +1 turn or +4?

- agent: `w3-resolution` (rule), `qa-breaker` (refutation), `innov-perf` (ruling)
- harness: `node scripts/dev/bench-apply.mjs --gate --runs 7`
- baseline: `gate-select` — round_trips=4 sleep_ms=450 model_turns=6 ready=true
- after: `gate-radio-req` — round_trips=4 sleep_ms=450 model_turns=10 ready=false
- budget: **none declared.** No worker stated a turn budget before the work;
  the "+1 turn" figure was a claim made about the change, not a budget
  set ahead of it. Not invented retroactively here.
- verdict: **REGRESSION against the claim, WITHIN BUDGET against the rule**
- rollback: **not requested.** Correctness outranks speed, and this is a
  correctness rule (34 fields auto-ticked before it, 0 after).

Runs, both reproduced by `innov-perf` from scratch:

| run | sha       | dirty `MEASURED_FILES`        | `--runs` | result        |
| --- | --------- | ----------------------------- | -------- | ------------- |
| 1   | `64ff80d` | 4 (`fill-plan.mjs` **clean**) | 7        | matrix below  |
| 2   | `fc05da5` | 5 (`fill-plan.mjs` **dirty**) | 3        | **identical** |

| row            | ready | c/w/wreq/cons | trips | sleep | turns | vs baseline |
| -------------- | ----- | ------------- | ----- | ----- | ----- | ----------- |
| greenhouse-p1  | false | 1/0/0/0       | 5     | 450   | 12    | —           |
| greenhouse-p2  | false | 0/1/0/1       | 3     | 450   | 11    | —           |
| gate-base      | true  | 0/0/0/0       | 4     | 450   | 6     | —           |
| gate-select    | true  | 0/0/0/0       | 4     | 450   | 6     | 0/0/0       |
| gate-radio-opt | true  | 0/1/0/0       | 4     | 450   | 6     | 0/0/0       |
| gate-radio-req | false | 0/1/1/0       | 4     | 450   | 10    | 0/0/**+4**  |
| gate-confirm   | false | 1/0/0/0       | 4     | 450   | 10    | 0/0/**+4**  |

**Which column is at which sha.** `round_trips` and `model_turns` derive from
`PROTOCOL` plus `fill-plan.mjs`'s output; in run 1 `fill-plan.mjs` was clean, so
those two columns ARE `64ff80d` numbers. `sleep_ms` comes from the scan and fill
engines, all of which were dirty in both runs — **the 450ms figure is not a
`64ff80d` number** and must not be cited as one.

### Ruling: 1 of the 4 added turns belongs to this rule. 3 do not.

`qa-breaker` asked which steps are genuinely required when the only defer is a
`confirm-widget` on a required field needing no new information. Taken one at a
time, against `SKILL.md` as it stands today:

| step                  | required?            | governing text                                                                                                                                                                                                                                    |
| --------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `approval-message`    | **YES**              | `SKILL.md:294` — "Surface these in the approval message with the value the bank resolved, so the user is ticking with the answer in front of them." The rule names its own cost. A message that ends in a wait is a real turn.                    |
| `fill-plan-again`     | **NO**               | `SKILL.md:272` conditions the re-run on "**after rendering PDFs and saving any new answers**". Neither happens: `needsRender=false`, `unknownDefers=0`. The harness predicate is `!c.ready`, which is strictly wider than the skill's.            |
| `decide-cover-letter` | **NO**               | `SKILL.md:173` labels step C "**(0 calls)**". A zero-call, non-terminal reasoning step folds into the next tool call's turn. It is the only such step in `PROTOCOL`, and charging it a turn inflates every `ready=false` row, not just these two. |
| `reuse-check`         | **NO, on this path** | `SKILL.md:187` scopes it to deciding whether to re-tailor. This shape has 0 file fields and 0 richtext fields — nothing to tailor. It enters the delta only because `gate-select` is `ready=true` and skips step C wholesale.                     |

**`fill-plan-again` is provably useless here, not merely unrequired.** Ran
`benchPlan` twice on `gate-radio-req` with the same slug: the plan is
**byte-identical** and `ready=false` with the same reason both times. The
`confirm-widget` guard keys on the WIDGET, not on the answer's availability, so
no re-run can clear it. A step that cannot change its own precondition is not a
step.

**So both parties are right about different things.** The "+1 turn" claim is
correct about the _rule_: `approval-message` is the only turn the rule causes.
`qa-breaker`'s "+4" is a correct derivation of what `SKILL.md` _as written_
prescribes today. The 3-turn gap is not a cost of the rule — it is **step C's
skip predicate**, which gates three scan-derived decisions (cover letter? PDFs?
reuse?) on `ready`, a defer-derived flag. None of the three is a function of the
defer list.

This is the same class of error Phase 2's first fix row already corrected once:
`readiness()` counting consent defers. The predicate, not the rule, is the
defect. Filed to `doc-scribe` (`SKILL.md`) and `qa-breaker` (`PROTOCOL`).

## M3 — `ready:true` costs 6 model turns. Is Phase 2 failing its target?

- agent: `innov-perf` (independent read requested by `build-manager`)
- harness: `node scripts/dev/bench-apply.mjs --gate --runs 7`, row `gate-base`
- baseline: audit estimate — ~12 model turns/page (`B0` above, an **estimate**)
- after: `64ff80d` / `fc05da5` — `gate-base` round_trips=4 model_turns=6
- budget: `docs/autonomy-plan.md:596` — "~12 model turns → 0 on green, ≤1 on amber"
- verdict: **improved (12 → 6 measured), and the target was misread**

The 6 turns are `navigate, scan, scan-to-disk, fill-plan, fill, handoff`
(`protocolCost({ready:true, unknownDefers:0, needsRender:false, hasNext:false})`).

**`ready:true` and "green" are NOT the same thing, and the 0-turn target does
not attach to `ready`.** `green` is a **lead-level, pre-browser tier**
(`autonomy-plan.md:685`: known adapter + cached shape + every required
non-consent field resolves + allowlisted consent + l0/l1/l3 pass), computed by
`automatability.mjs` before a browser opens, and explicitly "**a pre-filter, not
the authority**" (`:687`). `ready:true` is a per-page output of `fill-plan.mjs`
on the **model-driven MCP path**. A page can be `ready:true` on a lead that is
amber.

"Zero model turns" is delivered by **removing the model**, not by shortening its
path: `autonomy-plan.md:632` has `scripts/auto/auto-apply.mjs` launch Chromium
directly and call `fill-engine.mjs` as an import, and `:635` says the green path
"has zero model decisions **by construction**". `ls scripts/auto` returns
`audit.mjs`, `guard.mjs` — **`auto-apply.mjs` does not exist**, so the 0-turn
path is not built and `ready:true` cannot be measured against it.

So: **6 turns on `ready:true` is not evidence Phase 2 failed.** Four of the six
cross the model↔browser boundary as MCP calls, and an MCP call cannot occur
without a model turn — that is definitional. 12 → 6 is exactly what Phase 2's
first fix row promised to recover ("the whole step-C model block").

**Two real defects the question surfaced, both in `doc-scribe`'s file:**

1. `autonomy-plan.md:596` states a Phase 2 target only Phase 3 can reach, with
   no caveat — while `:1004` separately says "Phase 2 alone leaves the existing
   **manual flow** much faster." The target line invites precisely the reading
   `build-manager` made. It should state the model-path floor separately.
2. **"≤1 on amber" has no runtime path at all.** `amber` appears three times in
   the plan (`:94`, `:596`, `:684`) — defined once, targeted twice, and never
   assigned a runner. A numeric target on an undefined path is unmeasurable.

**What IS removable within Phase 2, on the model path: one turn.**
`scan-to-disk` exists only because the scan is stashed on `window.__ajLastScan`
for a second `browser_evaluate` to write `scan-p<N>.json`. Phase 2's fix table
already has it ("Scan returns a summary; the full inventory goes straight to
disk via `filename`", owner w2). Landing it gives **4 trips → 3, 6 turns → 5**.
That is the honest model-path floor; the plan's "4 round trips → 2" needs a
second, unspecified merge on top.

**Related, and it makes `SKILL.md` wrong today:** `SKILL.md:359` claims "Per
page, on a recognised ATS: **2 browser calls**". Measured: 4 on a single-page
form, 5 on `greenhouse-p1`. `navigate` and `scan-to-disk` are both uncounted.
`PROTOCOL` flags the second; the first is unflagged. Filed to `doc-scribe`.

## M4 — the derivation's citations have drifted; 11 of 15 are stale

- agent: `innov-perf` (cross-check of `qa-breaker`'s `PROTOCOL`)
- harness: `for n in 66 100 139 142 163 177 187 196 240 252 262 267 304 307 326; do sed -n "${n}p" .claude/skills/apply-job/SKILL.md; done`
- baseline: n/a — a falsifiability defect, not a latency change
- budget: n/a
- verdict: **REGRESSION in falsifiability** (the numbers themselves stand)

`PROTOCOL`'s header says each step "names the file and line that prescribes it.
Recount it yourself; that is the point of writing it down." `SKILL.md` has moved
underneath those line numbers:

| step                               | cited | true          | drift |
| ---------------------------------- | ----- | ------------- | ----- |
| `navigate`                         | 66    | 71            | +5    |
| `scan`                             | 100   | 106           | +6    |
| `scan-to-disk`                     | 139   | 144           | +5    |
| `scan-to-disk` ("2 browser calls") | 326   | 359           | +33   |
| `fill-plan`                        | 142   | 147           | +5    |
| `decide-cover-letter`              | 163   | 173           | +10   |
| `reuse-check`                      | 177   | 187           | +10   |
| `approval-message`                 | 187   | 197 / **294** | +10   |
| `pending-questions`                | 196   | 206           | +10   |
| `save-answer`                      | 240   | 244           | +4    |
| `render-pdf`                       | 252   | 262           | +10   |
| `fill-plan-again`                  | 262   | **272**       | +10   |
| `fill`                             | 267   | 301           | +34   |
| `advance`                          | 304   | 337           | +33   |
| `handoff`                          | 307   | 340           | +33   |

Every step still lands in the right _section_, so the derivation is recoverable
and M2's ruling stands — I re-derived it against the true lines. But a citation
that does not resolve cannot be recounted, which is the one property the derived
columns depend on. The two that matter most for M2 are marked bold: `272` is
what proves `fill-plan-again` is conditional, and `294` is what proves
`approval-message` is required. Filed to `qa-breaker`.

## M5 — the browser leg's stated blocker is gone; the leg is still unwired

- agent: `innov-perf` (finding; `bench-apply.mjs` is `qa-breaker`'s file)
- harness: `node -e "const {chromium}=require('playwright-core'); console.log(chromium.executablePath())"`
- verdict: **inconclusive — a capability claim to correct, not a latency change**

`bench-apply.mjs:14` states "There is no Playwright and no browser in this repo
(a deliberate ~150MB avoidance)". That is **no longer true**: `playwright-core
^1.62.1` is a committed dependency (`package.json:47`), it is installed, and a
real Chromium resolves at `.../ms-playwright/chromium-1234/chrome-win64/chrome.exe`.
**Nothing needs downloading.**

But `--browser` is a stub — `bench-apply.mjs:1951` prints "playwright-core
present (**schema reserved, not yet wired**)". So the six audit quantities in
`B0` stay `unmeasured` because _the leg is unwritten_, no longer because the
dependency is absent. That is a different sentence and the header should say it.

Consequence for the roster: the DEFERRED browser-leg hire request
(`team-roster.md` log, 2026-07-31) was blocked three ways, the first being "no
`playwright-core` until Phase 3.1". **That blocker is resolved.** The other two
(fixed agent registry, the plan-level "no non-manager gets Playwright" rule) are
not mine to rule on. Flagged to `build-manager`.

## M6 — two matrix rows report a sleep number for a fill that never ran

- agent: `innov-perf` (finding); `scripts/dev/bench-apply.mjs` is `qa-breaker`'s file
- harness: `for i in 1 2 3 4 5 6; do node scripts/dev/bench-apply.mjs --gate --runs 1 --json; done`
- baseline: `fc05da5`, `fill-plan.mjs` sha1 `7d6268e3efb0` — `greenhouse-p1` sleep_ms=450, `gate-confirm` sleep_ms=450
- after: `fc05da5`, `fill-plan.mjs` sha1 `e867f24d3bb6` — both sleep_ms=**0**
- budget: n/a — nobody declared one; this is a harness honesty defect
- verdict: **REGRESSION in harness honesty.** The zeros are not a speed-up.
- rollback: **not requested.** `fill-plan.mjs` is mid-edit by its owner; a
  work-in-progress file is not a rollback candidate.

**The same sha gave two different sleep columns.** Six consecutive runs before
and six after, each internally identical — so this is not variance, it is an
uncommitted edit landing mid-session. `git rev-parse HEAD` was unchanged
throughout. Only `provenance().file_sha1` distinguishes the two states, which is
precisely why that field exists.

**Root cause, proven not guessed.** `benchFill` builds its element map from
`plan.items` alone:

```js
for (const item of plan.items || []) { ... elements[sel] = {...} }
```

A **deferred** field is not in `items`, so no element exists for it. The fill
engine's sentinel guard then aborts the whole page:

```
{"k":"-","how":"guard","why":"this plan expects [data-aj=\"a1\"] on the page
 and found 0 — the form is not the one the plan was built for"}
```

`gate-confirm` reports `ok:0, failed:1, deferred:1`. **Nothing was filled.** Its
`sleep_ms=0` is the cost of refusing to run, not the cost of the path.

Proof: re-ran the identical bootstrap with one line added — an element for the
deferred field's selector — and got `ok=3 failed=0 sleep=450`. The engine is
fine; the double is missing a field.

**Scope of the damage, stated exactly.** This corrupts **only the sleep column**,
on **only the rows whose defer carries a selector absent from `items`** —
today `greenhouse-p1` and `gate-confirm`. `round_trips` and `model_turns` derive
from `PROTOCOL` plus the plan output, and the plan is unaffected (`gate-confirm`
still `ready=false`, `confirm=1`). **M2's ruling therefore stands unchanged.**

**Why this one matters beyond the number.** `benchScan` already refuses to report
zeros for a leg that did not run — it throws "Refusing to report zeros for a leg
that did not run — fix `unwrapScan()` rather than letting the numbers go quiet."
`benchFill` has no equivalent check, so a `report.ok === 0` sails through as a
sleep measurement. A row that silently reports 0 for an aborted leg is the exact
failure that guard was written to prevent, one leg over. Suggested to
`qa-breaker`: seed elements from `plan.defer` as well, and fail the row when
`report.failed > 0 && report.ok === 0`.

---

## M7 — 0.12: green-tier prevalence by widget shape — **1 of 7** remembered forms

- agent: `qa-adversary` (owns `scripts/dev/bench-green-prevalence.mjs`)
- harness: `node scripts/dev/bench-green-prevalence.mjs --json` (human report:
  same command without `--json`; `--self-check` validates the bucketer)
- baseline: n/a — a **census**, not a before/after. Nothing changed.
- after: `66937e0` — see **Provenance** below; taken twice, in two tree states,
  identical both times
- budget: none declared (a measurement, not a change)
- verdict: **1 of 7 remembered form shapes can reach `green`.** Seven forms
  cannot support a percentage and this entry does not compute one.
- note: The plan's premise was wrong twice. There are no stored scans of 141
  leads, and in this corpus work-auth and demographic questions do **not**
  render as radio groups — they render as combos and block via `CONFIRM`.

### The headline, with its `n` in the same sentence

**1 of 7 remembered form shapes reaches `green`; 1 of 6 distinct boards reaches
it on a best-case lead.** Seven forms is not a sample from which a rate can be
computed. Do not turn this into a percentage, do not multiply it by 141, and do
not read it as a property of "launch boards" — see **Limits** below.

Two further counts from the same run, which matter more than the headline for
supply math:

- **5 of 7** carry at least one checkbox/radio group or consent tickbox, and are
  therefore **permanently** amber: no re-scan and no amount of fact-base growth
  can clear those two rules.
- **At most 2 of 7** could ever reach green under the settled rules — the one
  that already does, plus `aa5c650e` (Affirm), whose only blocker is a recording
  gap a re-scan would fix.

### The premise correction, because the plan text is wrong

`docs/autonomy/phase-0.md` row 0.12 says this is "computed from the
**already-stored scans** of the 141 leads". **There are no such scans.** Scanning
is per-application. What exists on this machine is:

| Source                     | Count | Used                                             |
| -------------------------- | ----- | ------------------------------------------------ |
| `jobs/.field-cache.json`   | 7     | the corpus                                       |
| `jobs/<slug>/scan-p*.json` | 4     | 3 distinct forms; see the CAPTCHA result         |
| `tests/fixtures/boards/*`  | —     | **NOT counted** — synthetic; `--self-check` only |

**The fixture boards are excluded from every number above.** They appear only in
`--self-check`, which drives the real `shapeBlockers()` over synthetic shapes to
prove the harness's bucketing still speaks the product's language.

**The cache was read raw, on purpose.** It records `v: 2`; `CACHE_VERSION` is now
`4`, so `loadCache()` discards it and warns. That bump is about **reuse** — 0.5
put the registrable host in the fingerprint, invalidating the keys — not about
the recorded field shapes, which remain a valid historical record of what those
seven forms looked like. The harness therefore `JSON.parse`s the file directly.
`tests/dev/green-prevalence.test.mjs` pins that distinction.

**No rule was re-derived.** Every verdict below is the return value of
`automatability.mjs`'s `shapeBlockers()` / `classify()`, `fill-plan.mjs`'s
`resolveFields()` / `buildPlan()` / `submitReadiness()`, and
`pending-questions.mjs`'s `predictedFields()`. The harness adapts the cache's
map-shaped `fields` into the array those functions expect and **buckets the
strings they returned**; `bucket()` throws on any blocker it does not recognise,
so a reworded rule cannot silently drop out of the tally.

### Breakdown by widget shape — what 0.12 is actually named for

Rule occurrences / forms affected: `req-not-recorded` 4/4, `required-unsettled`
9/2, `consent` 4/3, `confirm-widget` 3/3.

| fingerprint | board               | fields | `req` recorded | checkbox/radio | consent | required-unsettled | green   |
| ----------- | ------------------- | ------ | -------------- | -------------- | ------- | ------------------ | ------- |
| `aa5c650e`  | greenhouse/affirm   | 26     | none           | 0              | 0       | —                  | no      |
| `b6882e3e`  | successfactors/IGT  | 42     | none           | 0              | 1       | —                  | no      |
| `5b8bb9bf`  | greenhouse/tebra    | 33     | none           | 1              | 0       | —                  | no      |
| `9fc7b9bb`  | greenhouse/tebra    | 34     | none           | 1              | 0       | —                  | no      |
| `b2a4f5cd`  | motional (generic)  | 25     | 13             | 0              | 1       | 2                  | no      |
| `0382a774`  | greenhouse/coinbase | 34     | 23             | 1              | 2       | 7                  | no      |
| `9ecba78c`  | ashby/ramp          | 8      | 4              | 0              | 0       | 0                  | **yes** |

**The finding inside the breakdown: not one of the three `confirm-widget` defers
is a work-authorisation or demographic question.** They are Tebra's "which of the
following technical areas do you have experience with (select all that apply)"
(twice, two variants of one form) and Coinbase's "Current role" employment-history
checkbox. On every Greenhouse form in this corpus, work-auth, sponsorship and EEO
questions render as **combos**, not radio groups. So the mechanism the plan named
is real but is not what is happening here.

What blocks them instead, by resolution status across the 9 `required-unsettled`
findings: **`CONFIRM` 4** (Motional work auth; Coinbase age-18, work auth,
sponsorship), **`UNKNOWN` 3** (Motional "are you currently a Motional employee",
Coinbase end-date month/year), **`NEEDS-CHOICE` 2** (Coinbase Location, School).

The 4 consent defers: IGT's `* typed signature`; Motional's SMS-consent combo;
Coinbase's arbitration/privacy-notice receipt and its AI-tools acknowledgement.
Three of those four are **combos**, not tickboxes — they defer on
`isConsent`/`looksLikeAgreementProse`, i.e. on topic and prose shape. The rule is
doing work that the word "tickbox" understates.

### The limiting factor, named

**No single rule is the limiter, and that is the actionable result.** Lifting any
one rule moves at most **one** form:

- lift `req-not-recorded` → `aa5c650e` becomes green; the other five stay blocked.
- lift `consent` → **0** forms move (`b6882e3e` and the two Tebra shapes are still
  `req-not-recorded`; Motional and Coinbase still have unsettled required fields).
- lift `confirm-widget` → **0** forms move, for the same reason.

The rule that decides the **ceiling** is the pair of shape rules
(`confirm-widget` + consent), because they are the only two that no re-scan and no
user answer can clear: **5 of 7**. `req-not-recorded` clears on a re-scan (4 of 7,
a scanner-vintage artifact, not a property of the forms); `required-unsettled`
clears when the user answers (2 of 7).

**The one green form is the weakest possible evidence for green.** `9ecba78c` is
an 8-field Ashby step-1 form (Ramp) with no EEO section, no work-auth question and
no consent box — it is green precisely because it omits the questions the rule is
about. Its green also expires: `updated: 2026-07-30` against
`DEFAULT_CACHE_MAX_AGE_DAYS = 30` makes it amber on **2026-08-29** with no code
change.

### The four workspace scans contributed nothing, and why that is the result

**4 of 4 scans on record hand off before a single field is examined.** All four
carry `signals: ["CAPTCHA present — hand off to the user"]`, so `buildPlan`
short-circuits (`fill-plan.mjs:739`) with zero items and one `__page__` defer.
Both real Greenhouse boards this machine has ever opened presented a CAPTCHA. That
is a supply-math fact worth more than the widget breakdown: on this evidence the
modal outcome of opening a real board is a hand-off, before tier, widget or fact
base is consulted.

A clearly-labelled **counterfactual** leg (`scans_past_captcha_COUNTERFACTUAL`)
re-runs the same scans with `signals` deleted, purely to see past the hand-off. It
runs on modified data and is not a measurement of pipeline behaviour on those
pages.

### FINDING QA-0.12-1 — **BREAKS.** The shipped CLIs resolve against an EMPTY fact base

Owner: `implementer` (`scripts/apply/`). **Reproduction, not a fix:**

```
node -e "import('./scripts/apply/answer-bank.mjs').then(ab=>{
  const f=[{k:'x',t:'text',l:'First Name',req:true}];
  console.log('omitted:', ab.resolveFieldsFromFiles(f,{profileFile:'tests/fixtures/profile.yaml',answersFile:'tests/fixtures/answers.yaml'}).results[0].status);
  console.log('null   :', ab.resolveFieldsFromFiles(f,{profileFile:null,answersFile:null}).results[0].status);})"
# omitted: OK
# null   : UNKNOWN
```

`resolveFieldsFromFiles` (`answer-bank.mjs:996`) defaults its paths with
**destructuring defaults**, which fire only on `undefined`. Three CLIs pass `null`
when no `--profile` flag is given, because their `flag()` returns `null` for a
missing flag: `fill-plan.mjs:1747`, `pending-questions.mjs:252`,
`automatability.mjs:611`. `fs.existsSync(null)` is `false` (it emits `DEP0187` and
returns), so **the fact base is empty and every field resolves `UNKNOWN`.**

- **Blast radius.** `node scripts/apply/fill-plan.mjs <slug>` — the invocation
  `apply-job/SKILL.md:147` documents — fills **nothing**. On the Coinbase scan it
  plans 3 items and 22 defers; the committed artifact from a real run
  (`jobs/coinbase-software-engineer/fill-plan.json`, 2026-07-29) has **24 items
  filled with real values**. Same on the Affirm scan: 19 items with the fact base,
  9 without.
- **Live since `147eb68` (2026-07-30 20:09)**, which introduced the destructuring
  default. Both committed `fill-plan.json` artifacts predate it, which is why
  nobody has noticed: no application has been prepped through the CLI since.
- **Second-order.** `loadBankById` (`fill-plan.mjs:327`) falls back with `||`
  rather than a destructuring default, so the bank **is** loaded for the CONFIRM
  class stamp — but nothing ever reaches `status === "OK"`, so the stamp never
  fires. Work authorisation still defers, as `unknown` rather than `confirm`: the
  guardrail holds, its stated reason does not.
- **Effect on this entry.** M7's headline uses the intended fact base (paths
  omitted). **With the argument the shipped CLIs actually pass, the number is
  `0 of 7`** — the harness reports both, as
  `headline.shapes_reaching_green_AS_SHIPPED_CLI`.

The failing test belongs with the fix, so none was landed here — a defect report
is not a merge veto. `tests/dev/green-prevalence.test.mjs` pins the correct
contract (explicit path → `OK`) and names this finding in a comment.

### FINDING QA-0.12-2 — latent. `green` can be granted to a form that can never submit

Owner: `implementer` (`automatability.mjs`). `shapeBlockers` skips optional fields
(`automatability.mjs:218`, `if (!f.req) continue`), but `buildPlan` defers a
`CONFIRM` resolution **before** its own optional-skip (`fill-plan.mjs:1093` vs
`:1111`), so an **optional** assertion-class field defers unconditionally and
`submitReadiness` fails. Real instance in the corpus: `b2a4f5cd` (Motional)
records requiredness and has one genuinely optional CONFIRM field — "will you now
or in the future require visa sponsorship…". Demonstrated end-to-end on the Affirm
scan with `signals` removed and the real fact base: 19 items, 4 defers, of which
**2 are `why:"confirm"`** (both immigration-sponsorship combos),
`submitReadiness → false`.

**Latent, not live**: no form is green _because_ of this today, and green is
explicitly a pre-filter rather than an authorisation. It matters when the green
list is used as a work queue — those leads are guaranteed hand-offs.

### Also observed, not mine to fix

`npm test` at `66937e0` plus implementer's in-flight Phase 2: **1704 tests, 1701
pass, 1 fail, 2 documented skips, 105.0s** (floor 1697; 1697 without this entry's
7 new tests). The one failure is `tests/apply/fill-plan.test.mjs` → "A6: filling
stays correct…", expecting `"Yes, US citizen, no sponsorship needed."` and getting
`"Yes"`. It is in `implementer`'s mid-flight `answer-bank.mjs`/`intents.mjs` work,
not in anything this entry touched.

### Harness cost

`n=7`, **median 1275 ms, range 1246–1383 ms**, 0 aborted. Method: `spawnSync` of
`node scripts/dev/bench-green-prevalence.mjs --json`, 7 consecutive runs, same
shell, warm; **each run's exit status and headline were asserted before its timing
was counted**, so no aborted run is in the spread. Output was byte-identical
across 5 earlier runs, so this is a deterministic analysis and the spread is
process startup, not variance in the answer.

### Provenance — the tree moved mid-measurement

- sha `66937e0`; `MEASURED_FILES` state at run time:
  **`scripts/apply/answer-bank.mjs` DIRTY** (implementer's Phase 2, plus untracked
  `scripts/apply/intents.mjs`); `fill-plan.mjs` and `automatability.mjs` clean.
- Taken **three times**, in three successive tree states as `implementer`'s
  Phase 2 landed under it: (1) `answer-bank.mjs` clean `4b76673…`; (2)
  `answer-bank.mjs` dirty `60b0a71…`; (3) `fill-plan.mjs` also dirty
  `7d7a8fe…`. **Every number above was identical in all three**, including the
  `0 of 7` as-shipped leg. The census is insensitive to that work.
- **Every line number in this entry is as of the `file_sha1`s below and will
  drift** — this repo has already had a plan row wrong twice that way (0.3).
  Cite the symbol, not the line: `resolveFieldsFromFiles`, `loadBankById`, the
  `r.status === "CONFIRM"` branch in `buildPlan`, `captchaSignal`, and
  `shapeBlockers`'s `if (!f.req) continue`.

`file_sha1` at the second (dirty) run:

```
c95427cdb07df06f83c4b8c55d34eedca9b38730  scripts/dev/bench-green-prevalence.mjs
c55b1f72c95ed02c68e623c9ad8bde4de1a0451b  scripts/apply/fill-plan.mjs
73250a8f640893139e91a72bb6287819c9816886  scripts/apply/automatability.mjs
60b0a719830b58dae7ed763c1fd74eceb04bca6f  scripts/apply/answer-bank.mjs   (DIRTY)
9c8892312952adfb268cab50604202a2b6aa2081  jobs/.field-cache.json
```

### Limits — read these before quoting `1 of 7` anywhere

1. **Seven forms cannot support a percentage.** "1 of 7" is the whole claim.
2. **This is not a random sample of launch boards.** It is every form this one
   user happened to open: 4 Greenhouse (2 of them variants of one Tebra form), 1
   Ashby, 1 SuccessFactors, 1 Motional-embedded. Greenhouse is over-weighted, and
   Lever, Workable, multi-step Ashby and Workday are absent entirely. "Zero
   radio-group work-auth questions found" is evidence about **these seven forms**,
   not evidence that the pattern is rare.
3. **Two of the seven are the same employer's form** (`5b8bb9bf`/`9fc7b9bb`, both
   Tebra, one pre-probe and one post-probe), so the effective employer count is 6,
   and the by-shape tally double-counts Tebra's checkbox.
4. **The best-case tier is an upper bound, not a prediction.** `classify()` was
   handed `profileApproved`, `hasVerifiedResume` and `stages.ok` all true and
   `alreadyApplied` false. A real lead must additionally clear all of those.
5. **What could not be computed at all, and what it would take.** Prevalence over
   the 141 leads is **not computable from anything on this machine** — there is no
   stored scan for 137 of them, and green requires a remembered shape for that
   board. Producing it means opening ~135 real employer forms, which this harness
   will not do and which 0.12 was scoped to avoid. The honest intermediate is
   `jobs/.shape-history.jsonl`, the sidecar `fill-plan.mjs:1778` already writes and
   which **does not exist yet** (no application has been prepped since it landed):
   once a few dozen applications have run, that file gives a per-shape census
   without a single extra page load.

---

## B1 — the browser FILL leg: fill wall, unconditional sleep, post-upload remount

- agent: `qa` (owns `tests/dev/*`, `tests/security/*`, `tests/fixtures/*`,
  `scripts/dev/bench-*.mjs`)
- harness: `node scripts/dev/bench-apply.mjs --board greenhouse --runs 1 --browser-fill --json`
  (human form: same without `--json`; paste-ready ledger line: `--ledger`)
- baseline: n/a — **this entry IS the baseline.** Nothing changed; nothing is
  compared to anything.
- after: `0b6db30` — MEASURED_FILES clean on every one of the 32 samples
  (`provenance.dirty_measured_files === []`, asserted per sample, not assumed)
- budget: none declared (a measurement, not a change)
- verdict: **captured, at HEAD and not at the anchor the plan named.** The fill
  costs **2.75s** on the Greenhouse fixture, of which **2.01s is one wait that
  never once exited early** and 0.46s is flat sleep.
- note: The specified `fa192a1` anchor is not merely inconvenient, it is
  impossible — see **The anchor** below. Read that paragraph before quoting a
  number here as "the baseline".

### The anchor the plan asked for does not exist, and this is why

Item 0.9 says capture B1 "at a clean `git worktree` of `fa192a1`". **The
`--browser-fill` leg was added BY item 0.9.** `git show fa192a1:scripts/dev/bench-apply.mjs | grep -c browser-fill`
returns **0**. There is no measurement to take at that commit: the instrument is
the deliverable of the item that specifies the reading. Three phases have also
landed since.

**Captured at HEAD (`0b6db30`) instead, and labelled as such.** Everything below
is a HEAD number. It is a floor for future comparison, not a "before".

**On the partial comparison, and what it would license.** All three named files
do exist at `fa192a1`, and one column — `plan_ms`, the accounted plan leg — was
runnable there. **I did not run it**, and the reason is that its answer would not
be attributable: `fa192a1..HEAD` is 4 commits over those three files (+661/−174
lines) but also moved the fixture boards, the scan fixtures and `bench-apply.mjs`
itself, so a `plan_ms` delta would name three files while measuring six. A number
that cannot be attributed is the failure mode this ledger's `file_sha1` mechanism
exists to prevent, and producing one to satisfy the letter of 0.9 would be the
wrong trade. What it would take to do honestly: a worktree at `fa192a1` with its
own `node_modules`, running its own fixtures, and a stated claim about `plan_ms`
only.

**Recording the correction, because the plan has been wrong about its own
premises repeatedly this session** and each correction has been kept rather than
edited away. This is the third: M6 corrected the harness's honesty, M7's
"Premise correction" corrected 0.12's stored-scan assumption, and 0.9's anchor is
corrected here.

### The three `file_sha1`s the Phase 0 check names

Recorded at `0b6db30`, with the `fa192a1` value beside each — all three changed
substantially in Phases 1–2, which is the whole reason the hashes are pinned.

| file                            | at `fa192a1`   | at `0b6db30` (B1)  | Δ lines    |
| ------------------------------- | -------------- | ------------------ | ---------- |
| `scripts/apply/fill-plan.mjs`   | `3af559212a31` | **`0c948d57fbc4`** | +343 (net) |
| `scripts/apply/answer-bank.mjs` | `19013fdae708` | **`893801e95d8d`** | +365 (net) |
| `scripts/apply/field-cache.mjs` | `6ba7a065e134` | **`3f7055894985`** | +127 (net) |

The rest of `MEASURED_FILES` at B1, since a fill number depends on all of them:
`eb26f79696a8 scan-page.js`, `548909071e69 scan.driver.mjs`,
`35da2d57dc72 scan-engine.mjs`, `be3f14913628 fill-engine.mjs`. The harness itself
is **not** in `MEASURED_FILES` and so is pinned by hand: `bench-apply.mjs`
`38a82884d8e8`; fixture pages `04fad8330b69 greenhouse-step1.html`,
`02c3cdc76167 lever.html`, `e101c73cabc7 ashby.html`.

### The three columns 0.9 asked for — Greenhouse, LOOPBACK, n=9

Median and full range. Never a bare mean: the remount column's tail is the whole
story. Each sample is one process, one Chromium, one real file upload.

| column                     | method   | median  | range           |
| -------------------------- | -------- | ------- | --------------- |
| **fill_wall_ms**           | measured | 2753.73 | 2707.15–2843.59 |
| **unconditional_sleep_ms** | measured | 456.14  | 450.80–466.31   |
| **post_upload_remount_ms** | measured | 2014.58 | 2009.46–2019.59 |
| conditional_total_ms       | measured | 2014.58 | 2009.46–2019.59 |
| non_wait_ms                | derived  | 272.15  | 245.02–375.05   |

Context legs from the same samples: `nav` 29.79 (26.85–40.31), `scan` (live DOM)
391.39 (349.87–665.34), `plan` 147.18 (129.68–389.17).

**The three are separate accumulators, not one number split three ways.**
`unconditional_sleep_ms` comes from `clockedPage`'s `slept_ms`, which only
`page.waitForTimeout` writes to. `post_upload_remount_ms` is summed out of
`by_target` **by selector** (`data-ajup…::locator.waitFor:detached`), never by
subtracting one total from another. The two are disjoint. `conditional_total_ms`
is a **superset** of the remount column, and on this board they are equal to the
0.01ms — the two upload detach waits are the ONLY conditional waits the fill
pays. `non_wait_ms` is the only derived column and says so.

### Loopback and modelled latency, in separate columns — never merged

`bench-apply.mjs` has **no `--latency` flag** (see FINDING QA-B1-3), so the
modelled population was taken through the exported leg. Batch B is the same
driver on loopback, present so B↔C is a latency comparison and not a driver
comparison; A↔B shows the CLI and the driver agree.

```
node --input-type=module -e "
const {start}=await import('./tests/fixtures/boards/server.mjs')
const {benchBrowserFill}=await import('./scripts/dev/bench-apply.mjs')
const fs=await import('node:fs'),os=await import('node:os'),p=await import('node:path')
const board=await start({latency:{nav_ms:300,xhr_ms:150}})   // omit for loopback
const dir=fs.mkdtempSync(p.join(os.tmpdir(),'b1-'))
console.log(JSON.stringify(await benchBrowserFill({board,boardName:'greenhouse',jobsDir:dir})))
await board.stop(); fs.rmSync(dir,{recursive:true,force:true})"
```

| column                 | A CLI loopback n=9 | B driver loopback n=9 | C driver **modelled** n=9 |
| ---------------------- | ------------------ | --------------------- | ------------------------- |
| fill_wall_ms           | 2753.73            | 2743.61               | 2743.86                   |
|                        | 2707.15–2843.59    | 2710.82–2787.91       | 2706.35–2819.58           |
| unconditional_sleep_ms | 456.14             | 456.96                | 457.29                    |
| post_upload_remount_ms | 2014.58            | 2016.75               | 2015.24                   |
| non_wait_ms (derived)  | 272.15             | 277.45                | 266.01                    |
| nav_ms                 | 29.79              | 27.31                 | **331.09**                |

C is `mode: "modelled"`, nav 300ms / xhr 150ms declared. **These are different
populations and must never be averaged with A or B**, per the latency contract at
`tests/fixtures/boards/server.mjs:31`.

**What the modelled column buys, stated exactly.** It moves `nav` (29.79 →
331.09, i.e. the declared 300ms lands) and **does not move the fill at all**
(2743.61 → 2743.86, inside a range that spans 80ms). That is a result, not a
null: the fill issues no HTTP, so its cost is engine-side waiting and CDP, and
**no amount of network improvement touches it.** The one number that did move
oddly is `scan` (404.65 loopback → 242.32 modelled); the plausible cause is that
a 300ms nav lets the page's own scripts finish before the scan starts. Not
investigated, not claimed, recorded so nobody quotes it as a speed-up.

### The other two boards, LOOPBACK, n=7 each

Same command with `--board lever` / `--board ashby`.

| column                 | lever n=7                 | ashby n=7                 |
| ---------------------- | ------------------------- | ------------------------- |
| fill_wall_ms           | 1783.63 (1758.39–1924.05) | 1685.17 (1652.26–1885.14) |
| unconditional_sleep_ms | 457.45 (451.06–467.47)    | 458.65 (452.54–462.80)    |
| post_upload_remount_ms | 1009.98 (1007.29–1015.01) | **null — unmeasured**     |
| conditional_total_ms   | 1009.98                   | 1004.16 (1000.73–1011.67) |
| non_wait_ms (derived)  | 307.27 (300.04–451.66)    | 223.16 (189.55–429.60)    |
| fill report            | ok=5 failed=0 deferred=2  | ok=4 failed=0 deferred=2  |
| upload landed?         | yes, 1 of 1               | **NO — 0 of 1**, 7/7 runs |

The unconditional 450ms is a **board-independent constant** — three boards, 23
samples, every median inside 456.1–458.7. It is one `page.waitForTimeout(450)` at
`fill-engine.mjs:888`, and it is the term removable by editing code.

### The remount column is a CEILING, not a settle time

`post_upload_remount_ms` ÷ waits is 1007ms on Greenhouse (2 waits), 1010ms on
Lever (1 wait), against a 1000ms ceiling. The engine's own `report.uploads[]` says
why: **`settled: "timeout"` on all three boards, every run** — observed by
wrapping `fill-engine.mjs` in-process and dumping the array, which no output path
prints.

So the reasoning at `fill-engine.mjs:653` — "a board that remounts in 150ms now
costs 150ms" — is **not exercised by any fixture in this repository.** The early
exit has zero coverage, and the honest reading of 2014.58ms is "two waits that
each paid their full ceiling", i.e. on this corpus it is indistinguishable from a
flat 1000ms per upload item. `tests/dev/b1-browser-fill.test.mjs` pins the
mechanical reason (the Ashby fixture's re-render strips `data-aj="…"` and leaves
`data-ajup="…"`, so the watched stamp survives) so the ceiling is never re-read as
a settle time.

### M6 is genuinely fixed, and here is how that was established

Not by reading `collectIncomplete`. `fill-engine.mjs` was replaced **in-process
only** (a `module.register` load hook; nothing on disk changed) with a stub
returning exactly `ok:2 failed:1 deferred:3`, and the real CLI was run:

```
node --import <hook> scripts/dev/bench-apply.mjs --board greenhouse --runs 1 --browser-fill
  -> exit 3, "MEASUREMENT REFUSED — the browser fill (board=greenhouse) did not
     complete", and it NAMES the field: "FAILED f3 how=fill"
… --ledger  -> exit 3, "REFUSING to emit a ledger entry", stdout empty
```

The shipped predicate is `failed === 0`, not M6's originally suggested
`failed > 0 && ok === 0` — which is what makes the partial-success case fail
closed. **Caveat, and it is an M1-shaped one:** no shipped board, shape or profile
produces `failed > 0`. All 24 combinations of {3 boards + 5 gate shapes + 3
synthetic shapes} × {best, typical, worst} report `failed=0`, so the exit-3 branch
is unreachable from the CLI without injection. It is correct and it is **untested
by anything that runs in CI**.

### FINDING QA-B1-1 — **BREAKS.** A straight file swap passes `upload_integrity.ok`

`bench-apply.mjs:2219` computes
`ok = inputs_with_files === planned && files_attached === planned`. That counts.
It cannot see a **swap**, which is the exact user-facing defect this read-back
mechanism was built to catch — a cover letter going out as the résumé.

Reproduced against the running harness with a fill engine that attaches crosswise
(in-process hook, nothing on disk changed):

```
upload_integrity: { planned: 2, files_attached: 2, inputs_with_files: 2, ok: true }
per_input: [ { id: "resume",       names: ["cover-letter.pdf"] },
             { id: "cover_letter", names: ["resume.pdf"] } ]
measurable: true, exit 0
```

The evidence is already collected — `per_input[].names` — and simply not compared
to the plan. Owner: `bench-apply.mjs`. Guard added meanwhile in
`tests/dev/b1-browser-fill.test.mjs` ("the resume input holds the resume"), which
asserts the pairing by name off the live DOM.

### FINDING QA-B1-2 — the Ashby upload attaches nothing, and `ok` says otherwise

7 of 7 runs: `fill: ok=4 failed=0 deferred=2`, `_systemfield_resume` holding
**zero files**. Mechanism, observed not guessed: the fixture's re-render fires
700ms after the `change` event — inside the engine's own 1000ms settle — and
`form.innerHTML = html` cannot carry a `FileList`. The engine knows:
`report.uploads[0]` is `{ settled: "timeout", attached: true, seen: "empty", seenFile: null }`.

**`seen` has no consumer.** `grep` for it across `scripts/` outside
`fill-engine.mjs` returns nothing. The CLAUDE.md gotcha "`ok` never says a file
reached the right field — attachments are reported from `report.uploads`" is today
a promise about a field **nothing reads**, and rule 6's submit path is the consumer
that will need to. Latent until the runner ships; blocking then.

Scope, honestly: proven against the fixture, and the fixture is a **model**. Its
`innerHTML` round trip is a worst case; real Ashby React reconciliation may
preserve the FileList. What this sample supports is "the engine reports `ok` for an
upload whose file is gone, on a page shaped like this one" — not a claim about live
Ashby, which this harness will not touch.

### FINDING QA-B1-3 — the harness cannot produce the modelled column 0.10 requires

`bench-apply.mjs`'s `parseArgs` has no `--latency`; `startBoard()` is called with no
arguments, so every CLI run is loopback. 0.10 requires the two populations side by
side and never merged; the CLI can only ever emit one of them. Column C above exists
only because `benchBrowserFill` is exported. Low severity, one option and one line to
thread through.

### Also observed, not findings

- `node scripts/dev/bench-apply.mjs --board ashby` **exits 0** (confirmed with and
  without `--browser-fill`, `--runs 1` and default `--runs 5`). 0.10's committed
  `ashby-step1.scan.json` / `lever-step1.scan.json` are doing their job.
- `--json` reports `measurable: true` on the Ashby run whose upload attached
  nothing, and on the swap reproduction. `measurable` is scoped to fill completeness
  only. The human and `--ledger` outputs both carry `UPLOAD-MISDIRECTION`, so nothing
  false is printed — but a machine consumer reading one boolean gets the wrong answer.
- `--shape combo23` and `--shape richtext` report `ok=0` with everything deferred and
  exit 0. Defensible (a deferral is a decision), but the sleep column of a fill that
  filled nothing is a number about refusing to act.

### Limits — read before quoting any figure above

1. **n=9 per Greenhouse batch, n=7 per other board, one machine, one session.**
   Enough to show the ranges are tight (fill_wall spans 5% of its median); not enough
   for a tail estimate. There is no p95 here and one should not be computed from these.
2. **Everything is the loopback fixture**, three replica boards. It is not a sample of
   real ATS pages, and the two most expensive audit quantities (a 14-combo form, a
   3,000-char cover letter) are absent from all three fixtures. The synthetic shapes
   cover those and are not part of B1.
3. **The tree was not quiescent.** At capture, `docs/autonomy/*`,
   `docs/autonomy-plan-v2.md`, `scripts/documents/verify-claims.mjs` and
   `scripts/lib/db.mjs` were modified and `scripts/documents/assemble-resume.mjs`
   untracked — `implementer`'s concurrent work. None is imported by the scan, plan or
   fill path, and `provenance.dirty_measured_files` was empty on all 32 samples.
   Contention on this project has previously inflated a duration by 75s → 150s, so the
   tight ranges are themselves the evidence that it did not here.
4. **`post_upload_remount_ms` for Ashby is `null`, not 0**, and the row must not be
   filled in with a zero. There is no remount cost because there was no upload.

---

## M8 — Phase 3: deterministic assembly throughput, and the reuse-check cache

- agent: `implementer`
- harness: not committed (`scripts/dev/bench-*.mjs` is `qa`'s). Both legs are
  reproducible from committed modules; the exact commands are given per number
  below.
- baseline: `0b6db30` — see per-leg rows; the assembler had no baseline because
  it did not exist.
- budget: declared before pickup — **3.4: warm sibling scan ≥40% off the ranking
  loop, and no end-to-end regression on the uncached path.** The assembler had
  no declared target: Phase 3's check 3 asks for the number, not a target.
- verdict: **improved** (3.4, at scale) / **inconclusive at today's tree size**
  (3.4, N=8) / **measured, first reading** (assembler throughput)
- note: the cache wins the loop everywhere and only wins the process past ~120
  workspaces; `jobs/` holds 8 today, so it is deliberately inert.

### Assembler throughput — Phase 3 falsifiable check 3

`assemble-resume.mjs`, `model_turns = 0` by construction (see
`tests/documents/assemble-purity.test.mjs`).

| leg                                             | ms/doc | docs/hour |
| ----------------------------------------------- | -----: | --------: |
| in-process batch, 50 docs, test fixture profile |   3.89 |   924,529 |
| in-process batch, real profile (101 facts)      |   6.27 |   574,505 |
| cold node process per document, CLI             |  212.4 |    16,949 |

- fixture batch: `bench-docs.mjs assemble --n 50 --runs 5`, median of 5.
- real-profile leg: 9 samples over the 8 committed job fixtures, **timing only —
  nothing from `profile/` was printed or stored**. Scale reported: 101 facts, 33
  selectable bullets, `approved_by_user: true`.
- cold-process leg: 9 samples, `assemble-resume.mjs <slug> --jobs-dir <tmp>`.
  212 ms is ~49 ms of node start plus module load; it is the honest per-call
  figure for a caller that shells out once per job.

**The attended denominator is NOT measured, and nothing on this machine can
measure it.** No recorded tailoring duration exists in this repository. The only
two anchors are `scripts/leads/cluster.mjs`'s header ("several minutes per
posting", a comment) and B0's audit estimate of ~12 model turns per page
(labelled an estimate there). So the comparison is stated as a bound rather than
a ratio: at 60 s/document — an aggressive lower bound for a dozen model turns
plus a human reading the approval message — the attended path yields 60
docs/hour, against 16,949 for the slowest assembler leg. The conclusion (three
orders of magnitude) survives any plausible value of the unmeasured term, which
is why it is quoted as a bound. **The real change is not wall clock at all: the
attended path needs a person in the session and this one does not, so the
ceiling stops being human hours.**

### 3.4 — reuse-check: exported core plus a `workspace_stacks` cache

Isolated ranking loop, cached and uncached back to back in one process,
4000-char descriptions:

| workspaces | uncached ms | cached ms | saved |
| ---------: | ----------: | --------: | ----: |
|         60 |       108.5 |      56.2 |   48% |
|        200 |       328.1 |     145.6 |   56% |
|        400 |       778.2 |     266.4 |   66% |
|            |

End to end (`node scripts/documents/reuse-check.mjs <slug> --dir <tmp> --json`),
9 interleaved samples per leg, HEAD vs this change:

| workspaces | BEFORE median | AFTER `--cache off` | AFTER `--cache on` |
| ---------: | ------------: | ------------------: | -----------------: |
|         60 |         276.1 |               273.7 |              274.0 |
|        200 |         624.9 |               646.3 |              511.6 |

- **The declared ≥40% target is met on the loop and NOT on the process**, and
  the reason is fixed cost the cache cannot avoid: `db.mjs` ~18 ms
  (`node:sqlite`), `openDb` ~4 ms, `node:crypto` ~6 ms. That is ~28 ms against a
  saving of ~0.26 ms per sibling, so the break-even sits near 60 workspaces and
  the win is only unambiguous well past it. `CACHE_MIN_WORKSPACES = 120`, and
  `--cache auto` therefore engages **nothing** on today's 8-workspace `jobs/`.
- The uncached path was kept honest deliberately: `node:crypto` is imported only
  on the cache path and the sibling readdir is done once and reused, because a
  first cut of this change cost the uncached path ~6 ms for a hash it never used.
- Two later N=200 repeats were taken under heavy contention (BEFORE median moved
  624.9 → 985.7 → 1152.4 for identical bytes) and are **inconclusive on
  medians**. On the contention-resistant `min` they agree: 31%, 26%, 31% faster
  cached. N=400 and N=8 were noise-dominated and are not quoted.

### Limits — read before quoting any figure above

1. **The tree was not quiescent.** `doc-scribe` was editing `docs/autonomy/*` and
   `qa` was running B1 throughout. Every number above except the first N=200 row
   was taken with other agents active; the repeats are reported rather than
   dropped, and the ones that are noise are labelled as noise.
2. **The 3.4 tables are synthetic trees**, generated locally, uniform 4000-char
   descriptions across six stacks. A real `jobs/` has variable description
   lengths and a lower per-sibling scan cost, which moves the break-even UP, not
   down.
3. **`docs_per_hour` for the assembler is a rate, not a plan.** Nothing upstream
   produces 574,000 leads an hour. It is quoted to show the document step is no
   longer the binding constraint, which is the only claim Phase 3 makes about it.
4. **The 3.3 cover-letter estimate is not in this ledger** because it is not a
   measurement: `scripts/documents/letter-plan.mjs --price-only` computes it from
   declared token counts, and no letter has been authored under that plan yet.

---

## M9 — Phase 4: the campaign harness, and both halves of the gate proved by mutation

- agent: `implementer` (4.1–4.4, 4.7, 4.8)
- harness: `node scripts/dev/bench-runner.mjs --apps 50 --concurrency 8 --board greenhouse,honest-greenhouse --runs 3 --json`
- baseline: `9905681` — first measurement of this workload; there is nothing before it
- after: `9905681` + the Phase 4 working tree — `MEASURED_FILES` untouched, `dirty=0`
- budget: none declared; this entry IS the baseline
- verdict: baseline established, and the gate demonstrated red in both directions
- note: stable to ±2% across three runs; every column is labelled `measured` and none is derived.

### The workload, and why it is a mix

50 applications at concurrency 8 across 8 distinct loopback origins and 8
`fixture-emp-<n>` tenants, three runs, `dry_run`, accounted (no browser).

**`--board greenhouse` alone was rejected as the gate workload.** That fixture
carries a consent tickbox, so every application defers on it: `defer_rate` is
`1.0` **by construction**, `submitted_per_hour` is structurally `0`, and the
gate's defer-rate rule can never move in either direction. That is a true fact
about the fixture and not a harness defect — but a gate whose columns cannot
move is not a gate. `greenhouse,honest-greenhouse` splits 25/25 and both
throughput columns carry a number.

### The nine columns, at `9905681`

| column                    | value                 | method   | statistic             |
| ------------------------- | --------------------- | -------- | --------------------- |
| `submitted_per_hour`      | 12,400                | measured | mean over the run     |
| `deferred_per_hour`       | 12,400                | measured | mean over the run     |
| `defer_rate`              | 0.5                   | measured | mean                  |
| `defer_rate_by_class`     | assent=0.5            | measured | mean                  |
| `model_turns_per_app`     | 0                     | measured | mean                  |
| `sleep_ms_per_app`        | 450                   | measured | mean                  |
| `edge_spacing_ms_per_app` | 0                     | measured | mean                  |
| `wall_ms_p95`             | 1565.31               | measured | p95, median of 3 runs |
| `spawns_per_app`          | 1                     | measured | mean                  |
| `round_trips_per_app`     | 60                    | measured | mean                  |
| `failure_rate_p`          | 0 on all 8 board_keys | measured | mean per `board_key`  |

**`edge_spacing_ms_per_app` is 0 because no spacing policy exists yet**, not
because spacing is free. The harness clocks the wait it actually performed;
inventing a number for a policy Phase 5 has not written would be the estimate
this ledger exists to refuse. `--edge-spacing-ms N` makes the column non-zero.

**`defer_rate_by_class` reads `assent=0.5`, and that split is the point.** Every
deferral in this workload is a consent tickbox — the class that does **not**
shrink with engineering and must not. Zero are `understanding`, so there is no
backlog item here that would unlock an application. A single `defer_rate` number
cannot say that.

### The instrument, which was wrong twice before it was right

`model_turns` is the gate's one hard, no-override column, so a counter that
silently reports 0 turns that rule into a permanent green light. Two obvious
implementations do exactly that, and both were measured rather than reasoned
about:

| approach                                              | counted |
| ----------------------------------------------------- | ------- |
| patch `child_process.execFileSync`, static import     | **0**   |
| patch, then `await import()` the caller               | **0**   |
| `--require` preload (`scripts/dev/spawn-counter.cjs`) | 1       |
| preload in the parent only, model call in a child     | **0**   |
| preload + `NODE_OPTIONS` + per-process exit rows      | 1       |

The first three are one fact: a module that did
`import { execFileSync } from "node:child_process"` is bound to the export the
builtin published at bootstrap, and reassigning the property afterwards reaches
nothing. The fourth is a second fact and the more dangerous one — the plan leg
**shells out** to `scripts/apply/fill-plan.mjs` once per application, so a model
call added there runs in a process the parent cannot see. Parent-only counting
scored the plan's own falsifiable mutation as **zero**.

`bench-runner` therefore re-execs itself with the preload, sets
`NODE_OPTIONS=--require <preload>` plus `AJ_COUNTER_FILE` for the campaign, and
sums one exit-written JSON row per descendant. **Cost, stated because it is
real:** the preload adds startup to every child and moved `wall_ms_p95` from
~1328 ms to ~1565 ms (+18%). The baseline above is taken **with** the instrument
in place, so the two are never compared across it.

**`model_turns` is narrowed from the plan's wording, deliberately.** §4.7 says
"process spawns plus outbound HTTP to any non-loopback host". Taken literally
that is red on every run by construction, because `benchPlan` spawns
`node scripts/apply/fill-plan.mjs` — a deterministic local script, and the
sanctioned behaviour. A gate that fires on the sanctioned behaviour acquires an
override line within a week. So `spawns_per_app` counts **every** spawn as its
own column, and `model_turns` counts a spawn only when it is not this repo's own
node running a file under `scripts/`, plus every non-loopback request. A real
model call is still caught either way it can arrive.

### Both halves of the falsifiable check, proved by mutation

Run with `--allow-dirty`, which exists for exactly this and prints numbers that
are evidence about the **gate**, never numbers to bank.

| mutation                                                                               | column                           | verdict                           |
| -------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------- |
| `await page.waitForTimeout(200)` after the verify blur in `fill-engine.mjs`            | `sleep_ms_per_app` 450 → **650** | **FAIL** — "exceeds 495"          |
| the same, with `perf-budget: sleep_ms +200` in the PR body                             | same 650                         | **PASS** — budget applied         |
| `https.request("https://api.anthropic.com/v1/messages")` at the top of `fill-plan.mjs` | `model_turns_per_app` 0 → **1**  | **FAIL**                          |
| the same, with `perf-budget: model_turns +99` in the PR body                           | same 1                           | **FAIL** — no override, by design |

The first mutation was initially placed in `openCombo`, which **this workload
does not reach**, and the gate stayed green — correctly. Recorded because it is
the mistake to expect: a mutation proof on a code path the run does not take
proves nothing, and reads exactly like a broken gate.

Both files were restored byte-for-byte (`git status` clean on `scripts/apply/`)
before the baseline was taken.

### The ledger invariant, in its corrected form

`durable_rows === reached_authorized` **and** `rows_in_state('attempted') === 0`
at run end. Revision 1 of the plan asked for
`durable_attempted_rows != apps_started` as a hard FAIL, which contradicts its
own state machine — deferrals exit at `planned` or `authorized`, before any
attempted row is written, and the taxonomy lists 14 pre-attempt kinds. On this
workload 25 of 50 applications defer, so revision 1's gate would have been red
on a completely healthy run, every run.

### Provenance

`9905681`, `dirty_measured_files: []`. The full `file_sha1` set is in
`docs/perf-baseline.json`, written by
`node .github/workflows/perf-gate.mjs --update` and read by CI on every PR.

| file                                       | `file_sha1`    |
| ------------------------------------------ | -------------- |
| `.claude/skills/apply-job/scan-page.js`    | `eb26f79696a8` |
| `.claude/skills/apply-job/scan.driver.mjs` | `548909071e69` |
| `scripts/apply/scan-engine.mjs`            | `35da2d57dc72` |
| `scripts/apply/fill-engine.mjs`            | `be3f14913628` |
| `scripts/apply/fill-plan.mjs`              | `0c948d57fbc9` |

### Limits — read before quoting any figure above

1. **This is the ACCOUNTED path, not a browser.** Sleep is recorded as the
   argument the engine passed on the branch it took, not slept. `--real-sleep`
   makes wall absorb the same total; that equivalence is bench-apply's check and
   it is unchanged here.
2. **Loopback, not the modelled-latency arm.** The fixture supports `--latency`
   and this baseline does not use it. A loopback number and a modelled number
   are never merged.
3. **`failure_rate_p` is 0 on every board, and that is a fixture fact.** The
   whole anomaly-breaker calibration in §4.6 rests on `p`, and the only honest
   thing this baseline says about it is that a healthy loopback run has none.
   Nobody has measured `p` against a real board, and the fixture cannot produce
   one.
4. **`submitted_per_hour` ≈ 12,400 is a rate, not a plan.** Nothing upstream
   produces 12,400 qualifying leads an hour, and 0.11 — the sweep number that
   would say what the supply actually is — is still outstanding.
5. **There is no runner.** `bench-runner` supplies its own ~40-line worker pool
   and drives the shipped modules; it contains no click, no retry policy and no
   trust decision. When Phase 5 lands, that pool is what it replaces, and this
   baseline must be re-taken against the real runner rather than assumed to
   carry over.

---

## M10 — 0.13: canonicalizing `apply_url`. The free half works; the aggregator half cannot be made to

- agent: `implementer`
- harness: `node scripts/leads/canonical.mjs [--network] [--limit N] [--json]`
- tree: `5d5da52` — `canonical.mjs` `dca14d6fdcfc`, `find-jobs.mjs` `2dc68f57353b`
- store: `jobs/leads.db`, 158 leads, on this machine (win32 / node 24.13.1), 2026-08-03
- verdict: **improved, and one half of the item is refuted**

### The headline, with its `n` in the same sentence

**Leads carrying a trust-gate-usable `apply_url`: 77 → 91 of 158** (48.7% → 57.6%),
at a cost of **zero third-party HTTP requests**.

| via             |   n | what it is                                                    |
| --------------- | --: | ------------------------------------------------------------- |
| `already-ats`   |  77 | the swept URL was an ATS posting; query and fragment dropped  |
| `lead-identity` |  14 | embedded careers page, resolved from the board's own API data |
| unresolved      |  67 | 51 adzuna, 9 jobicy, 7 successfactors (`jobs.igt.com`)        |

The 14 are the coinbase (10) and samsara (4) leads. Their canonical form is a
string operation on `source: greenhouse:<tenant>` plus `?gh_jid=<id>` — data the
**board** gave us, so no page is trusted and nothing is fetched. Greenhouse's
two host spellings also collapse: `boards.` + `job-boards.` → 51 on one host, so
the same posting found twice is now one string.

### The refutation, and it is the load-bearing result

**§7 R-8 says 0.13 "recovers the 40% of leads currently lost to aggregator and
embedded URLs". It recovers the embedded ones and NONE of the aggregator ones.**

Measured against a 21-lead sample (12 adzuna, all 9 jobicy), fetched once each:

| HTTP |   n | meaning                                            |
| ---- | --: | -------------------------------------------------- |
| 403  |  11 | the aggregator declined a scripted request         |
| 200  |   8 | served, and carrying **no ATS link of any family** |
| 404  |   2 | the posting is gone                                |

**Resolved: 0 of 21.** The 200s were scanned for 14 ATS families — Greenhouse,
Ashby, Lever, SmartRecruiters, Workday, Oracle, Ceipal, iCIMS, Taleo, BambooHR,
JazzHR, Workable, Breezy, Recruitee — and matched none. Adzuna keeps the
employer link behind its own redirector; the underlying ATS URL is not present
in anything it serves.

**This is not a gap to close later.** 52% of the sample is a 403, and the way
past a 403 is to defeat a third party's access control on their own site. That
is out of bounds, so the network tier is shipped, tested and **left at its
measured yield of zero** rather than "improved". The recovery of those 60 leads
(38% of the store) belongs at the supply end — preferring direct ATS boards in
`docs/job-sources.yaml`, which is Phase 6.1's and the user's file.

### One defect this measurement found in the harness itself

The resolver reported a 404 aggregator page as "no ATS posting found on the
page", because adzuna serves a **full 49 KB page with HTTP 404** for a dead job.
That reads as a parser gap and is not one — it is `posting-gone`, which Phase
4.1 already has a kind for. Fixed, and both statuses are asserted; a 403 is
asserted **not** to be reported as a dead posting, because those are different
facts about the world and one of them is the aggregator's decision, not the
job's.

### Limits — read these before quoting any number above

1. **The 21-lead sample is 35% of the 60 aggregator leads**, fetched once, from
   one IP, on one day. A 403 rate is exactly the kind of number that varies by
   all three. The claim it supports is "the network tier does not work here
   today", not "adzuna links are unresolvable in principle".
2. **`successfactors` (7 leads) is unresolved for a different reason** — it has
   no anchored host pattern, because `jobs.igt.com` is a customer-hosted domain
   with nothing ATS-shaped about the hostname. Adding it means allowlisting a
   specific employer's domain, which is a different decision from recognising an
   ATS, and it is the user's.
3. **91 leads have an `apply_url`; nothing has yet been submitted through one.**
   The trust gate that consumes this field is Phase 5's and does not exist. This
   entry measures that the field is populated and well-formed, not that it works.
