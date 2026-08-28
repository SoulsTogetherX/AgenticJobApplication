# Every file in this repository

This is the map. It lists every file this project owns, says in one sentence
what each one does, and points at the chapter that explains it properly. It
exists so that you can go from "I saw a filename I do not recognise" to "I know
what that is and where to read about it" in about fifteen seconds, without
opening the file and without guessing.

It was built mechanically — by listing the directory tree and counting the lines
in each file today, on 2026-08-06 — rather than from anybody's memory of what
the repository contains. That distinction matters, and the closing section
explains why with a real example of the previous map being wrong by a factor of
two and a half.

**What you will learn**

- The handful of file-and-folder ideas you need before a repository listing
  means anything: what an extension is, what `.mjs` signals, what a "dotfile"
  is, and the difference between a file Git tracks and a file Git ignores.
- How this repository is organised — the ten domains under `src/`, what each
  one is responsible for, and why the code is grouped that way rather than
  alphabetically or by "utils / helpers / core".
- A reading order that takes you from knowing nothing to being able to follow
  any chapter in this set.
- A complete census: every directory, every file, its size in lines, what it
  does, and which document explains it.
- Which files are load-bearing (something breaks if they go), which are working
  notes (safe to delete), and which are known-dead code that nothing calls.
- Why this page is guaranteed to go stale, and the exact command that rebuilds
  its numbers.

**Before this**

Nothing is strictly required. If a term below is unfamiliar,
[`../guide/02-computer-basics.md`](../guide/02-computer-basics.md) covers files,
paths and processes from the beginning, and
[`../guide/08-glossary.md`](../guide/08-glossary.md) is the lookup table.

---

## Part A — five ideas you need before a file listing means anything

### A file extension is a hint, not a rule

The part of a filename after the last dot — `.md`, `.mjs`, `.json`, `.yaml` — is
the **extension**. It tells a human, and usually a program, what kind of content
to expect. Nothing enforces it: you can rename a picture to `notes.txt` and the
computer will let you. It is a label on a jar, not a lock on the lid.

In this repository the extensions you will meet are:

| Extension        | What it holds                                                      | Who reads it                                                                   |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `.mjs`           | JavaScript, in the modern "ES module" style                        | Node.js — the program that runs JavaScript outside a browser                   |
| `.cjs`           | JavaScript, in the older "CommonJS" style                          | Node.js, when the older style is specifically needed                           |
| `.js`            | JavaScript with no style declared — here, code that runs in a page | a web browser, or Node for the one hook file                                   |
| `.json`          | structured data: lists, key/value pairs, numbers, text             | programs. Strict format — one stray comma is a parse error                     |
| `.yaml`          | structured data again, but written for humans, with `# comments`   | programs, via the `js-yaml` library                                            |
| `.md`            | Markdown — text with light formatting (`#` headings, `**bold**`)   | humans, and the AI agent, which reads instruction files                        |
| `.html` / `.css` | a web page and its styling                                         | a browser. Here: test fixtures and the PDF print stylesheet                    |
| `.cmd`           | a Windows batch script                                             | Windows itself — specifically Task Scheduler, which cannot run `node` directly |
| `.yml`           | the same as `.yaml`; GitHub's tooling prefers this spelling        | GitHub Actions, the service that runs the tests on every push                  |

### `.mjs` versus `.cjs` versus `.js`

JavaScript has two incompatible ways of splitting code into files that can use
each other. The modern one uses the words `import` and `export`; the older one
uses `require()` and `module.exports`. They cannot be freely mixed, so Node has
to know which style a file is written in.

There are two ways to tell it. One is the extension: `.mjs` means "modern",
`.cjs` means "older". The other is a line in `package.json` — this project sets
`"type": "module"`, which makes plain `.js` files modern too.

Nearly every file here is `.mjs`. There are exactly two deliberate exceptions,
and both have a reason:

- `src/dev/spawn-counter.cjs` is loaded by Node's `--require` flag, which
  only accepts the older style.
- `.claude/hooks/protect-profile.js` is a plain `.js` file that predates the
  convention and still works because of the `"type": "module"` setting.

There is also one file that is `.js` **on purpose and must stay that way**:
`.claude/skills/apply-job/scan-page.js`. It is never imported by Node at all —
its text is read as a string and handed to a web browser to run inside a page.
Chapter [`06-apply-scanning.md`](./06-apply-scanning.md) explains that
mechanism, which is stranger than it sounds and is load-bearing.

### A dotfile is a file whose name starts with a dot

`.gitignore`, `.prettierrc`, `.env`, `.mcp.json`. On Unix-derived systems these
are hidden from ordinary directory listings, which is why configuration
traditionally lives in them: the settings stay out of the way of the work.

Windows does not hide them, so you will see them at the top of the folder in
Explorer. They are not junk and they are not temporary. Several of them are
contracts that other parts of the system depend on, and Part D says which.

### Tracked, ignored, and untracked

Git — the tool that records the history of this project — sorts every file in
the folder into three buckets:

- **Tracked**: Git knows about it and records every change. 399 files today.
- **Ignored**: a rule in `.gitignore` tells Git to pretend it is not there. Used
  for two categories — things that can be regenerated (`node_modules/`), and
  things that must never leave this machine (`profile/`, `.env`,
  `.playwright-mcp/`).
- **Untracked**: present in the folder, not ignored, and not yet recorded. Files
  in this state are either brand new work or accidental leftovers.

You can ask Git which bucket any file is in:

```bash
git ls-files                       # everything tracked
git status --short                 # what is changed or untracked
git check-ignore -v answers.tmp    # which rule, in which file, ignores this
```

That last command prints the rule that did it, which is far more useful than a
yes/no:

```text
.gitignore:23:*.tmp     answers.tmp
```

### One repository, four kinds of file

Every file below falls into one of four classes, and knowing which one you are
looking at tells you how carefully to treat it. The 2026-08-05 audit assigned
these classes explicitly, and this index carries them forward:

| Class             | Meaning                                                    | If you delete it                                      |
| ----------------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| **Product code**  | does the work: finds jobs, writes documents, fills forms   | the pipeline breaks, loudly, and a test goes red      |
| **Load-bearing**  | data or config that running code reads                     | something breaks, sometimes silently — the worst kind |
| **Prose**         | documentation for humans and for the agent                 | nothing breaks now; understanding degrades later      |
| **Working notes** | plans, measurement logs, hand-off notes from past sessions | nothing at all happens                                |

The dangerous class is the second. `docs/tailoring-rules.md` looks like an
ordinary document, but three skill files load it at model time, so deleting it
would quietly make every tailored resume worse and no test would go red.

---

## Part B — how this repository is organised

### The top level

| Directory / file   | What lives there                                                           | Counted below?                    |
| ------------------ | -------------------------------------------------------------------------- | --------------------------------- |
| `src/`             | all the product code — 90 files, 43,124 lines                              | yes, in full                      |
| `tests/`           | the test suite and its inputs — 224 files, ~62,000 lines                   | yes, at directory level           |
| `docs/`            | documentation, planning notes, and three load-bearing config files         | yes, in full                      |
| `.claude/`         | how the AI agent is configured: skills, sub-agent roles, hooks, settings   | yes, in full                      |
| `.github/`         | the automated checks that run on every push, on GitHub's computers         | yes, in full                      |
| `schemas/`         | two JSON Schema files describing the shape of per-job data files           | yes                               |
| `templates/`       | one print stylesheet, used when rendering a PDF                            | yes                               |
| `jobs/`            | per-job workspaces **and the SQLite database**. Ignored by Git — your data | no (excluded, contains your data) |
| `profile/`         | your fact base: profile, banked answers, source PDFs. Ignored by Git       | only `profile.example.yaml`       |
| `logs/`            | machine-local run logs from the scheduled cycle. Ignored by Git            | mentioned, not itemised           |
| `node_modules/`    | downloaded third-party libraries. Ignored, regenerable with `npm install`  | no                                |
| `.playwright-mcp/` | a browser profile holding **real session cookies**. Ignored                | no                                |
| `.git/`            | Git's own storage of the project history                                   | no                                |
| root files         | `CLAUDE.md`, `README.md`, `package.json`, and the dotfiles                 | yes                               |

### The ten domains under `src/`

Everything the pipeline actually does lives under `src/`, grouped into ten
folders by **what stage of the job hunt it serves**. That is a deliberate
choice. The obvious alternative — `utils/`, `helpers/`, `core/`, `models/` —
groups code by how abstract it is, which tells you nothing about when it runs.
Grouping by domain means that if you know what you are trying to do, you know
where to look, and it also means each folder has an owner in the sense that
matters: one chapter of this document set explains it end to end.

| Domain              | Files |  Lines | Responsible for                                                                                                                                                       | Chapter                                                                                         |
| ------------------- | ----: | -----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/lib/`          |     6 |  6,011 | The foundation everything else imports: the database, the shared helpers, the skill lexicon, file locking, and the "a job posting is data, not instructions" defence. | [`01-lib-foundation.md`](./01-lib-foundation.md)                                                |
| `src/leads/`        |    15 |  5,668 | Finding job postings, screening them in four stages, and ranking what survives.                                                                                       | [`02`](./02-leads-finding.md) · [`03`](./03-leads-screening.md) · [`04`](./04-leads-ranking.md) |
| `src/documents/`    |     8 |  2,991 | Turning your fact base into a tailored resume and cover letter, verifying every claim, and rendering the PDF.                                                         | [`05-documents.md`](./05-documents.md)                                                          |
| `src/apply/`        |  13+5 | 10,248 | Reading an application form in a browser, deciding what to type where, and typing it.                                                                                 | [`06`](./06-apply-scanning.md) · [`07`](./07-apply-planning.md) · [`08`](./08-apply-filling.md) |
| `src/auto/`         |    22 |  8,845 | The unattended runner: doing the above with nobody watching, and every brake that stops it doing so wrongly.                                                          | [`09`](./09-auto-runner.md) · [`10`](./10-auto-safety.md)                                       |
| `scripts/profile/`  |     4 |  1,813 | The single guarded door into your fact base, plus the two gap analyses that read it.                                                                                  | [`11-record-and-profile.md`](./11-record-and-profile.md)                                        |
| `src/applications/` |     5 |    591 | The record of what you actually applied to and what came of it.                                                                                                       | [`11-record-and-profile.md`](./11-record-and-profile.md)                                        |
| `src/maintenance/`  |     3 |  1,102 | Housekeeping: archiving closed jobs, rebuilding the database, deleting waste.                                                                                         | [`11-record-and-profile.md`](./11-record-and-profile.md)                                        |
| `src/hooks/`        |     3 |    739 | Three small programs that can refuse one of the agent's actions before it happens.                                                                                    | [`12-harness-and-ci.md`](./12-harness-and-ci.md)                                                |
| `src/dev/`          |     5 |  5,003 | Measurement tools: how long does an application take, how flaky is a test, what does a campaign cost.                                                                 | [`15-benchmarks.md`](./15-benchmarks.md)                                                        |

Plus one file at the root of `src/`: `status.mjs`, the whole-pipeline
digest.

Two structural rules hold across all ten:

1. **No script calls a language model.** Every file under `src/` is
   deterministic — same input, same output, no network call to an AI. The model
   is used for exactly four things (tailoring prose, judging a posting a script
   flagged, driving the browser on the attended path, and talking to you), and
   the code that does those lives in `.claude/skills/`, not here. This is what
   makes the pipeline testable at all.
2. **`tests/` mirrors `src/` one directory at a time.** `src/leads/` is
   tested by `tests/leads/`, `src/auto/` by `tests/auto/`. The two
   exceptions are `tests/security/` (which cuts across everything) and
   `tests/fixtures/` (which is input data, not tests).

### Where the model actually lives

Since the point above is easy to misread: `.claude/` is where the AI agent's
behaviour is configured. `.claude/skills/*/SKILL.md` files are instructions
written in English that the agent loads when a matching task comes up.
`.claude/agents/*.md` define sub-agent roles with narrower tool access.
`.claude/hooks/` and `src/hooks/` are small programs that sit between the
agent and the operating system and can say no.

If you want to understand what the agent is told to do, read
[`13-skills-and-agents.md`](./13-skills-and-agents.md). If you want to
understand what it is physically prevented from doing, read
[`12-harness-and-ci.md`](./12-harness-and-ci.md) and
[`../guide/07-safety-model.md`](../guide/07-safety-model.md).

---

## Part C — start here

If you are opening this repository for the first time, or coming back after a
gap, read in this order. Each step assumes the one before it.

**Stage 1 — what is this and what is a computer doing here (about 2 hours)**

1. [`../guide/01-what-this-is.md`](../guide/01-what-this-is.md) — the problem
   this project solves and the shape of the answer.
2. [`../guide/02-computer-basics.md`](../guide/02-computer-basics.md) — files,
   paths, processes, exit codes, the terminal.
3. [`../guide/03-programming-basics.md`](../guide/03-programming-basics.md) —
   functions, data structures, JSON, regular expressions.
4. [`../guide/04-ai-and-agents.md`](../guide/04-ai-and-agents.md) — what a
   language model is, what a "tool call" is, why an agent needs guardrails.

**Stage 2 — the shape of the system (about 2 hours)**

5. [`../guide/07-safety-model.md`](../guide/07-safety-model.md) — the ten hard
   rules. Read this before the architecture, not after: most of the
   architecture is a consequence of the rules.
6. [`../guide/05-architecture.md`](../guide/05-architecture.md) — how the pieces
   fit and what flows between them.
7. [`../guide/06-data-model.md`](../guide/06-data-model.md) — the database
   tables, the per-job folder, the fact base.

**Stage 3 — the code, in dependency order**

8. This page, Part D — skim it. You are not memorising it; you are learning
   which names exist.
9. [`01-lib-foundation.md`](./01-lib-foundation.md) — everything else imports
   this. Do not skip it.
10. Then pick the lane you care about and read it front to back:
    - the job hunt: [`02`](./02-leads-finding.md) → [`03`](./03-leads-screening.md) → [`04`](./04-leads-ranking.md)
    - the documents: [`05-documents.md`](./05-documents.md)
    - the form filling: [`06`](./06-apply-scanning.md) → [`07`](./07-apply-planning.md) → [`08`](./08-apply-filling.md)
    - the unattended runner: [`09`](./09-auto-runner.md) → [`10`](./10-auto-safety.md)
11. [`11-record-and-profile.md`](./11-record-and-profile.md) — the fact base and
    the application record. Read this before you ever run `save-answer.mjs`.

**Stage 4 — running it and proving it**

12. [`../operate/01-commands.md`](../operate/01-commands.md) and
    [`../operate/02-recipes.md`](../operate/02-recipes.md) — how to actually use it.
13. [`12-harness-and-ci.md`](./12-harness-and-ci.md) and
    [`14-tests.md`](./14-tests.md) — the guardrails and the suite.
14. [`../audit-2026-08-05.md`](../audit-2026-08-05.md) — the honest list of what
    is currently broken. Read it last, when you have enough context for it to
    mean something.

Keep [`../guide/08-glossary.md`](../guide/08-glossary.md) open throughout. It is
a lookup table, not a chapter.

---

## Part D — the census

Line counts measured 2026-08-06. `†` marks a file that no chapter yet covers in
depth; the listed document is its nearest home.

### Root files

| File                | Lines | What it does                                                                                                                                                           | Explained in                                                             |
| ------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `CLAUDE.md`         |   352 | The project's standing instructions to the AI agent — the ten hard rules, the command catalogue, the gotcha index. Loaded automatically at the start of every session. | [`../guide/07-safety-model.md`](../guide/07-safety-model.md)             |
| `README.md`         |   105 | The human-facing introduction: what this is, how to set it up, what it can do.                                                                                         | [`../guide/01-what-this-is.md`](../guide/01-what-this-is.md)             |
| `package.json`      |    59 | The Node project manifest: dependencies, the `npm test` command, and the **test gate floors** that assert a green run actually ran tests.                              | [`12-harness-and-ci.md`](./12-harness-and-ci.md)                         |
| `package-lock.json` |    89 | Records the exact version of every downloaded library, so a fresh install reproduces this one. Never hand-edited.                                                      | [`12-harness-and-ci.md`](./12-harness-and-ci.md)                         |
| `.gitignore`        |    61 | Which files Git must never record. Three sections are safety-critical: your fact base, your `.env`, and the two browser profiles holding real session cookies.         | [`12-harness-and-ci.md`](./12-harness-and-ci.md)                         |
| `.gitattributes`    |     5 | Forces line endings to LF everywhere. Without it, several tests that compare file text against JavaScript strings fail on Windows.                                     | [`12-harness-and-ci.md`](./12-harness-and-ci.md)                         |
| `.prettierrc`       |     3 | Formatter settings. One line: no semicolons.                                                                                                                           | [`12-harness-and-ci.md`](./12-harness-and-ci.md)                         |
| `.prettierignore`   |    16 | Files the formatter must not touch. **Three of these entries are contracts, not preferences** — see the note below.                                                    | [`12-harness-and-ci.md`](./12-harness-and-ci.md)                         |
| `.mcp.json`         |    17 | Configures the Playwright browser server the agent drives on the attended apply path.                                                                                  | [`06-apply-scanning.md`](./06-apply-scanning.md)                         |
| `.env.example`      |    12 | A template for `.env`. Shows which API keys the Adzuna job aggregator needs, with no real values.                                                                      | [`../operate/04-config-reference.md`](../operate/04-config-reference.md) |
| `.env`              |     — | **Ignored by Git, and its contents never appear in chat or a commit.** Holds the real API keys.                                                                        | [`../operate/04-config-reference.md`](../operate/04-config-reference.md) |
| `LICENSE`           |   201 | The Apache 2.0 licence text.                                                                                                                                           | —                                                                        |

> **The three `.prettierignore` contracts.** `.claude/skills/apply-job/scan-page.js`
> and `scan.driver.mjs` are loaded and evaluated as bare function expressions;
> the formatter's leading-semicolon habit would make them unparseable.
> `docs/job-sources.yaml` is edited **line by line** by `manage-sources.mjs` to
> preserve its explanatory comments, which only works while every board entry
> stays on one line — and the formatter reflows the longer ones onto several.
> All three are documented in the file itself. Do not "tidy" them.

> **Known defect (2026-08-05 audit) — `README.md`.** The rule-6 section describes
> a policy that has been replaced twice. It still says the agent hands over
> rather than submitting, that "there is no runner", and that
> `docs/application-limits.yaml` has no `auto_apply` block. All three were true
> once and none is true now. Treat `CLAUDE.md` and the code as authoritative.

> **Known defect (2026-08-05 audit) — `package.json`.** Two things. First,
> `phases.current` is `"phase-5"` but `phases.order` lists only `phase-1`
> through `phase-4`, so the scaffolding reaper's expiry rule can never fire —
> the checker looks alive and enforces nothing. Second, `testGate.full.floor` is
> 2208 while its own `measured` provenance string stops at 2186, so a 22-test
> raise has no measurement entry behind it. That `measured` string is also 9,544
> characters — 84% of the file — which every agent pays to read.

**Untracked strays at the root.** `answers.tmp`, `screen_err.log` and
`screen_all_err.log` are all 0 bytes and all covered by `.gitignore` rules
(`*.tmp`, `*.log`). The `*.tmp` rule exists specifically because a documented
repair recipe stages your real `answers.yaml` at the repository root, and
`profile/*` does not cover the root. `logs/cycle.log` (1 line) is the scheduled
runner's local log. None of these is part of the project; all four are safe to
delete.

### `src/lib/` — the foundation

Six files, 6,011 lines. Everything else in the repository imports from here.

| File               | Lines | What it does                                                                                                                                                       | Explained in                                     |
| ------------------ | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `db.mjs`           | 2,190 | The whole SQLite storage layer: the schema, every read and write, and the claim primitives the unattended runner uses to stop two workers submitting the same job. | [`01-lib-foundation.md`](./01-lib-foundation.md) |
| `untrusted.mjs`    | 1,944 | Hard rule 0 in code: strips the known carriers of prompt-injection out of posting text before any model reads it, and records what it found.                       | [`01-lib-foundation.md`](./01-lib-foundation.md) |
| `keywords.mjs`     |   624 | The one skill lexicon. Every question of the form "what technology is named in this text?" reads this file, so two lists cannot drift apart.                       | [`01-lib-foundation.md`](./01-lib-foundation.md) |
| `lib.mjs`          |   546 | Shared helpers: path resolution, YAML loading, the agent-versus-human output mode, and the job/context validators.                                                 | [`01-lib-foundation.md`](./01-lib-foundation.md) |
| `lock.mjs`         |   487 | Advisory file locking with stale-holder recovery. Exists because six concurrent writers to one YAML file lost answers and every one exited 0.                      | [`01-lib-foundation.md`](./01-lib-foundation.md) |
| `verification.mjs` |   220 | Defines what "this document was verified" means in one place, so nothing can treat "the file exists" as evidence.                                                  | [`01-lib-foundation.md`](./01-lib-foundation.md) |

> **Known defect (2026-08-05 audit).** `lock.mjs` declares `AUTO_RUN_LOCK`
> (naming `jobs/.auto/run.lock`) and nothing anywhere takes it — so no run-level
> lock is held by the unattended runner. Per-slug exclusion is separately
> covered by the database claim, so this is unused surface rather than an open
> hazard, but it reads as a control and is not one. Same category:
> `hasVerifiedResume` in `verification.mjs` and `withLockAsync` in `lock.mjs`
> have test callers only.

### `src/leads/` — finding, screening, ranking

Fifteen files, 5,668 lines. This domain is split across three chapters because
it does three separate jobs.

| File                  | Lines | What it does                                                                                                                                      | Explained in                                       |
| --------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `find-jobs.mjs`       | 1,726 | The sweep: fetches from every board in `docs/job-sources.yaml` plus Hacker News, applies the two ingest gates, dedupes, and commits under a lock. | [`02-leads-finding.md`](./02-leads-finding.md)     |
| `canonical.mjs`       |   527 | Resolves a lead's URL to the applicant-tracking-system posting behind it — 47% of stored leads arrive pointing at an aggregator instead.          | [`03-leads-screening.md`](./03-leads-screening.md) |
| `screen.mjs`          |   517 | The screening command: drives all four stages over the stored leads, adds its own pattern pass, caches the verdicts.                              | [`03-leads-screening.md`](./03-leads-screening.md) |
| `fit.mjs`             |   327 | Stage **L2** — "can this profile actually do this job?", decided from the posting body with no model call.                                        | [`03-leads-screening.md`](./03-leads-screening.md) |
| `recommend.mjs`       |   291 | Scores every stored lead against the profile and prints the top N. Replaces the model reading every lead.                                         | [`04-leads-ranking.md`](./04-leads-ranking.md)     |
| `enrich.mjs`          |   287 | Fetches the description for postings whose board returns a list with no body — four ATS types do this, and they are the Las Vegas employers.      | [`02-leads-finding.md`](./02-leads-finding.md)     |
| `manage-sources.mjs`  |   282 | The only program that edits `docs/job-sources.yaml`. Prescreens each new board with a live API call and refuses duplicates.                       | [`04-leads-ranking.md`](./04-leads-ranking.md)     |
| `find-boards.mjs`     |   275 | Turns company **names** into `{type, slug}` board candidates by probing six ATS APIs.                                                             | [`04-leads-ranking.md`](./04-leads-ranking.md)     |
| `prep-queue.mjs`      |   263 | Picks which highly-ranked leads should have a resume tailored **before** you sit down to apply.                                                   | [`04-leads-ranking.md`](./04-leads-ranking.md)     |
| `risk.mjs`            |   242 | Stage **L3** — "is this job real?" Scam, ghost, repost and prompt-injection signals.                                                              | [`03-leads-screening.md`](./03-leads-screening.md) |
| `gate-audit.mjs`      |   240 | The safety net: re-runs every screening stage over every stored lead and reports what a gate change newly killed.                                 | [`03-leads-screening.md`](./03-leads-screening.md) |
| `board-yield.mjs`     |   202 | Scores each tracked board by how many of its live postings you could actually take. A board that yields nothing costs sweep time forever.         | [`04-leads-ranking.md`](./04-leads-ranking.md)     |
| `cluster.mjs`         |   195 | Groups near-duplicate postings so one tailored resume can serve several applications.                                                             | [`04-leads-ranking.md`](./04-leads-ranking.md)     |
| `discover-boards.mjs` |   185 | Yield-gates candidate boards and proposes only the ones that clear the bar. Deliberately not a bulk crawler.                                      | [`04-leads-ranking.md`](./04-leads-ranking.md)     |
| `stages.mjs`          |   109 | A tiny registry naming the four screening stages `l0`–`l3` and running them in order, so a rejection can say **which** check rejected it.         | [`02-leads-finding.md`](./02-leads-finding.md)     |

> **Stale comment, not a defect.** The header of `find-jobs.mjs` still says it
> maintains "the lead store at jobs/leads.json". The store has been
> `jobs/leads.db` since 2026-07-29; `leads.json` survives only as a frozen
> migration input read by `maintenance/migrate.mjs`. `profile-gaps.mjs` carries
> the same stale line.

### `src/documents/` — tailoring, verifying, rendering

Nine files, 3,245 lines.

| File                  | Lines | What it does                                                                                                                               | Explained in                               |
| --------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| `assemble-resume.mjs` |   777 | Deterministic resume assembly — tailoring with the model removed. Emits your own sentences verbatim, so it cannot invent anything.         | [`05-documents.md`](./05-documents.md)     |
| `verify-claims.mjs`   |   426 | **The truthfulness gate.** Checks every claim in a tailored document against the fact base and fails the document if one cannot be backed. | [`05-documents.md`](./05-documents.md)     |
| `keyword-plan.mjs`    |   419 | Works out which keywords a posting rewards and where they may honestly be placed — built before the resume is written.                     | [`05-documents.md`](./05-documents.md)     |
| `reuse-check.mjs`     |   389 | "Is this posting close enough to one already tailored for?" Recommends only; never reuses anything by itself.                              | [`05-documents.md`](./05-documents.md)     |
| `ats-lint.mjs`        |   287 | Checks that the rendered PDF's text layer is actually readable by an applicant-tracking system.                                            | [`05-documents.md`](./05-documents.md)     |
| `new-job.mjs`         |   279 | Scaffolds a per-job workspace: `jobs/<slug>/job.json` and `context.json`.                                                                  | [`05-documents.md`](./05-documents.md)     |
| `letter-plan.mjs`     |   272 | Plans cover letters per reuse cluster rather than per job, and states what that costs.                                                     | [`05-documents.md`](./05-documents.md)     |
| `reverify.mjs`        |   254 | Re-runs verify-claims for documents verified against an older fact base — one edit invalidates every row, and this re-checks them.         | [`09-auto-runner.md`](./09-auto-runner.md) |
| `render-pdf.mjs`      |   142 | Renders markdown to PDF using a locally installed Edge or Chrome. No network, no LLM; fact annotations stripped first.                     | [`05-documents.md`](./05-documents.md)     |

### `src/apply/` — reading and filling an application form

Thirteen files at the top level (9,997 lines) plus five ATS adapters (251
lines).

| File                      | Lines | What it does                                                                                                                                            | Explained in                                     |
| ------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `fill-plan.mjs`           | 2,499 | Turns a page scan into a deterministic fill plan. **All the decisions happen here**; the engine only executes them.                                     | [`07-apply-planning.md`](./07-apply-planning.md) |
| `fill-engine.mjs`         | 1,521 | Executes the plan against the live page. Makes no decisions of its own, so the model is never in this loop.                                             | [`08-apply-filling.md`](./08-apply-filling.md)   |
| `answer-bank.mjs`         | 1,284 | Resolves scanned fields against the fact base. Never invents an answer: anything it cannot resolve comes back `UNKNOWN`.                                | [`07-apply-planning.md`](./07-apply-planning.md) |
| `automatability.mjs` †    |   756 | "Could the deterministic pipeline apply to this posting without a human?" A module, deliberately not a screening stage.                                 | [`09-auto-runner.md`](./09-auto-runner.md)       |
| `intents.mjs`             |   751 | Typed intents: maps a question to a **meaning** rather than to an answer string, so "do you require sponsorship?" cannot be confused with its opposite. | [`07-apply-planning.md`](./07-apply-planning.md) |
| `auth-sync.mjs` †         |   698 | Copies the attended browser profile to the unattended runner's own profile, and refuses to do it while either browser is live.                          | [`09-auto-runner.md`](./09-auto-runner.md)       |
| `scan-engine.mjs`         |   768 | Installs the page scanner, runs it, and probes every custom dropdown for its options — in one call, with no pasted code.                                | [`06-apply-scanning.md`](./06-apply-scanning.md) |
| `capture-post-submit.mjs` |   533 | Captures the page an employer shows after **you** click submit, so the post-click classifier has real evidence. Stage → review → promote.               | [`10-auto-safety.md`](./10-auto-safety.md)       |
| `field-cache.mjs` †       |   348 | Remembers the shape of a form already filled — which widget each field is, what options it offers, which strategy worked.                               | [`07-apply-planning.md`](./07-apply-planning.md) |
| `pending-questions.mjs` † |   330 | Every question the fact base cannot answer, across all prepped jobs, in one list — so you answer each once, not once per application.                   | [`07-apply-planning.md`](./07-apply-planning.md) |
| `disclosure.mjs` †        |   242 | Two limits on autonomy: how much of one banked answer a single field may pull, and how many distinct facts one form may pull.                           | [`07-apply-planning.md`](./07-apply-planning.md) |
| `browser.mjs`             |   206 | Plumbing: launch a browser, hand out a page, decide where a browser may point, and turn engine text into something a sandbox can run.                   | [`06-apply-scanning.md`](./06-apply-scanning.md) |
| `longform.mjs` †          |   199 | Helpers for prose questions ("describe a project you are proud of"). **Currently wired to nothing** — see below.                                        | [`07-apply-planning.md`](./07-apply-planning.md) |

**The ATS adapters — `src/apply/ats/`**

An adapter contributes only _knowledge_, never behaviour: which dropdown
strategy to try first, which file field takes which document. The fill engine
itself contains no board-specific code, so an unrecognised board still works.

| File             | Lines | What it does                                                                                               | Explained in                                   |
| ---------------- | ----: | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `greenhouse.mjs` |    74 | Greenhouse, including the `/embed/job_app` iframe that company careers pages use. Field map verified live. | [`08-apply-filling.md`](./08-apply-filling.md) |
| `index.mjs`      |    65 | Detects which board a URL belongs to and hands back the matching adapter, or the generic one.              | [`08-apply-filling.md`](./08-apply-filling.md) |
| `ashby.mjs`      |    43 | Ashby: custom React dropdowns and a drag-or-click file field.                                              | [`08-apply-filling.md`](./08-apply-filling.md) |
| `lever.mjs`      |    37 | Lever: plainer than the others, mostly native inputs and a conventional file input.                        | [`08-apply-filling.md`](./08-apply-filling.md) |
| `generic.mjs`    |    32 | Fallback for any unrecognised form: tries every strategy in turn and reports which one worked.             | [`08-apply-filling.md`](./08-apply-filling.md) |

> **Known defect (2026-08-05 audit) — `longform.mjs`.** 199 lines exporting four
> functions, and a repository-wide search finds no importer anywhere in
> `src/`, `.claude/` or `tests/`, and no test file. It has a careful 35-line
> header arguing why it is lawful under hard rule 1, and it never runs. Either
> wire it into the plan's defer path or delete it — a module that exists but
> never executes is the shape that later gets mistaken for a live control.

> **Known defect (2026-08-05 audit) — probe-skipping.** Both `scan-engine.mjs`
> and `fill-plan.mjs` implement the optimisation that skips re-probing a
> dropdown whose options the field cache already knows, and **no production
> caller wires it up**. The slowest part of a scan is therefore still paid in
> full on every run.

> **Five files under active repair right now.** `answer-bank.mjs`,
> `intents.mjs`, `fill-plan.mjs`, `fill-engine.mjs` and `auto/multipage.mjs` are
> being changed as this index is written. Their line counts above are accurate
> as of the measurement and will move.

### `src/auto/` — the unattended runner and its brakes

Twenty-two files, 8,845 lines. Split across two chapters: the machinery that
runs, and the machinery that stops it.

| File                 | Lines | What it does                                                                                                                 | Explained in                               |
| -------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `audit.mjs`          | 1,028 | The run ledger, written twice on purpose: an append-only text file that survives, and SQLite tables for querying.            | [`10-auto-safety.md`](./10-auto-safety.md) |
| `authorize.mjs`      |   796 | Eleven preconditions in one place, producing a frozen single-use token that is the only permission to click.                 | [`10-auto-safety.md`](./10-auto-safety.md) |
| `auto-apply.mjs`     |   756 | The runner's command-line entry point: arguments, job selection, browser launch, worker pool.                                | [`09-auto-runner.md`](./09-auto-runner.md) |
| `preflight.mjs`      |   606 | "Would a run start right now?" — six read-only checks, including a scan of the fact base.                                    | [`10-auto-safety.md`](./10-auto-safety.md) |
| `guard.mjs`          |   587 | The filesystem boundary, the STOP kill switch and its four scopes, and the append-only alert inbox.                          | [`10-auto-safety.md`](./10-auto-safety.md) |
| `job.mjs`            |   568 | The per-job state machine: `queued → claimed → planned → …`, one application start to finish.                                | [`09-auto-runner.md`](./09-auto-runner.md) |
| `submit.mjs`         |   532 | `submitOnce()` — **the only function in this repository permitted to contain a submit click**, and its eleven preconditions. | [`09-auto-runner.md`](./09-auto-runner.md) |
| `cycle.mjs`          |   486 | One whole cycle: find → screen → reverify → prep → tailor → apply. The thing a scheduler runs twice a day.                   | [`09-auto-runner.md`](./09-auto-runner.md) |
| `trust.mjs`          |   411 | Five mechanical facts that decide whether a board may be submitted to unattended. Never a model's impression of a page.      | [`10-auto-safety.md`](./10-auto-safety.md) |
| `taxonomy.mjs`       |   394 | The closed vocabulary of defer/failure reasons, and which single one gets recorded when several apply.                       | [`10-auto-safety.md`](./10-auto-safety.md) |
| `multipage.mjs`      |   385 | `walkPages()` — resolves a multi-page application form one page at a time.                                                   | [`09-auto-runner.md`](./09-auto-runner.md) |
| `classify.mjs`       |   333 | Types the page that comes back after a click, into one of seven kinds. A pure function of `(url, html)` — no I/O, no clock.  | [`10-auto-safety.md`](./10-auto-safety.md) |
| `breaker.mjs`        |   326 | The anomaly circuit breaker: retry a transient, pause one board, or stop the run.                                            | [`10-auto-safety.md`](./10-auto-safety.md) |
| `digest.mjs`         |   290 | "Is the machine working?" — the `auto` section of `node src/status.mjs`. Reports progress, not recency.                      | [`10-auto-safety.md`](./10-auto-safety.md) |
| `reconcile.mjs`      |   288 | Asks the board, read-only, whether an orphaned submit attempt actually became an application.                                | [`10-auto-safety.md`](./10-auto-safety.md) |
| `advance.mjs`        |   263 | `advanceOnce()` — the second and last file permitted a click, and it may click only a control whose scanned role is `next`.  | [`09-auto-runner.md`](./09-auto-runner.md) |
| `untrusted-text.mjs` |   219 | The boundary between third-party page text and anything this directory keeps.                                                | [`10-auto-safety.md`](./10-auto-safety.md) |
| `stages.mjs`         |   189 | The four injected browser stages (`scan`, `plan`, `fill`, `classify`) — the real browser leg.                                | [`09-auto-runner.md`](./09-auto-runner.md) |
| `pool.mjs`           |   185 | The worker pool, partitioned by **origin** rather than by board.                                                             | [`09-auto-runner.md`](./09-auto-runner.md) |
| `caps.mjs`           |   114 | The blast-radius arithmetic: per-run, per-day and per-company caps, and nothing else.                                        | [`09-auto-runner.md`](./09-auto-runner.md) |
| `notify.mjs`         |    81 | A Windows desktop toast when the runner disables itself. Best-effort by design; cannot throw.                                | [`10-auto-safety.md`](./10-auto-safety.md) |
| `cycle.cmd`          |    35 | A Windows batch wrapper so Task Scheduler — which has no shell and no reliable `PATH` — can start `cycle.mjs`.               | [`09-auto-runner.md`](./09-auto-runner.md) |

> **Capability, stated from the code and not from a plan (2026-08-06).** The
> unattended runner is **armed**. `docs/application-limits.yaml` reads
> `auto_apply.enabled: true` and `dry_run: false` with four allowlisted ATS
> domains, and `auto-apply.mjs` calls `makeStages()` and `launchBrowser()`,
> which launches Chromium. Several documents in `docs/` still assert the
> opposite ("nothing opens a browser unattended"); they are wrong. Check it
> yourself before believing either claim — the two facts are
> `auto_apply:` in `docs/application-limits.yaml` and the `launchBrowser` import
> in `src/auto/auto-apply.mjs`.

> **Known defect (2026-08-05 audit) — `advance.mjs`.** It imports
> `consumeSubmitToken` and never uses it. That is misleading in precisely the
> file a reviewer opens to confirm what a "Next" click can and cannot do.

> **Known defect (2026-08-05 audit) — `job.mjs`.** The dry-run early exit for
> multi-page forms is unreachable, because the flag it tests (`hasNext`) is
> never set.

### `scripts/profile/`, `src/applications/`, `src/maintenance/`, `src/status.mjs`

The record-keeping half of the system: what you know, what you applied to, and
housekeeping.

| File                                  | Lines | What it does                                                                                                                                                               | Explained in                                             |
| ------------------------------------- | ----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `profile/save-answer.mjs`             | 1,106 | **The only door into the fact base**, and every refusal that guards it (exit 3 for instruction-shaped text, exit 4 for a government or financial identifier, no override). | [`11-record-and-profile.md`](./11-record-and-profile.md) |
| `profile/keyword-coverage.mjs`        |   368 | What postings demand that you probably **have** but never wrote down.                                                                                                      | [`11-record-and-profile.md`](./11-record-and-profile.md) |
| `profile/profile-gaps.mjs`            |   222 | What postings demand that your profile genuinely does not evidence, weighted toward rejections.                                                                            | [`11-record-and-profile.md`](./11-record-and-profile.md) |
| `profile/apply-profile.mjs`           |   117 | Installs a reviewed profile update, proving no existing fact was silently deleted or rewritten.                                                                            | [`11-record-and-profile.md`](./11-record-and-profile.md) |
| `applications/applications.mjs`       |   195 | The read/write surface for the application store: list, search, count, delete-with-confirmation, re-export.                                                                | [`11-record-and-profile.md`](./11-record-and-profile.md) |
| `applications/update-application.mjs` |   142 | Records what happened to one application — a status change or a follow-up sent.                                                                                            | [`11-record-and-profile.md`](./11-record-and-profile.md) |
| `applications/follow-ups.mjs`         |   100 | Which applications are due a nudge today. Read-only; never writes.                                                                                                         | [`11-record-and-profile.md`](./11-record-and-profile.md) |
| `applications/log-application.mjs`    |    79 | Creates one application record — the only sanctioned way, and only after you confirm you applied.                                                                          | [`11-record-and-profile.md`](./11-record-and-profile.md) |
| `applications/check-applied.mjs`      |    75 | "Have I already applied here?", as machine-readable output.                                                                                                                | [`11-record-and-profile.md`](./11-record-and-profile.md) |
| `maintenance/archive.mjs`             |   681 | Folds a closed job folder into the database, verified byte for byte.                                                                                                       | [`11-record-and-profile.md`](./11-record-and-profile.md) |
| `maintenance/migrate.mjs`             |   270 | Builds or tops up `jobs/leads.db` from the on-disk sources. Flat, not versioned — no migration chain.                                                                      | [`11-record-and-profile.md`](./11-record-and-profile.md) |
| `maintenance/prune-jobs.mjs`          |   151 | Deletes the one file type that is waste at every moment (`*.render.html`).                                                                                                 | [`11-record-and-profile.md`](./11-record-and-profile.md) |
| `status.mjs`                          |   152 | The whole-pipeline digest in one call — replaces several separate commands and the round-trips between them.                                                               | [`11-record-and-profile.md`](./11-record-and-profile.md) |

### `src/hooks/` — the agent-editable guardrails

Three files, 739 lines. A **hook** is a small program the AI harness runs before
(or after) a tool call; it can allow the call, or refuse it. Refusal is not a
suggestion — the action never happens.

| File              | Lines | What it does                                                                                         | Explained in                                     |
| ----------------- | ----: | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `guard-bash.mjs`  |   608 | Denies any Git command that would leave, or act outside, the `dev` branch. Hard rule 7 in code.      | [`12-harness-and-ci.md`](./12-harness-and-ci.md) |
| `prettify.mjs`    |    71 | Runs the formatter on every file the agent edits. Never blocks; silently skips what it cannot parse. | [`12-harness-and-ci.md`](./12-harness-and-ci.md) |
| `guard-files.mjs` |    60 | Denies any write whose path lands outside the project directory. Hard rule 9.                        | [`12-harness-and-ci.md`](./12-harness-and-ci.md) |

> **Known defect (2026-08-05 audit) — `guard-bash.mjs`.** A Git command hidden
> inside a quoted interpreter argument evades the branch guard: the tokenizer
> keeps `"git checkout main"` as one token, and the check that recognises a Git
> invocation is anchored, so it does not match. The older fallback regexes it
> replaced **do** catch it, but they only run when the tokenizer throws.

### `.claude/` — how the agent is configured

`.claude/hooks/` and `.claude/settings*.json` are **the user's files**, sealed
against agent edits on both the editing and the shell path. `.claude/skills/`
and `.claude/agents/` are documentation the agent reads.

| File                                    | Lines | What it does                                                                                                     | Explained in                                     |
| --------------------------------------- | ----: | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `.claude/settings.json`                 |    54 | **Wires all five hooks** and holds the pre-approved command list. Sealed — changing it changes what is enforced. | [`12-harness-and-ci.md`](./12-harness-and-ci.md) |
| `.claude/settings.local.json`           |    13 | Machine-local extra approvals. Ignored by Git via a global rule, not this repository's `.gitignore`.             | [`12-harness-and-ci.md`](./12-harness-and-ci.md) |
| `.claude/hooks/guard-profile-shell.mjs` |   239 | Denies shell commands that would write to the fact base or the guardrail machinery.                              | [`12-harness-and-ci.md`](./12-harness-and-ci.md) |
| `.claude/hooks/protect-profile.js`      |    55 | The same targets, on the file-editing path instead of the shell path.                                            | [`12-harness-and-ci.md`](./12-harness-and-ci.md) |

> **Known defect (2026-08-05 audit).** `docs/application-limits.yaml` is
> user-owned by written rule and guarded by **neither** hook. It is the file
> holding `auto_apply.enabled` and `board_allowlist` — the switch that turns
> unattended submitting on — and both an editing tool call and a shell write to
> it currently pass. Both hooks are yours to change; the audit proposes adding
> the path to each.

**`.claude/skills/` — what the agent is told to do.** A _skill_ is a directory
containing a `SKILL.md`: a description that decides when it triggers, and
instructions the agent follows once it does.

| File                           | Lines | Triggers on                                                                         | Explained in                                           |
| ------------------------------ | ----: | ----------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `apply-job/SKILL.md`           |   518 | "apply to this URL" — the whole attended apply flow.                                | [`13-skills-and-agents.md`](./13-skills-and-agents.md) |
| `apply-job/scan-page.js`       | 2,329 | not a skill file: **the scanner**, which runs inside the web page.                  | [`06-apply-scanning.md`](./06-apply-scanning.md)       |
| `apply-job/scan.driver.mjs`    |   440 | not a skill file: the same scan in one browser tool call, for the attended path.    | [`06-apply-scanning.md`](./06-apply-scanning.md)       |
| `pipeline-jobs/SKILL.md`       |   198 | batch-processing stored leads, one sub-agent per job.                               | [`13-skills-and-agents.md`](./13-skills-and-agents.md) |
| `manage-applications/SKILL.md` |   137 | reading and writing the application record.                                         | [`13-skills-and-agents.md`](./13-skills-and-agents.md) |
| `find-jobs/SKILL.md`           |   106 | searching for postings, or a given board URL.                                       | [`13-skills-and-agents.md`](./13-skills-and-agents.md) |
| `tailor-resume/SKILL.md`       |    94 | tailoring the resume for one posting.                                               | [`13-skills-and-agents.md`](./13-skills-and-agents.md) |
| `tailor-cover-letter/SKILL.md` |    64 | tailoring the cover letter, consistent with the resume via the shared context file. | [`13-skills-and-agents.md`](./13-skills-and-agents.md) |
| `update-profile/SKILL.md`      |    53 | merging an updated resume or new experience into the fact base.                     | [`13-skills-and-agents.md`](./13-skills-and-agents.md) |
| `follow-up/SKILL.md`           |    50 | outcomes and nudges.                                                                | [`13-skills-and-agents.md`](./13-skills-and-agents.md) |
| `manage-sources/SKILL.md`      |    50 | adding or removing a company from the daily sweep.                                  | [`13-skills-and-agents.md`](./13-skills-and-agents.md) |
| `profile-gaps/SKILL.md`        |    45 | "what am I missing / why am I not getting responses?"                               | [`13-skills-and-agents.md`](./13-skills-and-agents.md) |
| `check-applied/SKILL.md`       |    40 | "did I already apply to X?"                                                         | [`13-skills-and-agents.md`](./13-skills-and-agents.md) |

**`.claude/agents/` — sub-agent role definitions.** Each file defines a narrower
worker the main agent can hand a bounded task to, with its own model and its own
restricted tool list.

| File               | Lines | Role                                                                                    | Explained in                                           |
| ------------------ | ----: | --------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `doc-scribe.md`    |   177 | Documentation: owns `CLAUDE.md`, the reference docs, the skill files and code comments. | [`13-skills-and-agents.md`](./13-skills-and-agents.md) |
| `build-manager.md` |   163 | Integration manager: assigns file sets, reviews diffs, runs the suite, commits.         | [`13-skills-and-agents.md`](./13-skills-and-agents.md) |
| `ci-engineer.md`   |   160 | Owns the CI pipeline, `package.json`, the guardrail hooks and repository config.        | [`13-skills-and-agents.md`](./13-skills-and-agents.md) |
| `implementer.md`   |    92 | Builds and fixes product code anywhere under `src/`, and writes its own tests.          | [`13-skills-and-agents.md`](./13-skills-and-agents.md) |
| `architect.md`     |    89 | Read-only reviewer and tie-breaker on design questions. Writes no product code.         | [`13-skills-and-agents.md`](./13-skills-and-agents.md) |
| `qa.md`            |    81 | Adversarial QA: builds hostile job ads and hostile forms, tries to break changes.       | [`13-skills-and-agents.md`](./13-skills-and-agents.md) |
| `job-worker.md`    |    59 | Per-job worker, pinned to a smaller model because the work is mechanical.               | [`13-skills-and-agents.md`](./13-skills-and-agents.md) |

> **Known defect (2026-08-05 audit).** Nine of the audit's findings are in
> `apply-job/SKILL.md` and five in `tailor-resume/SKILL.md` — skill files carry
> the highest concentration of stale instructions in the repository, because
> nothing tests prose. See [`../audit-2026-08-05.md`](../audit-2026-08-05.md).

### `.github/workflows/` — the automated checks

These run on GitHub's computers, not yours, every time you push. Five jobs:
`security-gate`, `test`, `scaffolding`, `perf-gate`, `ci-gate`.

| File                     | Lines | What it does                                                                                                                    | Explained in                                     |
| ------------------------ | ----: | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `scaffolding-reaper.mjs` |   592 | Fails the build when a development-only artifact outlives the phase it promised to die in.                                      | [`12-harness-and-ci.md`](./12-harness-and-ci.md) |
| `test-gate.mjs`          |   505 | Runs the suite and asserts what a green run must **prove** — because `node --test` exits 0 when it runs zero tests.             | [`12-harness-and-ci.md`](./12-harness-and-ci.md) |
| `perf-gate.mjs`          |   345 | Runs the campaign benchmark against a loopback fixture and fails on a regression against a committed baseline.                  | [`12-harness-and-ci.md`](./12-harness-and-ci.md) |
| `ci.yml`                 |   267 | The pipeline definition: which jobs run, in what order, on which operating systems.                                             | [`12-harness-and-ci.md`](./12-harness-and-ci.md) |
| `report-browsers.mjs`    |    41 | Prints which browser the PDF renderer would find on this machine, so a skipped PDF test is attributable rather than mysterious. | [`12-harness-and-ci.md`](./12-harness-and-ci.md) |

### `schemas/` and `templates/`

| File                          | Lines | What it does                                                                                         | Explained in                                             |
| ----------------------------- | ----: | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `schemas/context.schema.json` |    69 | The shape of `jobs/<slug>/context.json`, the **shared** tailoring context both document skills read. | [`../guide/06-data-model.md`](../guide/06-data-model.md) |
| `schemas/job.schema.json`     |    49 | The shape of `jobs/<slug>/job.json`, the captured posting.                                           | [`../guide/06-data-model.md`](../guide/06-data-model.md) |
| `templates/document.css`      |    84 | The print stylesheet used when rendering a resume or letter to PDF: Letter size, 0.4in margins.      | [`05-documents.md`](./05-documents.md)                   |

### `docs/` — three load-bearing config files and a great deal of prose

The three files at the top of this table are **read by running code**. Everything
below them is text.

| File                         | Lines | Class                      | What it does                                                                                                             | Explained in                                                             |
| ---------------------------- | ----: | -------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `application-limits.yaml`    |   342 | load-bearing               | **Yours.** Location rules, title keywords, staleness limits, and the `auto_apply` block. Read at runtime by ten scripts. | [`../operate/04-config-reference.md`](../operate/04-config-reference.md) |
| `job-sources.yaml`           |    81 | load-bearing               | The swept board list. Edited line-by-line by `manage-sources.mjs`; excluded from the formatter for that reason.          | [`../operate/04-config-reference.md`](../operate/04-config-reference.md) |
| `perf-baseline.json`         |    32 | load-bearing               | The committed performance baseline the CI gate compares each run against.                                                | [`15-benchmarks.md`](./15-benchmarks.md)                                 |
| `tailoring-rules.md`         |   153 | load-bearing at model time | Loaded by three skill files with an `@` reference. Deleting it degrades every tailored document and no test goes red.    | [`05-documents.md`](./05-documents.md)                                   |
| `audit-2026-08-05.md`        | 1,865 | prose                      | The finished audit report — 247 findings with evidence. The honest list of what is broken.                               | [itself](../audit-2026-08-05.md)                                         |
| `measurements.md`            | 1,236 | working notes              | The append-only measurement ledger. No runtime reader; cited in comments by four benchmark scripts and the CI file.      | [`15-benchmarks.md`](./15-benchmarks.md)                                 |
| `board-candidates.yaml`      |   872 | generated                  | Output of board discovery — written, never read back.                                                                    | [`04-leads-ranking.md`](./04-leads-ranking.md)                           |
| `candidates/yc.yaml`         |   637 | input data                 | Company list from the public Y Combinator directory, fed to `find-boards.mjs` on demand.                                 | [`04-leads-ranking.md`](./04-leads-ranking.md)                           |
| `candidates/fortune500.yaml` |   146 | input data                 | Fortune 500 company list, same use.                                                                                      | [`04-leads-ranking.md`](./04-leads-ranking.md)                           |
| `candidates/local-lv.yaml`   |    64 | input data                 | Las Vegas metro employer list, same use.                                                                                 | [`04-leads-ranking.md`](./04-leads-ranking.md)                           |
| `agent-protocol.md`          |   288 | working notes              | How the multi-agent development process is meant to run.                                                                 | [`13-skills-and-agents.md`](./13-skills-and-agents.md)                   |
| `team-roster.md`             |   256 | working notes              | Which development role owns which paths.                                                                                 | [`13-skills-and-agents.md`](./13-skills-and-agents.md)                   |
| `roster-log.md`              |   217 | working notes              | Every hire, fire and ownership ruling, with its reason.                                                                  | [`13-skills-and-agents.md`](./13-skills-and-agents.md)                   |
| `research/` (4 files)        |   445 | working notes              | Outside-world research from 2026-07-31: how ATS systems rank resumes, comparable services, market demand.                | —                                                                        |

**The stale set.** These 33 files describe the system as it was planned or as it
was weeks ago, and several assert in the present tense things the code now
contradicts. They are being replaced by the document set this page belongs to.
Mine them for history if you are curious why something is the way it is; do not
read them as a description of the code.

| Group                                             | Files | Lines | Status                                                                                                             |
| ------------------------------------------------- | ----: | ----: | ------------------------------------------------------------------------------------------------------------------ |
| `docs/reference/` (`README`, `00`–`10`, `AUDIT`)  |    13 | 6,085 | The previous documentation set. Superseded by `docs/guide/`, `docs/code/`, `docs/operate/`.                        |
| `docs/autonomy/` (`00`–`08`, `phase-0`–`phase-6`) |    15 | 1,955 | Planning documents. `04-runner-spec.md` is the most stale file in the tree — it asserts the runner does not exist. |
| `docs/autonomy-plan.md`, `-v2.md`                 |     2 | 1,292 | The v1 plan and the v2 index. v1 is superseded in seven decisions by v2.                                           |
| `docs/improvement-plan.md`                        |     1 |   429 | A completed plan, marked implemented 2026-07-29.                                                                   |
| `docs/next-session-plan.md`, `-prompt.md`         |     2 |   398 | Session hand-off notes, superseded by the very change one of them warns about.                                     |

**The new set** — 28 documents in three directories: `docs/guide/` (8),
`docs/code/` (16, including this one) and `docs/operate/` (4). Written from the
code as it stands on 2026-08-05/06. They are being produced in parallel, so if a
link in the "Where to go next" section below does not resolve yet, that document
is still being written rather than missing.

### `tests/` — counted at directory level

224 files, 123 of them tests, roughly 62,000 lines. The whole suite is explained
in [`14-tests.md`](./14-tests.md); this table exists so a directory name is never
a mystery.

Run one directory with `node --test "tests/<name>/**/*.test.mjs"` — the quotes
matter, and so does the `**`: on Node 24, handing `node --test` a bare directory
does **not** search inside it and produces an error that looks like a test
failure.

| Directory             | Test files | All files |  Lines | Covers                                                                                                              | Explained in                             |
| --------------------- | ---------: | --------: | -----: | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `tests/apply/`        |         25 |        25 | 18,495 | Scanning, planning, filling, the answer bank, the ATS adapters, the field cache, the Oracle board fixes.            | [`14-tests.md`](./14-tests.md)           |
| `tests/auto/`         |         27 |        27 | 11,761 | The unattended runner and every brake: trust, authorize, submit, classify, breaker, reconcile, the click surface.   | [`14-tests.md`](./14-tests.md)           |
| `tests/fixtures/`     |          0 |        79 |  7,098 | **Not tests — inputs.** Fake ATS pages, hostile forms, poisoned postings, golden documents, the post-submit corpus. | [`14-tests.md`](./14-tests.md)           |
| `tests/security/`     |         11 |        12 |  5,493 | The Phase 1 gate: injection corpora, board fidelity, hostile forms, the NUL-byte source scan.                       | [`14-tests.md`](./14-tests.md)           |
| `tests/leads/`        |         22 |        22 |  5,414 | Finding, screening, ranking, the gate audit, board discovery.                                                       | [`14-tests.md`](./14-tests.md)           |
| `tests/documents/`    |         12 |        33 |  4,484 | Tailoring, verification, rendering — plus a golden corpus of eight expected resumes.                                | [`14-tests.md`](./14-tests.md)           |
| `tests/lib/`          |          6 |         6 |  3,978 | The foundation: database, keywords, helpers, locking, untrusted text, verification.                                 | [`14-tests.md`](./14-tests.md)           |
| `tests/hooks/`        |          7 |         7 |  2,261 | The guardrails themselves, the test gate, the performance gate, the reaper, repository hygiene.                     | [`14-tests.md`](./14-tests.md)           |
| `tests/profile/`      |          5 |         5 |  2,193 | The fact-base door, the profile merge guarantees, the two gap analyses.                                             | [`14-tests.md`](./14-tests.md)           |
| `tests/maintenance/`  |          3 |         3 |  1,157 | Archiving, migration, pruning.                                                                                      | [`14-tests.md`](./14-tests.md)           |
| `tests/dev/`          |          4 |         4 |    851 | The benchmark harnesses and the flake-rate estimator.                                                               | [`15-benchmarks.md`](./15-benchmarks.md) |
| `tests/applications/` |          3 |         3 |    535 | The application record: create, update, follow-ups.                                                                 | [`14-tests.md`](./14-tests.md)           |

The gate the project actually runs is `npm test`, which is **not** `node --test`.
It expands the file list itself and asserts the resulting count against a floor
in `package.json` (currently 2,208 tests for the full gate, 262 for the security
gate), because an exit code alone cannot distinguish "everything passed" from
"nothing ran".

### What is deliberately not listed

| Path                | Why it is excluded                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `node_modules/`     | Downloaded third-party code. Thousands of files, none of them yours. `npm install` recreates it.             |
| `.git/`             | Git's internal storage of the project history.                                                               |
| `jobs/`             | Your per-job workspaces (21 today) **and `leads.db`, the store of record**. Contains real posting data.      |
| `profile/`          | Your fact base: name, contact details, work history, banked answers, source PDFs. Never leaves this machine. |
| `.playwright-mcp/`  | A browser profile holding **real ATS session cookies**. Committing it would leak live credentials.           |
| `.playwright-auto/` | The unattended runner's equivalent, refreshed by `auth-sync.mjs`. Same reason.                               |
| `logs/`             | Machine-local run records from the scheduled cycle.                                                          |

Only `profile/profile.example.yaml` (53 lines) is listed, because it shows the
**shape** of the fact base with no real values in it. If you need to know what a
profile looks like, read that file, not the real one.

---

## Part E — this index is a census, and a census decays

Everything above was true on **2026-08-06**. Some of it was already changing
while it was being written: `tests/auto/` measured 11,711 lines at the start of
this document and 11,761 fifty minutes later, because another agent was
repairing `multipage.mjs` and its test at the same time.

That is not a small caveat. The **previous** manifest in this repository —
`docs/reference/README.md` — was a table exactly like these, written with care,
and by the 2026-08-05 audit it was wrong on 24 separate entries, several by a
factor of two or three:

| It claimed                     | Reality on 2026-08-06  | Wrong by         |
| ------------------------------ | ---------------------- | ---------------- |
| "All 156 tracked files"        | 399 tracked files      | 2.6×             |
| "66 test files"                | 123 test files         | 1.9×             |
| test gate floor "946 full"     | 2,208                  | 2.3×             |
| test gate floor "147 security" | 262                    | 1.8×             |
| one agent definition           | seven                  | 7×               |
| no mention of `src/auto/`      | 22 files, 8,845 lines  | omitted entirely |
| no mention of `tests/auto/`    | 27 files, 11,761 lines | omitted entirely |

Its own header had even warned readers: use it to find the document for a file,
not as a census. The warning did not help, because a table of numbers reads as
authoritative whether or not a sentence above it says otherwise.

So: **treat the line counts here as an order of magnitude, and the file list as
a snapshot.** The parts that decay slowly are the one-sentence purposes and the
chapter assignments; those describe intent, and intent moves at the speed of
design decisions rather than the speed of edits. The parts that decay fastest are
the numbers.

### Regenerating the numbers

Run this in PowerShell, from the repository root. It rebuilds the line count for
every tracked file in the code directories:

```powershell
git ls-files scripts .claude .github schemas templates |
  ForEach-Object { [pscustomobject]@{ file = $_; lines = @(Get-Content $_).Count } } |
  Sort-Object file | Format-Table -AutoSize
```

Note `@(Get-Content $_).Count` and not `Measure-Object -Line` — the latter skips
blank lines and under-reports by roughly 20%.

For the `tests/` table, which is counted at directory level:

```powershell
Get-ChildItem tests -Directory | ForEach-Object {
  $files = Get-ChildItem $_.FullName -Recurse -File
  [pscustomobject]@{
    dir   = $_.Name
    tests = @($files | Where-Object { $_.Name -like '*.test.mjs' }).Count
    files = $files.Count
    lines = ($files | ForEach-Object { @(Get-Content $_.FullName).Count } | Measure-Object -Sum).Sum
  }
} | Format-Table -AutoSize
```

If you prefer Git Bash, the equivalents are shorter:

```bash
git ls-files scripts .claude .github schemas templates | sort | xargs wc -l
find tests -type d -maxdepth 1 -mindepth 1 | while read d; do
  echo "$d $(find "$d" -name '*.test.mjs' | wc -l) $(find "$d" -type f | xargs wc -l | tail -1)"
done
```

And to check whether a file is new since this index was written:

```bash
git ls-files --others --exclude-standard     # untracked, not ignored
git log --diff-filter=A --name-only --since="2026-08-06"
```

If you regenerate and the numbers have moved a lot, that is the system working
— not this page failing. Update the table, and keep the date line honest.

---

## Where to go next

**If you are new**, follow the reading order in Part C. It starts at
[`../guide/01-what-this-is.md`](../guide/01-what-this-is.md).

**If you came here to find a file**, the "Explained in" column is the answer.
The full document set:

- **The guide** — concepts, no code:
  [`01-what-this-is`](../guide/01-what-this-is.md) ·
  [`02-computer-basics`](../guide/02-computer-basics.md) ·
  [`03-programming-basics`](../guide/03-programming-basics.md) ·
  [`04-ai-and-agents`](../guide/04-ai-and-agents.md) ·
  [`05-architecture`](../guide/05-architecture.md) ·
  [`06-data-model`](../guide/06-data-model.md) ·
  [`07-safety-model`](../guide/07-safety-model.md) ·
  [`08-glossary`](../guide/08-glossary.md)
- **The code** — this directory:
  [`01-lib-foundation`](./01-lib-foundation.md) ·
  [`02-leads-finding`](./02-leads-finding.md) ·
  [`03-leads-screening`](./03-leads-screening.md) ·
  [`04-leads-ranking`](./04-leads-ranking.md) ·
  [`05-documents`](./05-documents.md) ·
  [`06-apply-scanning`](./06-apply-scanning.md) ·
  [`07-apply-planning`](./07-apply-planning.md) ·
  [`08-apply-filling`](./08-apply-filling.md) ·
  [`09-auto-runner`](./09-auto-runner.md) ·
  [`10-auto-safety`](./10-auto-safety.md) ·
  [`11-record-and-profile`](./11-record-and-profile.md) ·
  [`12-harness-and-ci`](./12-harness-and-ci.md) ·
  [`13-skills-and-agents`](./13-skills-and-agents.md) ·
  [`14-tests`](./14-tests.md) ·
  [`15-benchmarks`](./15-benchmarks.md)
- **Operating it** — commands and fixes:
  [`01-commands`](../operate/01-commands.md) ·
  [`02-recipes`](../operate/02-recipes.md) ·
  [`03-troubleshooting`](../operate/03-troubleshooting.md) ·
  [`04-config-reference`](../operate/04-config-reference.md)
- **What is broken** — [`../audit-2026-08-05.md`](../audit-2026-08-05.md), 247
  findings with evidence. The defect notes scattered through Part D are a
  selection from it, not a summary of it.
