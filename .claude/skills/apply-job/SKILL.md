---
name: apply-job
description: Apply to a job in the browser via Playwright MCP - capture the
  posting, tailor resume and cover letter, fill the application form from
  approved facts, and hand off to the user for the final submit. Use when the
  user gives a job posting URL to apply to, or asks to apply for a job.
---

Drive one job application end-to-end using the Playwright MCP browser tools.

Two design rules explain every step below:

1. **Batch by phase, not by field.** Scan the whole page in one call, resolve
   every answer in one call, decide in one pass, fill in one call, verify once.
   Never inspect-then-fill field by field.
2. **Spend human attention once.** The user is asked exactly twice per
   application: one approval message (tailoring + unknown questions + reuse
   offer, together), and the final Submit click. Everything that can be learned
   before that message — including what the form actually asks — is learned
   first, so it can ride along in it.

## Hard boundaries (never cross these)

- **NEVER click a button the scan classifies `r: "submit"`.** The user submits.
  Hard rule 6 was rewritten on 2026-07-31 to permit an unattended submit — but
  only on the Phase 3 auto path, behind a **mechanical** trust gate, and that
  runner does not exist (`scripts/auto/` holds guards and an audit record, not
  a runner). **This skill is not that path**, whatever ships there, and no
  reading of rule 6 authorises it to click submit.
- **Never click `r: "start"` on a page that already has fields** — on most ATSs
  the final button is worded "Apply"/"Submit Application" and the scanner cannot
  tell the difference by text alone.
- Never click `r: "auth"`, create accounts, log in, enter passwords, or handle
  payment/identity data. Login wall → pause, ask the user to log in in the
  Playwright window, then re-scan and continue.
- Never solve CAPTCHAs — hand off to the user.
- Every answer must come from `profile/profile.yaml` or `profile/answers.yaml`.
  Unknown → ask the user, `node scripts/profile/save-answer.mjs`, then fill.
  Rephrasing a fact is fine; deriving a number that is not in the profile
  (years of experience, salary, notice period) is inventing — ask instead.

## Model

This flow is mechanical — Sonnet-appropriate throughout. Delegate the tailoring
step to the Sonnet-pinned `job-worker` agent (step 5). If you are running on a
larger model, say so once and suggest the user switch the session model; do not
silently burn a frontier model on form-filling.

## Phase 1 — Set up (no browser)

1. **Preconditions**: Playwright MCP tools available (check `/mcp`) and
   `profile/profile.yaml` has `meta.approved_by_user: true`. Otherwise stop.
2. **Workspace, from the lead store first**. The sweep already captured
   company, title, location and description for every stored lead — re-reading
   the live page to extract the same fields is a model call spent on data
   sitting in the database. Try:

   ```bash
   node scripts/documents/new-job.mjs <slug> --from-lead "<posting url>"
   ```

   It matches on lead id, then url, then url with tracking params and trailing
   slashes stripped, and prints `description=<chars>` or `description=missing`.

   | result                        | do                                                                              |
   | ----------------------------- | ------------------------------------------------------------------------------- |
   | exit 0, `description=<n>`     | done — **no page read at all**                                                  |
   | exit 0, `description=missing` | read the page (step 2b) for the body only                                       |
   | exit 4                        | no stored lead — read the page (2b) and scaffold with `--company/--title/--url` |

2b. **Page read, only when the above says so**: `browser_navigate` to the URL,
then `browser_evaluate` with `() => document.body.innerText.slice(0, 6000)` —
cheaper and more complete than a snapshot for reading an ad. Extract company,
title, location, requirements.

3. **History check**: `node scripts/applications/check-applied.mjs "<Company>"`. Already
   applied → report it and get the user's go-ahead first.
4. **Requirements**: fill `job.json`'s `requirements` from the description.
   `--from-lead` leaves it empty on purpose — that is an extraction, not a
   stored field.

## Phase 2 — Open the form and read it BEFORE tailoring

Do not tailor yet. The form decides whether a cover letter is needed, whether
PDFs are needed at all, and what unknown questions exist — all of which belong
in the single approval message.

### A0. Which ATS is this? (0 calls)

`scripts/apply/ats/` is not a CLI — detection happens inside `fill-plan.mjs`.
What matters here is what it will decide:

- **greenhouse / lever / ashby** → the deterministic path below. The model fills
  nothing by hand.
- **workday** → `fill-plan.mjs` exits **3** with a hand-off message. Workday
  requires creating an account, which you are not permitted to do. Tell the user
  and stop; their answers are in `profile/answers.yaml`.
- **anything else** → `generic`. Same mechanism, same scripts; only the number
  of deferred fields goes up. This is the ONLY path where you reason about
  individual fields, and even then only about the deferred ones.

### A. Scan (1 call)

```
mcp__playwright__browser_run_code_unsafe
  { filename: ".claude/skills/apply-job/scan.driver.mjs" }
```

That installs the scanner (`scan-page.js`) as `window.__ajScan` for the whole
session and returns the page inventory: fields with labels, required flags and
**all dropdown options — native and custom, opened for you**; classified
buttons; and signals. Every element is stamped `data-aj="<key>"`, so
`[data-aj="f7"]` is a valid `target` for every Playwright tool.

After the first run, re-scan with the ~30-token call
`browser_evaluate () => window.__ajScan(false)` (`false` skips re-opening
dropdowns). It survives navigation. Only if that throws — or if
`browser_run_code_unsafe` is unavailable — paste the function from
`scan-page.js` into `browser_evaluate` instead.

**On a board you have applied to before, skip the probe.** Opening every
dropdown is the slow half of a scan, and `fill-plan.mjs` remembers each form's
shape in `jobs/.field-cache.json`, keyed by its required fields. So scan with
`__ajScan(false)` and let the planner supply the options; it prints
`cache=<hits>/<dropdowns>`. If that shows `0/N` with N above zero, the form is
new or changed — re-scan with the probe and continue.

Act on `kind` before anything else:

| `kind`    | do                                                                |
| --------- | ----------------------------------------------------------------- |
| `ad`      | click the `r: "start"` button, then re-scan                       |
| `form`    | continue to B                                                     |
| `login`   | stop; ask the user to log in, then re-scan                        |
| `confirm` | the application is in — skip to **After submission**              |
| `unknown` | read `heading` + `btns`; if genuinely nothing to do, ask the user |

Signals override: a CAPTCHA signal means hand off; an iframe signal means
`browser_navigate` to that embedded URL (Greenhouse/Lever/Ashby embeds cannot be
scanned or filled through the parent frame) and scan again.

### B. Resolve every field at once (1 call)

Write the scan JSON to `jobs/<slug>/scan-p<N>.json`, then build the plan:

```bash
node scripts/apply/fill-plan.mjs <slug>
```

This runs `answer-bank.mjs` internally (profile + answer bank only, never a
guess) and writes `jobs/<slug>/fill-plan.js` + `.json`. It prints:

- **`ready=true|false`** — whether any model judgment is still required. On
  `ready=true` there is nothing here to think about: go straight to D, fill,
  and hand over. On `ready=false` the `reason=` says why,
- **`submitReady=true|false`** — the stricter twin: is anything at all left
  undecided, consent included? **Neither flag authorises a submit click**, and
  nothing on this path clicks one.
- `items=<n>` — fields that will be filled with no model involvement,
- one `defer` line per field a human must answer (`defer\t<key>\t<why>\t<label>`),
  each with a reason: `consent` (an agreement — always yours to accept, never
  mine), **`confirm-widget`** (a checkbox or radio group; see below),
  `confirm` (an assertion the fact base would have filled, not stated),
  `unknown`, `needs-choice`, `maybe`,
- the exact **bootstrap** to run in step D.

Only the `defer` lines need your attention. Do not read the plan file, and do
not re-derive answers the planner already resolved.

If PDFs are not rendered yet the attachment rows defer with `no rendered
resume` — that is expected before approval; re-run this after rendering.

### C. Decide what work is actually needed (0 browser calls)

**Gate each decision on what it actually reads.** The three document decisions
below are **scan-derived**: they depend on which fields the form has. `ready` is
**defer-derived** — it answers only "does a model still have to think before the
engine can run?". Gating a scan-derived decision on `ready` is the same
class of mistake `readiness()` itself had while it counted consent defers as
blocking (see D+E), and it costs the same way: a form with one required
`confirm-widget` comes back `ready=false` and drags three decisions with it that
the widget cannot possibly change.

- **Cover letter?** Only if the form has a cover-letter field or accepts
  attachments beyond the resume, or the posting explicitly asks. Otherwise skip
  it and say so. This is a property of the scan; `ready` does not enter it.
- **PDFs?** Only if the scan has a `t: "file"` field. A form with no file input
  (some Workday and in-house forms) needs no render at all — that saves ~6s and
  a browser launch. If there is a rich-text/textarea resume box instead, the
  markdown text goes there.
- **Reuse?** `node scripts/documents/reuse-check.mjs <slug>` — if it returns
  `verdict=REUSE`, an existing tailored resume is close enough that re-tailoring
  is wasted work. Offer it in the approval message with the score; the user
  decides. Never reuse silently. **Skip the call entirely when the scan has no
  `t: "file"` field and no rich-text resume box** — there is nowhere to put a
  resume, so no verdict can change what you do next.

When every bullet above resolves to "nothing to do", C costs **zero calls and
zero turns**: it is a non-terminal reasoning step and folds into the next tool
call. Only `reuse-check` costs anything, and only when it runs.

Then work the non-`OK` rows from B in one pass — this half **is** defer-derived,
so it runs whenever B printed a `defer` line: pick options for
`NEEDS-CHOICE`/`MAYBE` from profile facts, and collect every remaining `UNKNOWN`
into a numbered list for the approval message. Record every question into
`job.json` `questions`.

**Every pick you make here goes into the approval message too** — field, the
options offered, and which one you chose. That is what makes it saveable in
Phase 4. A pick the user never saw is not saved.

**If other jobs are prepped, ask for all of them at once.** `answers.yaml` is
global, so an answer given here resolves the same question on every future
application:

```bash
node scripts/apply/pending-questions.mjs
```

It merges the defers of every prepped workspace, drops consent boxes (those stay
in the browser) and anything the fact base can already answer, and predicts what
the other jobs' boards will ask from the remembered form shapes. Fold its list
into this one approval message rather than asking again per job.

## Phase 3 — Tailor (delegated)

**First check whether this is already done.** If `jobs/<slug>/context.json` has
`resume.status` of `verified` (or `approved`/`rendered`), the pipeline
pre-tailored it — skip this phase entirely and carry `tailor.summary` from
`context.json` into the approval message. Re-tailoring verified work is pure
latency with the user watching. `node scripts/leads/prep-queue.mjs` is what keeps
that state populated ahead of time.

Otherwise, unless the user accepted a reuse, hand the tailoring to `job-worker` (Sonnet):
give it the slug and whether a cover letter is needed. It drafts `resume.md`
(+ `cover-letter.md`), runs `verify-claims`, and returns compact JSON including
`tailor.summary`. It does not render PDFs — that waits for approval.

## Phase 4 — The one approval message

Send a single message containing:

1. the tailoring summary (emphasized / dropped / rephrased vs. the general
   resume) — hard rule 5,
2. the numbered unknown questions, each with its available options,
3. **the picks you made** for `NEEDS-CHOICE`/`MAYBE` fields — field, options,
   chosen value — so the user can correct any of them,
4. the reuse offer, if `reuse-check` flagged one,
5. what will be filled and what will be left blank.

Then wait. On the reply, save **both** the user's answers and the picks they
just approved, in one batch:

```bash
node scripts/profile/save-answer.mjs "Q1" "A1" && \
node scripts/profile/save-answer.mjs "Degree" "Undergraduate (BS/BA)" --source model
```

`--source model` marks a pick as derived-and-approved rather than user-stated;
it is what makes a wrong one findable later (`--replace` corrects it, and it
refuses to touch anything the user said themselves). Use the form's **exact**
field label as the question and the **exact** option text as the answer —
`answer-bank.mjs` matches saved questions exactly, ahead of its label rules, so
that field comes back `OK` on every future application to this ATS. This is the
only thing here that compounds: the defer list shrinks as you apply.

**Never save a pick the user did not see in the message above.** Saving what
they approved is not a new trust assumption; saving a silent guess is.

Then render the PDFs — only now, only if the form needs files:

```bash
node scripts/documents/render-pdf.mjs jobs/<slug>/resume.md jobs/<slug>/resume.pdf
```

Later pages of the same application resolve those saved answers automatically in
B, so this message does not repeat unless a later page asks something new.

## Phase 5 — Fill, verify, advance

### D+E. Fill and verify (ONE call)

Re-run `node scripts/apply/fill-plan.mjs <slug>` **only after rendering PDFs or
saving new answers** — those are the two inputs a re-run can pick up. The
`reason=` names what is still outstanding.

**If you rendered nothing and saved nothing, do not re-run it.** The plan is a
pure function of the scan, the fact base and the rendered files; with all three
unchanged you get the same bytes and the same `reason=` back for a whole extra
turn. In particular a `confirm-widget` defer can **never** be cleared by a
re-run: the guard in `fill-plan.mjs` defers on the control being a checkbox or
radio group, not on whether the bank has an answer (it defers even when the
answer resolved `OK`), so re-running with a fuller fact base changes nothing.
Confirmed by `innov-perf` on 2026-07-31 — `benchPlan` twice on one slug,
byte-identical plan, same `ready=false`, same reason. Take a required
`confirm-widget` to the approval message instead.

**A consent checkbox on its own no longer makes `ready=false`** (changed
2026-07-31, AUDIT **H10** closed). Until then, consent defers counted as blocking
and nearly every board has one, so `ready=true` had never fired on a live
application — the fast path this skill documents had never once executed.
`readiness()` now asks only "does a **model** need to think before the engine can
run?", and a consent box does not, because the user ticks it in the browser they
are already reviewing. **Nothing ticks it for them** — that is hard rule 6, and
do **not** "fix" this by auto-ticking consent. So still expect `ready=false`
whenever a real question is unanswered, and fill either way.

**A `confirm-widget` defer is a checkbox or radio group, and it is never ticked
here either** — whatever class the answer bank gave the value. A tick carries
**assent on a control the board owns**, not a value, and "the fact base can
answer the underlying question" is not a licence to perform the act. Measured
against the real 49-entry fact base on a page of verbatim-banked labels
(Country, Gender, Veteran Status), 34 such fields auto-ticked before this guard;
now 0. Like consent, a **non-required** `confirm-widget` defer does not make
`ready=false` — it sits unticked on a form the user is reviewing anyway. A
**required** one does block, because the form insists on an answer and nobody
has reviewed one. Surface these in the approval message with the value the bank
resolved, so the user is ticking with the answer in front of them.

Then run the bootstrap it printed:

```
mcp__playwright__browser_run_code_unsafe
  { filename: "jobs/<slug>/fill-plan.js" }
```

`fill-plan.mjs` embeds both the engine source and this job's plan into that one
file and loads it whole via `filename` — a real, unrestricted filesystem read
on the MCP server, so nothing but that one path enters your context regardless
of how big the form or the plan is. This is deliberately **not**
`{ code: "..." }` with an `addScriptTag`-based loader: that inserts the engine
and plan into the page as an inline `<script>`, which any board with a
nonce-based CSP (Ashby) refuses to execute outright — `page.evaluate` instead
drives the page over CDP, which the page's CSP does not gate. The engine does
uploads first (they remount the form and invalidate every `data-aj`), then
fills — retrying once on a stale/detached-element error, since a React remount
can land between locating a field and interacting with it — then verifies, and
returns only what is not right:

```json
{ "ok": 24, "failed": 0, "deferred": 12, "ms": 5100,
  "failures": [],
  "verify": { "mismatch": [], "errors": [], "requiredEmpty": [], "landed": [], "revealed": [] },
  "revealed": [], "reconciled": [],
  "defer": [...], "next": { "btn": "b34", "label": "Submit application", "role": "submit" } }
```

Three of those keys are the verify pass telling you something the fill itself
could not know, and skipping them loses real information:

- **`revealed`** — required controls that are on the page, empty, and were in no
  scan and no plan, because the fill **created** them ("if yes, explain"). Treat
  each as a new defer: nothing is filled into them. Repeated back at the top
  level as `revealed` for convenience.
- **`reconciled`** — items that threw on a detached element and whose value the
  verify pass then found on the page anyway. They are already counted in `ok`;
  the list exists so the promotion is never silent. Do not re-fill these.
- **`verify.landed`** — the keys whose value is genuinely on the page. Its point
  is the failure list, not the successes: it is what turns a stale-element throw
  into a `reconciled` entry rather than a false failure.

**Do not follow this with a verification scan** — the verify already ran inside
that call, including a sweep of the page's own rendered error text (element
state alone lies on React forms).

If `failed` or `verify.mismatch` is non-empty, fix the cause in the fact base or
the plan and re-run the same bootstrap; the engine is idempotent, so a repeat is
safe. Two automatic retries, then take it to the user.

**Never hand-fill fields the plan already covers.** If you find yourself issuing
`browser_fill_form` or clicking dropdown options one at a time, you have left
this flow — go back to B.

### F. Advance or hand off

- A `r: "next"` button exists → `browser_click` it, then go back to A for the
  next page (the scanner is already installed — just re-scan). New unknowns on a
  later page get their own batched question round.
- Only a `r: "submit"` button is left → **stop**. Summarize field → value for
  the whole application, name anything left blank and why, and tell the user the
  form is ready for them to review and submit.

The engine reports `next` but has no verb that can click it — advancing is
always an explicit `browser_click` you make, and submitting is always the user.

## After submission

Once the user confirms they submitted:

```bash
node scripts/applications/log-application.mjs <slug> --company "<Company>" --title "<Title>" --url "<posting url>"
```

Update `context.json` statuses and confirm the log entry.

## Cost expectations

Per page, on a recognised ATS: **4 browser calls** — scan, write the scan to
`scan-p<N>.json`, fill-and-verify, and the click to advance. **Page 1 is 5**,
because it also pays the `browser_navigate`. Everything between them is Bash.
Two human touchpoints per application, total.

That number is counted, not guessed: `node scripts/dev/bench-apply.mjs --board
greenhouse --json` reports `round_trips` with the steps it counted, and on
2026-07-31 it returned **5** for greenhouse page 1
(`navigate, scan, scan-to-disk, fill, advance`). The older "2 browser calls"
line omitted `navigate` and the scan-to-disk write that step B requires before
`fill-plan.mjs` can run.

Baseline before this existed: ~30 browser calls and roughly 8 minutes for a
single Greenhouse form. If you are making per-field calls, taking accessibility
snapshots, pasting the scanner repeatedly, verifying after the engine already
verified, or asking the user questions one at a time, you have left the flow —
go back to A.
