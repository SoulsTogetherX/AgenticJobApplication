import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  assertInsideJobs,
  assertNotProfile,
  assertNotStopped,
  stopActive,
  readStop,
  raiseStop,
  CHECKPOINTS,
  BoundaryError,
  StopError,
} from "../../scripts/auto/guard.mjs"
import * as guard from "../../scripts/auto/guard.mjs"

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aj-guard-"))
  const jobsDir = path.join(root, "jobs")
  fs.mkdirSync(path.join(jobsDir, ".auto"), { recursive: true })
  return { root, jobsDir, stopPath: path.join(jobsDir, ".auto", "STOP") }
}

// --- the filesystem boundary -------------------------------------------------

test("assertInsideJobs allows paths inside jobs/ and returns them resolved", () => {
  const { jobsDir } = sandbox()
  const p = path.join(jobsDir, "acme-dev", "resume.md")
  assert.equal(assertInsideJobs(p, { jobsDir }), path.resolve(p))
  assert.equal(assertInsideJobs(jobsDir, { jobsDir }), path.resolve(jobsDir))
})

test("assertInsideJobs refuses a traversal out of jobs/", () => {
  const { jobsDir } = sandbox()
  for (const bad of [
    path.join(jobsDir, "..", "profile", "answers.yaml"),
    path.join(jobsDir, "a", "..", "..", "escaped.txt"),
    path.resolve(os.tmpdir(), "elsewhere.txt"),
  ]) {
    assert.throws(
      () => assertInsideJobs(bad, { jobsDir }),
      (e) => e instanceof BoundaryError && e.code === "EOUTSIDEJOBS",
      `should refuse ${bad}`,
    )
  }
})

test("assertInsideJobs refuses a path that is lexically clean but symlinked out", (t) => {
  const { root, jobsDir } = sandbox()
  const outside = path.join(root, "outside")
  fs.mkdirSync(outside)
  const link = path.join(jobsDir, "sneaky")
  try {
    // 'junction' works on Windows without elevation; POSIX ignores the type.
    fs.symlinkSync(outside, link, "junction")
  } catch (e) {
    // A loud skip with a reason, per the test gate: an environment that
    // forbids links cannot exercise this, and silence would look like a pass.
    t.skip(`cannot create a link in this environment: ${e.code ?? e.message}`)
    return
  }
  const target = path.join(link, "stolen.txt")
  // Lexically this sits under jobs/. Only realpath catches it.
  assert.ok(path.resolve(target).startsWith(path.resolve(jobsDir)))
  assert.throws(
    () => assertInsideJobs(target, { jobsDir }),
    (e) =>
      e instanceof BoundaryError &&
      /link is pointing out of the tree/.test(e.message),
  )
})

test("assertNotProfile refuses the fact base and passes everything else", () => {
  assert.throws(
    () => assertNotProfile(path.join(guard.PROFILE_DIR, "answers.yaml")),
    (e) => e instanceof BoundaryError && /hard rule 2/.test(e.message),
  )
  assert.throws(() => assertNotProfile(guard.PROFILE_DIR), BoundaryError)
  const ok = path.join(guard.JOBS_DIR, "x", "job.json")
  assert.equal(assertNotProfile(ok), path.resolve(ok))
})

// --- the kill switch ---------------------------------------------------------

test("an EMPTY STOP file stops just as hard as an annotated one", () => {
  const { stopPath } = sandbox()
  assert.equal(stopActive({ stopPath }), false)
  // Exactly what `type nul > jobs\.auto\STOP` produces: zero bytes.
  fs.writeFileSync(stopPath, "")
  assert.equal(stopActive({ stopPath }), true)
  assert.equal(
    readStop({ stopPath }),
    null,
    "no reason recorded, still stopped",
  )
  assert.throws(
    () => assertNotStopped(CHECKPOINTS.RUN_START, { stopPath }),
    (e) => e instanceof StopError && e.code === "ESTOP",
  )
})

test("all three checkpoints are checked, and each names itself in the error", () => {
  const { stopPath } = sandbox()
  fs.writeFileSync(stopPath, "two job failures")
  const seen = []
  for (const cp of Object.values(CHECKPOINTS)) {
    assert.throws(
      () => assertNotStopped(cp, { stopPath }),
      (e) => {
        assert.equal(e.checkpoint, cp)
        assert.equal(e.reason, "two job failures")
        assert.match(e.message, new RegExp(cp))
        seen.push(cp)
        return true
      },
    )
  }
  assert.deepEqual(seen.sort(), ["between-jobs", "pre-submit", "run-start"])
})

test("an unnamed checkpoint is a TypeError, not a silent pass", () => {
  const { stopPath } = sandbox()
  assert.throws(
    () => assertNotStopped("somewhere", { stopPath }),
    (e) =>
      e instanceof TypeError &&
      /unknown kill-switch checkpoint/.test(e.message),
  )
  // And it must fail even when there is no STOP — otherwise a typo'd checkpoint
  // silently "passes" every day until the one day it matters.
  assert.throws(() => assertNotStopped("", { stopPath }), TypeError)
  assert.throws(() => assertNotStopped(undefined, { stopPath }), TypeError)
})

test("assertNotStopped passes cleanly when no STOP exists", () => {
  const { stopPath } = sandbox()
  assert.equal(assertNotStopped(CHECKPOINTS.PRE_SUBMIT, { stopPath }), true)
})

test("raiseStop records the reason, and the FIRST reason wins", () => {
  const { stopPath, jobsDir } = sandbox()
  assert.equal(
    raiseStop("post-submit page was not a confirmation", { stopPath, jobsDir }),
    true,
  )
  assert.match(
    readStop({ stopPath }),
    /post-submit page was not a confirmation/,
  )
  assert.match(
    readStop({ stopPath }),
    /will not run again until this file is deleted/,
  )

  assert.equal(
    raiseStop("a blander later anomaly", { stopPath, jobsDir }),
    false,
    "an existing STOP is never overwritten",
  )
  assert.match(
    readStop({ stopPath }),
    /post-submit page was not a confirmation/,
  )
  assert.doesNotMatch(readStop({ stopPath }), /blander/)
})

test("raiseStop will not write a STOP outside jobs/", () => {
  const outside = path.join(os.tmpdir(), "aj-not-jobs", "STOP")
  assert.throws(() => raiseStop("x", { stopPath: outside }), BoundaryError)
})

test("there is deliberately no way for the code to clear its own brake", () => {
  // Self-disabling is the rollback. An application cannot be unsent, so
  // re-enabling is the user's act. A clearStop() appearing here later would
  // silently undo that, which is why this asserts the absence.
  for (const name of Object.keys(guard)) {
    assert.doesNotMatch(
      name,
      /^(clearStop|resetStop|removeStop|deleteStop|unstop)$/i,
      `guard.mjs must not export ${name}`,
    )
  }
})
