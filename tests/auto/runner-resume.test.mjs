// §4.11 invariant 3: a SIGKILL at each queue state leaves a RESUMABLE database
// and NEVER a duplicate.
//
// The kill is a real one, in a real child process (tests/fixtures/auto/kill-at.mjs):
// no finally block runs, no stream flushes, `run.finish()` never happens. An
// in-process simulation would exercise the tidying code, and the tidying code is
// precisely what a crash skips.
//
// THE PLAN SAYS "EACH OF THE 8 STATES" AND THERE ARE NINE.
// AUTO_QUEUE_STATES is queued, claimed, planned, authorized, attempted,
// submitted, challenged, deferred, failed. All nine are covered below; the
// plan's count is off by one and is recorded here rather than matched, because
// quietly testing eight of nine to agree with a sentence is how the ninth stays
// untested forever.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import {
  openDb,
  recordVerification,
  readResumableAutoJobs,
  readOrphanAttempts,
  AUTO_QUEUE_STATES,
  AUTO_QUEUE_RESUMABLE,
  AUTO_QUEUE_TERMINAL,
} from "../../src/lib/db.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const KILLER = path.join(ROOT, "tests", "fixtures", "auto", "kill-at.mjs")
const SLUG = "kill-me"

function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aj-kill-"))
  const dbFile = path.join(dir, "leads.db")
  const jobsDir = path.join(dir, "jobs")
  fs.mkdirSync(path.join(jobsDir, ".auto"), { recursive: true })
  fs.mkdirSync(path.join(jobsDir, SLUG), { recursive: true })
  const resume = path.join(jobsDir, SLUG, "resume.md")
  fs.writeFileSync(resume, "# resume\n")
  const docSha = crypto
    .createHash("sha256")
    .update(fs.readFileSync(resume))
    .digest("hex")
  const profileSha = "b".repeat(64)

  const db = openDb(dbFile)
  recordVerification(db, {
    slug: SLUG,
    mode: "resume",
    verdict: "pass",
    doc_sha256: docSha,
    profile_sha256: profileSha,
  })
  db.close()

  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* a leaked handle must not fail an assertion that already passed */
    }
  })
  return { dir, dbFile, jobsDir, docSha, profileSha }
}

/**
 * Drive a child to `state` and let it die there. Returns nothing useful on
 * purpose: every assertion is against the database it left behind.
 *
 * TELLING A KILL FROM A CRASH IS PLATFORM-SPECIFIC AND THE FIRST VERSION OF
 * THIS GOT IT WRONG. On POSIX a SIGKILLed child comes back with
 * `signal: 'SIGKILL', status: null`; on Windows there are no signals,
 * `process.kill(pid, 'SIGKILL')` is TerminateProcess, and the child comes back
 * with a perfectly ordinary `status: 1`. Asserting on the exit code alone
 * therefore failed every crash leg here and would have PASSED on CI's Linux —
 * the worst shape of test failure, one that only shows up on the machine the
 * user actually runs.
 *
 * So the discriminator is the OUTPUT, not the code: a killed process writes
 * nothing, a process that threw writes a stack. Exit 97 is the fixture's own
 * marker for a platform that did not honour the kill at all.
 */
function driveTo(w, state, { expectCrash = false } = {}) {
  const args = [
    KILLER,
    "--db",
    w.dbFile,
    "--jobs-dir",
    w.jobsDir,
    "--state",
    state,
    "--doc-sha",
    w.docSha,
    "--profile-sha",
    w.profileSha,
  ]
  try {
    execFileSync(process.execPath, args, { stdio: "pipe", timeout: 30_000 })
    if (expectCrash)
      assert.fail(
        `the child exited cleanly at "${state}" — the kill did not happen, so ` +
          `this leg proves nothing about surviving a crash`,
      )
  } catch (e) {
    const stderr = String(e?.stderr ?? "")
    if (e?.status === 97)
      assert.fail("the child ran past process.kill — SIGKILL was not honoured")
    if (!expectCrash || /^\s+at /m.test(stderr))
      assert.fail(
        `kill-at.mjs failed for state "${state}" ` +
          `(exit ${e?.status ?? "none"}, signal ${e?.signal ?? "none"}):\n` +
          `${e?.stdout ?? ""}\n${stderr}`,
      )
    assert.ok(
      e.signal === "SIGKILL" || e.status !== 0,
      `the child at "${state}" neither signalled nor exited nonzero`,
    )
  }
}

const queueRow = (dbFile) => {
  const db = openDb(dbFile)
  try {
    return db.prepare("SELECT * FROM auto_queue WHERE slug = ?").get(SLUG)
  } finally {
    db.close()
  }
}

const submissionRows = (dbFile) => {
  const db = openDb(dbFile)
  try {
    return db.prepare("SELECT * FROM auto_submissions WHERE slug = ?").all(SLUG)
  } finally {
    db.close()
  }
}

// The five states a crash can land ON, and the four terminal ones a completed
// job lands on. Written as one list so a state added to AUTO_QUEUE_STATES and
// not to this file fails the last test in this file rather than going untested.
const CRASHED = ["queued", "claimed", "planned", "authorized", "attempted"]
const COMPLETED = ["submitted", "deferred", "failed", "challenged"]

for (const state of CRASHED) {
  test(`SIGKILL at "${state}" leaves a readable, correctly-typed database`, (t) => {
    const w = world(t)
    driveTo(w, state, { expectCrash: true })
    const row = queueRow(w.dbFile)
    assert.ok(row, `no auto_queue row survived the kill at "${state}"`)
    assert.equal(row.state, state)
  })
}

for (const state of COMPLETED) {
  test(`a job that reached "${state}" is terminal, not resumable`, (t) => {
    const w = world(t)
    driveTo(w, state)
    const row = queueRow(w.dbFile)
    assert.ok(row, `no auto_queue row for "${state}"`)
    assert.equal(row.state, state)
    assert.ok(AUTO_QUEUE_TERMINAL.has(row.state), `"${state}" must be terminal`)
    if (state !== "submitted")
      assert.ok(
        row.reason_kind,
        `a ${state} job must carry a reason_kind — a silent skip is not a ` +
          `deferral (hard rule 6)`,
      )
    const db = openDb(w.dbFile)
    const resumable = readResumableAutoJobs(db).map((r) => r.slug)
    db.close()
    assert.deepEqual(
      resumable,
      [],
      "a terminal job must not be picked up again",
    )
  })
}

test("the four resumable states ARE resumed, and 'attempted' is NOT", (t) => {
  // The line the whole design turns on. 'attempted' is excluded from the resume
  // set on purpose: that click may already be an application, so it belongs to
  // a human and to the orphan brake, never to an automatic retry.
  for (const state of ["queued", "claimed", "planned", "authorized"]) {
    const w = world(t)
    driveTo(w, state, { expectCrash: true })
    const db = openDb(w.dbFile)
    const resumable = readResumableAutoJobs(db).map((r) => r.slug)
    db.close()
    assert.deepEqual(
      resumable,
      [SLUG],
      `a job killed at "${state}" must be resumable`,
    )
  }

  const w = world(t)
  driveTo(w, "attempted", { expectCrash: true })
  const db = openDb(w.dbFile)
  const resumable = readResumableAutoJobs(db).map((r) => r.slug)
  const orphans = readOrphanAttempts(db)
  db.close()
  assert.deepEqual(
    resumable,
    [],
    "a job killed at 'attempted' must NOT be automatically retried",
  )
  assert.equal(
    orphans.length,
    1,
    "it must surface as an orphan instead, so the next run refuses to start " +
      "until a human has looked at the URL",
  )
  assert.equal(orphans[0].slug, SLUG)
  assert.ok(orphans[0].apply_url, "the orphan says where the click was aimed")
})

test("resuming after a crash never produces a duplicate submission row", (t) => {
  // The failure this is written against: a crash at 'planned', a resume, and
  // TWO applications at one employer. `(slug, mode)` is what makes the second
  // one impossible, and the assertion is on the row count rather than on any
  // message.
  const w = world(t)
  driveTo(w, "planned", { expectCrash: true })
  assert.equal(submissionRows(w.dbFile).length, 0)

  // A second invocation picks the job up and carries it to the end.
  //
  // LIVE mode since 2026-08-24: a dry run no longer reaches `submitted` at all
  // — it ends at `deferred/rehearsed`, because a rehearsal writing the terminal
  // row let it permanently consume the live slot for a slug (job.mjs has the
  // measured case). The fixture's `submitted` leg therefore runs
  // live-against-nothing, exactly as its `challenged` leg already did. What
  // this test is about — one row, never two — is unchanged, and the mode
  // assertion now pins the mode the leg actually runs in.
  driveTo(w, "submitted")
  const after = submissionRows(w.dbFile)
  assert.equal(after.length, 1, "exactly one row, after a crash and a resume")
  assert.equal(after[0].mode, "live")
  assert.equal(after[0].outcome, "submitted")

  // And a THIRD invocation adds nothing: the queue row is terminal, so the job
  // is never claimed again.
  driveTo(w, "submitted")
  assert.equal(
    submissionRows(w.dbFile).length,
    1,
    "a terminal job re-offered to the runner must not produce a second row",
  )
})

test("every state in AUTO_QUEUE_STATES is covered by this file", () => {
  assert.deepEqual(
    [...CRASHED, ...COMPLETED].sort(),
    [...AUTO_QUEUE_STATES].sort(),
    "a state was added to the queue and not to this test file",
  )
  // And the two sets are exactly the resumable/terminal split, so this file
  // cannot drift from db.mjs's own definition of which is which.
  assert.deepEqual(
    CRASHED.filter((s) => AUTO_QUEUE_RESUMABLE.has(s)).sort(),
    [...AUTO_QUEUE_RESUMABLE].sort(),
  )
  assert.deepEqual(COMPLETED.sort(), [...AUTO_QUEUE_TERMINAL].sort())
})
