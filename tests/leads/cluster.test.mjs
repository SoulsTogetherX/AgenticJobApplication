// Clustering decides which postings can share ONE tailored resume, so the
// failure that matters is a cluster that drifts: a group whose last member has
// nothing to do with the resume that was tailored for its leader.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { clusterLeads, coveredBy } from "../../src/leads/cluster.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const SCRIPT = path.join(ROOT, "src", "leads", "cluster.mjs")

const lead = (id, title, over = {}) => ({
  id,
  company: id.toUpperCase(),
  title,
  url: `https://x.test/${id}`,
  status: "new",
  ...over,
})
const kw = (pairs) => new Map(pairs.map(([id, ks]) => [id, new Set(ks)]))

test("groups two postings that are the same job in different words", () => {
  const leads = [
    lead("a", "Full Stack Engineer"),
    lead("b", "Full-Stack Developer"),
  ]
  const keywords = kw([
    ["a", ["React", "Node.js", "TypeScript", "PostgreSQL"]],
    ["b", ["React", "Node.js", "TypeScript", "PostgreSQL"]],
  ])
  const clusters = clusterLeads(leads, { keywords })
  assert.equal(clusters.length, 1)
  assert.equal(clusters[0].size, 2)
  assert.equal(clusters[0].lead_id, "a", "the first lead in leads the cluster")
  assert.deepEqual(clusters[0].shared, [
    "Node.js",
    "PostgreSQL",
    "React",
    "TypeScript",
  ])
})

test("keeps unrelated roles apart even when both say Engineer", () => {
  const leads = [lead("a", "Full Stack Engineer"), lead("b", "Data Engineer")]
  const keywords = kw([
    ["a", ["React", "Node.js"]],
    ["b", ["Python", "Spark"]],
  ])
  assert.equal(clusterLeads(leads, { keywords }).length, 2)
})

test("does not chain: C resembles B but not the leader, so it clusters alone", () => {
  const leads = [
    lead("a", "Full Stack Engineer"),
    lead("b", "Full Stack Engineer"),
    lead("c", "Full Stack Engineer"),
  ]
  const keywords = kw([
    ["a", ["React", "Node.js", "TypeScript", "PostgreSQL"]],
    ["b", ["Node.js", "TypeScript", "PostgreSQL", "Go"]],
    ["c", ["Node.js", "Go", "Kubernetes", "Terraform"]],
  ])
  const clusters = clusterLeads(leads, { keywords })
  assert.deepEqual(
    clusters.map((c) => c.members.map((m) => m.id)),
    [["a", "b"], ["c"]],
    "single-linkage would have pulled c in through b",
  )
})

test("shared keywords narrow to what the whole cluster actually wants", () => {
  const leads = [
    lead("a", "Full Stack Engineer"),
    lead("b", "Full Stack Engineer"),
  ]
  const keywords = kw([
    ["a", ["React", "Node.js", "TypeScript", "PostgreSQL"]],
    ["b", ["React", "Node.js", "TypeScript", "Redis"]],
  ])
  const [c] = clusterLeads(leads, { keywords })
  assert.equal(c.size, 2)
  assert.ok(
    !c.shared.includes("PostgreSQL") && !c.shared.includes("Redis"),
    "a term only one member asks for is not shared",
  )
})

test("identical titles with no keywords on either side do not cluster", () => {
  const leads = [
    lead("a", "Full Stack Engineer"),
    lead("b", "Full Stack Engineer"),
  ]
  const clusters = clusterLeads(leads, {
    keywords: kw([
      ["a", []],
      ["b", []],
    ]),
  })
  assert.equal(
    clusters.length,
    2,
    "an unknown stack is not evidence of a match — title alone maxes out at 0.5",
  )
})

test("falls back to extracting keywords from the description", () => {
  const leads = [
    lead("a", "Full Stack Engineer", {
      description: "React, Node.js and TypeScript on PostgreSQL",
    }),
    lead("b", "Full Stack Developer", {
      description: "We use React, Node.js, TypeScript and PostgreSQL",
    }),
  ]
  assert.equal(
    clusterLeads(leads).length,
    1,
    "a store with no lead_keywords table still clusters",
  )
})

test("the threshold is respected at the boundary", () => {
  const leads = [lead("a", "Full Stack Engineer"), lead("b", "Data Engineer")]
  const keywords = kw([
    ["a", ["React", "Node.js"]],
    ["b", ["React", "Node.js"]],
  ])
  // title 1/3 + stack 1/1 -> 0.5 * 0.333 + 0.5 = 0.67
  assert.equal(clusterLeads(leads, { keywords, threshold: 0.6 }).length, 1)
  assert.equal(clusterLeads(leads, { keywords, threshold: 0.7 }).length, 2)
})

test("coveredBy names the leader for every member but the leader itself", () => {
  const clusters = [
    { lead_id: "a", members: [{ id: "a" }, { id: "b" }, { id: "c" }] },
    { lead_id: "d", members: [{ id: "d" }] },
  ]
  const covered = coveredBy(clusters)
  assert.deepEqual(
    [...covered],
    [
      ["b", "a"],
      ["c", "a"],
    ],
  )
})

test("an empty lead list is not an error", () => {
  assert.deepEqual(clusterLeads([]), [])
  assert.equal(coveredBy([]).size, 0)
})

test("CLI reports what clustering saves, and exits 2 without a store", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cluster-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const leads = path.join(dir, "leads.json")
  fs.writeFileSync(
    leads,
    JSON.stringify({
      leads: [
        lead("a", "Full Stack Engineer", {
          description: "React, Node.js, TypeScript, PostgreSQL",
        }),
        lead("b", "Full Stack Developer", {
          description: "React, Node.js, TypeScript, PostgreSQL",
        }),
        lead("c", "Machine Learning Scientist", {
          description: "PyTorch and Python research",
        }),
      ],
    }),
  )

  const run = spawnSync(
    process.execPath,
    [SCRIPT, "--leads", leads, "--json"],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  )
  assert.equal(run.status, 0, run.stderr)
  const out = JSON.parse(run.stdout)
  assert.equal(out.leads, 3)
  assert.equal(
    out.saved,
    1,
    "one of the three needs no tailoring run of its own",
  )
  assert.equal(out.clusters.length, 2)

  const missing = spawnSync(
    process.execPath,
    [SCRIPT, "--leads", path.join(dir, "nope.json")],
    { cwd: ROOT, encoding: "utf8" },
  )
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /no lead store/)
})
