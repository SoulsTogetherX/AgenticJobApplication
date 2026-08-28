import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

function run(argsArr) {
  return spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "documents", "reuse-check.mjs"), ...argsArr],
    { cwd: ROOT, encoding: "utf8" },
  )
}

// Builds a throwaway jobs/ tree. `tailored: false` omits resume.md, which makes
// the workspace ineligible as a reuse candidate.
function makeJobs(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reuse-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const add = (slug, job, tailored = true) => {
    fs.mkdirSync(path.join(dir, slug), { recursive: true })
    fs.writeFileSync(
      path.join(dir, slug, "job.json"),
      JSON.stringify({ slug, ...job }),
    )
    if (tailored)
      fs.writeFileSync(path.join(dir, slug, "resume.md"), "# tailored\n")
  }
  return { dir, add }
}

const FULLSTACK = {
  company: "WidgetCo",
  title: "Full-Stack Engineer",
  description: "React and Node.js with PostgreSQL and Docker on AWS.",
  requirements: ["React", "Node.js", "PostgreSQL"],
}

test("near-identical posting recommends reuse; unrelated one does not", (t) => {
  const { dir, add } = makeJobs(t)
  add("widgetco-fullstack", FULLSTACK)
  add("gadgetco-fullstack", {
    company: "GadgetCo",
    title: "Senior Full-Stack Engineer",
    description: "Build products in React, Node.js, PostgreSQL, Docker on AWS.",
    requirements: ["React", "Node.js", "PostgreSQL"],
  })
  add("dataco-ml", {
    company: "DataCo",
    title: "Machine Learning Researcher",
    description: "Python research work.",
    requirements: ["Python"],
  })

  const res = run(["gadgetco-fullstack", "--dir", dir, "--json"])
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout)
  assert.equal(out.verdict, "REUSE")
  assert.equal(out.ranked[0].slug, "widgetco-fullstack")
  assert.ok(
    out.ranked[0].score >= 0.75,
    `expected a high score, got ${out.ranked[0].score}`,
  )
  // the unrelated posting ranks last and well below the threshold
  const ml = out.ranked.find((r) => r.slug === "dataco-ml")
  assert.ok(ml.score < 0.4, `expected a low score, got ${ml.score}`)

  // ...and from the ML job's side, nothing is close enough to reuse
  const other = JSON.parse(run(["dataco-ml", "--dir", dir, "--json"]).stdout)
  assert.equal(other.verdict, "TAILOR")
})

test("workspaces without a rendered resume are not candidates", (t) => {
  const { dir, add } = makeJobs(t)
  add("widgetco-fullstack", FULLSTACK) // tailored — eligible
  add("gadgetco-fullstack", FULLSTACK, false) // scanned but never tailored
  add("acmeco-fullstack", FULLSTACK, false) // ditto

  // the new job sees only the one workspace that actually has a resume
  const out = JSON.parse(
    run(["gadgetco-fullstack", "--dir", dir, "--json"]).stdout,
  )
  assert.equal(out.ranked.length, 1)
  assert.equal(out.ranked[0].slug, "widgetco-fullstack")
  assert.equal(out.ranked[0].score, 1)

  // with no eligible candidate at all, the verdict is TAILOR, not a crash
  fs.rmSync(path.join(dir, "widgetco-fullstack"), {
    recursive: true,
    force: true,
  })
  const empty = JSON.parse(
    run(["gadgetco-fullstack", "--dir", dir, "--json"]).stdout,
  )
  assert.equal(empty.verdict, "TAILOR")
  assert.deepEqual(empty.ranked, [])
})

test("terse output is one line per candidate plus a verdict summary", (t) => {
  const { dir, add } = makeJobs(t)
  add("widgetco-fullstack", FULLSTACK)
  add("gadgetco-fullstack", FULLSTACK)

  const res = run(["gadgetco-fullstack", "--dir", dir])
  assert.equal(res.status, 0, res.stderr)
  const lines = res.stdout.trim().split(/\r?\n/)
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^widgetco-fullstack\t1\t/)
  assert.match(lines[1], /^# verdict=REUSE best=widgetco-fullstack/)
})

test("usage errors exit 2", (t) => {
  const { dir } = makeJobs(t)
  assert.equal(run([]).status, 2) // no slug
  assert.equal(run(["nope", "--dir", dir]).status, 2) // no such workspace
})
