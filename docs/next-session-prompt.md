# Next session — start prompt

Paste everything below the line into a fresh session.

---

Read `CLAUDE.md` first. **Do not read the autonomy plan (`docs/autonomy-plan-v2.md` or `docs/autonomy/`)** — neither task below is in it, and reading it has repeatedly pulled sessions into building runner infrastructure nobody asked for.

Two tasks. **Task 1 is the one that matters**: the unattended pipeline is built, proven against real employers, and sends nothing, because of one gate the user has explicitly asked to move.

## State as of 2026-08-04

- `dev` @ `dd28032`, gate **2153 tests / 0 fail** (floor 2113 — raise it to 2153 in `package.json` once two clean runs agree).
- **A Windows scheduled task `AgenticJobApplication` is live**, firing `scripts/auto/cycle.cmd` every 12 hours from 07:00, logging to `logs/` (gitignored). `schtasks /Query /TN "AgenticJobApplication"` to inspect, `/Delete` to stop it.
- `docs/application-limits.yaml` is **modified and uncommitted, and that is correct**. The user set `auto_apply.enabled: true`, `dry_run: false` and added QA/SDET titles themselves. It is their file; the guard hook and the harness classifier both refuse an agent commit of it. **Leave it. Do not stage it. Do not `git add -A`.**
- `scripts/apply/longform.mjs` is untracked and unwired — that is Task 2.

### What already works, verified against real employers

`scripts/auto/cycle.mjs` runs search → screen → prep → tailor → apply as one command, and the tailoring leg has **no model in it**: `assemble-resume.mjs` emits facts verbatim with their `<!-- fact:ID -->` ids, so rule 1 holds by construction and `verify-claims` still runs as the check. Measured: 24 annotated bullets, `verify-claims ok: true`, a rendered PDF.

`scripts/auto/stages.mjs` gives the runner a real browser. `tests/auto/browser-leg.test.mjs` drives a real Chromium through a real Greenhouse replica to `state=submitted` in ~4s. That test is the difference between "wired" and "works" — **keep it green**.

Three real leads (one Coinbase/Greenhouse, two Render/Ashby) reach the live form, fill it from the fact base, and stop. **Zero applications have been sent unattended.**

---

## Task 1 — let an exact-banked assertion fill unattended

### What the user approved, and on what basis

Every application defers on the work-authorisation question, classed `CONFIRM` — an answer the user _asserts_ rather than states. Asked directly, they answered **"I am"**; separately, on consent tickboxes, **"If it's required, tick it. If it's optional, don't tick it."**

Both were implemented in the previous session and **both were reverted**, because the suite caught a real regression. The reasoning lives in the code, not only here — read these two comment blocks before writing anything:

- `scripts/apply/fill-plan.mjs`, the `r.status === "CONFIRM"` branch, marked **"ATTEMPTED AND REVERTED"**
- `scripts/apply/fill-plan.mjs`, the `isConsent(label) || looksLikeAgreementProse(...)` branch

**The regression, concretely.** `tests/fixtures/hostile/forms/escalated-tickbox-yes.html` renders a control **labelled** _"Are you legally authorized to work in the United States?"_ whose value the server writes into `agree_arbitration`. The escalated variant renames `id`, `name` and `autocomplete` to agree with the lying label, defeating `fieldIdentityMismatch` by construction. The fixture bank answers that exact question — so "fill any exact-banked CONFIRM" ticks a jury-trial waiver. 32 tests went red, correctly.

### The decision made after seeing that

Those fixtures model a **hostile board** — a form built to lie about where values go. The user's `auto_apply.board_allowlist` is Greenhouse, Lever and Ashby. On a real ATS a custom question's answer is stored against _that question_: the employer writes the label, the vendor wires the storage. Making "work authorization" post into an arbitration column requires the **vendor** to be hostile, not the employer.

The residual employer-controlled risk is a **misleading label** — which is exactly what the `labelExact` vouch (the complete, visible text of the control's label) exists to catch.

**The user has approved re-baselining the threat model from "hostile board" to "hostile employer on a trusted ATS."** Deliberate work with a named cost, not a flag flip.

### What to build, in `scripts/apply/fill-plan.mjs`

1. **`CONFIRM` + an `@exact` bank hit → fill it**, recording every one in `plan.actuated` with its label, value and bank id.
2. **Required consent → actuate it.** Optional consent keeps today's behaviour (it defers; a deferred box is never ticked, which is already what the user asked for).
3. **`submitReadiness()` stops refusing merely because `plan.actuated` is non-empty.** That branch's own comment says why it existed — _"the user delegates assent when they hand over a URL, and an unattended run has no such instruction"_ — and the runner now has that instruction. **The record stays; only the refusal goes.**

### What must NOT move — check each before you finish

- **`@exact` only, never fuzzy.** Gotcha A: a fuzzy yes/no match returns the right concept with the **wrong truth value** ("authorized to work _without_ sponsorship"). Never auto-invert.
- **The `labelExact` vouch is now load-bearing, not decorative.** It is the only thing between a misleading label and an actuated assent. A required consent whose label cannot be vouched still defers, with the reason stated. `vouchedLabels` arrives **out of band** — `scanPage` → `stages.mjs`'s WeakMap → `buildPlan` — so a scan file on disk can never assert its own vouch. That must stay true.
- **`UNKNOWN` still blocks on both paths.** That is rule 1, and rule 1 did not move.
- **Rule 0 still blocks**: `labelFlag`, L3 findings, the trust gate, screening.
- **Nothing is composed or inferred.** Only the string the user recorded is filled.

### Re-baselining the ~32 tests

**Do not delete them, and do not weaken an assertion to make it pass.** Each encodes a real attack. The job is to re-encode the _threat model_:

- Tests proving a **hostile board** lies about a field's destination keep asserting a refusal — split the fixture so the board-hostile case still defers (not on the allowlist, or its label cannot be vouched).
- "A consent box is NEVER actuated" becomes "…never actuated **without a vouched label**".
- Every changed test needs a comment naming **what changed in the threat model, and when**. An expectation that flips with no recorded reason is how the next reader concludes the protection was never real.
- Main files: `tests/security/hostile-forms.test.mjs`, and ~17 in `tests/apply/fill-plan.test.mjs`.

### How you know it worked

A green gate is necessary, not sufficient. Run it live:

```bash
node scripts/auto/auto-apply.mjs --limit 3
```

`readAutoQueue` should show `state: submitted`. Expect the post-submit classifier to return `unclassified` on a real board — that is **not** a failure: the click went out, the outcome is unconfirmed, and `reconcile.mjs` resolves it. Then run `scripts/apply/capture-post-submit.mjs`, which is the only lawful way that corpus ever fills.

`node scripts/maintenance/migrate.mjs --reset-queue` clears terminal rows so a slug can be retried.

---

## Task 2 — the long-form composer ("500 words minimum" questions)

`scripts/apply/longform.mjs` is **written and untracked**. Pure and deterministic: `longFormPrompt(field)` detects a prose prompt structurally (a `<textarea>` is the signal — no list of prompt wordings to be defeated by rewording), `parseLengthDemand(text)` reads "500 words minimum" / "200-500 words" / "max 1000 characters" off the form's own text, and `draftShortfall(draft, need)` checks a draft against it. Read its header; the rationale is there.

Still to do:

1. **Wire a `compose` defer into `buildPlan`**, where a long-form field with no resolved value would otherwise become `unknown`/`SKIP`. Carry the prompt and the length requirement on the defer.
2. **Add an `answer` mode to `verify-claims.mjs`.** The CLI rejects any mode but `resume`/`cover-letter`, while `verifyDocument` already runs R4–R6 (numbers, dates and tech terms must exist in the fact corpus) for any non-resume mode. That is the truthfulness gate for generated prose: a draft naming a technology the user has never used fails R6 and never reaches the form.
3. **Map `compose` in `scripts/auto/taxonomy.mjs`** (`freetext-disclosure` fits). An unmapped `why` becomes a loud `plan-error`, which reads as "the planner is broken".
4. **A step in `.claude/skills/apply-job/SKILL.md`**: draft from profile facts → `verify-claims answer` → show it in the one approval message → never fill an unverified draft.
5. Tests: detection, length parsing (including a backwards "range"), the shortfall check, and that an unverified draft cannot become a plan item.

**Attended path only.** A model composing prose in response to a third-party prompt is the opposite of the deterministic understanding rule 6 requires, so a `compose` defer blocks the unattended runner. Do not relax that as a side effect of Task 1.

---

## Traps this repo will spring on you

- **`git add -A` sweeps the user's `docs/application-limits.yaml` into your commit.** It happened last session. Stage explicit paths.
- **The harness classifier intermittently blocks `npm test` and `node scripts/...`** with "Stage 2 classifier error … usually transient". Retry once; it normally succeeds. It blocks committing `docs/application-limits.yaml` **every** time — that one is correct, not transient.
- **A green suite proves very little about the runner.** Every runner test injects fakes for the browser, so the entire browser leg was unreachable and broken while the gate was green. Five defects last session were found by running it; none by reading it.
- **Fixtures encode assertions about code, and they can be wrong.** `tests/auto/auto-apply.test.mjs`'s `lead()` helper puts `screening` inside the lead doc — a shape production never writes — which is why a broken screening lookup passed for weeks. Prefer the real writer (`recordScreens`) in new tests.
- **`node --test <dir>` does not recurse on Node 24.** Use the quoted glob.
- **`.claude/skills/apply-job/scan-page.js` is the highest-risk file in the repo** and is in `.prettierignore` as a contract. Read it whole before editing; do not reformat.

## Standing decisions — settled, do not relitigate

1. **The agent clicks submit.** Hard rule 6. When the user gives a posting URL, the application is sent. A hand-off has been removed twice.
2. **Unlimited application volume.** 999 is deliberate; the caps in the user's own file are theirs.
3. **Speed is the top priority, second only to security.** Measured against Jobright.
4. **Never put the user's name or personal details in a markdown file.** Write "the user". They belong in `profile/` and generated `jobs/<slug>/` documents only.
5. **`docs/application-limits.yaml` and `profile/` are the user's.** Propose values; never edit them.
