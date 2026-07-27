---
name: pipeline-jobs
description:
  Batch-process stored job leads with one subagent per job so the main
  context stays small - optionally screen each posting for ghost-job/scam/bad-
  workplace signals, tailor the resume and (optionally) cover letter, and prep
  the application for the user's review and final submit. Use when the user says
  to pipeline, batch-process, screen, or work through multiple saved leads.
---

Process several stored leads end-to-end without flooding the main context
window. Token discipline is the point: each job is handled by ONE subagent that
returns a compact verdict, never a transcript.

## Ground rules

- All CLAUDE.md hard rules apply inside every subagent (truthfulness, fact-base
  protection, verify-claims, limits, dev-branch git, no submit).
- The user is ALWAYS the one who clicks Submit (rule 6), and PDF rendering
  still requires their approval (rule 5) — so the pipeline preps applications;
  it never finishes them alone.
- Default cap: 5 jobs per run (ask before exceeding). Run subagents in
  parallel batches of no more than 3.

## Input

Ask which leads to process if not specified; default is
`node scripts/find-jobs.mjs list --status recommended` (falling back to
`new`). Confirm with the user which stages to run: screen only, screen+tailor,
or screen+tailor+apply, and whether a cover letter is wanted.

## Per-job subagent contract

Spawn one `general-purpose` agent per lead (Agent tool). Give it: the lead
JSON, the requested stages, and this contract. It must return ONLY:

```json
{
  "slug": "<workspace slug or null>",
  "screen": {
    "verdict": "pass|caution|reject",
    "signals": ["short strings"],
    "summary": "<= 50 words"
  },
  "tailor": {
    "resume": "done|skipped|failed",
    "cover_letter": "done|skipped|failed",
    "verify_claims": "pass|fail"
  },
  "next_step": "<= 30 words for the user"
}
```

No posting text, no document contents, no browsing logs in the reply.

### Stage A — screen (optional)

WebFetch the posting (Playwright only if JS-required). Check:

- **Ghost job**: posted/reposted for months (compare `posted_at`, look for
  "reposted" or old dates in page), vague responsibilities, no team or product
  specifics, hiring freeze news for the company, evergreen "always hiring"
  phrasing.
- **Scam**: pay-to-apply, requests for financial/identity info up front,
  free-mail contact addresses, salary far above market for vague work,
  interview via chat app only, urgency pressure, typo-ridden copy, company has
  no verifiable web presence.
- **Bad workplace**: "fast-paced" + "wear many hats" + "like a family"
  clustering, 24/7 on-call expectations, WebSearch for recent review/news red
  flags (layoff churn, lawsuits, Glassdoor headlines from search snippets —
  do not scrape review sites directly).
- **Limits recheck**: description demands relocation/hybrid outside the Las
  Vegas metro (docs/application-limits.yaml) even if the location field looked
  fine → reject with reason.

`reject` → subagent runs `node scripts/find-jobs.mjs mark <id> --status
dismissed --notes "<reason>"` and stops.

### Stage B — tailor (optional)

Workspace via `node scripts/new-job.mjs`, fill `job.json` from the captured
posting, then follow `docs/tailoring-rules.md` + the tailor-resume /
tailor-cover-letter skill rules: draft `resume.md` (and `cover-letter.md` if
requested) with `<!-- fact:ID -->` annotations, run
`node scripts/verify-claims.mjs` until it passes. Do NOT render PDFs — that
needs the user's approval in the main session.

### Stage C — apply prep

Only when the user asked for the apply stage: the subagent stops after
tailoring; actual form-filling happens back in the main session one job at a
time via the apply-job skill, with the user watching the browser and clicking
Submit. Never let a subagent drive the application form unattended.

## Wrap-up (main session)

Present one compact table: company | screen verdict | tailor status | next
step. Ask which prepped jobs to review; then run apply-job per approved job.
Mark statuses in the lead store as the user decides. Report total
skipped/failed honestly.
