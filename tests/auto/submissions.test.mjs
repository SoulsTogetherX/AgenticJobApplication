// The submission ledger's KEY, and the split between claiming a submit and
// acknowledging one.
//
// The old key was (run_id, slug), which meant the same slug could be submitted
// once per RUN with no conflict at all — exactly backwards for a row whose job
// is to be a claim. The new key is (slug, mode): one claim per posting, and a
// dry-run rehearsal is a separate row so it cannot pre-consume the live claim
// forever.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  openDb,
  recordAutoSubmission,
  acknowledgeAutoSubmission,
  readAutoSubmission,
  countAutoSubmissions,
  companySubmissionBreakdown,
  readOrphanAttempts,
  readSubmitLatencies,
} from "../../src/lib/db.mjs"

function store(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aj-subs-"))
  const file = path.join(dir, "leads.db")
  const handles = []
  t.after(() => {
    for (const d of handles) {
      try {
        d.close()
      } catch {
        /* already closed */
      }
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* a leaked Windows lock must not fail a passing test */
    }
  })
  return {
    file,
    open() {
      const d = openDb(file)
      handles.push(d)
      return d
    },
    raw() {
      const d = new DatabaseSync(file)
      handles.push(d)
      return d
    },
  }
}

const attempt = (over = {}) => ({
  run_id: "run-1",
  slug: "acme-dev",
  company: "Acme",
  title: "Dev",
  mode: "live",
  outcome: "attempted",
  plan_sha256: "a".repeat(64),
  apply_url: "https://boards.test/acme/1",
  submitted_at: "2026-08-02T10:00:00.000Z",
  ...over,
})

// --- the falsifiable check: a rehearsal does not consume the live claim -------

test("a dry_run row still admits a live attempt, and the second live insert is refused", (t) => {
  const db = store(t).open()

  assert.equal(recordAutoSubmission(db, attempt({ mode: "dry_run" })), 1)
  assert.equal(
    recordAutoSubmission(db, attempt({ mode: "live" })),
    1,
    "the rehearsal must not pre-consume the live claim",
  )
  assert.equal(
    recordAutoSubmission(db, attempt({ mode: "live", run_id: "run-2" })),
    0,
    "a second live claim on a slug already claimed reports 0 changes",
  )
  assert.equal(
    recordAutoSubmission(db, attempt({ mode: "dry_run", run_id: "run-2" })),
    0,
    "and so does a second rehearsal",
  )

  const rows = db
    .prepare("SELECT slug, mode, run_id FROM auto_submissions ORDER BY mode")
    .all()
  assert.deepEqual(
    rows.map((r) => `${r.slug}|${r.mode}|${r.run_id}`),
    ["acme-dev|dry_run|run-1", "acme-dev|live|run-1"],
    "two rows, both owned by the run that claimed them",
  )
})

test("a NEW run cannot re-claim a slug an old run already submitted", (t) => {
  const db = store(t).open()
  recordAutoSubmission(db, attempt())
  acknowledgeAutoSubmission(
    db,
    attempt({ outcome: "submitted", confirmation_url: "https://x.test/c/1" }),
  )
  assert.equal(
    recordAutoSubmission(db, attempt({ run_id: "run-99" })),
    0,
    "this is the whole point of the re-key: the old key made this a new row",
  )
  const row = readAutoSubmission(db, "acme-dev", "live")
  assert.equal(row.outcome, "submitted")
  assert.equal(row.run_id, "run-1")
})

// --- claim vs acknowledgement -------------------------------------------------

test("the acknowledgement resolves the claim instead of being dropped by it", (t) => {
  const db = store(t).open()
  recordAutoSubmission(db, attempt())
  assert.equal(
    acknowledgeAutoSubmission(
      db,
      attempt({
        outcome: "submitted",
        confirmation_url: "https://x.test/c/1",
        apply_url: null,
      }),
    ),
    1,
  )
  const rows = db.prepare("SELECT * FROM auto_submissions").all()
  assert.equal(rows.length, 1, "one application, one row")
  assert.equal(rows[0].outcome, "submitted")
  assert.equal(rows[0].confirmation_url, "https://x.test/c/1")
  assert.equal(
    rows[0].apply_url,
    "https://boards.test/acme/1",
    "acknowledging must never blank the URL the attempt recorded",
  )
})

test("acknowledging keeps the confirmation url when a later write omits it", (t) => {
  const db = store(t).open()
  recordAutoSubmission(db, attempt())
  acknowledgeAutoSubmission(
    db,
    attempt({ outcome: "submitted", confirmation_url: "https://x.test/c/1" }),
  )
  acknowledgeAutoSubmission(
    db,
    attempt({ outcome: "submitted", confirmation_url: null }),
  )
  assert.equal(
    readAutoSubmission(db, "acme-dev", "live").confirmation_url,
    "https://x.test/c/1",
    "the URL a manual withdrawal needs is never rewritten to null",
  )
})

test("an acknowledgement does not re-attribute the row to another run", (t) => {
  const db = store(t).open()
  recordAutoSubmission(db, attempt({ run_id: "owner" }))
  acknowledgeAutoSubmission(
    db,
    attempt({ run_id: "other", outcome: "submitted" }),
  )
  assert.equal(readAutoSubmission(db, "acme-dev", "live").run_id, "owner")
})

test("an acknowledgement with no preceding claim still lands — an application cannot be unsent", (t) => {
  const db = store(t).open()
  assert.equal(
    acknowledgeAutoSubmission(db, attempt({ outcome: "submitted" })),
    1,
  )
  assert.equal(readAutoSubmission(db, "acme-dev", "live").outcome, "submitted")
})

test("a mode-less row is stored as live, so it cannot dodge the key", (t) => {
  const db = store(t).open()
  assert.equal(recordAutoSubmission(db, attempt({ mode: undefined })), 1)
  assert.equal(
    recordAutoSubmission(db, attempt({ mode: "live", run_id: "r2" })),
    0,
    "NULL in a SQLite primary-key column conflicts with nothing; 'live' does",
  )
  assert.equal(readAutoSubmission(db, "acme-dev", "live").mode, "live")
})

// --- the counters keep counting both modes ------------------------------------

test("the caps still count rehearsals and attempts, and still ignore abandonments", (t) => {
  const db = store(t).open()
  const since = "2026-08-01T00:00:00.000Z"
  recordAutoSubmission(db, attempt({ mode: "dry_run" }))
  recordAutoSubmission(db, attempt({ mode: "live" }))
  recordAutoSubmission(db, attempt({ slug: "acme-qa", mode: "live" }))
  acknowledgeAutoSubmission(
    db,
    attempt({ slug: "acme-qa", mode: "live", outcome: "abandoned" }),
  )

  assert.equal(
    countAutoSubmissions(db, since),
    2,
    "the rehearsal and the live attempt count; the abandonment does not",
  )
  assert.deepEqual(companySubmissionBreakdown(db, "Acme", since), {
    total: 2,
    live: 1,
    dry_run: 1,
    manual: 0,
  })
})

test("a legacy row with a NULL outcome still counts — IS NOT, not !=", (t) => {
  const s = store(t)
  s.open().close()
  const raw = s.raw()
  raw
    .prepare(
      "INSERT INTO auto_submissions (run_id, slug, company, submitted_at, mode, doc) VALUES (?,?,?,?,?,?)",
    )
    .run("old", "old-slug", "Acme", "2026-08-02T09:00:00.000Z", "live", "{}")
  raw.close()
  const db = s.open()
  assert.equal(countAutoSubmissions(db, "2026-08-01T00:00:00.000Z"), 1)
})

test("an unacknowledged attempt from a run that never closed is still an orphan", (t) => {
  const db = store(t).open()
  recordAutoSubmission(db, attempt())
  const orphans = readOrphanAttempts(db)
  assert.equal(orphans.length, 1)
  assert.equal(orphans[0].apply_url, "https://boards.test/acme/1")
})

// --- the repair of an already-built database ----------------------------------

test("a database on the old primary key is rebuilt without losing a submitted application", (t) => {
  const s = store(t)
  const raw = s.raw()
  raw.exec(`CREATE TABLE auto_submissions (
      run_id TEXT NOT NULL, slug TEXT NOT NULL, company TEXT, title TEXT,
      submitted_at TEXT NOT NULL, mode TEXT, plan_sha256 TEXT,
      confirmation_url TEXT, doc TEXT NOT NULL, PRIMARY KEY (run_id, slug))`)
  const ins = raw.prepare(
    "INSERT INTO auto_submissions (run_id, slug, company, submitted_at, mode, confirmation_url, doc) VALUES (?,?,?,?,?,?,?)",
  )
  ins.run(
    "run-a",
    "acme-dev",
    "Acme",
    "2026-07-01T00:00:00.000Z",
    "live",
    "https://x.test/c/1",
    '{"note":"first"}',
  )
  ins.run(
    "run-b",
    "other-co",
    "Other",
    "2026-07-02T00:00:00.000Z",
    null,
    null,
    "{}",
  )
  raw.close()

  const db = s.open()
  const rows = db.prepare("SELECT * FROM auto_submissions ORDER BY slug").all()
  assert.equal(rows.length, 2, "every pre-existing application survives")
  assert.equal(rows[0].slug, "acme-dev")
  assert.equal(rows[0].confirmation_url, "https://x.test/c/1")
  assert.equal(rows[0].outcome, null, "a legacy row has no outcome to invent")
  assert.equal(
    rows[1].mode,
    "live",
    "a NULL mode becomes live — unknown mode has always counted as live",
  )

  const key = db
    .prepare("PRAGMA table_info(auto_submissions)")
    .all()
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name)
  assert.deepEqual(key, ["slug", "mode"])

  // And the repaired table refuses a second claim, which the old one could not.
  assert.equal(
    recordAutoSubmission(db, attempt({ run_id: "run-c", slug: "acme-dev" })),
    0,
  )
})

test("two old rows colliding on the new key keep the real submission AND the loser's record", (t) => {
  const s = store(t)
  const raw = s.raw()
  raw.exec(`CREATE TABLE auto_submissions (
      run_id TEXT NOT NULL, slug TEXT NOT NULL, company TEXT, title TEXT,
      submitted_at TEXT NOT NULL, mode TEXT, plan_sha256 TEXT,
      confirmation_url TEXT, outcome TEXT, apply_url TEXT, doc TEXT NOT NULL,
      PRIMARY KEY (run_id, slug))`)
  const ins = raw.prepare(
    "INSERT INTO auto_submissions (run_id, slug, company, submitted_at, mode, outcome, confirmation_url, doc) VALUES (?,?,?,?,?,?,?,?)",
  )
  // Same slug, same mode, three runs: an abandonment, an unresolved attempt,
  // and the one that actually reached the employer.
  ins.run(
    "r1",
    "acme-dev",
    "Acme",
    "2026-07-03T00:00:00.000Z",
    "live",
    "abandoned",
    null,
    '{"n":1}',
  )
  ins.run(
    "r2",
    "acme-dev",
    "Acme",
    "2026-07-02T00:00:00.000Z",
    "live",
    "attempted",
    null,
    '{"n":2}',
  )
  ins.run(
    "r3",
    "acme-dev",
    "Acme",
    "2026-07-01T00:00:00.000Z",
    "live",
    "submitted",
    "https://x.test/c/9",
    '{"n":3}',
  )
  raw.close()

  const db = s.open()
  const rows = db.prepare("SELECT * FROM auto_submissions").all()
  assert.equal(rows.length, 1)
  assert.equal(
    rows[0].outcome,
    "submitted",
    "the survivor is the one that most represents a real submission",
  )
  assert.equal(rows[0].confirmation_url, "https://x.test/c/9")

  const doc = JSON.parse(rows[0].doc)
  assert.equal(doc.n, 3)
  assert.equal(doc.superseded.length, 2, "nothing is dropped silently")
  assert.deepEqual(doc.superseded.map((r) => r.run_id).sort(), ["r1", "r2"])
})

test("a dry_run row and a live row for one slug both survive the rebuild", (t) => {
  const s = store(t)
  const raw = s.raw()
  raw.exec(`CREATE TABLE auto_submissions (
      run_id TEXT NOT NULL, slug TEXT NOT NULL, company TEXT, title TEXT,
      submitted_at TEXT NOT NULL, mode TEXT, plan_sha256 TEXT,
      confirmation_url TEXT, outcome TEXT, apply_url TEXT, doc TEXT NOT NULL,
      PRIMARY KEY (run_id, slug))`)
  const ins = raw.prepare(
    "INSERT INTO auto_submissions (run_id, slug, company, submitted_at, mode, outcome, doc) VALUES (?,?,?,?,?,?,?)",
  )
  ins.run(
    "r1",
    "acme-dev",
    "Acme",
    "2026-07-01T00:00:00.000Z",
    "dry_run",
    "submitted",
    "{}",
  )
  ins.run(
    "r2",
    "acme-dev",
    "Acme",
    "2026-07-02T00:00:00.000Z",
    "live",
    "submitted",
    "{}",
  )
  raw.close()

  const db = s.open()
  assert.deepEqual(
    db
      .prepare("SELECT mode FROM auto_submissions ORDER BY mode")
      .all()
      .map((r) => r.mode),
    ["dry_run", "live"],
    "they are different acts and stay different rows",
  )
})

test("reopening an already-rebuilt database rebuilds nothing", (t) => {
  const s = store(t)
  const first = s.open()
  recordAutoSubmission(first, attempt())
  first.close()
  const again = s.open()
  const rows = again.prepare("SELECT * FROM auto_submissions").all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].outcome, "attempted")
  assert.equal(
    JSON.parse(rows[0].doc).superseded,
    undefined,
    "an idempotent open does not rewrite the doc",
  )
})

// --- the market number counts only submissions that were CONFIRMED ----------
//
// readSubmitLatencies is what db.mjs calls "THE NUMBER THE PRODUCT IS ACTUALLY
// FOR", and it counted every row with a submitted_at regardless of outcome. An
// `attempted` row means a click went out and nothing came back to confirm it —
// the application may not exist — so those measured the latency of things that
// may never have been sent. Measured 2026-08-24: one unconfirmed Ashby click
// moved p95 from 547h to 653h. A dry_run row was in the same sample until the
// caller started passing the mode filter the helper always had.

test("an unconfirmed 'attempted' row is NOT in the latency sample", (t) => {
  const db = store(t).open()
  db.prepare(
    `INSERT INTO auto_queue (slug, state, attempt_no, posted_at, updated_at)
     VALUES ('sent', 'submitted', 1, '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z'),
            ('unsure', 'attempted', 1, '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z')`,
  ).run()
  for (const [slug, outcome] of [
    ["sent", "submitted"],
    ["unsure", "attempted"],
  ])
    db.prepare(
      `INSERT INTO auto_submissions (run_id, slug, mode, outcome, submitted_at, doc)
       VALUES ('r1', ?, 'live', ?, '2026-08-02T00:00:00.000Z', '{}')`,
    ).run(slug, outcome)

  const rows = readSubmitLatencies(db, { mode: "live" })
  assert.deepEqual(
    rows.map((r) => r.slug),
    ["sent"],
    "only a confirmed submission may be measured",
  )
})

test("a dry_run row is excluded when the caller asks for live", (t) => {
  const db = store(t).open()
  db.prepare(
    `INSERT INTO auto_queue (slug, state, attempt_no, posted_at, updated_at)
     VALUES ('rehearsal', 'deferred', 1, '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z')`,
  ).run()
  db.prepare(
    `INSERT INTO auto_submissions (run_id, slug, mode, outcome, submitted_at, doc)
     VALUES ('r1', 'rehearsal', 'dry_run', 'submitted', '2026-08-02T00:00:00.000Z', '{}')`,
  ).run()
  assert.equal(readSubmitLatencies(db, { mode: "live" }).length, 0)
  // And it is still visible to a caller that asks for it — the filter is the
  // CALLER's choice, not a deletion.
  assert.equal(readSubmitLatencies(db, { mode: "dry_run" }).length, 1)
})
