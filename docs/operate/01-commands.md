# Every command, and when to use it

This is the catalogue of everything in this repository that you can actually
_run_. There are 47 runnable programs under `src/`, plus a handful of `npm`
shortcuts, and none of them are discoverable by looking at the folder — the file
names tell you roughly what a thing is about, but not what it changes, what it
prints, or which of its flags will quietly rewrite a file you care about. This
document answers those three questions for every one of them.

It is organised **by the task you are trying to do**, not by folder, because
"find jobs" is a thing you want and `src/leads/` is an implementation
detail. Every entry was written by reading the script's own argument-parsing
code — not its README, not its header comment where the header disagreed with
the code. Where a command prints a usage line, the usage line quoted here is the
real output of running it.

**What you will learn**

- How to run any of these at all: what `node src/…` means, where you have to
  be standing when you type it, and what an "exit code" is and why this project
  leans on them so heavily.
- The shared conventions — `--json`, terse-versus-prose output, the
  dry-run-then-`--apply` pattern, and the flags that exist only so tests can
  avoid touching your real data.
- The three commands that are expensive to get wrong: `npm test` (a
  count-asserting gate, not a bare `node --test`; the floor is **2314**),
  `save-answer.mjs` (the only sanctioned way anything enters your fact base, with
  five distinct exit codes), and `gate-audit.mjs` (run it after **any** change to
  a screening rule).
- Every command grouped by task: find jobs, see what to do next, tailor a résumé,
  apply, record an application, follow up, know where you stand, add a job
  board, maintain the store, measure performance.
- For each one: the exact command line, what it does, the flags that matter, what
  it prints, **what it changes**, and the exit codes that carry meaning.
- Which commands write to disk, and — separately and much more importantly —
  which commands can put a real application in front of a real employer.

**Before this**

If terms like "command line", "flag", "exit code" or "JSON" are new, read
[`../guide/02-computer-basics.md`](../guide/02-computer-basics.md) first; it
covers the mechanics this document assumes. For _why_ the pipeline is shaped the
way it is, [`../guide/05-architecture.md`](../guide/05-architecture.md) is the
map, and [`../guide/07-safety-model.md`](../guide/07-safety-model.md) explains
the rules that several of these commands exist to enforce.

---

## Part 0 — How to run any of this

### 0.1 The shape of a command

Almost everything here is one line typed into a terminal, and it always looks
like this:

```
node src/<domain>/<name>.mjs [<subcommand>] [--flag value] [--switch]
```

`node` is the JavaScript runtime — the program that reads a `.mjs` file and does
what it says. `src/leads/find-jobs.mjs` is a path to a file relative to the
project root. So:

```
node src/leads/find-jobs.mjs search --source boards --query "full stack"
```

reads as: _run Node on the file `src/leads/find-jobs.mjs`, tell it to do the
`search` job, sweep only the company boards, and search for the phrase "full
stack"._

**You must be standing in the project root** — the folder that contains
`package.json`, `src/`, `docs/` and `jobs/`. Nearly every script resolves
`jobs/`, `profile/` and `docs/application-limits.yaml` relative to its own
location, so most will work from elsewhere, but several resolve relative to the
current directory and will silently read the wrong thing. `src/auto/cycle.cmd`
exists precisely because Windows Task Scheduler picks its own working directory
and gets this wrong.

### 0.2 Subcommands versus flags versus positional arguments

Three kinds of word can follow the filename, and mixing them up is the single
most common way to get a confusing error.

- A **subcommand** is a bare word naming a mode: `search`, `list`, `add`,
  `archive`, `promote`. Only some scripts have them. It always comes first.
- A **positional argument** is a bare word that _is_ the thing you are operating
  on: a job slug, a filename, a company name. `node
src/documents/keyword-plan.mjs acme-fullstack` — `acme-fullstack` is
  positional.
- A **flag** starts with `--`. Some are switches (`--json`, `--apply`) that mean
  "yes" just by being present; others take a value in the next word (`--top 20`,
  `--status new`).

> **Known defect (2026-08-05 audit; scope corrected 2026-08-24).** Six scripts
> find their positional argument by taking _the first word that does not start
> with `--`_, while reading flag values with a non-splicing `indexOf`. If you
> put a flag first, its **value** gets picked up as the positional. This entry
> named only `find-jobs.mjs` for three weeks; the same defect is in
> `ats-lint.mjs`, `keyword-plan.mjs`, `flake-rate.mjs`, `applications.mjs` and
> `manage-sources.mjs`. In `find-jobs.mjs` it is `cmdImport` and `cmdMark`. `node src/leads/find-jobs.mjs mark --status dismissed
greenhouse:acme:1` looks for a lead whose id is `"dismissed"` and reports `no
lead matches "dismissed"`. Put the positional argument first and this cannot
> bite you.

### 0.3 Exit codes, and why they matter here

Every program ends with a number called an **exit code**. `0` conventionally
means "fine"; anything else means some flavour of "not fine". You will not
normally see it — the terminal swallows it — but this project uses it as a real
communication channel, because the scripts are called by other scripts and by an
AI agent, both of which read the number rather than the prose.

To see it yourself:

```powershell
node src/documents/verify-claims.mjs resume jobs/acme/resume.md
echo $LASTEXITCODE          # PowerShell
```

```bash
node src/documents/verify-claims.mjs resume jobs/acme/resume.md
echo $?                     # Git Bash / Linux / macOS
```

Most scripts here follow a shared convention:

| Code | Meaning across this repository                                          |
| ---: | ----------------------------------------------------------------------- |
|  `0` | Ran fine. (For checkers: **and the check passed**.)                     |
|  `1` | Ran fine, but the answer is "no" — violations found, refused, conflict. |
|  `2` | You typed it wrong, or a required file is missing.                      |

A few commands add codes of their own, and where they do it is because the
distinction is load-bearing rather than decorative — `save-answer.mjs` uses `3`
and `4` to separate "this form text is attacking you" from "this is a number you
should type yourself, not store". Those are called out in each entry.

### 0.4 The npm shortcuts

`package.json` defines six named shortcuts. `npm run <name>` runs them; `npm test`
is special-cased by npm and needs no `run`.

| Shortcut                  | What it actually runs                                       | Notes                                                                     |
| ------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| `npm test`                | `node tools/ci/test-gate.mjs full`                          | **The** gate. See §2.1 — it is not a bare `node --test`.                  |
| `npm run test:security`   | `node tools/ci/test-gate.mjs security`                      | The narrow security-only gate, floor 262.                                 |
| `npm run test:raw`        | `node --test`                                               | Raw runner, no assertions about what ran. Diagnostic only.                |
| `npm run verify`          | `node src/documents/verify-claims.mjs`                      | Convenience alias; takes the same arguments.                              |
| `npm run browser:install` | `node node_modules/playwright-core/cli.js install chromium` | Downloads the headless browser. One-time setup.                           |
| `npm run reap`            | `node tools/ci/scaffolding-reaper.mjs`                      | Fails the build when a development-only file outlives its declared phase. |

### 0.5 How this document marks danger

Three labels appear on entries throughout:

- **READ-ONLY** — this command changes nothing on disk. You can run it as often
  as you like to see what it would say. (A handful of "read-only" commands do
  open `jobs/leads.db`, which creates the file and its empty tables if they do
  not exist yet. They write no rows. Where that matters it is stated.)
- **WRITES** — this command changes a file or a database row. What it changes is
  named in the entry.
- **CAN SEND A REAL APPLICATION** — this command, or something it calls, is
  capable of clicking a submit button on a real employer's website. There are
  exactly two, and §6.6 explains the current configuration in detail.

### 0.6 A note on the sample output in this document

Two kinds of code block appear below and it is worth being able to tell them
apart.

**Usage text and help screens are real captures.** Every `usage:` block quoted
here was produced by actually running the command with no arguments or with
`--help`, and pasted verbatim. If it disagrees with a header comment in the
source, trust the block.

**"What it prints" blocks are format illustrations.** The _shape_ — every label,
every separator, every field name — is taken from the exact template string in the
source. The _numbers and company names in them are made up_, because running these
against the real store would put the owner's live job search into a document. So
`Audited 158 lead(s) through 4 stages in 41 ms.` is exactly the sentence that
command emits; the 158 and the 41 are placeholders.

---

## Part 1 — Conventions every command shares

### 1.1 Terse for programs, prose for people

Almost every script prints two different versions of the same information, and
picks between them automatically. The logic lives in `outputMode` in
`src/lib/lib.mjs`:

```js
export function outputMode(argv = process.argv) {
  if (argv.includes("--verbose")) return "human"
  if (argv.includes("--quiet")) return "terse"
  return process.stdout.isTTY ? "human" : "terse"
}
```

`isTTY` means "is my output going to a real terminal a human is looking at?". If
yes, you get sentences. If the output is being piped into another program or
captured by an AI agent, you get compact pipe-separated records carrying the same
facts in a fraction of the words.

So `node src/leads/recommend.mjs` typed by you prints:

```
[14] Acme Corp — Full-Stack Engineer
  Remote (US) | matches: react, node.js, postgresql
  https://boards.greenhouse.io/acme/jobs/123
```

and the same command called from a script prints:

```
14|greenhouse:acme:123|Acme Corp|Full-Stack Engineer|match:react,node.js,postgresql|gap:kubernetes|https://boards.greenhouse.io/acme/jobs/123
ranked=1 of=58
```

**Never pass `--verbose` from an automated tool call.** It forces the wordy form
into a context where nothing benefits from it, and on a large lead store that is
thousands of words of prose that a program is going to throw away. This is a
standing project rule, not a style preference.

### 1.2 `--json`

Where a command supports `--json`, it prints one JSON document — a structured,
machine-parseable representation of the full result — and nothing else. Use it
when you want to feed the output into another tool, or when you want to see
fields the human-readable summary leaves out.

`--json` is honoured by: `status.mjs`, `screen.mjs`, `recommend.mjs`,
`gate-audit.mjs`, `prep-queue.mjs`, `cluster.mjs`, `board-yield.mjs`,
`discover-boards.mjs`, `find-boards.mjs`, `cc-boards.mjs`, `canonical.mjs`, `keyword-plan.mjs`,
`assemble-resume.mjs`, `ats-lint.mjs`, `reuse-check.mjs`, `letter-plan.mjs`,
`answer-bank.mjs`, `fill-plan.mjs`, `pending-questions.mjs`, `rebuild-plans.mjs`,
`automatability.mjs`, `auth-sync.mjs`, `preflight.mjs`, `auto-apply.mjs`,
`cycle.mjs`, `applications.mjs`, `follow-ups.mjs`, `profile-gaps.mjs`,
`keyword-coverage.mjs`, `prune-jobs.mjs`, `archive.mjs`, `save-answer.mjs`
(under `--rescan` only), and all four `src/dev/` benchmarks.

`check-applied.mjs` and `verify-claims.mjs` print JSON **always** — there is no
prose mode.

> **Known defect (2026-08-05 audit).** `verify-claims.mjs` always emits a
> pretty-printed JSON report with no terse mode. On a long résumé this is
> hundreds of lines of output for what is usually a one-bit answer, and the
> answer is already in the exit code.

### 1.3 Dry run by default; `--apply`, `--confirm`, `--save`

Anything that destroys or overwrites data shows you what it would do first, and
requires a second, explicit flag to actually do it. The flag name is not
consistent across the codebase, which is worth knowing:

| Command                                 | Default    | The flag that commits   |
| --------------------------------------- | ---------- | ----------------------- |
| `maintenance/prune-jobs.mjs`            | dry run    | `--apply`               |
| `maintenance/archive.mjs purge`         | dry run    | `--apply`               |
| `maintenance/migrate.mjs`               | **writes** | `--dry-run` to preview  |
| `leads/enrich.mjs`                      | dry run    | `--apply`               |
| `leads/canonical.mjs`                   | dry run    | `--apply`               |
| `applications/applications.mjs remove`  | refuses    | `--confirm`             |
| `apply/capture-post-submit.mjs promote` | refuses    | `--user-approved`       |
| `leads/gate-audit.mjs`                  | **saves**  | `--no-save` to suppress |

The two inversions — `migrate.mjs` and `gate-audit.mjs` — are deliberate.
`migrate.mjs` is an idempotent rebuild whose whole purpose is to write, and a
gate audit whose result is not recorded gives the next change nothing to compare
against, which is the entire point of running it.

### 1.4 The override flags that exist for tests

You will see the same handful of flags on script after script: `--leads`,
`--db`, `--file`, `--jobs-dir`, `--profile`, `--answers`, `--limits`,
`--applications`. These all mean "use this file instead of the real one", and
they exist so the test suite can exercise the real command against throwaway
fixtures without touching your live data.

**In normal use, omit them.** Every one has a sensible default pointing at the
real store. Passing one by mistake is how data ends up in the wrong place — and
there is a documented incident behind that sentence, described in §2.2.

> **Known defect (2026-08-05 audit).** Several scripts compare an override path
> against a _filename suffix_ rather than a resolved path. In `prep-queue.mjs`,
> `profile-gaps.mjs`, `check-applied.mjs` and `follow-ups.mjs`, an
> `--applications`/`--file` value that ends in `applications.yaml` is converted to
> `null`, which resolves to the **real** application store. A fixture that happens
> to be named `applications.yaml` is therefore silently ignored and the owner's
> live history is read instead.

> **Known defect (2026-08-05 audit).** `recordSweep` in
> `src/leads/find-jobs.mjs` calls `resolveLeadSource()` with no argument, so
> `node src/leads/find-jobs.mjs search --leads /tmp/scratch.db` still writes
> `board_stats` rows into the real `jobs/leads.db`. The `--leads` override is
> honoured everywhere else in that file.

### 1.5 What "writes" means in this project

Three stores exist, and it is worth knowing which one a command touches:

- **`jobs/leads.db`** — a SQLite database, the store of record for leads,
  applications, screening verdicts, verifications, archived documents and the
  unattended runner's queue. Most write commands touch this.
- **`jobs/<slug>/`** — one folder per job you are working on, holding `job.json`,
  `context.json`, `keywords.json`, `resume.md`, `fill-plan.json` and the rendered
  PDFs.
- **`profile/`** — your fact base. **The agent is forbidden from editing this**,
  enforced by a hook. Exactly two commands may write here:
  `scripts/profile/save-answer.mjs` (adds an answer, §2.2) and
  `scripts/profile/apply-profile.mjs` (applies a reviewed whole-profile update,
  §9.4).

`profile/applications.yaml` is a special case: it is a **generated export** of
the `applications` table, not a source of truth. Editing it by hand does nothing
useful; it will be overwritten on the next application write.

---

## Part 2 — The three that are expensive to get wrong

### 2.1 `npm test` — the count-asserting gate

**WRITES** (a temporary directory it cleans up; nothing else)

```
npm test
```

**Do not substitute `node --test`.** That is the mistake this gate exists to
catch, and the reason is one sentence: `node --test` **exits 0 when it runs zero
tests**. A build whose only assertion is "the test runner did not error" reports
success for a suite that was deleted, a folder that was renamed, or a file
pattern that stopped matching. The exit code alone is not evidence that anything
ran.

`tools/ci/test-gate.mjs` wraps the runner and asserts what a green run
must actually _prove_. It fails the build when:

- a required test directory is missing or contains no test files — this is what
  makes an absent `tests/security/` a **failure** rather than a pass;
- the runner produced no TAP summary at all (it crashed or was killed);
- any test failed or was cancelled;
- **fewer tests ran than the configured floor**;
- more tests are marked `todo` than the cap, which is `0` — converting a failing
  test to `todo` is the cheapest way to fake green;
- any test skipped **without a stated reason**. A skip can be legitimate (a Linux
  CI machine has no Edge or Chrome, so the PDF tests cannot run there) but it must
  be explicit and attributed. An unattributed skip is indistinguishable from a
  test that quietly stopped running.

**The floor is 2314.** It lives in `package.json` under
`testGate.full.floor`, next to a `measured` field recording every time it moved
and on what evidence. The rule the project follows: a floor is a number that
**two honest runs actually produced** on a quiescent tree, never the best number
ever seen. Three identical runs on a busy machine once gave 4 → 6 → 0 failures
purely from contention, and duration inflated from 75s to 150s, so a count taken
while other work is in flight is not attributable.

The security gate is separate and narrower:

```
npm run test:security
```

Floor **262**, over `tests/security/`, `tests/lib/untrusted.test.mjs` and
`tests/documents/verify-claims.test.mjs`.

**What it prints** — a block like this, followed by pass or fail:

```
test-gate: full — PASS
  platform    win32 / node v24.x.x
  paths       tests
  files       124 test file(s) after expansion
  tests       2314   (floor 2314)
  pass        2311
  fail        0
  skipped     3
  todo        0   (cap 0)
  duration    149.1s
```

If the count runs 25 or more above the floor, it prints a note suggesting you
raise the floor so future deletions are caught.

**Exit codes:** `0` everything asserted held; `1` at least one assertion failed,
with the reason printed.

**While you are iterating**, run one file instead of the whole suite:

```
node --test tests/apply/fill-plan.test.mjs
```

**Never pass a bare directory to `node --test`.** On Node 24 it does not recurse
— it reports `Cannot find module`, which looks exactly like a test failure and is
not one. Use a quoted glob:

```
node --test "tests/apply/**/*.test.mjs"
```

Run the full `npm test` once, before committing — not mid-implementation, not
after a comment tweak, and not on code that just passed.

### 2.2 `save-answer.mjs` — the only sanctioned fact-base write

**WRITES `profile/answers.yaml`**

```
node scripts/profile/save-answer.mjs "<question>" "<answer>" [--id a-007]
                      [--source user|model] [--class datum|assertion] [--replace]
                      [--file answers.yaml] [--user-approved]
node scripts/profile/save-answer.mjs "<question>" --set-class datum|assertion
node scripts/profile/save-answer.mjs --rescan [--file answers.yaml] [--json]
```

(The three lines above are the script's own `USAGE` constant, verbatim.)

**Why this is the only door.** Rule 1 of this project is that a tailored résumé
may contain only facts from `profile/profile.yaml` and `profile/answers.yaml`.
Rule 2 is that the AI agent never edits those files directly — a hook blocks it.
New information gets in here, after you have said it in chat, and nowhere else.

**What makes it more than a file append.** The _answer_ comes from you. The
_question_ does not — it is a form label copied off an employer's application
page. And `answers.yaml` is permanent, global to every future application, and
part of the evidence corpus that decides whether a claim may appear on your
résumé. So a hostile form label is worth more to an attacker than a hostile job
description: the description influences one tailoring run, an entry here
influences all of them. Both sides of every save therefore pass through the
untrusted-text boundary in `src/lib/untrusted.mjs`.

**The flags that matter:**

- `--source user` (the default) means you said it in chat. `--source model` means
  the agent picked an option off a form and you approved that pick in the
  approval message — still approved, but derived, so a wrong one has to be
  findable and reversible.
- `--class datum|assertion`. A **datum** is a fact about you (email, city, a
  skill, a salary figure); typing it into a form commits you to nothing. An
  **assertion** is something you assert or agree to — work authorisation,
  willingness to relocate, consent to a background check, an e-signature — and it
  must never be acted on unattended, whatever widget a board renders it as.
- `--replace` overwrites an existing entry for the same question, but **only**
  when that entry is `source: model`. A user-stated answer is never overwritten by
  this script.
- `--rescan` re-runs every check against what is _already_ stored and prints a
  report. It never writes. There is deliberately no `--fix` and no `--apply`: an
  auditor that repairs the fact base is a writer wearing a different hat.
- `--user-approved` asserts on the command line, where a hook can see it, that
  you personally gave this answer in chat.

**The exit codes, and they are the point:**

| Code | Meaning                                                                                                                                         |
| ---: | ----------------------------------------------------------------------------------------------------------------------------------------------- |
|  `0` | Saved.                                                                                                                                          |
|  `1` | Conflict — an entry for this question already exists and is not replaceable.                                                                    |
|  `2` | Usage error.                                                                                                                                    |
|  `3` | **Instruction-shaped text.** The question or answer contains something addressed at an assistant. Refused outright rather than stored redacted. |
|  `4` | **A government or financial identifier.** Refused, and there is no override.                                                                    |
|  `5` | The bank was locked by another writer and nothing was written. Retryable.                                                                       |

Under `--rescan`, only `0` (clean) and `1` (findings) are used — `3` and `4` mean
"this write was refused", and a rescan performs no write.

**Exit 4 has no override by design.** A field's meaning is decided server-side,
so a control labelled "Phone number" can POST to a column called `ssn` and no
scanner can tell. That makes the blast radius of a label-lie routing attack
exactly the contents of this file. Bounding the file is the structural fix. If a
form genuinely asks for your Social Security number, it is yours to type — in the
browser, on the page you are looking at. The refusal message never echoes the
value it refused, because printing it while refusing to store it would put it in
a terminal, a transcript and a log.

**A shell guard sits in front of this script**
(`.claude/hooks/guard-profile-shell.mjs`) and denies any shell invocation
targeting the default fact base unless it carries `--file <temp>`,
`--user-approved`, or `--rescan`. That guard exists because of a real incident:
on 2026-07-31 an agent verifying this script invoked it with `--answers <tmp>` —
the real flag is `--file` — the unknown flag was silently dropped, and three
probe values landed in the real `profile/answers.yaml` stamped `source: user`,
which was false. One was a fabricated phone number that then resolved cleanly
against the label appearing on nearly every application form. The parser is now
strict: **any unrecognised `--flag` is exit 2**, and so is a third positional
argument, because that is what a swallowed `--answers <path>` looks like.

### 2.3 `gate-audit.mjs` — run after ANY gate change

**WRITES `jobs/.gate-baseline.json` by default**

```
node src/leads/gate-audit.mjs [--json] [--status all|new|...]
     [--baseline <file>] [--no-save] [--leads <path>] [--profile <path>]
```

**What a "gate" is.** As leads come in, they pass through a series of checks —
title matches a target role, location is reachable, posting is not stale, the
body does not require a security clearance, the fit score clears a bar. Each check
is a gate. Tightening one is a two-word edit that can silently discard dozens of
jobs you would have wanted.

The four ordered stages, from `STAGE_IDS` and `STAGE_LABELS` in
`src/leads/stages.mjs`:

| Stage | Label                 | What it checks                                                                     |
| ----- | --------------------- | ---------------------------------------------------------------------------------- |
| `l0`  | `title/location/date` | The cheap gate: is this the right kind of job, somewhere reachable, still fresh?   |
| `l1`  | `body disqualifiers`  | Does the description itself rule it out (clearance, polygraph, on-site elsewhere)? |
| `l2`  | `profile fit`         | Do the required years and technologies clear the bar your profile can meet?        |
| `l3`  | `scam/ghost risk`     | Repost history, injection findings, and the ghost-job signals.                     |

**Why this command exists.** The worst failure in this system is a job you never
see, and it is invisible by construction: nothing tells you about the posting that
got filtered out. This re-runs every screening stage over the **whole** stored
lead set and diffs the result against the last recorded run.

**The asymmetry is deliberate.** A newly _accepted_ lead is a win and gets one
line. A newly _rejected_ lead is the dangerous direction, so those are listed in
full, with the stage and the reason that killed them, every time.

**What it prints** (prose mode):

```
Audited 158 lead(s) through 4 stages in 41 ms.

  93 pass every stage
  38 rejected at l1 (body disqualifiers)
  27 rejected at l2 (profile fit)

Compared against 158 lead(s) in the baseline.

!! 6 lead(s) NEWLY REJECTED — check each one:

  Station Casinos — Software Engineer II
    l2: required years 5 exceeds profile 3 + stretch 2

Baseline written to C:\...\jobs\.gate-baseline.json
```

**Exit codes** — and this one is genuinely useful:

| Code | Meaning                                                     |
| ---: | ----------------------------------------------------------- |
|  `0` | Clean, or only improvements (leads recovered).              |
|  `1` | **At least one lead became newly rejected.** Read the list. |
|  `2` | Usage error or missing lead store.                          |

**What it changes:** it rewrites `jobs/.gate-baseline.json` with the current
verdicts, so the next run has something to diff against. Pass `--no-save` if you
are running it purely to look.

> **Known defect (2026-08-05 audit), and this one limits the command's promise.**
> `gate-audit.mjs` runs only `evaluateStages`. It never calls `screenJob`, so the
> scam-pattern list, the blocker patterns (security clearance, polygraph) and the
> years-of-experience seniority gate are **outside the audit** — yet all three
> produce `verdict: 'reject'` in `screen.mjs`. Change the stretch-years constant
> and this command reports "No lead became newly rejected" while `screen.mjs`
> silently discards dozens.

> **Known defect (2026-08-05 audit).** `screen.mjs` builds the job it screens by
> folding in the captured posting text from `jobs/<slug>/job.json`;
> `gate-audit.mjs` passes the raw stored lead. For any lead that has a workspace,
> the audit judges a **shorter body** than the live screen does, so a lead can
> pass the audit and be rejected by `screen.mjs`, or the reverse.

---

## Part 3 — Find jobs

### 3.1 `find-jobs.mjs search` — the daily sweep

**WRITES `jobs/leads.db`**

```
node src/leads/find-jobs.mjs search [--source all|hn|boards|adzuna]
     [--query "full stack"] [--max-age N] [--concurrency 8]
     [--no-enrich] [--explain [N]] [--leads <path>]
```

Goes out to every board in `docs/job-sources.yaml`, asks each one "what jobs do
you have right now?", filters everything through `docs/application-limits.yaml`,
removes duplicates against what is already stored and against your application
history, and saves the survivors as **leads**.

**Flags:**

- `--source` picks which families to sweep. `boards` is the company career pages;
  `hn` is Hacker News' job feed; `adzuna` is an aggregator that needs credentials
  in `.env`. Default `all`. With `--source all` a missing Adzuna key is a soft
  skip; asking for `adzuna` explicitly makes it a hard failure.
- `--query` is the search phrase. Resolution order is: this flag, then
  `roles.search_query` in `docs/application-limits.yaml`, then the built-in
  default `"full stack"`. It matters for exactly one board type — Workday, where
  the query is a server-side filter.
- `--max-age N` overrides the staleness cutoff for this run only.
- `--concurrency N` (default 8) is how many boards are fetched at once. Higher is
  faster and rougher on the ATS vendors.
- `--no-enrich` skips the follow-up fetch that pulls a description for boards
  whose list endpoint carries none.
- `--explain [N]` prints why postings were rejected, for the top N reasons
  (default 30).

**What it prints:** a summary of how many were kept and rejected, per-board sweep
timing, and a line like `enriched=4/7`. Failures are printed to stderr as
`warn: source failed: <label> — <reason>` and never lose the rest of the sweep.

**What it changes:** inserts new lead rows into `jobs/leads.db`, bumps
`repost_count` on leads it has seen before, indexes each new lead's technology
keywords into `lead_keywords`, and records per-board statistics into
`board_stats`. The write happens inside a file lock; the network fetches
deliberately do not.

**Exit codes:** `2` for a bad subcommand, `1` for an unhandled error.

### 3.2 `find-jobs.mjs import` — leads captured by hand

**WRITES `jobs/leads.db`**

```
node src/leads/find-jobs.mjs import <file.json> [--no-enrich] [--leads <path>]
```

Takes a JSON file containing either an array of postings or an object with a
`leads` key, and runs it through exactly the same gates, dedupe and commit as a
sweep. This is how a posting you found in a browser session gets into the store.

### 3.3 `find-jobs.mjs list` and `mark`

**`list` is READ-ONLY; `mark` WRITES `jobs/leads.db`**

```
node src/leads/find-jobs.mjs list [--status new|recommended|dismissed|applied|all]
node src/leads/find-jobs.mjs mark <id-or-url> --status <status> [--notes "..."]
```

`list` defaults to `--status new`. `mark` accepts exactly the four statuses
`new`, `recommended`, `dismissed`, `applied`, and matches its argument against a
lead id **or** a URL (normalised, so trailing slashes and query strings do not
matter). It performs a single-row update rather than rewriting the whole store —
marking 57 leads used to mean 57 full rewrites of a 321 KB file.

### 3.4 `enrich.mjs` — fetch the missing descriptions

**Dry run by default; `--apply` WRITES `jobs/leads.db`**

```
node src/leads/enrich.mjs [--apply]
```

Four of the swept ATS types return a job _list_ with no description at all
(`oracle_cloud`, `smartrecruiters`, `successfactors`, `workday`). Those happen to
be the local Las Vegas employers — the highest-value leads for someone who can
work on-site. A lead with no description cannot be keyword-indexed and cannot be
screened for blockers, so it is simultaneously the least examinable and the most
important.

This walks the stored leads, finds the ones that could be enriched, and fetches
one description each. Without `--apply` it prints `would-fetch <id>` per
candidate and a count. With `--apply` it fetches, updates the rows inside a
transaction, and **re-indexes each lead's keywords** — because keywords are
derived from the description, and skipping the re-index would waste the fetch.

### 3.5 `canonical.mjs` — resolve an aggregator link to the real ATS page

**Dry run by default; `--apply` WRITES `jobs/leads.db`**

```
node src/leads/canonical.mjs [--apply] [--network] [--limit N] [--json]
```

Measured on the real store on 2026-08-03, 74 of 158 leads (47%) carried a host
that is not an ATS at all — mostly aggregator links. The unattended path refuses
any board whose host is not on your allowlist, so nearly half the supply would be
refused at the gate even when the form behind the link is an ordinary Greenhouse
page.

This resolves a lead's URL to the ATS-hosted posting behind it and stamps
`apply_url` on the lead.

- Without `--network`, only the free tiers run: everything resolvable from what
  the board API already told us, at zero third-party requests. This is what the
  daily sweep runs.
- `--network` opts into the aggregator tier, which costs one HTTP request per
  lead. Measured at 0 resolutions out of 21 on the two aggregators this store
  actually uses, so it is off by default for a reason.
- `--limit N` bounds how many pages a single run will fetch, and the bound applies
  only to the leads that would actually cost a request.

The security shape of this file is worth knowing: it takes a URL chosen by a
third party and produces a URL a later stage will **trust**. Three rules make
that safe — the output must itself be an ATS URL, checked _after_ resolution;
hostnames are matched anchored against the parsed host, never as a substring of
the whole URL; and anything that resolves elsewhere is reported UNRESOLVED rather
than "resolved to whatever it gave us".

### 3.6 `screen.mjs` — the mechanical first pass

**WRITES the `screens` table in `jobs/leads.db` (suppress with `--no-record`)**

```
node src/leads/screen.mjs [--status new] [--json] [--skip-screened]
     [--no-record] [--stage l0,l1,l2,l3|all]
     [--leads <path>] [--jobs-dir <path>] [--limits <path>] [--profile <path>]

node src/leads/screen.mjs record <lead-id> --verdict pass|caution|reject
     [--reason "..."] [--signals a,b] [--source model]
```

Deterministic, offline, no AI. Looks for ghost-job, scam and vagueness signals
and runs each lead through the four ordered stages `l0`–`l3`. Verdicts are
`pass`, `caution`, `reject`.

- `--skip-screened` leaves out leads that already carry a verdict from the AI
  judgment pass. That pass fetches the live posting and is genuinely expensive;
  this pass costs about 125 ms for the entire store, so its own cache saves
  nothing. The cache is for the model's benefit.
- `--stage` narrows to one layer for diagnosis: "what would L2 alone say about
  the store?"
- The `record` subcommand is how a model-produced verdict gets written into the
  cache.

**What it prints** (terse): one line per non-passing lead, then a summary like
`pass=93 caution=12 reject=53 l1=38 l2=15 model-screened=40`.

> **Known defect (2026-08-05 audit; wording corrected 2026-08-24).** `--stage` is
> documented as a diagnostic, but it is not paired with the recording block —
> which runs unless `--no-record` is passed. (This entry used to say the block
> runs "unconditionally"; it does not, and the workaround below was right for
> the wrong reason.) `node src/leads/screen.mjs --stage l0` therefore
> **overwrites the stored `mechanical` verdict for every lead** with one
> computed from a single stage — and that stored row is what the
> unattended runner reads as its screening evidence when no model verdict exists.
> Pair `--stage` with `--no-record` until this is fixed.

---

## Part 4 — See what to do next

### 4.1 `recommend.mjs` — rank the leads

**READ-ONLY**

```
node src/leads/recommend.mjs [--top 10] [--status new|recommended|all]
     [--json] [--leads <path>] [--profile <path>] [--jobs-dir <path>]
     [--applicable [--limits <path>]]
```

Scores every lead against your profile — technology overlap, role-title fit,
freshness, salary signal, minus risk flags — and prints the best N. This is the
job an AI used to do by reading every lead; now the model only interprets a short
ranked list, or nothing at all.

**`--applicable` (2026-08-17)** ranks the same way, then lifts the leads the
machine can actually finish — an `apply_url` on your `board_allowlist` — above
the rest **before** cutting to N, so the top N is a list of things that can be
sent rather than a list of things that fit. Every row carries its tier either
way (`automatable` / `off-allowlist` / `manual-only`, the same tiers as
`prep-queue.mjs`), in the terse output as a column before the URL and in
`--json` as `applicability`; the URL printed is `apply_url` when there is one.
Why: on 2026-08-17 four of the fit-ranked top five were Adzuna redirects that
`canonical.mjs` cannot resolve — the host answers 403 to robots, a bot wall and
not a parser gap, and it is not to be dressed around — and the morning digest
read them out as recommendations nothing could act on. **The daily digest should
run `--top 5 --applicable`** for the list of things to do, and plain `--top 5`
only if it also wants the hand-apply supply.

**One output detail worth understanding.** If every lead scores identically, the
sort falls through to alphabetical-by-company, and a flat list _labelled_ as
ranked is worse than a flat list labelled as flat. So it prints:

```
NOTE: every lead below scored identically (8) — this is NOT a ranking, it fell
through to alphabetical order by company. titleScore currently only distinguishes
software-engineering titles (roles.title_rank in docs/application-limits.yaml);
if the target role changed, that list needs updating for these results to mean
anything.
```

**Exit codes:** `2` if the profile is missing, the lead store is missing, or no
lead carries the requested status.

> **Known defect (2026-08-05 audit).** There is no status mode covering
> "new **plus** recommended". Marking a lead `recommended` therefore removes it
> from the default `--status new` view, so surfacing a lead hides it.

### 4.2 `prep-queue.mjs` — what to tailor before you sit down

**READ-ONLY**

```
node src/leads/prep-queue.mjs [--top 5] [--status new|all] [--json]
     [--leads <path>] [--profile <path>] [--jobs-dir <path>]
     [--applications <path>] [--limits <path>] [--cluster [--threshold 0.6]]
     [--by-score] [--include-rejected]
```

Tailoring a résumé takes a subagent a few minutes. Doing it at apply time puts
that on the critical path with you waiting; doing it during the nightly sweep
makes applying a fill-and-review step. This picks the targets. It does no
tailoring itself.

A lead is queued when it ranks well, has not been applied to, and has no verified
tailored résumé yet. `--cluster` collapses near-duplicate postings so a group one
résumé can serve costs one queue slot instead of four.

**Ordering is by applicability first, fit second (2026-08-09).** Each queued lead
reports an `applicability` tier, and the summary line counts them:

| tier            | meaning                                                                          |
| --------------- | -------------------------------------------------------------------------------- |
| `automatable`   | resolved to an ATS posting on your `board_allowlist` — the machine can finish it |
| `off-allowlist` | resolved to a real ATS posting, but no adapter ships for that board              |
| `manual-only`   | never resolved past the aggregator — you can still apply by hand                 |

Why: on the 2026-08-09 cycle all ten slots went to Adzuna leads that carry no
`apply_url`, and the run prepared zero documents while nine submittable leads sat
below the cut-off. Fit alone is the right order for a list you read and the wrong
one for a queue whose output is a tailored document.

**Nothing is filtered out** — a `manual-only` lead is still a job you can apply to
yourself, so it is ranked down, never hidden. `--by-score` restores the old
fit-only ordering.

**One exception (2026-08-18): a lead screening already rejected.** The queue
reads the same stored verdict the runner's trust gate reads (`screens` table,
model first, mechanical fallback) and leaves a `reject` out — it is not
hand-apply-only, it is a lead the pipeline decided against, and it used to take
prep slots the cycle then spent or skipped. The summary line counts them as
`screened_out=N`; `--include-rejected` puts them back.

**Exit codes:** `0` ok, `2` usage or missing store.

**Fixed 2026-08-17 (was a known defect from the 2026-08-05 audit):**
`prep-queue.mjs` now ranks with the same `keywords` map and `limits` as
`recommend.mjs` — both call `rankingContext()` in `recommend.mjs` — so one lead
gets one score in both places (Torc Robotics read 19 in one and 5 in the other
before). And it ranks **everything, partitions by applicability, then cuts** the
window: it used to cut `max(top*4, 20)` by score first and partition inside,
which at the default `--top 5` produced `manual_only=5 automatable=0` while
seventeen automatable leads sat just outside the window. The summary line now
also carries `supply=A/O/M` — the tier counts over the **whole** ranked store —
so `manual_only=5` can never again read as "that is all there is". Captured
posting text is still not folded in.

### 4.3 `cluster.mjs` — which leads are the same job twice

**READ-ONLY**

```
node src/leads/cluster.mjs [--status new|all] [--threshold 0.6]
     [--min-size 2] [--leads <path>] [--json]
```

Two "Full-Stack Engineer" roles that both want React, Node, TypeScript and
Postgres do not need two tailoring runs; they need one résumé and two
applications. This groups leads by title-plus-stack similarity so you can see
where that applies. It recommends; you approve the reuse.

**Exit codes:** `0` ok, `2` usage or missing store.

### 4.4 `automatability.mjs` — could the machine apply to this one alone?

**READ-ONLY**

```
node src/apply/automatability.mjs [--json] [--top N]
     [--jobs-dir <dir>] [--cache <file>] [--profile <p>] [--answers <a>]
```

Sorts leads into four tiers, first match wins:

| Tier      | Meaning                                                       |
| --------- | ------------------------------------------------------------- |
| `handoff` | The board needs an account we are not permitted to create.    |
| `blocked` | Something about **our** state forbids applying at all.        |
| `amber`   | Could be automatable, but we cannot know from here.           |
| `green`   | A pre-filter says the engine alone would very likely suffice. |

**`green` is a pre-filter, not an authorisation.** It reasons entirely from a
remembered form shape in `jobs/.field-cache.json` — no browser, no network, no
model. The remembered shape can be out of date and the page it describes is
written by a third party, so `green` means only "worth opening". Nothing in this
file authorises a click.

This is deliberately **not** registered as a screening stage. A stage rejection
becomes `dismissed`, so making automatability a stage would turn "the engine
cannot do this one alone" into "you never see this job".

### 4.5 `pending-questions.mjs` — every question the fact base cannot answer

**READ-ONLY**

```
node src/apply/pending-questions.mjs [<slug> ...] [--jobs-dir jobs]
     [--no-predict] [--profile <path>] [--answers <path>] [--json]
```

`profile/answers.yaml` is global: "Do you require sponsorship?" answered once
resolves it for every application ever. Today the flow still asks per job, while
you are sitting at a form, so the same question is asked N times and N−1 of those
are pure latency. Collect them up front, answer once, and the deferral list for
every one of those applications drops by the same amount.

Two sources: `plan` (a deferral already computed for a scanned form — certain)
and `predicted` (a required field remembered in the field cache for an ATS these
jobs use, that the fact base still cannot resolve — likely, and available before
any browser is opened). `--no-predict` drops the second.

Consent, terms and e-signature fields are **never** listed. They are yours to
tick in the browser, not questions with answers worth storing.

A plan older than the planner, the adapters or `profile/answers.yaml` is **not
read at all** — it is counted on a `stale` line instead. A fill plan is a cached
derivation of (scan, planner, fact base) and only the scan is bound to it, so an
old plan reports deferrals current code would not produce. Rebuild with §4.6
before trusting the list.

**Exit codes:** `0` ok, `2` missing jobs directory.

### 4.6 `rebuild-plans.mjs` — re-derive stale plans from the saved scan

**WRITES `jobs/<slug>/fill-plan.{js,json}` and `jobs/.field-cache.json`**

```
node src/apply/rebuild-plans.mjs [<slug> ...] [--all] [--dry-run]
     [--jobs-dir jobs]
```

Rebuilds every plan that predates its inputs, reading the scan already on disk —
**no browser, no network**. It changes no answers and makes no decisions: every
deferral it clears is one current code resolves on its own. `--all` rebuilds
regardless of age; `--dry-run` lists what would be rebuilt.

Measured 2026-08-20: 28 of 29 plans predated the Greenhouse typeahead fix
(2026-08-18), so `pending-questions.mjs` was still asking for a location banked
on 2026-08-07. A plan with no scan on disk cannot be rebuilt here and is named
on a `no-scan` line rather than skipped silently.

**Exit codes:** `0` ok (including nothing to do), `1` a rebuild failed, `2`
missing jobs directory.

---

## Part 5 — Tailor a résumé (and a cover letter)

The sequence, in order, is: `new-job` → `keyword-plan` → `assemble-resume` →
`verify-claims` → `render-pdf` → `ats-lint`. `reuse-check` and `letter-plan` sit
alongside it.

### 5.1 `new-job.mjs` — scaffold the workspace

**WRITES `jobs/<slug>/job.json` and `jobs/<slug>/context.json`**

```
node src/documents/new-job.mjs <slug> --company "Acme" --title "Full-Stack Developer"
     [--url <url>] [--root jobs]
node src/documents/new-job.mjs <slug> --from-lead <url|lead-id> [--leads <path>]
     [--description "<posting text>" | --description - | --description-file <path>]
```

`--from-lead` fills company, title, location, URL and description straight out of
the lead store, instead of having a model re-read the live posting for fields the
sweep already captured. Explicit `--company`/`--title` still win.

**Two description paths, two different trust stories.** With `--from-lead`, the
sweep already sanitised the body on the way in, so the stored text is clean;
re-sanitising would redact twice and double-count the findings. With
`--description` or `--description-file`, a model read the live page and handed
over raw text that nothing has looked at yet, so it goes through
`sanitizeHtmlSnippet()` before it is written into the file the tailoring model
will read. `--description -` means "read it from standard input", which is how a
6,000-character page grab gets in without going through a command line.

**Exit codes:** `0` ok, `1` the workspace already exists, `2` usage,
`4` `--from-lead` matched no lead (the caller falls back to reading the page).

### 5.2 `keyword-plan.mjs` — the honest keyword target

**WRITES `jobs/<slug>/keywords.json`**

```
node src/documents/keyword-plan.mjs <slug> [--json]
     [--jobs-dir <d>] [--profile <p>] [--answers <a>] [--limits <l>]
```

Two gatekeepers read a résumé: the classic ATS parser doing literal keyword
matching, and an AI layer on top of it. This gives the tailoring step a concrete,
truthful target for both.

The output has two lists, and the distinction is the whole design:

- **`must_use`** is the **intersection** of the posting and your fact base. Every
  term in it is already true of you, so placing it invents nothing.
- **`blocked`** is the posting's other terms, listed precisely so they stay out.
  `verify-claims` rule R6 enforces that independently.

Evidence comes from `evidenceText()`, not the raw answers file, because a form
question enumerating "AWS, Azure, or GCP" is not evidence of Azure. A compound
question answered "Yes" is dropped for the same reason: one yes cannot say which
of three it meant.

**What it prints:** the `must_use` list with placement guidance, the `blocked`
list with a note that R6 will reject them, and the density cap.

**Exit codes:** `2` if the slug has no workspace, or the profile is missing.

### 5.3 `assemble-resume.mjs` — deterministic tailoring

**WRITES `jobs/<slug>/resume.md` and `jobs/<slug>/resume-selection.json`**

```
node src/documents/assemble-resume.mjs <slug> [--budget 3800] [--out <f>]
     [--json] [--diff] [--stdout] [--no-selection-file]
     [--jobs-dir <d>] [--profile <p>] [--answers <a>] [--limits <l>]
     [--audit-rephrase <file>]
```

Every other path in this repository routes your fact base through an AI model,
and a model is the one component in the document pipeline that _can_ lie.
`verify-claims` catches an invention that was already proposed; this **removes
the operation**. It emits each selected fact's text verbatim, byte for byte, with
the `<!-- fact:ID -->` annotation naming where it came from. Verbatim emission
cannot invent a skill, an employer, a date or a metric, so rules R1–R7 hold by
construction. It takes **zero model turns**.

The posting influences exactly one thing: **which** of your own facts get
selected. It can never contribute a word of text to the document. That includes
**which summary paragraph** goes out: if you bank several in `profile.yaml`
(one per track), exactly one is emitted — the one whose terms best cover what
the posting asks for, ties going to whichever you listed first. So the order of
`summary:` in your profile is a preference: put your general one first.

**Guards:** it refuses to run unless `profile.yaml` has `meta.approved_by_user:
true`, and says so rather than guessing. And when you have two or more summary
variants and **none** covers a term the posting asks for, it refuses to
assemble at all (`no-summary-fit`, exit `3`, nothing written) — a posting none of
your tracks addresses is not one to pick a paragraph for. With a single variant
it always assembles; there is nothing to mis-choose.

**Output modes:** `--json` prints the selection record; `--diff` prints a
human-readable "what was emphasised, dropped, rephrased" table, with the summary
choice and every variant's score on its second line; `--stdout` writes the
markdown to the terminal instead of a file. Default terse output looks like:

```
assembled=jobs/acme/resume.md facts=18 dropped=7 chars=3612/3800 keywords=9/11 summary=summary-fs model_turns=0
```

**Exit codes:** `2` for usage, a missing workspace, a missing profile, a bad
`--budget`, or an unapproved fact base; `3` for `no-summary-fit`. Under
`--audit-rephrase`, `0` means the rephrase both preserved the facts and still
verifies; `1` means it did not.

### 5.4 `verify-claims.mjs` — the truthfulness gate

**WRITES a row into the `verifications` table (suppress with `--no-record`)**

```
node src/documents/verify-claims.mjs resume <file.md>
     [--job jobs/<slug>/job.json] [--profile profile/profile.yaml]
     [--answers profile/answers.yaml] [--jobs-dir <d>] [--db <path>] [--no-record]
node src/documents/verify-claims.mjs cover-letter <file.md> [same flags]
```

**This is hard rule 4: it must pass before any document is rendered or shown as
final.**

The seven rules, in résumé mode:

| Rule | What it requires                                                    |
| ---- | ------------------------------------------------------------------- |
| R1   | Every bullet line carries `<!-- fact:ID[,ID2] -->`.                 |
| R2   | Every cited fact id exists in the profile or answers.               |
| R3   | Every number in an annotated bullet appears in a cited fact's text. |
| R4   | Every number outside bullets appears somewhere in the corpus.       |
| R5   | Every "Mon YYYY" date token appears in the corpus.                  |
| R6   | Every known technology term in the document appears in the corpus.  |
| R7   | The document contains at least one annotated bullet.                |

Cover-letter mode runs R4–R6 only. The corpus additionally includes the job's
company and title so the letter can address them — but **never the posting body**,
so a technology that appears only in the job ad still fails R6.

**Output:** a JSON report on stdout, always. **Exit `0` = pass, `1` = violations,
`2` = usage error.** The exit code is what every caller reads.

**What it changes:** records the verdict — pass _and_ fail — into the
`verifications` table, so a later reader can distinguish "checked and rejected"
from "never checked". A database problem is reported on stderr and on the report
but never changes the verdict; a locked database must not turn a truthful
document into a verification failure.

### 5.5 `render-pdf.mjs` — markdown to PDF

**WRITES the output PDF and an intermediate `.render.html` beside it**

```
node src/documents/render-pdf.mjs <input.md> <output.pdf> [--letter] [--css templates/document.css]
```

Shells out to a locally installed Edge or Chrome in headless mode. It looks for
one in a fixed list of paths; set `PDF_BROWSER` to an executable path to override.
The `<!-- fact:ID -->` annotations are stripped before rendering. `--letter`
selects the cover-letter stylesheet instead of the résumé one.

Two post-processing steps put real text into the document that would otherwise
never reach the PDF's text layer: CSS bullet markers (Chrome draws them without
emitting any text, so a whole role extracts as one merged line) and link URLs
(which live only in PDF link annotations, so a résumé showing "LinkedIn | GitHub"
hands the parser no address at all).

**Exit codes:** `0` rendered, `1` the PDF was not produced or is not a valid PDF,
`2` usage or missing input, `3` **no Edge or Chrome found**.

### 5.6 `ats-lint.mjs` — will an ATS be able to read it?

**READ-ONLY**

```
node src/documents/ats-lint.mjs <resume.md> [--html <f.render.html>]
     [--pdf <f.pdf>] [--plan jobs/<slug>/keywords.json] [--json]
```

Checks the markdown, the intermediate HTML (which is the exact input Chrome turns
into the PDF), and structurally checks that the PDF is text-based rather than an
image. If you omit `--html` or `--plan` it guesses the conventional filenames
beside the markdown.

**Honest limit, stated by the script itself:** it does **not** decode the PDF's
text layer. Chrome subsets fonts with Identity-H encoding, and reading that back
needs a PDF library this project deliberately does not have. Every hazard it
checks is a property of the input, so checking the input catches them — but a
font-level regression inside Chrome would not be caught.

**Exit codes:** `0` clean (warnings are allowed), `1` problems found, `2` usage.

### 5.7 `reuse-check.mjs` — can I reuse a résumé I already tailored?

**WRITES cached rows into `workspace_stacks` when the cache is on**

```
node src/documents/reuse-check.mjs <slug> [--dir jobs] [--top 3]
     [--threshold 0.75] [--json] [--cache auto|on|off] [--db <path>]
```

Score = 0.5 × title similarity + 0.5 × technology-stack overlap, against every
other job workspace that already has a `resume.md`. It recommends; it never
reuses anything by itself.

`--cache auto` (the default) turns the cache on only above a workspace-count
threshold, and that is a measurement rather than a hedge: the ranking loop gets
48–66% faster with the cache, but loading the database module costs about 18 ms
of process startup, which wipes out the whole saving on a small tree.

**Exit codes:** `0` ran fine, `2` usage, missing workspace, or a bad `--cache`
value.

### 5.8 `letter-plan.mjs` — cover letters per cluster, and what they cost

**READ-ONLY**

```
node src/documents/letter-plan.mjs [--status new|all] [--threshold 0.6]
     [--leads <path>] [--json] [--price-only]
     [--in <tok>] [--out <tok>] [--in-rate <usd/Mtok>] [--out-rate <usd/Mtok>]
     [--revisions <n>]
```

Everything else in the document pipeline is deterministic. The cover letter stays
model-authored deliberately: the only field experiment on the question (ResumeGo,
n=7,287 applications) puts tailored letters at 16.4% callbacks against 12.5% for a
generic one — a 31% relative lift on the metric the whole pipeline exists to move.

So the answer to letter throughput is to **scale the clustering, not the
quality**: one letter per cluster of near-identical postings. This turns clusters
into a letter work list — one anchor per cluster, the rest marked as reusing it —
and prices the result. `--price-only` answers "what does one letter cost?" without
needing a lead store at all. `--json` prints the method alongside the number, so
nobody quotes the total without the basis.

---

## Part 6 — Apply

### 6.1 How applying actually happens

Applying is not one command. In normal use you hand the AI agent a posting URL
and the `apply-job` skill drives it: open the page in a browser, capture the
posting, tailor and verify the documents, scan the form, build a fill plan, fill
it, and submit. The commands below are the deterministic pieces that skill calls,
and you can run them yourself.

Two facts about the browser side that look like bugs and are load-bearing:

- The fill and scan code runs **Playwright-side**; nothing is read back out of
  the page to make a decision.
- The bootstrap loads by `filename` and never via `addScriptTag`, because
  nonce-based Content-Security-Policy boards (Ashby) block an injected script tag
  outright.

See [`../code/06-apply-scanning.md`](../code/06-apply-scanning.md),
[`../code/07-apply-planning.md`](../code/07-apply-planning.md) and
[`../code/08-apply-filling.md`](../code/08-apply-filling.md) for the mechanism.

### 6.2 `answer-bank.mjs` — resolve scanned fields against your facts

**READ-ONLY**

```
node src/apply/answer-bank.mjs --fields '[{"k":"f1","t":"text","l":"Email"}]' [--json]
cat scan.json | node src/apply/answer-bank.mjs [--json] [--profile <p>] [--answers <a>]
```

Takes the `fields` array a page scan produced and resolves each one against your
profile and answer bank. Deterministic lookup only — **it never invents an
answer.**

Four statuses come back, one per field:

| Status         | Meaning                                                                        |
| -------------- | ------------------------------------------------------------------------------ |
| `OK`           | A value is ready to fill.                                                      |
| `NEEDS-CHOICE` | A value resolved but no option matched — the agent picks from the option list. |
| `MAYBE`        | A weak match against the bank — the agent confirms the wording.                |
| `UNKNOWN`      | Not in the fact base. Ask the user, then `save-answer.mjs`.                    |

**`UNKNOWN` is not a gap to be filled in.** It is the system correctly reporting
that nothing deterministic understood the field. The only three ways to make
fewer things resolve `UNKNOWN` are an adapter that knows the board's shape, a
probed option list read off the live form, or a banked answer you approved. Never
by having a model read the field and decide.

**Exit codes:** `0` ran fine, `2` usage or JSON parse error.

### 6.3 `fill-plan.mjs` — turn a scan into a plan

**WRITES `jobs/<slug>/fill-plan.js`, `jobs/<slug>/fill-plan.json`, and `jobs/.field-cache.json`**

```
node src/apply/fill-plan.mjs <slug> [--scan <path> | --page <N>]
     [--url <url>] [--resume <pdf>] [--cover <pdf>] [--json]
     [--profile <p>] [--answers <a>] [--jobs-dir <d>] [--consent-allowlist <path>]
     [--no-cache] [--invalidate] [--record-via <path-to-fill-report.json>]
     [--max-freetext <chars>] [--disclosure-budget <n>]
```

This is where the decisions happen; the browser-side engine only executes. Nothing
here calls a model.

It writes two files. `fill-plan.json` is the plan data alone, for tests and for
you to read. `fill-plan.js` is a self-contained bootstrap containing the plan
**and** the fill-engine source, read off disk here in an ordinary Node process,
ready to be injected into the page.

**Flags worth knowing:**

- `--page N` is shorthand for `--scan <jobDir>/scan-p<N>.json`, because a
  multi-step form produces one scan per page. Neither flag is needed when the
  job directory holds exactly one scan file.
- `--invalidate` drops the remembered shape of this form. Use it when the engine
  reports a `verify.mismatch` on a field whose options came from the cache.
- `--record-via <report>` is a standalone mode: it reads the engine's fill report
  and persists which dropdown strategy actually worked, so the next application to
  the same form does not re-discover it. No scan needed.
- `--max-freetext` and `--disclosure-budget` override the long-free-text and
  disclosure limits for one run, without touching your limits file.

**What always defers, unconditionally:** consent, terms, arbitration and
e-signature fields. The agent does not agree to things on your behalf, on any
path. A checkbox or radio group defers on its **shape**, whatever the answer's
class, because a tick carries assent rather than a value.

**Exit codes:** `0` ok, `2` usage or missing scan, `3` this ATS needs a human
(Workday).

### 6.4 `capture-post-submit.mjs` — build the confirmation-page corpus

**`stage` and `review` write only to a gitignored staging directory; `promote` WRITES the committed corpus**

```
node src/apply/capture-post-submit.mjs stage --url <url> --html-file <f> [--board <k>] [--slug <s>]
node src/apply/capture-post-submit.mjs review [<id>]
node src/apply/capture-post-submit.mjs promote <id> --kind <classification> --user-approved
```

The unattended runner needs to type the page an ATS shows _after_ submit —
confirmation, identity check, bot challenge, email code, error, or "that was not a
confirmation". Writing a plausible-looking regex from memory instead fails in the
one direction that cannot be recovered: a page misread as a confirmation records
an application that was never sent, and nothing later corrects it.

Since you are on the submit button for every attended application, those pages
exist. This keeps them.

**Three steps, deliberately not one.** A confirmation page carries your name,
your email, often your phone and address, and a reference number that identifies
you to that employer. The committed corpus lives in git and goes wherever this
repository goes. So `stage` redacts and writes to a gitignored directory — and
**refuses if any known identifier survived the redaction**; `review` prints the
redacted visible text so you read what you are about to publish; `promote` copies
it into the committed corpus and only with an explicit `--user-approved`.

**Current state:** `tests/fixtures/post-submit/corpus.json` contains
`{"samples":[]}`. Nothing has been promoted yet. See §6.6 for what that means.

**Exit codes:** `2` for usage.

### 6.5 `auth-sync.mjs` — copy the logged-in browser profile to the runner's

**WRITES `.playwright-auto/profile`**

```
node src/apply/auth-sync.mjs [--check] [--src <dir>] [--dst <dir>] [--json]
```

Its own help text, verbatim:

```
usage: auth-sync.mjs [--check] [--src <dir>] [--dst <dir>] [--json]
  Copies .playwright-mcp/profile -> .playwright-auto/profile, one direction only.
  ALLOWLIST: cookies, Local Storage, Local State (the os_crypt key) and a rewritten
  minimal Preferences. Saved passwords, autofill/payment data, history and bookmarks
  are never copied — the auto profile visits hundreds of third-party pages.
  --check probes liveness and copies nothing.
  Refuses while either browser looks live, and refuses if the destination is not gitignored.
```

Chromium takes an exclusive lock on its profile directory, and two processes on
one directory corrupt it — the thing being corrupted being the store that holds
your real ATS session cookies. So the directories are split by role, this is the
only bridge, it runs in one direction, and it is run explicitly and never on a
schedule.

**The liveness check is a mitigation, not a proof, and the script says so.** Three
signals cover different platforms: singleton lock files (sound on Linux/macOS,
absent on Windows), an exclusive-open probe (a real positive on Windows, never
fires on Linux), and recent file modification time (a heuristic; a browser open
and untouched for two minutes passes it).

**Exit codes:** `0` synced or checked, `1` refused (a liveness signal, or an
un-gitignored destination), `2` usage.

### 6.6 `auto-apply.mjs` — the unattended runner

**CAN SEND A REAL APPLICATION. WRITES `jobs/leads.db`.**

```
node src/auto/auto-apply.mjs [--limit 25] [--concurrency 1]
     [--db <file>] [--limits <file>] [--jobs-dir <dir>]
     [--enqueue] [--fixture] [--json] [--help]
```

Its own help output, verbatim:

```
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

**What decides whether it clicks.** Two keys in `docs/application-limits.yaml`,
which is **your** file — this script reads it and never writes it:

- `auto_apply.enabled` answers "may this machine run at all". If it is not
  `true`, `preflight.mjs` refuses.
- `auto_apply.dry_run` answers "does it click". The mode is computed as
  `auto?.dry_run === false ? "live" : "dry_run"` — so a dry run is the default and
  anything other than an explicit `false` keeps it a dry run.

Plus `auto_apply.board_allowlist`, a map of `domain: ats-id`. A board not on it is
refused by the trust gate. Trust is mechanical — a known ATS on a list you
control, and a lead that cleared every screening stage — never a model's
impression that a page looks legitimate.

> **The current configuration is ARMED.** `docs/application-limits.yaml` today
> reads `auto_apply.enabled: true`, `dry_run: false`, `per_run_max: 10`,
> `per_day_max: 10`, `per_company_max_per_week: 5`, and a `board_allowlist`
> naming `boards.greenhouse.io`, `job-boards.greenhouse.io`, `jobs.lever.co` and
> `jobs.ashbyhq.com`. Several header comments in `src/auto/` and a paragraph
> in `CLAUDE.md` still describe this as shipping `enabled: false, dry_run: true`
> with no allowlist. **Those comments are stale; the file is the truth.** Read the
> file before running this command.

**What still blocks a submit on this path**, each because it means something on
the page was not understood: any field resolved `CONFIRM`; any checkbox or radio
group, which carries assent rather than a value; any consent tickbox; any
`UNKNOWN` field, unprobed dropdown or failed fill; `verify-claims` not passing or
the document not user-approved; the board failing the trust gate or the lead
carrying a screening rejection.

**And one more thing stops it today.** The post-click classifier is built and
deliberately blind on every real board: each of its rules declares where its
evidence came from, and a rule justified by a fixture page this repository wrote
may fire **only on loopback**. Since `tests/fixtures/post-submit/corpus.json` is
empty, a real ATS classifies as `unclassified`, which is a hard stop. That does
not prevent the click — the click happens first, then the page cannot be typed —
so the job terminates as `post-submit-unclassified` and the attempt is left for a
human to adjudicate.

**Exit codes** (`EXIT` in `src/auto/preflight.mjs`): `0` OK, `1` REFUSED,
`2` USAGE, `3` INSTRUCTION_SHAPED, `4` SENSITIVE.

**`--fixture` refuses to run against the real store**, checked before anything
opens and on the resolved path, because a fixture run writes `auto_submissions`
rows and those count toward your real per-day and per-company caps.

> **Known defect (2026-08-05 audit).** The run summary line always prints
> `submitted=0 deferred=0 failed=0` regardless of what happened.

> **Known defect (2026-08-05 audit).** A job resumed after a crash loses its apply
> URL and terminally defers.

> **Known defect (2026-08-05 audit).** `per_run_max` can be overshot at
> `--concurrency` greater than 1.

### 6.7 `cycle.mjs` — one whole cycle, for a scheduler

**CAN SEND A REAL APPLICATION (it calls `auto-apply.mjs`). WRITES `jobs/leads.db` and `jobs/<slug>/`.**

```
node src/auto/cycle.mjs [--top 10] [--limit N] [--json]
     [--skip-search] [--skip-apply] [--jobs-dir jobs]
```

The join between every other stage: search → screen → prep → tailor (new-job,
keyword-plan, assemble-resume, verify-claims, render-pdf, per lead) → apply.

- `--top N` — leads to tailor this cycle (default 10).
- `--limit N` — applications the runner may attempt (defaults to `--top`).
- `--skip-search` — reuse the leads already in the store.
- `--skip-apply` — prepare documents and stop before the runner. **Use this if you
  want the preparation without the possibility of a submit.**

**Why the whole thing can be unattended at all:** the tailoring step has no model
in it. `assemble-resume.mjs` emits each fact verbatim with its annotation, so rule
1 holds by construction. A pipeline whose tailoring step needed a model could not
be scheduled; this one can, and that is the property that makes autonomy possible,
not the runner.

**This file never decides to send anything.** It prepares, then hands over to
`auto-apply.mjs`, which reads your limits file. Nothing here can turn a dry run
into a live one.

**Idempotent on purpose.** Run it twice and the second run does almost nothing:
`prep-queue` excludes leads that already have a verified résumé, and the runner's
durable `(slug, mode)` row refuses a second attempt on the same slug.

**Exit codes:** `0` ok, `2` usage. A stage that fails for one lead is reported and
does **not** change the exit code — the cycle's job is to get as far as it can and
say exactly where each lead stopped.

**`src/auto/cycle.cmd`** is a Windows Task Scheduler wrapper around the same
thing. It pins the working directory to the repository root and appends a
timestamped log to `logs/cycle.log`. Registering it with Task Scheduler is your
act, not the agent's — it changes a system setting.

**Registering it (the 2026-08-13 split: the 7:00 task is prepare-only).** From
an elevated PowerShell, with the repository path adjusted if yours differs:

```powershell
$act = New-ScheduledTaskAction -Execute "C:\Users\xalva\Documents\Projects\VibeCoded\AgenticJobApplication\src\auto\cycle.cmd" -Argument "--skip-apply"
$trg = New-ScheduledTaskTrigger -Daily -At 07:00
$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName "AgenticJobApplication" -Action $act -Trigger $trg -Settings $set -User $env:USERNAME -RunLevel Limited -Force
```

Then `Get-ScheduledTask AgenticJobApplication | Get-ScheduledTaskInfo` should
show `LastTaskResult 0` after the next 07:00. **Why each flag is there:**
`--skip-apply` is the user's decision that the scheduled run prepares and does
not submit; `-AllowStartIfOnBatteries` because the task registered on
2026-08-03 was refused with `0x800710E0` every morning the laptop was
unplugged, and the log has one 07:00 entry in two weeks to show for it;
`-StartWhenAvailable` so a missed 07:00 runs when the machine wakes rather than
never; the two-hour limit because `find-jobs.mjs search --source all` can run
long and a hung child should be killed, not left until the next trigger. The
task registered on 2026-08-03 passed **no arguments** — it ran the full cycle,
runner included, twice a day. Check `(Get-ScheduledTask AgenticJobApplication).Actions.Arguments`
if in doubt.

**Reading `logs/cycle.log`.** Each run is bracketed by `==== cycle <stamp> ====`
and `==== exit <code> ====`. A stage line reads `search: ok — warn: …` or
`apply: FAILED — <first stderr line> … <last two>`, and a failed stage is followed
by an indented `stderr:` block holding the last 40 lines the child wrote. Until
2026-08-17 the summary kept only the last three lines and nothing else, which
turned the runner's launch error into the bottom edge of Playwright's boxed hint
and a search timeout into `search: FAILED` with nothing after it. A child killed
by the spawn timeout now reads `timed out after 600000ms (SIGTERM)`.

> **Known defect (2026-08-05 audit).** `cycle.mjs` spawns five processes per job,
> and `buildPlan` and `loadFactContext` each run twice. Document preparation is
> fully sequential with two Chrome launches per lead. The scheduled entry point
> gained a test file on 2026-08-17 (`tests/auto/cycle.test.mjs`) covering the
> step runner; the prep loop itself is still exercised only by hand.

### 6.8 `preflight.mjs` — would an unattended run be allowed?

**READ-ONLY. The script says so in its own usage text.**

```
node src/auto/preflight.mjs [--mode dry_run|live] [--answers <file>]
     [--profile <file>] [--limits <file>] [--json] [--help]
```

```
usage: preflight.mjs [--mode dry_run|live] [--answers <file>] [--profile <file>]
                     [--limits <file>] [--json]
       Reports only. This script never writes anything.
```

Checks every precondition an unattended run depends on and prints one line per
check with `ok`, `warn` or `REFUSE`, plus a remedy for anything failing. Run this
before touching `auto-apply.mjs`.

**Exit codes:** `0` clear to run, `1` refused, `2` usage, `3` something in the
answer bank is instruction-shaped, `4` something in it is a sensitive identifier.

---

## Part 7 — Record an application

**Nothing in this pipeline records an application by itself.** An application is
recorded only when you say you submitted it, and an outcome only when you report
it. That is hard rule 2, and it is about provenance rather than about any
particular file.

### 7.1 `check-applied.mjs` — did I already apply here?

**READ-ONLY**

```
node src/applications/check-applied.mjs "<company, title, or slug>"
     [--file profile/applications.yaml] [--today YYYY-MM-DD]
```

Run this **before** tailoring or applying to anything. Output is always JSON:

```json
{ "query": "acme", "job_already_applied": true, "matches": [ { "slug": "acme-fullstack", "days_ago": 12, ... } ] }
```

**Exit codes:** `0` whether or not there was a match — a "no" is a successful
answer, not an error. `2` for usage, including a `--today` that is not
`YYYY-MM-DD`.

### 7.2 `log-application.mjs` — record that you applied

**WRITES the `applications` table in `jobs/leads.db`, and regenerates `profile/applications.yaml`**

```
node src/applications/log-application.mjs <slug> --company "X" --title "Y"
     [--url <url>] [--date YYYY-MM-DD] [--notes "..."] [--file <yaml>]
```

The only sanctioned way for the agent to create an application record, and only
after you confirm you applied. `--date` defaults to today and must be
`YYYY-MM-DD`. `--file` forces the legacy YAML-only path, which is what the tests
use — omit it.

**Exit codes:** `2` for a missing slug, company or title, or a malformed date.

### 7.3 `applications.mjs` — read and correct the store

**`list`, `find` and `stats` are READ-ONLY; `remove` and `export` WRITE**

```
node src/applications/applications.mjs list [--status s] [--company X] [--json]
node src/applications/applications.mjs find "<company|title|slug>" [--json]
node src/applications/applications.mjs stats [--json]
node src/applications/applications.mjs remove <slug> --confirm
node src/applications/applications.mjs export
```

`stats` prints totals, distinct company count, first and latest dates and a
breakdown by status.

`remove` **refuses without `--confirm`** and prints what it would delete first:

```
Would remove: Acme Corp — Full-Stack Engineer (2026-07-14)
Re-run with --confirm to delete it.
```

Deleting an application destroys the record of something you actually did, so it
takes an explicit flag. `remove` exists to correct a mistake, never to rewrite
history.

`export` regenerates `profile/applications.yaml` from the database. That file is a
**generated export** kept for readability and recovery — the `applications` table
is the source of truth.

**Exit codes:** `2` for a bad subcommand, a missing query, a missing slug, or
`remove` without `--confirm`.

### 7.4 `update-application.mjs` — record what happened

**WRITES the `applications` table**

```
node src/applications/update-application.mjs <slug-or-company> --status <status>
node src/applications/update-application.mjs <slug-or-company> --followed-up [--date YYYY-MM-DD]
```

The statuses are exactly: `applied`, `followed_up`, `interviewing`, `offer`,
`rejected`, `withdrawn`.

Never creates entries (that is `log-application.mjs`) and never deletes them (that
is `applications.mjs remove`). The flags combine. Matching is by slug **or** by
company name.

**Exit codes:** `2` for usage, no matching application, an unknown status, or a
malformed date.

---

## Part 8 — Follow up

### 8.1 `follow-ups.mjs` — what is due a nudge

**READ-ONLY**

```
node src/applications/follow-ups.mjs [--days 10] [--json] [--file <path>]
```

The policy, encoded in `dueFollowUps`:

- A follow-up is due N days (default 10) after the application, or after the
  previous follow-up.
- At most **two** follow-ups per application. After that the lead is considered
  gone cold and stops appearing.
- Applications whose status shows a response (`interviewing`, `offer`, `rejected`,
  `withdrawn`) never appear.
- An application with an unparseable date is skipped rather than guessed at.

**What it prints** (prose):

```
Acme Corp — Full-Stack Engineer (acme-fullstack)
  applied 2026-07-14, 24 days since last touch, 1 follow-up(s) sent → second follow-up

1 application(s) due a follow-up (threshold 10 days).
```

**It never writes.** Recording that you sent a follow-up goes through
`update-application.mjs --followed-up`.

**Exit codes:** `2` for a `--days` value that is not a number of at least 1.

---

## Part 9 — Know where I stand

### 9.1 `status.mjs` — the whole pipeline in one call

**Effectively READ-ONLY** (it opens `jobs/leads.db`, which creates the file and
empty tables if they are absent; it writes no rows)

```
node src/status.mjs [--json] [--days 10] [--cadence-hours H]
node src/status.mjs --db <path> --stop-path <path>     # fixtures only
```

Replaces the several separate commands, and the round-trips between them, that
answering "where do things stand?" used to take. Four sections: leads by status,
applications by status plus how many are awaiting a response, follow-ups due (with
the list), and the unattended-runner section.

**What it prints** (prose):

```
Leads: 158 (new=93 recommended=6 dismissed=53 applied=6)
Applications: 6 (applied=4 rejected=1 interviewing=1); 4 awaiting a response
Follow-ups due: 1
  Acme Corp (acme-fullstack) — 24 days
```

`--days` sets the follow-up threshold. `--cadence-hours` sets what the runner
section treats as the expected interval between cycles, for judging whether a
scheduled run is overdue.

### 9.2 `applications.mjs stats`

See §7.3.

### 9.3 `profile-gaps.mjs` — what am I missing?

**READ-ONLY**

```
node src/profile/profile-gaps.mjs [--json] [--min-demand N]
     [--profile <p>] [--jobs-dir <d>] [--leads <l>] [--applications <a>]
```

Demand side: every captured job workspace, plus (weakly) stored lead titles.
Supply side: all text in `profile/profile.yaml`. **Jobs whose application ended in
rejection or silence count double** — those are the requirements actually costing
you interviews.

**Exit codes:** `2` if the profile is missing, or there are no captured jobs or
leads to analyse.

### 9.4 `keyword-coverage.mjs` — what do I have but never wrote down?

**READ-ONLY**

```
node src/profile/keyword-coverage.mjs [--min-demand 2] [--top 40]
     [--include-dismissed] [--job jobs/<slug>/job.json] [--json]
     [--profile <p>] [--answers <a>] [--leads <l>]
```

`profile-gaps.mjs` answers the harsher question — what is demanded and _not_
evidenced — and treats every one as a learning gap. Most of that list is not a gap
at all. Someone who has shipped React and Node has almost certainly written an
Express route and run Jest; those simply never made it into `profile.yaml`.
Meanwhile verify-claims R6 correctly refuses to let a résumé mention any
technology the fact base cannot back, so an unrecorded skill is an invisible one.

Three buckets, and the middle one is the point:

| Bucket    | Meaning                                                                                            |
| --------- | -------------------------------------------------------------------------------------------------- |
| `covered` | Demanded and evidenced — already usable in a tailored résumé.                                      |
| `ask`     | Demanded, not evidenced, but close to something evidenced — probably yours. Confirm and record it. |
| `gap`     | Demanded, not evidenced, not close to anything — a real learning gap.                              |

Demand is counted twice: `required` (read live from each description) and `total`
(from the keyword index). Ranking is by required first — the difference between
"you cannot apply without this" and "it would be nice".

**This never writes to `profile/`.** It prints the `save-answer.mjs` command; you
answer in chat.

### 9.5 `apply-profile.mjs` — apply a reviewed whole-profile update

**WRITES `profile/profile.yaml` and `profile/profile.backup.yaml`**

```
node scripts/profile/apply-profile.mjs [--proposal profile/profile.proposed.yaml]
     [--target profile/profile.yaml] [--allow-edits] [--allow-removals]
```

Replaces your profile with a reviewed proposal, **after** enforcing three merge
guarantees: every existing fact id must still exist (no silent deletions), every
existing fact's text must be unchanged (no silent rewrites), and all ids must be
unique with `contact.name` and `contact.email` present. `--allow-edits` and
`--allow-removals` override the first two and require your explicit approval. The
old profile is backed up first.

**Exit codes:** `2` if the proposal or target file does not exist, `1` if a merge
guarantee was violated.

---

## Part 10 — Add a job board

The sweep list is `docs/job-sources.yaml`, and it is **yours**. Two scripts
_propose_ boards and never edit it; one script edits it, on your instruction.

The board types the sweep understands, from `BOARD_TYPES`:

```
greenhouse, lever, ashby, smartrecruiters, workable, recruitee, workday,
oracle_cloud, jobvite, successfactors, jobicy, remotive, remoteok
```

### 10.1 `manage-sources.mjs` — the one that edits the list

**`add` and `remove` WRITE `docs/job-sources.yaml`; `verify` and `list` are READ-ONLY**

```
node src/leads/manage-sources.mjs add --type <ats> --company "Name" [--slug <slug>]
node src/leads/manage-sources.mjs add --type workday --company "Name" \
     --host x.wd5.myworkdayjobs.com --tenant x --site SiteName
node src/leads/manage-sources.mjs remove "<company or slug>"
node src/leads/manage-sources.mjs verify
node src/leads/manage-sources.mjs list
```

`add` **prescreens with a live API call** — the board must answer with a job list
before it earns a slot — and refuses duplicates, so the daily sweep only ever hits
boards known to work. Three board types identify themselves by host rather than a
slug and have extra requirements: `workday` needs `--host --tenant --site`,
`oracle_cloud` needs `--host --site`, `successfactors` needs `--host`. Everything
else needs `--slug`.

The YAML file is edited line by line (entries are single-line flow maps) so its
comments survive every add and remove.

**What `add` prints:**

```
Added Acme Corp (greenhouse:acme) — prescreen OK, 47 posting(s) visible right now.
```

An empty-but-live board is kept, with a note.

**Exit codes:** `2` for a bad subcommand, `1` for a rejected add (unknown type,
missing required field, duplicate, or a failed prescreen).

### 10.2 `find-boards.mjs` — given company names, find their boards

**WRITES `docs/board-candidates.yaml`**

```
node src/leads/find-boards.mjs --names "Acme,Globex" [--out <f>] [--append]
node src/leads/find-boards.mjs --file docs/candidates/fortune500.yaml [--limit 100]
     [--concurrency 6] [--json]
```

The six big ATSs all publish a no-authentication JSON endpoint keyed on a company
slug, and the slug is usually a predictable squashing of the company name. So:
generate candidate slugs, ask each ATS, keep what answers.

**What it does not do, measured rather than assumed.** Probing 16 companies found
Vercel, Figma and Notion in 4.2 seconds and found **nothing** for Konami Gaming,
Everi, Zappos, Switch, Scientific Games, PlayAGS, Sightline Payments, Southwest
Gas or NV Energy. Those are Las Vegas employers on Workday, iCIMS, Taleo and
Phenom, whose board URLs contain an opaque tenant host that cannot be guessed from
a name. Slug probing reaches startups and tech companies; the local market needs
per-company research. The output says so, because "no board found" reads as "not
hiring" otherwise.

**Exit codes:** `2` if neither `--names` nor `--file` was given.

> **Known defect (2026-08-05 audit).** The merge of existing candidates is gated
> on `--append`, but the file write is not. `docs/board-candidates.yaml` currently
> holds 217 candidates across 872 lines; a single `find-boards.mjs --names "Acme"`
> that resolves one board **replaces all 217 with one**, with no warning and no
> backup. Always pass `--append`.

### 10.3 `discover-boards.mjs` — is a candidate board worth sweeping?

**READ-ONLY. It never edits `docs/job-sources.yaml`.**

```
node src/leads/discover-boards.mjs --candidates <file.yaml|file.json>
node src/leads/discover-boards.mjs --type greenhouse --slug acme --company "Acme"
     [--min-solid 1] [--concurrency 6] [--query "full stack"] [--json]
```

Deliberately **not** a bulk slug crawler. On 2026-07-28 the 41 boards already
tracked carried 8,576 live postings and yielded 18 reachable ones — 0.21% — and 28
boards yielded zero. Adding companies indiscriminately makes that worse twice
over: every junk board costs sweep time forever, and its postings bury the
reachable leads in noise that then costs a model read to reject. So a candidate
must clear the same yield bar the audit applies to existing boards before it is
proposed at all.

It prints the `manage-sources.mjs add` command to run for anything that passes.

**Exit codes:** `2` if neither `--candidates` nor `--type`+`--slug` was given.

### 10.4 `board-yield.mjs` — score the boards you already sweep

**READ-ONLY**

```
node src/leads/board-yield.mjs [--query "full stack"] [--json]
     [--concurrency 6] [--min-qualifying 0]

node src/leads/board-yield.mjs --history [--live] [--json]
     [--dead-days 30] [--zero-streak 5] [--min-sweeps 5]
```

The default mode fetches every board in `docs/job-sources.yaml` live and reports,
per board: how many postings it has, how many pass your limits, how many are
confirmed reachable ("solid"), the yield percentage, and how many were
hard-filtered. Ranked on confirmed-reachable postings, because a board whose only
hits are unverified-remote is not a productive board.

`--history` answers the different question — **not "what is on this board today"
but "has this board ever been worth sweeping"** — by reading the accumulated
`board_stats` counters instead of the network. It is offline and effectively
instant (measured 2026-08-17 on 57 boards: **5 ms**, against **22.6 s** for the
live audit), and it prints per board: last swept, last time it yielded something
reachable, `leads_produced`, and `zero_streak/sweeps`. Add `--live` to join
today's snapshot onto that history, at the live audit's cost.

A board is proposed for removal when **any** of three thresholds trips:
`--zero-streak` consecutive dry sweeps, never having yielded across at least
`--min-sweeps` counted sweeps, or a last yield older than `--dead-days`. It takes
all three because the counters start at zero: only the `--dead-days` rule can
fire on history recorded before the counters existed, and a `?` in the
`DRY/SWEEPS` column marks exactly those rows.

Reports only, both modes. Removing a board is your call — the proposals print as
ready-to-run `manage-sources.mjs remove` lines and nothing is changed.

### 10.5 `cc-boards.mjs` — enumerate board slugs from Common Crawl

**WRITES `docs/candidates/cc-<crawl>-<host>.yaml` and resume state in `jobs/.cc/`**

```
node src/leads/cc-boards.mjs --crawl CC-MAIN-2026-30 --hosts ashby,greenhouse
     [--out <file>] [--max-pages N] [--json]
```

The candidate source `find-boards.mjs` cannot be: instead of guessing slugs
from company names, it reads every `jobs.ashbyhq.com/<slug>` and
`*.greenhouse.io/<slug>` URL Common Crawl's CDX index captured (both hosts'
robots.txt permit that crawl), counts captures per slug as a liveness signal,
and writes a candidates file for `discover-boards.mjs` — deduped against
`docs/job-sources.yaml`, ranked by `seen`. Get the newest `--crawl` id from
<https://index.commoncrawl.org/collinfo.json>.

**Lever is excluded by rule.** Lever's robots.txt disallows crawling, so
Common Crawl carries no lawful index of it; Lever candidates come from
`find-boards.mjs` name probing over `api.lever.co`, which lib.mjs's politeness
gate paces at its declared 1-second crawl-delay.

Every index request rides `fetchJson`/`fetchText`, so
`index.commoncrawl.org`'s 1s spacing applies automatically. The index sheds
load with transient 5xx; state is saved after **every** page, so the answer to
a `HTTP 502/503` (or a `429`) is to re-run and resume — never a retry loop.
The candidates YAML is regenerated from state on every run, including a
`--max-pages` slice.

**Exit codes:** `2` for a missing/unknown `--crawl`/`--hosts` (including
`lever`, refused by name), `1` when the index refused mid-run (state saved,
resumable).

---

## Part 11 — Maintain the store

### 11.1 `migrate.mjs` — build or top up `jobs/leads.db`

**WRITES `jobs/leads.db` (pass `--dry-run` to preview)**

```
node src/maintenance/migrate.mjs [--dry-run] [--db <path>]
     [--leads-json <path>] [--applications <path>] [--reset-queue]
node src/maintenance/migrate.mjs --export <file>
```

**Flat, not versioned.** There is no migration chain and no schema-version table:
`src/lib/db.mjs` declares the whole schema with `CREATE TABLE IF NOT EXISTS`,
and this re-imports from the files that are still the user-owned source of truth.
Running it twice is a no-op; running it after a schema addition fills in the new
tables.

**What it re-imports:** `leads` and `lead_keywords` (from a JSON snapshot named by
`--leads-json`; there is no default, deliberately) and `applications` (from
`profile/applications.yaml`).

**What it never touches:** `documents`, `auto_submissions` and `verifications`.
The `documents` table has **no on-disk source** — `archive.mjs` folds a workspace
into it and then removes the directory, so once that has happened the row is the
only copy. A "rebuild" over it could only empty it. **Backing it up means copying
`jobs/leads.db` itself.**

`--reset-queue` clears run state a dead process left behind, and deletes only rows
in states where no click was ever issued, plus finished ones. It **refuses while
any row is `attempted`** — an attempted row means a click may already have reached
an employer, and erasing it would silently disarm the orphan-attempt brake.

`--export <file>` takes a point-in-time snapshot of the leads table and exits.
There is deliberately no standing `jobs/leads.json`: a frozen snapshot drifts from
the database the moment a sweep runs, and a stale duplicate is worse than none.

### 11.2 `prune-jobs.mjs` — drop regenerable intermediates

**Dry run by default; `--apply` DELETES files**

```
node src/maintenance/prune-jobs.mjs [--apply] [--jobs-dir <path>] [--json]
```

Removes exactly one thing: `*.render.html`, the intermediate `render-pdf.mjs`
leaves behind. It is regenerated on every render and useful to nobody.

**Everything else stays** until the workspace is archived. `resume.md`,
`cover-letter.md`, `job.json` and `context.json` are the record of what was
actually claimed on an application; if an employer asks about a bullet in an
interview, this is it.

**What it prints** without `--apply`:

```
Would remove 3 file(s), 84 KB:

  acme-fullstack/resume.render.html
    regenerable intermediate

Dry run — nothing was deleted. Re-run with --apply to remove them.
Documents are never pruned; closed applications go to archive.mjs.
```

### 11.3 `archive.mjs` — fold closed workspaces into the database

**`list` and `show` are READ-ONLY; `archive`, `restore` and `purge --apply` WRITE**

```
node src/maintenance/archive.mjs list [--json]
node src/maintenance/archive.mjs show <slug> [--json]
node src/maintenance/archive.mjs archive <slug> [--force]
node src/maintenance/archive.mjs archive --closed [--dry-run]
node src/maintenance/archive.mjs restore <slug> [--to <dir>] [--force]
node src/maintenance/archive.mjs purge [--days N] [--apply] [--json]
     [--jobs-dir <path>] [--db <path>] [--applications <path>]
```

The problem this solves is not disk space. `jobs/` reached about 100 directories
and it stopped being possible to see which application was actually in flight, so
the whole lot got deleted — audit trail included. Two states:

- **ACTIVE** — `jobs/<slug>/` exactly as today. Editable, diffable, and what
  `verify-claims.mjs` and `render-pdf.mjs` read.
- **CLOSED** — rows in the `documents` table, directory removed.

`archive --closed` sweeps every application whose status shows it is over.
`purge` deletes archived rows whose **job posting** (not the archive date, not the
application date) is older than `--days` — defaulting to your
`freshness.max_age_days`, else 30. Dry run unless `--apply`, and **this one is
irreversible**: the row is the only copy of those bytes.

**Exit codes:** `0` ok, `1` refused or nothing to do, `2` usage.

---

## Part 12 — Measure performance

Latency is a first-class concern in this project — this pipeline is benchmarked
against commercial tools, and slowness is treated as a defect. These four
commands turn "it feels slow" and "that test is flaky" into numbers.

### 12.1 `bench-apply.mjs` — time one application

**READ-ONLY unless `--ledger` is passed**

```
node src/dev/bench-apply.mjs [--board <b>] [--shape <s>] [--profile <p>]
     [--page N] [--runs N] [--json] [--ledger] [--real-sleep]
     [--browser] [--browser-fill] [--all-profiles] [--verbs] [--gate] [--help]
```

Times scan → plan → fill against a local fake ATS and reports **three cost columns
separately**: browser round trips, sleep milliseconds, and model turns. Adding
them produces a number whose largest term is invisible, which is how roughly 24
seconds of `waitForTimeout` spent a long time being described as "network time".

Every number carries a `method`, and the CLI prints it:

- `measured` — produced by executing product code or real I/O in this run.
- `derived` — computed from a documented protocol plus this run's own plan
  output, with the source line cited.

The default run opens no browser, which is a choice about cost. `--browser` and
`--browser-fill` are real: `playwright-core` is a committed dependency and
Chromium is installed.

### 12.2 `bench-runner.mjs` — time a campaign

```
node src/dev/bench-runner.mjs [--apps 8] [--concurrency 4] [--board greenhouse]
     [--origins N] [--runs 1] [--profile typical] [--real-sleep]
     [--edge-spacing-ms N] [--latency <l>] [--json] [--ledger] [--allow-dirty]
```

`bench-apply` measures one application; this measures a run of them — N jobs at
concurrency C against a loopback fixture, through the real queue, with the real
plan and fill engines.

**It drives product code and decides nothing.** The scan engine, fill-plan, fill
engine, queue state machine, taxonomy and classifier are all the shipped modules.
What this supplies is only what a benchmark must supply anyway: a worker pool, a
clock, and a fixture. No retry rule, no backoff, no trust decision, and **no
click**. In dry run it records a `dry_run` submission row exactly as the real path
would and stops.

### 12.3 `bench-green-prevalence.mjs` — how many forms could run alone?

**READ-ONLY**

```
node src/dev/bench-green-prevalence.mjs            # human report
node src/dev/bench-green-prevalence.mjs --json
node src/dev/bench-green-prevalence.mjs --self-check
node src/dev/bench-green-prevalence.mjs --no-scans
```

Of the real application forms this machine has actually seen, how many could reach
the `green` tier at all — given that a checkbox or radio group defers permanently,
a consent tickbox defers on its shape, and any field resolving `CONFIRM` blocks a
submit however it renders?

The corpus is the remembered form shapes in `jobs/.field-cache.json` plus the
workspace scans in `jobs/<slug>/scan-p*.json`. Synthetic fixture boards are used
**only** by `--self-check`, to prove the harness agrees with the product rules,
and are never counted.

**Exit codes:** under `--self-check`, `0` if every self-check passed, `1` otherwise.

> **Known defect (2026-08-05 audit).** The report emits a fixed sentence claiming
> the field cache is at `v: 2` and would be discarded against `CACHE_VERSION 4`,
> and the header states the corpus is seven remembered shapes. The live cache is
> `v: 4` with eleven forms, so the stated justification for bypassing the normal
> cache loader has evaporated and the corpus size is wrong.

### 12.4 `flake-rate.mjs` — turn "that test is flaky" into a number

**READ-ONLY**

```
node src/dev/flake-rate.mjs <test-file> [--runs 10] [--load 1]
     [--alongside <file>]... [--json] [--help]
```

Two tests were once reported as intermittent with "3 failures in 7 runs" and "1
failure in 3 runs". Those are the right instinct and the wrong evidence: 1 failure
in 3 runs is consistent with a true failure rate anywhere from 6.1% to 79.2%
(Wilson, 95%), so a fix that removes four fifths of the flakiness and a fix that
does nothing look identical from the outside.

It reports failures over runs with a Wilson 95% interval, the number of runs needed
to distinguish the observed rate from zero (so "we ran it again and it passed" can
be priced), and per-run wall time (so a fix that trades flakiness for slowness is
visible).

**`--load N` is the point, not a setting.** Both reported flakes were contention:
`node --test` runs files in parallel and each of these spawns its own subprocesses.
`--load N` runs N copies of the target at once and reports the rate per load level,
which turns "flaky on my machine" into "fails above N concurrent writers".

**What it prints:**

```
flake rate — tests/lib/db.test.mjs  (load=4)
------------------------------------------------------------------------
  failures        3 / 20
  rate            15.0%  [95% CI 5.2% – 36.0%]
  a clean re-run  proves nothing until 19 consecutive passes
  even at 0/20, the true rate could still be as high as 16.1%
  wall ms         min 812  median 934  max 1420
```

### 12.5 `spawn-counter.cjs` — not a command

`src/dev/spawn-counter.cjs` is a `--require` preload, not something you run. It
counts every child process and outbound request a run makes. It is a preload
rather than a patch inside the harness because patching `child_process` from
inside an ES module counts **zero** — a module that imported the function is bound
to the export published at bootstrap, not to the property being reassigned. A
counter that silently reports 0 is worse than no counter, because the CI gate's one
hard rule is `model_turns > 0`.

---

## Part 13 — The complete index

Everything runnable, alphabetically within its folder, with what it changes.

### `src/` root

| Command      | Task               | Changes                                      |
| ------------ | ------------------ | -------------------------------------------- |
| `status.mjs` | Know where I stand | Nothing (opens the database; writes no rows) |

### `src/leads/`

| Command               | Task                      | Changes                                                                                 |
| --------------------- | ------------------------- | --------------------------------------------------------------------------------------- |
| `board-yield.mjs`     | Add a job board           | **READ-ONLY**                                                                           |
| `canonical.mjs`       | Maintain the store        | `leads` rows, with `--apply`                                                            |
| `cc-boards.mjs`       | Add a job board           | `docs/candidates/cc-*.yaml`, `jobs/.cc/` state                                          |
| `cluster.mjs`         | See what to do next       | **READ-ONLY**                                                                           |
| `discover-boards.mjs` | Add a job board           | **READ-ONLY**                                                                           |
| `enrich.mjs`          | Find jobs                 | `leads` + `lead_keywords`, with `--apply`                                               |
| `find-boards.mjs`     | Add a job board           | `docs/board-candidates.yaml`                                                            |
| `find-jobs.mjs`       | Find jobs                 | `leads`, `lead_keywords`, `board_stats` (`search`/`import`/`mark`); `list` is read-only |
| `gate-audit.mjs`      | **After any gate change** | `jobs/.gate-baseline.json` unless `--no-save`                                           |
| `manage-sources.mjs`  | Add a job board           | `docs/job-sources.yaml` (`add`/`remove`)                                                |
| `prep-queue.mjs`      | See what to do next       | **READ-ONLY**                                                                           |
| `recommend.mjs`       | See what to do next       | **READ-ONLY**                                                                           |
| `screen.mjs`          | Find jobs                 | `screens` rows unless `--no-record`                                                     |

### `src/documents/`

| Command               | Task                    | Changes                                                                           |
| --------------------- | ----------------------- | --------------------------------------------------------------------------------- |
| `assemble-resume.mjs` | Tailor a résumé         | `jobs/<slug>/resume.md`, `resume-selection.json`                                  |
| `ats-lint.mjs`        | Tailor a résumé         | **READ-ONLY**                                                                     |
| `keyword-plan.mjs`    | Tailor a résumé         | `jobs/<slug>/keywords.json`                                                       |
| `letter-plan.mjs`     | Tailor a résumé         | **READ-ONLY**                                                                     |
| `new-job.mjs`         | Tailor a résumé         | `jobs/<slug>/job.json`, `context.json`                                            |
| `render-pdf.mjs`      | Tailor a résumé         | the PDF, plus a `.render.html` beside it                                          |
| `reuse-check.mjs`     | Tailor a résumé         | `workspace_stacks` cache rows when the cache is on                                |
| `reverify.mjs`        | Keep documents eligible | a `verifications` row per stale document; **deletes rows** with `--prune-orphans` |
| `verify-claims.mjs`   | Tailor a résumé         | a `verifications` row unless `--no-record`                                        |

### `src/apply/`

| Command                   | Task                | Changes                                                         |
| ------------------------- | ------------------- | --------------------------------------------------------------- |
| `answer-bank.mjs`         | Apply               | **READ-ONLY**                                                   |
| `auth-sync.mjs`           | Apply               | `.playwright-auto/profile`                                      |
| `automatability.mjs`      | See what to do next | **READ-ONLY**                                                   |
| `capture-post-submit.mjs` | Apply               | a gitignored staging dir; `promote` writes the committed corpus |
| `fill-plan.mjs`           | Apply               | `jobs/<slug>/fill-plan.{js,json}`, `jobs/.field-cache.json`     |
| `pending-questions.mjs`   | See what to do next | **READ-ONLY**                                                   |
| `rebuild-plans.mjs`       | Apply               | `jobs/<slug>/fill-plan.{js,json}`, `jobs/.field-cache.json`     |

### `src/applications/`

| Command                  | Task                  | Changes                                    |
| ------------------------ | --------------------- | ------------------------------------------ |
| `applications.mjs`       | Record an application | `remove` and `export` write; the rest read |
| `check-applied.mjs`      | Record an application | **READ-ONLY**                              |
| `follow-ups.mjs`         | Follow up             | **READ-ONLY**                              |
| `log-application.mjs`    | Record an application | `applications` + the YAML export           |
| `update-application.mjs` | Follow up             | `applications` + the YAML export           |

### `scripts/profile/`

| Command                | Task               | Changes                                         |
| ---------------------- | ------------------ | ----------------------------------------------- |
| `apply-profile.mjs`    | Know where I stand | `profile/profile.yaml` + `profile.backup.yaml`  |
| `keyword-coverage.mjs` | Know where I stand | **READ-ONLY**                                   |
| `profile-gaps.mjs`     | Know where I stand | **READ-ONLY**                                   |
| `save-answer.mjs`      | **The fact base**  | `profile/answers.yaml` (never under `--rescan`) |

### `src/auto/`

| Command          | Task  | Changes                                                                                          |
| ---------------- | ----- | ------------------------------------------------------------------------------------------------ |
| `auto-apply.mjs` | Apply | **CAN SEND A REAL APPLICATION.** `auto_queue`, `auto_submissions`, run records                   |
| `cycle.cmd`      | Apply | Windows scheduler wrapper around `cycle.mjs`; writes `logs/cycle.log`                            |
| `cycle.mjs`      | Apply | **CAN SEND A REAL APPLICATION.** Everything the tailoring chain writes, plus the runner's tables |
| `preflight.mjs`  | Apply | **READ-ONLY** — states so in its own usage text                                                  |

Every other file under `src/auto/` (`advance`, `audit`, `authorize`,
`breaker`, `caps`, `classify`, `digest`, `guard`, `job`, `multipage`, `notify`,
`pool`, `reconcile`, `stages`, `submit`, `taxonomy`, `trust`, `untrusted-text`) is
a library with no command line. So is everything under `src/lib/`,
`src/hooks/`, `src/apply/ats/`, and `src/leads/{fit,risk,stages}.mjs`.

### `src/maintenance/`

| Command          | Task               | Changes                                                |
| ---------------- | ------------------ | ------------------------------------------------------ |
| `archive.mjs`    | Maintain the store | `documents` rows; removes/restores `jobs/<slug>/`      |
| `migrate.mjs`    | Maintain the store | `leads`, `lead_keywords`, `applications`, `auto_queue` |
| `prune-jobs.mjs` | Maintain the store | Deletes `*.render.html`, with `--apply`                |

### `src/dev/`

| Command                      | Task                | Changes                                                                                         |
| ---------------------------- | ------------------- | ----------------------------------------------------------------------------------------------- |
| `bench-apply.mjs`            | Measure performance | A ledger entry with `--ledger`                                                                  |
| `bench-green-prevalence.mjs` | Measure performance | **READ-ONLY**                                                                                   |
| `bench-runner.mjs`           | Measure performance | Fixture rows; a ledger entry with `--ledger`                                                    |
| `flake-rate.mjs`             | Measure performance | **READ-ONLY**                                                                                   |
| `scorecard.mjs`              | Measure performance | Appends a row to `docs/scorecard.jsonl` **by default** — pass `--no-record` for a read-only run |
| `spawn-counter.cjs`          | Measure performance | Not a command — a `--require` preload                                                           |

---

**Where to go next**

- [`02-recipes.md`](02-recipes.md) — these commands strung together into the
  sequences you will actually run: a morning sweep, tailoring one job end to end,
  applying, and recording the result.
- [`03-troubleshooting.md`](03-troubleshooting.md) — what to do when one of these
  fails, organised by the error message you are looking at.
- [`04-config-reference.md`](04-config-reference.md) — every key in
  `docs/application-limits.yaml` and `docs/job-sources.yaml`, including the
  `auto_apply` block that decides whether §6.6 can click.
- [`../guide/05-architecture.md`](../guide/05-architecture.md) — how the stages fit
  together, if the grouping in this document raised the question "but why is it
  split up like that?".
- [`../guide/07-safety-model.md`](../guide/07-safety-model.md) — the reasoning
  behind the refusals: why a posting is data and never instructions, why
  `UNKNOWN` is never guessed, and why exit 4 in §2.2 has no override.
- [`../code/00-file-index.md`](../code/00-file-index.md) — every file in the
  repository with a one-line purpose, if you want to go from a command to the code
  that implements it.
- [`../guide/08-glossary.md`](../guide/08-glossary.md) — for any term here that is
  still doing more work than it explained.
