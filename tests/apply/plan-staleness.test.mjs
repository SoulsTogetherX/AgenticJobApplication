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
//
// HERMETIC ON PURPOSE. These tests used to compute thresholds off the REAL
// src/ tree, and the sensitivity test proved the guard live by bumping the
// real fill-plan.mjs mtime a day into the future. Any concurrent walk of that
// same tree — another gate run, another session sharing the checkout — that
// straddled a bump between this process's threshold snapshot and the spawned
// child's own re-walk then read a "fresh" plan as stale, and the two
// fresh-plan tests here failed while the stale-side ones kept passing (the
// 2026-08-27 flaky pair; reproduced on demand 2026-08-28 with a bump/restore
// loop). So every input below is a temp file only this test can touch
// (--inputs-dir / --answers / --profile), NO test mutates a real source
// file's timestamps, and the one fact still read from the real tree is
// asserted read-only ("the default input roots cover the real planner").
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  newestInputMtime,
  factBaseInputs,
  PLAN_INPUT_PATHS,
} from "../../src/apply/pending-questions.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const SCRIPT = path.join(ROOT, "src", "apply", "pending-questions.mjs")

// Far enough either side of the threshold that filesystem timestamp
// granularity cannot make the assertion flap.
const DAY = 24 * 60 * 60 * 1000

// A self-contained world: a stand-in planner tree and fact base, so the
// threshold this process computes and the one the spawned child computes walk
// exactly the same files, and nothing outside the mkdtemp can move either.
function makeWorld(dir) {
  const inputs = path.join(dir, "inputs")
  fs.mkdirSync(inputs, { recursive: true })
  fs.writeFileSync(path.join(inputs, "planner.mjs"), "// mtime probe\n")
  const answers = path.join(dir, "answers.yaml")
  fs.writeFileSync(answers, "answers: []\n")
  const profile = path.join(dir, "profile.yaml")
  fs.writeFileSync(profile, "meta: {}\n")
  const jobs = path.join(dir, "jobs")
  fs.mkdirSync(jobs)
  return { inputs, answers, profile, jobs }
}

// The same set the spawned child walks: the planner stand-in plus both halves
// of the fact base.
function newestOf(w) {
  return newestInputMtime([w.answers, w.profile], [w.inputs])
}

function makeJob(jobsDir, slug, { planMtime }) {
  const jobDir = path.join(jobsDir, slug)
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

function run(w) {
  const r = spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--jobs-dir",
      w.jobs,
      "--inputs-dir",
      w.inputs,
      "--answers",
      w.answers,
      "--profile",
      w.profile,
      "--no-predict",
      "--json",
    ],
    { encoding: "utf8" },
  )
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

test("a plan older than the planner is not a source of questions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stale-"))
  try {
    const w = makeWorld(dir)
    const threshold = newestOf(w)
    makeJob(w.jobs, "old-job", { planMtime: threshold - DAY })

    const out = run(w)
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
    const w = makeWorld(dir)
    const threshold = newestOf(w)
    makeJob(w.jobs, "new-job", { planMtime: threshold + DAY })

    const out = run(w)
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
    const w = makeWorld(dir)
    const threshold = newestOf(w)
    makeJob(w.jobs, "old-job", { planMtime: threshold - DAY })
    makeJob(w.jobs, "new-job", { planMtime: threshold + DAY })

    const out = run(w)
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
  try {
    const w = makeWorld(dir)
    // Everything except the answer bank, so the freshly-banked answer is the
    // one input the plan is older than.
    const codeOnly = newestInputMtime([w.profile], [w.inputs])

    // A plan newer than the code but older than the freshly-banked answer.
    const planMtime = codeOnly + DAY
    makeJob(w.jobs, "job-a", { planMtime })
    const banked = (planMtime + DAY) / 1000
    fs.utimesSync(w.answers, banked, banked)

    const out = run(w)
    assert.deepEqual(out.stale, ["job-a"])
    assert.deepEqual(out.questions, [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("newestInputMtime rises when a planner source is touched", () => {
  // The touch lands on the TEMP planner stand-in, never the real one: a real
  // source carrying a future mtime, however briefly, is exactly what poisoned
  // concurrent runs' staleness arithmetic (see the header).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "touch-"))
  try {
    const w = makeWorld(dir)
    const before = newestInputMtime([], [w.inputs])
    const bumped = (before + DAY) / 1000
    fs.utimesSync(path.join(w.inputs, "planner.mjs"), bumped, bumped)
    assert.ok(
      newestInputMtime([], [w.inputs]) > before,
      "a planner change must be able to invalidate plans, or the guard is inert",
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("the default input roots cover the real planner", () => {
  // The hermetic tests above prove the arithmetic; this proves the WIRING:
  // with no override, the walk visits the real planner closure, so a fix
  // landing in src/apply or src/lib genuinely invalidates plans on disk.
  // Structural on purpose, twice over: proving it by MUTATING real mtimes is
  // what made this file flaky, and proving it by COMPARING two live reads of
  // the same real file (a stat against a walk) still races with any
  // concurrent toucher of the checkout. A superset check, not deepEqual: new
  // roots may join the closure freely, losing one of these must be loud.
  for (const rel of ["src/apply", "src/lib"]) {
    assert.ok(
      PLAN_INPUT_PATHS.includes(rel),
      `${rel} left the default input roots — a planner change no threshold sees cannot invalidate anything`,
    )
    assert.ok(
      fs.statSync(path.join(ROOT, rel)).isDirectory(),
      `${rel} is not a directory here — the default walk would visit nothing`,
    )
  }
  assert.ok(
    fs.existsSync(path.join(ROOT, "src", "apply", "fill-plan.mjs")),
    "the planner itself must sit inside a covered root",
  )
})

test("factBaseInputs stats the override, not the real fact base", () => {
  // The other half of hermeticity: the spawned child honours --answers and
  // --profile, so a test's threshold never depends on the real profile/ tree.
  const [a, p] = factBaseInputs({
    answersFlag: path.join("fx", "answers.yaml"),
    profileFlag: path.join("fx", "profile.yaml"),
  })
  assert.equal(a, path.resolve(path.join("fx", "answers.yaml")))
  assert.equal(p, path.resolve(path.join("fx", "profile.yaml")))
  // And with no override, both halves of the real fact base are inputs.
  const [da, dp] = factBaseInputs()
  assert.ok(da.endsWith(path.join("profile", "answers.yaml")))
  assert.ok(dp.endsWith(path.join("profile", "profile.yaml")))
})
