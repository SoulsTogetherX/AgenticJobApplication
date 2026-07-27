---
name: check-applied
description: Check whether a specific job or company has already been applied to
  and how long ago, and record newly submitted applications. Use when the user
  asks "did I apply to X?", before tailoring or applying to any job, or right
  after the user confirms they submitted an application.
---

Application-history skill. The log lives in `profile/applications.yaml`
(user-editable; the agent writes it ONLY through `scripts/log-application.mjs`).

## Checking history

1. Run the check for both the company and (if known) the job slug:
   ```bash
   node scripts/check-applied.mjs "<company>"
   node scripts/check-applied.mjs "<job-slug>"
   ```
2. Interpret the JSON:
   - `job_already_applied: true` → this exact job was applied to. Report the
     `applied_at` date and `days_ago`, and do NOT proceed with a duplicate
     application unless the user explicitly says to.
   - Company `matches` → prior application(s) to this company. Tell the user
     what was applied to and how long ago (e.g. "you applied to their Backend
     role 12 days ago"); let them decide whether another application makes sense.
   - No matches → say so plainly and continue.

## Recording an application

Only after the user confirms an application was actually submitted:

```bash
node scripts/log-application.mjs <slug> --company "<Company>" --title "<Title>" [--url <posting url>] [--date YYYY-MM-DD]
```

- Date defaults to today; pass `--date` if the user says they applied earlier.
- Duplicate slugs are rejected — if the log disagrees with the user, show them
  the existing entry and let them edit `profile/applications.yaml` by hand.
- Never mark a job applied on your own judgment (e.g. because a tailored PDF
  was rendered) — submission is a user-confirmed fact.
