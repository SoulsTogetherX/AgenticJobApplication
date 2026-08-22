// A fill plan is a CACHED DERIVATION of (scan, planner, fact base), and only
// the scan is bound to it. So a plan on disk can disagree with what current
// code would decide, and pending-questions.mjs used to read that disagreement
// straight back to the user as an open question.
//
// The incident these tests pin (2026-08-20): "Location (City)*" was asked
// across seven jobs off plans built 2026-08-08, after ats/greenhouse.mjs
// resolved that field on 2026-08-18 and after the answer had been banked on
// 2026-08-07. Asking someone a question they have already answered is a trust
// failure, not a latency one — so the properties here are two-sided. A stale
// plan must not produce questions, AND a current plan must still produce them:
// a guard that silently swallowed everything would "fix" the complaint by
// going blind, which is the same bug pointing the other way.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { newestInputMtime } from "../../scripts/apply/pending-questions.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const SCRIPT = path.join(ROOT, "scripts", "apply", "pending-questions.mjs")

// Far enough either side of the threshold that filesystem timestamp
// granularity cannot make the assertion flap.
const DAY = 24 * 60 * 60 * 1000

function makeJob(dir, slug, { planMtime }) {
  const jobDir = path.join(dir, slug)
  fs.mkdirSync(jobDir, { recursive: true })
  fs.writeFileSync(
    path.join(jobDir, "job.json"),
    JSON.stringify({
      slug,
      apply_url: "https://job-boards.greenhouse.io/acme/jobs/1",
    }),
  )
  const planPath = path.join(jobDir, "fill-plan.json")
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      v: 1,
      slug,
      ats: "greenhouse",
      defer: [
        {
          k: "f1",
          label: `Question for ${slug}`,
          why: "unknown",
        },
      ],
    }),
  )
  const t = planMtime / 1000
  fs.utimesSync(planPath, t, t)
  return planPath
}

function run(jobsDir) {
  const r = spawnSync(
    process.execPath,
    [SCRIPT, "--jobs-dir", jobsDir, "--no-predict", "--json"],
    { encoding: "utf8" },
  )
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

test("a plan older than the planner is not a source of questions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stale-"))
  try {
    const threshold = newestInputMtime()
    makeJob(dir, "old-job", { planMtime: threshold - DAY })

    const out = run(dir)
    assert.deepEqual(out.stale, ["old-job"])
    assert.equal(out.planned, 0)
    assert.deepEqual(
      out.questions.map((q) => q.label),
      [],
      "a defer recorded before the planner moved must not be re-asked",
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a plan newer than every input is still read", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fresh-"))
  try {
    const threshold = newestInputMtime()
    makeJob(dir, "new-job", { planMtime: threshold + DAY })

    const out = run(dir)
    assert.deepEqual(out.stale, [])
    assert.equal(out.planned, 1)
    assert.deepEqual(
      out.questions.map((q) => q.label),
      ["Question for new-job"],
      "the guard must not go blind — a current plan still asks",
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("staleness is decided per job, not for the whole run", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mixed-"))
  try {
    const threshold = newestInputMtime()
    makeJob(dir, "old-job", { planMtime: threshold - DAY })
    makeJob(dir, "new-job", { planMtime: threshold + DAY })

    const out = run(dir)
    assert.deepEqual(out.stale, ["old-job"])
    assert.equal(out.planned, 1)
    assert.deepEqual(
      out.questions.map((q) => q.label),
      ["Question for new-job"],
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("banking an answer makes every earlier plan stale", () => {
  // The fact base is an input like any other: the whole point of answering a
  // question is that the answer takes effect, and a plan built before it was
  // banked cannot have taken it into account.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bank-"))
  const answers = path.join(dir, "answers.yaml")
  try {
    fs.writeFileSync(answers, "answers: []\n")
    const codeOnly = newestInputMtime()

    // A plan newer than the code but older than the freshly-banked answer.
    const planMtime = codeOnly + DAY
    makeJob(dir, "job-a", { planMtime })
    const banked = (planMtime + DAY) / 1000
    fs.utimesSync(answers, banked, banked)

    const r = spawnSync(
      process.execPath,
      [
        SCRIPT,
        "--jobs-dir",
        dir,
        "--answers",
        answers,
        "--no-predict",
        "--json",
      ],
      { encoding: "utf8" },
    )
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(r.stdout)
    assert.deepEqual(out.stale, ["job-a"])
    assert.deepEqual(out.questions, [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("newestInputMtime rises when a planner source is touched", () => {
  const before = newestInputMtime()
  const probe = path.join(ROOT, "scripts", "apply", "fill-plan.mjs")
  const stat = fs.statSync(probe)
  try {
    const bumped = (before + DAY) / 1000
    fs.utimesSync(probe, bumped, bumped)
    assert.ok(
      newestInputMtime() > before,
      "a planner change must be able to invalidate plans, or the guard is inert",
    )
  } finally {
    fs.utimesSync(probe, stat.atime, stat.mtime)
  }
})
