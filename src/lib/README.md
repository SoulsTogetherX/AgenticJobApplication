# `src/lib/` — shared foundation

**Owner:** `implementer`.

Seven files that every other domain imports and that import nothing from any
other domain. If you find yourself adding an import here that points at
`../leads/` or `../apply/`, the decision is in the wrong file.

## The boundary

`lib/` holds **shared pure helpers**. Two things are excluded on purpose:

- **Nothing that spawns.** No `child_process`, no browser launch, no scheduler.
  A helper that spawns is a stage, and stages live in their domain.
- **Nothing domain-specific.** "Does this lead pass the location filter" is a
  leads decision even though four domains ask it. Shared ≠ general.

`db.mjs` is the one file that stretches this: it holds the schema and every
accessor for `jobs/leads.db`, so it knows about leads, applications, the auto
queue and the submission ledger. That is deliberate — one place that owns the
SQL beats five places that each own a table — and it is why `db.mjs` is the
largest file in the tree rather than a sign the boundary has slipped.

## The import rule

`#lib/*` is the canonical specifier, mapped in `package.json`:

```json
"imports": { "#lib/*": "./src/lib/*" }
```

Write `import { openDb } from "#lib/db.mjs"`. Relative `../lib/...` and
`../../lib/...` still work and still exist across the tree; they are **legacy
being retired**, and `tests/quality/import-fragility.test.mjs` ratchets the
deep-relative count downward so the retirement cannot silently reverse.

Inside this directory, sibling imports stay relative (`./lib.mjs`) — a module
importing itself through the subpath map is a cycle waiting to be written.

## The files

| File               | What it is                                                                            |
| ------------------ | ------------------------------------------------------------------------------------- |
| `args.mjs`         | Strict flag validation. An unknown flag on a mutating command exits rather than runs. |
| `db.mjs`           | The store: `SCHEMA`, `openDb`, and every accessor. No LLM, no network.                |
| `keywords.mjs`     | The one skill lexicon — everything that asks "what technology is named here?"         |
| `lib.mjs`          | Output mode (terse for agents, prose for humans), `mapPool`, HTTP with politeness.    |
| `lock.mjs`         | Single-flight advisory file locking, with stale-holder recovery.                      |
| `untrusted.mjs`    | Rule 0's sanitiser: posting text is data, never instructions.                         |
| `verification.mjs` | What "verified" means, in one place.                                                  |

## Traps that live here

- `db.mjs`'s `SCHEMA` is a template literal. A backtick inside its SQL ends the
  string.
- `openDb` sets `busy_timeout` **before** `journal_mode = WAL`. Do not reorder.
- SQLite permits NULLs in the columns of a non-INTEGER primary key, which
  silently un-enforces the key.
- `untrusted.mjs` must scan the **decoded** form of a URL as well as the raw one.

Full reasoning for each: [`../../docs/code/01-lib-foundation.md`](../../docs/code/01-lib-foundation.md).
