// Corpus poisoning: a third party writing a claim onto the user's own resume.
//
// R6 is the load-bearing truthfulness control — every tech term in a generated
// document must trace to profile.yaml or answers.yaml. Two things a stranger
// controls used to join that corpus:
//
//   1. THE JOB TITLE. verify-claims.mjs adds job.company + job.title +
//      job.slug as "addressing fields", and techTermsIn() cannot tell Nevada
//      from Kubernetes. A resume claiming Kubernetes FAILED without --job and
//      PASSED ok:true with it. No hidden text, no injection phrasing — just a
//      normal-looking title. Closed by commit e2bcdca; this pins it.
//
//   2. A FORM LABEL. answers.yaml stores each question beside its answer, and
//      evidenceText() counts a question as evidence when the answer is an
//      unambiguous yes. The employer writes the question. Answered "Yes" once,
//      a compound label becomes permanent evidence for every future
//      application.
//
// EVERY ASSERTION HERE IS ON verify-claims' EXIT CODE AND R6 VIOLATIONS — the
// consumer — never on techTermsIn() or evidenceText() in isolation. A tailored
// resume either passes verification or it does not; that is the outcome that
// decides whether a lie goes out under the user's name.
//
// Run: node --test tests/security/corpus-poisoning.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..", "..")
const FIXTURES = path.join(ROOT, "tests/fixtures")
const HOSTILE = path.join(FIXTURES, "hostile")
const PROFILE = path.join(FIXTURES, "profile.yaml")

// The document under test. Two bullets: one truthful and cited, one claiming a
// technology the fact base cannot back. R7 needs at least one annotated
// bullet, so the truthful one is load-bearing for the test to be meaningful.
const RESUME_CLAIMING = (tech) => `# Jane Test

## Experience

### Full-Stack Developer — Acme Corp

- Built a customer portal in React and Node.js. <!-- fact:exp-acme-b1 -->
- Ran ${tech} clusters in production. <!-- fact:exp-acme-b1 -->
`

function verify(resumeText, { job, answers } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-corpus-"))
  try {
    const file = path.join(dir, "resume.md")
    fs.writeFileSync(file, resumeText)
    const args = ["resume", file, "--profile", PROFILE]
    if (job) args.push("--job", job)
    if (answers) args.push("--answers", answers)
    const res = spawnSync(
      process.execPath,
      [path.join(ROOT, "src/documents/verify-claims.mjs"), ...args],
      { cwd: ROOT, encoding: "utf8" },
    )
    let report = null
    try {
      report = JSON.parse(res.stdout)
    } catch {
      /* a usage error has no report; the caller asserts on status */
    }
    return {
      status: res.status,
      stderr: res.stderr,
      ok: report?.ok ?? null,
      r6: (report?.violations ?? [])
        .filter((v) => v.rule === "R6")
        .map((v) => v.detail),
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// --- the fixture is real ---------------------------------------------------

test("the title-poisoning fixture is a normal-looking posting, not an obvious attack", () => {
  const job = JSON.parse(
    fs.readFileSync(
      path.join(HOSTILE, "postings/title-poisoning.json"),
      "utf8",
    ),
  )
  assert.equal(job.title, "Full-Stack Engineer (React, Kubernetes, Terraform)")
  assert.equal(job.company, "Kubernetes Solutions LLC")
  // The point of this fixture: nothing in the BODY carries the attack. If the
  // description ever grows an injection phrase, the test stops proving that a
  // plain title is enough.
  assert.doesNotMatch(job.description, /ignore|instruction|resume|kubernetes/i)
  assert.ok(
    !job.requirements.some((r) => /kubernetes|terraform/i.test(r)),
    "the requirements must not name the technologies either",
  )
})

// --- attack 1: the title ---------------------------------------------------

test("a poisoned TITLE cannot whitelist a claim through R6", () => {
  const job = path.join(HOSTILE, "postings/title-poisoning.json")
  // Both security assertions first; the exit-code convention is a
  // characterisation and goes last, so a change to how verify-claims reports
  // cannot abort the test before the R6 violation is checked.
  const r = verify(RESUME_CLAIMING("Kubernetes"), { job })
  assert.equal(r.ok, false, "a resume claiming Kubernetes must not verify")
  assert.ok(
    r.r6.some((d) => /Kubernetes/.test(d)),
    `expected an R6 violation naming Kubernetes, got ${JSON.stringify(r.r6)}`,
  )
  assert.equal(r.status, 1, "a violation must exit non-zero")
})

test("the poisoned title is inert for EVERY technology it names", () => {
  // Terraform is in the title, Kubernetes is in the company name, React is in
  // both — and React is the interesting one, because the profile DOES back it.
  // A fix that stripped the whole addressing field would break nothing here;
  // a fix that stripped nothing would let all three through.
  const job = path.join(HOSTILE, "postings/title-poisoning.json")
  for (const tech of ["Kubernetes", "Terraform"]) {
    const r = verify(RESUME_CLAIMING(tech), { job })
    assert.equal(r.ok, false, `${tech} was whitelisted by the title`)
  }
  // React is truthful (profile.yaml lists it), so it must still pass — proving
  // the fix removed the WHITELIST, not the ability to mention a real skill.
  const react = verify(RESUME_CLAIMING("React"), { job })
  assert.equal(
    react.ok,
    true,
    `a truthful React claim must still verify: ${react.r6}`,
  )
})

test("the same claim fails identically with and without --job", () => {
  // The original bug in one line: the verdict CHANGED when a posting was
  // supplied. It must not.
  const job = path.join(HOSTILE, "postings/title-poisoning.json")
  const without = verify(RESUME_CLAIMING("Kubernetes"))
  const with_ = verify(RESUME_CLAIMING("Kubernetes"), { job })
  assert.equal(without.ok, false)
  assert.equal(with_.ok, false)
  assert.deepEqual(
    with_.r6,
    without.r6,
    "a posting must not change the verdict",
  )
})

test("addressing text still counts for NUMBERS, which is why it is in the corpus at all", () => {
  // The fix must not throw the baby out: a title like "Engineer II"
  // legitimately carries a number, and R4 checks numbers against the corpus.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-corpus-num-"))
  try {
    const job = path.join(dir, "job.json")
    fs.writeFileSync(
      job,
      JSON.stringify({ slug: "x", company: "Acme", title: "Engineer 77" }),
    )
    const doc = `# Jane Test

Applying for the Engineer 77 role.

- Built a customer portal in React and Node.js. <!-- fact:exp-acme-b1 -->
`
    assert.equal(
      verify(doc, { job }).ok,
      true,
      "a number from the title must still verify",
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// --- attack 2: the form label ---------------------------------------------

test("a compound form LABEL answered Yes cannot whitelist a claim — bracketed form", () => {
  // "Are you legally authorized to work in the US? (This role uses Kubernetes,
  // Terraform, Kafka.)" / "Yes". The user only ever said yes to being allowed
  // to work here.
  const answers = path.join(HOSTILE, "answers-label-poisoned.yaml")
  const r = verify(RESUME_CLAIMING("Kubernetes"), { answers })
  assert.equal(r.ok, false, "a parenthetical inventory became evidence")
  assert.ok(r.r6.some((d) => /Kubernetes/.test(d)))
})

test("a compound form LABEL answered Yes cannot whitelist a claim — UNBRACKETED form", () => {
  // THE 26TH REWORDING. The bracketed version was closed by stripping asides;
  // drop the brackets and name exactly one technology and the "must name
  // exactly one skill" narrowing lets it through. Measured passing (ok:true,
  // exit 0) on 2026-07-31 before w1-security's lib.mjs change; kept as the
  // permanent regression pin, because the shape is a rewording away from
  // returning.
  const answers = path.join(HOSTILE, "answers-label-poisoned.yaml")
  const r = verify(RESUME_CLAIMING("Kubernetes"), { answers })
  assert.equal(
    r.ok,
    false,
    "a-901 — an unbracketed compound label naming ONE technology — became evidence",
  )
})

test("an honest single-skill question answered Yes IS still evidence", () => {
  // The narrowing must not be so broad that recording a real skill stops
  // working: a-902 is "Do you have hands-on experience with React?" / "Yes".
  // Without this, a fix that rejects every question would look correct.
  const answers = path.join(HOSTILE, "answers-label-poisoned.yaml")
  const r = verify(RESUME_CLAIMING("React"), { answers })
  assert.equal(
    r.ok,
    true,
    `an unambiguous single-skill yes must remain evidence: ${JSON.stringify(r.r6)}`,
  )
})

test("the two attacks stack: a poisoned title AND a poisoned label together still fail", () => {
  // Defences are usually tested one at a time. A posting controls both fields,
  // so the combination is the realistic case.
  const r = verify(RESUME_CLAIMING("Kubernetes"), {
    job: path.join(HOSTILE, "postings/title-poisoning.json"),
    answers: path.join(HOSTILE, "answers-label-poisoned.yaml"),
  })
  assert.equal(r.ok, false)
  assert.ok(r.r6.some((d) => /Kubernetes/.test(d)))
})

// --- the corpus boundary itself -------------------------------------------

test("the posting BODY is never evidence, however much technology it names", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-corpus-body-"))
  try {
    const job = path.join(dir, "job.json")
    fs.writeFileSync(
      job,
      JSON.stringify({
        slug: "x",
        company: "Acme",
        title: "Full-Stack Engineer",
        description:
          "Our stack is Kubernetes, Terraform, Kafka, Scala, Elixir and Rust. " +
          "The successful candidate has deep experience with all of them.",
        requirements: ["Kubernetes", "Terraform", "Kafka"],
      }),
    )
    for (const tech of ["Kubernetes", "Terraform", "Kafka", "Rust"]) {
      assert.equal(
        verify(RESUME_CLAIMING(tech), { job }).ok,
        false,
        `${tech} was whitelisted by the posting body`,
      )
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
