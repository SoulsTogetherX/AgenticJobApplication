# Next session — start prompt

Paste everything below the line into a fresh session.

---

Continue implementing `docs/autonomy-plan.md`. It is **already approved — implement it, do not re-plan it.**

You are `build-manager`. Delegate to the agents in `.claude/agents/` per `docs/team-roster.md` ownership. **Only the manager commits, to `dev` only.** Read `docs/agent-protocol.md` and `docs/team-roster.md` first — they contain rules earned from real incidents, not preferences.

## Where things stand

Branch `dev`, HEAD was `f4e537e`, 38 commits since tag `baseline-pre-autonomy`. Suite: **1121 tests, 1117 pass, 0 fail, 4 skipped (all reasoned), 0 todo.** Security gate: **201, 198 pass, 0 fail, 3 skipped.**

**Phase 1 (security) is essentially done.** The round-trip RCE is closed; a posting's title can no longer whitelist a résumé claim through verify-claims R6; `untrusted.mjs` is real and sanitises at ingest before `textSnippet` flattens the HTML; L3 injection findings now **reject** rather than merely flag; a government ID can no longer enter `answers.yaml` (exit 4, two-factor, measured 0 false positives across 5940 pairs); `save-answer.mjs` exits 2 on an unrecognised flag. `tests/fixtures/boards/` is a local fake ATS — Greenhouse, Lever and Ashby replicas plus hostile variants, served on `127.0.0.1` — and `tests/fixtures/boards/dom.mjs` runs the **real `scan-page.js`** with no browser.

**Phase 2 (latency) has only its baseline.** `scripts/dev/bench-apply.mjs` exists: 5 round trips, 450ms unconditional sleep, 12 model turns, measured against the fake board. The tuning table in the plan is untouched, except that `ready=` was redefined to mean _"no model turn is needed"_ rather than _"nothing is deferred"_ — the plan's own highest-leverage Phase 2 item.

**Phase 3 (autonomy) has not been started at all.** `scripts/auto/`, `lock.mjs`, `automatability.mjs`, the `auto_apply` block in `application-limits.yaml`, `jobs/.auto/` — none of it exists. Nothing applies to anything unattended today.

## Do these first, in this order

**1. Wire the consent classifier to its consumer. This is a live defect.**

`w1-security` built `answerClass` / `mayAutoActUnattended` in `scripts/lib/untrusted.mjs`: an answer is `datum` (a fact — email, phone, years of experience) or `assertion` (something the user asserts — work authorisation, relocation, background check, arbitration). An assertion must never auto-act unattended.

**Nothing consumes it.** `grep -c "answerClass" scripts/apply/fill-plan.mjs` returns 0, so in running code these tests pass, meaning the attack still works:

```
ok 21 - LANDS (shape B): a tickbox whose own label is 'Yes' is auto-ticked, and the tick POSTs into an arbitration waiver
ok 22 - LANDS (shape C): the commonest real ATS rendering — a Yes/No radio pair — ticks the same waiver
```

The spec is in the git log for commit `f4e537e` and in `w1-security`'s own header comments. Key points: parse `/^(a-\d+)@/` off `r.source` and classify **that one row** (~1 µs/field; classifying the whole bank per field costs 86 µs). Do **not** branch on `f.t` anywhere in the gate — that is what shape C defeats. Do **not** reuse `UNKNOWN`, which routes to `pending-questions.mjs` and would re-ask a question the user already answered, globally, forever; use a distinct `CONFIRM` status carrying the value, the pick, and `describeClass(info)`. Owner: **`w3-resolution`**.

Measured cost, so nobody rediscovers it: 1 of 8 resolved fields defers across the honest board fixtures (12.5%) — the work-authorisation field, which legally must.

**2. Shape E — scanner blindness. Sequence it AFTER item 1.**

A `<div role="checkbox">` produces **zero** scanned fields, and `readiness()` returns `ready: true` on a form carrying an unanswered required consent the user was never told existed. Owner: **`w2-engine`** (`scan-page.js` field collection).

`qa-adversary` flagged the ordering hazard itself and it is real: making that control **visible** before it can **defer** converts a blindness into a bad tick, because shapes B and C prove the ordinary branch will tick whatever it can see. Item 1 must land first.

**3. Build the `--rescan` I approved.** Report-only, no writes, over the stored answer bank. Owner: **`w1-security`**. Two fact-base contaminations happened in one session and nothing rescans what is already stored.

**4. Raise the test floors.** `package.json` `testGate.full.floor` 946 → 1121 and `testGate.security.floor` 147 → 201. The gate prints this request itself. Owner: **`ci-engineer`** (it owns `package.json`; nobody else may edit it).

## Then: Phase 2, then Phase 3

Phase 2's tuning table is in the plan. Every latency claim must be a **number from `bench-apply.mjs` against the local fake board, before and after** — `innov-perf` owns `docs/measurements.md` and may reject an optimisation that does not move a number. Phase 3 builds the unattended runner, and **auto-submit ships `enabled: false, dry_run: true`** regardless of what else is done.

## Real-job testing — the user's explicit instruction

The user wants the team to **test against real job postings once it is sure the pipeline works**, and to **record every detail and failure so the team improves from them**. Sequence it carefully, because this is where an irreversible mistake becomes possible:

1. **Fake board first.** Everything must be green against `tests/fixtures/boards/` before any real posting is touched.
2. **Install Chromium** (`npx playwright install chromium`, ~150MB — `playwright-core` is already a devDependency). Three tests are skipped for want of it, and one says in its own skip reason _"run it before trusting consent auto-tick."_ Ask the user before downloading.
3. **No subagent ever drives a real employer's form.** That is a plan-level rule and it is what keeps the tree bounded. Real-board runs happen in the **main session with the user present**, via the `apply-job` skill and Playwright MCP. QA agents build fixtures; they do not visit employers.
4. **Hard rule 6 stands: the user clicks Submit.** Nothing auto-submits, on any path, until Phase 3 ships it disabled and the user turns it on after reading a dry-run report they trust.
5. **Record everything.** Each real run gets its failures, deferred fields and surprises written up, and each one becomes a fixture in `tests/fixtures/boards/` or `tests/fixtures/hostile/` so the same failure cannot recur silently. That is the improvement loop the user is asking for — a real failure that does not become a test is a failure that will happen twice.

## Researcher → QA: what a real posting looks like

The user's instruction: **the `researcher` should be helping the QA agents know what an accurate job posting and application form actually look like.** This is a standing collaboration, not a one-off.

Today's fixtures were built from the codebase's own knowledge of Greenhouse, Lever and Ashby. They are good, but they are inferred. `researcher` (owns `docs/research/*`, reads the open web) should supply QA with the real shapes: which ATS products actually dominate, how their forms are really structured, what field labels and consent wordings genuinely appear, which knockout questions are common, and how postings are really written. `qa-adversary` and `qa-breaker` then build fixtures against **observed** reality rather than inferred reality.

`researcher`'s first output is already committed under `docs/research/` — read it before re-researching. Its highest-value finding for this work: **mainstream ATS do not auto-reject on résumé content; the only true auto-reject is knockout questions**, which puts the answer bank at a higher-leverage layer than any keyword work.

**One correction to carry forward**: that report's question-3 recommendation does not survive checking. Observability/Kubernetes/Incident-response appear as top demanded skills only with `--include-dismissed`; among pursuable leads they are 3, 2 and 4 with `req=0`, and the 50 dismissed ones were dropped for relocation, staff-level seniority and non-software roles — none for lacking those skills. Counts were right, the inference from them was not.

## Standing rules that cost something to relearn

- **Clear a full agent's context between jobs.** Resuming keeps context, which is right _mid-job_ and wrong _between_ jobs. An agent that died on a session limit is always cleared. A cleared agent is **owed a handoff** — ownership belongs to the role, not the instance. Four agents were lost to session limits in one session, one partway through an owned file set.
- **Never run a whole-tree git command** while agents are live — no `stash`, `checkout .`, `reset --hard`, `add -A`. Ownership is exclusive _per file_ and does not protect the working tree. Path-scoped only; `git status` first.
- **A self-report is a claim, not evidence.** Verify against artifacts — read the diff, run the command. Several agents caught real defects this way, including one that found an error in a commit message I had written.
- **Use the third lens.** When two agents disagree, a third with a different lens breaks the tie. It was used twice and both times found something _both_ sides had missed — including that a control everyone believed was holding had never fired at all.
- **An auxiliary assertion placed before a finding assertion masks the finding.** Found twice in one day. Where a test pins a defect, the defect assertion must be the one that cannot be pre-empted.
- **Commit messages carry the reasoning, not just the change.** They are the durable record; this project's history is its documentation.

## Two things the user still owes, and one is blocking

**BLOCKING — the fact base holds 4 fabricated entries.** Two agents hit the same bug (`save-answer.mjs` silently ignoring an unknown flag, since fixed) and wrote `a-050`–`a-053` to `profile/answers.yaml`, falsely stamped `source: user`. `a-051` is a **fabricated phone number** that resolves `OK` on a label appearing on virtually every form — verified: `f1 OK a-051@exact 702-555-0134`. **No agent can remove them; rule 2 and a hook make `profile/` the user's alone.** Confirm with the user before any real-job run:

```bash
head -n 234 profile/answers.yaml > answers.tmp && mv answers.tmp profile/answers.yaml
```

That restores exactly 49 entries ending at `a-049`. **Check this has been done** — do not assume.

**Optional — Chromium** for the three skipped browser legs (see real-job testing above).
