# `src/maintenance/` — keeping the store healthy

**Owner:** `implementer`.

Three commands, all of which move or delete data. Read what each one does not
touch before running it.

| Command          | What it does                                                                    |
| ---------------- | ------------------------------------------------------------------------------- |
| `migrate.mjs`    | Builds or tops up `jobs/leads.db` from on-disk sources.                         |
| `prune-jobs.mjs` | Retention for `jobs/<slug>/` — drops regenerable intermediates, with `--apply`. |
| `archive.mjs`    | Folds a closed workspace into the `documents` table and removes the directory.  |

## What `migrate.mjs` does and does not re-import

It re-imports **`leads`, `lead_keywords` and `applications`**. It never touches
`documents`, `auto_submissions` or `verifications`, and for `auto_queue` it can
only create the table or clear it (`--reset-queue`, refused while any click is
unaccounted for).

The consequence that catches people: **the `documents` table has no on-disk
source.** Backing it up means copying `leads.db` itself. The schema is flat —
no version table, no migration chain.

## What does not belong here

- Anything that decides what is **true** — that is the fact base's job and the
  user's.
- A destructive default. Every command here is dry-run first; `--apply` and
  `--confirm` are how a write is asked for.

Detail: [`../../docs/code/11-record-and-profile.md`](../../docs/code/11-record-and-profile.md),
[`../../docs/guide/06-data-model.md`](../../docs/guide/06-data-model.md).
