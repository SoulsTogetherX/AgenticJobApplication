// The per-application queue: the table that makes a run stop being the unit of
// anything. A kill at application #437 of 999 must lose nothing, duplicate
// nobody, and the next invocation must resume at 437 by READING THE DATABASE.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  openDb,
  enqueueAutoJobs,
  claimAutoJob,
  setAutoJobState,
  readAutoQueue,
  readResumableAutoJobs,
  readStrandedAutoJobs,
  autoQueueCounts,
  releaseStaleAutoClaims,
  withBusyRetry,
  AUTO_QUEUE_STATES,
} from "../../scripts/lib/db.mjs"

// One temp store per test, with the handles tracked. Closing before removing
// matters on Windows: an open SQLite handle keeps a lock on the file, and
// rmSync then fails with EPERM in a cleanup hook, which reads as a test failure
// with nothing to do with the test.
function store(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aj-queue-"))
  const file = path.join(dir, "leads.db")
  const handles = []
  t.after(() => {
    for (const d of handles) {
      try {
        d.close()
      } catch {
        /* already closed by the test */
      }
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* a leaked lock must not fail the assertion that already passed */
    }
  })
  return {
    file,
    open() {
      const d = openDb(file)
      handles.push(d)
      return d
    },
  }
}

const slugs = (n) =>
  Array.from({ length: n }, (_, i) => ({
    slug: `co-${String(i).padStart(3, "0")}`,
    origin: "sweep-2026-08-02",
    board_key: "boards.test/acme",
  }))

// --- the falsifiable check: resume after a kill -------------------------------

test("a kill mid-run resumes at exactly the unprocessed slugs, and none of the done ones", (t) => {
  const s = store(t)
  const jobs = slugs(50)

  // The first process: enqueues 50 and drives 20 all the way to submitted.
  let db = s.open()
  assert.equal(enqueueAutoJobs(db, jobs), 50)
  const done = []
  for (const j of jobs.slice(0, 20)) {
    assert.equal(claimAutoJob(db, j.slug, { run_id: "run-1" }), 1)
    for (const s of ["planned", "authorized", "attempted", "submitted"])
      assert.equal(setAutoJobState(db, j.slug, s, { run_id: "run-1" }), 1)
    done.push(j.slug)
  }
  // ...and is then killed. Nothing closes the run, nothing summarises it.
  db.close()

  // The second process knows nothing except what is in the file.
  db = s.open()
  const resumable = readResumableAutoJobs(db).map((r) => r.slug)
  assert.equal(resumable.length, 30)
  assert.deepEqual(
    resumable,
    jobs.slice(20).map((j) => j.slug),
  )
  for (const s of done)
    assert.ok(!resumable.includes(s), `${s} was already submitted`)
  assert.equal(autoQueueCounts(db).submitted, 20)
})

test("the resume set is read from the row, not re-derived: a finished slug stays finished", (t) => {
  const db = store(t).open()
  enqueueAutoJobs(db, slugs(4))
  claimAutoJob(db, "co-000", { run_id: "r" })
  setAutoJobState(db, "co-000", "failed", {
    run_id: "r",
    reason_kind: "nav-timeout",
    reason_stage: "plan",
  })
  claimAutoJob(db, "co-001", { run_id: "r" })
  setAutoJobState(db, "co-001", "deferred", {
    run_id: "r",
    reason_kind: "confirm-widget",
    reason_detail: "a radio group carries assent, not a value",
  })
  assert.deepEqual(
    readResumableAutoJobs(db).map((r) => r.slug),
    ["co-002", "co-003"],
    "terminal rows are done whatever their outcome was",
  )
})

test("an 'attempted' row is stranded, never resumed — the click may already have landed", (t) => {
  const db = store(t).open()
  enqueueAutoJobs(db, slugs(3))
  claimAutoJob(db, "co-000", { run_id: "r" })
  setAutoJobState(db, "co-000", "attempted", { run_id: "r" })

  assert.deepEqual(
    readResumableAutoJobs(db).map((r) => r.slug),
    ["co-001", "co-002"],
  )
  assert.deepEqual(
    readStrandedAutoJobs(db).map((r) => r.slug),
    ["co-000"],
    "it needs a human, not a retry",
  )
  // And a lease sweep must not quietly hand it back either.
  assert.equal(releaseStaleAutoClaims(db, { leaseMs: 0 }), 0)
  assert.equal(readAutoQueue(db, { state: "attempted" }).length, 1)
})

// --- the falsifiable check: two workers, one slug -----------------------------

test("two workers racing one slug produce exactly one claim, and the loser does not click", (t) => {
  const s = store(t)
  const setup = s.open()
  enqueueAutoJobs(setup, [{ slug: "acme-dev" }])
  setup.close()

  // Separate connections, exactly as two processes would have.
  const clicks = []
  const worker = (id) => {
    const db = s.open()
    try {
      if (claimAutoJob(db, "acme-dev", { run_id: id }) === 0) return "returned"
      clicks.push(id)
      return "claimed"
    } finally {
      db.close()
    }
  }
  const results = [worker("w1"), worker("w2"), worker("w3")]

  assert.equal(results.filter((r) => r === "claimed").length, 1)
  assert.equal(clicks.length, 1, "only the winner clicks")

  const db = s.open()
  const row = readAutoQueue(db)[0]
  assert.equal(row.state, "claimed")
  assert.equal(row.run_id, clicks[0])
  assert.equal(row.attempt_no, 1, "the losers did not bump the attempt counter")
})

test("a slug that was never enqueued is claimable exactly once", (t) => {
  const db = store(t).open()
  assert.equal(claimAutoJob(db, "fresh", { run_id: "w1" }), 1)
  assert.equal(claimAutoJob(db, "fresh", { run_id: "w2" }), 0)
  assert.equal(readAutoQueue(db)[0].run_id, "w1")
})

test("a claim carries origin and the plan hash, so a retry with a different plan is a different act", (t) => {
  const db = store(t).open()
  const a = "a".repeat(64)
  const b = "b".repeat(64)
  const t0 = new Date("2026-08-02T10:00:00.000Z")
  const t1 = new Date("2026-08-02T12:00:00.000Z")
  enqueueAutoJobs(db, [{ slug: "s", origin: "board-sweep" }], { now: t0 })
  assert.equal(
    claimAutoJob(db, "s", { run_id: "r1", plan_sha256: a, now: t0 }),
    1,
  )
  let row = readAutoQueue(db)[0]
  assert.equal(row.plan_sha256, a)
  assert.equal(row.origin, "board-sweep", "origin is carried, not consumed")

  // Released and re-claimed with a different plan: the row says so.
  releaseStaleAutoClaims(db, { leaseMs: 0, now: t1 })
  assert.equal(
    claimAutoJob(db, "s", { run_id: "r2", plan_sha256: b, now: t1 }),
    1,
  )
  row = readAutoQueue(db)[0]
  assert.equal(row.plan_sha256, b)
  assert.equal(row.attempt_no, 2)
})

// --- state transitions --------------------------------------------------------

test("a worker cannot advance a job another run holds", (t) => {
  const db = store(t).open()
  enqueueAutoJobs(db, [{ slug: "s" }])
  claimAutoJob(db, "s", { run_id: "owner" })
  assert.equal(setAutoJobState(db, "s", "planned", { run_id: "stranger" }), 0)
  assert.equal(readAutoQueue(db)[0].state, "claimed")
  assert.equal(setAutoJobState(db, "s", "planned", { run_id: "owner" }), 1)
  assert.equal(readAutoQueue(db)[0].state, "planned")
})

test("advancing a slug that is not in the queue changes nothing", (t) => {
  const db = store(t).open()
  assert.equal(setAutoJobState(db, "ghost", "planned"), 0)
  assert.equal(readAutoQueue(db).length, 0)
})

test("an unknown state is refused rather than written", (t) => {
  const db = store(t).open()
  enqueueAutoJobs(db, [{ slug: "s" }])
  assert.throws(
    () => setAutoJobState(db, "s", "SUBMITTED"),
    /unknown auto_queue state/,
  )
  assert.throws(
    () => setAutoJobState(db, "s", "done"),
    /unknown auto_queue state/,
  )
  assert.equal(readAutoQueue(db)[0].state, "queued")
  // Every state the plan names is accepted. The three that end a job carry a
  // kind from the closed taxonomy; the rest carry none.
  const kindFor = {
    deferred: "confirm-widget",
    failed: "nav-timeout",
    challenged: "bot-challenge",
  }
  for (const s of AUTO_QUEUE_STATES)
    assert.equal(
      setAutoJobState(db, "s", s, { reason_kind: kindFor[s] ?? null }),
      1,
      s,
    )
})

test("a deferral without a reason is refused — a silent skip is not a deferral", (t) => {
  const db = store(t).open()
  enqueueAutoJobs(db, [{ slug: "s" }])
  assert.throws(
    () => setAutoJobState(db, "s", "deferred"),
    /requires a reason_kind/,
  )
  assert.equal(readAutoQueue(db)[0].state, "queued")
  // Phase 4.1: the kind must also be one the digest can count. This test used
  // to write `consent_tickbox` — the right concept spelled the wrong way, which
  // is precisely the drift a free-text column cannot notice and this one now
  // refuses.
  assert.throws(
    () =>
      setAutoJobState(db, "s", "deferred", {
        reason_kind: "consent_tickbox",
        reason_detail: "underscores are not the taxonomy's spelling",
      }),
    /unknown reason_kind/,
  )
  assert.equal(readAutoQueue(db)[0].state, "queued")
  assert.equal(
    setAutoJobState(db, "s", "deferred", {
      reason_kind: "consent-tickbox",
      reason_stage: "plan",
      reason_detail: "the user ticks those, always",
    }),
    1,
  )
  const row = readAutoQueue(db)[0]
  assert.equal(row.reason_kind, "consent-tickbox")
  assert.equal(row.reason_stage, "plan")
  assert.match(row.reason_detail, /the user ticks/)
})

test("enqueueing is idempotent and never resets a job already in flight", (t) => {
  const db = store(t).open()
  assert.equal(enqueueAutoJobs(db, slugs(3)), 3)
  claimAutoJob(db, "co-000", { run_id: "r" })
  setAutoJobState(db, "co-000", "submitted", { run_id: "r" })
  claimAutoJob(db, "co-001", { run_id: "r" })

  assert.equal(enqueueAutoJobs(db, slugs(5)), 2, "only the two new slugs")
  const byState = Object.fromEntries(
    readAutoQueue(db).map((r) => [r.slug, r.state]),
  )
  assert.equal(byState["co-000"], "submitted", "a finished job is not revived")
  assert.equal(byState["co-001"], "claimed", "a held job is not released")
  assert.equal(byState["co-002"], "queued")
})

test("enqueueAutoJobs refuses a row with no slug, and writes none of the batch", (t) => {
  const db = store(t).open()
  assert.throws(
    () => enqueueAutoJobs(db, [{ slug: "ok" }, { origin: "x" }]),
    /requires a slug/,
  )
  assert.equal(
    readAutoQueue(db).length,
    0,
    "the whole batch rolls back, so a partial queue is never left behind",
  )
})

// --- the lease ----------------------------------------------------------------

test("a claim held by a dead process is released back to the pool, and only after the lease", (t) => {
  const db = store(t).open()
  const t0 = new Date("2026-08-02T10:00:00.000Z")
  enqueueAutoJobs(db, [{ slug: "s" }], { now: t0 })
  claimAutoJob(db, "s", { run_id: "dead", now: t0 })

  const soon = new Date(t0.getTime() + 60_000)
  assert.equal(
    releaseStaleAutoClaims(db, { leaseMs: 30 * 60_000, now: soon }),
    0,
    "a worker one minute into a job is not dead",
  )
  assert.equal(claimAutoJob(db, "s", { run_id: "other", now: soon }), 0)

  const later = new Date(t0.getTime() + 31 * 60_000)
  assert.equal(
    releaseStaleAutoClaims(db, { leaseMs: 30 * 60_000, now: later }),
    1,
  )
  const row = readAutoQueue(db)[0]
  assert.equal(row.state, "queued")
  assert.equal(row.run_id, null)
  assert.equal(claimAutoJob(db, "s", { run_id: "other", now: later }), 1)
})

// --- 1.6: the bounded retry on SQLITE_BUSY ------------------------------------

test("withBusyRetry retries a busy write and returns the eventual success", () => {
  let calls = 0
  const slept = []
  const out = withBusyRetry(
    () => {
      calls += 1
      if (calls < 3) {
        const e = new Error("database is locked")
        e.code = "SQLITE_BUSY"
        throw e
      }
      return "written"
    },
    { sleep: (ms) => slept.push(ms) },
  )
  assert.equal(out, "written")
  assert.equal(calls, 3)
  assert.deepEqual(slept, [25, 50], "bounded backoff, not a spin")
})

test("withBusyRetry is BOUNDED: it gives up and rethrows rather than hanging", () => {
  let calls = 0
  assert.throws(
    () =>
      withBusyRetry(
        () => {
          calls += 1
          throw Object.assign(new Error("SQLITE_BUSY: database is locked"), {
            code: "SQLITE_BUSY",
          })
        },
        { attempts: 4, sleep: () => {} },
      ),
    /database is locked/,
  )
  assert.equal(calls, 4, "four tries, then an honest failure")
})

test("withBusyRetry never retries an error that is not contention", () => {
  let calls = 0
  assert.throws(
    () =>
      withBusyRetry(
        () => {
          calls += 1
          throw new Error("UNIQUE constraint failed: auto_queue.slug")
        },
        { sleep: () => {} },
      ),
    /UNIQUE constraint failed/,
  )
  assert.equal(calls, 1, "a constraint violation is an answer, not a wait")
})
