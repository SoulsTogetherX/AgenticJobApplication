// Phase 3 item 3.3: cover letters stay model-authored, are planned per reuse
// cluster rather than per job, and the model cost is priced.
//
// The item's testable content is the ARITHMETIC and the CLUSTERING, not the
// letter. Two things are asserted that would otherwise be a paragraph nobody
// can check: that the plan writes one letter per cluster and not one per job,
// and that the estimate is a function of declared inputs rather than a number
// somebody typed. A cost estimate whose terms cannot be varied and re-checked
// is a claim, not an estimate.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  COST_MODEL,
  priceCluster,
  pricePlan,
  letterPlan,
} from "../../src/documents/letter-plan.mjs"
import { clusterLeads } from "../../src/leads/cluster.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

const LEADS = [
  {
    id: "a1",
    status: "new",
    company: "WidgetCo",
    title: "Full-Stack Engineer",
    description: "React, Node.js, PostgreSQL and Docker.",
  },
  {
    id: "a2",
    status: "new",
    company: "GadgetCo",
    title: "Senior Full-Stack Engineer",
    description: "React, Node.js, PostgreSQL and Docker.",
  },
  {
    id: "a3",
    status: "new",
    company: "SprocketCo",
    title: "Full Stack Developer",
    description: "React, Node.js, PostgreSQL and Docker.",
  },
  {
    id: "b1",
    status: "new",
    company: "DataCo",
    title: "Machine Learning Researcher",
    description: "Python, Pandas and NumPy research.",
  },
]

test("one letter per cluster, not one per job", () => {
  const clusters = clusterLeads(LEADS)
  const plan = letterPlan(clusters)
  assert.equal(plan.length, 2, JSON.stringify(plan.map((p) => p.anchor)))
  const big = plan.find((p) => p.size === 3)
  assert.ok(big, "the three near-identical postings did not group")
  assert.equal(big.anchor.id, "a1")
  assert.deepEqual(
    big.reuses.map((r) => r.id),
    ["a2", "a3"],
  )
  assert.match(big.why, /share/)
  // The lone posting still gets its own letter — clustering never drops a job.
  const applications = plan.reduce((n, p) => n + p.size, 0)
  assert.equal(applications, LEADS.length)
})

test("the price is a function of its declared terms, not a typed-in number", () => {
  const base = priceCluster(1)
  const doubled = priceCluster(1, {
    ...COST_MODEL,
    output_tokens: COST_MODEL.output_tokens * 2,
  })
  assert.equal(doubled.tokens_out, base.tokens_out * 2)
  assert.ok(doubled.usd > base.usd)

  const noRevision = priceCluster(1, { ...COST_MODEL, revisions: 0 })
  assert.equal(noRevision.tokens_in * 2, base.tokens_in)
  assert.equal(noRevision.tokens_out * 2, base.tokens_out)

  // The arithmetic, spelled out, so a change to it has to be deliberate.
  const inPer = Object.entries(COST_MODEL.input_tokens)
    .filter(([k]) => !k.startsWith("_"))
    .reduce((s, [, v]) => s + v, 0)
  const calls = 1 + COST_MODEL.revisions
  assert.equal(base.tokens_in, inPer * calls)
  assert.equal(
    base.usd,
    Number(
      (
        ((inPer * calls) / 1e6) * COST_MODEL.usd_per_mtok_in +
        ((COST_MODEL.output_tokens * calls) / 1e6) * COST_MODEL.usd_per_mtok_out
      ).toFixed(4),
    ),
  )
})

test("clustering moves the per-application cost, and the letter count is the reason", () => {
  const clusters = clusterLeads(LEADS)
  const clustered = pricePlan(clusters)
  const perJob = pricePlan(LEADS.map(() => ({ size: 1 })))
  assert.equal(clustered.letters, 2)
  assert.equal(perJob.letters, 4)
  assert.equal(clustered.letters_saved, 2)
  assert.ok(clustered.usd < perJob.usd)
  assert.equal(clustered.applications, 4)
  assert.ok(clustered.usd_per_application < perJob.usd_per_application)
  // Cost scales with LETTERS, not applications — that is the whole claim.
  assert.equal(clustered.usd, Number((priceCluster(1).usd * 2).toFixed(4)))
})

test("a cluster of one costs the same as a per-job letter", () => {
  const one = priceCluster(1)
  assert.equal(one.usd_per_application, one.usd)
  const four = priceCluster(4)
  assert.equal(four.usd, one.usd)
  // Both sides round to 4dp, and they round from different intermediates
  // (the implementation divides before rounding), so compare within one unit
  // of the last place rather than pretending the two agree exactly.
  assert.ok(
    Math.abs(four.usd_per_application - one.usd / 4) <= 0.0001,
    `${four.usd_per_application} vs ${one.usd / 4}`,
  )
})

test("the model's every term is declared with a basis", () => {
  assert.ok(COST_MODEL.input_tokens._basis.length > 20)
  assert.ok(COST_MODEL._model.includes("sonnet"))
  for (const [k, v] of Object.entries(COST_MODEL.input_tokens)) {
    if (k.startsWith("_")) continue
    assert.equal(typeof v, "number", `${k} is not a number`)
    assert.ok(v > 0, `${k} is not positive`)
  }
  assert.ok(COST_MODEL.usd_per_mtok_out > COST_MODEL.usd_per_mtok_in)
})

function cli(args) {
  return spawnSync(
    process.execPath,
    [path.join(ROOT, "src", "documents", "letter-plan.mjs"), ...args],
    { cwd: ROOT, encoding: "utf8" },
  )
}

test("--price-only answers without a lead store", () => {
  const res = cli(["--price-only", "--json"])
  assert.equal(res.status ?? 0, 0, res.stderr)
  const out = JSON.parse(res.stdout)
  assert.equal(out.one.usd, priceCluster(1).usd)
  assert.equal(
    out.four.usd_per_application,
    priceCluster(4).usd_per_application,
  )
})

test("the rates are overridable, so the estimate survives a price change", () => {
  const cheap = JSON.parse(
    cli(["--price-only", "--json", "--in-rate", "0.3", "--out-rate", "1.5"])
      .stdout,
  )
  assert.ok(cheap.one.usd < priceCluster(1).usd / 5)
})

test("the plan runs against a JSON lead store and labels itself an estimate", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "letter-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, "leads.json")
  fs.writeFileSync(file, JSON.stringify({ leads: LEADS }))
  const res = cli(["--leads", file, "--json"])
  assert.equal(res.status ?? 0, 0, res.stderr)
  const out = JSON.parse(res.stdout)
  assert.equal(out.leads, 4)
  assert.equal(out.price.letters, 2)
  assert.equal(out.if_written_per_job.letters, 4)
  assert.ok(out.saved_usd > 0)
  assert.match(out.caveat, /ESTIMATE/)
  assert.match(out.caveat, /not measured/)
})

test("a missing lead store is a usage error, not a zero", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "letter2-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const res = cli(["--leads", path.join(dir, "nope.json")])
  assert.equal(res.status, 2)
  assert.match(res.stderr, /no lead store/)
})
