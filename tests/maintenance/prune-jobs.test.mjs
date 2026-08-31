import test from "node:test"
import assert from "node:assert/strict"
import { planPrune } from "../../src/maintenance/prune-jobs.mjs"

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
  const plan = planPrune([ws()])
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
  assert.deepEqual(names(planPrune([ws()])), ["resume.render.html"])
})

test("PDFs are no longer prune's business", () => {
  // archive.mjs owns the closed-application lifecycle now. Two rules deleting
  // the same files on different triggers is how a workspace loses a PDF that
  // its archive row then records as regenerable-but-never-stored.
  const plan = planPrune([
    ws({ status: "rejected", applied_at: "2020-01-01" }),
    ws({ slug: "old-swe", status: "no_response", applied_at: "2019-01-01" }),
  ])
  assert.ok(!names(plan).includes("resume.pdf"))
  assert.ok(!names(plan).includes("cover-letter.pdf"))
  assert.equal(plan.length, 2, "only the two intermediates")
})

test("planPrune on no workspaces returns an empty plan", () => {
  assert.deepEqual(planPrune([]), [])
})

test("a workspace with nothing regenerable yields nothing", () => {
  assert.deepEqual(
    planPrune([{ slug: "acme-swe", files: ["resume.md", "job.json"] }]),
    [],
  )
})

test("every planned removal explains itself", () => {
  const plan = planPrune([ws()])
  assert.ok(plan.length > 0)
  for (const p of plan) {
    assert.ok(p.reason && p.reason.length > 5, `no reason for ${p.file}`)
    assert.equal(p.slug, "acme-swe")
  }
})
