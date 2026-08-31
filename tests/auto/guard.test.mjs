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
} from "../../src/auto/guard.mjs"
import * as guard from "../../src/auto/guard.mjs"

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

// --- the scope of a STOP (§4.9) ----------------------------------------------
//
// The property under test throughout this section is ONE sentence: a brake says
// only what it has evidence about. Every test below is either "the brake still
// brakes" or "it stops braking things it knows nothing about", and both halves
// have to hold or the change is a weakening rather than a narrowing.

test("a company brake stops that company and nothing else", () => {
  const { jobsDir, stopPath } = sandbox()
  raiseStop("an orphan at acme", {
    scope: "company",
    key: "Acme",
    stopPath,
    jobsDir,
    notify: () => {},
  })

  assert.throws(
    () =>
      assertNotStopped(CHECKPOINTS.PRE_SUBMIT, { stopPath, company: "Acme" }),
    (e) => e instanceof StopError && e.scope === "company" && e.key === "acme",
  )
  assert.ok(
    assertNotStopped(CHECKPOINTS.PRE_SUBMIT, { stopPath, company: "Globex" }),
    "a different company is untouched",
  )
  assert.ok(
    assertNotStopped(CHECKPOINTS.PRE_SUBMIT, { stopPath, board: "greenhouse" }),
    "and so is the board it happens to sit on",
  )
  assert.equal(stopActive({ stopPath }), false, "the global brake is not set")
})

test("a caller that names no scope sees only the global brake", () => {
  // The backwards-compatibility property, and it is the one that makes this
  // change safe to land: nothing written before scopes existed changed meaning.
  const { jobsDir, stopPath } = sandbox()
  raiseStop("acme only", {
    scope: "company",
    key: "acme",
    stopPath,
    jobsDir,
    notify: () => {},
  })
  assert.ok(assertNotStopped(CHECKPOINTS.RUN_START, { stopPath }))

  raiseStop("everything", { stopPath, jobsDir, notify: () => {} })
  assert.throws(
    () => assertNotStopped(CHECKPOINTS.RUN_START, { stopPath }),
    (e) => e instanceof StopError && e.scope === "global",
  )
})

test("the global brake is reported first when several apply", () => {
  const { jobsDir, stopPath } = sandbox()
  const opts = { stopPath, jobsDir, notify: () => {} }
  raiseStop("company reason", { ...opts, scope: "company", key: "acme" })
  raiseStop("global reason", opts)
  assert.throws(
    () =>
      assertNotStopped(CHECKPOINTS.PRE_SUBMIT, { stopPath, company: "acme" }),
    (e) => e instanceof StopError && /global reason/.test(e.message),
    "the widest brake explains the most, so it is the one the user reads",
  )
})

test("a scoped raiseStop with no key THROWS rather than widening to global", () => {
  // THE LOAD-BEARING REFUSAL. A caller that meant "brake this board" and passed
  // an empty key must fail loudly. Falling back to global would mean a bug in
  // one call site quietly costs a whole night of applications.
  const { jobsDir, stopPath } = sandbox()
  const opts = { stopPath, jobsDir, notify: () => {} }
  for (const key of [null, undefined, "", "   ", "///", "..", "-.-"]) {
    assert.throws(
      () => raiseStop("x", { ...opts, scope: "board", key }),
      TypeError,
      `key ${JSON.stringify(key)} must be refused, not widened`,
    )
  }
  assert.equal(stopActive({ stopPath }), false, "and nothing was written")
})

test("a global raiseStop that was handed a key THROWS", () => {
  // The mirror of the rule above: a caller that named a key meant to scope
  // this, and silently ignoring it would halt every board instead of one.
  const { jobsDir, stopPath } = sandbox()
  assert.throws(
    () =>
      raiseStop("x", {
        key: "acme",
        stopPath,
        jobsDir,
        notify: () => {},
      }),
    TypeError,
  )
})

test("an unknown scope is a TypeError, not a silent global", () => {
  const { jobsDir, stopPath } = sandbox()
  assert.throws(
    () =>
      raiseStop("x", {
        scope: "team",
        key: "a",
        stopPath,
        jobsDir,
        notify: () => {},
      }),
    TypeError,
  )
  assert.throws(() => guard.scopedStopPath("origin", "a"), TypeError)
})

test("a scope key cannot traverse out of the stops directory", () => {
  // The key is DATA — a company name off a lead. The closed character class is
  // the control; assertInsideJobs is the second net, not the first.
  for (const hostile of [
    "../../../etc/passwd",
    "..\..\Windows\system32",
    "acme/../../escape",
    "a\u0000b",
  ]) {
    const p = guard.scopedStopPath("company", hostile, {
      stopPath: "/x/jobs/.auto/STOP",
    })
    assert.ok(
      !path.relative("/x/jobs/.auto/stops", p).startsWith(".."),
      `${hostile} must stay under stops/: got ${p}`,
    )
  }
})

test("stopKey collapses to a filename, and collisions can only OVER-block", () => {
  assert.equal(guard.stopKey("Acme, Inc."), "acme-inc")
  assert.equal(guard.stopKey("Acme Inc"), "acme-inc")
  assert.equal(guard.stopKey("  Globex  "), "globex")
  assert.ok(guard.stopKey("x".repeat(500)).length <= 80)
})

test("the stops directory follows the stopPath seam", () => {
  // A sandbox that moved only HALF the switch would read the real
  // jobs/.auto/stops while claiming to be isolated — a test passing on the
  // developer's own brake files is worse than no test.
  const { jobsDir, stopPath } = sandbox()
  raiseStop("sandboxed", {
    scope: "board",
    key: "greenhouse",
    stopPath,
    jobsDir,
    notify: () => {},
  })
  const written = path.join(jobsDir, ".auto", "stops", "board", "greenhouse")
  assert.ok(fs.existsSync(written), `expected the brake at ${written}`)
  assert.ok(
    !fs.existsSync(path.join(guard.STOPS_DIR, "board", "greenhouse")),
    "and NOT in the real tree",
  )
})

test("a scoped STOP will not be written outside jobs/ either", () => {
  const outside = path.join(os.tmpdir(), "aj-not-jobs", "STOP")
  assert.throws(
    () => raiseStop("x", { scope: "company", key: "acme", stopPath: outside }),
    BoundaryError,
  )
})

test("activeStops reports every brake that applies, widest first", () => {
  const { jobsDir, stopPath } = sandbox()
  const opts = { stopPath, jobsDir, notify: () => {} }
  raiseStop("board reason", { ...opts, scope: "board", key: "greenhouse" })
  raiseStop("company reason", { ...opts, scope: "company", key: "acme" })
  raiseStop("run reason", { ...opts, scope: "run", key: "run-1" })

  const all = guard.activeStops({
    stopPath,
    board: "greenhouse",
    company: "acme",
    runId: "run-1",
  })
  assert.deepEqual(
    all.map((s) => s.scope),
    ["run", "board", "company"],
  )
  assert.deepEqual(
    guard.activeStops({ stopPath, company: "globex" }),
    [],
    "and a job on none of them is clear",
  )
})

test("there is no way for the code to clear a SCOPED brake either", () => {
  // The absence asserted above is asserted again at the new surface: scoping
  // the halt must not be the change that quietly introduces self-clearing.
  for (const name of Object.keys(guard)) {
    assert.doesNotMatch(
      name,
      /(clear|reset|remove|delete|lift|resume|unpause).*stop/i,
      `guard.mjs must not export ${name}`,
    )
  }
})
