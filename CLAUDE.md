# Project: Agentic Job Application Pipeline

Tailors the user's resume and cover letter to specific job postings and (Milestone 2)
helps apply via Playwright MCP. The user is applying to **Full-Stack Developer
roles, and (user decision 2026-07-27) Back-End roles as well** — the title
keywords in `docs/application-limits.yaml` are the authoritative list.

## Commands

- Tests: `npm test` (node --test; see the testing rule in Workflow below)
- Verify a tailored doc: `node scripts/documents/verify-claims.mjs <resume|cover-letter> <file> [--job jobs/<slug>/job.json]`
- New job workspace: `node scripts/documents/new-job.mjs <slug> --company "X" --title "Y" [--url Z]`
  — or, preferred when the posting is already a stored lead,
  `node scripts/documents/new-job.mjs <slug> --from-lead <url|lead-id>`, which
  fills company/title/location/description from `leads.db` instead of having a
  model re-read the page. Prints `description=<chars>|missing`; exits **4** when
  no lead matches, which is the caller's cue to read the page instead.
- Save an answer: `node scripts/profile/save-answer.mjs "<question>" "<answer>" [--source user|model] [--replace]`
  — `--source model` records a form pick the agent chose and the user approved
  (default is `user`). `--replace` corrects such a pick and **refuses** to
  overwrite anything the user stated themselves.
- Build a deterministic fill plan for a scanned application form (runs
  answer-bank internally, picks the ATS adapter, writes `jobs/<slug>/fill-plan.js`,
  prints the browser bootstrap): `node scripts/apply/fill-plan.mjs <slug>`
  — prints `ready=true|false` (plus `reason=` when false): whether any model
  judgment is still needed before filling. On `ready=true` the path is
  scan → fill → hand over, with no model step in between.
- Resolve scanned application-form fields against the fact base (batch):
  `node scripts/apply/answer-bank.mjs < jobs/<slug>/scan-p1.json` (fields come from
  `.claude/skills/apply-job/scan-page.js`; never invents an answer). An answer
  saved for a question's **exact** label outranks the label rules, so a pick the
  user approved once resolves `OK` on every later application to that ATS.
- Every question the fact base cannot answer, across ALL prepped jobs, in one
  list: `node scripts/apply/pending-questions.mjs [<slug> ...] [--no-predict]`
  — `answers.yaml` is global, so asking once resolves the same field on every
  future application. Merges the defers of scanned forms and predicts what an
  unscanned job's board will ask from the remembered form shape; consent boxes
  are never listed (those stay the user's to tick in the browser).
- Can an existing tailored resume be reused for a new posting?
  `node scripts/documents/reuse-check.mjs <slug>` (recommends only; user approves reuse)
- Check application history: `node scripts/applications/check-applied.mjs "<company, title, or slug>"`
- Log a submitted application: `node scripts/applications/log-application.mjs <slug> --company "X" --title "Y"`
- Read/write the application store (list, find, stats, remove, export):
  `node scripts/applications/applications.mjs <list|find|stats|remove|export>`
- Rebuild `jobs/leads.db` from the on-disk sources (flat + idempotent, safe to
  re-run): `node scripts/maintenance/migrate.mjs`
- Board productivity audit (which swept boards actually yield reachable roles):
  `node scripts/leads/board-yield.mjs [--json]`
- Find a company's public board from its NAME (the front half of discovery):
  `node scripts/leads/find-boards.mjs --file docs/candidates/<list>.yaml [--append]`
  — probes candidate slugs against the six no-auth ATS APIs and writes
  `docs/board-candidates.yaml`. Candidate lists live in `docs/candidates/`
  (`fortune500.yaml`, `yc.yaml` built from the public yc-oss directory,
  `local-lv.yaml`). **It cannot reach Workday/iCIMS/Taleo/Phenom boards** —
  those need an opaque tenant host that no slug guess produces, and that is what
  most large employers and nearly every local Las Vegas employer uses.
- Propose NEW boards, yield-gated (never edits job-sources.yaml itself):
  `node scripts/leads/discover-boards.mjs --candidates docs/board-candidates.yaml`
- Prune `.render.html` intermediates (dry run by default):
  `node scripts/maintenance/prune-jobs.mjs [--apply]`
- Archive/restore job workspaces (files while live, rows once closed):
  `node scripts/maintenance/archive.mjs list|show <slug>|archive <slug>|archive --closed|restore <slug> [--to <dir>]`
  — `archive --closed` only touches applications with a **recorded** closed
  outcome; `archive <slug>` is the manual path and refuses a still-live
  application without `--force`. Restore is byte-identical; PDFs are recorded
  as regenerable and rebuilt with `render-pdf.mjs`.
- Apply a reviewed profile update: `node scripts/profile/apply-profile.mjs [--allow-edits] [--allow-removals]`
- Render PDF: `node scripts/documents/render-pdf.mjs <input.md> <output.pdf> [--letter]`
- Find job leads: `node scripts/leads/find-jobs.mjs search|import|list|mark ...`
  (filters through `docs/application-limits.yaml`, stores in `jobs/leads.db`;
  `search` sweeps boards in parallel — `--concurrency N`, default 8)
  — ingest runs **two gates**: `passesLimits` on the cheap list fields
  (title/location/date), then `bodyDisqualifiers` on the posting text. Between
  them, postings that survived the first gate get their description fetched
  (`--no-enrich` skips it); only survivors are fetched, so it is single digits
  of round trips, not one per posting swept.
- Backfill descriptions onto stored leads whose board list endpoint carried none
  (dry run by default, idempotent): `node scripts/leads/enrich.mjs [--apply]`
  — re-indexes keywords for every lead it fills, since keywords derive from the
  description.
- Manage swept boards: `node scripts/leads/manage-sources.mjs add|remove|verify|list`
  (prescreens on add, refuses duplicates; edits `docs/job-sources.yaml`)
- Follow-ups due: `node scripts/applications/follow-ups.mjs [--days N] [--json]`
- Record an outcome/follow-up the user reported:
  `node scripts/applications/update-application.mjs <slug-or-company> [--status s] [--followed-up]`
- Profile-gap report: `node scripts/profile/profile-gaps.mjs [--json] [--min-demand N]`
- **Qualifications you have but never recorded**:
  `node scripts/profile/keyword-coverage.mjs [--min-demand N] [--include-dismissed] [--job <job.json>] [--json]`
  — splits demanded skills into `covered` / **`ask`** / `gap`. The `ask` bucket
  is the point: demanded, NOT in the fact base, but close to something you do
  have — either `adjacent` (a hand-checked lexicon edge: React ⇒ Redux,
  Docker+nginx ⇒ Linux) or the weaker `same-area`. It prints a ready-to-run
  `save-answer.mjs` line and **never writes** — rule 2. Until a skill is
  recorded, verify-claims R6 forbids any resume from mentioning it, so an
  unrecorded skill is an invisible one.
  — Demand is counted **twice**: `required` (parsed live from each description
  with the same required-vs-nice-to-have splitter L2 uses) and `total` (from
  `lead_keywords`). Ranking is by `required`, because "you cannot apply without
  this" and "it would be nice" are different facts. Dismissed leads are excluded
  by default.
- **Per-job resume keyword plan** (run BEFORE tailoring):
  `node scripts/documents/keyword-plan.mjs <slug> [--json]`
  — writes `jobs/<slug>/keywords.json`: `must_use` (in the posting AND backed by
  the fact base — placing these invents nothing), `placement`, `ats_forms`
  (acronym _and_ expansion, since systems index one or the other),
  `title_mirror`, `density_cap`, and `blocked` (what the posting wants that the
  facts cannot back, each with the `save-answer` line that would unlock it).
- **Will an ATS read the rendered resume?**
  `node scripts/documents/ats-lint.mjs <resume.md> [--pdf <f.pdf>] [--html <f.render.html>]`
  — checks the markdown and the intermediate `.render.html` (Chrome's exact
  input) for the hazards that are invisible on the page: CSS `::marker` bullets
  that emit no text, links whose URL exists only as a PDF annotation, tables,
  images, leaked fact annotations. Also confirms the PDF has a text layer at
  all. It does **not** decode the PDF text layer — Chrome subsets fonts with
  Identity-H encoding and reading that back needs a CMap parser.
- Rank leads against the profile: `node scripts/leads/recommend.mjs [--top N]`
- Which leads to tailor ahead of time (keeps tailoring off the apply path):
  `node scripts/leads/prep-queue.mjs [--top N] [--cluster] [--json]`
- Group near-duplicate postings so one tailored resume serves several:
  `node scripts/leads/cluster.mjs [--status new|all] [--threshold 0.6] [--json]`
  — 50/50 title and stack overlap over `lead_keywords`, the same weighting
  `reuse-check.mjs` uses. Members are compared against the cluster **leader**,
  never against each other, so a cluster cannot chain its way from full-stack to
  platform engineering one hop at a time. Recommends only; the user approves
  reusing a resume across a cluster.
- **Four-stage screening** — every lead runs an ordered pipeline, cheapest
  first, stopping at the first rejection, and the stored verdict records WHICH
  layer decided (so "why did I never see this job?" is answerable):

  | Stage      | Reads                 | Decides                                                       |
  | ---------- | --------------------- | ------------------------------------------------------------- |
  | `l0` title | board list payload    | title keywords, hard/soft filter, location, freshness, salary |
  | `l1` body  | the description       | hard disqualifiers stated in the text                         |
  | `l2` fit   | the description       | can this profile do this job? **rejects** below a threshold   |
  | `l3` risk  | description + history | scam, ghost, repost, evergreen                                |

  Stages live in `scripts/leads/stages.mjs`; `l2` is `fit.mjs`, `l3` is
  `risk.mjs`. Run one in isolation with `screen.mjs --stage l2`.
  - **l2 rejects** (user decision 2026-07-29). What makes that safe: a posting
    naming fewer than `fit.min_required_terms` technologies in its REQUIRED
    section is unevaluable and can never be rejected, technologies under "nice
    to have" never count against the profile, thresholds live in
    `docs/application-limits.yaml`, and every rejection is visible in
    `gate-audit.mjs`.
  - **l3 needs reposting history**, which `dedupeLeads` used to destroy: a
    re-posted job arrives with a new board id, matched an existing lead on
    company+title, and was silently dropped. It now returns those sightings and
    ingest records `repost_count` on the stored lead.

- **Gate audit — run after ANY gate change**: `node scripts/leads/gate-audit.mjs [--json] [--no-save]`
  — re-runs every stage over the whole store and diffs against the last run.
  Newly REJECTED leads are listed in full every time (a job you never see is the
  worst failure here); exits 1 when there are any. This is the mechanical form
  of the "re-run the gate over the live store and check the reject list did not
  grow" discipline the body-gate gotcha below demands.
- Mechanical ghost/scam screen: `node scripts/leads/screen.mjs [--status new] [--skip-screened] [--no-record] [--stage l0|l1|l2|l3|all]`
  — records its verdicts to the `screens` table as `source: mechanical`.
  `--skip-screened` leaves out leads that already carry a **model** verdict.
- Record a model screening verdict (the expensive judgment pass, so it is never
  paid for twice): `node scripts/leads/screen.mjs record <lead-id> --verdict pass|caution|reject [--reason "..."] [--signals a,b]`
- Whole-pipeline digest: `node scripts/status.mjs`
- All scripts print compact output to agents (non-TTY) and prose to humans;
  `--verbose` / `--quiet` override, `--json` where supported.

## Hard rules (guardrails — never bend these)

1. **Truthfulness**: tailored documents may ONLY contain facts from
   `profile/profile.yaml` and `profile/answers.yaml`. Rephrasing and reordering
   are allowed; inventing skills, employers, dates, metrics, or tech is forbidden.
2. **The agent never edits the fact base** (`profile/`). A PreToolUse hook blocks
   it. New info goes through `scripts/profile/save-answer.mjs` after asking the user in
   chat — including a form option the agent picked, which may only be saved
   (`--source model`) once the user has approved it in the approval message; a
   silent guess is never written. Submitted applications go through
   `scripts/applications/log-application.mjs` after the
   user confirms they applied. The application store moved to the
   `applications` table in `jobs/leads.db` (2026-07-29) and
   `profile/applications.yaml` is now a generated export — the rule is about
   **provenance, not the file**: an application is recorded only when the user
   says they submitted it, and an outcome only when they report it. Removing a
   record is possible (`scripts/applications/applications.mjs remove <slug> --confirm`) but
   only to correct a mistake, never to rewrite history.
3. **Every tailored resume bullet** carries `<!-- fact:ID -->` citing profile fact ids.
4. **verify-claims must pass** before any document is rendered or shown as final.
5. **User approval** before rendering final PDFs: show a summary of what was
   emphasized/dropped/rephrased vs. the general resume.
6. Never auto-submit an application; the user is always on the submit button.
7. **Git: `dev` branch only.** The agent never touches any other branch — no
   switching to, committing on, or pushing to `main`/`master` or anything else.
   Commit and push only to `dev` (`git checkout -b dev` if it doesn't exist).
   A PreToolUse hook (`scripts/hooks/guard-bash.mjs`) enforces this.
8. **Prettier on every edited document.** A PostToolUse hook
   (`scripts/hooks/prettify.mjs`) runs prettier on each file the agent
   edits/writes; do not fight its formatting.
9. **Filesystem boundary** (`scripts/hooks/guard-files.mjs`): never edit files
   outside this project directory (hook-enforced). Inside the project,
   interactive development work may create/remove files freely, but the
   job-application flows (find-jobs, pipeline-jobs, apply-job, and any subagent
   they spawn) may only write inside `jobs/<slug>/` and via the deterministic
   scripts — applying to jobs must not generate other content.
10. **Application limits**: every lead, tailoring job, and application must pass
    `docs/application-limits.yaml` — no roles requiring relocation away from
    North Las Vegas (remote or Las Vegas metro on-site OK, occasional travel
    OK), no stale postings. The user owns that file; ask before changing it.

## Structure

- `.claude/skills/` — skills: tailor-resume, tailor-cover-letter, check-applied,
  update-profile (merge new source docs into the profile), apply-job (Playwright
  MCP application flow; user always clicks Submit), find-jobs (search public
  sources, store leads), pipeline-jobs (batch screen/tailor/prep with one
  subagent per job), manage-sources (add/remove swept boards), follow-up
  (nudge cadence + outcome recording via update-application.mjs), profile-gaps
  (demand-vs-profile analysis; honest recommendations only),
  manage-applications (read/write the application store: list, find, stats,
  remove, export)
- `docs/application-limits.yaml` — user-owned hard filters (location/freshness/
  roles/salary) every job must pass; `docs/job-sources.yaml` — board list for
  the sweep (managed via manage-sources)
- `jobs/leads.db` — the SQLite store of record (gitignored): `leads`,
  `lead_keywords` (tech terms extracted at ingest from a lead's title,
  description AND requirements, for demand analysis — a lead with no description
  therefore indexes nothing, which is why `enrich.mjs` exists), `applications`,
  `documents` (archived workspaces — see below), `screens` (verdicts keyed by
  `source`: `mechanical` is cheap and kept for history, `model` is the
  expensive Stage A judgment and exists so it is never re-paid), `board_stats`.
  Schema is declared once in `scripts/lib/db.mjs` with
  `CREATE TABLE IF NOT EXISTS` — **flat, not versioned**; there is no migration
  chain. `profile/applications.yaml` is a generated export and the recovery
  input for applications; it is never authoritative once the database exists.
  There is **no standing `jobs/leads.json`** — a second copy of the leads went
  stale the moment a sweep ran, and leads are re-derivable by re-running the
  sweep (applications are not, which is why only they keep a durable export).
  Take a point-in-time leads snapshot on demand with
  `node scripts/maintenance/migrate.mjs --export <file>`, and restore one with
  `--leads-json <file>`.
- **Job workspaces are hybrid**: files while an application is live, rows in
  `documents` once it closes. `jobs/<slug>/` is what `verify-claims.mjs` and
  `render-pdf.mjs` read, so a listing of `jobs/` should show only live work
  (normally one to three folders). Closing an application folds the workspace
  into the table byte-for-byte and removes the directory; PDFs are recorded as
  regenerable rather than stored, because `render-pdf.mjs` is deterministic.
  Unlike every other table, `documents` has **no on-disk source** once the
  directory is gone — `migrate.mjs` never touches it, and backing it up means
  copying `jobs/leads.db`.
- `.env` — secrets (gitignored; Adzuna API keys); `.env.example` is the
  committed template. Never print `.env` contents into chat, docs, or commits.
- `docs/tailoring-rules.md` — shared rules both skills load
- `profile/` — fact base (gitignored; user-owned)
- `jobs/<slug>/` — per-job workspace: `job.json`, `context.json` (SHARED between
  both skills for consistency), `resume.md`, `cover-letter.md`, rendered PDFs
- `schemas/` — shape documentation for job.json / context.json
- `scripts/` — deterministic helpers (no LLM calls), grouped by domain:
  - `lib/` — shared infrastructure: `lib.mjs` (incl. the HTTP + HTML
    primitives `fetchJson`/`fetchText`/`textSnippet`/`decodeEntities`, which
    live here because both find-jobs and enrich fetch postings; find-jobs
    re-exports `textSnippet`/`SNIPPET_MAX` for its existing importers),
    `db.mjs`
  - `leads/` — find, filter, rank: find-jobs, enrich, screen, recommend,
    prep-queue, cluster, board-yield, discover-boards, manage-sources
  - `applications/` — the application record: applications, log-application,
    update-application, check-applied, follow-ups
  - `documents/` — tailored docs: new-job, render-pdf, verify-claims, reuse-check
  - `apply/` — browser form-filling: answer-bank, fill-plan, pending-questions,
    field-cache, `ats/`
  - `profile/` — fact-base tools: apply-profile, profile-gaps, save-answer
  - `maintenance/` — store lifecycle: migrate, prune-jobs, archive
  - `hooks/` — guardrail hooks wired in `.claude/settings.json` (guard-files,
    guard-bash, prettify). **Note:** these are NOT agent-protected —
    `.claude/hooks/protect-profile.js` only denies writes under
    `.claude/hooks/`, so the guard scripts here are editable by the agent.
  - `status.mjs` stays at the root: it is the one cross-cutting digest
- `tests/` — mirrors `scripts/` one-for-one (`tests/leads/`, `tests/apply/`, …)
  with shared `tests/fixtures/`. Includes guardrail failure-mode tests; keep
  them passing. `npm test` is `node --test`, which recurses, so nested test
  files are discovered automatically.

## Workflow for any code change

1. Plan → implement **completely** → test → fix until green.
2. **Test only when there is finished code that needs testing.** Tests cost
   tokens and wall-clock, so do not run them mid-implementation, after a
   comment/doc tweak, or "just to check". Finish the unit of work, then:
   run the single relevant test file while iterating
   (`node --test tests/<group>/<file>.test.mjs`), and `npm test` once before
   committing. Never re-run a suite that just passed on unchanged code.
3. New features need tests covering success AND failure/boundary cases.
4. Do not commit unless the user asks.

## Token discipline (applies to every session)

1. **Script first, model second.** If a deterministic script can answer it,
   run the script and reason only about its output. Never hand-read the lead
   store, re-rank leads, or re-derive status — `recommend.mjs`, `screen.mjs`,
   `status.mjs`, `follow-ups.mjs`, and `profile-gaps.mjs` already do it.
   The model is for: tailoring documents, judging a posting a script flagged,
   filling application forms, and talking to the user.
2. **Scripts are terse for agents automatically.** They detect a non-TTY
   stdout and print compact records; a human at a terminal gets prose. Never
   pass `--verbose` from a tool call.
3. **Targeted reads.** `Read` with `offset`/`limit` over the region you need;
   don't pull a whole file to see one function. Never re-read a file straight
   after writing it — the write already told you the content.
4. **Delegate breadth.** Codebase-wide searches and multi-file exploration go
   to a subagent (`Explore`), so the file dumps land in its context, not this
   one. Per-job work goes to the Sonnet-pinned `job-worker` agent.
5. **Model tiering.** Job searching, screening, applying, and recording
   outcomes do not need a frontier model — Sonnet is the default for that
   work (`job-worker` pins it). Reserve larger models for architecture and
   debugging.
6. **Context hygiene.** One task per session; suggest `/clear` when the user
   switches to an unrelated task (finished a feature, moving from building to
   applying), because every later turn re-reads the whole history. Long
   sessions are the single biggest cost driver.
7. **Batch tool calls** that don't depend on each other into one message.

## Gotchas

- Windows machine; PDF rendering shells out to local Edge/Chrome headless
  (`PDF_BROWSER` env var overrides the browser path).
- **Not every board's list endpoint returns a description.** Greenhouse, Ashby
  and Lever include one; `oracle_cloud`, `smartrecruiters`, `successfactors` and
  `workday` return none, and Adzuna returns a ~500-char teaser (already flagged
  `partial_description`). Those four need a per-posting detail fetch —
  `scripts/leads/enrich.mjs`, one fetcher per ATS, URLs derived from the lead's
  own `url`/`id` rather than from `job-sources.yaml`. This mattered more than the
  count suggests: those boards are Caesars, Station Casinos, Boyd, IGT and CVS,
  i.e. the **local Las Vegas employers**, which are the highest-value leads
  because on-site is in scope for them — so the least examinable leads were also
  the most important. A lead with no description can be neither keyword-indexed
  nor blocker-screened.
- **The body gate's "is this a software job?" test is easy to get wrong.**
  Job-posting prose is full of near-misses for software words: the first version
  matched bare `code` and read "Be familiar with OSHA safety **codes**" as
  evidence that a building-maintenance job was a software job. `application`
  (job application), `rest` (the rest of the team), `framework` (regulatory
  framework), `library` and `server` all fail the same way. `SOFTWARE_BODY` in
  `find-jobs.mjs` therefore only contains multi-word or unmistakable terms, and
  `NON_SOFTWARE_BODY` says "maintain cleanliness" not "cleanliness" (code
  cleanliness) and "beverage server" not "server". When adding a term, re-run the
  gate over the whole live store and check the reject list did not grow.
- The body gate **rejects only on unambiguous evidence and flags everything
  else**, because a false reject is a job the user never sees. Twilio's postings
  are the reason: one carries three contradictory location sentences pasted in
  sequence ("based in our San Francisco office" / "remote, based on the East
  Coast" / "not eligible to be hired in CA, CT, IL…"), so in-office language
  only ever produces an `onsite_conflict` flag. A state carve-out is decisive
  only when it names the user's own state.
- `profile/` and `jobs/` are gitignored on purpose (personal data). Tests use
  fixtures in `tests/fixtures/`, never the real profile.
- profile.yaml `meta.approved_by_user` must be `true` before tailoring for real
  applications; if false, warn the user first.
- Playwright MCP runs with a persistent browser profile
  (`--user-data-dir .playwright-mcp/profile` in `.mcp.json`) so ATS logins
  survive between sessions. It holds real session cookies — gitignored, never
  commit it. Changing `.mcp.json` needs a session restart to take effect.
- `openDb` sets `PRAGMA busy_timeout` **before** `journal_mode = WAL`, and the
  order is load-bearing: switching the journal mode takes a brief exclusive
  lock, so with the pragmas the other way round four processes opening the store
  at once have three die on the WAL statement itself — before the timeout they
  were about to set could apply. This is what makes the pipeline's subagent
  fan-out safe.
- The `SCHEMA` string in `scripts/lib/db.mjs` is a **template literal**, so a
  backtick anywhere in its SQL comments ends the string and the file stops
  parsing. Quote identifiers in those comments with plain words, not backticks.
- `.claude/skills/apply-job/scan-page.js` and `scan.driver.mjs` are eval'd as
  bare function expressions, not modules — they are in `.prettierignore`
  because prettier's leading-semicolon guard would make them unparseable.
  `scan-page.js` is the single source of truth; the driver loads it off disk.
- **`docs/job-sources.yaml` is also in `.prettierignore`**, for a different
  reason: `manage-sources.mjs` edits it LINE BY LINE to preserve its comments,
  which only works while every board is one flow-style entry on one line.
  Prettier reflows the longer workday/oracle_cloud entries into block style and
  silently breaks that contract.
- **`lead_keywords` goes stale the moment the lexicon changes.** It is indexed
  once at ingest, so a skill added to `keywords.mjs` afterwards has zero rows
  however often postings demand it. Re-index with
  `node scripts/maintenance/migrate.mjs` — it only ADDS leads that are missing
  and rebuilds keywords from what is already in the database, so it is safe on a
  live store (268 → 443 links after the lexicon was unified, 0 leads touched).
  Anything ranking on those counts should gate on `max(required, total)`, not
  `total`: `keyword-coverage.mjs` dropped System design at a required-demand of
  8 because the index predated the term.
- **One lexicon, two name fields, and they are not interchangeable.**
  `scripts/lib/keywords.mjs` is the single source for "what technology is named
  here?". Each skill carries `surface` (literal strings watched inside the
  USER'S OWN documents — drives verify-claims R6) and `aliases` (what the skill
  looks like in SOMEONE ELSE'S posting — drives `lead_keywords`). Folding
  `surface` into the detection regex was tried and matched "we **go** to
  production", "**Spring** 2027 internship", "a **bun** and coffee",
  "Section **S3** of the handbook" — six false positives in nine probes. A
  negative-corpus test (`tests/lib/keywords.test.mjs`) pins this down; add to it
  whenever you add an alias.
- **`answers.yaml` question text is NOT evidence.** It stores each application
  form question beside its answer, and forms ask things like "which of these do
  you have? [4 = Spring / Spring Boot; 5 = Cloud (AWS, Azure, or GCP)]". Using
  the raw file as the verifier corpus made **Azure, Spring, Java and GCP** all
  pass R6 — including Spring, which the user explicitly did not select. Use
  `evidenceText()` in `lib.mjs`: an answer always counts, a question only counts
  when the answer is an unambiguous yes.
- **`textSnippet` preserves block boundaries.** It used to collapse every run of
  whitespace including newlines, so a Greenhouse body arrived as one
  4,000-character line and the L2 fit stage found a requirements heading in 0 of
  92 stored leads. Block-level tags now become newlines; inline markup still
  collapses to a space. Section splitting in `fit.mjs` also matches headings
  INLINE, because leads stored before this change are still flat.
- **Slug probing can find the wrong company.** `find-boards.mjs` tries
  "spring" for "Spring Mobile" and "ultimate" for "Ultimate Fighting
  Championship"; a board with that slug may belong to someone else entirely.
  This is contained because `discover-boards.mjs` reports the company and live
  counts, and the user approves each addition — never auto-add.
