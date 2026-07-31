# 06 — Record, feedback, maintenance

`scripts/applications/`, `scripts/profile/`, `scripts/maintenance/`, and
`scripts/status.mjs`.

---

## `scripts/applications/` — the application record

**The guardrail here is about provenance, not files.** An application is recorded
only when the user says they submitted it, and an outcome only when they report it.
The storage moved to the `applications` table on 2026-07-29;
`profile/applications.yaml` became a generated export. The rule did not change.

### `log-application.mjs` (79 lines)

```bash
node scripts/applications/log-application.mjs <slug> --company "X" --title "Y"
     [--url U] [--date YYYY-MM-DD] [--notes N] [--file <yaml>]
```

The **only** sanctioned way for the agent to create an application record, and only
after the user confirms they applied. Validates the date format strictly, refuses a
duplicate slug (pointing at `update-application` or `applications remove`), then
`writeApplication()` — which upserts the row **and** regenerates the YAML export.

`--file` forces the legacy YAML-only path, which is what the tests use so they never
touch the production database.

### `update-application.mjs` (142 lines)

```bash
node scripts/applications/update-application.mjs <slug-or-company> [--status s]
     [--followed-up] [--date YYYY-MM-DD]
```

Records what **happened**. Never creates entries, never deletes them.

```js
STATUSES = [
  "applied",
  "followed_up",
  "interviewing",
  "offer",
  "rejected",
  "withdrawn",
]
```

`applyUpdate` is the pure core. A follow-up date is validated, refused if already
recorded, and only bumps the status forward **from plain "applied"** — it will not
overwrite `interviewing`.

The positional-argument loop is worth noting: it skips the _value_ of each
value-taking flag (`--file`, `--status`, `--date`) but not `--followed-up`, which is
boolean, so its neighbour stays eligible as the key.

### `check-applied.mjs` (75 lines)

```bash
node scripts/applications/check-applied.mjs "<company, title, or slug>" [--today YYYY-MM-DD]
```

Always prints JSON: `{ query, checked, job_already_applied, matches[] }` with
`days_ago` on each match, sorted nearest-first. `job_already_applied` is true only
on an exact **slug** match — a company match is informational.

> Its comment claims it "falls back to the YAML automatically if that file has been
> edited more recently". It does not — there is no mtime comparison anywhere. AUDIT
> **M16**. It also carries two dead imports.

### `follow-ups.mjs` (100 lines)

```bash
node scripts/applications/follow-ups.mjs [--days N] [--json] [--file path]
```

Policy: a follow-up is due N days (default 10) after the application **or after the
previous follow-up**. `MAX_FOLLOW_UPS = 2` — after that the lead is considered gone
cold and stops appearing. Applications whose status shows a response
(interviewing / offer / rejected / withdrawn) never appear.

An unparseable anchor date is **skipped, not guessed**. Never writes anything;
recording a sent follow-up goes through `update-application.mjs`.

### `applications.mjs` (195 lines)

```bash
node scripts/applications/applications.mjs list [--status s] [--company X] [--json]
node scripts/applications/applications.mjs find "<query>" [--json]
node scripts/applications/applications.mjs stats [--json]
node scripts/applications/applications.mjs remove <slug> --confirm
node scripts/applications/applications.mjs export
```

`remove` without `--confirm` prints what _would_ be deleted and exits 2. Deleting an
application destroys a record of something the user actually did, so it takes an
explicit flag rather than a bare command — and it exists to correct a mistake, never
to rewrite history.

`export` regenerates `profile/applications.yaml` with a header that says, in the
file itself, that it is generated and where the source of truth is.

---

## `scripts/profile/` — the fact base and the feedback loop

### `save-answer.mjs` (112 lines)

```bash
node scripts/profile/save-answer.mjs "<question>" "<answer>"
     [--id a-007] [--source user|model] [--replace] [--file path]
```

The **only** sanctioned write path into the fact base.

`--source` records provenance. `user` (the default) means the user said it in chat.
`model` means the agent picked an option off a form **and the user approved that
pick in the approval message** — still approved, but derived, so a wrong one has to
be findable and reversible.

`--replace` overwrites an existing entry for the same question, but **only when that
entry is `source: model`**. A user-stated answer is never overwritten by this
script; correcting one is a deliberate edit of the file by its owner. Entries
written before provenance existed have no `source` — those came from the user, so
they get the user's protection.

Ids are `a-NNN`, generated to avoid collision with anything already used.

> **Defect:** it rewrites the file with `yaml.dump`, destroying any comments the user
> added — in a file the header itself calls "user-editable". `docs/job-sources.yaml`
> got special line-by-line treatment for exactly this reason; `answers.yaml` did
> not. AUDIT **M10**.

### `apply-profile.mjs` (117 lines)

```bash
node scripts/profile/apply-profile.mjs [--proposal p] [--target t]
     [--allow-edits] [--allow-removals]
```

Replaces `profile.yaml` with `profile.proposed.yaml` **after enforcing the merge
guarantees**:

- every existing fact id must still exist → otherwise refuse (unless
  `--allow-removals`);
- every existing fact's text must be unchanged → otherwise refuse (unless
  `--allow-edits`);
- ids unique (enforced for free — `buildFactIndex` throws on a duplicate);
- `contact.name`, `contact.email` and `meta` present.

The old profile is copied to `profile.backup.yaml` before the swap, and the proposal
file is deleted afterwards. Prints `{ applied, added, changed, removed, backup }`.

This is the "add-only unless the user says otherwise" enforcement behind the
`update-profile` skill. It is genuinely careful: the two override flags exist so the
agent physically cannot lose a fact without the user having typed the flag.

> **Gap:** nothing here (or anywhere) checks `meta.approved_by_user`. AUDIT **M5**.

### `profile-gaps.mjs` (222 lines)

```bash
node scripts/profile/profile-gaps.mjs [--json] [--min-demand N]
```

Demand vs evidence, ranked. Demand comes from every captured job workspace plus,
weakly (weight 0.5), every non-dismissed stored lead. Supply is every string in
`profile.yaml`, flattened by `profileText()`.

**Jobs that got a rejection or silence-after-follow-up count double** (`jobWeight`):
those are the requirements that demonstrably did not convert.

A lead contributes its `terms` (from `lead_keywords`) rather than its text — which
is the only way a lead contributes anything real. `gatherJobs` used to hand over
`text: lead.title`, so 92 stored descriptions were invisible to this report.

This file also **re-exports** `TECH_LEXICON` and `extractTech` from
`keywords.mjs`, so existing importers (`recommend.mjs`, `find-jobs.mjs`,
`screen.mjs`, `keyword-plan.mjs`, `migrate.mjs`) keep working after the lexicon
moved. That re-export is convenient but it is a layering inversion — see AUDIT
**L18**.

### `keyword-coverage.mjs` (364 lines) — the best script in the project

```bash
node scripts/profile/keyword-coverage.mjs [--min-demand 2] [--top 40]
     [--include-dismissed] [--job jobs/<slug>/job.json] [--json]
```

Three buckets, and the middle one is the point:

| bucket    | meaning                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------- |
| `covered` | demanded and evidenced → already usable in a tailored resume                                          |
| **`ask`** | demanded, NOT evidenced, but **close to something evidenced** → probably yours; confirm and record it |
| `gap`     | demanded, not evidenced, not close to anything → a genuine learning gap                               |

Two routes into `ask`, labelled differently because they are different strengths of
claim:

- **`adjacent`** — a hand-checked edge in the lexicon (React ⇒ Redux). Strong.
- **`same-area`** — you already evidence `GROUP_AFFINITY_MIN` (4) other skills in
  this group. Weak, offered only because the adjacency map is hand-maintained and
  therefore incomplete, and shown last.

Adjacency is computed from what the user **already has**, never from what is
demanded: the claim is "you have React, so you probably have Redux", never "the
market wants Redux, so you probably have it".

**Demand is counted twice**, and this is the insight:

- `total` — from `lead_keywords`, indexed once at ingest from a posting's whole
  text. Cheap, and it covers leads whose description was never stored. But it has no
  idea which _half_ of the posting a term came from.
- `required` — parsed **live** from each description with the same
  `splitRequirements` the L2 fit stage uses. Only available where a description was
  stored.

Ranking is by `required` first, because "you cannot apply without this" and "it
would be nice" are different facts. And the `minDemand` gate uses
`Math.max(total, required)`, **not** `total`: `lead_keywords` is indexed once at
ingest, so any skill added to the lexicon since the last sweep has `total = 0` while
its required count is read live. Gating on `total` alone silently dropped **System
design at required = 8** — the single most required skill in the store — because the
index predated the term.

**It never writes.** It prints a ready-to-run `save-answer.mjs` line and the user
answers in chat. Rule 2.

> **Defect:** the `--job` path counts the whole body as "required" when there is no
> requirements section — exactly the flattening the leads path explicitly refuses to
> do. AUDIT **M8**.

---

## `scripts/maintenance/` — store lifecycle

### `migrate.mjs` (205 lines)

```bash
node scripts/maintenance/migrate.mjs [--dry-run] [--db p] [--leads-json p]
                                     [--applications p]
node scripts/maintenance/migrate.mjs --export <file>
```

**Flat, not versioned.** No `schema_version` table, no migration chain. `db.mjs`
declares the whole schema with `CREATE TABLE IF NOT EXISTS`, and this script
re-imports from the files that are still the user-owned source of truth. Running it
twice is a no-op; running it after a schema addition just fills in the new tables. A
single-user tool whose inputs are all re-derivable does not need incremental
migrations — it needs one idempotent build step you can always re-run.

**The two tables have different sources of truth, and conflating them is a data-loss
bug:**

- `leads` — the **database** is the live store once it exists. A JSON snapshot is
  frozen. Re-importing it wholesale would roll statuses back, so leads are only ever
  **added** if their id is not already present.
- `applications` — the **table** is the source of truth. The YAML is a generated
  export, imported only to **bootstrap an empty table**. Re-importing it over a
  populated table would undo every outcome recorded since the export was written.

Keywords are rebuilt for **every** lead in the database (not from the snapshot,
which may be missing everything found since the first build). That is what makes
this the fix for stale `lead_keywords`: 268 → 443 links after the lexicon was
unified, 0 leads touched.

It then **verifies itself**: every snapshot lead must be present, newly inserted
rows must round-trip field-for-field, and bootstrapped applications must match the
YAML exactly. Any failure throws rather than reporting success.

**`documents` is never touched.** An archived workspace has no on-disk source once
its directory is gone, so there is nothing to rebuild it from — re-running this must
not be able to clear it.

There is deliberately **no default** for `--leads-json`: a default would recreate
the stale-duplicate problem this removed.

### `archive.mjs` (393 lines)

```bash
node scripts/maintenance/archive.mjs list | show <slug>
node scripts/maintenance/archive.mjs archive <slug> [--force]
node scripts/maintenance/archive.mjs archive --closed [--dry-run]
node scripts/maintenance/archive.mjs restore <slug> [--to dir] [--force]
```

**The problem this solves is not disk space.** `jobs/` reached ~100 directories and
it stopped being possible to see which application was actually in flight, so the
whole lot got deleted — audit trail included. Folding closed work into the database
keeps `ls jobs/` down to live work without throwing anything away. A full database
was rejected as too opaque to inspect by hand.

```
ACTIVE  jobs/<slug>/ exactly as today — editable, diffable, and what
        verify-claims.mjs and render-pdf.mjs already read
CLOSED  rows in `documents`, directory removed
```

`classify(name)`: `.render.html` → **drop**, `.pdf` → **regenerable** (row without
content; `render-pdf.mjs` rebuilds it), everything else → **store** (exact bytes).

```js
CLOSED = { rejected, closed, withdrawn, no_response } // safe to archive
LIVE = { applied, followed_up, interviewing, offer } // refuse without --force
```

`archive --closed` only touches applications with a **recorded** closed outcome. No
record and no recorded outcome both mean "not known to be closed", which is not the
same as closed.

**`verifyArchive` reads every row back and proves it matches the disk BEFORE
anything is deleted.** `migrate.mjs` holds the same discipline; an archive step that
removes the only copy on an unverified write is how an audit trail disappears.
`restoreOne` re-checks each blob's sha256 before writing it out, and keeps the rows
afterwards — restoring is for inspecting or reusing, not for taking the workspace
back out of the archive.

> **Defects:** subdirectories inside a workspace are never archived but **are**
> deleted (AUDIT **H2**), and two of the four `CLOSED` statuses can never be set by
> `update-application.mjs` (AUDIT **M9**).

### `prune-jobs.mjs` (151 lines)

```bash
node scripts/maintenance/prune-jobs.mjs [--apply] [--jobs-dir p] [--json]
```

Dry run by default. It now drops exactly one thing: `*.render.html`, the intermediate
`render-pdf.mjs` leaves behind, regenerated on every render and useful to nobody.

It used to also drop PDFs once an application was closed and old. `archive.mjs`
supersedes that, and the comment explains why the overlap was removed: **two rules
competing to delete the same files, on different triggers, is how a workspace loses
a PDF that its archive row then records as regenerable-but-never-stored.**

Everything else stays until the workspace is archived — `resume.md`,
`cover-letter.md`, `job.json` and `context.json` are the record of what was actually
claimed on an application. If an employer asks about a bullet in an interview, this
is it.

> **Defect:** `--json --apply` prints the plan as JSON and then appends a
> non-JSON `removed=N` line. AUDIT **L4**.

---

## `scripts/status.mjs` (100 lines)

```bash
node scripts/status.mjs [--json] [--days N]
```

The whole-pipeline digest in **one call** — it replaces the several separate
commands, and the model round-trips between them, that answering "where do things
stand?" used to take.

`buildStatus(leads, applications, {now, days})` returns lead totals by status,
application totals by status, how many are awaiting a response
(`applied` / `followed_up`), and the follow-up list from `dueFollowUps()`.

It is the one cross-cutting script, which is why it sits at the root of `scripts/`
rather than in a domain folder.

> **Defect:** its `ROOT` constant resolves one directory **above** the repository,
> and both `ROOT` and `readJson` are declared and never used. AUDIT **M6**.
