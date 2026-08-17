# Every piece of data this system stores

This document is the complete inventory of what lives on disk when you run this
project: every database table with every column, every file in a job's working
folder, the fact base your resume is built from, and the four caches that make
the pipeline fast. It is written to be read by somebody who has never used a
database before, so it teaches the database ideas as it goes rather than
assuming them. If you wanted to rebuild this project from nothing, this is the
document you would design from first — because the shape of the storage decides
what the rest of the code is even able to do.

**What you will learn**

- What a database **table**, **row**, **column** and **primary key** actually
  are, taught from zero, with real rows from this project's own store.
- Why this project uses **SQLite** — a database that is one ordinary file with
  no server running behind it — and what the alternatives would have cost.
- All twelve tables in `jobs/leads.db`, column by column, with what each column
  means, whether it can be empty, and why it exists.
- **The single most consequential decision in the storage layer**: why the
  `auto_submissions` table is keyed on `(slug, mode)`, and the two specific
  bugs that appeared when it was keyed the two other obvious ways.
- **A trap that silently disables a primary key.** SQLite permits `NULL` in the
  columns of most primary keys, and because `NULL` never equals anything —
  including another `NULL` — two rows that are "the same" can both be stored.
  One column definition in this project exists purely to close that hole.
- What an **UPSERT** is, what a **transaction** is, why the difference between
  `BEGIN` and `BEGIN IMMEDIATE` once silently threw away a user's hand-recorded
  interview, and what **WAL mode** buys you.
- Every file inside `jobs/<slug>/` — which program writes it, which program
  reads it, and the exact JSON shape, cross-referenced to `schemas/`.
- The **fact base** in `profile/`: what a _fact id_ is, what
  `profile.yaml` and `answers.yaml` look like, and the exact comment syntax a
  tailored resume bullet uses to cite a fact.
- The four caches and ledgers outside the database — `jobs/.field-cache.json`,
  `jobs/.shape-history.jsonl`, `jobs/.gate-baseline.json` and `jobs/.auto/` —
  what each remembers, what makes it stale, and what breaks if you delete it.
- **How to back all of this up**, which is one file copy, and why exporting the
  YAML is _not_ a backup.

**Before this**

You can read this without them, but they answer questions this document
assumes:

- [`02-computer-basics.md`](02-computer-basics.md) — files, folders, paths,
  text versus binary.
- [`03-programming-basics.md`](03-programming-basics.md) — objects, arrays,
  JSON, functions.
- [`05-architecture.md`](05-architecture.md) — how the stages of the pipeline
  fit together. This document is the _nouns_; that one is the _verbs_.
- [`../code/01-lib-foundation.md`](../code/01-lib-foundation.md) — the
  **functions** that read and write the database. This document covers the
  tables; that one covers the accessors.

---

## Part 0 — the ideas you need before any of the storage

Everything below this part is concrete. This part is the vocabulary. If you
already know what a primary key and a transaction are, skim to §0.7, which
covers two things that are genuinely unusual and are load-bearing here.

### 0.1 Three kinds of stored data, and why the distinction matters more than anything else

Every file this project writes falls into exactly one of three categories, and
confusing them is the most expensive mistake you can make.

| Kind                 | What it means                                                                            | Example here                | If you lose it                                      |
| -------------------- | ---------------------------------------------------------------------------------------- | --------------------------- | --------------------------------------------------- |
| **Store of record**  | The one authoritative copy. Nothing can rebuild it. Losing it loses information forever. | the `applications` table    | You no longer know what you applied to.             |
| **Generated export** | A second copy written _from_ the store of record, for convenience or disaster recovery.  | `profile/applications.yaml` | Regenerate it with one command.                     |
| **Cache**            | Derived data kept only because recomputing it is slow. Never authoritative.              | `jobs/.field-cache.json`    | The next run is slower and then it rebuilds itself. |

The rule that follows from this: **a cache may never be read as a source of
truth**, and **a generated export may never be edited by hand**, because the
next regeneration will overwrite whatever you typed. This project writes that
rule into the export file itself — `exportApplicationsYaml` in
`scripts/lib/db.mjs` stamps five header lines at the top of
`profile/applications.yaml` beginning:

```
# APPLICATION LOG — GENERATED, do not edit.
# Source of truth is the `applications` table in jobs/leads.db.
```

There is a fourth category that this project uses heavily and that is worth
naming separately: a **ledger**. A ledger is a store of record whose rows are
_claims about the outside world_ — "an application was sent to this employer".
You cannot un-send an application, so a ledger is never allowed to lose a row,
and correcting one means adding a correcting entry rather than deleting the
original. The `auto_submissions` table is a ledger, and much of Part 2 is about
what that costs.

### 0.2 What a database, a table, a row and a column are

A **database** is a program's filing cabinet. In this project it is one file:
`jobs/leads.db`.

A **table** is one drawer in that cabinet, holding many items that all have the
same shape. This project has twelve tables — one for job leads, one for
applications, one for screening verdicts, and so on.

A **column** is one named field that every item in that drawer has. A **row**
is one item, holding one value per column.

Here is a real table from this project, drawn as a grid. The `leads` table has
six columns, and this is two of its rows with the sixth column shortened:

| `id`                                                | `status`    | `company` | `title`                                  | `posted_at`  | `doc`                                                       |
| --------------------------------------------------- | ----------- | --------- | ---------------------------------------- | ------------ | ----------------------------------------------------------- |
| `greenhouse:reddit:8060775`                         | `dismissed` | `Reddit`  | `Senior Staff SWE, Client Architecture`  | `2026-07-30` | `{"id":"greenhouse:reddit:8060775","status":"dismissed",…}` |
| `ashby:openai:07153f7c-7e8b-4283-a879-cb07a224e083` | `new`       | `OpenAI`  | `Software Engineer, Privacy Engineering` | `2026-08-01` | `{"id":"ashby:openai:07153f7c-…","status":"new",…}`         |

Two things to notice already, because they are choices this project made rather
than facts about databases:

1. The `id` is not a number. It is a text string that encodes where the lead
   came from: the board type, the employer, and the board's own posting id.
2. The last column, `doc`, holds the _entire_ lead as JSON text — including
   copies of `status`, `company`, `title` and `posted_at`. That duplication is
   deliberate and §0.9 explains why.

A **column type** says what kind of value a column holds. SQLite has five:
`TEXT` (a string), `INTEGER` (a whole number), `REAL` (a decimal), `BLOB` (raw
bytes — used here for PDF and markdown file contents), and `NULL`.

**`NULL` is not a value.** It is the absence of one. A column that is `NULL`
means "we do not know" or "this does not apply". `NULL` behaves in a way that
surprises everybody the first time, and §0.7 is devoted to it because this
project has a comment about it in the schema and a bug that came from it.

**Nullable** means "this column is allowed to be `NULL`". A column marked
`NOT NULL` is not: an insert that leaves it empty is rejected. Throughout Part
2 the tables have a "Nullable" column, and that word means exactly this.

### 0.3 Why SQLite, and what "no server" means

Most databases you may have heard of — MySQL, PostgreSQL, MongoDB — are
**servers**. A separate program runs continuously in the background, and your
code talks to it over a network connection, even when both are on the same
machine. That means before anything works, the server has to be installed,
configured, started, and still running.

**SQLite is not a server.** It is a library that reads and writes one ordinary
file. There is no background program. Your code opens the file, reads and
writes it, and closes it.

`scripts/lib/db.mjs` states the reasoning in its own header, and it is worth
quoting because it is the kind of trade-off reasoning a newcomer rarely sees
written down:

```
// WHY SQLITE (and not MongoDB/MySQL, which were the other candidates):
// this is a single-user CLI on a Windows laptop. Mongo and MySQL both need a
// server daemon running before any script can do anything — if it is not up,
// the whole pipeline fails. SQLite is a single file with no daemon, it is
// built into Node 22.5+ as `node:sqlite` (so zero new dependencies on top of
// js-yaml and marked), and it is ACID.
```

**ACID** is four guarantees a database makes, and the word is an acronym:

- **A**tomic — a group of changes either all happen or none happen. There is no
  half-finished state where three of five rows were written.
- **C**onsistent — the database's own rules (like "this column may not be
  empty") are never violated, even mid-operation.
- **I**solated — two programs writing at the same time do not see each other's
  half-finished work.
- **D**urable — once the database says a change is saved, a power cut does not
  undo it.

That last one is why this project stores the record of "we are about to click
submit on an employer's form" in SQLite and not in a variable in memory. A
variable dies with the process. The row survives.

Before SQLite this project stored leads in a plain JSON file,
`jobs/leads.json`. The header records exactly what that cost, measured on the
real store of 99 leads and 321 KB:

```
//   - jobs/leads.json was fully parsed AND fully rewritten on every mutation.
//     Marking 57 leads dismissed meant 57 full read+rewrite cycles — O(n^2).
//     A single-row UPDATE replaces that.
```

"O(n²)" is a way of saying the cost grows with the _square_ of the size: twice
as many leads is four times the work. The file
`scripts/lib/db.mjs` still exports `JSON_PATH` pointing at
`jobs/leads.json`, but only so a repository that has not migrated yet can still
be read — there is no standing `leads.json` any more.

### 0.4 A primary key

A **primary key** is the column (or set of columns) that uniquely identifies a
row. No two rows may have the same primary key. The database enforces this: an
insert that would create a duplicate fails.

In the `leads` table, the primary key is `id`. That means one job posting can
appear in the table exactly once, no matter how many times a sweep finds it.

A **composite primary key** (also called a _compound_ key) uses more than one
column together. `lead_keywords` is keyed on `(lead_id, keyword)`:

| `lead_id`                   | `keyword`    |
| --------------------------- | ------------ |
| `greenhouse:reddit:8060775` | `react`      |
| `greenhouse:reddit:8060775` | `typescript` |
| `ashby:openai:07153f…`      | `react`      |

The key `(lead_id, keyword)` allows the same `lead_id` many times, and the same
`keyword` many times, but never the same _pair_ twice. That is exactly the rule
you want: a lead may have many keywords, a keyword may appear on many leads, but
"react appears twice on this one lead" is nonsense.

**Choosing a primary key is the most important design decision in a table**,
because the key is not just an identifier — it is a _rule about what cannot
happen twice_. Part 2.8 is a long worked example of getting this wrong in two
different directions.

### 0.5 An index

An **index** is a sorted lookup structure the database maintains beside a table
so that finding rows by a particular column does not require reading every row.

Think of a physical book. Finding every mention of "Postgres" by reading the
whole book front to back is a **scan**. Finding it in the index at the back and
jumping to page 214 is a **search**. Same answer, wildly different cost, and the
difference grows with the size of the book.

This project creates sixteen indexes explicitly. For example:

```sql
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
```

That makes "give me every lead whose status is `new`" fast.

**Every primary key also creates an index automatically.** SQLite names these
`sqlite_autoindex_<table>_1`. That is how it enforces uniqueness — to know
whether a key already exists it has to be able to look it up quickly. So this
project's database actually holds 28 indexes: the 16 declared ones plus 12
automatic ones, one for each of the twelve tables. You can confirm this yourself
by asking SQLite's own catalogue table, `sqlite_master`.

An index is not free. Every insert and every update has to update every index on
that table. An index that no query uses is pure cost.

> **Known defect (2026-08-05 audit).** Two of the sixteen declared indexes are
> redundant. `idx_docs_slug` covers `documents(slug)`, but the primary key
> `(slug, name)` already produces an automatic index whose _first_ column is
> `slug` — and an index sorted by `(slug, name)` can answer any question about
> `slug` alone. Asking SQLite which one it actually uses, with
> `EXPLAIN QUERY PLAN SELECT name FROM documents WHERE slug='x'`, returns
> `SEARCH documents USING COVERING INDEX sqlite_autoindex_documents_1 (slug=?)`
> — the automatic one. `idx_verifications_slug` is redundant with
> `verifications`' key `(slug, mode, doc_sha256)` for the same reason. Meanwhile
> `auto_queue.board_key` has **no** index at all, although three queries filter
> or group on it. Neither is a correctness problem; both are the same class of
> mistake in opposite directions.

> **Known defect (2026-08-05 audit).** The three `leads` indexes
> (`idx_leads_status`, `idx_leads_company`, `idx_leads_posted`) are maintained on
> every write and used by nothing. Every query against that table in this
> repository is an unfiltered `SELECT * FROM leads` — including `readLeadStore`
> in `scripts/lib/db.mjs` — and the filtering happens in JavaScript after every
> row's `doc` has been parsed. The header comment claims "reads filtered by
> status scanned every lead; now they hit an index", and that is currently not
> true of any caller.

### 0.6 An UPSERT

"Insert this row, or if it already exists, update it instead" is such a common
need that SQL has one statement for it. It is spelled
`INSERT … ON CONFLICT … DO UPDATE`, and the informal name is **UPSERT** (update

- insert).

Here is the one this project uses for leads, from `scripts/lib/db.mjs` (the
column list is generated from the `INDEXED` array, so the real source builds
this string; this is what it produces):

```sql
INSERT INTO leads (id, status, company, title, posted_at, doc)
VALUES ($id, $status, $company, $title, $posted_at, $doc)
ON CONFLICT(id) DO UPDATE SET
  status = excluded.status,
  company = excluded.company,
  title = excluded.title,
  posted_at = excluded.posted_at,
  doc = excluded.doc
```

Read it as: _try to insert. If a row with this `id` already exists, then instead
of failing, overwrite these columns with the values I was trying to insert._

`excluded` is a special name meaning "the row that was rejected" — the values
you tried to insert. It is a slightly odd name; think of it as "the excluded
candidate".

There are two variants, and this project uses both, deliberately:

- **`DO UPDATE`** — overwrite. Used when re-finding a lead should refresh it.
- **`DO NOTHING`** — leave the existing row alone. `enqueueAutoJobs` in
  `scripts/lib/db.mjs` was this until 2026-08-17, because re-running the planner
  over a queue another worker is already working on must not reset a job
  somebody else holds. It is now the guarded form below with one narrow
  condition — `state = 'deferred'` and the reason is one of
  `AUTO_REQUEUEABLE_KINDS` — because a bare `DO NOTHING` made every deferral
  permanent: a job that deferred once on an unprobed dropdown stayed deferred
  after the probe was fixed, for thirteen days, with nothing able to notice.
  Every other state still behaves as `DO NOTHING`.

And there is a third form that is the heart of this project's concurrency
design: a **guarded** `DO UPDATE`, which is `DO UPDATE … WHERE <condition>`. The
update only happens if the condition holds. If it does not, nothing is written
and the statement reports **zero rows changed**. That zero is a _signal_, and
Part 2.9 explains why it is the entire mechanism that stops two workers applying
to the same job twice.

### 0.7 `NULL`, and the trap that silently turns a primary key off

This is the section to read twice.

In SQL, `NULL` means "unknown". And comparisons involving an unknown do not
produce `true` or `false` — they produce `NULL`, which is treated as "not true".

| Expression                | Result  | Plain English                                                          |
| ------------------------- | ------- | ---------------------------------------------------------------------- |
| `1 = 1`                   | `true`  | obviously                                                              |
| `1 = 2`                   | `false` | obviously                                                              |
| `NULL = NULL`             | `NULL`  | "is one unknown thing the same as another unknown thing?" — unknowable |
| `NULL != 'abandoned'`     | `NULL`  | same reason, and `NULL` is **not true**, so a `WHERE` skips the row    |
| `NULL IS NULL`            | `true`  | `IS` asks about identity, not equality, and it _does_ answer           |
| `NULL IS NOT 'abandoned'` | `true`  | `IS NOT` is the identity form and answers properly                     |

That last pair is not academic. This project's daily-cap counter,
`countAutoSubmissions` in `scripts/lib/db.mjs`, counts applications sent since a
date, excluding two outcomes:

```sql
SELECT COUNT(*) c FROM auto_submissions
 WHERE submitted_at >= ?
   AND outcome IS NOT 'abandoned' AND outcome IS NOT 'reconciled-not-sent'
```

The source carries a comment explaining why it is not `!=`:

```
// IS NOT, not !=. `NULL != 'abandoned'` is NULL, which is falsy, so a row
// written before the outcome column existed would silently stop counting.
// `NULL IS NOT 'abandoned'` is 1. Those legacy rows are real submitted
// applications and must keep counting.
```

Write that with `!=` and every old row silently drops out of the count that
protects the user from spamming an employer. The query does not fail. It just
quietly returns a smaller number.

#### The trap

Now the part that is genuinely surprising, and that this project has a schema
comment about.

**In most databases, a primary key column can never be `NULL`.** That is part of
the definition of a key. **SQLite is an exception.** For historical
compatibility, only an `INTEGER PRIMARY KEY` (SQLite's special row-id column) is
protected. In _any other_ primary key — text keys, composite keys — SQLite
permits a column to be `NULL`.

Combine that with `NULL = NULL` being _not true_, and you get the failure:

> Two rows both holding `NULL` in a key column **do not conflict with each
> other**, because the database cannot tell they are the same. So a nullable key
> column silently turns the uniqueness rule off — for exactly those rows.

You do not get an error. You get duplicates.

Here is the concrete case in this project. `auto_submissions` is keyed
`(slug, mode)`, where `mode` is either `'live'` or `'dry_run'`. If `mode` were
allowed to be `NULL`, then this could happen:

| `slug`           | `mode` | conflicts with the row above? |
| ---------------- | ------ | ----------------------------- |
| `acme-fullstack` | `NULL` | —                             |
| `acme-fullstack` | `NULL` | **no** — `NULL != NULL`       |
| `acme-fullstack` | `NULL` | **no**                        |

An unlimited number of rows for one job posting, none of them refusable. And
because a row in that table is the _claim_ that stops a second application going
out, that is an unlimited number of applications to the same employer.

The fix is one clause in the column definition:

```sql
mode TEXT NOT NULL DEFAULT 'live',   -- 'dry_run' | 'live'
```

`NOT NULL` makes the empty case impossible. `DEFAULT 'live'` decides what
happens when a caller forgets to say. And the schema comment states why the
default leans that way:

```
-- An unknown mode counts as live everywhere else in this file too; nothing that
-- reached this ledger without saying it was a rehearsal gets the benefit of
-- the doubt.
```

That is a **fail-closed** default: when in doubt, assume the more serious thing
happened. The opposite — assuming a real submission was only a rehearsal —
would let the machine apply again.

### 0.8 Transactions

A **transaction** is a group of database changes treated as one indivisible
unit. You write `BEGIN`, then some statements, then `COMMIT`. Either all of them
took effect or, if you write `ROLLBACK` instead (or the process dies), none of
them did.

This project's pattern, from `upsertLeads` in `scripts/lib/db.mjs`:

```js
db.exec("BEGIN")
try {
  for (const l of leads) stmt.run(leadToRow(l))
  db.exec("COMMIT")
} catch (e) {
  db.exec("ROLLBACK")
  throw e
}
```

If lead 40 of 99 is malformed, the first 39 are undone. You do not end up with a
half-imported store.

#### `BEGIN` versus `BEGIN IMMEDIATE`, and the interview that vanished

SQLite has two flavours of transaction, and the difference caused a real
data-loss bug that this project's source documents in full.

- **`BEGIN`** (also called `DEFERRED`, and it is the default) does not take a
  write lock until the first _write_. Two transactions can both be open and both
  reading.
- **`BEGIN IMMEDIATE`** takes the write lock at `BEGIN`. The second caller waits.

Why that matters for a **read-modify-write** — where you read a value, change
part of it, and write it back:

```
Time  Worker A                        Worker B
----  ------------------------------  ------------------------------
 1    BEGIN
 2    read application doc  {status:"applied"}
 3                                    BEGIN
 4                                    read the SAME doc {status:"applied"}
 5    merge {status:"interview"}
 6    write  {status:"interview"}
 7    COMMIT
 8                                    merge {notes:"recruiter called"}
 9                                    write {status:"applied", notes:"…"}
10                                    COMMIT
```

Worker B read the document _before_ A's change landed, merged onto that stale
copy, and wrote it back — erasing `status:"interview"`. Nothing errored. This is
called a **lost update**.

`updateApplication` in `scripts/lib/db.mjs` uses `BEGIN IMMEDIATE` for exactly
this reason, and the comment names the human cost:

```
// A DEFERRED transaction (SQLite's default, and what plain `BEGIN` gives) takes
// no write lock until its first write, so two of these can both READ, both
// merge onto the same base, and the second write silently discards the first
// patch. During a multi-hour unattended run that lost patch is the user
// recording an interview by hand — a fact nothing else in the system can
// reconstruct.
```

**SQLite does not support nested transactions.** You cannot open one inside
another. That produces a hard rule for this file: `upsertLeads`,
`upsertApplications`, `writeDocuments`, `recordScreens`, `enqueueAutoJobs`,
`strandPausedBoardJobs` and `updateApplication` each open their own transaction,
and therefore **none of them may be called from inside another one**. The
comment on `updateApplication` records where that bit: it issues its upsert
inline rather than calling `upsertApplications`, "because that function opens
its own transaction and SQLite does not nest them."

> **Known defect (2026-08-05 audit).** `updateApplication` — the one function
> written to make an application patch safe under concurrency — is called only
> by tests. The real command-line path in `scripts/applications/` does a
> read-modify-write across two separate connections with no transaction at all,
> which is the exact shape the `BEGIN IMMEDIATE` comment says loses data.

### 0.9 The "document plus columns" shape

Ten of the twelve tables have a column named `doc` holding
`JSON.stringify(theWholeObject)` — the complete object as text — _alongside_
ordinary columns holding copies of a few of its fields.

Storing the same value twice looks like a mistake. It is not, and the reasoning
is the single most important design note in `scripts/lib/db.mjs`:

```
// This shape was chosen after a column-per-field version failed its own
// round-trip check on 73 of 99 real leads: mapping fields by hand cannot
// distinguish `flags: []` from no flags, or `notes: ""` from `notes: null`,
// and each such case silently altered a lead. Keeping the document verbatim
// makes fidelity structural rather than something 15 mappings must get right,
// and json_set() keeps the denormalized columns in step on update.
```

**Round-tripping** means: store a thing, read it back, and get exactly what you
put in. A column-per-field design failed that on 74% of the real data, because
"an empty list" and "no list at all" are different facts and a hand-written
mapping flattened them together.

Copying a few fields out into their own columns is called **denormalisation**.
It is done for one reason only: you cannot index the inside of a JSON blob
efficiently, but you can index a column. The list of copied fields is a single
JavaScript array in `scripts/lib/db.mjs`:

```js
const INDEXED = ["status", "company", "title", "posted_at"]
```

and the UPSERT statement is _generated_ from it, so adding a name to that array
changes the SQL automatically rather than requiring you to remember three
places.

Keeping the two in step on update uses SQLite's built-in JSON support.
`setLeadStatus` runs:

```sql
UPDATE leads SET status = ?, doc = json_set(doc, '$.status', ?) WHERE id = ?
```

`json_set` edits a value _inside_ stored JSON text without your code having to
read it, parse it, change it and write it back. `'$.status'` is a **JSON path**:
`$` means the root object, `.status` means that property.

### 0.10 WAL mode, busy timeouts, and opening the file

`openDb` in `scripts/lib/db.mjs` is the only way anything in this project opens
the database. It does six things, and their order is load-bearing:

1. Create the `jobs/` directory if it does not exist.
2. Open the file.
3. `PRAGMA busy_timeout = 5000`
4. `PRAGMA journal_mode = WAL`
5. `PRAGMA synchronous = NORMAL`
6. Run the three "heal" repairs (§2.14), then create every table and index.

A **`PRAGMA`** is a SQLite-specific settings statement — not standard SQL, more
like turning a dial on the connection.

**WAL** stands for **write-ahead logging**. Without it, a writer blocks all
readers. With it, new writes go into a side file first and readers keep reading
the main file, so **readers and a writer can run at the same time**. Writers
still take turns with each other.

WAL is why you will see two extra files appear beside the database while
anything has it open:

```
jobs/leads.db        the database
jobs/leads.db-wal    the write-ahead log — recent changes not yet folded in
jobs/leads.db-shm    shared memory index for the WAL
```

Those are not junk. See Part 6 before copying the database.

**`busy_timeout = 5000`** says: if another process holds the write lock, wait up
to five seconds rather than failing instantly. The comment in `openDb` explains
why it must be set _first_, and this is on the project's short list of things
never to reorder:

```
// The ordering is not cosmetic: switching the journal mode below takes a
// brief exclusive lock, so four processes opening the same store at once used
// to have three of them die on `PRAGMA journal_mode = WAL` itself — before
// any timeout they set afterwards could apply.
```

Setting the journal mode is itself a write. Set the timeout after it, and the
statement you needed the timeout for is the one that fails.

**`synchronous = NORMAL`** trades a little durability for a lot of speed. At
full durability every commit waits for the disk to physically confirm the write
(an `fsync`). Measured here: 57 sequential updates cost about 246 ms, almost
all of it waiting on the disk. `NORMAL` is the documented companion to WAL and
risks losing only the last few commits in an operating-system-level crash.

One more detail with a Windows-specific reason. If anything throws during
opening, `openDb` closes the handle before re-throwing:

```
// An open that throws must not leave the handle behind. On Windows a
// leaked one keeps a lock on the file, so the next thing to touch it fails
// with EPERM and the real error is two layers down.
```

---

## Part 1 — the map

Four places hold state. Everything else is code.

```
AgenticJobApplication/
├── jobs/                          ← gitignored; all runtime state
│   ├── leads.db                   ← THE DATABASE — 12 tables (Part 2)
│   ├── <slug>/                    ← one folder per job worked on (Part 3)
│   │   ├── job.json
│   │   ├── context.json
│   │   ├── keywords.json
│   │   ├── resume.md / cover-letter.md
│   │   ├── resume-selection.json
│   │   ├── resume.render.html / resume.pdf
│   │   ├── scan-p1.json / scan-p2.json
│   │   └── fill-plan.json / fill-plan.js
│   ├── .field-cache.json          ← remembered form shapes (Part 5)
│   ├── .shape-history.jsonl       ← append-only shape counter (Part 5)
│   ├── .gate-baseline.json        ← last screening audit, for diffing (Part 5)
│   └── .auto/
│       ├── runs/<runid>.jsonl     ← the surviving copy of every run (Part 5)
│       └── post-submit/           ← staged post-submit captures (Part 5)
├── profile/                       ← gitignored; THE FACT BASE (Part 4)
│   ├── profile.yaml               ← store of record — user-owned
│   ├── answers.yaml               ← store of record — user-owned
│   ├── applications.yaml          ← GENERATED export of the applications table
│   ├── profile.example.yaml       ← the only committed file here; a template
│   └── source/                    ← the user's original resume/cover letter
└── schemas/
    ├── job.schema.json            ← the shape of jobs/<slug>/job.json
    └── context.schema.json        ← the shape of jobs/<slug>/context.json
```

Two lines in `.gitignore` decide most of this: `/jobs/` and `profile/*` (with
`!profile/profile.example.yaml` letting the template through). Nothing in
`jobs/` or `profile/` is ever committed or leaves the machine. That is why the
back-up story in Part 6 exists at all — git is not doing it for you.

The exact live sizes on the machine this was written on, so the scale is
concrete: `leads.db` 1.4 MB holding 194 leads, 892 keyword links, 228 screening
verdicts, 25 applications, 41 verifications and 84 archived files;
`.field-cache.json` 83 KB holding 11 remembered forms; `.gate-baseline.json`
45 KB; `.shape-history.jsonl` 4.5 KB.

---

## Part 2 — `jobs/leads.db`, table by table

Every table is created by one long SQL string, the `SCHEMA` constant in
`scripts/lib/db.mjs`, run in a single `db.exec(SCHEMA)` inside `openDb`. Every
statement in it is `CREATE … IF NOT EXISTS`, so running it against a database
that already exists does nothing.

> **A trap in the schema itself, already hit once.** `SCHEMA` is a JavaScript
> **template literal** — a string delimited by backtick characters. A single
> backtick anywhere inside the SQL, _including inside an SQL comment_, ends the
> JavaScript string and produces a syntax error hundreds of lines away from its
> cause. The schema carries a comment saying so, and that comment records that
> this is exactly how it failed the first time it was written.

There is **no version table and no migration chain**. The schema is flat. When a
table's shape had to change, three narrow repair functions were written instead
(§2.14).

### 2.1 `leads` — job postings found by a sweep

Written by `scripts/leads/find-jobs.mjs` through `upsertLeads` and
`setLeadStatus`. Read by nearly everything.

| Column      | Type   | Nullable | Meaning                                                                         |
| ----------- | ------ | -------- | ------------------------------------------------------------------------------- |
| `id`        | `TEXT` | no (PK)  | Unique id, e.g. `greenhouse:reddit:8060775` — board type, employer, posting id. |
| `status`    | `TEXT` | yes      | `new`, `dismissed`, `applied`, … A copy of `doc.status`, kept for indexing.     |
| `company`   | `TEXT` | yes      | Employer name. A copy of `doc.company`.                                         |
| `title`     | `TEXT` | yes      | Job title. A copy of `doc.title`.                                               |
| `posted_at` | `TEXT` | yes      | ISO-8601 date the posting went up. A copy of `doc.posted_at`.                   |
| `doc`       | `TEXT` | **no**   | `JSON.stringify(lead)` — the complete lead object, unmodified.                  |

**Primary key:** `id`. One posting, one row, however many times a sweep finds
it.

**Indexes:** `idx_leads_status(status)`, `idx_leads_company(company)`,
`idx_leads_posted(posted_at)` — plus the automatic key index on `id`. (See the
known defect in §0.5: nothing currently queries through the three declared
ones.)

The `doc` column holds whatever the sweep captured: the URL, the location, the
description, salary bounds, screening flags, notes. `readLeadStore` reads every
row and `JSON.parse`s every `doc`; `rowToLead` is the one-line function that
does it.

`writeLeadStore` on the database path **merges** — it calls `upsertLeads`, which
never deletes. A lead absent from the object you hand it is not removed. On the
legacy JSON path it does replace the file. That asymmetry is worth knowing
before you write a script that expects "write the store" to mean "make the store
equal this".

### 2.2 `lead_keywords` — technologies named in a posting

Written by `setLeadKeywords`. Read by `keywordMap`, `keywordsFor` and
`keywordDemand`.

| Column    | Type   | Nullable | Meaning                                           |
| --------- | ------ | -------- | ------------------------------------------------- |
| `lead_id` | `TEXT` | no (PK₁) | Which lead. Matches `leads.id`.                   |
| `keyword` | `TEXT` | no (PK₂) | One canonical technology term, e.g. `typescript`. |

**Primary key:** `(lead_id, keyword)` — a duplicate keyword on one lead is
impossible by construction.

**Index:** `idx_kw_keyword(keyword)`. The key index sorts by `lead_id` first, so
it answers "what does this lead ask for?" cheaply but not "which leads ask for
Kubernetes?". The extra index on `keyword` alone answers the reverse question.

The schema comment states why this is a separate table rather than a field on
the lead:

```
-- A separate table rather than a field on the lead so the interesting question
-- is a GROUP BY: "what do the jobs that rejected me keep asking for?"
```

`GROUP BY` is the SQL clause that turns many rows into one row per distinct
value, usually with a count. `keywordDemand` is exactly that query, and its
answer is what `scripts/profile/profile-gaps.mjs` turns into "the market keeps
asking for X and your profile does not evidence it".

`setLeadKeywords` **deletes then re-inserts** the whole set for a lead, so
re-ingesting a posting whose description changed cannot leave stale terms
behind.

> **Known defect (2026-08-05 audit), noted in `CLAUDE.md`'s gotchas.**
> `lead_keywords` goes stale when the technology lexicon in
> `scripts/lib/keywords.mjs` changes. The rows were extracted at ingest with the
> lexicon of that day; nothing re-extracts them when new terms are added.

### 2.3 `applications` — what the user actually submitted

The store of record for hard rule 2. Written only through `writeApplication`,
which is reached only from `scripts/applications/log-application.mjs` after the
user confirms in chat that they submitted an application.

| Column       | Type   | Nullable | Meaning                                                 |
| ------------ | ------ | -------- | ------------------------------------------------------- |
| `slug`       | `TEXT` | no (PK)  | The job's workspace slug, e.g. `acme-senior-fullstack`. |
| `company`    | `TEXT` | yes      | Employer name, as the user typed it.                    |
| `title`      | `TEXT` | yes      | Job title.                                              |
| `applied_at` | `TEXT` | yes      | ISO-8601 date/time of submission.                       |
| `status`     | `TEXT` | yes      | Outcome so far: applied, rejected, interview, offer, …  |
| `doc`        | `TEXT` | **no**   | The complete application object, verbatim.              |

**Primary key:** `slug`. One application per job workspace.

**Indexes:** `idx_apps_company(company)`, `idx_apps_applied(applied_at)`, plus
the automatic key index on `slug`.

The `doc` shape written by `log-application.mjs` is
`{ slug, company, title, applied_at, source_url, … }`, gaining `status` and
`follow_ups` later as outcomes are recorded.

`profile/applications.yaml` is written from this table after every change, by
`exportApplicationsYaml`. That file is **read back only to bootstrap a database
that does not exist yet** — never merged. The reasoning, quoted from
`scripts/lib/db.mjs`:

```
// The applications TABLE is the source of truth (user decision, 2026-07-29:
// applications are only ever created by scripts/applications/log-application.mjs after the
// user confirms a submission — nobody hand-edits them, so a file pretending to
// be authoritative bought nothing but a sync problem).
```

> **Known defect (2026-08-05 audit).** `writeApplication` re-reads the whole
> `applications` table and rewrites the whole YAML export on every single-row
> change — the exact per-mutation full rewrite that this file's own header says
> SQLite was adopted to eliminate. And `readApplications` parses the entire
> application history for every single-slug question;
> `scripts/applications/check-applied.mjs` calls it on the hot path before every
> tailor and every apply.

> **Known defect (2026-08-05 audit).** This table stores no `posted_at`. So the
> metric the schema calls "THE NUMBER THE PRODUCT IS ACTUALLY FOR" — how long a
> posting waits between going up and being applied to — cannot be computed for
> the attended path, which is the only path that runs today. `auto_queue` carries
> `posted_at` specifically to preserve that measurement; `applications` does not.

### 2.4 `screens` — screening verdicts, keyed by who produced them

Written by `recordScreens`. Read by `readScreens` and `screenIndex`.

| Column        | Type   | Nullable | Meaning                                                                     |
| ------------- | ------ | -------- | --------------------------------------------------------------------------- |
| `lead_id`     | `TEXT` | no (PK₁) | Which lead.                                                                 |
| `source`      | `TEXT` | no (PK₂) | Who judged it: `mechanical` or `model`. Validated against `SCREEN_SOURCES`. |
| `verdict`     | `TEXT` | **no**   | The judgement.                                                              |
| `screened_at` | `TEXT` | **no**   | ISO-8601 timestamp; also written into `doc`.                                |
| `doc`         | `TEXT` | **no**   | The verdict document verbatim — signals, reason, whatever a screen emits.   |

**Primary key:** `(lead_id, source)`.

**Index:** `idx_screens_source(source, verdict)`.

The `source` column is the whole point of the table, and the schema comment is
the clearest cost-control argument in the project:

```
-- The mechanical screen
-- (scripts/leads/screen.mjs) is regex over stored text and costs ~125 ms for
-- the entire store, so caching it saves nothing; it is kept because a verdict
-- with no history cannot be audited. The expensive source is "model" — the
-- pipeline-jobs Stage A read, which fetches the live posting and judges
-- ghost/scam/culture signals. That verdict used to be discarded, so
-- re-screening a lead paid for it again. Now it is looked up.
--
-- Latest verdict per (lead, source), not an append-only log: nothing reads
-- screening history, and a row per re-run grows without bound. A mechanical
-- verdict must never satisfy a caller looking for a model one, which is exactly
-- what a single-verdict-per-lead table would have allowed.
```

Two design ideas in one comment: this is a **latest-value-per-key** table rather
than an **append-only log**, because nobody reads history and history grows
forever; and the `source` in the key means a cheap verdict can never be
mistaken for an expensive one.

`recordScreens` validates every `source` against the exported set
`SCREEN_SOURCES` and throws `unknown screen source: …` — _inside_ the
transaction, so the whole batch rolls back rather than half-landing.

### 2.5 `documents` — archived job workspaces, one row per file

Written by `writeDocuments`, from `scripts/maintenance/archive.mjs`. Read by
`readDocuments`, `listDocuments`.

| Column        | Type      | Nullable | Meaning                                                     |
| ------------- | --------- | -------- | ----------------------------------------------------------- |
| `slug`        | `TEXT`    | no (PK₁) | Which job workspace.                                        |
| `name`        | `TEXT`    | no (PK₂) | File name within `jobs/<slug>/`, e.g. `resume.md`.          |
| `content`     | `BLOB`    | **yes**  | The exact bytes — or `NULL`, meaning "regenerable".         |
| `bytes`       | `INTEGER` | **no**   | Size in bytes, derived from `content`.                      |
| `sha256`      | `TEXT`    | **no**   | SHA-256 hash of the content, so a restore can prove itself. |
| `archived_at` | `TEXT`    | **no**   | ISO-8601 timestamp.                                         |

**Primary key:** `(slug, name)`.

**Index:** `idx_docs_slug(slug)` — redundant, see §0.5.

A **BLOB** is a _binary large object_: raw bytes, not text. A PDF is not text
and would be corrupted by being stored as one.

A **SHA-256 hash** is a fixed-length fingerprint of some bytes — 64 hexadecimal
characters. Change one byte of the input and the hash changes completely.
Storing it lets a restore verify it wrote back exactly what was archived, and
`restoreOne` in `scripts/maintenance/archive.mjs` does that check and refuses on
a mismatch.

**`content IS NULL` means "regenerable, deliberately not stored".** PDFs are
deterministic output of `scripts/documents/render-pdf.mjs`, so the markdown is
the artifact worth keeping and the PDF is rebuilt on demand. The classification
is one line in `archive.mjs`: any name matching `/\.pdf$/i` is regenerable. The
row survives with `content = NULL` so a restore can still say what was there.

`listDocuments` deliberately does not select `content`, so listing an archive
never pulls megabytes into memory to count them. Its SQL uses a neat SQLite
idiom worth knowing — in SQLite a boolean is 1 or 0, so summing one counts it:

```sql
SELECT slug, COUNT(*) files, SUM(bytes) bytes,
       SUM(content IS NULL) regenerable, MAX(archived_at) archived_at
  FROM documents GROUP BY slug ORDER BY archived_at DESC, slug
```

**This is the table that makes Part 6 necessary.** Its own comment:

```
-- Nothing rebuilds this table. Unlike leads (re-derivable from a sweep) and
-- applications (exported to YAML), an archived workspace has no other on-disk
-- source once the directory is gone — migrate.mjs must never touch it.
```

### 2.6 `board_stats` — job-board productivity over time

Written by `recordBoardStats`, from `scripts/leads/find-jobs.mjs`.

| Column               | Type      | Nullable | Meaning                                                     |
| -------------------- | --------- | -------- | ----------------------------------------------------------- |
| `board_id`           | `TEXT`    | no (PK)  | Identifier of the board.                                    |
| `type`               | `TEXT`    | yes      | Board family: `greenhouse`, `lever`, `ashby`, …             |
| `slug`               | `TEXT`    | yes      | The board's own slug on that ATS.                           |
| `company`            | `TEXT`    | yes      | Employer name.                                              |
| `last_swept`         | `TEXT`    | yes      | ISO-8601 timestamp of the most recent sweep.                |
| `live_postings`      | `INTEGER` | yes (0)  | Postings seen in the latest sweep. **Replaced** each sweep. |
| `qualifying`         | `INTEGER` | yes (0)  | Postings that passed the limits. **Replaced.**              |
| `solid`              | `INTEGER` | yes (0)  | Postings that looked genuinely good. **Replaced.**          |
| `leads_produced`     | `INTEGER` | yes (0)  | **Accumulates** across sweeps.                              |
| `last_qualifying_at` | `TEXT`    | yes      | When this board last yielded something solid.               |

**Primary key:** `board_id`. **No secondary indexes** — it is read whole.

Two different update semantics in one upsert, on purpose:
`leads_produced = board_stats.leads_produced + excluded.leads_produced`
accumulates, while the three snapshot counters take the newest sweep's numbers.

The `last_qualifying_at` value is decided on the _insert_ side as well as in the
conflict clause, and the comment records why:

```
// Must be decided here, not only in the ON CONFLICT branch: on a board's
// FIRST sweep there is no conflict, so a CASE in the update clause never
// runs and a productive board was being recorded as never having yielded.
```

That is a good example of a whole class of upsert bug: logic written only in the
`DO UPDATE` branch never runs the first time.

> **Known defect (2026-08-05 audit).** This table is written every sweep and read
> by nothing. `scripts/leads/board-yield.mjs` — the script whose job is board
> productivity — does not import `scripts/lib/db.mjs` at all and recomputes from
> the live boards instead.

### 2.7 `auto_runs` — one row per unattended run

Written by `upsertAutoRun` from `scripts/auto/audit.mjs`. Read by
`latestAutoRun` (the heartbeat `scripts/status.mjs` warns on when it is more
than 26 hours old) and by the orphan-attempt join in §2.8.

| Column              | Type      | Nullable | Meaning                                                          |
| ------------------- | --------- | -------- | ---------------------------------------------------------------- |
| `run_id`            | `TEXT`    | no (PK)  | e.g. `2026-08-04T17-53-38-730Z-3b1afb`.                          |
| `started_at`        | `TEXT`    | **no**   | ISO-8601.                                                        |
| `finished_at`       | `TEXT`    | yes      | `NULL` means the run never ended — it died.                      |
| `mode`              | `TEXT`    | yes      | `dry_run` or `live`.                                             |
| `outcome`           | `TEXT`    | yes      | `ok`, `stopped`, `error`, or `running`.                          |
| `planned`           | `INTEGER` | yes (0)  | Counter.                                                         |
| `submitted`         | `INTEGER` | yes (0)  | Counter.                                                         |
| `deferred`          | `INTEGER` | yes (0)  | Counter.                                                         |
| `failed`            | `INTEGER` | yes (0)  | Counter.                                                         |
| `stop_reason`       | `TEXT`    | yes      | Why the runner disabled itself, if it did.                       |
| `profile_sha_start` | `TEXT`    | yes      | JSON: `{"profile.yaml":"…","answers.yaml":"…"}` at start.        |
| `profile_sha_end`   | `TEXT`    | yes      | The same two hashes at the end.                                  |
| `jsonl`             | `TEXT`    | yes      | Path to the surviving append-only copy under `jobs/.auto/runs/`. |
| `doc`               | `TEXT`    | **no**   | The complete run record, verbatim.                               |

**Primary key:** `run_id`. **Index:** `idx_auto_runs_started(started_at)`.

`upsertAutoRun` is an upsert rather than an insert on purpose:

```
// Upsert, not insert: a run is written once at start (outcome 'running') and
// again at the end. A run that never gets its second write is a run that died,
// and it should be visible as 'running' with no finished_at rather than absent
// entirely — the silent no-op is the failure nobody notices.
```

Its conflict clause deliberately does **not** update `started_at` or
`profile_sha_start`, because those are facts about the beginning of the run.

The two `profile_sha_*` columns hold **two** hashes each, one per fact-base
file, stored as JSON text rather than combined into one digest — because "which
of the two changed" is the first question anyone asks, and a combined hash
destroys exactly that. What their differing _means_ is an alarm, not a detail:

```
-- The auto path is forbidden to write to profile/ at all, so these differing is
-- not an audit detail, it is an alarm: either something wrote the fact base
-- during an unattended run, or the user edited it mid-run and the run was
-- reasoning about a snapshot that no longer holds.
```

This table is **the second of two copies**. The first is the append-only JSONL
file under `jobs/.auto/runs/`, described in Part 5, and _that_ is the copy that
survives. The table exists because JSONL cannot be queried, and "how many times
have we written to this company this week?" is a cap question that must be
answered cheaply before the next submit.

> **Known defect (2026-08-05 audit).** `readAutoRuns` — the exported function for
> listing recent runs — has zero callers anywhere, including tests. So does
> `countCompanySubmissions`. Note that `countAutoSubmissions`, one letter apart,
> _is_ live and is used by `scripts/auto/caps.mjs` and `scripts/auto/digest.mjs`.

### 2.8 `auto_submissions` — the ledger, and the key decision

This is the table to understand if you understand only one.

| Column             | Type   | Nullable                       | Meaning                                                                       |
| ------------------ | ------ | ------------------------------ | ----------------------------------------------------------------------------- |
| `run_id`           | `TEXT` | **no**                         | Which run claimed it. Never re-attributed by an acknowledgement.              |
| `slug`             | `TEXT` | no (PK₁)                       | The job.                                                                      |
| `company`          | `TEXT` | yes                            | Employer name, for the per-company cap.                                       |
| `title`            | `TEXT` | yes                            | Job title.                                                                    |
| `submitted_at`     | `TEXT` | **no**                         | Of the **attempt**; refreshed when it is acknowledged.                        |
| `mode`             | `TEXT` | **no**, default `'live'` (PK₂) | `dry_run` or `live`.                                                          |
| `plan_sha256`      | `TEXT` | yes                            | Hash of the fill plan, so a retry with a different plan is visibly different. |
| `confirmation_url` | `TEXT` | yes                            | Where to go to withdraw the application.                                      |
| `outcome`          | `TEXT` | yes                            | `attempted`, `submitted`, `abandoned`, or `reconciled-not-sent`.              |
| `apply_url`        | `TEXT` | yes                            | Where the click was aimed — the one thing an orphaned attempt must still say. |
| `doc`              | `TEXT` | **no**                         | The verification block, consent labels actuated, screenshot paths.            |

**Primary key: `(slug, mode)`.**

**Indexes:** `idx_auto_subs_company(company, submitted_at)`,
`idx_auto_subs_at(submitted_at)`, `idx_auto_subs_run(run_id)`.

#### Why the row is written _before_ the click

A row here is not a record that something happened. It is a **claim** that
something is about to happen. `recordAutoSubmission` writes `outcome
= 'attempted'` immediately before a browser click; `acknowledgeAutoSubmission`
updates it to `'submitted'` afterwards.

```
-- 'attempted' means the runner was about to click and nothing has confirmed
-- what happened next; 'submitted' means the click returned and was recorded.
-- The caps count BOTH, because the failure this shape exists for is the
-- process being killed one second after the click (Task Scheduler's
-- ExecutionTimeLimit): the application is in the employer's ATS, and a ledger
-- that only knows about acknowledged submits would let the next run apply
-- again. An attempt is a submission until proven otherwise.
```

Read that last sentence as a design principle: when you cannot know, assume the
outcome that costs the user more if you are wrong.

#### Why the key is `(slug, mode)` — and what broke under the two alternatives

The whole point of the row is to **refuse** a second application. So the primary
key has to be exactly the thing that must not happen twice.

`recordAutoSubmission` returns the number of rows written. **1 means this caller
owns the submit. 0 means the slug already has a row in this mode and this caller
must not click.** That zero is control flow, not a diagnostic.

**Alternative one: key on `(run_id, slug)`.** This is the obvious first guess —
"one row per job per run". It is exactly backwards for a claim:

```
-- (run_id, slug) was backwards for a row whose job is to be a CLAIM: the same
-- slug could be submitted once per RUN with no conflict at all, so the ledger
-- could not refuse a second application to the same posting tomorrow.
```

Worked through: Monday's run has `run_id = "…monday…"` and writes
`("…monday…", "acme-fullstack")`. Tuesday's run has a different `run_id`, so
`("…tuesday…", "acme-fullstack")` is a **different key** and inserts cleanly.
The employer receives a second application to the same posting, and the ledger
that exists to prevent that reported success.

**Alternative two: key on `(slug)` alone.** This fixes Monday/Tuesday but breaks
the other direction, because dry-run rows live in this same table on purpose:

```
-- (slug) alone is wrong in the other direction: dry-run rows live in this same
-- table on purpose, so a rehearsal would pre-consume the live claim forever and
-- the first real run after an enable would find every slug already taken.
```

Worked through: you run a rehearsal with `auto_apply.dry_run: true`. It writes
`("acme-fullstack")` with `mode = 'dry_run'`. Later you enable live mode. The
first real run tries to claim `("acme-fullstack")`, collides with its own
rehearsal, gets 0, and refuses. Every slug you rehearsed is permanently
unappliable.

Why does the dry run write to the real ledger at all? Because the rehearsal has
to exercise the same cap arithmetic the live run will:

```
-- the point of the dry run is that its counts and its cap arithmetic are the
-- same ones a live run would have done, so a cap query that silently ignored
-- them would be testing different code than it protects.
```

**`(slug, mode)` satisfies both.** One live claim per posting, forever. One
rehearsal claim per posting, in its own namespace. And §0.7's `NOT NULL DEFAULT
'live'` is what keeps a missing `mode` from creating an unlimited third
namespace of un-refusable rows.

#### The one outcome that releases a claim

The upsert has a `WHERE` on its update branch:

```sql
ON CONFLICT(slug, mode) DO UPDATE SET … WHERE auto_submissions.outcome = 'reconciled-not-sent'
```

That literal is interpolated from the exported constant `RECONCILED_NOT_SENT` in
`scripts/lib/db.mjs` — safe because it is a code-owned string that never touches
user input.

The reason for the exception is a permanent-deadlock bug:

```
// The failure it fixes: the
// reconciler proves an orphaned attempt never reached the employer, but under a
// plain DO NOTHING the row still occupies (slug, mode) forever — so that slug
// reports 0 changes on every future run, fails as `db-write-failed` each time,
// and after two in a row pauses the board. A posting nobody applied to would
// become permanently unappliable, loudly, for the rest of the machine's life.
```

And the alternative that was proposed and rejected, which is worth reading as a
statement of what a ledger is:

```
// The critic's alternative — DELETE the row — is rejected and stays rejected:
// `auto_submissions` is the store of record for what was AIMED at an employer,
// and deleting evidence to unblock a retry is the shape hard rule 2 forbids for
// applications. A terminal outcome unblocks the retry and keeps the history.
```

**Widening that list of releasing outcomes re-opens the deadlock bug.** Every
other outcome — `attempted`, `submitted`, `abandoned` — still hits the `WHERE`
and reports 0.

#### The two accessors, and why only one retries

`recordAutoSubmission` (the claim) is wrapped in `withBusyRetry` — four
attempts, backing off 25 ms, 50 ms, 100 ms, roughly 175 ms total. Nothing else
in the file gets that:

```
// Every other write can be
// retried by re-running the command; this one is the record that a click is
// about to happen, and losing it means a crash one second later leaves an
// application in an employer's ATS that no ledger knows about.
// …
// BOUNDED, and short. An unbounded retry in front of a click is a process that
// hangs holding an authorisation token; four tries over ~175ms either gets the
// lock or reports honestly that it did not.
```

`acknowledgeAutoSubmission` is the opposite act and must **never** be dropped —
so it is an unguarded upsert, never a refusal. It uses `COALESCE` (which returns
the first non-`NULL` of its arguments) on the two URL columns, so acknowledging
an attempt cannot blank the URL the attempt recorded. And it deliberately does
not update `run_id`: the row belongs to the run that claimed it.

#### `readOrphanAttempts` — the crash brake

A **`LEFT JOIN`** returns every row from the left table, filling the right side
with `NULL` when there is no match. A plain `JOIN` would drop those rows. That
distinction is the whole query:

```sql
SELECT s.run_id, s.slug, s.company, s.submitted_at, s.mode, s.apply_url
  FROM auto_submissions s
  LEFT JOIN auto_runs r ON r.run_id = s.run_id
 WHERE s.outcome = 'attempted' AND (r.run_id IS NULL OR r.finished_at IS NULL)
 ORDER BY s.submitted_at
```

In words: _every attempt that was never acknowledged, whose run also never
finished_. That is the signature of a process killed between the click and the
acknowledgement. At the next startup the runner refuses to start until a human
has looked at the `apply_url`.

### 2.9 `auto_queue` — the per-application state machine

Written by `enqueueAutoJobs`, `claimAutoJob`, `setAutoJobState`,
`releaseStaleAutoClaims` and `strandPausedBoardJobs`.

| Column          | Type      | Nullable          | Meaning                                                             |
| --------------- | --------- | ----------------- | ------------------------------------------------------------------- |
| `slug`          | `TEXT`    | no (PK)           | The job. **The coordination primitive.**                            |
| `run_id`        | `TEXT`    | yes               | Which run holds it. `NULL` when enqueued but never claimed.         |
| `board_key`     | `TEXT`    | yes               | Which board, for grouping and for the breaker.                      |
| `origin`        | `TEXT`    | yes               | Which sweep/board/source put this slug in the queue.                |
| `state`         | `TEXT`    | **no**            | One of nine values, below.                                          |
| `attempt_no`    | `INTEGER` | **no**, default 0 | Incremented on each claim.                                          |
| `plan_sha256`   | `TEXT`    | yes               | Hash of the fill plan used.                                         |
| `reason_kind`   | `TEXT`    | yes               | A value from a **closed** vocabulary. Required for terminal states. |
| `reason_stage`  | `TEXT`    | yes               | Where in the state machine it stopped.                              |
| `reason_detail` | `TEXT`    | yes               | The sanitised human half. The only free-text column here.           |
| `posted_at`     | `TEXT`    | yes               | **Snapshotted**, not joined from `leads`.                           |
| `claimed_at`    | `TEXT`    | yes               | When a worker took it.                                              |
| `updated_at`    | `TEXT`    | yes               | Last change.                                                        |

**Primary key:** `slug`. **Indexes:** `idx_auto_queue_state(state)`,
`idx_auto_queue_run(run_id)`.

The states, exported as `AUTO_QUEUE_STATES`:

```
queued → claimed → planned → authorized → attempted
                                        → submitted | challenged | deferred | failed
```

The last four are **terminal** (`AUTO_QUEUE_TERMINAL`): nothing further happens.
The first four are **resumable** (`AUTO_QUEUE_RESUMABLE`) — after a crash the
next run may pick them up.

**`attempted` is in neither set, and that is the point.** A click may already
have reached the employer, so it is never retried automatically.
`releaseStaleAutoClaims` deliberately omits it from its state list, and
`readStrandedAutoJobs` exists to hand those rows to a human.

#### The claim, in one statement

`claimAutoJob` is a guarded upsert:

```sql
INSERT INTO auto_queue (slug, run_id, board_key, origin, state, attempt_no, plan_sha256, claimed_at, updated_at)
VALUES ($slug, $run_id, $board_key, $origin, 'claimed', 1, $plan_sha256, $at, $at)
ON CONFLICT(slug) DO UPDATE SET
  run_id = excluded.run_id,
  board_key = COALESCE(excluded.board_key, auto_queue.board_key),
  …
  state = 'claimed',
  attempt_no = auto_queue.attempt_no + 1,
  reason_kind = NULL, reason_stage = NULL, reason_detail = NULL,
  …
WHERE auto_queue.state = 'queued'
```

Two workers race for `acme-fullstack`, both running exactly this:

- **Worker A** arrives first. The row exists in `queued`, so the conflict fires,
  the guard `WHERE auto_queue.state = 'queued'` holds, the row becomes
  `claimed` with `run_id` A. **Returns 1.**
- **Worker B** arrives second. The conflict fires again, but `state` is now
  `claimed`, so the guard fails, nothing is written. **Returns 0.**

Because it is a _single statement_, SQLite serialises the two and there is no
window between "check" and "act" for the other worker to slip into. That is what
makes it an **atomic** operation, and atomicity is the only thing that makes a
claim a claim.

`scripts/auto/job.mjs` reads that zero and returns without touching anything —
writing a reason there would overwrite the owner's. Zero is the ordinary outcome
for every worker but one in a fan-out. It is not an error.

#### Why `posted_at` and `origin` are copied rather than looked up

```
-- posted_at is SNAPSHOTTED here rather than joined from leads … the metric it
-- feeds -- how long a posting waits between going up and being applied to --
-- must survive the lead being pruned or archived, and a join that silently
-- loses its oldest rows reports a latency distribution missing exactly the tail
-- anybody cares about.
```

`origin` is written and never read, on purpose: "a column added later cannot be
back-filled for the rows that mattered."

#### The closed reason taxonomy

`reason_kind` may only hold a value from one of three frozen lists in
`scripts/lib/db.mjs`:

- **`AUTO_DEFER_KINDS`** (20 values) — the machine did not understand something,
  or the environment declined. Not a malfunction: `confirm-field`,
  `confirm-widget`, `consent-tickbox`, `unknown-field`, `unprobed-dropdown`,
  `fill-failed`, `identity-verification`, `captcha`, `bot-challenge`,
  `email-code-challenge`, `multipage-unresolvable`, `freetext-disclosure`,
  `doc-unverified`, `fact-base-changed`, `board-untrusted`, `l3-rejected`,
  `cap-company`, `posting-gone`, `board-paused`, `reconciled-not-sent`.
- **`AUTO_FAILURE_KINDS`** (7 values) — the machine malfunctioned:
  `nav-timeout`, `browser-crash`, `token-refused`, `origin-mismatch`,
  `post-submit-unclassified`, `db-write-failed`, `plan-error`.
- **`AUTO_CHALLENGE_KINDS`** (3 values, a subset of the defer kinds) —
  `captcha`, `bot-challenge`, `email-code-challenge`. These are the only kinds a
  `challenged` row may carry, because `challenged` means "we do not know whether
  this landed".

`assertReasonKind` is the single gate. A `deferred`, `failed` or `challenged`
row with no kind throws:

```
a deferred job requires a reason_kind — a silent skip is not a deferral (hard rule 6)
```

Why a closed list rather than a sentence:

```
// A sentence cannot be aggregated: "unprobed dropdown" and "dropdown
// was not probed" are the same loss and two buckets, so the defer log could
// never answer "what did NOT understanding this board cost us this week?" —
// which is the one question that turns deferrals into a prioritised backlog.
```

That question is `readReasonCounts`, a `GROUP BY` over `(state, reason_kind,
reason_stage, board_key)`. Its output is the product's own backlog: the kinds at
the top are the applications a deterministic understanding of a board would
unlock.

> **Known defect (2026-08-05 audit).** `setAutoJobState`'s ownership guard is
> `AND ($run_id IS NULL OR run_id = $run_id)`. A row whose `run_id` is still
> `NULL` — which is how `scripts/auto/auto-apply.mjs` enqueues jobs, _before_ the
> run exists — matches neither branch when a `run_id` is supplied, so the update
> silently changes zero rows. Verified empirically: inserting a row with a `NULL`
> `run_id` and running that predicate with a real `run_id` returns
> `changes: 0`. The consequence is precisely the invisible loss bucket the
> surrounding comments say must not exist: those jobs stay `queued` with no
> `reason_kind`. `strandPausedBoardJobs`, in the same file, already carries the
> fix — its guard adds `OR auto_queue.run_id IS NULL` — and it is called by no
> production script.

> **Known defect (2026-08-05 audit).** `auto_queue` has no column for the apply
> URL, so a crash-resumed job cannot recover where it was pointed and terminally
> defers.

### 2.10 `board_pauses` — the circuit breaker's durable record

Written by `recordBoardPause` and `clearBoardPause` from
`scripts/auto/breaker.mjs`. Read by `readActiveBoardPauses`.

| Column          | Type   | Nullable | Meaning                                                   |
| --------------- | ------ | -------- | --------------------------------------------------------- |
| `board_key`     | `TEXT` | no (PK₁) | Which board was backed off from.                          |
| `run_id`        | `TEXT` | no (PK₂) | Which run paused it. **In the key on purpose.**           |
| `paused_at`     | `TEXT` | no (PK₃) | ISO-8601 instant.                                         |
| `until`         | `TEXT` | yes      | When the backoff expires and a probe may run.             |
| `reason_kind`   | `TEXT` | yes      | The kind whose signature tripped the breaker.             |
| `reason_detail` | `TEXT` | yes      | Human half.                                               |
| `cleared_at`    | `TEXT` | yes      | Set when a probe succeeded and the board was re-admitted. |

**Primary key:** `(board_key, run_id, paused_at)`. **Index:**
`idx_board_pauses_run(run_id)`.

The three-column key makes `recordBoardPause` **idempotent** — calling it twice
in the same millisecond for the same board and run is the same pause, and the
second call writes nothing. "Idempotent" means doing something twice has the
same effect as doing it once, which is a property you want in any operation a
retry might repeat.

`run_id` is in the key deliberately:

```
-- SCOPED BY run_id ON PURPOSE. A pause is a timed backoff with probe
-- re-admission, never terminal, and never inherited by the next invocation
-- without re-probing -- so readers ask for one run's pauses and a fresh run
-- starts with none. The row survives the process because the DIGEST needs it
-- after the run is over, not because the next run should obey it.
```

**A board pause is not the same thing as a board STOP.** A pause is a timed
backoff cleared by one successful probe. A scoped STOP is a durable brake only a
human clears, and it lives elsewhere. `CLAUDE.md` names this distinction because
conflating them removes a safety property.

`readActiveBoardPauses` returns each uncleared pause together with the number of
jobs it is holding, using a **correlated subquery** — a subquery that runs once
per outer row and refers to that row's values:

```sql
(SELECT COUNT(*) FROM auto_queue q
  WHERE q.board_key = p.board_key
    AND q.state IN ('queued','claimed','planned','authorized')) AS held
```

"Holding" counts only resumable states. A job that already reached a terminal
state was not held by anything.

### 2.11 `verifications` — what `verify-claims` decided, made durable

Written by `recordVerification`. Read by `hasPassingVerification`, which is what
`scripts/auto/submit.mjs` and `scripts/auto/auto-apply.mjs` call to enforce hard
rule 4.

| Column           | Type   | Nullable | Meaning                                                  |
| ---------------- | ------ | -------- | -------------------------------------------------------- |
| `slug`           | `TEXT` | no (PK₁) | Which job workspace.                                     |
| `doc_sha256`     | `TEXT` | no (PK₃) | Hash of the **exact bytes** that were checked.           |
| `mode`           | `TEXT` | no (PK₂) | `resume` or `cover-letter`. Validated by `VERIFY_MODES`. |
| `verdict`        | `TEXT` | **no**   | `pass` or `fail`.                                        |
| `profile_sha256` | `TEXT` | **no**   | Hash of the **fact base** they were checked against.     |
| `verified_at`    | `TEXT` | **no**   | ISO-8601.                                                |
| `doc`            | `TEXT` | yes      | The `verify-claims` report, verbatim.                    |

**Primary key:** `(slug, mode, doc_sha256)`. **Index:**
`idx_verifications_slug(slug, mode)` — redundant, see §0.5.

Before this table existed, verification wrote nothing durable: the only evidence
that a document had passed was that a `resume.md` file existed on disk. Which
means every tailored file was "verified" whether it had ever been checked or
not — a hard rule 1 hole reachable by accident, on the path that submits
unattended.

**The row is only evidence while both hashes still hold.**

- `doc_sha256` pins the bytes, so editing the resume invalidates its own
  verification.
- `profile_sha256` pins the facts, so the user editing `profile.yaml`
  invalidates every outstanding verification at once.

```
-- A resume verified against yesterday's facts is not verified today --
-- the corpus R3/R4/R5/R6 compared it to no longer exists.
```

`hasPassingVerification` requires **both** hashes to match and the verdict to be
`pass`. It returns `false` immediately if any of its inputs is missing. A match
on `doc_sha256` alone means the document is unchanged but the facts behind it
are not the ones it was checked against — a stale verdict about a corpus that no
longer exists.

The fact-base hash is computed by exactly one function, `factBaseSha256` in
`scripts/lib/verification.mjs`, used by both the writer and the reader — because
a writer and a reader that hash the fact base differently agree on nothing and
**fail open** (that is, wrongly allow the thing they were meant to block).

`recordVerification` coerces the verdict: anything that is not exactly the
string `"pass"` is stored as `"fail"`. That is **failing closed** by
construction. It also throws a `TypeError` if either hash is missing, with the
message "a row missing either is not evidence of anything".

> **Known defect (2026-08-05 audit).** `verifiedResumeUrls` in
> `scripts/lib/verification.mjs` issues an N+1 query — one `SELECT DISTINCT` for
> the slug list, then a fresh `db.prepare` inside the loop for each slug, because
> `hasPassingVerification` prepares its statement inline on every call. "N+1"
> means one query to get a list plus one more per item, where a single query
> would do.

### 2.12 `workspace_stacks` — a strict cache

Written by `upsertWorkspaceStack`, read by `readWorkspaceStacks`, for
`scripts/documents/reuse-check.mjs`.

| Column       | Type   | Nullable | Meaning                                        |
| ------------ | ------ | -------- | ---------------------------------------------- |
| `slug`       | `TEXT` | no (PK)  | Which job workspace.                           |
| `job_sha256` | `TEXT` | **no**   | Hash of the `job.json` this was computed from. |
| `title`      | `TEXT` | yes      | Job title.                                     |
| `company`    | `TEXT` | yes      | Employer.                                      |
| `stack`      | `TEXT` | **no**   | JSON array of canonical technology terms.      |
| `title_toks` | `TEXT` | **no**   | JSON array of title tokens.                    |
| `updated_at` | `TEXT` | **no**   | ISO-8601.                                      |

**Primary key:** `slug`. **No secondary indexes.**

```
-- Derived data, cheap to rebuild, and it is a CACHE in the strict
-- sense: nothing may read it as a source of truth.
--
-- job_sha256 is the invalidation, and it is the whole design. A cached row is
-- used only when it matches the sha256 of the job.json currently on disk, so
-- an edited posting recomputes and a stale row can never be believed.
```

**A keyed cache whose key does not cover its input fails open.** That sentence
is the general lesson: if you cache a computation, the cache key must include
everything the computation depended on, or you will serve an answer that was
right for different inputs.

`upsertWorkspaceStack` refuses a row with no `job_sha256`, with the message "a
cache row with no invalidation key is worse than no row". And
`readWorkspaceStacks` **swallows** a row whose JSON will not parse rather than
throwing — because this is a cache, and an unreadable entry must degrade to a
recompute, never to a crash in a script whose job is to rank resumes.

### 2.13 The index inventory

Verified by reading `sqlite_master` from the live database.

| Table              | Declared indexes                                                                                              | Automatic (from the key)         |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `leads`            | `idx_leads_status(status)`, `idx_leads_company(company)`, `idx_leads_posted(posted_at)`                       | `(id)`                           |
| `lead_keywords`    | `idx_kw_keyword(keyword)`                                                                                     | `(lead_id, keyword)`             |
| `applications`     | `idx_apps_company(company)`, `idx_apps_applied(applied_at)`                                                   | `(slug)`                         |
| `screens`          | `idx_screens_source(source, verdict)`                                                                         | `(lead_id, source)`              |
| `documents`        | `idx_docs_slug(slug)`                                                                                         | `(slug, name)`                   |
| `board_stats`      | —                                                                                                             | `(board_id)`                     |
| `auto_runs`        | `idx_auto_runs_started(started_at)`                                                                           | `(run_id)`                       |
| `auto_submissions` | `idx_auto_subs_company(company, submitted_at)`, `idx_auto_subs_at(submitted_at)`, `idx_auto_subs_run(run_id)` | `(slug, mode)`                   |
| `auto_queue`       | `idx_auto_queue_state(state)`, `idx_auto_queue_run(run_id)`                                                   | `(slug)`                         |
| `board_pauses`     | `idx_board_pauses_run(run_id)`                                                                                | `(board_key, run_id, paused_at)` |
| `verifications`    | `idx_verifications_slug(slug, mode)`                                                                          | `(slug, mode, doc_sha256)`       |
| `workspace_stacks` | —                                                                                                             | `(slug)`                         |

**16 declared + 12 automatic = 28 total.** Every table has a non-`INTEGER`
primary key, which is why every one gets an automatic index — and, per §0.7, why
every one is in principle exposed to the `NULL`-in-a-key trap.

Which of them are actually protected is worth reading off the schema, because
the pattern is not uniform:

- **Every composite key spells out `NOT NULL` on all its columns.**
  `lead_keywords(lead_id, keyword)`, `screens(lead_id, source)`,
  `documents(slug, name)`, `auto_submissions(slug, mode)`,
  `board_pauses(board_key, run_id, paused_at)` and
  `verifications(slug, mode, doc_sha256)` are all fully guarded.
- **The six single-column keys do not.** `leads.id`, `applications.slug`,
  `board_stats.board_id`, `auto_runs.run_id`, `auto_queue.slug` and
  `workspace_stacks.slug` are declared as bare `TEXT PRIMARY KEY`.

Do not read that second group as safe because it is a single column. Checked
directly against `node:sqlite`, `CREATE TABLE t (id TEXT PRIMARY KEY)` accepts
two rows with `id` `NULL` and stores both. Those six are protected only by the
fact that every code path that writes them always supplies a value — never by
the database. `auto_submissions.mode` is the one that carries an explicit
`NOT NULL DEFAULT`, and it does so because that is the one where a caller
genuinely could have omitted it and the consequence was un-refusable duplicate
applications.

### 2.14 No migrations, three narrow repairs

Real systems change shape. Most projects handle that with a **migration chain**:
a numbered series of scripts, each turning schema version N into version N+1,
with a version number stored in the database.

This project has none. `CREATE TABLE IF NOT EXISTS` handles new tables, and
three targeted "heal" functions in `scripts/lib/db.mjs` handle the three shape
changes that actually happened. All three run **before** `db.exec(SCHEMA)`, and
that ordering is load-bearing.

`CREATE TABLE IF NOT EXISTS` has exactly one blind spot: a table whose _shape_
changed is left alone, because it already exists.

**`healScreens`** — the `screens` table gained its `source` column after being
built and never written to. It checks with `PRAGMA table_info(screens)` (a
SQLite statement that lists a table's columns), returns immediately on a fresh
database or an already-healed one, and then:

- If the old table holds **zero** rows, `DROP TABLE screens` and let `SCHEMA`
  rebuild it. Rebuilding an empty table is not a migration; there is nothing to
  migrate.
- If it holds any rows, **throw** rather than drop, with a message telling the
  user to back up `jobs/leads.db` and drop the table themselves. Silently
  discarding recorded verdicts to fix a schema is the kind of repair that loses
  data.

It must run before `SCHEMA` because `SCHEMA` creates an index on
`screens(source, verdict)`, and _that statement_ is the one that fails against
the old shape.

**`healAutoSubmissions`** — two halves.

First, additive: `ALTER TABLE auto_submissions ADD COLUMN outcome TEXT` and the
same for `apply_url`, when missing. `ADD COLUMN` rather than a drop-and-rebuild
because these rows are submitted applications and no version of this repair is
allowed to lose one. Existing rows get `NULL`, and `readOrphanAttempts` treats
`NULL` as "not an attempt" — correct, since every row written before that column
existed was written _after_ its click.

Second, the re-key. **A primary key cannot be changed with `ALTER TABLE`.** The
key moved from `(run_id, slug)` to `(slug, mode)`, so `rebuildAutoSubmissions`
copies every row into a new table with the new key and renames it into place.
Two decisions the no-losses rule forces:

- A legacy row with a `NULL` `mode` becomes `'live'` — §0.7's reason exactly.
- Two rows **can** collide on the new key (the same slug under two `run_id`s,
  which the old key permitted by construction). The survivor is chosen by
  `submissionRank`: `submitted` (4) beats a legacy `NULL` outcome (3), which
  beats `attempted` (2), which beats `abandoned` (1), with later `submitted_at`
  breaking ties. **The losers are not dropped** — each is carried verbatim into
  the survivor's `doc` under a `superseded` key, "because the thing a user needs
  when withdrawing an application is the record of it, not a tidy table."

And the check that turns the promise into a refusal, run _before_ the old table
is destroyed:

```js
const kept = db
  .prepare("SELECT COUNT(*) c FROM auto_submissions__rekeyed")
  .get().c
if (kept !== groups.size)
  throw new Error(
    `auto_submissions rebuild kept ${kept} of ${groups.size} distinct (slug, mode) row(s)`,
  )
```

The whole rebuild runs inside `BEGIN IMMEDIATE` and rolls back on any throw.

One ordering consequence: dropping the old table also drops
`idx_auto_subs_company`, `idx_auto_subs_at` and `idx_auto_subs_run`. They come
back only because `db.exec(SCHEMA)` runs _after_ the heals. Reorder those two
and the ledger silently loses its indexes.

**`healAutoQueue`** — purely additive: `ADD COLUMN reason_stage TEXT` and
`ADD COLUMN posted_at TEXT` when missing. Existing rows get `NULL`, which reads
as "stage unknown" and is the truth.

---

## Part 3 — `jobs/<slug>/`, the per-job workspace

A **slug** is a short, lowercase, hyphenated name derived from the employer and
the title — `twilio-swe-l4`, `render-swe-compute-infra`. It is the folder name,
and it is the key that ties the workspace to the `applications`, `verifications`
and `auto_queue` rows.

The folder is created by `scripts/documents/new-job.mjs`, which writes the first
two files. Everything else is added by later stages. A workspace with only
`job.json`, `context.json`, `scan-p1.json` and a fill plan is a job that was
scanned but never tailored; a workspace with PDFs is one that reached the
approval step.

| File                                           | Written by                                                  | Read by                                                 | What it is                                                     |
| ---------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------- |
| `job.json`                                     | `scripts/documents/new-job.mjs`                             | every tailoring and apply script                        | The captured posting. Schema: `schemas/job.schema.json`.       |
| `context.json`                                 | `scripts/documents/new-job.mjs`, then both tailoring skills | both tailoring skills                                   | Shared tailoring state. Schema: `schemas/context.schema.json`. |
| `keywords.json`                                | `scripts/documents/keyword-plan.mjs`                        | `scripts/documents/ats-lint.mjs`, the tailoring skill   | Which posting terms may be mirrored, and which may not.        |
| `resume.md`                                    | `scripts/documents/assemble-resume.mjs`                     | `verify-claims.mjs`, `render-pdf.mjs`, `auto-apply.mjs` | The tailored resume, with fact citations.                      |
| `resume-selection.json`                        | `scripts/documents/assemble-resume.mjs`                     | diagnostics                                             | Which profile items were included and why.                     |
| `cover-letter.md`                              | the cover-letter skill                                      | `verify-claims.mjs`, `render-pdf.mjs`, `auto-apply.mjs` | The tailored cover letter.                                     |
| `resume.render.html`                           | `scripts/documents/render-pdf.mjs`                          | `scripts/documents/ats-lint.mjs`                        | The intermediate HTML the PDF was made from.                   |
| `resume.pdf`                                   | `scripts/documents/render-pdf.mjs`                          | the user; uploaded to forms                             | The final document. **Regenerable.**                           |
| `cover-letter.render.html`, `cover-letter.pdf` | same                                                        | same                                                    | Same, for the letter.                                          |
| `scan-p1.json`                                 | the apply skill's browser scanner                           | `scripts/apply/fill-plan.mjs`                           | What the application form looks like, page 1.                  |
| `scan-p2.json`                                 | same, for a second page                                     | same                                                    | Page 2 of a multi-page form.                                   |
| `fill-plan.json`                               | `scripts/apply/fill-plan.mjs`                               | `scripts/apply/pending-questions.mjs`, tests, the user  | The plan data alone — human-readable.                          |
| `fill-plan.js`                                 | `scripts/apply/fill-plan.mjs`                               | the browser, via `page.evaluate`                        | A self-contained bootstrap bundle. Large.                      |

### 3.1 `job.json` — the captured posting

Validated by `validateJob` in `scripts/lib/lib.mjs`; the shape is written down
in `schemas/job.schema.json`. Required: `slug`, `company`, `title`.

```json
{
  "slug": "acme-senior-fullstack",
  "company": "Acme Robotics",
  "title": "Senior Full-Stack Engineer",
  "source_url": "https://boards.greenhouse.io/acme/jobs/4412",
  "location": "Remote (US)",
  "captured_at": "2026-08-01",
  "description": "We are looking for an engineer to …",
  "requirements": ["3+ years with React", "Experience with PostgreSQL"],
  "questions": ["Are you authorized to work in the US?"]
}
```

Two fields carry safety meaning and are worth reading the schema's own
descriptions for.

**`description` is not verbatim.** The schema says so:

> posting text after `scripts/lib/untrusted.mjs` has stripped the known
> injection carriers — NOT verbatim. It is still third-party data, never
> instructions (hard rule 0).

**`untrusted_findings` is omitted entirely when the posting is clean**, so an
honest posting's `job.json` is byte-for-byte what it would have been before the
field existed. When present it records _what the posting tried_ without ever
reproducing the payload:

```json
"untrusted_findings": [
  { "kind": "override_instructions", "count": 2,
    "fingerprint": "9f3c1a7b2e04", "shape": "len=118 words=19" }
]
```

The schema explains the omission of the text in as many words: an earlier
version had a `sample` field that re-emitted 120 raw characters of the attack
into the very file the tailoring model reads. The `fingerprint` is 12 hex
characters of a SHA-256 — enough to correlate the same attack across postings,
not enough to reconstruct it.

### 3.2 `context.json` — the shared tailoring state

Validated by `validateContext` in `scripts/lib/lib.mjs`; schema in
`schemas/context.schema.json`. This is the file that keeps the resume and the
cover letter consistent — both skills read and write it.

Here is a real one, freshly created (a workspace that has been scanned but not
yet tailored):

```json
{
  "slug": "twilio-swe-l4",
  "analysis": {
    "key_requirements": [],
    "matched_fact_ids": [],
    "gaps": [],
    "keywords": [],
    "tone": null
  },
  "consistency": {
    "emphasized_skills": [],
    "lead_experience": null,
    "notes": null
  },
  "resume": { "status": "pending", "facts_used": [], "dropped": [] },
  "cover_letter": { "status": "pending", "facts_used": [], "key_points": [] },
  "pending_questions": []
}
```

Field meanings:

- `analysis.key_requirements` — what the posting asks for.
- `analysis.matched_fact_ids` — **fact ids** (Part 4) the profile can honestly
  offer against those requirements.
- `analysis.gaps` — requirements the profile **cannot** truthfully cover. Being
  explicit here is what stops the next stage inventing something.
- `analysis.keywords` — posting vocabulary to mirror _where truthful_.
- `consistency.lead_experience` — the fact id both documents lead with, so they
  do not tell two different stories.
- `resume.status` / `cover_letter.status` — one of `pending`, `drafted`,
  `verified`, `approved`, `rendered`. `validateContext` rejects anything else.
- `resume.dropped` — fact ids intentionally omitted, with why. This is what
  hard rule 5's "show what was emphasized/dropped/rephrased" is built from.
- `pending_questions` — form questions awaiting a user answer.

> **Known defect (2026-08-05 audit).** A model fills `context.analysis` even
> though two deterministic scripts already compute most of it —
> `scripts/documents/keyword-plan.mjs` computes the evidenced/blocked split, and
> `scripts/documents/assemble-resume.mjs` reports which items it included and
> why.

### 3.3 `keywords.json` — what may and may not be mirrored

Written by `scripts/documents/keyword-plan.mjs`. Two lists:

- **`must_use`** — the _intersection_ of the posting's technology terms and the
  fact base. Every term here is one the profile can already evidence, so
  mirroring the posting's wording is honest.
- **`blocked`** — the posting's _other_ terms, listed precisely so they stay
  out. Each carries a `why`, and the standard one is "not present in
  profile.yaml or answers.yaml — verify-claims R6 will reject it".

This is hard rule 1 expressed as data before a model ever sees the posting: the
list of words it is allowed to echo is computed, not judged.

### 3.4 `resume.md` and its citations

The tailored resume is markdown. Every bullet carries an HTML comment naming the
profile facts it rests on:

```markdown
- Built and deployed a customer portal serving 100+ users <!-- fact:exp-acme-b1 -->
- Shipped a React and PostgreSQL demo application <!-- fact:prj-demo-b1,skill-lang -->
```

An HTML comment is invisible when the markdown is rendered, so the PDF the
employer receives shows only the sentence. The comment is there for the
verifier. Part 4.3 covers exactly what it is checked against.

### 3.5 `scan-p1.json` — what the form looks like

Produced in the browser by the apply skill's scanner. One entry per field, with
short keys because this JSON crosses a browser boundary and size matters:

```json
{
  "url": "https://job-boards.greenhouse.io/acme/jobs/4412",
  "heading": "Senior Full-Stack Engineer",
  "kind": "form",
  "fields": [
    {
      "k": "f11",
      "sel": "#first_name",
      "ac": "given-name",
      "t": "text",
      "l": "First Name",
      "lSeen": "First Name*",
      "req": true
    },
    {
      "k": "f1",
      "t": "combo",
      "l": "Country",
      "opts": ["United States +1", "Afghanistan +93", "…"]
    }
  ]
}
```

| Key     | Meaning                                                                |
| ------- | ---------------------------------------------------------------------- |
| `k`     | A stable within-page key for this field.                               |
| `sel`   | A CSS selector the browser can use to find it again.                   |
| `ac`    | The page's own `autocomplete` attribute, when it has one.              |
| `t`     | Widget type: `text`, `combo`, `select`, `checkbox`, `radio`, `file`, … |
| `l`     | The label the scanner **matched on** — the canonical form.             |
| `lSeen` | The label as the page **displays** it, when the two differ.            |
| `req`   | Whether the form marks it required.                                    |
| `opts`  | The option list, for a dropdown that was probed.                       |

The `l` versus `lSeen` split matters: `First Name*` is what the page shows, and
`First Name` is what everything matches on. Keys and caches are built from `l`.

### 3.6 `fill-plan.json` and `fill-plan.js`

`scripts/apply/fill-plan.mjs` takes a scan and produces two files. The `.json`
is the plan; the `.js` is a self-contained bundle that carries the plan **and**
the source of `scripts/apply/fill-engine.mjs` embedded as strings, loaded into
the page whole. (The bundling is not an optimisation — it is required, because
some boards serve a Content-Security-Policy that blocks the ordinary way of
adding a script to a page.)

The plan's shape, with the values replaced by placeholders:

```json
{
  "v": 1,
  "slug": "acme-senior-fullstack",
  "ats": "greenhouse",
  "urlGuard": "https://job-boards.greenhouse.io/acme/jobs/4412",
  "pageGuard": ["#first_name", "#last_name", "#email", "#phone"],
  "comboStrategies": ["type-enter", "type-click", "click-option"],
  "items": [
    {
      "k": "f11",
      "sel": "#first_name",
      "how": "fill",
      "value": "<the user's first name>",
      "label": "First Name*",
      "matchedLabel": "First Name"
    },
    {
      "k": "f1",
      "how": "combo",
      "value": "United States +1",
      "label": "Country*"
    }
  ]
}
```

- `urlGuard` and `pageGuard` are safety checks: the engine refuses to fill if
  the page it finds is not the page the plan was built for.
- `items[].how` is the action: `fill` for a text box, `combo` for a custom
  dropdown, and so on.
- `matchedLabel` rides along whenever the displayed label and the matched label
  differ, so the field cache can be looked up by the matched one.

**This file contains the user's real personal details** — name, email, phone,
address as they will be typed into the form. It lives under `jobs/`, which is
gitignored, and it never leaves the machine.

Anything the fact base cannot answer is **deferred**, never guessed. Consent,
terms, arbitration and e-signature fields are always deferred on the unattended
path, unconditionally.

---

## Part 4 — `profile/`, the fact base

This is the most important directory in the project and the one the agent is
forbidden to edit. A PreToolUse hook blocks writes to it. New information gets
in through exactly one door: `scripts/profile/save-answer.mjs`, run after asking
the user in chat.

Everything here except `profile.example.yaml` is gitignored and never leaves the
machine.

### 4.1 `profile.yaml` — the structured facts

The real file is private. The committed template
`profile/profile.example.yaml` shows the shape, and this is that template in
full — the names in it are fictional:

```yaml
meta:
  version: 1
  target_role: Full-Stack Developer
  approved_by_user: false

contact:
  name: Jane Developer
  location: Springfield, USA
  phone: "(555) 555-5555"
  email: jane@example.com
  linkedin: https://www.linkedin.com/in/jane-developer
  github: https://github.com/jane-developer
  website: null

summary:
  - id: summary-fs
    text: Full-stack developer with experience building production web apps.

experience:
  - id: exp-acme
    title: Full-Stack Developer
    company: Acme Corp
    dates: Jan 2024 – Present
    bullets:
      - id: exp-acme-b1
        text: Built and deployed a customer portal using React and Node.js.

projects:
  - id: prj-demo
    name: Demo Project
    tech: React, PostgreSQL
    year: "2026"
    bullets:
      - id: prj-demo-b1
        text: Built a demo application serving 100+ users.

skills:
  - id: skill-lang
    group: Languages
    items: [TypeScript, Python]

education:
  - id: edu-state
    school: State University
    degrees: B.S. Computer Science
    graduated: Jun 2023
    gpa: "3.50"
    coursework: [Algorithms, Data Structures]

organizations: []
extras: []
```

**YAML** is a text format for structured data, like JSON but with indentation
instead of braces. It is used here because a human edits this file directly.

One field decides whether the pipeline will do real work:
`meta.approved_by_user` must be `true` before real tailoring runs. The example
ships with `false`.

### 4.2 What a fact id is

**Every item in `profile.yaml` carries a stable `id`.** That id is what a
tailored document cites, and it is the entire mechanism behind hard rule 1.

`buildFactIndex` in `scripts/lib/lib.mjs` walks the whole profile and builds a
`Map` from id to `{ id, text }`. The `text` is what the verifier is allowed to
compare a claim against, and how it is assembled differs per section:

| Section         | Ids added                     | The `text` for each                                                      |
| --------------- | ----------------------------- | ------------------------------------------------------------------------ |
| `summary`       | `s.id`                        | `s.text`                                                                 |
| `experience`    | `exp.id` and each `bullet.id` | for the role: `"<title> <company> <dates>"`; for a bullet: `b.text`      |
| `projects`      | `prj.id` and each `bullet.id` | for the project: `"<name> <tech> <year> <role>"`; for a bullet: `b.text` |
| `skills`        | `sk.id`                       | `"<group>: <item, item, …>"`                                             |
| `education`     | `edu.id`                      | school, degrees, graduation, GPA, honours and coursework joined          |
| `organizations` | `org.id`                      | `org.text`                                                               |
| `extras`        | `ex.id`                       | `ex.text`                                                                |
| `answers.yaml`  | `a.id`                        | `"<question> <answer>"`                                                  |

`buildFactIndex` **throws on a duplicate id** — `Duplicate fact id: exp-acme-b1`
— because two facts sharing an id makes every citation ambiguous.

Naming is by convention, not enforced: `exp-` for a role, `exp-<x>-b1` for its
first bullet, `prj-` for a project, `skill-` for a skill group, `edu-` for
education, `a-001` for an answer. The convention is what makes a citation
readable to a human.

### 4.3 How a resume bullet cites a fact

`scripts/documents/verify-claims.mjs` looks for exactly this pattern, defined by
one regular expression:

```js
const FACT_RE = /<!--\s*fact:\s*([A-Za-z0-9_,\s-]+?)\s*-->/
```

So `<!-- fact:exp-acme-b1 -->` and `<!-- fact:prj-demo-b1, skill-lang -->` both
parse; multiple ids are comma-separated.

The rules it enforces in resume mode, from the file's own header:

| Rule | What it checks                                                                  |
| ---- | ------------------------------------------------------------------------------- |
| R1   | Every bullet line must carry a `<!-- fact:ID -->` annotation.                   |
| R2   | Every cited fact id must exist in the index.                                    |
| R3   | Every **number** in an annotated bullet must appear in a **cited** fact's text. |
| R4   | Every number outside bullets must appear somewhere in the corpus.               |
| R5   | Every `Mon YYYY` date token must appear in the corpus.                          |
| R6   | Every known technology term in the document must appear in the corpus.          |
| R7   | The document must contain at least one annotated bullet.                        |

R3 is the strictest and the most useful. Take this bullet:

```markdown
- Built a portal serving 5,000 users <!-- fact:exp-acme-b1 -->
```

against the fact text "Built and deployed a customer portal using React and
Node.js". `extractNumbers` finds `5000` in the bullet and nothing in the fact, so
the verifier emits:

```
R3  line 12  Number "5000" not present in cited fact(s) [exp-acme-b1]
```

A number that was invented cannot pass, because the check is not "does this
sound plausible" but "is this digit sequence in the text you cited".

> **Known defect (2026-08-05 audit).** `FACT_RE` matches only the _first_
> annotation on a line. Given
> `- Shipped apps <!-- fact:exp-1-b1 --> <!-- fact:exp-2 -->`, the second
> comment's own id is left in the line content, so R3 sees the digit `2` from
> `exp-2` as a number in the bullet and reports
> `Number "2" not present in cited fact(s) [exp-1-b1]` — and `exp-2` is never
> resolved as a citation at all.

### 4.4 `answers.yaml` — the answer bank

The second half of the fact base: answers to application-form questions, so the
same question is never asked twice. The real file is private; this is the
committed test fixture `tests/fixtures/answers-bank.yaml`, which shows the exact
shape:

```yaml
answers:
  - id: a-001
    question: Are you authorized to work in the US?
    answer: Yes, US citizen, no sponsorship needed.
    added: 2026-07-27
  - id: a-002
    question: Are you legally authorized to work in the United States?
    answer: "Yes"
    added: 2026-07-27
  - id: a-003
    question: Will you now or in the future require sponsorship for employment visa status?
    answer: "No"
    added: 2026-07-27
```

Entries written by `save-answer.mjs` also carry provenance fields: `source`
(`user` — the user said it in chat — or `model`, meaning the agent picked a form
option and the user approved that pick in the approval message) and `class`
(`datum` for a fact, `assertion` for something the user _asserts_ rather than
states, like work authorisation).

#### Why the question text is treated as hostile

An answer comes from the user. **The question does not** — it is a form label
copied off an employer's page. `save-answer.mjs` runs both through
`scripts/lib/untrusted.mjs` and **refuses** rather than storing a redacted
version, exiting 3. Its own reasoning:

```
// A hostile label is therefore worth more to an attacker than a hostile job
// description: the description influences one tailoring run, an entry in
// answers.yaml influences all of them.
```

Because an entry here is permanent, global to every future application, and part
of the evidence corpus that decides what may appear on the user's resume.

Exit 4 is a government or financial identifier, and **exit 4 has no override by
design**.

#### The trap that makes question text unusable as evidence

`answers.yaml` stores the question as well as the answer, and the fact index
concatenates both. But the _evidence corpus_ — the text a claim may be checked
against — must not include the question, and `evidenceText` in
`scripts/lib/lib.mjs` is the function that enforces that. The reason, quoted:

```
// application forms ask questions that enumerate technologies:
//
//   question: "Which of these do you have experience with? [1 = REST APIs;
//              ... 4 = Spring / Spring Boot; 5 = Cloud (AWS, Azure, or GCP)]"
//   answer:   "1, 2, 3, 5"
//
// Treating that whole record as evidence made "Azure" and "Spring" pass
// verify-claims R6 — so a tailored resume could have claimed Spring Boot
// experience the user explicitly did NOT select, and Azure when what they have
// is AWS.
```

**`answers.yaml` question text is not evidence.** Use `evidenceText()`. This is
on `CLAUDE.md`'s never-fix-this-back list for exactly this reason.

### 4.5 `applications.yaml` and `profile/source/`

`profile/applications.yaml` is a **generated export** of the `applications`
table, rewritten after every change. It is read back only to bootstrap a
database that does not exist yet.

`profile/source/` holds the user's original resume and cover letter — the
documents `profile.yaml` was built from.

---

## Part 5 — the caches and ledgers

Four things live outside both the database and the job workspaces. Two are
caches, two are ledgers.

### 5.1 `jobs/.field-cache.json` — remembered form shapes

**What it remembers:** for each distinct _form shape_ the pipeline has seen,
every field's widget type, visible label, whether it is required, its CSS
selector, its option list, and (once learned) which strategy successfully filled
its custom dropdowns.

**Why:** the expensive half of a page scan is probing custom dropdowns. The
scanner has to open each one in the browser, wait for the menu to render, read
the options, and close it — up to fifteen of them, measured at 1.5–2.5 seconds
each. Everything it learns is identical the next time, so it only needs learning
once.

**Shape:**

```json
{
  "v": 4,
  "forms": {
    "ed2bfaa469e89884": {
      "ats": "greenhouse",
      "url": "https://job-boards.greenhouse.io/acme/jobs/4412",
      "updated": "2026-08-06",
      "comboStrategy": "type-enter",
      "fields": {
        "first name|text": {
          "t": "text",
          "l": "First Name",
          "req": true,
          "sel": "#first_name"
        },
        "phone|combo": {
          "t": "combo",
          "l": "Phone",
          "opts": ["United States +1", "…"],
          "optsTotal": 249,
          "optsTruncated": true,
          "via": "type-enter"
        }
      }
    }
  }
}
```

**How it is keyed.** Not by URL. By a **fingerprint** — `fingerprint` in
`scripts/apply/field-cache.mjs` takes a SHA-1 hash of
`"<ats id>|<host>|<sorted required labels>"` and keeps sixteen hex characters.
Two postings by the same employer on the same board share a key; a board that
redesigns its form gets a new fingerprint and re-probes automatically. Only
_required_ labels go into the basis, because optional blocks (equal-opportunity
questions especially) come and go between postings and would churn the key for
nothing.

The host was added to the basis in a fix worth understanding, because it is a
_wrong data_ bug rather than a missed optimisation: the basis used to be
`atsId + "|" + labels`, which is cross-tenant by construction. Every employer on
the same ATS whose required fields carry the same labels — name, email, resume:
the common case — shared one fingerprint, so employer B was served employer A's
remembered option lists. A "How did you hear about us?" list is written per
employer.

**What invalidates it:**

- `CACHE_VERSION` in `scripts/apply/field-cache.mjs` (currently `4`) not
  matching the file's `v`. `loadCache` then discards **every** remembered form.
- The file not parsing at all — same discard.
- `invalidate(cache, fp)`, called when the browser reported a mismatch on a
  field the cache claimed to know.
- A board redesigning its required fields, which changes the fingerprint and
  orphans the old entry harmlessly.

**If you delete it:** nothing breaks. The next application to each board re-probes
every dropdown and re-learns. You pay the latency once per board.

> **A version mismatch used to be silent, and it dropped the whole pipeline to
> amber.** `jobs/.field-cache.json` sat at `v: 2` while `CACHE_VERSION` moved to
> `3`, so all seven real fingerprints were thrown away on every load with nothing
> printed anywhere. Every board then reported "no remembered form shape" — the
> same message a board this pipeline had genuinely never seen would produce — and
> nobody could tell the two apart. The discard was always correct; only its
> silence was the bug. `loadCache` now writes a line to standard error **and**
> returns a `discarded` object so a caller can act on the count.

> **Known defect (2026-08-05 audit).** That `discarded` marker is returned on the
> cache object, and `saveCache` serialises the whole object with no filtering — so
> after the next save it is written into the file and re-served forever.

> **Known defect (2026-08-05 audit).** `recordCache` keeps only `t`, `l`, `req`,
> `opts`, `sel` and `via` per field. It drops the field's help text (`h`) and its
> section heading, which is what long-form-prompt detection needs. And a page that
> `buildPlan` **refused** still gets written to the cache and to the shape history,
> because the write is unconditional after `buildPlan` returns.

### 5.2 `jobs/.shape-history.jsonl` — an append-only counter

**What it remembers:** one line per scan, holding four values and nothing else.

```
{"date":"2026-08-02","ats":"greenhouse","fp":"ed2bfaa469e89884","hasCheckboxOrRadio":true}
{"date":"2026-08-02","ats":"greenhouse","fp":"ed2bfaa469e89884","hasCheckboxOrRadio":true}
```

**JSONL** — JSON Lines — is one complete JSON object per line. Appending is a
single write with no read-modify-write of a growing structure, so two sessions
finishing at nearly the same moment cannot clobber each other's line the way two
writers racing on `saveCache` could.

**Why:** to answer one measurement question later, at zero browsing cost — what
fraction of real forms carry a checkbox or radio group, which permanently blocks
the fully-automatic tier. The live cache cannot answer it, because `recordCache`
**overwrites** a fingerprint's entry when a board redesigns its form, so the fact
that an earlier shape had a checkbox is lost.

It records nothing else, deliberately: never a label, an option, a selector, or
anything from `entry.fields`. And it is **never read** by `applyCache`,
`recordCache` or `scripts/apply/automatability.mjs` — it changes nothing about
what gets filled or what counts as automatable. It exists to be counted.

**What invalidates it:** nothing. It is append-only.

**If you delete it:** the measurement starts over. Nothing else changes.

> **Known defect (2026-08-05 audit).** The number this file was created to
> justify is still hard-coded. `scripts/apply/disclosure.mjs` uses a threshold of
> 20 with its own comment saying "The right input is a real distribution, which
> `jobs/.shape-history.jsonl` … is accumulating and which is empty today."

### 5.3 `jobs/.gate-baseline.json` — the last screening audit

**What it remembers:** the verdict every lead in the store received the last time
`scripts/leads/gate-audit.mjs` ran — whether it passed, which stage rejected it,
the stated reasons, and any flags.

```json
{
  "recorded_at": "2026-08-04T00:10:11.930Z",
  "leads": [
    {
      "id": "greenhouse:reddit:8060775",
      "company": "Reddit",
      "title": "Senior Staff Software Engineer, Client Architecture",
      "ok": false,
      "stage": "l0",
      "reasons": ["title: \"senior\" is hard-filtered"],
      "flags": []
    },
    {
      "id": "ashby:openai:07153f7c-…",
      "company": "OpenAI",
      "title": "Software Engineer, Privacy Engineering",
      "ok": true,
      "stage": null,
      "reasons": [],
      "flags": ["remote_unverified", "fit_weak"]
    }
  ]
}
```

**Why:** so that changing a screening rule can be _diffed_. `diffAudit` in
`gate-audit.mjs` compares the new verdicts against this file and reports three
lists: newly rejected, newly accepted, and leads whose rejecting stage moved.
`CLAUDE.md` puts it plainly — a job you never see is the worst failure in this
system, so a gate change you cannot see the effect of is the dangerous kind.

Saving is the **default**; `--no-save` opts out. The comment in `gate-audit.mjs`
says why: "an audit whose result is not recorded gives the next change nothing to
diff against, which is the whole point."

It lives under `jobs/` because that directory is already gitignored and this is
derived state about the user's own lead store, not project source.

**What invalidates it:** the next run overwrites it wholesale.

**If you delete it:** the next `gate-audit.mjs` run has nothing to compare
against, so it reports current verdicts with no diff and writes a fresh baseline.
One audit's worth of change-detection is lost.

### 5.4 `jobs/.auto/` — the unattended runner's own directory

Three things live here.

**`jobs/.auto/runs/<run_id>.jsonl`** — append-only event log, one file per run.
`scripts/auto/audit.mjs` writes it, and its header states the relationship to the
database plainly: this is the copy that survives, and the tables exist because
JSONL cannot be queried.

A real run's first three lines, abbreviated:

```
{"at":"2026-08-04T17:53:38.751Z","t":"run.start","run_id":"2026-08-04T17-53-38-730Z-3b1afb","mode":"dry_run","profile":{"profile.yaml":"7def2203…","answers.yaml":"c4de5f0c…"},"meta":{"concurrency":1,"queued":1}}
{"at":"2026-08-04T17:53:38.773Z","t":"job.begin","run_id":"…","slug":"fixture-analytics-fullstack","company":"Fixture Analytics","tier":null}
{"at":"2026-08-04T17:53:42.304Z","t":"submit.attempt","run_id":"…","slug":"fixture-analytics-fullstack","mode":"dry_run","plan_sha256":"462aae4f…","apply_url":"http://127.0.0.1:63266/…","outcome":"attempted"}
```

Every line has `at` (a timestamp), `t` (an event type) and `run_id`. Appending is
atomic enough that a killed process leaves a truncated _last line_ rather than a
corrupted file — which is the property the format was chosen for.

**`jobs/.auto/post-submit/`** — staged captures of what a board showed after a
submit, written by `scripts/apply/capture-post-submit.mjs` as an `.html` and a
`.json` per capture. These are **redacted** before they are written, and staging
is gitignored. The three-step flow is _stage_ (right after the user's click),
_review_ (the user reads the redacted visible text), _promote_ (copies it into
the committed corpus at `tests/fixtures/post-submit/`, and only with an explicit
`--user-approved` and a `--kind` the user supplies).

The reason this pipeline is manual is worth stating, because it is the one thing
currently keeping the unattended path from working: the post-submit classifier's
rules are bounded by their evidence, and a rule justified only by a fixture page
may fire only on loopback. So a real ATS classifies as `unclassified`, which is a
hard stop. Writing a plausible-looking regular expression instead would fail
silently in the one direction that cannot be recovered — a page misread as a
confirmation records an application that was never sent, and nothing later
corrects it.

**`jobs/.auto/INBOX.md`** — where `audit.mjs` writes the things a human has to
look at. It does not exist on this machine because no run has produced one.

> **Known defect (2026-08-05 audit).** `AUTO_RUN_LOCK` is exported by
> `scripts/lib/lock.mjs` pointing at `jobs/.auto/run.lock`, and no code anywhere
> takes it. Nothing in `scripts/auto/` imports the locking module at all.

### 5.5 The delete-it table

| File / directory            | Kind                | Rebuilt by                             | Cost of deleting it                                  |
| --------------------------- | ------------------- | -------------------------------------- | ---------------------------------------------------- |
| `jobs/.field-cache.json`    | cache               | the next scan of each board            | Latency: one full dropdown probe per board, once.    |
| `jobs/.shape-history.jsonl` | append-only log     | nothing — it accumulates forward       | A measurement sample. Nothing operational.           |
| `jobs/.gate-baseline.json`  | derived snapshot    | the next `gate-audit.mjs` run          | One audit's worth of change-detection.               |
| `jobs/.auto/runs/*.jsonl`   | **ledger**          | **nothing**                            | The surviving record of what unattended runs did.    |
| `jobs/.auto/post-submit/`   | staging             | nothing                                | Un-promoted captures. Promoted ones are in `tests/`. |
| `jobs/<slug>/*.pdf`         | regenerable         | `scripts/documents/render-pdf.mjs`     | Seconds.                                             |
| `jobs/<slug>/` (whole)      | mixed               | partly — `job.json` can be re-captured | The tailored documents and their approval state.     |
| `jobs/leads.db`             | **store of record** | **only partly** — see Part 6           | See Part 6. This is the one that matters.            |

---

## Part 6 — How to back this up

### 6.1 The short answer

**Copy `jobs/leads.db`.** That single file is the database — all twelve tables,
all 28 indexes, everything.

Copy it while nothing is running. If a process has it open, WAL mode means some
recent commits are sitting in `jobs/leads.db-wal` and not yet in the main file, so
a copy of `leads.db` alone can be missing them. Two safe options:

- **Simplest:** make sure nothing is running, then copy the file. SQLite folds
  the WAL back into the main database when the last connection closes.
- **Belt and braces:** copy all three of `leads.db`, `leads.db-wal` and
  `leads.db-shm` together, or use SQLite's own `VACUUM INTO 'backup.db'`, which
  writes a consistent copy from inside a running connection.

Also copy `profile/` — `profile.yaml` and `answers.yaml` are the fact base, they
are gitignored, and nothing else on earth has them.

### 6.2 Why the YAML export is not a backup

`profile/applications.yaml` is a real export of a real table, and it _is_ useful
disaster recovery for that one table. It is not a backup of the database, for a
reason that is structural rather than an oversight.

**The `documents` table has no on-disk source.** Its own schema comment:

```
-- Nothing rebuilds this table. Unlike leads (re-derivable from a sweep) and
-- applications (exported to YAML), an archived workspace has no other on-disk
-- source once the directory is gone — migrate.mjs must never touch it.
```

Here is the whole picture, table by table — what could be rebuilt from
somewhere else, and what could not:

| Table              | Rebuildable from                                     | Rebuildable in practice?                  |
| ------------------ | ---------------------------------------------------- | ----------------------------------------- |
| `leads`            | Re-running a sweep against the live boards           | Partly — postings that closed are gone.   |
| `lead_keywords`    | Re-extracting from `leads.doc`                       | Yes, if `leads` survives.                 |
| `applications`     | `profile/applications.yaml`                          | **Yes** — this is what the export is for. |
| `screens`          | Re-screening (mechanical is cheap, model is not)     | Partly, at cost.                          |
| `documents`        | **Nothing.**                                         | **No.**                                   |
| `board_stats`      | Accumulates over sweeps                              | No — the history is the value.            |
| `auto_runs`        | `jobs/.auto/runs/*.jsonl`                            | In principle; no importer exists.         |
| `auto_submissions` | **Nothing.** The JSONL has the events, not the rows. | **No.**                                   |
| `auto_queue`       | Nothing — it _is_ the run state.                     | **No.**                                   |
| `board_pauses`     | Nothing.                                             | No.                                       |
| `verifications`    | Re-running `verify-claims.mjs` on every document     | Yes, at cost — if the documents exist.    |
| `workspace_stacks` | Recomputed on demand.                                | Yes — it is a cache.                      |

`scripts/maintenance/migrate.mjs` is the closest thing to a restore tool, and its
own header is explicit about the limits:

- It re-imports **`leads`**, **`lead_keywords`** and **`applications`** (the last
  only from `profile/applications.yaml`, and only when the table is empty — a
  bootstrap, not a merge).
- It **never touches** `documents`, `auto_submissions` or `verifications`.
- For `auto_queue` it can only create the table or clear it. `--reset-queue`
  deletes only rows in states where no click was ever issued, and **refuses
  outright** while any row sits in `attempted`, printing the pages a human must
  check first.

So: the YAML export recovers exactly one of twelve tables. The other eleven are
recovered by copying the file.

### 6.3 A backup recipe

```bash
# Stop anything that might be running first.

# 1. The database, consistently, without needing exclusive access:
node -e "const{DatabaseSync}=require('node:sqlite');\
const d=new DatabaseSync('jobs/leads.db');\
d.exec(\"VACUUM INTO 'backup/leads-2026-08-07.db'\");d.close()"

# 2. The fact base — gitignored, irreplaceable:
cp -r profile/ backup/profile-2026-08-07/

# 3. The unattended run ledger:
cp -r jobs/.auto/runs/ backup/auto-runs-2026-08-07/

# 4. Optional: live job workspaces you have not archived yet.
cp -r jobs/*/ backup/workspaces-2026-08-07/
```

Skip `.field-cache.json`, `.shape-history.jsonl` and `.gate-baseline.json` if you
like — they cost latency and one measurement sample, nothing more.

**Verifying a backup is a backup.** A copy you have never restored is a hope, not
a backup. Restore into a scratch directory and check that `node scripts/status.mjs`
reports the counts you expect, and that `node scripts/maintenance/archive.mjs list`
lists the archived workspaces you remember.

---

## Part 7 — the invariants, collected

These are the storage-layer rules that look like tidy-ups and are not. Each one
is a bug somebody already hit.

1. **`SCHEMA` is a template literal — no backticks in the SQL, ever**, including
   inside SQL comments.
2. **`busy_timeout` is set before `journal_mode = WAL`.** Reversing it makes
   three of four concurrent openers die on the WAL switch itself.
3. **The three heal functions run before `db.exec(SCHEMA)`.** `healScreens`
   because `SCHEMA`'s index on `screens(source, verdict)` is what fails on the
   old shape; `healAutoSubmissions` because `SCHEMA` is what recreates the three
   indexes the rebuild's `DROP TABLE` destroyed.
4. **`auto_submissions.mode` stays `NOT NULL DEFAULT 'live'`.** SQLite allows
   `NULL` in a non-`INTEGER` primary key's columns, so a `NULL` there silently
   un-enforces the whole key.
5. **`auto_submissions` is keyed `(slug, mode)`** — not `(run_id, slug)`, not
   `(slug)`.
6. **A `0` from `claimAutoJob` or `recordAutoSubmission` is the normal fan-out
   result**, not an error. It means another worker owns the slug and this one
   must not click.
7. **`IS NOT`, never `!=`, when comparing a nullable `outcome`.**
8. **`attempted` is never released or retried automatically.**
9. **`reconciled-not-sent` is the only outcome that releases a claim.** Widening
   that list re-opens the permanent-deadlock bug.
10. **Never `DELETE` an `auto_submissions` row to unblock a retry.** A terminal
    outcome unblocks the retry and keeps the history.
11. **`BEGIN IMMEDIATE` for any read-modify-write.** Plain `BEGIN` is deferred
    and permits a lost update.
12. **Functions that open their own transaction cannot nest**: `upsertLeads`,
    `upsertApplications`, `writeDocuments`, `recordScreens`, `enqueueAutoJobs`,
    `strandPausedBoardJobs`, `updateApplication`.
13. **`hasPassingVerification` compares both hashes.** A match on `doc_sha256`
    alone is not verification.
14. **`recordVerification` coerces anything that is not exactly `"pass"` to
    `"fail"`.** Fail closed.
15. **`readWorkspaceStacks` swallowing a parse error is deliberate.** A cache
    degrades to a recompute, never to a crash.
16. **`readQueueAges` reports `age_ms: null`, not `0`, for a row with no
    timestamp.** Reporting unknown as fresh is how a stuck job hides in a
    percentile.
17. **`readSubmitLatencies` excludes rows with no `posted_at`** rather than
    counting them as instantaneous.
18. **`resolveLeadSource` and `resolveApplicationSource` decide format by file
    extension** (`.endsWith(".db")`). A fixture named `store.sqlite` is treated
    as JSON.
19. **`writeLeadStore` on the database path merges; it never deletes.**
20. **`answers.yaml` question text is not evidence.** Use `evidenceText()`.
21. **The field cache's `v` must match `CACHE_VERSION`**, and a mismatch discards
    every remembered shape.
22. **Importing `scripts/lib/db.mjs` patches `process.emitWarning` globally** for
    that process, to suppress exactly one experimental-SQLite warning. That is a
    side effect of `import`, not of any function call.

---

**Where to go next**

- [`../code/01-lib-foundation.md`](../code/01-lib-foundation.md) — the
  **functions** that read and write everything above, one export at a time.
  Start here if you want to write code against this data.
- [`05-architecture.md`](05-architecture.md) — how the stages that produce this
  data fit together. This document is the nouns; that one is the verbs.
- [`07-safety-model.md`](07-safety-model.md) — why a job posting is data and
  never instructions, and how `untrusted_findings`, `evidenceText` and
  `save-answer.mjs`'s refusals fit into one policy.
- [`08-glossary.md`](08-glossary.md) — slug, lead, ATS, fact base, defer, claim,
  cap, and the rest of the vocabulary used above.
- [`../code/09-auto-runner.md`](../code/09-auto-runner.md) and
  [`../code/10-auto-safety.md`](../code/10-auto-safety.md) — the state machine
  in `auto_queue` and the ledger in `auto_submissions`, as running code.
- [`../code/11-record-and-profile.md`](../code/11-record-and-profile.md) — the
  application record and the fact base, as running code.
- [`../code/05-documents.md`](../code/05-documents.md) — how a fact id becomes a
  resume bullet, and what `verify-claims.mjs` does with the citation.
- [`../operate/04-config-reference.md`](../operate/04-config-reference.md) —
  `docs/application-limits.yaml` and `docs/job-sources.yaml`, the two files the
  user owns that this data is filtered by.
- [`../operate/03-troubleshooting.md`](../operate/03-troubleshooting.md) — what
  to do when the field cache goes amber, when a run leaves an orphaned attempt,
  or when a verification stops matching.
