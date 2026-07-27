# Project: Agentic Job Application Pipeline

Tailors the user's resume and cover letter to specific job postings and (Milestone 2)
helps apply via Playwright MCP. The user is applying to **Full-Stack Developer roles only**.

## Commands

- Tests: `npm test` (node --test; run after every change)
- Verify a tailored doc: `node scripts/verify-claims.mjs <resume|cover-letter> <file> [--job jobs/<slug>/job.json]`
- New job workspace: `node scripts/new-job.mjs <slug> --company "X" --title "Y" [--url Z]`
- Save a user answer: `node scripts/save-answer.mjs "<question>" "<answer>"`
- Check application history: `node scripts/check-applied.mjs "<company, title, or slug>"`
- Log a submitted application: `node scripts/log-application.mjs <slug> --company "X" --title "Y"`
- Apply a reviewed profile update: `node scripts/apply-profile.mjs [--allow-edits] [--allow-removals]`
- Render PDF: `node scripts/render-pdf.mjs <input.md> <output.pdf> [--letter]`
- Find job leads: `node scripts/find-jobs.mjs search|import|list|mark ...`
  (filters through `docs/application-limits.yaml`, stores in `jobs/leads.json`)

## Hard rules (guardrails — never bend these)

1. **Truthfulness**: tailored documents may ONLY contain facts from
   `profile/profile.yaml` and `profile/answers.yaml`. Rephrasing and reordering
   are allowed; inventing skills, employers, dates, metrics, or tech is forbidden.
2. **The agent never edits the fact base** (`profile/`). A PreToolUse hook blocks
   it. New info goes through `scripts/save-answer.mjs` after asking the user in
   chat; submitted applications through `scripts/log-application.mjs` after the
   user confirms they applied.
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
  subagent per job)
- `docs/application-limits.yaml` — user-owned hard filters (location/freshness/
  roles/salary) every job must pass; `docs/job-sources.yaml` — user-editable
  board list for the sweep; `jobs/leads.json` — stored leads (gitignored)
- `docs/tailoring-rules.md` — shared rules both skills load
- `profile/` — fact base (gitignored; user-owned)
- `jobs/<slug>/` — per-job workspace: `job.json`, `context.json` (SHARED between
  both skills for consistency), `resume.md`, `cover-letter.md`, rendered PDFs
- `schemas/` — shape documentation for job.json / context.json
- `scripts/` — deterministic helpers (no LLM calls)
- `scripts/hooks/` — guardrail hooks wired in `.claude/settings.json`
  (guard-files, guard-bash, prettify); self-protected like `.claude/hooks/`
- `tests/` — includes guardrail failure-mode tests; keep them passing

## Workflow for any code change

1. Plan → implement → `npm test` → fix until green.
2. New features need tests covering success AND failure/boundary cases.
3. Do not commit unless the user asks.

## Gotchas

- Windows machine; PDF rendering shells out to local Edge/Chrome headless
  (`PDF_BROWSER` env var overrides the browser path).
- `profile/` and `jobs/` are gitignored on purpose (personal data). Tests use
  fixtures in `tests/fixtures/`, never the real profile.
- profile.yaml `meta.approved_by_user` must be `true` before tailoring for real
  applications; if false, warn the user first.
