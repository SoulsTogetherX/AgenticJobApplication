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

function verify(mode, file, extra = []) {
  const res = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "documents", "verify-claims.mjs"),
      mode,
      path.join(FIX, file),
      "--profile",
      path.join(FIX, "profile.yaml"),
      "--answers",
      path.join(FIX, "answers.yaml"),
      ...extra,
    ],
    { cwd: ROOT, encoding: "utf8" },
  )
  let report = null
  try {
    report = JSON.parse(res.stdout)
  } catch {
    /* usage errors print no JSON */
  }
  return { status: res.status, report, stderr: res.stderr }
}

test("faithful resume passes all rules", () => {
  const { status, report } = verify("resume", "good-resume.md")
  assert.equal(status, 0, JSON.stringify(report?.violations))
  assert.equal(report.ok, true)
  assert.ok(report.checked.annotatedBullets >= 5)
})

test("faithful cover letter passes with job context", () => {
  const { status, report } = verify("cover-letter", "good-cover-letter.md", [
    "--job",
    path.join(FIX, "job.json"),
  ])
  assert.equal(status, 0, JSON.stringify(report?.violations))
})

test("invented number in a cited bullet fails (R3)", () => {
  const { status, report } = verify("resume", "bad-invented-number.md")
  assert.equal(status, 1)
  assert.ok(
    report.violations.some((v) => v.rule === "R3" && v.detail.includes("5000")),
  )
})

test("tech terms absent from the profile fail (R6)", () => {
  const { status, report } = verify("resume", "bad-unknown-tech.md")
  assert.equal(status, 1)
  const terms = report.violations
    .filter((v) => v.rule === "R6")
    .map((v) => v.detail)
  assert.ok(terms.some((d) => d.includes("Kubernetes")))
  assert.ok(terms.some((d) => d.includes("Terraform")))
})

test("bullet without a fact annotation fails (R1)", () => {
  const { status, report } = verify("resume", "bad-missing-annotation.md")
  assert.equal(status, 1)
  assert.ok(
    report.violations.some(
      (v) => v.rule === "R1" && v.detail.includes("Led a team"),
    ),
  )
})

test("citing a nonexistent fact id fails (R2)", () => {
  const { status, report } = verify("resume", "bad-unknown-fact-id.md")
  assert.equal(status, 1)
  assert.ok(
    report.violations.some(
      (v) => v.rule === "R2" && v.detail.includes("exp-nonexistent-b9"),
    ),
  )
})

test("empty resume fails: nothing traceable (R7)", () => {
  const { status, report } = verify("resume", "empty.md")
  assert.equal(status, 1)
  assert.ok(report.violations.some((v) => v.rule === "R7"))
})

test("dishonest cover letter fails on numbers, dates, and tech (R4/R5/R6)", () => {
  const { status, report } = verify("cover-letter", "bad-cover-letter.md", [
    "--job",
    path.join(FIX, "job.json"),
  ])
  assert.equal(status, 1)
  const rules = new Set(report.violations.map((v) => v.rule))
  assert.ok(
    rules.has("R4"),
    "invented numbers (7 years, 2,000,000 rps) should fail R4",
  )
  assert.ok(rules.has("R5"), "invented date (Aug 2021) should fail R5")
  assert.ok(rules.has("R6"), "invented tech (Rust, AWS) should fail R6")
  const r6 = report.violations
    .filter((v) => v.rule === "R6")
    .map((v) => v.detail)
    .join(" ")
  assert.ok(r6.includes("Rust") && r6.includes("AWS"))
  // Kubernetes appears only in the job posting BODY — the posting is not a fact
  // source, so claiming it must fail even with --job provided.
  assert.ok(r6.includes("Kubernetes"))
})

test("cover letter may reference the job title/company even when the posting body is off-limits", () => {
  // good-cover-letter.md says "Full-Stack Engineer posting" and "WidgetCo" —
  // allowed via job.json company/title whitelisting.
  const { status } = verify("cover-letter", "good-cover-letter.md", [
    "--job",
    path.join(FIX, "job.json"),
  ])
  assert.equal(status, 0)
})

// --- a posting must not be able to authorise its own claims ------------------
//
// The addressing fields (company/title/slug) join the corpus so a company name
// is not itself flagged as an unsupported claim. But techTermsIn() cannot tell
// a city from a technology, and THE BOARD WRITES THE TITLE. A posting called
// "Senior Engineer (Terraform / Kotlin / Elixir stack)" at "Kubernetes
// Solutions LLC" used to whitelist every one of those: the same document FAILED
// R6 without --job and PASSED ok:true with it.
//
// No hidden text and no injection phrasing needed — just a normal-looking job
// title. This is the load-bearing control for hard rule 1, so it gets a test.

test("a posting's own TITLE cannot whitelist a technology through R6", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-hostile-title-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const hostile = path.join(dir, "job.json")
  fs.writeFileSync(
    hostile,
    JSON.stringify({
      slug: "hostile-co",
      company: "Kubernetes Solutions LLC",
      title: "Senior Engineer (Terraform / Kotlin / Elixir stack)",
      source_url: "https://example.com/jobs/999",
      description: "Nothing untoward in the body at all.",
      requirements: [],
      questions: [],
    }),
  )

  const { status, report } = verify("resume", "bad-unknown-tech.md", [
    "--job",
    hostile,
  ])
  assert.equal(status, 1, "a posting must never authorise an unbacked claim")
  const r6 = (report?.violations ?? [])
    .filter((v) => v.rule === "R6")
    .map((v) => v.detail)
    .join(" ")
  assert.ok(r6.length > 0, "R6 must still fire with the hostile job attached")
})

test("the addressing fields still keep the company and title themselves legal", () => {
  // The narrowing must not break what the whitelist was FOR: good-cover-letter
  // names "WidgetCo" and "Full-Stack Engineer", and that must still pass.
  const { status } = verify("cover-letter", "good-cover-letter.md", [
    "--job",
    path.join(FIX, "job.json"),
  ])
  assert.equal(status, 0)
})

test("usage errors exit 2", () => {
  assert.equal(verify("resume", "does-not-exist.md").status, 2)
  const res = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "documents", "verify-claims.mjs"),
      "badmode",
      "x.md",
    ],
    { cwd: ROOT, encoding: "utf8" },
  )
  assert.equal(res.status, 2)
})
