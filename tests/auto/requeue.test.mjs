// requeue.mjs — the one supported way back out of a terminal auto_queue row.
//
// The properties that matter are all refusals. This command re-arms a job for a
// real submit against a real employer, so the interesting cases are the ones it
// must decline, and the one case it must NOT decline: a terminal `submitted`
// row that a DRY RUN wrote, which records no application at all.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { openDb } from "../../src/lib/db.mjs"
import {
  requeueSlug,
  listRequeueable,
  hasLiveSubmission,
  REQUEUE_REFUSED,
} from "../../src/auto/requeue.mjs"

function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requeue-"))
  const file = path.join(dir, "leads.db")
  const db = openDb(file)
  t.after(() => {
    try {
      db.close()
    } catch {
      /* already closed by the test */
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return db
}

function queueRow(db, slug, state, reason_kind = null) {
  db.prepare(
    `INSERT INTO auto_queue (slug, state, attempt_no, reason_kind, updated_at)
     VALUES (?, ?, 1, ?, '2026-08-18T00:00:00.000Z')`,
  ).run(slug, state, reason_kind)
}

function submission(db, slug, mode, outcome = "submitted") {
  // `doc` is NOT NULL — the row carries its own JSON record.
  db.prepare(
    `INSERT INTO auto_submissions (run_id, slug, mode, outcome, submitted_at, doc)
     VALUES ('r1', ?, ?, ?, '2026-08-18T00:00:00.000Z', ?)`,
  ).run(slug, mode, outcome, JSON.stringify({ slug, mode, outcome }))
}

test("a real live submission is REFUSED — re-queuing would send a second one", (t) => {
  const db = tempDb(t)
  queueRow(db, "acme-swe", "submitted")
  submission(db, "acme-swe", "live")
  const out = requeueSlug(db, "acme-swe", { reason: "I want to retry" })
  assert.equal(out.ok, false)
  assert.match(out.reason, /would send a second one/)
  assert.equal(
    db.prepare("SELECT state FROM auto_queue WHERE slug=?").get("acme-swe")
      .state,
    "submitted",
    "the row must not have moved",
  )
})

test("THE ELIZA CASE: a `submitted` row written by a DRY RUN is movable", (t) => {
  // auto_queue has no mode column, so a rehearsal wrote a terminal row that is
  // indistinguishable by STATE from a real application. auto_submissions is
  // keyed (slug, mode) and is what settles it.
  const db = tempDb(t)
  queueRow(db, "eliza-fde", "submitted")
  submission(db, "eliza-fde", "dry_run")
  assert.equal(hasLiveSubmission(db, "eliza-fde"), false)
  const out = requeueSlug(db, "eliza-fde", { reason: "dry-run artefact" })
  assert.equal(out.ok, true)
  assert.equal(out.from, "submitted")
  assert.equal(
    db.prepare("SELECT state FROM auto_queue WHERE slug=?").get("eliza-fde")
      .state,
    "queued",
  )
})

test("a slug rehearsed AND live-submitted is still refused", (t) => {
  // The dry_run row must not be read as evidence that nothing was sent when a
  // live row sits beside it.
  const db = tempDb(t)
  queueRow(db, "both", "submitted")
  submission(db, "both", "dry_run")
  submission(db, "both", "live")
  assert.equal(hasLiveSubmission(db, "both"), true)
  assert.equal(requeueSlug(db, "both", { reason: "x" }).ok, false)
})

test("the schema itself refuses a mode-less submission row", (t) => {
  // The `mode IS NULL` arm of hasLiveSubmission is belt-and-braces: the column
  // is NOT NULL, which is what actually stops a row dodging the (slug, mode)
  // key. SQLite permits NULLs in a non-INTEGER primary key's columns, so
  // without this constraint the key would be silently un-enforced — the trap
  // CLAUDE.md records for exactly this table. Pinned so a future schema edit
  // that drops NOT NULL fails here rather than in production.
  const db = tempDb(t)
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO auto_submissions (run_id, slug, mode, outcome, submitted_at)
           VALUES ('r1', 'legacy', NULL, 'submitted', '2026-08-01T00:00:00.000Z')`,
        )
        .run(),
    /NOT NULL constraint failed: auto_submissions\.mode/,
  )
})

test("a slug with NO submission row at all reads as not-sent", (t) => {
  // The queue row is terminal but nothing ever reached the ledger — a job
  // killed between the state write and the submission write. Movable, because
  // no click is recorded anywhere.
  const db = tempDb(t)
  queueRow(db, "ghost", "submitted")
  assert.equal(hasLiveSubmission(db, "ghost"), false)
  assert.equal(requeueSlug(db, "ghost", { reason: "no ledger row" }).ok, true)
})

test("hasLiveSubmission FAILS CLOSED when the ledger cannot be read", (t) => {
  // A false "nothing was sent" is the one error here that sends a second
  // application to a real employer, so any doubt must report true.
  const db = tempDb(t)
  db.exec("DROP TABLE auto_submissions")
  assert.equal(hasLiveSubmission(db, "anything"), true)
})

test("`attempted` is refused and has NO override — a click may have landed", (t) => {
  const db = tempDb(t)
  queueRow(db, "orphan", "attempted")
  const out = requeueSlug(db, "orphan", { reason: "please" })
  assert.equal(out.ok, false)
  assert.match(out.reason, /may already exist at this employer/)
  // Even with no submission row at all, an attempt is never movable: the whole
  // point of `attempted` is that we do not know what happened.
  assert.equal(
    listRequeueable(db).find((r) => r.slug === "orphan").movable,
    false,
  )
})

test("`challenged` is refused for the same reason as `attempted`", (t) => {
  const db = tempDb(t)
  queueRow(db, "chal", "challenged")
  assert.equal(requeueSlug(db, "chal", { reason: "x" }).ok, false)
})

test("a deferred row moves, and records WHY it was moved by hand", (t) => {
  const db = tempDb(t)
  queueRow(db, "deferred-job", "deferred", "unknown-field")
  const out = requeueSlug(db, "deferred-job", {
    reason: "adapter now knows it",
  })
  assert.equal(out.ok, true)
  const row = db
    .prepare(
      "SELECT state, reason_kind, reason_detail FROM auto_queue WHERE slug=?",
    )
    .get("deferred-job")
  assert.equal(row.state, "queued")
  assert.equal(row.reason_kind, null, "the stale kind must be cleared")
  assert.match(row.reason_detail, /requeued by hand: adapter now knows it/)
})

test("a requeue with no reason still records that none was given", (t) => {
  // The queue refuses a deferral with no reason; a silent hand-requeue is the
  // same hole pointing the other way.
  const db = tempDb(t)
  queueRow(db, "no-reason", "deferred", "unknown-field")
  requeueSlug(db, "no-reason", {})
  assert.match(
    db
      .prepare("SELECT reason_detail FROM auto_queue WHERE slug=?")
      .get("no-reason").reason_detail,
    /no reason given/,
  )
})

test("an unknown slug is reported, not silently ignored", (t) => {
  const db = tempDb(t)
  const out = requeueSlug(db, "nope", { reason: "x" })
  assert.equal(out.ok, false)
  assert.match(out.reason, /no queue row/)
})

test("--list separates 'this command can move it' from 'enqueue would retry it'", (t) => {
  // Conflating the two is how the digest came to report six permanently
  // unreachable rows as requeueable: the kind was on the list, but selection
  // turned the lead away before the conflict clause ever ran.
  const db = tempDb(t)
  queueRow(db, "auto", "deferred", "unknown-field") // a requeueable kind
  queueRow(db, "manual", "deferred", "l3-rejected") // deliberately not
  const rows = listRequeueable(db)
  const auto = rows.find((r) => r.slug === "auto")
  const manual = rows.find((r) => r.slug === "manual")
  assert.equal(auto.autoRequeues, true)
  assert.equal(auto.movable, true)
  assert.equal(manual.autoRequeues, false)
  assert.equal(manual.movable, true, "a human may still move it deliberately")
})

test("every refused state names a click that may already have landed", () => {
  // Pins the vocabulary: if a state is added here later, its reason has to
  // explain the risk rather than just saying no.
  for (const [state, reason] of Object.entries(REQUEUE_REFUSED)) {
    assert.match(
      reason,
      /click|sent|second one/,
      `${state} must say why it is refused`,
    )
  }
})
