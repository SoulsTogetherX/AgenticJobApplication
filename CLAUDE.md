# Project: Agentic Job Application Pipeline

Tailors the user's resume and cover letter to specific job postings and (Milestone 2)
helps apply via Playwright MCP. The user is applying to **Full-Stack Developer
roles, and (user decision 2026-07-27) Back-End roles as well** — the title
keywords in `docs/application-limits.yaml` are the authoritative list.

## Commands

- Tests: `npm test` (node --test; see the testing rule in Workflow below)
- Verify a tailored doc: `node scripts/documents/verify-claims.mjs <resume|cover-letter> <file> [--job jobs/<slug>/job.json]`
- New job workspace: `node scripts/documents/new-job.mjs <slug> --company "X" --title "Y" [--url Z]`
- Save a user answer: `node scripts/profile/save-answer.mjs "<question>" "<answer>"`
- Build a deterministic fill plan for a scanned application form (runs
  answer-bank internally, picks the ATS adapter, writes `jobs/<slug>/fill-plan.js`,
  prints the browser bootstrap): `node scripts/apply/fill-plan.mjs <slug>`
- Resolve scanned application-form fields against the fact base (batch):
  `node scripts/apply/answer-bank.mjs < jobs/<slug>/scan-p1.json` (fields come from
  `.claude/skills/apply-job/scan-page.js`; never invents an answer)
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
- Propose NEW boards, yield-gated (never edits job-sources.yaml itself):
  `node scripts/leads/discover-boards.mjs --candidates docs/board-candidates.yaml`
- Prune regenerable job-workspace files (dry run by default):
  `node scripts/maintenance/prune-jobs.mjs [--older-than 90] [--apply]`
- Apply a reviewed profile update: `node scripts/profile/apply-profile.mjs [--allow-edits] [--allow-removals]`
- Render PDF: `node scripts/documents/render-pdf.mjs <input.md> <output.pdf> [--letter]`
- Find job leads: `node scripts/leads/find-jobs.mjs search|import|list|mark ...`
  (filters through `docs/application-limits.yaml`, stores in `jobs/leads.db`;
  `search` sweeps boards in parallel — `--concurrency N`, default 8)
- Manage swept boards: `node scripts/leads/manage-sources.mjs add|remove|verify|list`
  (prescreens on add, refuses duplicates; edits `docs/job-sources.yaml`)
- Follow-ups due: `node scripts/applications/follow-ups.mjs [--days N] [--json]`
- Record an outcome/follow-up the user reported:
  `node scripts/applications/update-application.mjs <slug-or-company> [--status s] [--followed-up]`
- Profile-gap report: `node scripts/profile/profile-gaps.mjs [--json] [--min-demand N]`
- Rank leads against the profile: `node scripts/leads/recommend.mjs [--top N]`
- Which leads to tailor ahead of time (keeps tailoring off the apply path):
  `node scripts/leads/prep-queue.mjs [--top N] [--json]`
- Mechanical ghost/scam screen: `node scripts/leads/screen.mjs [--status new]`
- Whole-pipeline digest: `node scripts/status.mjs`
- All scripts print compact output to agents (non-TTY) and prose to humans;
  `--verbose` / `--quiet` override, `--json` where supported.

## Hard rules (guardrails — never bend these)

1. **Truthfulness**: tailored documents may ONLY contain facts from
   `profile/profile.yaml` and `profile/answers.yaml`. Rephrasing and reordering
   are allowed; inventing skills, employers, dates, metrics, or tech is forbidden.
2. **The agent never edits the fact base** (`profile/`). A PreToolUse hook blocks
   it. New info goes through `scripts/profile/save-answer.mjs` after asking the user in
   chat; submitted applications through `scripts/applications/log-application.mjs` after the
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
  `lead_keywords` (tech terms per lead, for demand analysis), `applications`,
  `screens`, `board_stats`. Schema is declared once in `scripts/lib/db.mjs` with
  `CREATE TABLE IF NOT EXISTS` — **flat, not versioned**; there is no migration
  chain. `jobs/leads.json` is the frozen bootstrap snapshot and
  `profile/applications.yaml` the generated export; both are recovery inputs
  for `migrate.mjs`, never authoritative once the database exists.
- `.env` — secrets (gitignored; Adzuna API keys); `.env.example` is the
  committed template. Never print `.env` contents into chat, docs, or commits.
- `docs/tailoring-rules.md` — shared rules both skills load
- `profile/` — fact base (gitignored; user-owned)
- `jobs/<slug>/` — per-job workspace: `job.json`, `context.json` (SHARED between
  both skills for consistency), `resume.md`, `cover-letter.md`, rendered PDFs
- `schemas/` — shape documentation for job.json / context.json
- `scripts/` — deterministic helpers (no LLM calls), grouped by domain:
  - `lib/` — shared infrastructure: `lib.mjs`, `db.mjs`
  - `leads/` — find, filter, rank: find-jobs, screen, recommend, prep-queue,
    board-yield, discover-boards, manage-sources
  - `applications/` — the application record: applications, log-application,
    update-application, check-applied, follow-ups
  - `documents/` — tailored docs: new-job, render-pdf, verify-claims, reuse-check
  - `apply/` — browser form-filling: answer-bank, fill-plan, field-cache, `ats/`
  - `profile/` — fact-base tools: apply-profile, profile-gaps, save-answer
  - `maintenance/` — store lifecycle: migrate, prune-jobs
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
- `profile/` and `jobs/` are gitignored on purpose (personal data). Tests use
  fixtures in `tests/fixtures/`, never the real profile.
- profile.yaml `meta.approved_by_user` must be `true` before tailoring for real
  applications; if false, warn the user first.
- Playwright MCP runs with a persistent browser profile
  (`--user-data-dir .playwright-mcp/profile` in `.mcp.json`) so ATS logins
  survive between sessions. It holds real session cookies — gitignored, never
  commit it. Changing `.mcp.json` needs a session restart to take effect.
- `.claude/skills/apply-job/scan-page.js` and `scan.driver.mjs` are eval'd as
  bare function expressions, not modules — they are in `.prettierignore`
  because prettier's leading-semicolon guard would make them unparseable.
  `scan-page.js` is the single source of truth; the driver loads it off disk.
