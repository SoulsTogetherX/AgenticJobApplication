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

## Pre-tailoring (run this ahead of time, not while the user waits)

Tailoring costs a subagent several minutes. Doing it at apply time puts that on
the critical path with the user watching a blank screen; doing it in advance
turns applying into fill-and-review. So when the user asks to pipeline, prep, or
"get things ready", pick the targets mechanically:

```bash
node scripts/leads/prep-queue.mjs --top 5 --json
```

It returns only leads that rank well, have not been applied to, and have **no
verified tailored resume yet** — so nothing is ever tailored twice. Each row
carries a `reason`:

| `reason`          | what the subagent does                                    |
| ----------------- | --------------------------------------------------------- |
| `no_workspace`    | `new-job.mjs` first, then Stage B                         |
| `no_resume`       | workspace exists; go straight to Stage B                  |
| `resume_<status>` | a draft exists but never passed verify-claims — finish it |

Fan these out to `job-worker` (Stage B only) in batches of no more than 3. An
empty queue means the top leads are already prepped — say so and stop; do not
re-tailor to look busy.

## Input

Ask which leads to process if not specified; default is
`node scripts/leads/find-jobs.mjs list --status recommended` (falling back to
`new`). Confirm with the user which stages to run: screen only, screen+tailor,
or screen+tailor+apply.

**Cover letters are automatic, not asked about.** Per job, the subagent
inspects the application form (or posting) and tailors a cover letter ONLY if
the job requests one, or the form has a cover-letter field, or it accepts
attachments beyond the resume. Otherwise the CL is skipped and reported as
`"skipped (no slot)"`. The user never has to decide this per job.

## Per-job subagent contract

Spawn one **`job-worker`** agent per lead (Agent tool,
`subagent_type: "job-worker"`). It is pinned to Sonnet — this work does not
need a larger model, and per-job cost is the whole point of the pipeline.
Give it: the lead JSON, the requested stages, and this contract. It returns
ONLY:

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

**Run the mechanical pass first — it is free (~125 ms for the whole store):**

```bash
node scripts/leads/screen.mjs --status new --skip-screened
```

It flags scam wording, stale/repost age, culture-red-flag clusters, thin
descriptions, and unresolved location/salary from stored data. Anything it
marks `reject` needs no model time at all.

`--skip-screened` drops leads you have **already judged** in a previous run.
Your Stage A verdict is the expensive part of this whole flow — it fetches the
live posting — and it is cached in the `screens` table, so paying for it twice
on the same lead is pure waste. The output reports `model-screened=<n>` either
way. Re-judge a lead only if the posting has changed.

Only for `caution`/`pass` rows, WebFetch the posting (Playwright only if
JS-required) and judge:

- **Ghost job**: live/reposted ≥ `ghost_signals.repost_age_days` (45; industry
  guidance says 45+ days unfilled is the strongest ghost signal), vague
  responsibilities, no team or product specifics, no salary range, hiring
  freeze news for the company, evergreen "always hiring" phrasing.
  **Cross-reference**: if the lead came from an aggregator (HN, LinkedIn
  paste), confirm the job still exists on the company's own careers page —
  a posting missing there is likely filled or pulled.
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

**Write the verdict down — every time, whatever it is.** This is what makes
`--skip-screened` work on the next run:

```bash
node scripts/leads/screen.mjs record <lead-id> --verdict pass|caution|reject \
  --reason "<why, one line>" --signals "evergreen,no_salary"
```

`reject` → the subagent ALSO runs `node scripts/leads/find-jobs.mjs mark <id>
--status dismissed --notes "<reason>"` and stops. Recording the verdict and
dismissing the lead are separate: the verdict says what was judged and why, the
status says what to do about it.

### Stage B — tailor (optional)

Workspace via `node scripts/documents/new-job.mjs`, fill `job.json` from the captured
posting, then follow `docs/tailoring-rules.md` + the tailor-resume /
tailor-cover-letter skill rules: draft `resume.md` (and `cover-letter.md` per
the automatic cover-letter rule above) with `<!-- fact:ID -->` annotations,
run `node scripts/documents/verify-claims.mjs` until it passes. Do NOT render PDFs —
that needs the user's approval in the main session. Subagents write ONLY
inside `jobs/<slug>/` (CLAUDE.md rule 9).

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
