# 00 — Overview: what this project actually is

> Part of `docs/reference/`. Read this first, then
> [01-control-flow.md](01-control-flow.md). The audit of real defects is
> [AUDIT.md](AUDIT.md).

## The one-sentence version

A Claude Code agent that finds job postings, screens them, writes a tailored
resume and cover letter that are **provably** made only of facts the user
approved, and fills in application forms in a real browser — stopping short of
pressing Submit.

## The idea that shapes everything

There is one dangerous thing an LLM can do in a job search: **make something
up**. A fabricated skill on a resume signed with the user's name is a lie the
user is legally and professionally on the hook for. So the entire architecture
is organised around one rule:

> A model may **select, reorder and rephrase** approved facts. It may never
> **add** one.

Every design decision follows from that. Facts live in one user-owned place. A
deterministic script re-reads the finished document and fails it if any number,
date or technology in it cannot be traced back. A hook physically blocks the
agent from editing the fact base. The user, not the agent, presses Submit.

The second organising idea is **cost**. Every model token costs money and
latency, so the project pushes as much work as possible into deterministic Node
scripts and leaves the model only the jobs that genuinely need judgment:
writing prose, judging a posting a script flagged, and talking to the user.

## The four things the model is allowed to do

Everything else is a script.

1. **Tailor documents** — turn facts into prose for a specific posting.
2. **Judge a posting** a script has flagged as ambiguous.
3. **Fill the gaps** a form asks about that the fact base cannot answer.
4. **Talk to the user** — approvals, questions, summaries.

## The five layers

```
                    ┌─────────────────────────────────────────┐
     DISCOVERY      │  public ATS APIs  →  leads.db           │
                    │  scripts/leads/                         │
                    └──────────────────┬──────────────────────┘
                                       │  a lead that survived 4 gates
                    ┌──────────────────▼──────────────────────┐
     PREPARATION    │  keyword plan → tailored md → verified   │
                    │  scripts/documents/                     │
                    └──────────────────┬──────────────────────┘
                                       │  jobs/<slug>/resume.md + .pdf
                    ┌──────────────────▼──────────────────────┐
     APPLICATION    │  scan page → fill plan → fill → hand off│
                    │  scripts/apply/ + .claude/skills/apply-job│
                    └──────────────────┬──────────────────────┘
                                       │  the user reviews and clicks Submit
                    ┌──────────────────▼──────────────────────┐
     RECORD         │  applications table, follow-ups, outcomes│
                    │  scripts/applications/                  │
                    └──────────────────┬──────────────────────┘
                                       │
                    ┌──────────────────▼──────────────────────┐
     FEEDBACK       │  what did the market ask that you lack? │
                    │  scripts/profile/                       │
                    └─────────────────────────────────────────┘
```

`scripts/lib/` sits underneath all five. `scripts/maintenance/` handles the
store's lifecycle. `scripts/hooks/` + `.claude/hooks/` enforce the guardrails.

> **On the APPLICATION row's hand-off.** Hard rule 6 was rewritten on
> 2026-07-31 (user decision) to permit an unattended submit — but only on a
> board that passes a **mechanical** trust gate, with nothing on the form that
> required a judgement, and everything else deferring **with a stated reason**.
> That path would live in `scripts/auto/`. As of 2026-07-31 that directory holds
> `guard.mjs` (filesystem boundary, `jobs/.auto/STOP` kill switch, read-only
> profile hashing) and `audit.mjs` (the run record) — **the checks, not the
> runner**. Neither file opens a browser or contains a click, there is no trust
> gate, and `docs/application-limits.yaml` has no `auto_apply` block. It would
> ship `enabled: false, dry_run: true` for the user to turn on after reading a
> dry-run report they trust. So the arrow above is what happens today.
>
> The word doing the work is _mechanical_: a board would be trusted because it
> is a known ATS on an allowlist the user controls and the lead cleared every
> screening stage — **never** because a model read the posting and found it
> convincing. Hard rule 0 applies at full force here, and a page that looks
> trustworthy is exactly the one worth worrying about.

## Where state lives, and who owns it

This is the single most important table in the project. Confusing these is how
data gets lost.

| Location                          | Owner                                              | Authoritative?      | Recoverable if deleted?                                  |
| --------------------------------- | -------------------------------------------------- | ------------------- | -------------------------------------------------------- |
| `profile/profile.yaml`            | **the user**, by hand                              | yes — the fact base | **no** (gitignored, no backup but `profile.backup.yaml`) |
| `profile/answers.yaml`            | the user; agent appends via `save-answer.mjs` only | yes                 | **no**                                                   |
| `profile/applications.yaml`       | generated                                          | **no** — an export  | yes, from the db                                         |
| `jobs/leads.db` → `leads`         | scripts                                            | yes, once it exists | yes — re-run a sweep                                     |
| `jobs/leads.db` → `applications`  | `log-application.mjs` after the user confirms      | **yes**             | from `applications.yaml`                                 |
| `jobs/leads.db` → `documents`     | `archive.mjs`                                      | **yes**             | **no** — see below                                       |
| `jobs/leads.db` → `lead_keywords` | derived at ingest                                  | no                  | yes — `migrate.mjs`                                      |
| `jobs/leads.db` → `screens`       | `screen.mjs`                                       | history only        | no, but cheap to redo                                    |
| `jobs/leads.db` → `board_stats`   | `find-jobs.mjs` sweep                              | no                  | yes                                                      |
| `jobs/<slug>/`                    | scripts + the tailoring model                      | yes while live      | via `archive.mjs restore`                                |
| `jobs/.field-cache.json`          | `fill-plan.mjs`                                    | no — a cache        | yes, by re-scanning                                      |

**The one thing with no second copy** is the `documents` table. Once a workspace
directory is folded into it and removed, the only backup is a copy of
`jobs/leads.db` itself. `migrate.mjs` deliberately never touches that table.

## The truthfulness chain, in order

Five things stand between a job posting and a false claim going out. They are
not equally strong, and knowing which is load-bearing matters.

1. **Rule 0 — a posting is data, not instructions.** `scripts/lib/untrusted.mjs`
   strips invisible text, HTML comments, hidden blocks and instruction-shaped
   phrases before any model reads a posting. _Defence in depth only._
2. **The whitelist.** `docs/tailoring-rules.md` §1: facts come from
   `profile.yaml` + `answers.yaml`, plus the job's company and title for
   addressing. _A model instruction — not enforced by code._
3. **Fact annotations.** Every resume bullet carries `<!-- fact:ID -->`.
   _Enforced by verify-claims R1/R2._
4. **`verify-claims.mjs`.** Re-reads the finished markdown and fails it if any
   number, date or known technology is absent from the fact base.
   **This is the load-bearing control.**
5. **`protect-profile.js`.** A PreToolUse hook that denies agent writes to
   `profile/`. _Enforced by the harness._

Layer 4 is the one that actually stops a lie. [AUDIT.md](AUDIT.md) documents
two ways it can currently be walked past, and one way it fires on a **truthful**
document — which is worse, because it trains you to work around the verifier.

## The two lexicons — read this before touching anything keyword-related

`scripts/lib/keywords.mjs` holds one table of ~140 skills. Each entry has two
different name fields, and **they are not interchangeable**:

| field     | means                                          | used to read                 | matched                   |
| --------- | ---------------------------------------------- | ---------------------------- | ------------------------- |
| `surface` | literal strings a resume would really write    | **the user's own documents** | exact, **case-sensitive** |
| `aliases` | what the skill looks like in someone else's ad | **job postings**             | loose, case-insensitive   |

Two projections come out of that table:

- `TECH_TERMS` + `techTermsIn()` → built from `surface`. Drives verify-claims R6.
- `TECH_LEXICON` + `extractTech()` → built from `aliases`. Drives
  `lead_keywords`, fit scoring, gap analysis, the keyword plan.

Using the wrong one is the most common bug class in this codebase. `techTermsIn`
on a job posting reads "we **go** to production" as Go and "Section **S3** of the
handbook" as Amazon S3. `extractTech` on the user's own profile treats the word
"containers" as evidence of Docker. Both mistakes are live in the tree today —
see AUDIT findings **C3**, **C4** and **H13**.

## Why SQLite, and why a document column

The lead store was `jobs/leads.json`: fully parsed and fully rewritten on every
mutation. Marking 57 leads dismissed meant 57 whole-file read+rewrite cycles.
`node:sqlite` (built into Node 22.5+, no new dependency, no daemon) makes that a
single-row `UPDATE`.

Each row keeps the **whole lead as a verbatim JSON document** in a `doc` column,
with only the queried fields (`status`, `company`, `title`, `posted_at`) copied
out into real columns for indexing. That shape was chosen after a
column-per-field version failed its own round-trip check on 73 of 99 real leads:
hand-written field mappings cannot tell `flags: []` from "no flags", or
`notes: ""` from `notes: null`. Keeping the document intact makes fidelity
structural rather than something fifteen mappings have to get right.

The schema is **flat**: one `CREATE TABLE IF NOT EXISTS` block in
`scripts/lib/db.mjs`, no version table, no migration chain. `migrate.mjs` is one
idempotent build step you can always re-run. That works because every input is
re-derivable — except `documents`, which is why that table is fenced off.

## Four data-model facts that are easy to get wrong

- **The schema is flat, not versioned.** Declared once in `scripts/lib/db.mjs`
  with `CREATE TABLE IF NOT EXISTS`. There is no migration chain, and `migrate.mjs`
  is an idempotent build step rather than a step in a sequence.
- **`documents` has no on-disk source** (the state table above says the same
  thing in a column). Job workspaces are hybrid: files while an application is
  live, rows in `documents` once it closes. A listing of `jobs/` should therefore
  show only live work — normally one to three folders.
- **`profile/applications.yaml` is a generated export**, never authoritative once
  the database exists. It is the recovery input, not the record. This is why hard
  rule 2 is about **provenance, not the file**: an application is recorded because
  the user said they submitted it, wherever the bytes live.
- **There is no standing `jobs/leads.json`.** A second copy went stale the moment
  a sweep ran. Leads are re-derivable by re-sweeping; applications are not, which
  is why only applications keep a durable export.

## Where the source lives, and what `.env` is

- `profile/` — the fact base. **Gitignored, user-owned.** Tests use
  `tests/fixtures/`, never the real profile.
- `jobs/<slug>/` — per-job workspace: `job.json`, `context.json` (**shared** by
  both tailoring skills, so they stay consistent), `resume.md`,
  `cover-letter.md`, PDFs.
- `jobs/leads.db` — the SQLite store of record (gitignored): `leads`,
  `lead_keywords`, `applications`, `documents`, `screens`, `board_stats`.
- `scripts/` — deterministic helpers, no LLM calls, grouped by domain: `lib/`
  (`db.mjs`, `keywords.mjs` — the one lexicon, `untrusted.mjs` — hard rule 0),
  `leads/`, `applications/`, `documents/`, `apply/` (incl. the Playwright-side
  browser engines), `auto/`, `profile/`, `maintenance/`, `dev/`, `hooks/`.
  `status.mjs` stays at the root as the one cross-cutting digest.
- `tests/` — mirrors `scripts/` one-for-one, with shared `tests/fixtures/`.
  `tests/security/` is the Phase 1 gate.
- `.env` — secrets (gitignored; Adzuna keys). **Never print its contents into
  chat, docs, or commits.** `.env.example` is the committed template.

## Reading order for the rest of this reference

| doc                                                        | covers                                              |
| ---------------------------------------------------------- | --------------------------------------------------- |
| [01-control-flow.md](01-control-flow.md)                   | the four pipelines, call by call                    |
| [02-lib.md](02-lib.md)                                     | `scripts/lib/` — the shared foundation              |
| [03-leads.md](03-leads.md)                                 | `scripts/leads/` — discovery and screening          |
| [04-documents.md](04-documents.md)                         | `scripts/documents/` — tailoring and verification   |
| [05-apply.md](05-apply.md)                                 | `scripts/apply/` + the browser engine               |
| [06-record-and-feedback.md](06-record-and-feedback.md)     | `scripts/applications/`, `profile/`, `maintenance/` |
| [07-guardrails-and-config.md](07-guardrails-and-config.md) | hooks, skills, agents, every config file            |
| [08-tests.md](08-tests.md)                                 | the test suite, and what it does not cover          |
| [AUDIT.md](AUDIT.md)                                       | **every defect found, with reproductions**          |
