import test from "node:test"
import assert from "node:assert/strict"
import { planPrune } from "../../scripts/maintenance/prune-jobs.mjs"

const NOW = new Date("2026-07-28T00:00:00Z")
const FILES = [
  "resume.md",
  "cover-letter.md",
  "job.json",
  "context.json",
  "resume.pdf",
  "cover-letter.pdf",
  "resume.render.html",
]
const ws = (over = {}) => ({ slug: "acme-swe", files: FILES, ...over })
const names = (plan) => plan.map((p) => p.file).sort()

test("the audit trail is never pruned", () => {
  // resume.md / cover-letter.md / job.json / context.json record what was
  // actually claimed on an application and cannot be regenerated.
  const plan = planPrune(
    [ws({ status: "rejected", applied_at: "2020-01-01" })],
    { olderThanDays: 90, now: NOW },
  )
  for (const keep of [
    "resume.md",
    "cover-letter.md",
    "job.json",
    "context.json",
  ]) {
    assert.ok(!names(plan).includes(keep), `${keep} must never be pruned`)
  }
})

test("render.html intermediates are always pruned", () => {
  // No outcome, no age — still pure waste.
  const plan = planPrune([ws({ status: null, applied_at: null })], {
    olderThanDays: 90,
    now: NOW,
  })
  assert.deepEqual(names(plan), ["resume.render.html"])
})

test("PDFs survive until the application is BOTH closed and old", () => {
  const cases = [
    // [status, applied_at, pdfsPruned, why]
    [null, null, false, "never applied"],
    ["applied", "2020-01-01", false, "old but still awaiting a reply"],
    ["rejected", "2026-07-20", false, "closed but only 8 days ago"],
    ["rejected", "2020-01-01", true, "closed and long past"],
    ["no_response", "2020-01-01", true, "gone quiet and long past"],
  ]
  for (const [status, applied_at, expected, why] of cases) {
    const plan = planPrune([ws({ status, applied_at })], {
      olderThanDays: 90,
      now: NOW,
    })
    const pruned = names(plan).includes("resume.pdf")
    assert.equal(pruned, expected, `${why}: expected pruned=${expected}`)
    // The intermediate goes regardless, in every one of these cases.
    assert.ok(names(plan).includes("resume.render.html"))
  }
})

test("an in-flight application keeps its PDFs no matter how old", () => {
  // "applied" is deliberately not a closed outcome — a submitted application
  // with no reply may still need the exact PDF that was sent.
  const plan = planPrune(
    [ws({ status: "applied", applied_at: "2019-01-01" })],
    {
      olderThanDays: 1,
      now: NOW,
    },
  )
  assert.deepEqual(names(plan), ["resume.render.html"])
})

test("planPrune on no workspaces returns an empty plan", () => {
  assert.deepEqual(planPrune([], { now: NOW }), [])
})

test("every planned removal explains itself", () => {
  const plan = planPrune(
    [ws({ status: "rejected", applied_at: "2020-01-01" })],
    { olderThanDays: 90, now: NOW },
  )
  assert.ok(plan.length > 0)
  for (const p of plan) {
    assert.ok(p.reason && p.reason.length > 5, `no reason for ${p.file}`)
    assert.equal(p.slug, "acme-swe")
  }
})
