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
- **This pipeline never submits.** Rule 6 permits an unattended submit only on
  the Phase 3 auto path — a mechanical trust gate, nothing on the form needing a
  judgement — and there is no runner on that path yet: `scripts/auto/` holds
  guards and an audit record, nothing that opens a browser. Whatever ships
  there, **this skill is not it**. PDF rendering still requires the user's
  approval (rule 5), so the pipeline preps applications and the user finishes
  them.
- Default cap: 5 jobs per run (ask before exceeding). That cap is what bounds
  concurrency — fan the run out in ONE wave rather than waves of three. Each
  `job-worker` owns exactly one `jobs/<slug>/` and nothing else, and the lead
  store now opens every connection willing to wait on a busy writer, so a
  barrier between batches buys nothing but wall-clock.

## Pre-tailoring (run this ahead of time, not while the user waits)

Tailoring costs a subagent several minutes. Doing it at apply time puts that on
the critical path with the user watching a blank screen; doing it in advance
turns applying into fill-and-review. So when the user asks to pipeline, prep, or
"get things ready", pick the targets mechanically:

```bash
node scripts/leads/prep-queue.mjs --top 5 --cluster --json
```

It returns only leads that rank well, have not been applied to, and have **no
verified tailored resume yet** — so nothing is ever tailored twice. Each row
carries a `reason`:

| `reason`          | what the subagent does                                    |
| ----------------- | --------------------------------------------------------- |
| `no_workspace`    | `new-job.mjs` first, then Stage B                         |
| `no_resume`       | workspace exists; go straight to Stage B                  |
| `resume_<status>` | a draft exists but never passed verify-claims — finish it |

`--cluster` groups near-duplicate postings (`scripts/leads/cluster.mjs`) so four
React/Node full-stack roles cost ONE tailoring run, not four. Each queued row
lists what it `covers`; those siblings are not queued. Tailoring is the only
irreducibly expensive step in this pipeline, so this is the flag that matters —
report the covered postings, and let the user approve reusing the resume for
them (`reuse-check.mjs` scores the pairing per job).

Fan the whole queue out to `job-worker` (Stage B only) in one wave — one
subagent per slug, always. An empty queue means the top leads are already
prepped — say so and stop; do not re-tailor to look busy.

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

- **Ghost job**: live/reposted ≥ `ghost_signals.repost_age_days` — **read the
  value from `docs/application-limits.yaml`, do not assume one.** The user has
  set it to **30**; `screen.mjs`'s fallback of 45 applies only when the key is
  absent, and quoting 45 here is how a stricter user setting gets silently
  ignored. (The 45 comes from industry guidance that 45+ days unfilled is the
  strongest ghost signal; the user chose tighter.) Also: vague
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

**Ask the questions once, for the whole batch.** `profile/answers.yaml` is
global — "Do you require sponsorship?" answered once is answered for every
application that will ever be filed:

```bash
node scripts/apply/pending-questions.mjs
```

It merges what every prepped workspace still cannot answer, drops consent boxes
(the user ticks those in the browser) and anything the fact base already covers,
and predicts what these boards will ask from the remembered form shapes. Put the
whole list in ONE message, then save each answer with
`scripts/profile/save-answer.mjs`. Asking per job at apply time is N-1 avoidable
interruptions with the user waiting at a form.

Present one compact table: company | screen verdict | tailor status | next
step. Ask which prepped jobs to review; then run apply-job per approved job.
Mark statuses in the lead store as the user decides. Report total
skipped/failed honestly.
