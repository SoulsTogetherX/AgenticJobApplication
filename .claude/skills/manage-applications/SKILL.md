---
name: manage-applications
description:
  Read and write the application store - list or search what has been applied
  to, record a newly submitted application, update an outcome, remove a wrong
  entry, and regenerate the YAML export. Use when the user asks what they have
  applied to, how many applications they have sent, to fix or delete an
  application record, or right after they confirm they submitted one.
---

Own the application record end to end. The store is a SQLite table, not a
file the user maintains by hand.

## Where the data lives

`applications` table in `jobs/leads.db` is the **source of truth**.
`profile/applications.yaml` is a **generated export** — rewritten after every
change, never read back except to bootstrap an empty database. Do not edit it;
edits there are overwritten on the next write.

Storage moved on 2026-07-29 (user decision: nobody hand-edits the log, so a
file pretending to be authoritative only created a sync problem).

## The guardrail did not move

CLAUDE.md rule 2 still holds, and it is about _provenance_, not about a file:

- An application is recorded **only after the user says they submitted it**.
  Never infer it from a tailored resume, an open tab, or a filled form.
- Outcomes (`rejected`, `interviewing`, `offer`, ...) are recorded **only from
  what the user reported**. Never guess from silence.
- `remove` exists to correct a mistaken entry. It is not a way to quietly
  rewrite history — say what is being removed and why, and get a clear yes.

## Reading

```bash
node scripts/applications.mjs list [--status <s>] [--company "X"] [--json]
node scripts/applications.mjs find "<company|title|slug>" [--json]
node scripts/applications.mjs stats [--json]
```

`find` is the fast answer to "did I apply to X?" — it matches slug, company and
title. For the richer duplicate check that also reasons about how long ago and
about near-miss company names, `scripts/check-applied.mjs` is still the right
tool and the check-applied skill still owns that flow.

## Writing

Creating and updating keep their own scripts — they carry the confirmation
rules above:

```bash
node scripts/log-application.mjs <slug> --company "X" --title "Y" \
  [--url <url>] [--date YYYY-MM-DD] [--notes "..."]
node scripts/update-application.mjs <slug-or-company> --status <status> [--followed-up]
```

Statuses: `applied`, `followed_up`, `interviewing`, `offer`, `rejected`,
`withdrawn`.

Removing and re-exporting:

```bash
node scripts/applications.mjs remove <slug>            # dry run: prints what would go
node scripts/applications.mjs remove <slug> --confirm  # actually deletes
node scripts/applications.mjs export                   # rewrite the YAML export
```

`remove` without `--confirm` prints the entry and exits non-zero. Show that
output to the user before passing `--confirm`.

## Maintenance

- `node scripts/migrate.mjs` rebuilds `jobs/leads.db` from the on-disk sources.
  It is flat and idempotent — safe to re-run. It imports applications **only**
  when the table is empty, so it can never undo recorded outcomes.
- If `jobs/leads.db` is lost, the YAML export is the recovery path: migrate
  bootstraps the table straight back from it.

## Token discipline

All of these are deterministic scripts. Run the script and reason about its
output — never read `profile/applications.yaml` or the database by hand to
answer a question one of these commands already answers. Pass `--json` only
when the structure is actually needed; the default output is already compact
for agents.
