import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  startRun,
  hashProfile,
  capCheck,
  PROFILE_FILES,
} from "../../scripts/auto/audit.mjs"
import { openDb, upsertApplications } from "../../scripts/lib/db.mjs"
import { StopError, readStop } from "../../scripts/auto/guard.mjs"

function sandbox({ profile = "name: x\n", answers = "answers: []\n" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aj-audit-"))
  const jobsDir = path.join(root, "jobs")
  const autoDir = path.join(jobsDir, ".auto")
  const profileDir = path.join(root, "profile")
  fs.mkdirSync(autoDir, { recursive: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, "profile.yaml"), profile)
  fs.writeFileSync(path.join(profileDir, "answers.yaml"), answers)
  return {
    root,
    jobsDir,
    autoDir,
    profileDir,
    dbFile: path.join(jobsDir, "leads.db"),
    stopPath: path.join(autoDir, "STOP"),
    opts: {
      autoDir,
      profileDir,
      dbFile: path.join(jobsDir, "leads.db"),
    },
  }
}

const lines = (file) =>
  fs
    .readFileSync(file, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((l) => JSON.parse(l))

const fullSubmission = (slug) => ({
  slug,
  company: "Acme",
  title: "Full-Stack Developer",
  plan_sha256: "a".repeat(64),
  verify: { ok: true, checks: 12 },
  consent_labels: [],
  screenshots: { before: "before.png", after: "after.png" },
  confirmation_url: "https://example.test/confirmation/1",
})

// --- opening a run -----------------------------------------------------------

test("startRun refuses to guess whether it may send real applications", () => {
  const s = sandbox()
  assert.throws(() => startRun({ ...s.opts }), TypeError)
  assert.throws(() => startRun({ mode: "maybe", ...s.opts }), TypeError)
})

test("startRun writes BOTH copies: the JSONL and the auto_runs row", () => {
  const s = sandbox()
  const run = startRun({ mode: "dry_run", ...s.opts })
  const ev = lines(run.jsonl)
  assert.equal(ev.length, 1)
  assert.equal(ev[0].t, "run.start")
  assert.equal(ev[0].mode, "dry_run")
  for (const f of PROFILE_FILES)
    assert.match(ev[0].profile[f], /^[0-9a-f]{64}$/)

  const db = openDb(s.dbFile)
  try {
    const row = db
      .prepare("SELECT * FROM auto_runs WHERE run_id = ?")
      .get(run.id)
    assert.equal(
      row.outcome,
      "running",
      "a run that dies is visible, not absent",
    )
    assert.equal(row.finished_at, null)
    assert.equal(row.mode, "dry_run")
    assert.ok(row.profile_sha_start)
  } finally {
    db.close()
  }
})

test("CHECKPOINT 1: startRun refuses while STOP is set, before anything is created", () => {
  const s = sandbox()
  fs.writeFileSync(s.stopPath, "")
  assert.throws(
    () => startRun({ mode: "live", ...s.opts }),
    (e) => e instanceof StopError && e.checkpoint === "run-start",
  )
  assert.equal(
    fs.existsSync(path.join(s.autoDir, "runs")),
    false,
    "a refused run leaves no artifacts behind",
  )
})

// --- the checkpoints ---------------------------------------------------------

test("CHECKPOINT 2: a STOP appearing mid-run halts the next job", () => {
  const s = sandbox()
  const run = startRun({ mode: "dry_run", ...s.opts })
  assert.equal(run.beginJob({ slug: "one" }), true)
  fs.writeFileSync(s.stopPath, "user pulled the brake")
  assert.throws(
    () => run.beginJob({ slug: "two" }),
    (e) => e instanceof StopError && e.checkpoint === "between-jobs",
  )
})

test("CHECKPOINT 3: preSubmitCheck reads the switch again, immediately before the click", () => {
  const s = sandbox()
  const run = startRun({ mode: "dry_run", ...s.opts })
  run.beginJob({ slug: "one" })
  assert.ok(run.preSubmitCheck({ slug: "one" }))
  // The window this exists for: the switch was clear at the start of the job
  // and is set by the time we reach the button.
  fs.writeFileSync(s.stopPath, "raced")
  assert.throws(
    () => run.preSubmitCheck({ slug: "one" }),
    (e) => e instanceof StopError && e.checkpoint === "pre-submit",
  )
})

test("a submission recorded without a pre-submit check STOPS the runner", () => {
  const s = sandbox()
  const run = startRun({ mode: "live", ...s.opts })
  run.beginJob({ slug: "one" })
  // No preSubmitCheck — the checkpoint that cannot be reconstructed afterwards.
  const row = run.recordSubmission(fullSubmission("one"))
  assert.ok(
    row,
    "the record is still written — an application cannot be unsent",
  )
  assert.match(
    readStop({ stopPath: s.stopPath }),
    /without a matching pre-submit/,
  )
  assert.ok(lines(run.jsonl).some((e) => e.t === "submit.unchecked"))
})

test("one pre-submit check authorises exactly one submission", () => {
  const s = sandbox()
  const run = startRun({ mode: "live", ...s.opts })
  run.beginJob({ slug: "one" })
  run.preSubmitCheck({ slug: "one" })
  run.recordSubmission(fullSubmission("one"))
  assert.equal(
    readStop({ stopPath: s.stopPath }),
    null,
    "the first one is clean",
  )

  run.recordSubmission({ ...fullSubmission("two"), slug: "two" })
  assert.match(
    readStop({ stopPath: s.stopPath }),
    /without a matching pre-submit/,
    "the ticket is single-use",
  )
})

test("a pre-submit check for one job does not authorise a different job", () => {
  const s = sandbox()
  const run = startRun({ mode: "live", ...s.opts })
  run.preSubmitCheck({ slug: "one" })
  run.recordSubmission(fullSubmission("two"))
  assert.match(readStop({ stopPath: s.stopPath }), /"two"/)
})

// --- the record itself -------------------------------------------------------

test("a submission missing audit fields is still recorded, and then stops the runner", () => {
  const s = sandbox()
  const run = startRun({ mode: "live", ...s.opts })
  run.preSubmitCheck({ slug: "one" })
  const partial = fullSubmission("one")
  delete partial.confirmation_url
  delete partial.screenshots
  const row = run.recordSubmission(partial)

  assert.deepEqual(row.audit_incomplete.sort(), [
    "confirmation_url",
    "screenshots",
  ])
  const db = openDb(s.dbFile)
  try {
    const stored = db
      .prepare("SELECT * FROM auto_submissions WHERE run_id = ? AND slug = ?")
      .get(run.id, "one")
    assert.ok(
      stored,
      "losing the record is strictly worse than an incomplete one",
    )
    assert.equal(stored.confirmation_url, null)
  } finally {
    db.close()
  }
  assert.match(
    readStop({ stopPath: s.stopPath }),
    /cannot support a manual withdrawal/,
  )
})

test("a complete submission lands in both copies with its plan hash and confirmation url", () => {
  const s = sandbox()
  const run = startRun({ mode: "live", ...s.opts })
  run.preSubmitCheck({ slug: "one" })
  run.recordSubmission(fullSubmission("one"))

  const done = lines(run.jsonl).find((e) => e.t === "submit.done")
  assert.equal(done.confirmation_url, "https://example.test/confirmation/1")
  assert.deepEqual(done.verify, { ok: true, checks: 12 })

  const db = openDb(s.dbFile)
  try {
    const row = db.prepare("SELECT * FROM auto_submissions").get()
    assert.equal(row.plan_sha256, "a".repeat(64))
    assert.equal(row.mode, "live")
    assert.equal(JSON.parse(row.doc).verify.checks, 12)
  } finally {
    db.close()
  }
})

test("a deferral with no stated reason is recorded as the defect it is", () => {
  const s = sandbox()
  const run = startRun({ mode: "dry_run", ...s.opts })
  run.deferJob({ slug: "one" }, "")
  const ev = lines(run.jsonl).find((e) => e.t === "job.defer")
  assert.match(ev.reason, /NO REASON GIVEN/, "a silent skip is not a deferral")
})

test("the JSONL is append-only: earlier events survive every later write", () => {
  const s = sandbox()
  const run = startRun({ mode: "dry_run", ...s.opts })
  run.beginJob({ slug: "one" })
  run.deferJob({ slug: "one" }, "consent tickbox")
  run.failJob({ slug: "two" }, new Error("timeout"))
  run.finish({ outcome: "ok" })
  const types = lines(run.jsonl).map((e) => e.t)
  assert.deepEqual(types, [
    "run.start",
    "job.begin",
    "job.defer",
    "job.fail",
    "run.finish",
  ])
})

// --- the fact base -----------------------------------------------------------

test("hashProfile hashes both files and tolerates a missing one", () => {
  const s = sandbox()
  const h = hashProfile({ profileDir: s.profileDir })
  assert.match(h["profile.yaml"], /^[0-9a-f]{64}$/)
  fs.rmSync(path.join(s.profileDir, "answers.yaml"))
  assert.equal(hashProfile({ profileDir: s.profileDir })["answers.yaml"], null)
})

test("profile/ changing during a run is an alarm, not a note", () => {
  const s = sandbox()
  const run = startRun({ mode: "dry_run", ...s.opts })
  fs.writeFileSync(
    path.join(s.profileDir, "answers.yaml"),
    "answers: [tampered]\n",
  )
  const final = run.finish()

  assert.notDeepEqual(final.profile_sha_start, final.profile_sha_end)
  const ev = lines(run.jsonl).find((e) => e.t === "run.finish")
  assert.equal(ev.profile_mutated, true)
  assert.match(
    readStop({ stopPath: s.stopPath }),
    /profile\/ changed during an unattended run/,
  )
})

test("an unchanged fact base finishes cleanly and records both hashes", () => {
  const s = sandbox()
  const run = startRun({ mode: "dry_run", ...s.opts })
  const final = run.finish()
  assert.deepEqual(final.profile_sha_start, final.profile_sha_end)
  assert.equal(final.outcome, "ok")
  assert.equal(readStop({ stopPath: s.stopPath }), null)

  const db = openDb(s.dbFile)
  try {
    const row = db.prepare("SELECT * FROM auto_runs").get()
    assert.equal(row.outcome, "ok")
    assert.ok(row.finished_at)
    assert.ok(row.profile_sha_end)
  } finally {
    db.close()
  }
})

test("finish is idempotent, so a double-close cannot rewrite the outcome", () => {
  const s = sandbox()
  const run = startRun({ mode: "dry_run", ...s.opts })
  const first = run.finish({ outcome: "ok" })
  const second = run.finish({ outcome: "error" })
  assert.deepEqual(first, second)
  assert.equal(lines(run.jsonl).filter((e) => e.t === "run.finish").length, 1)
})

test("a run that stopped itself finishes as 'stopped', whatever outcome is passed", () => {
  const s = sandbox()
  const run = startRun({ mode: "dry_run", ...s.opts })
  run.stop("two job failures")
  const final = run.finish({ outcome: "ok" })
  assert.equal(final.outcome, "stopped")
  assert.equal(final.stop_reason, "two job failures")
  assert.match(readStop({ stopPath: s.stopPath }), /two job failures/)
})

// --- the caps ----------------------------------------------------------------

test("capCheck refuses when the user has not configured the caps", () => {
  const s = sandbox()
  const r = capCheck({ company: "Acme", caps: {}, dbFile: s.dbFile })
  assert.equal(r.ok, false)
  assert.match(r.reason, /per_run_max, per_day_max, per_company_max_per_week/)
})

test("capCheck enforces per_run_max without touching the database", () => {
  const s = sandbox()
  const caps = { per_run_max: 3, per_day_max: 5, per_company_max_per_week: 1 }
  assert.equal(
    capCheck({ company: "Acme", caps, sentThisRun: 2, dbFile: s.dbFile }).ok,
    true,
  )
  const r = capCheck({
    company: "Acme",
    caps,
    sentThisRun: 3,
    dbFile: s.dbFile,
  })
  assert.equal(r.ok, false)
  assert.match(r.reason, /per_run_max reached \(3\/3\)/)
})

test("capCheck counts per_day across runs, not just the current one", () => {
  const s = sandbox()
  const caps = { per_run_max: 3, per_day_max: 2, per_company_max_per_week: 9 }
  const run = startRun({ mode: "live", ...s.opts })
  for (const slug of ["a", "b"]) {
    run.preSubmitCheck({ slug })
    run.recordSubmission({ ...fullSubmission(slug), company: `Co-${slug}` })
  }
  const r = capCheck({
    company: "Co-c",
    caps,
    sentThisRun: 0,
    dbFile: s.dbFile,
  })
  assert.equal(r.ok, false)
  assert.match(r.reason, /per_day_max reached \(2\/2\)/)
})

test("per_company_max_per_week counts MANUAL applications too", () => {
  const s = sandbox()
  const caps = { per_run_max: 3, per_day_max: 5, per_company_max_per_week: 1 }
  const db = openDb(s.dbFile)
  try {
    upsertApplications(db, [
      {
        slug: "acme-typed-by-hand",
        // Different casing and spacing from the lead's name on purpose: the two
        // ledgers get their company names from different places.
        company: "  ACME   ",
        title: "Full-Stack Developer",
        applied_at: new Date().toISOString(),
        status: "applied",
      },
    ])
  } finally {
    db.close()
  }
  const r = capCheck({ company: "Acme", caps, dbFile: s.dbFile })
  assert.equal(r.ok, false, "the employer sees both applications the same way")
  assert.match(r.reason, /per_company_max_per_week reached for Acme \(1\/1\)/)
  assert.equal(
    capCheck({ company: "Other Co", caps, dbFile: s.dbFile }).ok,
    true,
    "and it does not bleed onto a different employer",
  )
})

test("per_company_max_per_week ignores an application older than the window", () => {
  const s = sandbox()
  const caps = { per_run_max: 3, per_day_max: 5, per_company_max_per_week: 1 }
  const db = openDb(s.dbFile)
  try {
    upsertApplications(db, [
      {
        slug: "old",
        company: "Acme",
        title: "x",
        applied_at: new Date(Date.now() - 30 * 86400_000).toISOString(),
        status: "applied",
      },
    ])
  } finally {
    db.close()
  }
  assert.equal(capCheck({ company: "Acme", caps, dbFile: s.dbFile }).ok, true)
})

test("a dry-run submission still counts toward the caps", () => {
  const s = sandbox()
  const caps = { per_run_max: 3, per_day_max: 5, per_company_max_per_week: 1 }
  const run = startRun({ mode: "dry_run", ...s.opts })
  run.preSubmitCheck({ slug: "a" })
  run.recordSubmission(fullSubmission("a"))
  const r = capCheck({ company: "Acme", caps, dbFile: s.dbFile })
  assert.equal(
    r.ok,
    false,
    "the dry run must exercise the same arithmetic the live run will",
  )
})
