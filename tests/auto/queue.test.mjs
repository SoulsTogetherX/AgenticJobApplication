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
  AUTO_DEFER_KINDS,
  AUTO_REQUEUEABLE_KINDS,
  readStaleDeferred,
} from "#lib/db.mjs"

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

// --- re-queuing a defer that something may since have resolved ---------------
//
// MEASURED 2026-08-17: three rows deferred 2026-08-04, attempt_no=1, never
// looked at again — because `deferred` is terminal and enqueue was a bare
// DO NOTHING. Two of them were blocked on a reason the code had fixed on
// 08-07. These pin the narrow exception and, more importantly, its edges.

test("a deferred row on a requeueable kind goes back to 'queued' on the next enqueue, and its next claim is attempt 2", (t) => {
  const db = store(t).open()
  assert.equal(enqueueAutoJobs(db, slugs(1)), 1)
  claimAutoJob(db, "co-000", { run_id: "r1", plan_sha256: "old" })
  setAutoJobState(db, "co-000", "deferred", {
    run_id: "r1",
    reason_kind: "confirm-field",
    reason_detail: "Are you legally authorized…",
  })
  assert.equal(readResumableAutoJobs(db).length, 0, "deferred is not resumable")

  assert.equal(enqueueAutoJobs(db, slugs(1)), 1, "the row was re-queued")
  const row = readAutoQueue(db)[0]
  assert.equal(row.state, "queued")
  assert.equal(row.reason_kind, null, "the old reason is cleared, not carried")
  assert.equal(
    row.plan_sha256,
    null,
    "the old plan is forgotten — it is rebuilt on claim",
  )
  assert.equal(
    row.attempt_no,
    1,
    "the enqueue itself does not count an attempt",
  )

  assert.equal(
    claimAutoJob(db, "co-000", { run_id: "r2", plan_sha256: "new" }),
    1,
  )
  assert.equal(readAutoQueue(db)[0].attempt_no, 2, "the claim counts it")
  assert.equal(readAutoQueue(db)[0].plan_sha256, "new")
})

test("every requeueable kind is re-queued; every other defer kind is left terminal", (t) => {
  const db = store(t).open()
  const kinds = [...AUTO_DEFER_KINDS]
  const jobs = kinds.map((k, i) => ({
    slug: `k-${i}`,
    origin: "o",
    board_key: "b",
  }))
  enqueueAutoJobs(db, jobs)
  kinds.forEach((kind, i) => {
    claimAutoJob(db, `k-${i}`, { run_id: "r" })
    setAutoJobState(db, `k-${i}`, "deferred", {
      run_id: "r",
      reason_kind: kind,
      reason_detail: kind,
    })
  })
  const n = enqueueAutoJobs(db, jobs)
  assert.equal(n, AUTO_REQUEUEABLE_KINDS.length)
  const byState = Object.fromEntries(
    readAutoQueue(db).map((r) => [r.slug, r.state]),
  )
  kinds.forEach((kind, i) => {
    const expect = AUTO_REQUEUEABLE_KINDS.includes(kind) ? "queued" : "deferred"
    assert.equal(byState[`k-${i}`], expect, `${kind} -> ${expect}`)
  })
  // The ones a board or the user's policy decided are named here so widening
  // the list is a visible act, not a drift.
  for (const k of [
    "posting-gone",
    "l3-rejected",
    "cap-company",
    "board-untrusted",
    "reconciled-not-sent",
    "captcha",
  ])
    assert.ok(!AUTO_REQUEUEABLE_KINDS.includes(k), `${k} stays terminal`)
})

test("re-queuing never touches attempted, submitted, challenged or failed rows", (t) => {
  const db = store(t).open()
  const jobs = slugs(4)
  enqueueAutoJobs(db, jobs)
  for (const j of jobs) claimAutoJob(db, j.slug, { run_id: "r" })
  setAutoJobState(db, "co-000", "attempted", { run_id: "r" })
  setAutoJobState(db, "co-001", "submitted", { run_id: "r" })
  setAutoJobState(db, "co-002", "challenged", {
    run_id: "r",
    reason_kind: "captcha",
    reason_detail: "x",
  })
  setAutoJobState(db, "co-003", "failed", {
    run_id: "r",
    reason_kind: "nav-timeout",
    reason_detail: "x",
  })
  assert.equal(enqueueAutoJobs(db, jobs), 0)
  const byState = Object.fromEntries(
    readAutoQueue(db).map((r) => [r.slug, r.state]),
  )
  assert.deepEqual(byState, {
    "co-000": "attempted",
    "co-001": "submitted",
    "co-002": "challenged",
    "co-003": "failed",
  })
})

test("readStaleDeferred counts deferred rows older than the threshold, oldest first, and says which will be looked at again", (t) => {
  const db = store(t).open()
  const jobs = slugs(3)
  enqueueAutoJobs(db, jobs)
  const old = new Date("2026-08-04T02:56:00Z")
  const fresh = new Date("2026-08-17T04:00:00Z")
  const now = new Date("2026-08-17T12:00:00Z")
  claimAutoJob(db, "co-000", { run_id: "r", now: old })
  setAutoJobState(db, "co-000", "deferred", {
    run_id: "r",
    reason_kind: "confirm-field",
    reason_detail: "x",
    now: old,
  })
  claimAutoJob(db, "co-001", { run_id: "r", now: old })
  setAutoJobState(db, "co-001", "deferred", {
    run_id: "r",
    reason_kind: "posting-gone",
    reason_detail: "x",
    now: old,
  })
  claimAutoJob(db, "co-002", { run_id: "r", now: fresh })
  setAutoJobState(db, "co-002", "deferred", {
    run_id: "r",
    reason_kind: "confirm-field",
    reason_detail: "x",
    now: fresh,
  })

  const stale = readStaleDeferred(db, { now })
  assert.deepEqual(
    stale.map((s) => s.slug),
    ["co-000", "co-001"],
    "the fresh one is not stale",
  )
  assert.equal(stale[0].requeueable, true)
  assert.equal(
    stale[1].requeueable,
    false,
    "posting-gone stands until a human changes something",
  )
  assert.ok(stale[0].age_ms > 13 * 24 * 3600 * 1000)
  assert.equal(readStaleDeferred(db, { now, olderThanMs: 0 }).length, 3)
})

// ---------------------------------------------------------------------------
// The row is SELF-DESCRIBING (2026-08-18). A queued job carries the apply_url it
// was trusted on, the lead id its screening verdict is keyed by, and the
// company/title the report names it by — so a row this invocation did not
// itself select (enqueued earlier, beyond --limit, or left by a crash) can be
// resumed from the database alone. The Torc Robotics defect: a lead with a
// perfectly good apply_url in the store deferred board-untrusted because the
// queue row knew nothing about it.
// ---------------------------------------------------------------------------

test("enqueue persists apply_url, lead_id, company and title on the row, and readResumableAutoJobs hands them back", (t) => {
  const db = store(t).open()
  assert.equal(
    enqueueAutoJobs(db, [
      {
        slug: "torc-build-tools",
        board_key: "job-boards.greenhouse.io/embed?for=torcrobotics",
        origin: "https://job-boards.greenhouse.io",
        apply_url:
          "https://job-boards.greenhouse.io/torcrobotics/jobs/8654323002",
        lead_id: "greenhouse:torcrobotics:8654323002",
        company: "Torc Robotics",
        title: "Software Engineer II - Build Tools",
      },
    ]),
    1,
  )
  const [row] = readResumableAutoJobs(db)
  assert.equal(
    row.apply_url,
    "https://job-boards.greenhouse.io/torcrobotics/jobs/8654323002",
  )
  assert.equal(row.lead_id, "greenhouse:torcrobotics:8654323002")
  assert.equal(row.company, "Torc Robotics")
  assert.equal(row.title, "Software Engineer II - Build Tools")
})

test("re-queuing a deferred row keeps its identity when the new batch carries none, and fills it in when the row had none", (t) => {
  const db = store(t).open()
  enqueueAutoJobs(db, [
    {
      slug: "a",
      apply_url: "https://jobs.ashbyhq.com/x/1/application",
      lead_id: "ashby:x:1",
    },
    { slug: "b" }, // an anonymous row, as every row was before the columns existed
  ])
  for (const s of ["a", "b"]) {
    claimAutoJob(db, s, { run_id: "r1" })
    setAutoJobState(db, s, "deferred", {
      run_id: "r1",
      reason_kind: "unknown-field",
      reason_detail: "x",
    })
  }
  // A re-queue that says nothing about identity must not erase what is there.
  assert.equal(enqueueAutoJobs(db, [{ slug: "a" }]), 1)
  let row = readAutoQueue(db).find((r) => r.slug === "a")
  assert.equal(row.state, "queued")
  assert.equal(
    row.apply_url,
    "https://jobs.ashbyhq.com/x/1/application",
    "COALESCE keeps the row's value",
  )
  assert.equal(row.lead_id, "ashby:x:1")

  // A re-queue that DOES know the identity fills a blank row in.
  assert.equal(
    enqueueAutoJobs(db, [
      {
        slug: "b",
        apply_url: "https://jobs.lever.co/y/2/apply",
        lead_id: "lever:y:2",
        company: "Y",
      },
    ]),
    1,
  )
  row = readAutoQueue(db).find((r) => r.slug === "b")
  assert.equal(row.apply_url, "https://jobs.lever.co/y/2/apply")
  assert.equal(row.lead_id, "lever:y:2")
  assert.equal(row.company, "Y")
})

test("identity is backfilled onto a row already in the queue without touching its state or attempt count", (t) => {
  const db = store(t).open()
  enqueueAutoJobs(db, [{ slug: "legacy" }])
  claimAutoJob(db, "legacy", { run_id: "r1" }) // held by a worker: the DO UPDATE branch must not fire
  assert.equal(
    enqueueAutoJobs(db, [
      {
        slug: "legacy",
        apply_url: "https://jobs.ashbyhq.com/z/3/application",
        lead_id: "ashby:z:3",
        title: "T",
      },
    ]),
    0,
    "a held row is neither added nor re-queued",
  )
  const row = readAutoQueue(db)[0]
  assert.equal(row.state, "claimed", "state untouched")
  assert.equal(row.attempt_no, 1, "attempt count untouched")
  assert.equal(
    row.apply_url,
    "https://jobs.ashbyhq.com/z/3/application",
    "but the row now knows its URL",
  )
  assert.equal(row.lead_id, "ashby:z:3")
  assert.equal(row.title, "T")
})

test("an existing database without the identity columns is healed on open, and old rows read NULL", (t) => {
  const s = store(t)
  // Build the pre-2026-08-18 table by hand, then open through openDb.
  const { DatabaseSync } = require_sqlite()
  const raw = new DatabaseSync(s.file)
  raw.exec(`CREATE TABLE auto_queue (
    slug TEXT PRIMARY KEY, run_id TEXT, board_key TEXT, origin TEXT, state TEXT NOT NULL,
    attempt_no INTEGER NOT NULL DEFAULT 0, plan_sha256 TEXT, reason_kind TEXT, reason_detail TEXT,
    claimed_at TEXT, updated_at TEXT)`)
  raw.exec(`INSERT INTO auto_queue (slug, state) VALUES ('old', 'queued')`)
  raw.close()
  const db = s.open()
  const cols = new Set(
    db
      .prepare("PRAGMA table_info(auto_queue)")
      .all()
      .map((c) => c.name),
  )
  for (const c of ["apply_url", "lead_id", "company", "title"])
    assert.ok(cols.has(c), `${c} added`)
  const [row] = readResumableAutoJobs(db)
  assert.equal(row.slug, "old")
  assert.equal(
    row.apply_url,
    null,
    "an old row is honestly blank, not invented",
  )
})

function require_sqlite() {
  // node:sqlite is what db.mjs itself uses; reached the same way the tests
  // for healAutoQueue's siblings reach it.
  return process.getBuiltinModule("node:sqlite")
}

// --- the staleness clock is the FIRST deferral, not the last write ----------
//
// MEASURED 2026-08-24. `setAutoJobState` overwrites `updated_at` on every
// write, and readStaleDeferred aged rows from it — so re-deferring a job RESET
// its staleness clock. readStaleDeferred's own doc says it exists to surface
// "a job that deferred once and was never looked at again", and a REQUEUEABLE
// deferral is looked at again on every enqueue, so the metric systematically
// excluded exactly the population it was built for. Only deferrals nothing
// could fix ever accumulated age.

test("re-deferring does NOT reset the staleness clock", (t) => {
  const db = store(t).open()
  enqueueAutoJobs(db, [{ slug: "s1", origin: "o", board_key: "b" }])
  claimAutoJob(db, "s1", { run_id: "r1" })
  const first = new Date("2026-08-20T00:00:00.000Z")
  setAutoJobState(db, "s1", "deferred", {
    run_id: "r1",
    reason_kind: "unknown-field",
    reason_detail: "first",
    now: first,
  })
  // Re-queued and deferred again three days later, as a requeueable kind is.
  enqueueAutoJobs(db, [{ slug: "s1", origin: "o", board_key: "b" }])
  claimAutoJob(db, "s1", { run_id: "r2" })
  const again = new Date("2026-08-23T00:00:00.000Z")
  setAutoJobState(db, "s1", "deferred", {
    run_id: "r2",
    reason_kind: "unknown-field",
    reason_detail: "again",
    now: again,
  })

  const now = new Date("2026-08-24T00:00:00.000Z")
  const stale = readStaleDeferred(db, { now })
  assert.equal(stale.length, 1, "4 days of being stuck must still read stale")
  assert.equal(stale[0].since, first.toISOString(), "aged from the FIRST defer")
  assert.equal(
    stale[0].last_seen,
    again.toISOString(),
    "the last write is still reported, just not used as the age",
  )
  assert.ok(stale[0].age_ms >= 4 * 24 * 3600 * 1000 - 1000)
})

test("THE FULL CYCLE: defer -> enqueue -> claim -> planned -> defer keeps the stamp", (t) => {
  // THIS IS THE TEST THAT WAS MISSING, AND ITS ABSENCE MADE THE WHOLE FEATURE
  // INERT. The pair above went enqueue -> claim -> deferred and passed, but
  // job.mjs writes `planned` for EVERY re-queued job on its way back to a
  // deferral, and the CASE's old `ELSE NULL` cleared the stamp on every
  // non-deferred transition — `planned` included. So in production the stamp
  // was wiped by the very cycle it exists to measure: defer 08-01 -> re-plan
  // -> stamp null -> re-defer, and readStaleDeferred(72h) on 08-06 returned
  // EMPTY.
  //
  // The test that stood here asserted `planned` clears the stamp, which is
  // the bug written down as an intention. It was not weakened, it was wrong.
  const db = store(t).open()
  const first = new Date("2026-08-20T00:00:00.000Z")
  enqueueAutoJobs(db, [{ slug: "s2", origin: "o", board_key: "b" }])
  claimAutoJob(db, "s2", { run_id: "r1" })
  setAutoJobState(db, "s2", "deferred", {
    run_id: "r1",
    reason_kind: "unknown-field",
    reason_detail: "x",
    now: first,
  })
  // The re-queue, exactly as job.mjs drives it.
  enqueueAutoJobs(db, [{ slug: "s2", origin: "o", board_key: "b" }])
  claimAutoJob(db, "s2", { run_id: "r2" })
  setAutoJobState(db, "s2", "planned", { run_id: "r2" })
  const mid = db
    .prepare("SELECT first_deferred_at FROM auto_queue WHERE slug='s2'")
    .get()
  assert.equal(
    mid.first_deferred_at,
    first.toISOString(),
    "an intermediate state is the same stuck job moving, not a fresh start",
  )
  setAutoJobState(db, "s2", "deferred", {
    run_id: "r2",
    reason_kind: "unknown-field",
    reason_detail: "x again",
    now: new Date("2026-08-23T00:00:00.000Z"),
  })
  const stale = readStaleDeferred(db, {
    now: new Date("2026-08-24T00:00:00.000Z"),
  })
  assert.equal(stale.length, 1, "four days stuck must read stale")
  assert.equal(stale[0].since, first.toISOString(), "aged from the FIRST defer")
})

test("a job that actually leaves the queue loses its deferral stamp", (t) => {
  // The honest reset, and the reason the CASE is a list rather than an ELSE:
  // these three mean the job is no longer waiting on a human. It was clicked,
  // it landed, or it hit a challenge.
  for (const state of ["attempted", "submitted", "challenged"]) {
    const db = store(t).open()
    const slug = `s-${state}`
    enqueueAutoJobs(db, [{ slug, origin: "o", board_key: "b" }])
    claimAutoJob(db, slug, { run_id: "r1" })
    setAutoJobState(db, slug, "deferred", {
      run_id: "r1",
      reason_kind: "unknown-field",
      reason_detail: "x",
      now: new Date("2026-08-20T00:00:00.000Z"),
    })
    setAutoJobState(db, slug, state, {
      run_id: "r1",
      // `challenged` is a reason-bearing state (hard rule 6: a silent skip is
      // not a deferral), so it must be given one even here.
      ...(state === "challenged" ? { reason_kind: "bot-challenge" } : {}),
    })
    const row = db
      .prepare("SELECT first_deferred_at FROM auto_queue WHERE slug = ?")
      .get(slug)
    assert.equal(row.first_deferred_at, null, state)
    db.close()
  }
})

test("a row written before the column ages from updated_at, as it always did", (t) => {
  // The additive-migration promise: an old queue keeps reporting exactly as it
  // used to rather than silently reading as brand new (age 0 = never stale).
  const db = store(t).open()
  enqueueAutoJobs(db, [{ slug: "s3", origin: "o", board_key: "b" }])
  claimAutoJob(db, "s3", { run_id: "r1" })
  setAutoJobState(db, "s3", "deferred", {
    run_id: "r1",
    reason_kind: "unknown-field",
    reason_detail: "x",
    now: new Date("2026-08-18T00:00:00.000Z"),
  })
  db.prepare("UPDATE auto_queue SET first_deferred_at = NULL").run()
  const stale = readStaleDeferred(db, {
    now: new Date("2026-08-24T00:00:00.000Z"),
  })
  assert.equal(stale.length, 1)
  assert.equal(stale[0].since, "2026-08-18T00:00:00.000Z")
})
