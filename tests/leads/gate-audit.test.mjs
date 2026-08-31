// gate-audit is the safety net for every other gate change in the pipeline, so
// its diff has to be right in the direction that matters: a lead that used to
// be visible and now is not must always be reported, because CLAUDE.md's stated
// worst failure mode is a job the user never sees.
import test from "node:test"
import assert from "node:assert/strict"
import { diffAudit, summarize } from "../../src/leads/gate-audit.mjs"
import { evaluateStages, STAGE_IDS } from "../../src/leads/stages.mjs"

const row = (id, ok, stage = null, extra = {}) => ({
  id,
  company: id.toUpperCase(),
  title: "Full Stack Developer",
  ok,
  stage,
  reasons: ok ? [] : [`${stage}: because`],
  flags: [],
  ...extra,
})

test("a lead that stopped passing is reported as newly rejected", () => {
  const d = diffAudit({ leads: [row("a", true)] }, [row("a", false, "l0")])
  assert.equal(d.newlyRejected.length, 1)
  assert.equal(d.newlyRejected[0].id, "a")
  assert.equal(d.newlyRejected[0].was, "pass")
})

test("a lead that started passing is reported as recovered", () => {
  const d = diffAudit({ leads: [row("a", false, "l1")] }, [row("a", true)])
  assert.equal(d.newlyAccepted.length, 1)
  assert.equal(
    d.newlyAccepted[0].was,
    "l1",
    "records which stage used to kill it",
  )
  assert.equal(d.newlyRejected.length, 0)
})

test("a still-rejected lead caught by a different stage is not a regression", () => {
  const d = diffAudit({ leads: [row("a", false, "l0")] }, [
    row("a", false, "l2"),
  ])
  assert.equal(d.newlyRejected.length, 0)
  assert.equal(d.stageMoved.length, 1)
  assert.equal(d.stageMoved[0].was, "l0")
  assert.equal(d.stageMoved[0].stage, "l2")
})

test("an unchanged lead produces no diff entries at all", () => {
  const d = diffAudit({ leads: [row("a", true), row("b", false, "l0")] }, [
    row("a", true),
    row("b", false, "l0"),
  ])
  assert.deepEqual(
    [d.newlyRejected.length, d.newlyAccepted.length, d.stageMoved.length],
    [0, 0, 0],
  )
})

test("a lead absent from the baseline is neither a regression nor a win", () => {
  // A newly swept posting has no previous verdict to compare against, and
  // counting it as a regression would make every sweep look like a disaster.
  const d = diffAudit({ leads: [] }, [row("new", false, "l0")])
  assert.equal(d.newlyRejected.length, 0)
  assert.equal(d.newlyAccepted.length, 0)
  assert.equal(d.compared, 0)
})

test("a lead dropped from the store is listed as gone", () => {
  const d = diffAudit({ leads: [row("a", true), row("b", true)] }, [
    row("a", true),
  ])
  assert.deepEqual(d.gone, ["b"])
})

test("no baseline at all is treated as nothing to compare", () => {
  const d = diffAudit(null, [row("a", false, "l0")])
  assert.equal(d.compared, 0)
  assert.equal(d.newlyRejected.length, 0)
})

test("summarize counts every stage, including ones that rejected nothing", () => {
  const s = summarize([
    row("a", true),
    row("b", false, "l0"),
    row("c", false, "l0"),
  ])
  assert.equal(s.total, 3)
  assert.equal(s.passing, 1)
  assert.equal(s.rejected_by.l0, 2)
  for (const id of STAGE_IDS) {
    assert.ok(id in s.rejected_by, `stage ${id} missing from the summary`)
  }
})

// --- the stage runner itself ------------------------------------------------

const LIMITS = {
  location: {
    base: "North Las Vegas, NV",
    remote_ok: true,
    onsite_allowed: ["las vegas"],
  },
  freshness: { max_age_days: 30 },
  roles: {
    title_keywords: ["full stack", "software engineer"],
    hard_filter: ["senior"],
  },
}
const NOW = new Date("2026-07-29T00:00:00Z")
const FRESH = "2026-07-26T00:00:00Z"

test("stages stop at the first rejection and name the stage", () => {
  const v = evaluateStages(
    {
      title: "Senior Full Stack Developer",
      location: "Remote",
      posted_at: FRESH,
    },
    { limits: LIMITS, now: NOW },
  )
  assert.equal(v.ok, false)
  assert.equal(v.stage, "l0")
  assert.ok(!("l1" in v.stages), "l1 must not run once l0 rejected")
})

test("a clean lead reaches every registered stage", () => {
  const v = evaluateStages(
    {
      title: "Full Stack Developer",
      location: "Remote",
      posted_at: FRESH,
      description: "Build web applications with TypeScript and Node.js APIs.",
    },
    { limits: LIMITS, now: NOW },
  )
  assert.equal(v.ok, true)
  assert.equal(v.stage, null)
  assert.ok("l0" in v.stages && "l1" in v.stages)
})

test("flags accumulate across stages", () => {
  // l1's "did this arrive on a loose title match?" test reads l0's flags, so
  // the runner must hand each stage what the earlier ones raised.
  const v = evaluateStages(
    { title: "Full Stack Developer", location: "", posted_at: FRESH },
    { limits: LIMITS, now: NOW },
  )
  assert.ok(v.flags.includes("unknown_location"))
})

test("the stage list can be narrowed to one stage", () => {
  const v = evaluateStages(
    { title: "Full Stack Developer", location: "Remote", posted_at: FRESH },
    { limits: LIMITS, now: NOW },
    ["l1"],
  )
  assert.ok(!("l0" in v.stages), "l0 was not requested")
  assert.ok("l1" in v.stages)
})
