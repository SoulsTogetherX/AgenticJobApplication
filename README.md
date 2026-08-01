# Agentic Job Application

A Claude Code-driven pipeline that tailors a resume and cover letter to a specific
job posting — **using only pre-approved facts** — then verifies every claim
deterministically and renders ATS-friendly PDFs.

## Design principles

- **One job = one folder** (`jobs/<slug>/`) with its own captured posting, shared
  tailoring context, drafts, and rendered PDFs. No rolling conversation state.
- **Single source of truth**: `profile/profile.yaml` is the only place facts may
  come from. It is distilled from the owner's real resumes and cover letter and
  is user-approved. `profile/answers.yaml` grows over time as the agent asks the
  user questions it can't answer; the user can edit it freely.
- **Shared context**: both tailoring skills read/write `jobs/<slug>/context.json`
  so the resume and cover letter never contradict each other.
- **Truthfulness guardrails** (layered):
  1. Skills may only rephrase/reorder facts, never invent (see `docs/tailoring-rules.md`).
  2. Every resume bullet carries a `<!-- fact:ID -->` annotation tying it to a profile fact.
  3. `scripts/documents/verify-claims.mjs` deterministically fails any output
     containing numbers, dates, or tech keywords not present in the referenced
     facts / profile. This is the load-bearing control, not the sanitiser that
     runs earlier: a claim the fact base cannot back never survives verification,
     however it got proposed.
  4. A PreToolUse hook blocks the agent from editing the profile fact base directly.
- **Privacy**: `profile/` (except the example) and `jobs/` are gitignored — real
  personal data never leaves this machine via git.
- **Government and financial identifiers stay out of the answer bank.**
  `scripts/profile/save-answer.mjs` refuses (exit 4) to store an SSN, DOB,
  passport, driver's licence, bank or card number, because whatever is in that
  bank is what the pipeline types into other people's forms. There is no
  override: if a form genuinely needs one, the user types it in the browser.
  Ordinary application data — name, email, phone, address, salary, EEO answers —
  is unaffected; that is what the pipeline is for.

## Layout

```
.claude/skills/tailor-resume/       skill: tailor resume to a job
.claude/skills/tailor-cover-letter/ skill: tailor cover letter to a job
.claude/skills/check-applied/       skill: application history (already applied? how long ago?)
.claude/skills/update-profile/      skill: merge replaced/updated source docs into the profile (add-only)
.claude/skills/apply-job/           skill: apply in the browser via Playwright MCP (fills, then hands over)
.claude/hooks/protect-profile.js    hook: deny agent edits to the fact base
docs/tailoring-rules.md             shared rules both skills must follow
profile/profile.yaml                approved master fact profile (gitignored)
profile/answers.yaml                growing Q&A bank (gitignored, user-editable)
profile/applications.yaml           log of submitted applications (gitignored, user-editable)
profile/profile.example.yaml        sanitized template (committed)
jobs/<slug>/                        per-job workspace (gitignored)
schemas/                            JSON shape docs for job.json / context.json
scripts/                            deterministic helpers (no LLM)
tests/                              test suite incl. guardrail failure cases
                                    (`npm test` — a count-asserting gate, not a
                                     bare `node --test`)
templates/document.css              print stylesheet for PDF rendering
```

## Setup

```bash
npm install
npm test
```

PDF rendering uses a locally installed Edge or Chrome in headless mode
(no extra download). Override the browser with the `PDF_BROWSER` env var.

## Usage (inside Claude Code)

- `/tailor-resume <job>` — tailor the resume for a job posting
- `/tailor-cover-letter <job>` — tailor the cover letter (reuses the same context)
- `/check-applied <company>` — has this job/company been applied to, and when?
- `/update-profile` — after replacing/editing a PDF in `profile/source/`, merge new facts in
- `/apply-job <url>` — full browser application flow (requires the Playwright MCP
  server from `.mcp.json`, so start Claude Code in THIS folder and approve it)

The Playwright MCP server (`.mcp.json`) loads when a Claude Code session starts
in this folder; the apply-job skill fills applications with it. **This path fills
and hands over. It does not submit**, and it never logs in, creates an account,
or handles credentials.

Hard rule 6 (rewritten 2026-07-31, user decision) permits an unattended submit
in one narrowly-drawn case — a board that passes a **mechanical** trust gate,
with nothing on the form that required a judgement — and requires everything
else to defer **with a stated reason** the user can act on. Three things about
that rule matter more than the permission itself:

- **The thing that would submit does not exist.** `scripts/auto/` now holds the
  guardrails (`guard.mjs` — the filesystem boundary, the `jobs/.auto/STOP` kill
  switch, the read-only profile hash) and the audit record (`audit.mjs`). There
  is **no runner**: nothing in that directory opens a browser, and neither file
  contains a click. The trust gate and the tier classifier are also unwritten,
  and `docs/application-limits.yaml` has no `auto_apply` block at all. Guards
  existing is not the capability existing — `guard.mjs` says so about itself.
- **It would ship off.** `enabled: false, dry_run: true` in
  `docs/application-limits.yaml`'s `auto_apply` block, to be turned on by the
  user only after they have read a dry-run report they trust.
- **Trust would be mechanical, never a model's impression of a page.** A board
  would be trusted because it is a known ATS on an allowlist the user controls
  and the lead cleared every screening stage — never because the posting reads
  as legitimate. A page that looks trustworthy is the one worth worrying about.

Until that ships and the user enables it, the user is on the submit button for
every application — that is what the code does today, not a preference.
