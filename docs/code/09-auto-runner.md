# The unattended runner: applying without you watching

Everything else in this repository is a helper that you — or an AI agent talking
to you — start by hand. `scripts/auto/` is the part designed to run when nobody
is at the keyboard: a scheduled task that picks jobs out of the store, opens a
real Chromium browser, fills a real employer's application form, and clicks
Submit. It is the only place in the tree where something irreversible can happen
without a human in the loop, and that is why almost every line of it is a
_refusal_ rather than a capability. This document walks through the nine files
that make up the runner's core, one at a time, and states plainly what is armed,
what is deliberately blind, and what is currently broken.

**What you will learn here**

- Whether the unattended runner is switched on right now, and what it has
  actually done (answer: it is on, it has run live five times, and it has
  submitted nothing).
- The nine-state machine every application walks through, state by state, with a
  diagram — and why one of those states is deliberately unrecoverable.
- Why the browser pool refuses to run two jobs on the same _origin_ at once, and
  why "origin" and not "board" is the line that matters.
- All eleven named preconditions on the one submit click in the codebase, in the
  order they run, which of them leave no trace when they refuse, and which one
  writes a permanent record before anything is clicked.
- Why the click surface is exactly two files, and how a test keeps it that way.
- Five real defects found in a 2026-08-05 audit of these files, marked as such.

**Before this**

You do not need to have read the others, but these help:

- [`../guide/05-architecture.md`](../guide/05-architecture.md) — how the whole
  pipeline fits together.
- [`../guide/06-data-model.md`](../guide/06-data-model.md) — the SQLite database
  (`jobs/leads.db`) and its tables.
- [`../guide/07-safety-model.md`](../guide/07-safety-model.md) — the hard rules
  this subsystem exists to enforce.
- [`../guide/08-glossary.md`](../guide/08-glossary.md) — vocabulary.
- [`10-auto-safety.md`](10-auto-safety.md) — the sibling document covering the
  gates this one keeps calling: `trust.mjs`, `authorize.mjs`, `taxonomy.mjs`,
  `audit.mjs`, `breaker.mjs`, `classify.mjs`, `guard.mjs`, `preflight.mjs`,
  `reconcile.mjs`.
- [`08-apply-filling.md`](08-apply-filling.md) — the scan/plan/fill engine that
  the runner reuses unchanged.

**The files covered here**

| file                          | lines | one-line purpose                                                      |
| ----------------------------- | ----: | --------------------------------------------------------------------- |
| `scripts/auto/auto-apply.mjs` |   756 | the runner's command-line entry point: args, selection, browser, pool |
| `scripts/auto/job.mjs`        |   568 | the per-job state machine — one application, start to finish          |
| `scripts/auto/cycle.mjs`      |   486 | one whole cycle: find → screen → reverify → prep → tailor → apply     |
| `scripts/auto/stages.mjs`     |   189 | the four injected browser stages (`scan`, `plan`, `fill`, `classify`) |
| `scripts/auto/pool.mjs`       |   185 | the worker pool, partitioned by origin                                |
| `scripts/auto/caps.mjs`       |   114 | the blast-radius arithmetic (per-run / per-day / per-company caps)    |
| `scripts/auto/advance.mjs`    |   263 | `advanceOnce()` — clicks a `next` control, never a submit             |
| `scripts/auto/multipage.mjs`  |   285 | `walkPages()` — resolve a multi-page form one page at a time          |
| `scripts/auto/submit.mjs`     |   532 | `submitOnce()` — the one submit click and its eleven preconditions    |

---

## Is this thing on? (verified 2026-08-05)

Older documents in this repository say the unattended runner cannot open a
browser and cannot reach a click. **That is no longer true, and repeating it
would be dangerous.** Here is what the files and the database actually say
today.

### The switch is on

`docs/application-limits.yaml` is _your_ file — no script in this repository
writes it. Its `auto_apply` block currently reads:

```yaml
auto_apply:
  enabled: true
  dry_run: false
  per_run_max: 10
  per_day_max: 10
  per_company_max_per_week: 5
  cache_max_age_days: 30

  board_allowlist:
    boards.greenhouse.io: greenhouse
    job-boards.greenhouse.io: greenhouse
    jobs.lever.co: lever
    jobs.ashbyhq.com: ashby
```

`auto-apply.mjs` turns that into a mode with one line:

```js
const mode = auto?.dry_run === false ? "live" : "dry_run"
```

Note the polarity: the value has to be _literally the boolean `false`_ to get
`"live"`. A missing key, a `null`, or the string `"false"` all leave you in
`dry_run`. Today the file holds a real boolean `false`, so **`mode` resolves to
`"live"`**.

The runner also genuinely opens a browser now. `auto-apply.mjs`'s `main()` calls
`launchBrowser({ userDataDir, headless, localOnly })`, and
`scripts/apply/browser.mjs` calls `chromium.launch(...)` inside it. It also
builds real page-handling stages with `makeStages({ jobsDir })` rather than
waiting for a test harness to inject fakes.

### And it has submitted nothing

Reading `jobs/leads.db` (read-only) on 2026-08-05:

| table              | what is in it                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| `auto_runs`        | five rows, all `mode = 'live'`, all on 2026-08-04 between 02:22 and 02:56 UTC, all `outcome = 'ok'` |
| `auto_submissions` | **empty** — zero rows, so not one click has ever been issued                                        |
| `auto_queue`       | three rows, all `state = 'deferred'`, all `reason_stage = 'plan'`                                   |

The last of the five runs recorded `planned = 3, submitted = 0, deferred = 3,
failed = 0`. The three queue rows say exactly why nothing went out:

| slug                          | board_key                                | reason_kind       | first deferred field                                                     |
| ----------------------------- | ---------------------------------------- | ----------------- | ------------------------------------------------------------------------ |
| `coinbase-software-engineer`  | `job-boards.greenhouse.io/embed?for=...` | `consent-tickbox` | "Please confirm receipt of the above linked Global Data Privacy Notice…" |
| `render-swe-compute-infra`    | `jobs.ashbyhq.com/render`                | `confirm-field`   | "Are you legally authorized to work in the United States of America?"    |
| `render-user-auth-experience` | `jobs.ashbyhq.com/render`                | `confirm-field`   | "Are you legally authorized to work in the United States of America?"    |

So the honest summary is:

> **The runner is armed and it is refusing.** The click is reachable — the
> wiring is no longer what stops it. What stops it is that every job so far hit
> a field the machine will not answer on your behalf: a consent tickbox and a
> work-authorisation question. Both of those are _assent_ deferrals, the
> category the hard rules say may never shrink.

There is a second thing standing between the runner and a real submission even
if every field resolved cleanly. The post-click page classifier
(`scripts/auto/classify.mjs`) is built, but every one of its rules was written
against a locally-served fixture page rather than a real board, and a
fixture-sourced rule is only permitted to fire on a loopback address (`localhost`
/ `127.x.x.x`). On a real Greenhouse, Lever or Ashby confirmation page it
therefore answers `unclassified`, and `job.mjs` turns `unclassified` into the
failure kind `post-submit-unclassified`. That is deliberate, not a gap to route
around — see [`10-auto-safety.md`](10-auto-safety.md).

---

## Orientation: the three vocabularies

Everything in this subsystem speaks three closed vocabularies. A **closed
vocabulary** here means a fixed list defined in one place in code; writing a
value that is not on the list throws an error rather than being stored. That is
what makes it possible to later ask "how many applications did consent tickboxes
cost me this week?" with a database `GROUP BY` instead of a text search.

### 1. The nine queue states

Defined in `scripts/lib/db.mjs` as `AUTO_QUEUE_STATES`:

```
queued, claimed, planned, authorized, attempted,
submitted, challenged, deferred, failed
```

Two subsets matter:

- `AUTO_QUEUE_TERMINAL` = `{submitted, challenged, deferred, failed}` — nothing
  further happens to a job in one of these.
- `AUTO_QUEUE_RESUMABLE` = `{queued, claimed, planned, authorized}` — the states
  a crashed run can be picked back up from.

**`attempted` is in neither set, on purpose.** A job sitting at `attempted` means
a click may already have gone out. Retrying it automatically could send a second
application to the same employer, so it is left for a human. The schema comment
in `db.mjs` puts it bluntly: re-running an attempt "is the carpet-bomb this whole
machinery exists to prevent".

### 2. The closed reason kinds

Any terminal row that is not `submitted` must carry a `reason_kind` from one of
three frozen lists in `db.mjs`:

- **`AUTO_DEFER_KINDS`** — we chose not to send. Includes `confirm-field`,
  `confirm-widget`, `consent-tickbox`, `unknown-field`, `unprobed-dropdown`,
  `fill-failed`, `identity-verification`, `captcha`, `bot-challenge`,
  `email-code-challenge`, `multipage-unresolvable`, `freetext-disclosure`,
  `doc-unverified`, `fact-base-changed`, `board-untrusted`, `l3-rejected`,
  `cap-company`, `posting-gone`, `board-paused`, `reconciled-not-sent`.
- **`AUTO_FAILURE_KINDS`** — we malfunctioned: `nav-timeout`, `browser-crash`,
  `token-refused`, `origin-mismatch`, `post-submit-unclassified`,
  `db-write-failed`, `plan-error`.
- **`AUTO_CHALLENGE_KINDS`** — the only kinds a `challenged` row may carry:
  `captcha`, `bot-challenge`, `email-code-challenge`.

The distinction between _deferred_ and _failed_ is worth internalising:
**deferred means the system worked correctly and declined; failed means the
system broke.** They are counted separately for exactly that reason.

### 3. The seven stages

`scripts/auto/taxonomy.mjs` exports `STAGES`:

```
queue, claim, plan, authorize, attempt, post-submit, reconcile
```

Every terminal row records both a kind _and_ the stage it happened at, because
the same kind means different things at different stages. `posting-gone` at
`plan` is a lead that rotted between screening and today; `posting-gone` at
`post-submit` is the employer closing the req in the seconds while your click was
in flight.

---

## The per-job state machine

Every application is one row in the `auto_queue` table, keyed by its slug (the
short folder name like `render-swe-compute-infra`). The row moves through states,
and **every move is a database write before the next thing happens**, so a
power cut leaves a row that says exactly how far the job got.

```text
                      ┌────────────┐
  enqueueAutoJobs()   │   queued   │  selected and eligible; nobody owns it
  ───────────────────▶└─────┬──────┘  RESUMABLE
                            │
                            │  claimAutoJob(db, slug, {...})
                            │  → 1  = this worker now owns the slug
                            │  → 0  = someone else owns it; this worker returns
                            │         the non-state "not-claimed" and touches
                            │         nothing. NORMAL, not an error.
                            ▼
                      ┌────────────┐
                      │  claimed   │  attempt_no += 1, claimed_at stamped
                      └─────┬──────┘  RESUMABLE
                            │
                            │  trustBoard()   ─── refuses ──▶ deferred/failed
                            │  openPage()     ─── refuses ──▶ failed (nav-timeout)
                            │  scanStage() + planStage()  (per page)
                            ▼
                      ┌────────────┐
                      │  planned   │  plan_sha256 written; re-written per page,
                      └─────┬──────┘  then once more with the MERGED plan's hash
                            │         RESUMABLE
                            │  authorizeSubmit() minted a token
                            ▼
                      ┌────────────┐
                      │ authorized │  every gate passed; a single-use token exists
                      └─────┬──────┘  RESUMABLE
                            │
                            │  written BEFORE submitOnce() is even called
                            ▼
                      ┌────────────┐
                      │ attempted  │  ✱ NOT RESUMABLE ✱
                      └─────┬──────┘  a click MAY already have been issued
                            │
        ┌───────────┬───────┴────────┬──────────────┐
        ▼           ▼                ▼              ▼
  ┌───────────┐ ┌────────────┐ ┌────────────┐ ┌──────────┐
  │ submitted │ │ challenged │ │  deferred  │ │  failed  │
  └───────────┘ └────────────┘ └────────────┘ └──────────┘
   it went out   a click went    we chose not   we broke
   (or the       out; we do      to send, and   (reason_kind
   rehearsal     not know if     reason_kind    from
   completed)    it landed       says why       AUTO_FAILURE_KINDS)

  NOTE: deferred and failed are reachable from EVERY earlier state, not only
  from `attempted`. Almost all real deferrals happen at `claimed` or `planned`,
  long before anything could be clicked — all three rows in the live store
  today are `deferred` at stage `plan`.
```

Two properties are the whole point of this design, and `job.mjs`'s own header
states them:

> 1. EVERY TRANSITION IS A DURABLE WRITE, and nothing lives in process memory
>    across a job boundary that cannot be re-derived from the database. The run
>    is not a recovery unit; the job is.
> 2. EVERY EXIT IS TYPED. There is no path out of this function that leaves a
>    job without a `reason_kind` from the closed taxonomy… The one exit with no
>    reason is `submitted`, which has nothing to explain.

### What a claim returning 0 means

`claimAutoJob(db, slug, opts)` runs one SQL statement — an insert with a guarded
conflict clause — and returns the number of rows it changed. It returns `1` when
this worker now owns the slug, and `0` when it does not.

**A `0` is not an error.** In a fan-out where several workers are pulling from
the same queue, `0` is the ordinary result for every worker but one. It means
either another worker got there first, or the row is already in a state that
cannot be claimed (`attempted`, or any terminal state). `runJob` handles it in
three lines and the comment explains why it writes nothing at all:

```js
// 0 changes means another worker owns it, or it is already terminal. Either
// way this worker touches nothing — writing a reason here would overwrite
// the owner's.
return done(NOT_CLAIMED, null)
```

`NOT_CLAIMED` is the exported string `"not-claimed"`. It is deliberately _not_
one of the nine queue states: it never gets written to the database, it is only
the value the losing worker hands back to the pool so the pool can move on.

---

## `scripts/auto/auto-apply.mjs` — the entry point

### 1. What it is and why it exists

This is the command you (or a scheduler) run. Without it every other module in
`scripts/auto/` is a library with nobody calling it. Its job is narrow: parse
arguments, read your limits file, refuse early if something is wrong, work out
which jobs are eligible, open a browser, hand the queue to the pool, close down,
and print the run record.

Its second job is architectural, and its own header says so:

> It parses args, opens the database, launches the browser, drives the pool,
> closes down and writes the run record. IT CONTAINS NO CLICK, no trust decision,
> no cap arithmetic and no retry policy. Every one of those lives in a module
> with a test against it, and the reason to keep them out of the entry point is
> that this is the file people edit when they want the runner to "just also do
> X".

That is a rule about future edits, not about today's code. If you find yourself
adding a decision here, add it to the module that owns that decision instead.

### 2. How you run it

```bash
# work up to 10 queued jobs, one at a time (the normal invocation)
node scripts/auto/auto-apply.mjs --limit 10 --concurrency 1

# just fill the queue and stop — writes auto_queue rows, opens no browser
node scripts/auto/auto-apply.mjs --enqueue --limit 25

# machine-readable output (one JSON object on stdout)
node scripts/auto/auto-apply.mjs --json

# loopback fixture mode, against a throwaway database
node scripts/auto/auto-apply.mjs --fixture --db /tmp/leads.db --limits /tmp/limits.yaml
```

`--help` prints the usage block and exits 0. Real output, captured 2026-08-05:

```text
auto-apply.mjs — the unattended application runner

  --limit N          how many queued jobs this invocation may work (default 25)
  --concurrency N    workers; at most one job per origin regardless (default 1)
  --db <file>        the store. Defaults to jobs/leads.db
  --limits <file>    the limits document. Defaults to docs/application-limits.yaml
  --jobs-dir <dir>   workspace root. Defaults to jobs/
  --enqueue          select eligible jobs into auto_queue and stop
  --fixture          loopback fixture mode: widens the trust gate to loopback
                     http and REFUSES to run against the real lead store
  --json             machine-readable output
```

A normal (non-JSON) run prints one progress line per job to stderr and one
summary line to stdout:

```text
  render-swe-compute-infra: deferred
  coinbase-software-engineer: deferred
run=2026-08-04T02-55-53-304Z-c1900f mode=live outcome=ok submitted=0 deferred=0 failed=0
```

> **Known defect (2026-08-05 audit).** The `submitted=`, `deferred=` and
> `failed=` numbers on that summary line are **structurally always zero**.
> `runCampaign` returns an object with the keys `run_id, mode, outcome,
concurrency, origins, max_in_flight, started, skipped, results, counts,
stop_reason, paused_boards` — there is no `submitted`, `deferred` or `failed`
> key, so `result.submitted ?? 0` always falls through to `0`. `cycle.mjs`
> prints the same phantom number from the parsed JSON. The real numbers exist:
> `result.counts` is `autoQueueCounts(db)` (a per-state tally) and
> `result.results` carries every per-job outcome. They are simply not surfaced.
> For a user whose only view of an unattended run is that one line, this reads
> as "the runner sent nothing" even on a run that sent something.

> **Known defect (2026-08-05 audit).** The per-job progress line prints
> `r.reason_kind`, but `runJob` returns the field as `kind`, never
> `reason_kind`. The parenthesised reason is therefore never shown — you see
> `deferred` with no explanation. The reason is in the database
> (`auto_queue.reason_kind`), so nothing is lost, but the line is less useful
> than it looks.

### 3. Everything it exposes

**Command-line flags**

| flag               | default                        | meaning                                                                                          |
| ------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------ |
| `--limit N`        | 25                             | how many queued jobs this invocation may work                                                    |
| `--concurrency N`  | 1                              | how many workers run at once; at most one job per origin regardless                              |
| `--db <file>`      | `jobs/leads.db`                | the SQLite store                                                                                 |
| `--limits <file>`  | `docs/application-limits.yaml` | your limits document                                                                             |
| `--jobs-dir <dir>` | `jobs/`                        | the workspace root holding `jobs/<slug>/`                                                        |
| `--enqueue`        | off                            | select eligible jobs into `auto_queue` and stop — no browser, no clicks                          |
| `--fixture`        | off                            | loopback fixture mode: widens the trust gate to plain-http loopback, refuses the real lead store |
| `--json`           | off                            | print one JSON object instead of prose                                                           |
| `--help` / `-h`    | off                            | print usage, exit 0                                                                              |

A numeric flag that is not a positive integer throws immediately:
`--limit 0` or `--limit abc` produces
`--limit must be a positive integer, got "abc"` on stderr and exit code 2.

**Environment variables**

| variable       | effect                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------ |
| `AUTO_PROFILE` | a directory path. Set → the persistent browser lane (one shared Chromium profile on disk). |
| `AUTO_HEADED`  | any truthy value → `headless: false`, so you can watch the browser work.                   |

**Exit codes** (imported from `preflight.mjs`'s frozen `EXIT` object; they
deliberately reuse `save-answer.mjs`'s numbering so a wrapper script can tell
refusals apart by number alone):

| code | name                 | meaning                                                                      |
| ---: | -------------------- | ---------------------------------------------------------------------------- |
|    0 | `OK`                 | ran (or printed help, or found nothing eligible)                             |
|    1 | `REFUSED`            | a gate said no: fixture isolation, preflight, or the browser would not start |
|    2 | `USAGE`              | a bad flag                                                                   |
|    3 | `INSTRUCTION_SHAPED` | preflight found instruction-shaped text where a fact should be               |
|    4 | `SENSITIVE`          | preflight found a government or financial identifier                         |

**Exported functions**

| signature                                                              | returns                                                                                                                       |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `parseArgs(argv)`                                                      | `{limit, concurrency, db, limits, jobsDir, fixture, enqueueOnly, json, help}`; throws on a bad numeric flag                   |
| `assertFixtureIsolation({fixture, dbFile, realDbPath = DB_PATH})`      | `true`, or throws                                                                                                             |
| `selectEligible({db, limits, jobsDir, allowLoopbackHttp, limit, now})` | `{jobs, rejected, considered, at}`                                                                                            |
| `makeOpenPage(session, {localOnly = true})`                            | an `async (url) => {page, url, status, close}` function                                                                       |
| `runCampaign({...})`                                                   | `{run_id, mode, outcome, concurrency, origins, max_in_flight, started, skipped, results, counts, stop_reason, paused_boards}` |
| `defaultDocuments(slug, {jobsDir})`                                    | `{resume, cover, verification}` where `verification` is `{doc_sha256, profile_sha256, mode: "resume"}`                        |
| `main(argv)`                                                           | `Promise<number>` — an `EXIT` code                                                                                            |
| `HERE`                                                                 | this file's directory, as a string                                                                                            |

### 4. How it works, step by step

`main(argv)` runs in this order:

1. **Parse args.** On a throw, write the message to stderr and return exit 2.
2. **`--help`** → print usage, return 0.
3. **Resolve paths** for the database, the limits file and the jobs directory.
4. **`assertFixtureIsolation`.** On a throw, stderr and exit 1.
5. **`readLimits(limitsFile)`** (from `trust.mjs`). Returns `null` if the file is
   absent, but **throws** on malformed YAML — silently treating unparseable YAML
   as "no config" is how a typo turns into an open gate.
6. **Decide the mode** — `dry_run === false` → `"live"`, anything else →
   `"dry_run"`.
7. **`preflight(...)`** — the "would a run start right now?" check, which reads
   your fact base as well as your caps. If it refuses _and_ this is not an
   `--enqueue` invocation, each failing check is printed as
   `  - <id>: <detail>` and its exit code is returned.
8. **`allowlistProblems(...)`** — each problem in the board allowlist printed
   once as `allowlist: <problem>`. The comment explains why this is worth a
   dedicated message: "A misconfigured allowlist reads as 'every board is
   untrusted', which sends the user looking at their boards instead of at their
   typo."
9. **Open the database, run `selectEligible`** — and call `enqueueAutoJobs`
   **only** when `--enqueue` was passed. This is load-bearing:

   > WITHOUT `--enqueue` THIS COMMAND WRITES NOTHING… The first version selected
   > and enqueued unconditionally and then refused to run — leaving `auto_queue`
   > rows in the user's real store as a side effect of a command that had just
   > said no.

10. **`--enqueue`** → print `enqueued=N considered=M rejected=K` and return 0.
11. **Nothing eligible** → print
    `auto-apply: nothing eligible (N considered, K rejected). Nothing to do.`
    and return 0.
12. **Read `profile/profile.yaml`** for `meta.approved_by_user === true`.
13. **`makeStages({ jobsDir })`** — build the four real browser stages.
14. **`launchBrowser(...)`** — on a throw, print
    `auto-apply: could not start a browser — <msg>` and return exit 1.
15. **`runCampaign(...)`** inside a `try/finally` that always closes the browser
    session.
16. **Print the result** and return 0.

#### `selectEligible` and its walk direction

This is the function that decides which slugs are even candidates, and the
_direction_ of its walk is a safety property:

> THE WALK IS OVER VERIFICATIONS, NEVER OVER `jobs/`. `verifiedResumeUrls` starts
> from the verification rows and asks "do these exact bytes still exist, and does
> their workspace name a URL?" — so a workspace with a resume and no passing row
> is never reached. Walking `jobs/` and asking "is there a resume here?" is the
> direction that used to pass unverified documents.

The steps:

1. `verifiedResumeUrls(db, {...})` → a `Map` from posting URL to slug, built from
   the `verifications` table.
2. `SELECT * FROM leads` → an index keyed on **both** `lead.apply_url` and
   `lead.url`.
3. Two screening indexes: `screenIndex(db, "model")` then
   `screenIndex(db, "mechanical")`, both keyed by `lead.id`. This carries a long
   comment recording a measured defect that made the whole runner look empty:

   > WHERE A SCREENING VERDICT ACTUALLY LIVES, and this was a real defect: the
   > `screens` TABLE, keyed by `(lead_id, source)` — never on the lead's own JSON
   > doc. This function read `lead.screening ?? lead.screen`… so EVERY lead
   > looked unscreened, the trust gate refused all of them, and the runner
   > reported "nothing eligible" on a store whose leads had all been screened.
   > Measured 2026-08-03: 12 of 14 leads carrying a usable apply_url were
   > rejected for "no stored screening verdict" minutes after `screen.mjs` had
   > written 27 of them.

4. For each URL, up to `--limit`:
   - Take the lead's `apply_url`.
   - `detectAts(posted)` picks the board adapter; if it has an
     `applicationUrl()` function, use it to convert the **posting** URL into the
     **form** URL. Another measured defect:

     > THE POSTING AND THE FORM ARE DIFFERENT PAGES on every board this repo
     > adapts, and the runner was being handed the posting. It scanned a job ad,
     > found no fields, and deferred "nothing to fill" — measured on a real lead
     > 2026-08-03.

     It is resolved **once, here**, so "the trust gate, the board key, the submit
     token's origin binding and the navigation all agree on ONE url."

   - `submitOrigin(applyUrl)` → the origin string.
   - `trustBoard(...)` → pass or a stated reason.
   - Failed → push `{slug, reason}` onto `rejected`. Passed → push a queue row.

**Worked example.** Suppose the store holds one verified job.
`verifiedResumeUrls` yields
`Map { "https://boards.greenhouse.io/acme/jobs/4012" => "acme-senior-fullstack" }`.
The lead row carries `company: "Acme"`, `title: "Senior Full-Stack Engineer"`,
`posted_at: "2026-07-30T00:00:00Z"`, and the `screens` table holds a passing
model verdict. `detectAts` returns the Greenhouse adapter; its
`applicationUrl()` rewrites the posting into the embedded form URL. The row that
comes out looks like:

```json
{
  "slug": "acme-senior-fullstack",
  "board_key": "boards.greenhouse.io/embed",
  "origin": "https://boards.greenhouse.io",
  "apply_url": "https://boards.greenhouse.io/embed/job_app?token=4012",
  "posted_at": "2026-07-30T00:00:00Z",
  "company": "Acme",
  "title": "Senior Full-Stack Engineer",
  "screening": { "…": "the model verdict row" }
}
```

`screening` is carried on the row because `runJob` later hands it to
`authorizeSubmit`, which refuses an unscreened lead outright.

#### The two browser lanes

`makeOpenPage(session, opts)` returns a function that opens one page for one job.
Which of two lanes you get is decided by whether `session.browser` exists, and
that in turn is decided by the `AUTO_PROFILE` environment variable:

- **No `AUTO_PROFILE` (the default) — the non-persistent lane.** `launchBrowser`
  called `chromium.launch()`, so the session carries a `browser` handle. Each job
  gets `browser.newContext()` — a completely fresh cookie jar and `localStorage`
  area — and the whole context is closed when the job ends. Nothing is written to
  disk.
- **`AUTO_PROFILE` set — the persistent lane.** `launchBrowser` called
  `chromium.launchPersistentContext(dir, ...)`, which returns **no** `browser`
  handle. Every job gets a page on one shared context, so cookies and
  `localStorage` are shared between jobs.

The docstring says why that difference matters for the pool:

> NON-PERSISTENT LANE… Genuine per-job cookie and localStorage isolation, no
> profile copy, nothing on disk… This is what makes "at most one job per origin"
> a courtesy rather than a load-bearing security control.
>
> PERSISTENT LANE (`AUTO_PROFILE`…): one page on the shared context, and the
> origin exclusion in pool.mjs is then doing real work.

> **Known defect (2026-08-05 audit).** `makeOpenPage(session, { localOnly = true })`
> accepts `localOnly` and **never reads it in the body**. Both lanes call
> `page.goto(url)` directly, not `session.goto(url)` — and `session.goto` is the
> wrapper in `browser.mjs` that runs `assertAllowedTarget(url, {localOnly})`, the
> guard that refuses a non-loopback URL. `main()` passes
> `localOnly: !!args.fixture` believing it confines a fixture run to
> `localhost`. It does not. A `--fixture` run pointed at a real board would
> navigate there. Either use the parameter or delete it; a guard that silently
> does nothing is worse than no guard.

#### `runCampaign`, in order

1. `openDb(dbFile)` — one connection for the whole run, closed in a `finally`.
2. `releaseStaleAutoClaims(db, {leaseMs: staleClaimMs})` — hand back any job a
   dead worker is still holding. The comment on this call is the only place
   resume latency is documented anywhere:

   > THIS LEASE IS THE ONLY THING CONTROLLING RESUME LATENCY… a job crashed at
   > 'planned' is handed back by the reader and then refused by the claim — 0
   > changes, `not-claimed`, no work done — until this call has moved it back to
   > 'queued'. At the 30-minute default, a runner that crashes at 21:00 and
   > restarts at 21:05 does nothing until 21:30.
   >
   > Shortening it is SAFE and merely wasteful… the cost of a lease that is too
   > short is duplicated planning, never a duplicated application.

3. Enqueue the freshly selected jobs.
4. `readResumableAutoJobs(db).slice(0, limit)` — "A run is a CURSOR over
   `auto_queue`. Resume-after-crash is a SELECT, not a log replay: nothing in the
   tree reads the JSONL for state, and nothing shall."
5. `startRun({mode, dbFile, meta: {...}})` from `audit.mjs` — this is what writes
   the `auto_runs` row and opens the per-run JSONL log.
6. `makeBreaker({db, runId, now})` — the anomaly breaker. Its pause state is
   deliberately **not** persisted between invocations, because a pause is a timed
   backoff with probe re-admission and carrying one forward without re-probing
   would be wrong.
7. `runPool({jobs, concurrency, shouldStop, onResult, onSkip, runOne})`:
   - `shouldStop: () => breaker.runStopReason` — this is the **run-level** stop
     only. A board-level pause never reaches here; that is the whole distinction.
   - `onSkip(job, reason)` writes `deferred` / `board-paused` / stage `queue` for
     every job the run never reached, wrapped in a `try/catch` carrying the
     comment `/* a stranded-job note must never be the thing that throws */`.
   - `runOne(row)` asks `breaker.admit(row)` first (a paused board writes
     `board-paused` and returns without touching the browser), rebuilds the lead,
     picks the documents, calls `runJob(...)`, and then feeds the outcome to
     `breaker.record(...)` — **including the successes**, because a success is
     what clears a pause.
8. `run.finish({outcome: pool.stopped_reason ? "stopped" : "ok"})`, then build
   and return the run record. `paused_boards` is included because paused boards
   are a first-class run outcome — "A run that quietly held back a third of its
   queue while reporting `ok` is the failure mode this prevents."

### 5. What it reads and writes

**Reads:** the whole `leads` table; `screens` (via `screenIndex`);
`verifications` (via `verifiedResumeUrls` / `hasPassingVerification`);
`auto_queue` (via `readResumableAutoJobs`, `autoQueueCounts`);
`docs/application-limits.yaml`; `profile/profile.yaml`; and the existence and
hashes of `jobs/<slug>/resume.md` and `jobs/<slug>/cover-letter.md`.

**Writes:** `auto_queue` rows (`enqueueAutoJobs`, `setAutoJobState`,
`releaseStaleAutoClaims`), plus everything `audit.mjs` writes — the `auto_runs`
row, the run's JSONL log under `jobs/.auto/runs/<run_id>.jsonl`, and (at click
time, from inside `submit.mjs`) `auto_submissions`.

The `auto_queue` columns are: `slug TEXT PRIMARY KEY`, `run_id`, `board_key`,
`origin`, `state NOT NULL`, `attempt_no INTEGER NOT NULL DEFAULT 0`,
`plan_sha256`, `reason_kind`, `reason_stage`, `reason_detail`, `posted_at`,
`claimed_at`, `updated_at`, with indexes `idx_auto_queue_state` and
`idx_auto_queue_run`.

> **Known defect (2026-08-05 audit).** `auto_queue` has **no `apply_url` column
> and no `company` column**, but `runCampaign`'s `runOne` does
> `const applyUrl = seed.apply_url ?? row.apply_url ?? null` — `row.apply_url` is
> always `undefined`. `seed` comes from a map built only from the jobs _this
> invocation_ selected. `readResumableAutoJobs` orders by slug while
> `selectEligible` yields verification order and stops at `--limit`, so the two
> sets diverge easily (a crashed 25-job run followed by `--limit 10`, for
> instance). A resumed slug with no seed gets `apply_url: null`, `trustBoard`
> then fails its first check with "the lead carries no apply_url — Phase 0.13
> canonicalization did not resolve this lead", and `runJob` writes a **terminal**
> `deferred` / `board-untrusted` row that is never retried — blaming
> canonicalisation for what is actually a missing column. The fix is
> deterministic: carry `apply_url` and `company` on the queue row (the schema
> already carries `posted_at` for exactly this reason, with the comment "a column
> added later cannot be back-filled for the rows that mattered"), or re-derive
> them from `leads` by slug inside `runOne`.

### 6. Traps and things not to "fix"

- **`--fixture` and the real store are mutually exclusive**, and the check is on
  the _resolved_ path rather than on whether `--db` was passed —
  `--db ./jobs/leads.db` is the real store however it is spelled. A fixture run
  writes `auto_submissions` rows, and those count toward your per-day and
  per-company caps, so pointing one at the real store could silently consume a
  real employer's weekly budget.
- **No writes without `--enqueue`.** See step 9 above.
- **A dry run still requires `enabled: true`.** From the file's own header:
  "`enabled` answers 'may this machine run at all'; `dry_run` answers 'does it
  click'. Reading `enabled: false` as 'dry runs are fine' would make the off
  switch mean nothing."
- **The trust gate runs twice** — once in `selectEligible` and again inside
  `runJob` — and that is not redundant: "this one keeps the queue clean, that one
  catches the lead store changing under a job that is already queued."
- **`launchBrowser` is imported at the top of the file but loads
  `playwright-core` lazily inside itself**, so importing it costs nothing on the
  `--enqueue` path.
- The header comment still says "THE STATE THIS SHIPS IN — OFF. `auto_apply.enabled`
  is `false` and `dry_run` is `true`". **That describes the shipped default, not
  your file.** Your file has `enabled: true, dry_run: false`.

### 7. Dependencies

**Imports:** `node:fs`, `node:path`, `node:url`; `../lib/db.mjs`;
`../lib/lib.mjs`; `../lib/verification.mjs`; `../apply/automatability.mjs`
(`boardKey`); `../apply/ats/index.mjs` (`detectAts`); `../apply/browser.mjs`
(`launchBrowser`); and from within `scripts/auto/`: `authorize.mjs`
(`submitOrigin`), `trust.mjs`, `preflight.mjs`, `audit.mjs`, `pool.mjs`,
`job.mjs`, `breaker.mjs`, `guard.mjs`, `untrusted-text.mjs`, `stages.mjs`.

**Depended on by:** `scripts/auto/cycle.mjs` (which spawns it as a child
process), and the tests `tests/auto/auto-apply.test.mjs`,
`tests/auto/browser-leg.test.mjs`, `tests/auto/concurrency.test.mjs`,
`tests/fixtures/auto/kill-at.mjs`.

---

## `scripts/auto/job.mjs` — the per-job state machine

### 1. What it is and why it exists

One call to `runJob()` is one application, from claiming the slug to writing a
terminal row. It is the recovery unit of the whole system: a run can die at any
moment, and what survives is a set of `auto_queue` rows each saying precisely how
far its job got.

Without it, "resume after a crash at job 437" would mean replaying a log, and log
replay is exactly the mechanism that duplicates side effects.

### 2. How you use it

Library only. The sole production caller is `runCampaign`'s `runOne` inside
`auto-apply.mjs`. Tests: `tests/auto/job.test.mjs`.

Every collaborator arrives as a parameter — `openPage`, `scan`, `plan`, `fill`,
`classify`, `sleep`, `now`. This is **dependency injection** (passing a function
in rather than importing it), and the header names two reasons neither of which
is testability alone:

> - §4.1 requires the runner to IMPORT its stages, never `execFileSync` them —
>   four spawns per application over 999 applications is ~198s of process
>   startup, serialised behind every tab, and `spawns_per_app` is a gate column
>   asserted to be 0.
> - the browser lane differs per board… That choice belongs to the pool, which
>   owns the browser. This file must not know which lane it is on.

### 3. Everything it exposes

| export                 | shape                                                                    |
| ---------------------- | ------------------------------------------------------------------------ |
| `runJob({...})`        | `Promise<{slug, state, kind, stage, detail, submitted, wall_ms}>`        |
| `NOT_CLAIMED`          | the string `"not-claimed"`                                               |
| `isTerminal(state)`    | `boolean` — re-exported "so the pool does not import db.mjs for one set" |
| `CHECK_TO_KIND`        | `Map` from an `authorizeSubmit` check name to a taxonomy kind            |
| `PRECONDITION_TO_KIND` | `Map` from a `submitOnce` precondition name to a taxonomy kind           |
| `isJobResult(v)`       | a shape predicate. Its docstring: "For assertions, never a gate."        |

`runJob`'s parameters: `db, run, job, lead, limits, screening = null, mode,
openPage, scan, plan, fill, documents = null, profileApproved = false,
sentThisRun = 0, allowLoopbackHttp = false, classify = null, dbFile,
stopPath = undefined, navRetries = 1, navBackoffMs = 1_000, sleep, now`.

The return contract is unusual and important:

> `state` is `not-claimed` or a terminal `auto_queue` state. It NEVER throws for
> a per-job condition — a thrown error would take the pool's worker down with it
> and strand every job behind it. It DOES re-throw `StopError`, because a STOP is
> not a per-job condition: it means stop.

**The two mapping tables.** These convert another module's vocabulary into the
closed reason taxonomy. Every entry is a deliberate aggregation decision.

`CHECK_TO_KIND` — from `authorizeSubmit`'s eleven check names:

| check              | kind                | why                                                      |
| ------------------ | ------------------- | -------------------------------------------------------- |
| `auto_apply_block` | `fact-base-changed` | your limits file changed while the run was in flight     |
| `enabled`          | `fact-base-changed` | same                                                     |
| `mode`             | `fact-base-changed` | same                                                     |
| `trust_gate`       | `board-untrusted`   | the board is not on your allowlist                       |
| `apply_origin`     | `origin-mismatch`   | a **failure** kind — a broken invariant in our own store |
| `screening`        | `l3-rejected`       | the lead was rejected by screening                       |
| `plan_defer`       | `unknown-field`     | the plan has unresolved fields                           |
| `label_flag`       | `l3-rejected`       | the form's own label tried to instruct the agent         |
| `submit_readiness` | `unknown-field`     | the form is not ready to send                            |
| `company_known`    | `unknown-field`     | no company name to count against the per-company cap     |
| `caps`             | `cap-company`       | a blast-radius limit is reached                          |

The docstring insists these are decisions, not a lookup table somebody filled in:

> `auto_apply_block/enabled/mode -> fact-base-changed`. These three read the
> user's own limits file, which auto-apply.mjs already read once at startup… So a
> per-job failure here means THE FILE CHANGED WHILE THE RUN WAS IN FLIGHT…
> Mapping them to `board-untrusted` (the nearest-looking kind) would tell the
> user their boards went bad when what actually happened is that they edited
> their own file at 21:40.
>
> `label_flag -> l3-rejected`. The finding came from the FORM's label rather than
> from the posting body, but it is the same class of event — text under a third
> party's control tried to instruct the agent, and rule 0 stopped it.

`PRECONDITION_TO_KIND` — from `submitOnce`'s eleven precondition names:

| precondition        | kind              |
| ------------------- | ----------------- |
| `token_live`        | `token-refused`   |
| `token_slug`        | `token-refused`   |
| `token_plan_sha`    | `token-refused`   |
| `token_mode`        | `token-refused`   |
| `page_origin`       | `origin-mismatch` |
| `queue_claimed`     | `token-refused`   |
| `durable_attempt`   | `db-write-failed` |
| `plan_clean`        | `unknown-field`   |
| `stop_clear`        | `doc-unverified`  |
| `board_trusted`     | `board-untrusted` |
| `document_verified` | `doc-unverified`  |

### 4. How it works, state by state

**Entry.** Record the start time; throw `TypeError` if `job.slug` is missing —
that is the one throw in this function that is a programming error rather than a
job condition. Build a context object holding `board_key` and `origin`.

Two local helpers do all the bookkeeping. `done(state, record)` builds the return
object. `terminate(kind, stage, detail, state)` is the **only funnel to a
terminal state**:

```js
/** Write a terminal row and return the result. One funnel, so no exit can
 *  skip the taxonomy: reasonRecord throws on an unknown kind. */
const terminate = (kind, stage, detail, state = null) => { … }
```

It calls `reasonRecord` (which validates the kind and stage against the closed
taxonomy and sanitises the detail through `safeText(detail, 240)`), then
`setAutoJobState`, then `run.failJob` or `run.deferJob`.

**→ `claimed`.** `claimAutoJob(...)`. Anything other than `1` returns
`not-claimed` without touching a thing.

**The trust gate, before the browser.** `trustBoard(...)`; a refusal terminates
at stage `claim`. The ordering is deliberate:

> Deliberately first. A board the user has not allowlisted costs one row and no
> page load, which is what makes the gate cheap enough to be strict. Running it
> after the scan would spend a navigation on every untrusted board in the queue.

**Navigation, with a bounded retry.** A loop around `openPage(applyUrl, {...})`.
On a throw, if this was already the last permitted attempt (`navRetries` defaults
to 1, meaning two tries in total) it terminates with `nav-timeout` at stage
`plan`; otherwise it sleeps `navBackoffMs * (attempt + 1)` — one second, then
two — and tries again. Why bounded:

> §4.6: transient kinds get a bounded job-level retry with backoff BEFORE they
> are eligible to count toward a breaker signature. A 20-second wifi drop at job
> 41 must not pause a board holding 900 leads.

**Posting-gone check.** HTTP status 404 or 410 (or an explicit `gone` marker)
terminates with `posting-gone` at stage `plan`. "A posting taken down between
screening and submit is routine at hundreds of leads, and it is the board's
event, not a malfunction of ours."

**→ `planned` — the walk.** `walkPages(...)` does the real work (see the next
section). Two things `runJob` hands it are worth naming:

- `mintToken` is a closure around `authorizeSubmit` — so a fresh authorisation is
  minted **per page transition**, meaning the STOP switch, the caps and the trust
  gate are all re-read at every page. "A brake pulled while a worker is on page 2
  of 4 stops it there."
- `onPagePlanned` writes `setAutoJobState(db, slug, "planned", {run_id,
plan_sha256: pageSha})` per page, **before that page's fill**, so a kill
  anywhere in the walk lands on `planned` carrying the hash of the page it died
  on.

If `walkPages` throws: a `StopError` is re-thrown; an `AdvanceAmbiguous` becomes
`post-submit-unclassified` at stage `plan`, with this reasoning:

> AdvanceAmbiguous: a Next click went out and the page did not become what was
> expected. If the scanner's role regex was wrong, that click was a submit — so
> this is NOT abandoned and NOT retried, exactly like an ambiguous submit.

**After the walk.** Three details:

- The scan handed to `submitOnce` is **the last page's**, never the first: "The
  submit control lives on the final page, and an earlier page's stamps do not
  exist in that DOM."
- The plan hash is recomputed over the **merged** plan and `planned` is rewritten
  with it: "a token bound to the last page alone would authorise a submit whose
  earlier pages nothing checked."
- Any remaining defers are typed through `classifyPlanDefers`, so "the kind comes
  from the shipped taxonomy rather than from here."

> **Known defect (2026-08-05 audit).** The dry-run multipage early exit is
> unreachable. `runJob` checks
> `walk.dryRun && (walk.pages?.length ?? 0) === 1 && walk.pages[0]?.hasNext` and
> terminates with `multipage-unresolvable`. But `walkPages` pushes page objects
> shaped `{page, plan, report, scan, sha, url}` — there is no `hasNext` key
> anywhere in `multipage.mjs`, so the condition is always false. A dry run over a
> multi-page form is therefore reported as a clean single-page resolution instead
> of "I could not walk this". The information is available: `walkPages` already
> computes `findNextControl(scan).ok` on the same page.

**→ `authorized`.** `authorizeSubmit(...)` over the merged plan. A `StopError` is
re-thrown; an `AuthorizationInputError` becomes `plan-error` at stage `authorize`
("The runner wired the gate wrong. A malfunction of ours"); a deferral takes its
kind from `CHECK_TO_KIND.get(auth.failed[0]) ?? "plan-error"`.

**→ `attempted`.** Written **before** `submitOnce` is called:

> The queue row moves to 'attempted' BEFORE submitOnce, so a SIGKILL between
> these two lines leaves a row that says a click may have been issued — which is
> what keeps it out of AUTO_QUEUE_RESUMABLE and in front of a human. It is
> written before submitOnce's own durable ledger row on purpose: of the two
> possible orderings, this one can only ever over-report, and over-reporting an
> attempt costs a human one look at a URL while under-reporting one costs a
> duplicate application.

**The submit and its outcomes.** What `submitOnce` returns or throws maps to:

| thrown / returned                                                          | `runJob` does                                                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `StopError`                                                                | re-throw — stops the whole run                                                        |
| `SubmitAmbiguous`                                                          | `terminate("post-submit-unclassified", "attempt", …)` — leaves an orphan for a human  |
| `SubmitRefused`                                                            | `terminate(PRECONDITION_TO_KIND.get(e.precondition) ?? "plan-error", "authorize", …)` |
| `ClassifierRequired`                                                       | `terminate("plan-error", "authorize", e.message)` — our wiring error, not the board's |
| outcome `"dry-run"` or `"confirmation"`                                    | `setAutoJobState(..., "submitted")` and return `submitted`                            |
| outcome `bot-challenge` / `email-code-challenge` / `identity-verification` | `terminate(kind, "post-submit", …, "challenged")`                                     |
| outcome `"posting-gone"`                                                   | `terminate("posting-gone", "post-submit", …)`                                         |
| anything else (including `unclassified` and `error`)                       | `terminate("post-submit-unclassified", "post-submit", …)`                             |

The challenge map is small and explicit:

```js
const CHALLENGE = new Map([
  ["bot-challenge", "bot-challenge"],
  ["email-code-challenge", "email-code-challenge"],
  ["identity-verification", "captcha"],
])
```

with the comment: "`challenged` means 'a click went out and we do not know
whether it landed' — it counts toward caps (never under-count) and is reported as
unconfirmed, never as sent."

**The catch-all and the finally.** Anything unexpected becomes a `plan-error`; if
even that write fails, the job returns `failed` / `db-write-failed` without
throwing. The comment names the stakes: "A job must not be able to take its
worker down: the pool has N-1 other jobs behind it and an uncaught throw strands
all of them." The `finally` always closes the page, swallowing errors, because "a
leaked page must not turn a clean defer into a failure."

### 5. A worked example — the Coinbase job that actually deferred

This is one of the three rows sitting in the live database right now.

1. `claimAutoJob` returns `1`; the row becomes `claimed`, `attempt_no = 1`.
2. `trustBoard` passes: `job-boards.greenhouse.io` is on your allowlist and
   declares the `greenhouse` adapter, which this repo ships.
3. `openPage` returns a page on `https://job-boards.greenhouse.io/...` with
   status 200.
4. `walkPages` runs once — the form has a submit button and no `next` control.
   The scan finds the fields; the plan resolves most of them and **defers nine**.
5. Because the plan has defers, `walkPages` returns
   `{ok: false, kind: "plan-defer", reason: "page 1 deferred 9 field(s)"}` and,
   since only one page was reached, no draft abandonment is reported.
6. `classifyPlanDefers` sorts the nine by priority. `consent-tickbox` wins, and
   the resulting detail records the others too.
7. The row is written:

   ```text
   slug          coinbase-software-engineer
   state         deferred
   reason_kind   consent-tickbox
   reason_stage  plan
   reason_detail 9 field(s) need a human; first: Please confirm receipt of the
                 above linked Global Data Privacy Notice and US Arb…
                 (also confirm-widget, confirm-field, doc-unver…)
   ```

Nothing was clicked. `auto_submissions` has no row for this slug. And because the
kind is a value from a closed list rather than a sentence, the digest can later
count "consent-tickbox at plan on greenhouse cost N applications this week" with
a `GROUP BY`.

### 6. Traps and things not to "fix"

- **It never throws for a per-job condition, and always re-throws `StopError`.**
  If you add a throw here, you strand every job queued behind this worker.
- **`terminate` is the only funnel to a terminal state.** An unknown kind becomes
  a loud `TaxonomyError` (caught by the catch-all and retyped as `plan-error`)
  rather than a quiet bucket.
- **`attempted` is written before the click and is not resumable.** Do not
  "optimise" that ordering.
- **The last page's scan, not the first**, is what locates the submit control.
- **The merged plan's hash replaces the per-page hash** before the submit token is
  minted.
- The stage functions are called with a narrow contract — `scanStage(page, ctx)`,
  `planStage(ctx)`, `fillStage(page, plan, ctx)`. Keep them thin.

### 7. Dependencies

**Imports:** `../lib/db.mjs` (`claimAutoJob`, `setAutoJobState`,
`AUTO_QUEUE_TERMINAL`); `./authorize.mjs`; `./trust.mjs`; `./submit.mjs`;
`./multipage.mjs`; `./advance.mjs` (`AdvanceAmbiguous`); `./taxonomy.mjs`;
`./untrusted-text.mjs`; `./guard.mjs`.

**Depended on by:** `scripts/auto/auto-apply.mjs` and `tests/auto/job.test.mjs`.

---

## `scripts/auto/multipage.mjs` — walking a form page by page

### 1. What it is and why it exists

Many application forms are wizards: page 1 asks for your name, and page 2 only
exists after you fill page 1 and click Next. The original specification demanded
that every field on the whole form be resolved "before the first keystroke",
which is unsatisfiable on such a form — so the only way to obey it was to defer
every multi-page form. The file's header calls that "a volume loss dressed up as
a correctness win, and the only signal it had happened would have been a
defer-rate number."

`walkPages()` takes the other fix: resolve **incrementally**, page by page, and
abandon explicitly when a page cannot be resolved. The replacement invariant:

> **Nothing is submitted until EVERY page has been resolved with zero defers.**
>
> That is weaker than C7 asked for in one specific way — keystrokes reach page 1
> before page 3 is known — and identical in the way that matters: an application
> still only leaves when nothing on any page needed a judgement. What page 1's
> keystrokes cost if page 3 turns out to be unresolvable is a DRAFT sitting in
> the employer's ATS, which is why abandoning it explicitly is part of the
> specification rather than a nicety.

### 2. How you use it

Library. Sole caller: `runJob` in `job.mjs`. Tests:
`tests/auto/multipage.test.mjs`.

Note that a **single-page** form is not a special case — it is the same code with
the loop running exactly once.

### 3. Everything it exposes

| export                                   | shape                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `MAX_PAGES`                              | `8`                                                                         |
| `mergePages(pages)`                      | `{plan: {v: 1, items, defer, pages: N}, report: {uploads, revealed}}`       |
| `DRAFT_ABANDONERS`                       | an **empty** `Map`                                                          |
| `abandonDraft(page, {board, slug, why})` | `Promise<{abandoned: boolean, how: string}>`                                |
| `walkPages(page, {...})`                 | `Promise<{ok, pages, plan, report, reason?, kind?, abandonment?, dryRun?}>` |

`MAX_PAGES = 8` is a loop guard, not a feature limit: "A real ATS form is 1-4
pages; the bound exists so a board that always renders a `next` control cannot
spin a worker forever."

`mergePages` concatenates items, defers, uploads and revealed entries, stamping
each item and defer with the page number it came from. Defers concatenate even
though a page with defers ends the walk, because "the merged plan has to be able
to REPRESENT a defer, or the submit gate's own zero-defer check becomes vacuous
on multi-page forms."

`DRAFT_ABANDONERS` being empty is honest, not unfinished:

> DELIBERATELY EMPTY FOR EVERY PRODUCTION BOARD… Greenhouse, Lever and Ashby
> hosted forms expose no candidate-facing "discard this application" action
> without the logged-in session §6.4 excluded. §4.2c says "where the ATS supports
> it", and on today's allowlist that is nowhere.

So `abandonDraft` mostly _records_ rather than acts, and the record is the point.
Its default message reads: `no draft-discard path on lever — a partial
application may be sitting in their ATS for "acme-senior-fullstack" (page 3
deferred 1 field(s))`. Its return value is documented as
"`abandoned: false` with a stated `how` is a legitimate outcome, not a failure."

`walkPages` parameters: `slug, mode, job, lead, documents, board, url, scanStage,
planStage, fillStage, mintToken, planSha256, onPagePlanned, maxPages`.

### 4. How it works, step by step

For each page number 1, 2, 3, …:

1. `scanStage(page, {url, job, lead, page: pageNo})` → the scan.
2. `planStage({scan, url, job, lead, documents, page: pageNo})` → the plan.
3. Hash the plan.
4. `onPagePlanned({page, plan, sha})` — the `planned` waypoint. This moved here
   from `job.mjs` and the move is the point:

   > §4.4's ladder is queued -> claimed -> planned -> authorized, and a state a
   > SIGKILL can never land on is a rung that is not there: writing `planned`
   > only after the whole form was walked meant a kill during page 1's fill left
   > `claimed`, and the runner-resume suite caught exactly that.

5. `fillStage(page, plan, {...})` → the report. "The fill runs Playwright-side and
   nothing is read back out of the page."
6. Push `{page, plan, report, scan, sha, url}`. The per-page scan is kept because
   the submit control lives on the final page and "locating it by the stamp from
   an earlier page's scan would be locating it by a key that no longer exists in
   the DOM."
7. **If the plan has any defers, the walk ends here** with kind `plan-defer`.
   "Advancing past a page that needed a human would put more of the user's data
   into a form that is never going to be submitted."
8. `findNextControl(scan)`:
   - No `next` control, and either the page has a `submit` control or we are on
     page 1 → **break**. This is the ordinary exit, including every single-page
     form.
   - No `next` control mid-form → fail with `multipage-unresolvable`: "page N
     offers neither a 'next' control nor a 'submit' one".
9. If we are already at `maxPages` → fail with `multipage-unresolvable`: "still
   being offered a 'next' control after 8 pages — this is a loop rather than a
   form".
10. `mintToken(pageSha, {page, plan})` — a **fresh** authorisation for this page.
    A missing or deferred token fails with kind `authorize`.
11. `advanceOnce(page, {token, slug, planSha: pageSha, mode, pageUrl, scan})`.
    - In dry run nothing is clicked, so the walk returns immediately with
      `{ok: true, dryRun: true, …, reason: "dry run: resolved page N and did not
advance"}`.
    - `AdvanceRefused` → fail with `multipage-unresolvable`.
    - `AdvanceAmbiguous` (or anything else) is **re-thrown**: "the click went out.
      This is NOT ours to abandon."
12. Update the live URL and loop.

Every failure path goes through a local `fail(kind, reason)` closure, which
attaches a draft abandonment **only if the walk advanced past page 1**:

> ONLY IF WE ADVANCED. A form abandoned on page 1 left nothing behind: no Next
> was clicked, so no draft exists to discard, and reporting one would be telling
> the user about something that is not there.

**Worked example — a three-page Lever form.** Page 1 scans eight fields plus a
`next` button labelled "Continue"; the plan resolves all eight with zero defers;
`onPagePlanned` writes `planned` with `sha=3f9c…`; the fill types the answers;
`mintToken` returns a token; `advanceOnce` clicks `[data-aj="b7"]`, the origin is
unchanged, and the live URL becomes `.../apply?step=2`. Page 2 goes the same way.
Page 3 scans four fields and a `submit` button with no `next`, and the plan defers
one field (`why: "unprobed dropdown"`). `fail("plan-defer", "page 3 deferred 1
field(s)")` runs; because three pages were reached, `abandonDraft` returns
`{abandoned: false, how: 'no draft-discard path on lever — a partial application
may be sitting in their ATS for "acme-senior-fullstack" (page 3 deferred 1
field(s))'}`. `job.mjs` then types the merged plan's defer as
`unprobed-dropdown`, writes `deferred`, and appends that abandonment sentence to
`reason_detail` — so you learn about the half-finished application.

### 5. What it reads and writes

It touches no files and no database tables directly. Everything durable happens
through the injected `onPagePlanned` callback (which `job.mjs` wires to
`setAutoJobState`) and through `mintToken` (which reaches `authorizeSubmit` and
the caps ledgers).

### 6. Traps and things not to "fix"

- **Zero defers on every page, or nothing is submitted.** That is the invariant.
- **A fresh authorisation per page** is not wasteful duplication — it is what
  makes the STOP switch, the caps and the trust gate effective mid-form.
- **`AdvanceAmbiguous` propagates and is never converted into an abandonment.**
- **`DRAFT_ABANDONERS` empty is correct** for the current allowlist.
- The page objects have no `hasNext` field. See the known defect noted under
  `job.mjs`.

### 7. Dependencies

**Imports:** `./advance.mjs` (`advanceOnce`, `findNextControl`,
`AdvanceRefused`) and `./untrusted-text.mjs` (`safeText`).
**Depended on by:** `scripts/auto/job.mjs`, `tests/auto/multipage.test.mjs`.

---

## `scripts/auto/advance.mjs` — the navigate verb

### 1. What it is and why it exists

`advanceOnce()` clicks exactly one kind of thing: a control whose **scanned role
is `next`**. It is the second and last file under `scripts/auto/` permitted to
contain a click, and its own header frames its existence as a cost rather than a
feature:

> **`fill-engine.mjs` is not touched.** Its inexpressibility property is
> preserved verbatim. The navigate verb lives out here instead — one small file
> with one function, where the click surface stays reviewable.
>
> This is a REAL WIDENING of a surface this project kept at zero.

The "inexpressibility property" it refers to is a line in `fill-engine.mjs`:
"there is deliberately no verb that clicks a button. 'Never click submit' is not
a rule this engine follows — it is a thing it cannot express." That property is
worth preserving because a rule that cannot be broken beats a rule that must be
remembered.

**Why a Next button needs the same ceremony as a submit** is the most important
paragraph in the file:

> Because the difference between Next and Submit is a REGEX OVER THIRD-PARTY
> TEXT. `roleOf` in scan-page.js reads the control's label — which the board
> writes — so a page that labels its final submit "Save and Continue" is scanned
> as `next`. That is not hypothetical; it is a normal thing for a board to do,
> and rule 0 says the label is data.

(A **regular expression**, or regex, is a compact pattern language for describing
text to search for — `^Next\b` means "the word Next at the start of the string".
The scanner uses one to guess a button's role from its visible label.)

So this function assumes it may be _wrong_ about the role, and takes the same
origin binding and the same token discipline as the real submit. If the click it
makes turns out to have been a submit, the durable `(slug, mode)` row exists, the
caps counted it, and the ledger says an attempt was made — instead of an
application leaving with no record at all.

### 2. How you use it

Library. Called only from `walkPages` in `multipage.mjs`. Its `AdvanceAmbiguous`
class is also imported by `job.mjs`. Tests: `tests/auto/advance.test.mjs`,
`tests/auto/click-surface.test.mjs`.

### 3. Everything it exposes

| export                     | shape                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `class AdvanceRefused`     | `{name, code: "EADVANCEREFUSED", reason, role}` — thrown **before** any click               |
| `class AdvanceAmbiguous`   | `{name, code: "EADVANCEAMBIGUOUS", detail}` — the click went out and the outcome is unknown |
| `findNextControl(scan)`    | `{ok: true, key, label, role}` or `{ok: false, terminal, reason}`                           |
| `advanceOnce(page, {...})` | `Promise<{advanced, url, control, dryRun?}>`                                                |

`advanceOnce` options: `token, slug, planSha, mode, pageUrl, scan,
clickTimeoutMs = 15_000, settleMs = 20_000`.

Two module constants carry the whole property:

```js
/** The roles this file will actuate. A set of one, written as a set so that
 *  adding to it is a visible act rather than an edit to a comparison. */
const CLICKABLE_ROLES = new Set(["next"])

/** The role it must never actuate, named separately from "not in the set
 *  above" so the refusal can say WHY rather than "no next control found". */
const FORBIDDEN_ROLE = "submit"
```

### 4. How it works, step by step

`findNextControl(scan)` reads `scan.buttons` (or the older `scan.btns`), where
each button is `{k, l, r}` — `k` is the scanner's `data-aj` stamp (a unique
attribute the scanner writes onto each control so it can be found again later),
`l` is the label, `r` is the role. It refuses ambiguity in both directions:

- **Zero** `next` controls → `{ok: false, terminal, reason}`, where `terminal`
  says whether a `submit`-role button exists instead. That flag matters because
  "'no next control' and 'this is the last page' are different situations and the
  caller's correct response differs: one is a defer, the other is a submit."
- **More than one** → refuse: "which one advances the form is a judgement, and
  this path does not make judgements."
- **Exactly one but no `data-aj` stamp** → refuse. There is no text fallback, and
  that is deliberate: "a text fallback is a fuzzy match to a control that moves an
  application forward, and the label is the board's own text."

`advanceOnce` then runs, in order:

1. **Token, checked but NOT spent.** `isSubmitToken(token)` must be true, and
   `assertTokenMatches(token, {slug, planSha, mode})` must not throw. Why not
   spent:

   > A multi-page form needs several advances and exactly one submit, and the
   > token is single-use because the SUBMIT must be. Spending it here would leave
   > nothing to authorise the submit at the end of the form; minting a fresh one
   > per page would make the nonce meaningless.

   (A **nonce** is a value that may be used only once. The token carries one, so
   the submit that spends it cannot be replayed.)

2. **Origin binding.** The token's `apply_url` origin must equal the live page's
   origin. This "matters MORE here than at the submit: an attacker-controlled
   redirect on page 2 of a form moves the browser somewhere else, and the next
   thing this runner does is type the user's answers into whatever is there."
3. **Find the control** with `findNextControl`.
4. **Belt and braces**, repeated on purpose:

   ```js
   if (control.role === FORBIDDEN_ROLE || !CLICKABLE_ROLES.has(control.role))
     throw new AdvanceRefused(
       `refusing to actuate a control whose scanned role is '${…}' — ` +
         `this verb clicks 'next' and nothing else`,
       { role: control.role },
     )
   ```

   > The check is repeated rather than trusted because it is the single property
   > this file exists to guarantee, and a future edit to findNextControl that
   > widened the filter would otherwise silently make this function able to
   > submit.

5. **Dry run exits here**, "having exercised every check", returning
   `{advanced: false, url: pageUrl, control, dryRun: true}`.
6. **The click**: `page.locator('[data-aj="<key>"]').click({timeout: 15000})`. If
   it throws, that becomes `AdvanceAmbiguous`, not a clean refusal:

   > A NEXT CLICK THAT THREW IS NOT AUTOMATICALLY SAFE. Playwright's timeout can
   > fire after the event reached the page, and if the scanner's regex was wrong
   > about the role, that dispatched event was a submit.

7. `waitForLoadState("domcontentloaded")`, with a timeout swallowed — "a slow
   settle is not evidence of anything".
8. Read the new URL; a throw here is also `AdvanceAmbiguous`.
9. **Origin again, after the navigation.** If the origin changed, throw
   `AdvanceAmbiguous`:

   > ORIGIN AGAIN, AFTER THE NAVIGATION. The click is the moment a board can move
   > the browser, so binding checked only before it is a check on the page that is
   > no longer there.

10. Return `{advanced: true, url, control}`.

### 5. What it reads and writes

Nothing on disk and nothing in the database. It reads the token object and the
scan, and it drives the Playwright page.

### 6. Traps and things not to "fix"

- **The token is checked and deliberately not consumed.**
- **The origin is checked twice** — before and after the click.
- **An error from the click is never read as "safe".** `AdvanceRefused` means
  nothing was clicked; `AdvanceAmbiguous` means something may have been. Those
  are different types on purpose.
- `CLICKABLE_ROLES` is a `Set` of one so that adding a role is a visible act.

> **Known defect (2026-08-05 audit), cosmetic but misleading.**
> `consumeSubmitToken` is imported at the top of `advance.mjs` and never used —
> the file explicitly does not spend the token. An unused import of the
> token-spending function, in exactly the file where a reader is checking what
> can and cannot happen, is worth removing. Separately, the file header promises
> a function called `landedOnSubmit` ("What it does instead is DETECT that it
> landed on something terminal (see `landedOnSubmit`)"). **No such function
> exists in the file.** The post-navigation origin check is what actually
> catches the dangerous case.

### 7. Dependencies

**Imports:** `./authorize.mjs` (`consumeSubmitToken` — unused, `assertTokenMatches`,
`isSubmitToken`, `submitOrigin`, `TokenError`) and `./untrusted-text.mjs`.
**Depended on by:** `scripts/auto/multipage.mjs`, `scripts/auto/job.mjs`,
`tests/auto/advance.test.mjs`, `tests/auto/click-surface.test.mjs`.

---

## The click surface is exactly two files

Before the submit itself, the invariant that holds the whole subsystem together.

**`.click(` appears under `scripts/auto/` in exactly two files:**

| file          | what it may click                                      |
| ------------- | ------------------------------------------------------ |
| `submit.mjs`  | the one submit — exactly one `.click(`                 |
| `advance.mjs` | a control whose scanned role is `next`, never `submit` |

`tests/auto/click-surface.test.mjs` (116 lines) is what keeps it that way. It
makes three assertions:

1. No `.mjs` file under `scripts/auto/` other than those two contains `.click(`.
   Line comments are stripped before matching, so prose _about_ clicking does not
   fail the suite — and every file in that directory discusses clicking at length,
   on purpose.
2. `submit.mjs` contains **exactly one** `.click(`. The failure message explains
   why the count matters: "One function, one click — a second one is a second
   place an irreversible act can be issued from."
3. `advance.mjs`, imported for real, **rejects** when handed a scan whose only
   button has `r: "submit"`, using a stub page whose `click` method calls
   `assert.fail("it clicked")`.

This project generally prefers behavioural tests over grepping the source, and
the test's own header explains why this one is the exception:

> because the property under test IS a property of the source. "No other file
> contains a click" cannot be observed by running anything — a file that never
> gets called still contains the click, and the day somebody calls it is the day
> it matters.

One honest note about assertion 3: the stub is called with no token, so
`advanceOnce` refuses at its very first check (the missing authorisation) rather
than at the role check. The behavioural property that matters — _the stub's click
was never called_ — is genuinely asserted; the specific reason for the refusal is
not.

---

## `scripts/auto/submit.mjs` — the one submit click

### 1. What it is and why it exists

`submitOnce()` is the only function in this repository permitted to contain a
submit click. Everything irreversible funnels through it so the review surface is
one file, and the **order** of its checks is itself a safety property.

### 2. How you use it

Library. Sole caller: `runJob` in `job.mjs`. Tests: `tests/auto/submit.test.mjs`,
`tests/auto/click-surface.test.mjs`.

### 3. Everything it exposes

| export                     | shape                                                     |
| -------------------------- | --------------------------------------------------------- |
| `SUBMIT_PRECONDITIONS`     | a frozen array of the eleven precondition names, in order |
| `class SubmitRefused`      | `{precondition, detail, code: "ESUBMITREFUSED"}`          |
| `class ClassifierRequired` | `{code: "ECLASSIFIER"}` — **not** one of the eleven       |
| `class SubmitAmbiguous`    | `{detail, code: "ESUBMITAMBIGUOUS"}`                      |
| `findSubmitControl(scan)`  | `{ok: true, key, label}` or `{ok: false, reason}`         |
| `isProvablyBeforeClick(e)` | `boolean`                                                 |
| `submitOnce(page, {...})`  | `Promise<{outcome, confirmationUrl, clicked, url?, row}>` |

`submitOnce` options: `token, slug, planSha, mode, pageUrl, queueRow, plan,
report, run, trust, verification, profileApproved, scan, classify, dbFile,
stopPath, clickTimeoutMs = 15_000, settleMs = 20_000, job`.

Two of those carry a warning in their JSDoc:

- `pageUrl` — "`page.url()`, the LIVE url. Never the planned one: comparing the
  plan against itself passes through a redirect."
- `classify` — "REQUIRED IN LIVE MODE… It is injected rather than imported so that
  this file cannot silently acquire a live path before W2 builds and corpus-tests
  one."

### 4. The eleven preconditions, in order

They are named in code as a frozen list so that a report can say which one refused
without parsing prose, "and a twelfth has to be added HERE":

```js
export const SUBMIT_PRECONDITIONS = Object.freeze([
  "token_live", //  1  minted by authorizeSubmit() in this process, nonce unspent
  "token_slug", //  2  token.slug === slug
  "token_plan_sha", //  3  token.planSha === planSha === sha256(plan being sent)
  "token_mode", //  4  token.mode === mode
  "page_origin", //  5  live page origin === token's apply_url origin
  "queue_claimed", //  6  queue row is 'authorized' and claimed by this worker
  "durable_attempt", //  7  the (slug, mode) attempt row reported 1 change
  "plan_clean", //  8  no defers, submitReadiness true, no labelFlag anywhere
  "stop_clear", //  9  STOP not set at global / board / company scope
  "board_trusted", // 10  trust.mjs passed and the lead carries no L3 rejection
  "document_verified", // 11  passing verification for these bytes AND this fact base
])
```

They are a **set** — all eleven must hold — but the evaluation order is a design
decision the file spells out:

> FIRST, everything that can refuse with NO SIDE EFFECT AT ALL (1-6, 8, 10, 11).
> A job refused here leaves no row, no ledger entry and nothing to reconcile,
> which is what makes a defer cheap enough that the runner can afford to be
> strict.
>
> THEN 7, the durable `(slug, mode)` attempt row, written BEFORE the click. It is
> deliberately the LAST thing before the token is spent, because every check
> placed after it is time in which a crash leaves an orphan for a human to
> adjudicate. Item 7 is the only control in the design that a crash or a
> claim-race cannot walk past — db.mjs says it outright: "An attempt is a
> submission until proven otherwise."
>
> THEN the token spend (`consumeSubmitToken`), which re-runs 1-5 and re-reads the
> kill switch with nothing between it and the click but one statement. That is
> check 9 in its load-bearing position: a STOP the user set while this job was
> planning still stops it.

Here is each one as the code actually evaluates it, in source order.

|   # | name                | what it checks                                                                                                                                       | side effect if it refuses                                                                     |
| --: | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
|   1 | `token_live`        | `isSubmitToken(token)` is true; later, `assertTokenMatches` did not throw a `TokenError` (this is the only place the nonce's liveness is observable) | **none** — throws `SubmitRefused`, writes nothing                                             |
|   2 | `token_slug`        | `token.slug === slug`                                                                                                                                | **none**                                                                                      |
|   3 | `token_plan_sha`    | `token.planSha === planSha` — "an unbound token authorises any plan"                                                                                 | **none**                                                                                      |
|   4 | `token_mode`        | `token.mode === mode`                                                                                                                                | **none**                                                                                      |
|   5 | `page_origin`       | the token's `apply_url` has an http(s) origin, the live page has one, and they are equal                                                             | **none**                                                                                      |
|   6 | `queue_claimed`     | `queueRow` is an object, its `state` is `"authorized"`, its `slug` matches, and its `run_id` matches this run                                        | **none**                                                                                      |
|   8 | `plan_clean`        | `plan` is an object, `plan.defer` is empty, `submitReadiness(plan, report)` says yes, and **no** plan item or defer entry carries a `labelFlag`      | **none**                                                                                      |
|  10 | `board_trusted`     | `trust` is an object and `trust.ok` is true                                                                                                          | **none**                                                                                      |
|  11 | `document_verified` | `verification` is an object, `profileApproved === true`, and `hasPassingVerification(db, {slug, mode, doc_sha256, profile_sha256})` finds a row      | opens and closes its own database connection; **writes nothing**                              |
|   7 | `durable_attempt`   | `run.beginSubmit(...)` inserted the `(slug, mode)` row with `outcome = 'attempted'` and reported one change                                          | **WRITES** an `auto_submissions` row                                                          |
|   9 | `stop_clear`        | `consumeSubmitToken(...)` did not throw — it re-runs 1-5 and re-reads the STOP switch at global, company, run and board scope                        | reached only after 7; calls `run.abandonAttempt(..., {beforeClick: true})` before re-throwing |

So: **nine of the eleven can refuse with no trace whatsoever.** Only 7 and 9
touch state, and 9 only because 7 already did.

A labelFlag deserves its own note. It is the marker the planner sets when the
page's own text tried to instruct the agent — the attack hard rule 0 exists to
stop. The code refuses on it anywhere:

> A labelFlag ANYWHERE — plan item or defer entry — is rule 0 firing on the
> page's own text. It is not weighed against the rest of the plan.

Precondition 11 also states its own honest limit rather than papering over it:

> WHAT THIS CHECKS AND WHAT IT STILL DOES NOT. It checks that verify-claims passed
> for EXACTLY these document bytes against EXACTLY this fact base, and that the
> fact base itself is user-approved. It does NOT check that the user approved THIS
> DOCUMENT, because no durable record of a per-document approval exists anywhere
> in the tree today (hard rule 5's approval happens in a chat message, which
> leaves no row). That gap is named here rather than papered over with a field
> that would always read true.

### 5. The three error types, and why they are three

This distinction is the heart of the file.

| type                 | meaning                                                                                                              | what the caller must do                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `SubmitRefused`      | one of the eleven said no. **Nothing was clicked.** Carries `.precondition` naming which one.                        | type it via `PRECONDITION_TO_KIND` and write a terminal row |
| `ClassifierRequired` | live mode was asked for without a post-click classifier. A property of **how the runner was wired**, not of the job. | write `plan-error` — a malfunction of ours                  |
| `SubmitAmbiguous`    | the click **was issued** and something went wrong after it. Carries `.detail`.                                       | leave the attempt as an orphan; never retry, never abandon  |

`ClassifierRequired` is deliberately not a `SubmitRefused`, and the code says why:

> NOT a SubmitRefused, because it is not one of the eleven — those are properties
> of the job, and this is a property of how the runner was wired. Reusing a
> precondition name for it would put a wiring error in the bucket the user reads
> as "the board declined", and would quietly make the closed list of eleven mean
> twelve things.

There is a **fourth** category worth knowing: `TokenError`, thrown by
`authorize.mjs`. `submitOnce` catches it in exactly two places and converts it —
at check 1 it becomes `SubmitRefused("token_live", …)`, and at the spend it is
re-thrown after `run.abandonAttempt(..., {beforeClick: true})`. A token error is
never allowed to escape untyped.

Finally, `SubmitAmbiguous` is the one outcome the system refuses to resolve
automatically:

> A FAILURE DURING THE CLICK IS AMBIGUOUS AND STAYS AN ORPHAN. It is not
> abandoned, not retried, and it stops the runner. The request may have reached
> the ATS, and an application cannot be unsent.

### 6. When it does and does not click

**Beyond the eleven**, these also stop the click:

- `mode === "live"` with no `classify` function → `ClassifierRequired`, thrown
  before anything durable is written, "so a runner wired live without W2 fails as
  a clean defer instead of leaving an attempted row it cannot resolve".
- `run.beginSubmit(...)` throwing — the ledger already holds a `(slug, mode)` row,
  or the run's mode disagrees with the token's.
- `consumeSubmitToken(...)` throwing — a STOP is set, or any of checks 1-5 fails
  on re-check.
- `mode !== "live"` — the **dry run** returns
  `{outcome: "dry-run", confirmationUrl: null, clicked: false, row}` after calling
  `run.recordRehearsal(...)`.
- `findSubmitControl(scan)` failing — abandon the attempt (`beforeClick: true`)
  and throw `SubmitRefused("plan_clean", …)`.

**It clicks** when, and only when, all eleven hold, `beginSubmit` returned, the
token was spent without throwing, `mode === "live"`, and `findSubmitControl`
returned exactly one stamped `submit` control. The click is two lines:

```js
const locator = page.locator(`[data-aj="${control.key}"]`)
await locator.click({ timeout: clickTimeoutMs })
```

`findSubmitControl` filters buttons for `r === "submit"` and refuses on zero, on
more than one ("which one is the application is a judgement, and this path does
not make judgements"), and on a match with no `data-aj` stamp. The refusal of a
text fallback is explicit and cites a measured board behaviour:

> Located by the scanner's own `data-aj` stamp and by NOTHING ELSE. A text
> fallback ("find a button that says Submit") is the obvious next move and it is
> refused deliberately: the label is third-party text, and a fuzzy match to a
> submit button is a fuzzy match to an irreversible act. If the stamp is gone —
> Greenhouse remounts its form after an upload and drops every stamp, which is a
> measured behaviour of the real board, not a hypothetical — the correct outcome
> is a re-scan by the caller or a defer, never a guess.

### 7. After the click

1. `waitForLoadState("domcontentloaded", {timeout: settleMs})`, timeout swallowed
   — "a slow settle is not evidence of anything; classify what is there".
2. Read `page.url()` and `page.content()`. A throw here → `SubmitAmbiguous`.
3. `classify(url, html)` → one of seven kinds.
4. `confirmationUrl` is the URL only when the kind is `confirmation`.
5. Return `{outcome, confirmationUrl, clicked, url, row}`.

Reading the page here is explicitly bounded:

> READING THE PAGE HERE IS SANCTIONED AND NARROW (§4.10): the classifier is a
> pure function over (url, html) and its output is a TYPE, never an instruction.
> Nothing else is read back out of the page for a decision.

The classifier's vocabulary (`classify.mjs`, `CLASSIFICATIONS`) is
`confirmation`, `identity-verification`, `bot-challenge`,
`email-code-challenge`, `posting-gone`, `error`, `unclassified`. On a real board
today the answer is `unclassified`, because every rule in the classifier was
justified by a fixture page and a fixture-sourced rule may fire only on loopback.
`job.mjs` turns that into `post-submit-unclassified` — a **failure** kind at stage
`post-submit`.

### 8. `isProvablyBeforeClick` — the list that must never grow a timeout

```js
const BEFORE_CLICK_PATTERNS = [
  /strict mode violation/i,
  /resolved to \d+ elements/i,
  /element is not attached to the dom/i,
  /no element matches selector/i,
]
export function isProvablyBeforeClick(e) {
  const m = String(e?.message ?? e ?? "")
  if (/timeout/i.test(m)) return false
  return BEFORE_CLICK_PATTERNS.some((re) => re.test(m))
}
```

These are **structural** failures only: the selector matched nothing, or matched
several, or the node left the page. Each of those is decided before Playwright
even begins waiting for the element to become clickable, so no click event was
dispatched. When one of them fires, `submitOnce` abandons the attempt cleanly and
throws `SubmitRefused("plan_clean", …)`.

The comment above the list is the single most important "do not fix this" in the
file:

> A TIMEOUT IS NEVER IN THIS LIST, and the temptation to add one is the reason the
> list is written out rather than expressed as "not a timeout". Playwright
> performs the actionability wait and the dispatch inside ONE call, and its
> timeout message is the same string whether it gave up before "attempting click
> action" or after — so a timeout cannot prove which side of the dispatch it died
> on. An unprovable case must read as ambiguous, and an ambiguous attempt stays an
> orphan for a human to adjudicate. Widening this list to recover a few clean
> defers would trade an orphan the user can resolve for a duplicate application
> they cannot.

### 9. What dry run does, and its honest limit

Dry run is not a no-op. It runs **every** check above, including item 7 — so it
writes a real `(slug, 'dry_run')` row, and that row counts toward your caps on
purpose, because "a rehearsal that did not exercise the cap arithmetic would not
be a rehearsal of the run that matters". The `(slug, mode)` key is what stops
that row from pre-consuming the live claim: the same slug can be rehearsed and
then submitted.

The rehearsal row is **resolved** by `run.recordRehearsal()` rather than left at
`attempted`, because "an unresolved attempt is an orphan, and an orphan halts
EVERY future run until a human looks at a URL — so a dry run that left one would
turn the safe mode into the one that breaks the machine."

And the limit, stated by the file itself:

> everything below the token spend — the click, the post-click classification, the
> attempted -> submitted transition — runs for the FIRST TIME when the user
> enables live mode… Dry run proves the gate. It proves nothing about the click.

### 10. What it reads and writes

**Reads:** the `verifications` table, via `hasPassingVerification`, on its own
short-lived database connection.

**Writes** (all through the injected `run` object from `audit.mjs`):
`auto_submissions` — `beginSubmit` creates a `(slug, mode)` row with
`outcome = 'attempted'`; `recordRehearsal` resolves the dry-run row;
`abandonAttempt` sets `outcome = 'abandoned'` — plus the run's JSONL log.

`auto_submissions` columns: `run_id`, `slug`, `company`, `title`, `submitted_at`,
`mode` (`NOT NULL DEFAULT 'live'`), `plan_sha256`, `confirmation_url`, `outcome`,
`apply_url`, `doc`, with `PRIMARY KEY (slug, mode)`.

### 11. Traps and things not to "fix"

- **Exactly one `.click(` in the file**, asserted by a test.
- **Each of the four token checks is its own explicit comparison, never a regex
  over an error message.** The comment records why the short version was wrong:

  > Calling assertTokenMatches and then deriving WHICH precondition failed by
  > matching its message with a regex is string matching where a type belongs:
  > the message says `is for "acme", not "other"` and a `/slug/` pattern does not
  > appear in it, so three of the four names came out as `token_live`. A report
  > that names the wrong precondition is worse than one that names none.

- **The durable attempt row is written before the click** and is the last thing
  before the token spend.
- **`pageUrl` must be the live URL**, never the planned one.
- **The `(slug, mode)` primary key is not to be "simplified".** From the incident
  record: `(run_id, slug)` let the same slug be submitted once _per run_ — exactly
  backwards for a row whose job is to refuse a duplicate. `(slug)` alone breaks
  the rehearsal: a dry run would pre-consume the live claim forever, and the first
  real run after enabling auto-apply would find every slug taken.
- **`mode` is `NOT NULL` for a reason that is not obvious.** SQLite permits NULLs
  in the columns of a non-`INTEGER` primary key, and **a NULL conflicts with
  nothing** — so a nullable `mode` would silently un-enforce the key, allowing an
  unlimited number of un-refusable duplicate rows for one slug.

### 12. Dependencies

**Imports:** `./authorize.mjs` (`consumeSubmitToken`, `assertTokenMatches`,
`isSubmitToken`, `submitOrigin`, `TokenError`); `../apply/fill-plan.mjs`
(`submitReadiness`); `./untrusted-text.mjs`; `../lib/db.mjs` (`openDb`,
`hasPassingVerification`, `DB_PATH`).
**Depended on by:** `scripts/auto/job.mjs`, `tests/auto/submit.test.mjs`,
`tests/auto/click-surface.test.mjs`.

---

## `scripts/auto/pool.mjs` — the origin-keyed worker pool

### 1. What it is and why it exists

`runPool` runs several jobs at once with one hard rule: **at most one job may be
in flight per origin at any moment.**

An **origin** is the combination of scheme, host and port —
`https://boards.greenhouse.io` is one origin, `https://jobs.lever.co` is another,
`https://boards.greenhouse.io:8443` would be a third. The runner computes it with
`submitOrigin(url)`, which is `new URL(u).origin` after checking the scheme is
one a token may be spent on. (The file's header calls it the "registrable
origin"; the value the code produces is the URL origin.)

### 2. Why the key is the ORIGIN and not the board

This is the single most important paragraph in the file, and it comes from a real
near-miss rather than from theory:

> Revision 1 of the plan keyed in-flight exclusion on `board_key`. That is
> TENANT-scoped (hostname + first path segment + `for=` employer param), while
> cookies and localStorage are ORIGIN-scoped — so "one job per board_key"
> permitted eight concurrent Greenhouse tenants sharing one cookie jar and one
> storage area. The consequence is not theoretical: Greenhouse's embed flow holds
> upload and draft state per origin, so one tab's resume upload token is
> overwritable by another's, and the Coinbase application goes out carrying the
> Tebra-tailored resume — irreversibly, and with nothing in any log saying so.
>
> So: AT MOST ONE JOB IN FLIGHT PER REGISTRABLE ORIGIN, always.

To unpack the mechanism for a reader new to browsers: a **cookie** is a small
piece of data a website stores in your browser and sends back on every later
request; **`localStorage`** is a similar per-site key-value store. The browser
partitions both **by origin** — every page on `https://boards.greenhouse.io` shares
one cookie jar and one storage area, regardless of which company's job you are
looking at.

`board_key` is finer-grained than that. `boardKey(url)` produces things like
`boards.greenhouse.io/embed?for=coinbase` — hostname, first path segment, and the
employer query parameter. Two different employers hosted on Greenhouse get two
different `board_key` values but **the same origin**. So if you excluded on
`board_key`, eight tabs could be open simultaneously on eight employers, all
sharing one storage area — and Greenhouse keeps its file-upload token there. Tab
A uploads Acme's tailored resume, tab B overwrites the token with Coinbase's, and
tab A submits the wrong document. Nothing in any log would say so, and an
application cannot be unsent.

The tradeoff is stated too: concurrency is recovered structurally instead —
cookie-free boards get their own `browser.newContext()` per job, which is genuine
per-job storage isolation.

And a rule that matters to you specifically, given that you want unlimited
application volume:

> N IS A RESOURCE LIMIT THE USER OWNS, NEVER A VOLUME LIMIT. Every queued job is
> still applied to; N bounds only the rate at which work is driven. If a queue
> holds 200 jobs on one origin, this pool runs them one at a time and finishes all
> 200 — it does not drop 199 of them.

### 3. How you use it

Library. Called from `runCampaign` in `auto-apply.mjs`, and from
`scripts/dev/bench-runner.mjs`. Tests: `tests/auto/pool.test.mjs`,
`tests/auto/concurrency.test.mjs`.

### 4. Everything it exposes

```js
runPool({ jobs, runOne, concurrency = 1, onResult = null, shouldStop = null, onSkip = null })
  -> Promise<{ results, max_in_flight, started, skipped, stopped_reason }>

originCount(jobs) -> number
```

| parameter     | contract (from the JSDoc)                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jobs`        | rows with at least `{slug, origin}`                                                                                                                                                                                       |
| `runOne`      | `async (job) -> result`. "Must not throw for a per-job condition; a throw here aborts the pool, which is correct only for a StopError."                                                                                   |
| `concurrency` | worker count. Must be an integer ≥ 1, or `TypeError`.                                                                                                                                                                     |
| `onResult`    | called with each result as it lands, for progress output                                                                                                                                                                  |
| `shouldStop`  | called before each job starts; truthy stops the pool from starting **new** work. "In-flight jobs are allowed to finish — killing them mid-fill would leave exactly the ambiguous half-states the ledger exists to avoid." |
| `onSkip`      | called for every job left unstarted when the pool ends                                                                                                                                                                    |

`max_in_flight` is **sampled, not assumed**:

> THE OBSERVED MAXIMUM IS RETURNED, NOT THE CONFIGURED ONE… a pool CAPABLE of
> eight that serialises on its exclusion key reports N=1 throughput under an N=8
> label — which is then the number a gate enforces forever.

`originCount(jobs)` is the useful upper bound on real concurrency: "a run of 50
jobs at concurrency 8 across 3 origins can never exceed 3, and without this number
that reads as the pool underperforming rather than as the queue being the
constraint."

### 5. How it works, step by step

The pool keeps a copy of the job list, a `Set` of busy origin keys, a counter of
in-flight jobs, and a cursor into the list.

`takeNext()` scans forward from the cursor for the first entry whose origin key is
not busy, blanks that slot, advances the cursor past leading holes, and returns
the job plus its key. Why a scan rather than shifting the job to the back:

> A job whose origin is busy is not dropped and not re-queued at the end: it is
> left in place and retried on the next pass. Moving it to the back would reorder
> the queue by origin contention, which silently de-prioritises exactly the boards
> the user has most leads for.

A job with **no** origin gets a shared sentinel key, so all origin-less jobs are
serialised against each other rather than let through unbounded: "A missing origin
means we do not know what it shares state with, and 'unknown' must be the cautious
end."

That sentinel is written in a way that looks strange and must not be "cleaned up":

```js
const NO_ORIGIN = "\u0000no-origin"
```

> WRITTEN AS AN ESCAPE, NEVER AS A LITERAL NUL BYTE IN THE SOURCE. A raw one
> passes prettier and `node --check` untouched, is invisible in every editor, and
> makes ripgrep classify this file as BINARY — so a codebase-wide search silently
> skips it and reports nothing rather than reporting a miss… The VALUE is
> unchanged; only its spelling is.

(A **NUL byte** is the character with numeric value zero. Two of them had actually
reached `scripts/` before this was found, which made ripgrep skip those two files
entirely during a codebase-wide search. `tests/security/source-bytes.test.mjs` is
now the standing check.)

Each worker loops:

```js
for (;;) {
  if (stoppedReason) return
  const stop = shouldStop ? await shouldStop() : null
  if (stop) { stoppedReason = …; return }
  const next = takeNext()
  if (!next) {
    if (!remaining() || inFlight === 0) return
    await new Promise((r) => setTimeout(r, 15))
    continue
  }
  const { job, key } = next
  busyOrigins.add(key); inFlight += 1
  maxInFlight = Math.max(maxInFlight, inFlight); started += 1
  try {
    const r = await runOne(job)
    results.push(r)
    if (onResult) onResult(r)
  } finally {
    inFlight -= 1
    busyOrigins.delete(key)
  }
}
```

The 15-millisecond sleep is a **busy-wait** (repeatedly checking rather than
waiting for a signal), which is normally a mistake. Here it is defended:

> Nothing startable RIGHT NOW. If work remains it is blocked on an origin another
> worker holds, so yield and look again — this is the one place a busy-wait is
> correct, because the unblocking event is another worker's completion and there
> is nothing to await on.

`min(concurrency, jobs.length || 1)` workers run under one `Promise.all`. When
they finish, every job still in the list is pushed onto `skipped` and passed to
`onSkip`, so the caller can write a reason for it: "the largest single loss bucket
in a degraded run must not be invisible."

**Worked example.** 50 jobs spread across 8 loopback origins
(`http://127.0.0.1:9000` … `:9007`), `concurrency: 8` — this is exactly what
`tests/auto/concurrency.test.mjs` sets up. Eight workers start; each takes the
first job whose origin is free, so all eight origins go busy immediately and
`max_in_flight` reaches 8. Worker 3 finishes `job-3`, releases
`http://127.0.0.1:9003`, and on its next pass picks up `job-11` — the next job on
that origin. All 50 complete; `originCount` is 8. The measured figures for that
workload live in `docs/measurements.md` M9: `wall_ms_p95` 1565 ms,
`model_turns_per_app` 0.

**Contrast:** put all 50 jobs on **one** origin at `concurrency: 8`, and one
worker runs a job while the other seven spin the 15 ms wait. `max_in_flight` is 1
— and all 50 still complete.

### 6. What it reads and writes

Nothing. It imports one helper (`safeText`) and touches no files and no database.
"It contains no policy. No retry rule (job.mjs owns the bounded nav retry), no
trust decision, no cap arithmetic, and NO CLICK."

### 7. Traps and things not to "fix"

- **One in-flight job per origin, always.** This is an invariant, not a heuristic.
- **`max_in_flight` is measured**, and it must stay measured.
- **A `runOne` that throws aborts the whole `Promise.all`** — which is precisely
  why `runJob` catches everything except `StopError`.
- **`busyOrigins.delete(key)` is in a `finally`**, so a throwing `runOne` still
  frees the origin.
- Do not rewrite `NO_ORIGIN` as a literal NUL byte.

### 8. Dependencies

**Imports:** `./untrusted-text.mjs` only.
**Depended on by:** `scripts/auto/auto-apply.mjs`, `scripts/dev/bench-runner.mjs`,
`tests/auto/pool.test.mjs`, `tests/auto/concurrency.test.mjs`.

---

## `scripts/auto/caps.mjs` — the blast-radius arithmetic

### 1. What it is and why it exists

One question, answered from the ledgers: is this application within your per-run,
per-day and per-company-per-week limits? Nothing else.

It is its own file for a reason worth reading, because it is a common shape of
design mistake:

> WHY IT IS ITS OWN FILE. It used to live in audit.mjs, which made audit.mjs a
> dependency of authorize.mjs (the gate needs the caps) — and that meant audit.mjs
> could not import the gate back to check a submit token without an import cycle.
> The concession that followed was beginSubmit taking its token OPTIONALLY, and an
> optional check is not a check.

(An **import cycle** is when file A imports B and B imports A; JavaScript modules
tolerate it badly and one of the two ends up half-initialised.) The fix was to
move the shared piece into a **leaf module** — one that imports only `db.mjs` and
is imported by both. Two alternatives were considered and rejected:

> - having the CALLER inject capCheck into authorizeSubmit — which puts the runner
>   back in charge of supplying its own control, the exact shape this whole
>   inversion exists to remove;
> - a dynamic `import()` inside authorizeSubmit — which makes the gate async and
>   hides the dependency. An async gate at a click site is the one function nobody
>   should have to reason hard about.

### 2. How you use it

Library. Called from `authorizeSubmit` in `authorize.mjs`:

```js
const caps = capCheck({ company, caps: config, sentThisRun, dbFile, now })
```

Also imported by `tests/auto/audit.test.mjs`.

### 3. Everything it exposes

```js
capCheck({ company, caps, sentThisRun = 0, dbFile = DB_PATH, now = new Date() })
  -> { ok: boolean, reason: string|null, counts: object|null }
```

Config keys, read out of `docs/application-limits.yaml`'s `auto_apply` block:

| key                        | your value today | meaning                                         |
| -------------------------- | ---------------: | ----------------------------------------------- |
| `per_run_max`              |               10 | applications one invocation may send            |
| `per_day_max`              |               10 | applications in a rolling 24 hours              |
| `per_company_max_per_week` |                5 | applications to one company in a rolling 7 days |

**A missing cap is a refusal, never a default:**

> `caps` comes from docs/application-limits.yaml's auto_apply block — the USER'S
> file. Nothing here supplies defaults for it: a missing cap reads as "not
> configured" and this returns a refusal, because an unattended process inventing
> its own blast radius is precisely the failure the block exists to prevent.

### 4. How it works, step by step

1. Check all three caps are finite numbers. Any missing → refuse with
   `auto_apply caps not configured: per_day_max, …` and `counts: null`.
2. `if (sentThisRun >= per_run)` → refuse with `per_run_max reached (4/10)`.
   **No database is opened on this path** — it is pure arithmetic on a counter the
   runner keeps in memory.
3. Compute `dayAgo` (now minus 24 hours) and `weekAgo` (now minus 7 days) as ISO
   timestamps.
4. Open a database connection (closed in a `finally`).
5. `countAutoSubmissions(db, dayAgo)` — counts `auto_submissions` rows with
   `submitted_at >= dayAgo` whose outcome is neither `'abandoned'` nor
   `'reconciled-not-sent'`.
6. `companySubmissionBreakdown(db, company, weekAgo)` — returns
   `{live, dry_run, manual, total}`, counting **both** ledgers: the
   `auto_submissions` table and the manual `applications` table.
7. `day >= per_day` → refuse `per_day_max reached (10/10)`.
8. `week >= per_company_week` → refuse, **itemised by source**.
9. Otherwise `{ok: true, reason: null, counts}`.

The itemisation in step 8 exists because the unitemised version misattributed:

> ITEMISED, because the reason has to be one the user can act on and the
> unitemised version misattributed. Dry-run rows count toward this cap on purpose
> (the rehearsal must exercise the arithmetic the live run will), so five dry runs
> against one employer followed by a live enable refuse every application to that
> employer — and the old string blamed "manual applications", sending the user to
> look through a ledger that says nothing of the kind.

The message now reads, for example:

```text
per_company_max_per_week reached for Acme (5/5): 2 auto-submitted,
1 from dry runs (rehearsals, counted on purpose), 2 applied manually
```

### 5. What it reads and writes

**Reads:** `auto_submissions` (columns `submitted_at`, `mode`, `outcome`,
`company`) and the `applications` table, both via helpers in `db.mjs`.
**Writes:** nothing.

### 6. Traps and things not to "fix"

- **Missing config is a refusal**, not a default.
- **Dry-run rows count toward the per-company cap on purpose.** If you rehearse a
  company five times and then go live, that company is blocked for the rest of the
  week. That is the arithmetic doing its job, not a bug.
- **`per_run_max` is checked against an in-memory counter**, not against the
  ledger. That is the one cap that is not ledger-backed, which leads to:

> **Known defect (2026-08-05 audit).** `per_run_max` can be overshot when
> `--concurrency` is greater than 1. In `runCampaign`, `sentThisRun` starts at 0
> and is incremented inside `onResult`, which fires **after** a job completes —
> but the value handed to `runJob` (and from there to `capCheck`) is read when the
> job **starts**. With `per_run_max: 10` and `--concurrency 8`, eight workers can
> all begin holding `sentThisRun = 9` and all pass the check. The per-day and
> per-company caps are ledger-backed and unaffected. This is latent at today's
> default concurrency of 1, but the pool is proven at 8.

> **Known inefficiency (2026-08-05 audit).** `capCheck` opens and closes its own
> SQLite connection on every call, and `openDb` replays the full schema
> (about 30 `CREATE TABLE/INDEX IF NOT EXISTS` statements) plus three healing
> routines on every open. `capCheck` runs once per page transition plus once over
> the merged plan, and `submitOnce` opens a third connection for its verification
> check — so a three-page form replays the schema four or five times per
> application, while `runCampaign` is already holding an open handle it never
> passes down. Threading an optional `db` through
> `capCheck` / `authorizeSubmit` / `submitOnce` would remove that without touching
> any gate.

### 7. Dependencies

**Imports:** `../lib/db.mjs` (`openDb`, `countAutoSubmissions`,
`companySubmissionBreakdown`, `DB_PATH`).
**Depended on by:** `scripts/auto/authorize.mjs`, `tests/auto/audit.test.mjs`.

---

## `scripts/auto/stages.mjs` — the browser leg

### 1. What it is and why it exists

`runJob` and `walkPages` take `openPage`, `scan`, `plan` and `fill` as injected
functions. For a long time `auto-apply.mjs` had a real `openPage` and none of the
other three, so the entire runner was complete and **unreachable**. This file is
the four functions that connect it to a browser.

Its header is the clearest statement of both the problem and the design rule:

> So the whole runner — state machine, trust gate, caps, breaker, pool,
> classifier — was complete and unreachable. This file is the four functions that
> connect it to a browser.
>
> THE STAGES ARE THE SAME CODE THE ATTENDED PATH USES. scan-engine.mjs,
> fill-plan.mjs and fill-engine.mjs, called in process. That is deliberate: an
> unattended path with its own scanner or its own planner would be a second
> implementation of the rules, and the second implementation is always the one
> that quietly disagrees. Everything that makes the attended path safe —
> verify-claims, the confirm-widget gate, the defer taxonomy, rule 1 — is
> therefore automatically true here, because it is literally the same call.

That last point is the most valuable idea in the file. The unattended path is not
_trusted to be as safe as_ the attended path; it **is** the attended path, called
from a different caller.

### 2. How you use it

Library. Called once by `auto-apply.mjs` — `const stages = makeStages({ jobsDir })`
— and by `tests/auto/browser-leg.test.mjs`.

> **Naming trap.** `scripts/leads/stages.mjs` is a completely different file
> (screening stages, imported by `screen.mjs` and `gate-audit.mjs`). Do not
> confuse the two.

### 3. Everything it exposes

| export                           | shape                                                                       |
| -------------------------------- | --------------------------------------------------------------------------- |
| `bankSizeOf(answersPath)`        | `number` — how many answers your answer bank holds; `0` on any read failure |
| `renderedFiles(slug, {jobsDir})` | `{resume?, cover?}` — absolute paths to the PDFs, **omitted when absent**   |
| `makeStages({...})`              | `{scan, plan, fill, classify}`                                              |

`makeStages` options and their defaults: `jobsDir`,
`profilePath = <ROOT>/profile/profile.yaml`,
`answersPath = <ROOT>/profile/answers.yaml`,
`limitsFile = <ROOT>/docs/application-limits.yaml`, `scannerSrc = undefined`.

Both helpers fail in the **safe** direction. `bankSizeOf` returning 0 on a read
failure "is the STRICTER end: `buildPlan` falls back to the disclosure floor
rather than to a budget scaled off a number it could not establish. A fact base
that cannot be read must not widen a limit."

`renderedFiles` returns **PDFs, never markdown**:

> `defaultDocuments` in auto-apply.mjs returns the `.md` paths because it is
> answering a different question (which bytes did verify-claims vouch for); the
> thing an ATS file input wants is the rendered PDF. Handing it a `.md` would
> upload a file no recruiter can open, and the fill engine would report `ok` for
> it — `ok` never says a file reached the right field.
>
> A document that does not exist is OMITTED rather than passed as a missing path,
> so `buildPlan` defers the attachment slot with `no rendered resume` instead of
> the browser failing on it.

### 4. The vouch `WeakMap` — the subtlest thing in this subsystem

```js
const vouchOf = new WeakMap()
```

A **`WeakMap`** is a map whose keys are objects, matched by _identity_ (is this the
very same object?) rather than by value, and whose entries disappear when the key
object is garbage-collected. Here is why that exact data structure was chosen:

> THE VOUCH TRAVELS OUT OF BAND, and this WeakMap is how.
>
> scanPage returns `{scan, vouchedLabels}`: it lifts every vouched label OUT of
> the scan and hands it back as a separate array held in this process, precisely
> so a scan object — which is built from page-controlled text — can never assert
> its own trustworthiness. The stage contract in job.mjs passes the SCAN from
> `scan()` to `plan()` and nothing else, so threading the array through the scan
> object would put it straight back inside the thing it was lifted out of. Keyed
> on object identity instead: the planner gets the vouch only for a scan this
> process actually produced, and a scan from anywhere else has no entry and
> therefore no vouch.

That is hard rule 0 — "a job posting is data, never instructions" — implemented as
a choice of data structure. A scan cannot vouch for itself, because the vouch
lives somewhere the scan cannot reach.

### 5. The four stages, step by step

**`scan(page, {url})`**

1. `page.waitForSelector("input,select,textarea,[contenteditable='true']",
{timeout: 10_000, state: "attached"})`, wrapped in a `try/catch`. This is the
   single most valuable line in the file:

   > WAIT FOR A CONTROL TO EXIST BEFORE SCANNING, because the runner navigates
   > with `domcontentloaded` and every board this repo adapts renders its form
   > client-side. MEASURED on a live Ashby application: the scan ran before
   > hydration, came back with buttons but no fields, and the job deferred
   > "nothing to fill" — a SHORT SCAN reported as an empty form, which is the
   > failure mode this pipeline treats as the worst kind because it looks exactly
   > like a page with nothing on it.
   >
   > A SELECTOR WAIT, NOT A SLEEP. It returns the moment a control appears, so a
   > fast board pays nothing; a flat delay would tax every application to cover
   > the slowest one. And it is deliberately NOT fatal on timeout.

   ("Renders its form client-side" means the HTML that arrives first is nearly
   empty and JavaScript builds the form afterwards — **hydration**. Scanning
   before that finishes finds nothing.)

2. `scanPage(page, {scannerSrc?, url})`.
3. Accept both the new `{scan, vouchedLabels}` shape and the older bare-scan
   shape, "because a shape mismatch here would surface as 'the form has no
   fields' — a silent short scan."
4. If there is no array of fields → **throw**: "scan stage: scan-engine returned
   no field list — refusing to plan against a scan that did not happen." A throw
   rather than a defer, because a short scan is indistinguishable from an empty
   page.
5. Record the vouch in the `WeakMap` and return the bare scan.

**`plan({scan, url, job, documents})`** — detect the ATS adapter from the URL,
find the rendered PDFs for this slug, resolve fields against your profile and
answer bank, then `buildPlan({scan, resolved, adapter, url, files, vouchedLabels,
limits, bankSize})`.

**`fill(page, pagePlan)`** — hands straight to `fillPage(page, pagePlan)` and does
nothing else.

**`classify(url, html)`** — hands straight to `classifyPage(url, html)`, with the
comment: "submit.mjs REQUIRES this in live mode and refuses the click outright
without it, so passing it is not optional plumbing — it is what makes a live
submit reachable at all."

### 6. What it reads and writes

**Reads:** `profile/profile.yaml`, `profile/answers.yaml`, the disclosure block of
`docs/application-limits.yaml`, and `jobs/<slug>/resume.pdf` /
`jobs/<slug>/cover-letter.pdf`.
**Writes:** nothing to disk or the database.

### 7. Traps and things not to "fix"

- **A missing PDF is omitted, never passed as a path.**
- **`bankSizeOf` fails closed (0)**, which narrows a limit rather than widening
  it.
- **A scan without a field list is a throw, not a defer.**
- **The vouch never travels inside the scan object.**
- **The selector wait is not a sleep, and its timeout is not fatal.**

### 8. Dependencies

**Imports:** `node:fs`, `node:path`, `node:url`; `../apply/scan-engine.mjs`;
`../apply/fill-engine.mjs`; `../apply/fill-plan.mjs`; `../apply/disclosure.mjs`;
`../apply/ats/index.mjs`; `./classify.mjs`; `../lib/lib.mjs`.
**Depended on by:** `scripts/auto/auto-apply.mjs`,
`tests/auto/browser-leg.test.mjs`.

---

## `scripts/auto/cycle.mjs` — one whole cycle

### 1. What it is and why it exists

"ONE CYCLE: find jobs, screen them, tailor documents, apply. The thing a scheduler
runs twice a day." Every stage of the pipeline already existed as its own command;
nothing joined them up. This is the join:

```
1. search    find-jobs.mjs      new leads from your boards
2. screen    screen.mjs         l0/l1/l3 verdicts (hard rule 0 lives here)
3. reverify  reverify.mjs       re-run verify-claims where the fact base moved
4. prep      prep-queue.mjs     which leads are worth documents
5. tailor    new-job → keyword-plan → assemble-resume → verify-claims → render-pdf
6. apply     auto-apply.mjs     the runner
```

The header names the property that makes unattended operation possible at all,
and it is not the runner:

> WHY THE WHOLE THING CAN BE UNATTENDED AT ALL: step 4 has no model in it.
> `assemble-resume.mjs` emits each selected fact VERBATIM with its
> `<!-- fact:ID -->` annotation, so rule 1 holds by construction rather than by
> inspection, and `verify-claims` still runs afterwards as the check. A pipeline
> whose tailoring step needed a model could not be scheduled; this one can, and
> that is the property that makes autonomy possible rather than the runner.

### 2. How you run it

```bash
node scripts/auto/cycle.mjs [--top N] [--limit N] [--json]
     [--skip-search] [--skip-apply] [--jobs-dir jobs] [--any-board]
```

| flag            | default         | meaning                                                  |
| --------------- | --------------- | -------------------------------------------------------- |
| `--top N`       | 10              | leads to tailor this cycle                               |
| `--limit N`     | same as `--top` | applications the runner may attempt                      |
| `--jobs-dir D`  | `<ROOT>/jobs`   | workspace root                                           |
| `--skip-search` | off             | reuse the leads already in the store                     |
| `--skip-apply`  | off             | prepare documents and stop before the runner             |
| `--any-board`   | off             | prepare documents even for boards the trust gate refuses |
| `--json`        | off             | emit the whole cycle record as one JSON line             |

Human output is one line per stage, one per lead, one per skipped lead, and a
summary:

```text
search: ok
screen: ok
reverify: ok — 33 stale job(s): 54 re-passed, 0 failed, 0 missing (411ms)
prep: ok
  render-swe-compute-infra: documents ready
  acme-backend-engineer: stopped at verify-claims — 2 unsupported claims
  skipped Globex — Staff Engineer: board not on the allowlist (www.adzuna.com)
prepared=1 run=2026-08-04T02-55-53-304Z-c1900f mode=live submitted=0
```

Nothing in `package.json` runs it; it is meant for an operating-system scheduler.
Exit codes: 0 ok, 2 usage. In practice `main` always returns 0 — "A stage that
fails for one lead is reported and does not change the exit code."

### 3. Everything it exposes

| export                                    | shape                                                                             |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| `step(script, args, {cwd, timeout})`      | `{ok, code, stdout, detail}` — **never throws**                                   |
| `slugFor(lead, {jobsDir, taken})`         | `string` — a filesystem-safe workspace name                                       |
| `prepareDocuments(slug, lead, {jobsDir})` | `{slug, ok, stages: [{stage, ok, detail}]}`                                       |
| `runCycle(argv)`                          | `Promise<{started, stages, reverify?, leads, skipped, prepared, run?, finished}>` |

`step` runs a child process with `spawnSync` and returns its exit code and the
last three lines of stderr (truncated to 300 characters) as **data**:

> NEVER THROWS. A stage is a step in a cycle, not an assertion: `keyword-plan`
> exiting 2 on one posting is a fact about that posting, and turning it into an
> exception would abandon every lead behind it.

`slugFor` builds `company-title` in kebab-case, truncates to 60 characters (so a
long title cannot produce a path Windows refuses), prefixes `job-` if it does not
start with a letter or digit, and suffixes `-2`, `-3` … on collision. The suffix
matters: sharing a workspace "would let the second posting's keyword plan
overwrite the first's tailored resume after it had been verified."

### 4. How it works, step by step

1. Parse `--top`, `--limit`, `--jobs-dir`.
2. Unless `--skip-search`: run `find-jobs.mjs search --source all` (10-minute
   timeout).
3. Always: run `screen.mjs --skip-screened` (10-minute timeout) — "Screening is
   where hard rule 0 is enforced, and the runner refuses an unscreened lead
   outright, so this is not optional housekeeping."
4. **The re-verification sweep** (`scripts/documents/reverify.mjs`, in-process,
   before anything consults eligibility). Every job whose newest recorded
   verification carries a `profile_sha256` other than the current
   `factBaseSha256()` gets verify-claims re-RUN through the normal recording
   path — both `resume.md` and `cover-letter.md` where present. One
   `save-answer` write invalidates every outstanding verification at once
   (the freshness key working as designed), and without this sweep nothing
   ever re-checked the already-tailored workspaces: measured 2026-08-09,
   33/33 tailored jobs stale, `selectEligible` refused all of them; the first
   sweep re-passed all 54 documents (33 resumes + 21 cover letters) in 411ms
   end-to-end through the CLI, with zero LLM calls, and the second sweep found
   nothing stale in 94ms. A document
   that re-passes becomes eligible again; one the new fact base no longer
   supports is recorded as FAILING, printed by name (`re-verify FAILED <slug>
(<mode>): …`), and not re-tried until the facts move again. A sweep that
   cannot run reports `ok: false` and leaves the rows stale — the runner keeps
   refusing them, which is the closed failure direction.
5. Run `prep-queue.mjs --top N --cluster --json` and parse its stdout. A parse
   failure sets a detail message and leaves the queue empty.
6. **The applicability gate, before any document work.** This is the most
   instructive comment in the file:

   > MEASURED, first real cycle (2026-08-03): prep-queue ranks on FIT and knows
   > nothing about where a posting lives, so it picked ten leads of which every
   > single one was refused by the runner a step later — eight on `www.adzuna.com`
   > (an aggregator, not an ATS…) and two on a Workday tenant. The cycle had
   > assembled, verified and rendered a PDF for each. A pipeline that spends its
   > whole budget tailoring documents nothing can submit LOOKS like it is working:
   > every stage reports ok, `prepared=10`, and zero applications go out.
   >
   > So the same gate the runner uses is asked FIRST. `trustBoard` is imported
   > rather than reimplemented on purpose — a second copy of "is this board
   > applicable" is a copy that drifts…
   >
   > A REFUSED LEAD IS NOT DROPPED SILENTLY.

   Implementation: open the database once, index every lead by both `url` and
   `apply_url`, index the screening verdicts the same way, close it, then run
   `trustBoard` per queue entry. A refusal pushes `{company, title, url, reason}`
   onto `skipped`.

7. For each surviving lead, pick a slug and call `prepareDocuments`.
8. Count the successes into `prepared`.
9. Unless `--skip-apply`: spawn
   `node scripts/auto/auto-apply.mjs --limit N --json` (30-minute timeout) and
   parse the last line of its stdout into `out.run`.

`prepareDocuments` runs five or six child processes and **stops at the first
failure**:

|   # | command                                                         | notes                                                                    |
| --: | --------------------------------------------------------------- | ------------------------------------------------------------------------ |
|   1 | `new-job.mjs <slug> --from-lead <url>`                          | only when `jobs/<slug>/job.json` is absent                               |
|   2 | `keyword-plan.mjs <slug>`                                       | "the ONLY step that reads the posting, and it sanitises first — rule 0"  |
|   3 | `assemble-resume.mjs <slug>`                                    | no model involved                                                        |
|   4 | `verify-claims.mjs resume <dir>/resume.md --job <dir>/job.json` | "The durable pass row this writes is what `selectEligible` later reads." |
|   5 | `render-pdf.mjs <dir>/resume.md <dir>/resume.pdf`               |                                                                          |
|   6 | `render-pdf.mjs <dir>/cover-letter.md <dir>/cover-letter.pdf`   | only when the markdown exists, and **not fatal** when it fails           |

Step 6 carries its own measured incident:

> MEASURED on a real run: a workspace holding resume.md and cover-letter.md but
> only resume.pdf made buildPlan defer BOTH attachment slots with "no rendered
> cover", and the whole application failed on a document that was sitting right
> there in markdown… NOT FATAL when it fails. A missing cover letter defers one
> attachment slot; a missing resume defers the application.

### 5. What it reads and writes

**Reads:** the `leads` and `screens` tables directly,
`docs/application-limits.yaml` via `readLimits`, and the existence of
`jobs/<slug>/`.
**Writes:** nothing itself. Every write is done by a child process it spawns —
`jobs/<slug>/job.json`, `resume.md`, `resume.pdf`, `cover-letter.pdf`, the
`verifications` table, `auto_queue`, `auto_submissions`.

### 6. Traps and things not to "fix"

- **This file never decides to send anything.** It prepares, then hands over to
  `auto-apply.mjs`, which reads `enabled` and `dry_run` from your own file.
  "Nothing here can turn a dry run into a live one, and nothing here edits that
  file."
- **It is idempotent on purpose.** "Run it twice and the second run does almost
  nothing: prep-queue excludes leads that already have a verified resume, and the
  runner's durable `(slug, mode)` row refuses a second attempt on a slug."
- **It spawns and the runner must not**, and the asymmetry is explained:

  > job.mjs imports its stages because four spawns per application over 999
  > applications is ~198s of pure process startup on the critical path, and
  > `spawns_per_app` is a gate column asserted to be 0. THIS file runs twice a day
  > over a handful of leads, so a spawn per stage costs nothing measurable — and
  > buys the thing that matters more here: one lead whose keyword plan throws
  > cannot take the other nine down with it, because a non-zero exit is a value
  > rather than an exception.

- **`prepareDocuments` stops at the first failure**, so a PDF is never rendered
  from a resume that failed verification.
- The `flag()` helper refuses a value starting with `--`, so `--top --json` gives
  you the default rather than the string `"--json"`.

> **Known defect (2026-08-05 audit).** `Number(flag(argv, "--top", "10"))` is
> unvalidated: `--top abc` becomes `NaN` and is passed to `prep-queue` as the
> string `"NaN"`. Compare `auto-apply.mjs`'s `parseArgs`, which throws with a
> clear message on the same input.

> **Known inefficiency (2026-08-05 audit).** `runCycle` prepares documents
> strictly one lead after another, and `prepareDocuments` issues five or six
> blocking `spawnSync` calls per lead — two of which are `render-pdf.mjs`, which
> itself shells out to a local Edge or Chrome. At `--top 10` that is roughly 55
> blocking child processes and 20 browser launches, one after another, on the wall
> clock of a scheduled cycle, with `spawnSync` blocking the event loop throughout.
> Leads are independent (each writes only its own `jobs/<slug>/`), so bounded
> parallelism across leads, or one browser process rendering every PDF, would cut
> this materially. The file's own justification — "a spawn per stage costs nothing
> measurable" — accounts for Node startup, not for a Chrome launch per document.

> **Known inefficiency (2026-08-05 audit).** Every eligibility pass loads the
> **entire** `leads` table. `cycle.mjs` runs `SELECT * FROM leads` and builds a map
> keyed on both `url` and `apply_url`, plus two full screening indexes — and then
> the `auto-apply.mjs` it spawns does exactly the same thing again. So one cycle
> materialises every lead row twice. `verifiedResumeUrls` already knows the exact
> URL set that matters, so the lookup could be a parameterised
> `SELECT … WHERE apply_url IN (…)` and the screening indexes could be scoped to
> those lead ids. This is the classic "load everything to look up a handful"
> pattern and it grows linearly with the store.

### 7. Dependencies

**Imports:** `node:fs`, `node:path`, `node:child_process` (`spawnSync`),
`node:url`; `../lib/db.mjs` (`openDb`, `rowToLead`, `screenIndex`); `./trust.mjs`
(`trustBoard`, `readLimits`).
**Depended on by:** nothing in `scripts/` or `tests/` imports it. It is a leaf
entry point intended for a scheduler.

---

## The gates a single application meets, in order

Pulling the whole subsystem together, here is every gate one application passes
through from `cycle.mjs` to a click:

|   # | gate                                      | scope           | what it asks                                                            |
| --: | ----------------------------------------- | --------------- | ----------------------------------------------------------------------- |
|   1 | `preflight`                               | once per run    | is the fact base usable, are the caps configured, is `enabled` true     |
|   2 | `assertFixtureIsolation`                  | once per run    | `--fixture` may not touch the real store                                |
|   3 | `trustBoard` in `selectEligible`          | per candidate   | allowlist, declared adapter, screening verdict, https, origin stability |
|   4 | `breaker.admit`                           | per job         | is this board in a timed backoff                                        |
|   5 | `trustBoard` again in `runJob`            | per job         | the lead store may have changed since the queue was filled              |
|   6 | `walkPages` per-page defer check          | per page        | zero defers on every page                                               |
|   7 | `authorizeSubmit` (per page, then merged) | per page + once | STOP, caps, screening, label flags, submit readiness, company known     |
|   8 | `submitOnce`'s eleven preconditions       | once            | see the table above                                                     |
|   9 | `consumeSubmitToken`                      | once            | the spend — re-reads STOP one statement before the click                |
|  10 | `classify(url, html)`                     | once            | what kind of page came back                                             |

---

## If you were rebuilding this

Three decisions carry almost all the weight. If you rebuilt this subsystem from
scratch and got these wrong, everything else would be cosmetic.

**1. The recovery unit is the job, not the run — and one state must be
unrecoverable.**

The naive design keeps progress in memory and writes a summary when the run ends.
That works until the process dies, and then you cannot tell which of 437 jobs
went out. This design writes a database row at every transition, so recovery is a
`SELECT` rather than a log replay. The subtle part is the one state that is
deliberately **not** resumable: `attempted`. Anything that might already have
reached the employer belongs to a human, not to an automatic retry. A naive
rebuild treats "unknown" as "retry", and the failure mode is duplicate
applications — the thing that destroyed the reputation of at least one commercial
product in this space. Bias every ambiguity toward "leave it for a person".

**2. The exclusion key is the browser's storage boundary, not your mental model
of a board.**

If you write the pool yourself, "one job per board" feels obviously right. It is
wrong, and the reason is a fact about browsers rather than a fact about job
boards: cookies and `localStorage` are partitioned by **origin**
(`https://boards.greenhouse.io`), while your idea of a "board" is finer than that
(`boards.greenhouse.io/embed?for=coinbase`). Eight employers on one Greenhouse
origin share one storage area, and Greenhouse keeps its upload token there — so
concurrent tabs can silently swap each other's resumes. The general lesson
transfers: **when you pick a mutual-exclusion key, pick the one the underlying
system actually partitions on, not the one your domain vocabulary suggests.**

**3. Concentrate every irreversible act in one function, order its checks by side
effect, and make the ordering a documented property.**

`submitOnce` could have been ten small functions. It is one, because the review
surface for "can this send an application?" should be one file you can read in an
afternoon. Within it, the ordering is not style: nine checks that can refuse with
**no trace at all** run first, so refusing is cheap and the system can afford to be
strict; then the durable attempt row; then the token spend one statement before
the click. A naive rebuild would write the ledger row after the click ("record
what happened"), and the first crash mid-click would leave an application sent
with no record. The comment in the schema says it best — **"An attempt is a
submission until proven otherwise."**

A fourth, which is less a design decision than a discipline: **make the
narrowness testable.** "Only two files contain a click" is not a convention
anybody can be expected to remember; it is `tests/auto/click-surface.test.mjs`,
and it is the reason the property is still true after three phases of
development. When a rule matters, write the test that makes breaking it loud.
