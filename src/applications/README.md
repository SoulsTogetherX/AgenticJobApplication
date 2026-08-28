# `src/applications/` — the record

**Owner:** `implementer`.

What was applied to, what happened, and who is due a nudge. Small directory,
strict rule: **an application is recorded only when the user says they submitted
it, and an outcome only when they report it.** That is hard rule 2, and it is
about provenance rather than about a file.

## Entry points

| Command                  | What it does                                                     |
| ------------------------ | ---------------------------------------------------------------- |
| `log-application.mjs`    | Records a submitted application. The only sanctioned writer.     |
| `update-application.mjs` | Records what happened to one — the only sanctioned outcome path. |
| `applications.mjs`       | Read and correct the store; `remove <slug> --confirm`, `export`. |
| `check-applied.mjs`      | Have I already applied to this slug or company?                  |
| `follow-ups.mjs`         | What is due a nudge, by age and stage.                           |

## Store of record versus export

`jobs/leads.db`'s `applications` table is the **store of record** (since
2026-07-29). `profile/applications.yaml` is a **generated export** — the recovery
input, not the record. Read the table; regenerate the YAML.

`applications.mjs remove <slug> --confirm` corrects a mistake. It never rewrites
history, and it is the sanctioned path when
`node src/dev/audit-submissions.mjs` shows a recorded submission that never went
out.

## What does not belong here

- Anything that decides an application **happened**. Only the user's statement
  does that. A classifier reading a page as a confirmation is evidence for a
  human, not a write.
- Follow-up text generation. This directory says who is due; the model writes.

Detail: [`../../docs/code/11-record-and-profile.md`](../../docs/code/11-record-and-profile.md).
