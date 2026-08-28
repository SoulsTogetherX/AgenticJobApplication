// R8 — keyword coverage reporting in verify-claims.
//
// R8 is the only rule here that does NOT block. Every other rule answers "is
// this true?", where a failure is a lie. R8 answers "is this complete?", where
// a miss is an editorial trade-off on a one-page document. Making it blocking
// would push the tailoring step toward stuffing, which is exactly what modern
// parsers penalise — so these tests mostly pin down that it stays advisory.
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
const FIX = path.join(ROOT, "tests", "fixtures")

// A workspace in a temp dir: verify-claims derives the plan path from --job,
// so job.json and keywords.json must sit next to each other.
function workspace({ plan, resume }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kwcov-"))
  fs.writeFileSync(
    path.join(dir, "job.json"),
    JSON.stringify({ company: "Acme", title: "Full Stack Developer" }),
  )
  if (plan) {
    fs.writeFileSync(path.join(dir, "keywords.json"), JSON.stringify(plan))
  }
  const file = path.join(dir, "resume.md")
  fs.writeFileSync(file, resume)
  return { dir, file, job: path.join(dir, "job.json") }
}

function verify(file, job) {
  const res = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "src", "documents", "verify-claims.mjs"),
      "resume",
      file,
      "--profile",
      path.join(FIX, "profile.yaml"),
      "--answers",
      path.join(FIX, "answers.yaml"),
      "--job",
      job,
    ],
    { cwd: ROOT, encoding: "utf8" },
  )
  let report = null
  try {
    report = JSON.parse(res.stdout)
  } catch {}
  return { status: res.status, report }
}

const RESUME = [
  "# Test Person",
  "",
  "## SUMMARY",
  "",
  "Full-Stack Developer working in TypeScript and React.",
  "",
  "## EXPERIENCE",
  "",
  "- Built web applications with React and TypeScript <!-- fact:exp-acme-b1 -->",
  "",
].join("\n")

const PLAN = (over = {}) => ({
  must_use: [
    { skill: "React", required: true, ats_forms: ["React"] },
    { skill: "TypeScript", required: true, ats_forms: ["TypeScript"] },
    { skill: "Docker", required: true, ats_forms: ["Docker"] },
  ],
  blocked: [{ skill: "Kubernetes", required: true }],
  title_mirror: { mirror: "Full-Stack Developer" },
  ...over,
})

test("coverage reports what was placed and what was missed", () => {
  const ws = workspace({ plan: PLAN(), resume: RESUME })
  const { report } = verify(ws.file, ws.job)
  assert.equal(report.coverage.must_use, 3)
  assert.equal(report.coverage.placed, 2)
  assert.deepEqual(report.coverage.missing, ["Docker"])
  assert.deepEqual(report.coverage.missing_required, ["Docker"])
})

test("a missing keyword does NOT fail verification", () => {
  // The whole point: R8 advises, R1-R7 block.
  const ws = workspace({ plan: PLAN(), resume: RESUME })
  const { status, report } = verify(ws.file, ws.job)
  assert.equal(status, 0, "exit code must stay 0")
  assert.equal(report.ok, true)
  assert.deepEqual(report.violations, [])
})

test("full coverage reports nothing missing", () => {
  const ws = workspace({
    plan: PLAN({
      must_use: [{ skill: "React", required: true, ats_forms: ["React"] }],
    }),
    resume: RESUME,
  })
  const { report } = verify(ws.file, ws.job)
  assert.deepEqual(report.coverage.missing, [])
  assert.equal(report.coverage.placed, 1)
})

test("an ATS surface form counts as placing the term", () => {
  // "continuous integration" in prose should satisfy a CI/CD must-use even
  // though the literal "CI/CD" never appears.
  const ws = workspace({
    plan: PLAN({
      must_use: [
        {
          skill: "CI/CD",
          required: true,
          ats_forms: ["CI/CD", "continuous integration"],
        },
      ],
    }),
    resume: RESUME.replace(
      "Built web applications",
      "Ran continuous integration and built web applications",
    ),
  })
  const { report } = verify(ws.file, ws.job)
  assert.deepEqual(report.coverage.missing, [])
})

test("a blocked term appearing is reported in coverage AND fails R6", () => {
  const ws = workspace({
    plan: PLAN(),
    resume: RESUME.replace("React and TypeScript", "React and Kubernetes"),
  })
  const { status, report } = verify(ws.file, ws.job)
  assert.deepEqual(report.coverage.used_blocked, ["Kubernetes"])
  assert.equal(status, 1, "R6 must still block an unbacked tech term")
  assert.ok(report.violations.some((v) => v.rule === "R6"))
})

test("title mirroring is reported when the plan supplies one", () => {
  const ws = workspace({ plan: PLAN(), resume: RESUME })
  const { report } = verify(ws.file, ws.job)
  assert.equal(report.coverage.title_mirror, "Full-Stack Developer")
  assert.equal(report.coverage.title_mirrored, true)
})

test("an unmirrorable title reports null rather than a false miss", () => {
  const ws = workspace({
    plan: PLAN({ title_mirror: { mirror: null } }),
    resume: RESUME,
  })
  const { report } = verify(ws.file, ws.job)
  assert.equal(report.coverage.title_mirrored, null)
})

test("no keywords.json means no coverage block and no behaviour change", () => {
  const ws = workspace({ plan: null, resume: RESUME })
  const { status, report } = verify(ws.file, ws.job)
  assert.equal(status, 0)
  assert.ok(!("coverage" in report), "must stay silent when there is no plan")
})

test("a malformed plan never blocks a truthful document", () => {
  const ws = workspace({ plan: null, resume: RESUME })
  fs.writeFileSync(path.join(ws.dir, "keywords.json"), "{ not json")
  const { status, report } = verify(ws.file, ws.job)
  assert.equal(status, 0)
  assert.match(report.coverage.error, /unreadable/)
})
