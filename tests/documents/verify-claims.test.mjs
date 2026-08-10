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

// Regression — the end-to-end half of the buildFactIndex organizations bug.
// `org.name` (undefined) instead of `org.text` meant a bullet quoting an
// organization verbatim was rejected with
//   Number "2021" not present in cited fact(s) [org-honor]
// even though the year is right there in the fact. R3 is the load-bearing
// number check, so the truthfulness gate was failing true content.
test("a bullet citing an organization fact passes R3", () => {
  const { status, report } = verify("resume", "good-resume-organizations.md")
  assert.equal(status, 0, JSON.stringify(report?.violations))
  assert.equal(report.ok, true)
  assert.ok(
    !report.violations.some((v) => v.detail?.includes("org-honor")),
    "no rule may fault a bullet that quotes its organization fact exactly",
  )
})

// Regression — a line carrying TWO separate fact comments.
//
// Nothing requires a writer to combine citations into one `<!-- fact:a,b -->`
// tag, and the strip used to be non-global: only the first comment came off,
// so the second one's own text stayed in the content the number checks read.
// A fact id is allowed to contain digits (`a-001`, `a-008`), so the verifier
// reported a number the document never claimed:
//   R4  Number "001" not found in any fact source
// Found 2026-08-10 on a real tailored resume. Both halves are asserted: the
// leaked id text (R4, non-bullet line) and the citations the first tag hid
// (R3, bullet line — 42% is backed only by the SECOND tag's fact).
test("two separate fact comments on one line are both stripped and both cited", () => {
  const { status, report } = verify(
    "resume",
    "good-resume-two-fact-comments.md",
  )
  assert.equal(status, 0, JSON.stringify(report?.violations))
  assert.equal(report.ok, true)
  const details = (report.violations ?? []).map((v) => v.detail).join(" ")
  assert.ok(
    !details.includes("001"),
    "a fact id's digits must never be read as an unsupported number",
  )
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

// THE SIBLING HOLE: the same attack aimed at answers.yaml instead of job.json.
//
// A hostile application form asks a question that is really an inventory, the
// user answers "Yes" to the part they were actually asked, and the whole
// inventory joins the evidence corpus — permanently, and for every future
// application, not just this employer's. Asserted HERE, at verify-claims,
// rather than only at evidenceText(): a unit test of the rule proves the rule,
// and what has to hold is that no document gets past the verifier.
test("a form question cannot whitelist a technology through a bare Yes", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-hostile-answers-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const poisoned = path.join(dir, "answers.yaml")
  fs.writeFileSync(
    poisoned,
    "answers:\n" +
      "  - id: a-001\n" +
      '    question: "Are you authorized to work in the US? (This role uses Kubernetes, Terraform and Kafka.)"\n' +
      "    answer: Yes\n" +
      "    added: 2026-07-30\n" +
      "  - id: a-002\n" +
      '    question: "Can you start within 30 days. The team runs Kubernetes."\n' +
      "    answer: Yes\n" +
      "    added: 2026-07-30\n",
    "utf8",
  )

  const res = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "documents", "verify-claims.mjs"),
      "resume",
      path.join(FIX, "bad-unknown-tech.md"),
      "--profile",
      path.join(FIX, "profile.yaml"),
      "--answers",
      poisoned,
    ],
    { cwd: ROOT, encoding: "utf8" },
  )
  const report = JSON.parse(res.stdout)
  assert.equal(res.status, 1, "a form question must never authorise a claim")
  const r6 = report.violations
    .filter((v) => v.rule === "R6")
    .map((v) => v.detail)
    .join(" ")
  assert.match(r6, /Kubernetes/, "Kubernetes must still be an unbacked claim")
  assert.match(r6, /Terraform/)
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

// --- the durable verdict (autonomy phase 1, item 1.3) -------------------------
//
// Before this, verification left no trace and "verified" degraded to "a
// resume.md exists". These tests are about the ROW, and about the two ways it
// stops being evidence.

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aj-vc-"))
  t.after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      /* a leaked Windows lock must not fail a passing test */
    }
  })
  const jobsDir = path.join(root, "jobs")
  const slug = "acme-dev"
  fs.mkdirSync(path.join(jobsDir, slug), { recursive: true })
  const resume = path.join(jobsDir, slug, "resume.md")
  fs.copyFileSync(path.join(FIX, "good-resume.md"), resume)
  return { root, jobsDir, slug, resume, db: path.join(root, "leads.db") }
}

function verifyIn(w, file, extra = []) {
  const res = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "documents", "verify-claims.mjs"),
      "resume",
      file,
      "--profile",
      path.join(FIX, "profile.yaml"),
      "--answers",
      path.join(FIX, "answers.yaml"),
      "--jobs-dir",
      w.jobsDir,
      "--db",
      w.db,
      ...extra,
    ],
    { cwd: ROOT, encoding: "utf8" },
  )
  return {
    status: res.status,
    report: JSON.parse(res.stdout),
    stderr: res.stderr,
  }
}

test("verifying a document in a job workspace writes a durable passing row", async (t) => {
  const w = workspace(t)
  const { status, report } = verifyIn(w, w.resume)
  assert.equal(status, 0)
  assert.equal(report.recorded.slug, "acme-dev")

  const { openDb, readVerifications, hasPassingVerification } =
    await import("../../scripts/lib/db.mjs")
  const { factBaseSha256, sha256File } =
    await import("../../scripts/lib/verification.mjs")
  const db = openDb(w.db)
  try {
    const rows = readVerifications(db, "acme-dev")
    assert.equal(rows.length, 1)
    assert.equal(rows[0].verdict, "pass")
    assert.equal(rows[0].mode, "resume")
    assert.equal(rows[0].doc_sha256, sha256File(w.resume))
    assert.ok(rows[0].verified_at)
    assert.equal(
      hasPassingVerification(db, {
        slug: "acme-dev",
        doc_sha256: sha256File(w.resume),
        profile_sha256: factBaseSha256({
          profilePath: path.join(FIX, "profile.yaml"),
          answersPath: path.join(FIX, "answers.yaml"),
        }),
      }),
      true,
      "the writer and the reader must compute profile_sha256 identically",
    )
  } finally {
    db.close()
  }
})

test("a FAILING verification is recorded as a failure, never as evidence", async (t) => {
  const w = workspace(t)
  fs.copyFileSync(path.join(FIX, "bad-unknown-tech.md"), w.resume)
  const { status, report } = verifyIn(w, w.resume)
  assert.equal(status, 1)
  assert.equal(report.recorded.slug, "acme-dev")

  const { openDb, readVerifications, hasPassingVerification } =
    await import("../../scripts/lib/db.mjs")
  const { sha256File, factBaseSha256 } =
    await import("../../scripts/lib/verification.mjs")
  const db = openDb(w.db)
  try {
    assert.equal(readVerifications(db, "acme-dev")[0].verdict, "fail")
    assert.equal(
      hasPassingVerification(db, {
        slug: "acme-dev",
        doc_sha256: sha256File(w.resume),
        profile_sha256: factBaseSha256({
          profilePath: path.join(FIX, "profile.yaml"),
          answersPath: path.join(FIX, "answers.yaml"),
        }),
      }),
      false,
    )
  } finally {
    db.close()
  }
})

test("verifying a file outside any job workspace writes nothing", async (t) => {
  const w = workspace(t)
  const scratch = path.join(w.root, "scratch-resume.md")
  fs.copyFileSync(path.join(FIX, "good-resume.md"), scratch)
  const { status, report } = verifyIn(w, scratch)
  assert.equal(status, 0)
  assert.equal(report.recorded, undefined, "no slug, no row")
  assert.equal(
    fs.existsSync(w.db),
    false,
    "and no store is created just to say nothing",
  )
})

test("--no-record verifies without touching the store", (t) => {
  const w = workspace(t)
  const { status, report } = verifyIn(w, w.resume, ["--no-record"])
  assert.equal(status, 0)
  assert.equal(report.ok, true)
  assert.equal(report.recorded, undefined)
  assert.equal(fs.existsSync(w.db), false)
})

test("re-verifying the same bytes updates the row rather than piling up rows", async (t) => {
  const w = workspace(t)
  verifyIn(w, w.resume)
  verifyIn(w, w.resume)
  const { openDb, readVerifications } = await import("../../scripts/lib/db.mjs")
  const db = openDb(w.db)
  try {
    assert.equal(readVerifications(db, "acme-dev").length, 1)
  } finally {
    db.close()
  }
})

test("a recording failure does not change the verdict verify-claims reports", (t) => {
  const w = workspace(t)
  // A directory where the database file should be: openDb cannot write there.
  fs.mkdirSync(w.db, { recursive: true })
  const { status, report, stderr } = verifyIn(w, w.resume)
  assert.equal(status, 0, "hard rule 4's gate is the verdict, not the ledger")
  assert.equal(report.ok, true)
  assert.ok(report.recorded.error, "and the problem is stated, not swallowed")
  assert.match(stderr, /verification not recorded/)
})
