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
| Scan probe sleep                    | ~6.8s (380ms × ≤18 dropdowns)   |
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
