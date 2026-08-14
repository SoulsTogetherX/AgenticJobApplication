// The Purpose Scorecard measures whether a change helped the machine's actual
// job (reach, automatability, deferral pressure, speed, outcomes). The tests
// that matter most are the FAILURE ones: a missing lead store must refuse
// rather than print an all-zero line that reads as "the pipeline collapsed",
// an unmeasured statistic must come out null rather than 0 (a zero flatters
// exactly the number it belongs to), and a broken input must cost a warning,
// never the snapshot.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  percentile,
  countDeferrals,
  countCache,
  collectInputs,
  buildScorecard,
  appendLine,
} from "../../scripts/dev/scorecard.mjs"
import { openDb } from "../../scripts/lib/db.mjs"

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "scorecard-"))
}

test("percentile: empty sample is null, never zero", () => {
  assert.equal(percentile([], 95), null)
  assert.equal(percentile([NaN, undefined], 50), null)
})

test("percentile: nearest-rank on small samples", () => {
  assert.equal(percentile([7], 50), 7)
  assert.equal(percentile([1, 2, 3, 4], 50), 2)
  assert.equal(percentile([1, 2, 3, 4], 95), 4)
  // unsorted input is the caller's reality, not an error
  assert.equal(percentile([4, 1, 3, 2], 50), 2)
})

test("countDeferrals: sums defer fields and unknowns across plans", () => {
  const dir = tmpdir()
  fs.mkdirSync(path.join(dir, "job-a"))
  fs.writeFileSync(
    path.join(dir, "job-a", "fill-plan.json"),
    JSON.stringify({
      defer: [{ why: "unknown" }, { why: "confirm" }, { why: "unknown" }],
    }),
  )
  fs.mkdirSync(path.join(dir, "job-b"))
  fs.writeFileSync(
    path.join(dir, "job-b", "fill-plan.json"),
    JSON.stringify({ defer: [{ why: "consent" }] }),
  )
  // dot-dirs (jobs/.auto, jobs/.cc) are pipeline state, not workspaces
  fs.mkdirSync(path.join(dir, ".auto"))
  fs.writeFileSync(
    path.join(dir, ".auto", "fill-plan.json"),
    JSON.stringify({ defer: [{ why: "unknown" }] }),
  )
  const got = countDeferrals(dir)
  assert.deepEqual(got, { plans: 2, fields: 4, unknown: 2 })
})

test("countDeferrals: an unparsable plan is skipped, not fatal", () => {
  const dir = tmpdir()
  fs.mkdirSync(path.join(dir, "job-broken"))
  fs.writeFileSync(path.join(dir, "job-broken", "fill-plan.json"), "{nope")
  fs.mkdirSync(path.join(dir, "job-ok"))
  fs.writeFileSync(
    path.join(dir, "job-ok", "fill-plan.json"),
    JSON.stringify({ defer: [] }),
  )
  const got = countDeferrals(dir)
  assert.deepEqual(got, { plans: 1, fields: 0, unknown: 0 })
})

test("countDeferrals: missing jobs dir is an empty count", () => {
  assert.deepEqual(countDeferrals(path.join(tmpdir(), "absent")), {
    plans: 0,
    fields: 0,
    unknown: 0,
  })
})

test("countCache: counts forms carrying via and comboStrategy", () => {
  const file = path.join(tmpdir(), "cache.json")
  fs.writeFileSync(
    file,
    JSON.stringify({
      v: 4,
      forms: {
        aaa: {
          ats: "greenhouse",
          comboStrategy: "type-enter",
          fields: { "name|text": { t: "text", l: "Name", via: "type-enter" } },
        },
        bbb: { ats: "ashby", fields: { "email|text": { t: "text", l: "E" } } },
      },
    }),
  )
  assert.deepEqual(countCache(file), {
    forms: 2,
    with_strategy: 1,
    with_via: 1,
  })
})

test("countCache: malformed or missing file counts as empty, not a crash", () => {
  const dir = tmpdir()
  const bad = path.join(dir, "bad.json")
  fs.writeFileSync(bad, "{not json")
  assert.deepEqual(countCache(bad), { forms: 0, with_strategy: 0, with_via: 0 })
  assert.deepEqual(countCache(path.join(dir, "absent.json")), {
    forms: 0,
    with_strategy: 0,
    with_via: 0,
  })
})

test("collectInputs: refuses a missing lead store instead of minting one", () => {
  assert.throws(
    () => collectInputs({ dbFile: path.join(tmpdir(), "absent.db") }),
    (e) => e.code === 2 && /no lead store/.test(e.message),
  )
})

test("collectInputs: walks an empty store end-to-end with stubbed spawns", () => {
  const dir = tmpdir()
  const dbFile = path.join(dir, "leads.db")
  openDb(dbFile).close() // create the schema so the store exists but is empty
  const jobsDir = path.join(dir, "jobs")
  fs.mkdirSync(jobsDir)
  const spawned = []
  const inputs = collectInputs({
    dbFile,
    jobsDir,
    spawnJson: (args) => {
      spawned.push(args[0])
      if (args[0].includes("automatability"))
        return { counts: { green: 1, amber: 2, handoff: 0, blocked: 3 } }
      if (args[0].includes("pending-questions"))
        return { questions: [{ label: "a" }, { label: "b" }] }
      return { due: [{ slug: "x" }] }
    },
  })
  assert.equal(spawned.length, 3)
  assert.equal(inputs.submissions, 0)
  assert.equal(inputs.eligible, 0)
  assert.equal(inputs.applications, 0)
  assert.deepEqual(inputs.autoCounts, {
    green: 1,
    amber: 2,
    handoff: 0,
    blocked: 3,
  })
  assert.equal(inputs.pendingLabels, 2)
  assert.equal(inputs.followUpsDue, 1)
})

test("buildScorecard: assembles nulls where inputs are unknown", () => {
  const card = buildScorecard(
    {
      sha: "abc1234",
      boards: 58,
      stats: { live: 8867, solid: 39, last_swept: "2026-08-13T01:00:00Z" },
      leadCounts: { new: 41 },
      submissions: 0,
      eligible: 33,
      tailored: 37,
      wall: [],
      latency: [],
      applications: 36,
      benchP95: 1565.31,
      autoCounts: null, // spawn failed — must survive as null, not throw
      pendingLabels: null,
      followUpsDue: null,
      deferrals: { plans: 27, fields: 155, unknown: 30 },
      cache: { forms: 21, with_strategy: 0, with_via: 0 },
    },
    { now: new Date("2026-08-13T02:00:00Z"), note: "baseline" },
  )
  assert.equal(card.at, "2026-08-13T02:00:00.000Z")
  assert.equal(card.note, "baseline")
  assert.equal(card.auto, null)
  assert.equal(card.speed.wall_p95, null)
  assert.equal(card.speed.posting_age_p50_h, null)
  assert.equal(card.docs.eligible, 33)
  assert.equal(card.reach.qualifying, 39)
})

test("appendLine: appends exactly one JSONL line per call", () => {
  const out = path.join(tmpdir(), "sub", "scorecard.jsonl")
  appendLine({ at: "t1", note: "a" }, out)
  appendLine({ at: "t2", note: "b" }, out)
  const lines = fs.readFileSync(out, "utf8").trim().split("\n")
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[0]).at, "t1")
  assert.equal(JSON.parse(lines[1]).note, "b")
})
