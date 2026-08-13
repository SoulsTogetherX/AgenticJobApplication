// Phase 4.2 — the auto section of the digest.
//
// THE CHECK THE PLAN NAMES: a fixture store containing an orphan, a paused
// board with stranded jobs, and a STOP must produce all three in the output.
// Each of those is a thing revision 1's digest could not show, and a run that
// has all three looks, by every number the old digest reported, like a quiet
// night.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  openDb,
  enqueueAutoJobs,
  claimAutoJob,
  setAutoJobState,
  recordAutoSubmission,
  recordBoardPause,
  upsertAutoRun,
  upsertApplications,
} from "../../scripts/lib/db.mjs"
import { buildAutoStatus, percentile } from "../../scripts/auto/digest.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const STATUS = path.join(ROOT, "scripts", "status.mjs")

const HOUR = 3_600_000
const NOW = new Date("2026-08-02T12:00:00Z")
const ago = (h) => new Date(NOW.getTime() - h * HOUR)

// A store holding one of everything that used to be invisible.
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aj-digest-"))
  const file = path.join(dir, "leads.db")
  const stopPath = path.join(dir, "STOP")
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
      /* a leaked lock must not fail an assertion that already passed */
    }
  })
  const db = openDb(file)
  handles.push(db)

  upsertAutoRun(db, {
    run_id: "run-1",
    started_at: ago(3).toISOString(),
    mode: "dry_run",
    outcome: "running",
    doc: JSON.stringify({ run_id: "run-1" }),
  })

  enqueueAutoJobs(
    db,
    [
      // Two greenhouse jobs that will be held by a pause.
      { slug: "gh-held-1", board_key: "greenhouse", run_id: "run-1" },
      { slug: "gh-held-2", board_key: "greenhouse", run_id: "run-1" },
      // One that has been sitting far longer than a scheduler cadence.
      { slug: "gh-stale", board_key: "greenhouse", run_id: "run-1" },
      // One submitted, with a posting date so latency is computable.
      {
        slug: "lv-sent",
        board_key: "lever",
        run_id: "run-1",
        posted_at: ago(30).toISOString(),
      },
      // One deferred for a reason engineering could remove.
      { slug: "lv-defer", board_key: "lever", run_id: "run-1" },
      // One orphan: a click went out and nothing ever said what happened.
      { slug: "ab-orphan", board_key: "ashby", run_id: "run-1" },
    ],
    { now: ago(2) },
  )
  // The stale one predates the cadence window.
  db.prepare(
    "UPDATE auto_queue SET updated_at = ? WHERE slug = 'gh-stale'",
  ).run(ago(20).toISOString())

  claimAutoJob(db, "lv-sent", { run_id: "run-1", board_key: "lever" })
  setAutoJobState(db, "lv-sent", "submitted", { run_id: "run-1" })
  recordAutoSubmission(db, {
    run_id: "run-1",
    slug: "lv-sent",
    company: "Lever Co",
    mode: "dry_run",
    submitted_at: ago(6).toISOString(),
    outcome: "submitted",
    doc: JSON.stringify({ ok: true }),
  })

  claimAutoJob(db, "lv-defer", { run_id: "run-1", board_key: "lever" })
  setAutoJobState(db, "lv-defer", "deferred", {
    run_id: "run-1",
    reason_kind: "unprobed-dropdown",
    reason_stage: "plan",
    reason_detail: "the Source dropdown was never probed",
  })

  claimAutoJob(db, "ab-orphan", { run_id: "run-1", board_key: "ashby" })
  setAutoJobState(db, "ab-orphan", "attempted", { run_id: "run-1" })
  recordAutoSubmission(db, {
    run_id: "run-1",
    slug: "ab-orphan",
    company: "Ashby Co",
    mode: "dry_run",
    submitted_at: ago(1).toISOString(),
    outcome: "attempted",
    apply_url: "https://jobs.ashbyhq.com/x/y",
    doc: JSON.stringify({}),
  })

  recordBoardPause(db, {
    board_key: "greenhouse",
    run_id: "run-1",
    reason_kind: "nav-timeout",
    reason_detail: "3 of the last 5 timed out",
    paused_at: ago(2),
  })

  upsertApplications(db, [])
  fs.writeFileSync(
    stopPath,
    "STOPPED\ncredential exposure at job 400\n",
    "utf8",
  )
  return { dir, file, stopPath, db }
}

test("percentile reports null on an empty sample, never zero", () => {
  assert.equal(percentile([], 95), null)
  assert.equal(percentile([5], 95), 5)
  // Nearest-rank: p50 of ten values is the fifth.
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5)
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10)
})

test("the three things a quiet-looking run hides all appear: orphan, pause, STOP", (t) => {
  const f = fixture(t)
  const a = buildAutoStatus(f.db, { now: NOW, stopPath: f.stopPath })

  // 1. The orphan — a click was issued and never resolved.
  assert.equal(a.orphans, 1)
  assert.ok(
    a.warnings.some((w) => w.kind === "orphan-attempt"),
    "an unresolved attempt must be a warning, not a row nobody reads",
  )

  // 2. The paused board, WITH the jobs it is holding. The count is the point:
  //    "greenhouse is paused" and "greenhouse is paused, holding 3" are
  //    different pieces of news.
  assert.equal(a.paused_boards.length, 1)
  assert.equal(a.paused_boards[0].board_key, "greenhouse")
  assert.equal(a.paused_boards[0].held, 3)

  // 3. The STOP, with the reason that explains it.
  assert.equal(a.stop.active, true)
  assert.match(a.stop.reason, /credential exposure/)
  assert.ok(a.warnings.some((w) => w.kind === "stopped"))
})

test("the digest reports progress, not recency", (t) => {
  const f = fixture(t)
  const a = buildAutoStatus(f.db, { now: NOW, stopPath: f.stopPath })

  // Depth, per state, plus the total that is the real headline.
  // The three greenhouse jobs. The submitted, deferred and attempted ones have
  // left the resumable set — an 'attempted' row is stranded, not outstanding.
  assert.equal(a.queue.outstanding, 3)
  assert.equal(a.queue.depth.queued, 3)
  assert.equal(a.queue.depth.claimed, 0)

  // Age p95 catches the job that has been sitting for 20 hours.
  assert.ok(a.queue.age_p95_ms.queued >= 19 * HOUR)
  assert.ok(
    a.warnings.some((w) => w.kind === "queue-stalled"),
    "a job older than one scheduler cadence is a WARN",
  )

  // Deferrals are grouped by the typed kind and by class.
  assert.equal(a.deferrals.by_kind["unprobed-dropdown"], 1)
  assert.equal(a.deferrals.by_class.understanding, 1)
  assert.equal(a.deferrals.by_board.lever["unprobed-dropdown"], 1)

  // posted_at -> submitted_at, which is the number the product is FOR.
  assert.equal(a.latency.n, 1)
  assert.equal(a.latency.p50_hours, 24)

  assert.equal(a.submitted_24h, 2) // the submission and the orphaned attempt
})

test("a challenge is reported as unconfirmed, never as sent", (t) => {
  const f = fixture(t)
  enqueueAutoJobs(f.db, [
    { slug: "gh-ch", board_key: "greenhouse", run_id: "run-1" },
  ])
  claimAutoJob(f.db, "gh-ch", { run_id: "run-1", board_key: "greenhouse" })
  setAutoJobState(f.db, "gh-ch", "challenged", {
    run_id: "run-1",
    reason_kind: "email-code-challenge",
    reason_stage: "post-submit",
  })
  const a = buildAutoStatus(f.db, { now: NOW, stopPath: f.stopPath })
  assert.equal(a.challenged, 1)
  assert.equal(
    a.submitted_total,
    1,
    "a challenge does not count as a submission",
  )
  const w = a.warnings.find((x) => x.kind === "unconfirmed")
  assert.match(w.detail, /UNCONFIRMED, not sent/)
})

test("the CLI itself emits every field 4.2 names", (t) => {
  const f = fixture(t)
  f.db.close()
  const out = execFileSync(
    process.execPath,
    [STATUS, "--json", "--db", f.file, "--stop-path", f.stopPath],
    { encoding: "utf8", cwd: ROOT },
  )
  const s = JSON.parse(out)
  assert.ok(s.auto, "status --json carries an auto object")
  for (const key of [
    "submitted_24h",
    "deferrals",
    "orphans",
    "challenged",
    "stop",
    "latency",
    "wall",
    "queue",
    "paused_boards",
    "warnings",
  ])
    assert.ok(key in s.auto, `auto.${key} is missing`)
  assert.equal(s.auto.stop.active, true)
  assert.equal(s.auto.paused_boards[0].board_key, "greenhouse")
  assert.equal(s.auto.orphans, 1)
})

// --- per-job wall time -----------------------------------------------------
//
// runJob has computed `wall_ms` for every job since the queue existed and
// written it nowhere, so the one question a latency-sensitive pipeline gets
// asked — is it slower than it was? — had no data behind it. These pin the
// whole path: the column persists, the reader excludes what it cannot know,
// and the digest reports it SEPARATELY from the posted→submitted hours.

test("per-job wall time is persisted, and reported by stage", (t) => {
  const f = fixture(t)
  const job = (slug, board, ms, state, extra = {}) => {
    enqueueAutoJobs(f.db, [{ slug, board_key: board, run_id: "run-1" }])
    claimAutoJob(f.db, slug, { run_id: "run-1", board_key: board })
    setAutoJobState(f.db, slug, state, {
      run_id: "run-1",
      wall_ms: ms,
      ...extra,
    })
  }
  // Three fills that went fine and one that sat in `plan` for 40 seconds —
  // the shape a single slow board makes, and the one a mean would hide.
  job("w-fast-1", "greenhouse", 1200, "submitted")
  job("w-fast-2", "greenhouse", 1400, "submitted")
  job("w-fast-3", "lever", 1600, "submitted")
  job("w-slow", "ashby", 40_000, "deferred", {
    reason_kind: "unprobed-dropdown",
    reason_stage: "plan",
  })

  const a = buildAutoStatus(f.db, { now: NOW, stopPath: f.stopPath })
  assert.equal(a.wall.n, 4, "one sample per job that recorded a duration")
  // Nearest-rank over [1200, 1400, 1600, 40000]: p50 is the 2nd value.
  assert.equal(a.wall.p50_ms, 1400)
  assert.equal(
    a.wall.p95_ms,
    40_000,
    "the tail is the whole point: one 40s job among four leaves the median " +
      "at 1.4s and moves the p95 by 30x",
  )

  // BY STAGE, because a total cannot be acted on.
  assert.equal(a.wall.by_stage.plan.n, 1)
  assert.equal(a.wall.by_stage.plan.p95_ms, 40_000)
  assert.equal(a.wall.by_stage.submitted.n, 3)
  assert.equal(a.wall.by_stage.submitted.p95_ms, 1600)
  assert.equal(
    Object.keys(a.wall.by_stage)[0],
    "plan",
    "the slowest stage is listed first; the ordering is the recommendation",
  )
  assert.deepEqual(a.wall.slowest, {
    slug: "w-slow",
    ms: 40_000,
    stage: "plan",
  })

  // The two latency blocks are DIFFERENT MEASUREMENTS and stay apart: one is
  // hours from posting to click, the other milliseconds inside our worker.
  assert.equal(a.latency.n, 1, "the market number is unchanged by any of this")
  assert.equal(a.latency.p50_hours, 24)
})

test("a job nobody timed is excluded from the sample, never counted as instant", (t) => {
  const f = fixture(t)
  enqueueAutoJobs(f.db, [
    { slug: "w-timed", board_key: "lever", run_id: "run-1" },
    { slug: "w-untimed", board_key: "lever", run_id: "run-1" },
  ])
  for (const slug of ["w-timed", "w-untimed"])
    claimAutoJob(f.db, slug, { run_id: "run-1", board_key: "lever" })
  setAutoJobState(f.db, "w-timed", "submitted", {
    run_id: "run-1",
    wall_ms: 900,
  })
  // A row written by an older build, or any path that records no duration.
  setAutoJobState(f.db, "w-untimed", "submitted", { run_id: "run-1" })

  const a = buildAutoStatus(f.db, { now: NOW, stopPath: f.stopPath })
  assert.equal(a.wall.n, 1, "an unknown duration is not a duration of zero")
  assert.equal(a.wall.p50_ms, 900, "and it does not drag the median down")
})

test("an intermediate state write does not erase a duration already recorded", (t) => {
  // The failure this guards: `setAutoJobState(..., 'attempted')` carries no
  // timing, and a plain assignment would blank the column on the way past. The
  // reason columns ARE overwritten — each write states the current reason —
  // but a duration is a fact about a job that already ran.
  const f = fixture(t)
  enqueueAutoJobs(f.db, [
    { slug: "w-seq", board_key: "greenhouse", run_id: "run-1" },
  ])
  claimAutoJob(f.db, "w-seq", { run_id: "run-1", board_key: "greenhouse" })
  setAutoJobState(f.db, "w-seq", "planned", { run_id: "run-1", wall_ms: 700 })
  setAutoJobState(f.db, "w-seq", "authorized", { run_id: "run-1" })
  setAutoJobState(f.db, "w-seq", "submitted", { run_id: "run-1", wall_ms: 950 })

  const a = buildAutoStatus(f.db, { now: NOW, stopPath: f.stopPath })
  assert.equal(a.wall.n, 1)
  assert.equal(a.wall.p50_ms, 950, "the last duration written wins")

  // And a garbage value is refused rather than stored: a negative or
  // non-finite duration would poison every percentile computed from it.
  enqueueAutoJobs(f.db, [
    { slug: "w-bad", board_key: "lever", run_id: "run-1" },
  ])
  claimAutoJob(f.db, "w-bad", { run_id: "run-1", board_key: "lever" })
  setAutoJobState(f.db, "w-bad", "submitted", {
    run_id: "run-1",
    wall_ms: -5,
  })
  assert.equal(
    buildAutoStatus(f.db, { now: NOW, stopPath: f.stopPath }).wall.n,
    1,
    "a negative duration is not a fast job",
  )
})

test("the digest never fails the whole command when the auto tables are empty", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aj-digest-empty-"))
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* a leaked lock must not fail a passing assertion */
    }
  })
  const file = path.join(dir, "leads.db")
  const db = openDb(file)
  db.close()
  const out = execFileSync(process.execPath, [STATUS, "--json", "--db", file], {
    encoding: "utf8",
    cwd: ROOT,
  })
  const a = JSON.parse(out).auto
  assert.equal(a.queue.outstanding, 0)
  assert.equal(a.latency.p50_ms, null, "no submissions is null latency, not 0")
  assert.equal(a.wall.n, 0)
  assert.equal(a.wall.p50_ms, null, "no jobs is null wall time, not 0")
  assert.equal(a.wall.slowest, null)
  assert.deepEqual(a.wall.by_stage, {})
  assert.deepEqual(a.warnings, [])
})
