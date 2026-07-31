# Next-session plan — cut reasoning cost, parallelize, hybrid document storage

Hand this file to a fresh session. It is self-contained: it assumes no memory of
the conversation that produced it.

**Read `CLAUDE.md` first** — its hard rules (truthfulness, fact-base protection,
`dev` branch only, never auto-submit) all still apply and are not repeated here.

**Working preference from the user: plan before acting.** Investigate, produce a
concrete plan, get sign-off, then implement. Do not commit unless asked.

> **Status note added 2026-07-31 (`doc-scribe`). This is a dated plan, not a
> to-do list, and several items below have since shipped — do not build them
> twice.** Verified by opening the files rather than by reading a report:
> **§1.2** `save-answer.mjs` takes `--source user|model` and `--replace`;
> **§1.3** `fill-plan.mjs` prints `ready=` (and `submitReady=`), though `ready`
> was **redefined** afterwards to mean "no model turn is needed" rather than
> "nothing is deferred" — a consent-only defer no longer blocks it, and nothing
> auto-ticks consent; **§1.4** `scripts/apply/pending-questions.mjs` exists and
> batches across jobs; **§1.5** the `screens` table is in `db.mjs`'s schema with
> a `(lead_id, source)` key. Everything else here is **unverified** by this note
> and should be checked against the code before acting on it. The live plan is
> `docs/autonomy-plan.md`.

---

## 0. Where the project stands (2026-07-29)

Three commits landed today on `dev`: `7eb48b3`, `f71aa7f`, `eaf7337`.

**Storage.** `jobs/leads.db` (SQLite via built-in `node:sqlite`, Node v24) is the
store of record. Schema is declared once in `scripts/lib/db.mjs` with
`CREATE TABLE IF NOT EXISTS` — **flat, never versioned, no migration chain**.
Tables:

| Table           | Notes                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| `leads`         | whole lead JSON in a `doc` column; only `status`/`company`/`title`/`posted_at` denormalized for indexing |
| `lead_keywords` | `(lead_id, keyword)`, 226 rows — tech terms per lead, extracted at ingest                                |
| `applications`  | source of truth; `profile/applications.yaml` is a **generated export**                                   |
| `screens`       | **built but unused — 0 rows**                                                                            |
| `board_stats`   | per-sweep board productivity                                                                             |

`scripts/maintenance/migrate.mjs` rebuilds the DB and is idempotent.
`--export <file>` takes a leads snapshot; `--leads-json <file>` restores one.
There is deliberately **no standing `jobs/leads.json`**.

**Script layout** (reorganized today — everything moved):

```
scripts/lib/          lib.mjs, db.mjs
scripts/leads/        find-jobs, screen, recommend, prep-queue,
                      board-yield, discover-boards, manage-sources
scripts/applications/ applications, log-application, update-application,
                      check-applied, follow-ups
scripts/documents/    new-job, render-pdf, verify-claims, reuse-check
scripts/apply/        answer-bank, fill-plan, field-cache, ats/
scripts/profile/      apply-profile, profile-gaps, save-answer
scripts/maintenance/  migrate, prune-jobs
scripts/hooks/        guard-bash, guard-files, prettify
scripts/status.mjs
tests/                mirrors scripts/ exactly, plus shared tests/fixtures/
```

Baseline: **270 tests pass**. `npm test` is `node --test` (recurses, so nested
test files are found automatically).

**`jobs/<slug>/` is currently empty** — the user deleted the 18 workspaces on
purpose, because a hundred folders made it impossible to see which application
was live. That is the motivation for work item 3.

---

## Work item 1 — cut reasoning out of the apply path

Five model touchpoints per application today, in
`.claude/skills/apply-job/SKILL.md`:

1. Phase 1.2 — read posting `innerText.slice(0, 6000)`, extract
   company/title/location/requirements
2. Phase 2.C — resolve `fill-plan` defers (`NEEDS-CHOICE` / `MAYBE` / `UNKNOWN`)
3. Phase 3 — tailor resume + cover letter (subagent) — **the dominant cost**
4. Phase 4 — compose the approval message
5. Phase 5.F — per extra page, repeat 2

Do these in order; 1.1–1.3 are independent and each is separately verifiable.

### 1.1 Build `job.json` from the lead store, not from a model read

`leads.db` already holds `company`, `title`, `location`, `url`, and
`description` (up to 4,000 chars) for every swept lead. Phase 1.2 has the model
re-read the live page to extract the same fields.

Add `--from-lead <url|id>` to `scripts/documents/new-job.mjs`: look the lead up
via `readLeadStore()` in `scripts/lib/db.mjs` and populate `job.json` directly.
Update the apply-job skill to prefer it and fall back to the page read only when
the URL matches no stored lead.

_Watch for:_ `description` is truncated at 4,000 chars and 29 of 99 leads have
none at all (the SuccessFactors fetcher returns no body). Fall back to the page
read when the description is missing, not merely short.

### 1.2 Persist model-resolved picks — the compounding win

`scripts/profile/save-answer.mjs` is only invoked for `UNKNOWN` questions the
**user** answers (SKILL.md line ~188). When the model picks an option for a
`NEEDS-CHOICE` or `MAYBE` field — a degree dropdown, a state abbreviation, a
long-form Yes/No — the pick is discarded. The same field on the same form costs
reasoning again on **every** future application.

Persist those picks so `answer-bank.mjs` resolves them as `OK` next time. The
defer list then converges toward zero as more applications are filed against the
same ATS. This is the only change that compounds.

_Design points:_

- Record provenance (model-derived vs user-stated) so a wrong pick is findable
  and reversible. `save-answer.mjs` currently takes `"<question>" "<answer>"
[--id]` — it needs a source field.
- Only persist picks that were **shown in the approval message** the user
  already sees. Saving what the user approved is not a new trust assumption;
  saving a silent guess would be.
- `profile/answers.yaml` is hook-protected. `save-answer.mjs` is the sanctioned
  writer — do not write the file any other way.

### 1.3 Make "no reasoning needed" machine-readable

`scripts/apply/fill-plan.mjs` already computes everything needed to decide:
`defer` count, whether rendered documents exist, which adapter matched. Have it
emit an explicit `ready=true|false` (plus a reason when false). The skill then
branches on a boolean instead of the model reading the plan and judging.

When `ready=true`: scan → fill → hand the user the submit button, with no model
judgment in between.

### 1.4 Batch questions across jobs, not within one

`profile/answers.yaml` is global — answering "Do you require sponsorship?" once
resolves it for every future application. Today the flow sends one approval
message per job. When `pipeline-jobs` has prepped N jobs, collect the unknowns
from all N into a single message.

### 1.5 Use the `screens` table (currently 0 rows)

Cache extracted requirements / years-required / stack per lead instead of
re-deriving them from the description for both screening and tailoring.

### 1.6 Cluster tailoring with `lead_keywords`

`scripts/documents/reuse-check.mjs` is per-job. `lead_keywords` now makes it
cheap to group postings by keyword overlap (e.g. Jaccard similarity) so one
tailored resume can serve a cluster. This is the only item that attacks
touchpoint 3, the expensive one. `scripts/leads/prep-queue.mjs` already moves
tailoring off the critical path — this reduces how often it must run at all.

**Honest limit:** tailoring itself is irreducibly model work. Everything above
reduces the _other_ four touchpoints and how often tailoring is needed.

---

## Work item 2 — parallelism

Already parallel: the board sweep runs pooled at concurrency 8
(`mapPool` in `scripts/lib/lib.mjs`) — **74.3s → 23.0s** across 41 boards.
`.claude/skills/pipeline-jobs/SKILL.md` fans out one `job-worker` subagent per
job in batches of ≤3.

Worth doing:

- **Raise the pipeline fan-out.** Tailoring N jobs is embarrassingly parallel —
  each subagent owns exactly one `jobs/<slug>/`. Batches of 3 look conservative;
  measure before raising, and keep one-subagent-per-slug as the invariant.
- **Parallelize the pre-tailor queue.** `prep-queue.mjs` picks targets; running
  the resulting tailoring jobs concurrently during the sweep means applying is
  fill-and-review rather than fill-and-wait.

Do **not** parallelize:

- **The apply flow itself.** One browser, and the user is on the submit button
  (CLAUDE.md rule 6). Two applications at once means two forms competing for one
  browser session.
- **Anything writing the same `jobs/<slug>/`.** One subagent per slug, always.

_SQLite note:_ WAL mode allows concurrent readers, but **writers serialize**.
Concurrent subagents each opening their own connection is fine; a long write
transaction while others wait is not. Keep writes short. If `SQLITE_BUSY`
appears under fan-out, set a busy timeout rather than serializing the work.

_Agent-usage note:_ the user does not want subagents spawned for ordinary work.
`pipeline-jobs` is the sanctioned exception because it is explicitly a batch
flow. Ask before fanning out anywhere new.

---

## Work item 3 — hybrid document storage

**Problem:** `jobs/` accumulated ~100 folders and it became impossible to see
which application was live. The user deleted them all. Pure-database storage was
rejected as too opaque; a frontend is explicitly out of scope.

**Design:** files while an application is active, database rows once it closes.

- **Active** — `jobs/<slug>/` exactly as today: `job.json`, `context.json`,
  `resume.md`, `cover-letter.md`, rendered PDFs. Editable, diffable, and what
  `verify-claims.mjs` and `render-pdf.mjs` already read. `ls jobs/` then shows
  only live work, normally one to three folders.
- **Closed** — when an application reaches `rejected`, `withdrawn`, or
  `no_response`, fold the workspace into a new `documents` table
  (`slug`, `kind`, `content`, `archived_at`, and the rendered PDF as a BLOB or a
  regenerate-on-demand flag), then remove the directory.
- **Restore** — a command that writes a slug back out to `jobs/<slug>/` for
  inspection or reuse.

This supersedes the PDF half of `scripts/maintenance/prune-jobs.mjs`: PDFs are
deterministic output of `render-pdf.mjs`, so archive the markdown and regenerate
a PDF only if one is needed again. Keep prune's `.render.html` cleanup.

_Constraints:_

- `verify-claims.mjs` must still be able to run against an archived document —
  restore to a temp dir, or teach it to read from the table.
- Archiving must be reversible and must never fire on an application that is
  merely `applied` (awaiting a reply) — only on a recorded closed outcome.
- Fold this into `.claude/skills/manage-applications/SKILL.md`, which already
  owns the application lifecycle.

---

## Verification

- `npm test` — **270 passing is the baseline; do not regress it.** New behaviour
  needs tests covering success _and_ failure/boundary cases (CLAUDE.md).
- **Work item 1:** measure tokens for one real application before and after.
  Report the number, not an adjective. For 1.2 specifically, run two
  applications against the same ATS and show the defer count dropping on the
  second.
- **Work item 2:** wall-clock for a pipeline run at the old and new fan-out.
- **Work item 3:** archive a closed application, confirm `jobs/` no longer shows
  it, restore it, and confirm the restored files are byte-identical.
- Smoke-run every CLI after any refactor — imports are the usual breakage.

---

## Traps that already bit this project

Each of these was a real bug found today. Assume the same class exists elsewhere.

1. **Tests writing to production paths.** `indexApplication` defaulted to the
   real `DB_PATH`, so every test run using `--file <tmp>` wrote fixtures into the
   live database (`acme-fullstack`, `widgetco-*` were found there). Any new
   helper with a production default has this bug. Consider making the test suite
   refuse real paths outright instead of relying on each test to pass an
   override.
2. **`ON CONFLICT` branches that skip the INSERT path.** `board_stats`'
   `last_qualifying_at` was only set in the update clause, so a board's _first_
   productive sweep recorded it as never having yielded. Test the insert path
   separately.
3. **Regex word boundaries around decimals.** `\b(\d{1,2})` matched the `5` in
   `"1.5+ years"` — a decimal point is a word boundary — turning an entry-level
   bar into a 5-year one and rejecting exactly the junior postings wanted. Fixed
   with a lookbehind in `scripts/leads/screen.mjs`.
4. **Hand-mapped columns lose fidelity.** A column-per-field lead schema failed
   its own round-trip check on 73 of 99 real leads: mapping cannot distinguish
   `flags: []` from no flags, or `notes: ""` from `null`. That is why leads and
   applications are stored as whole JSON documents with only indexed fields
   denormalized. **Use the same pattern for the `documents` table.**
5. **The prettier PostToolUse hook reformats after every edit.** If a subsequent
   `Edit` targets a region it rewrapped, `Read` the file first.
6. **`.claude/hooks/` is agent-write-protected** by
   `.claude/hooks/protect-profile.js` itself. `scripts/hooks/` is **not**,
   despite what older docs claimed. Editing anything under `.claude/hooks/`
   needs explicit user authorization.
7. **Always verify a migration before trusting it.** `migrate.mjs` asserts row
   counts and field-for-field round-trips and aborts on mismatch. Keep that
   discipline for the `documents` table.
