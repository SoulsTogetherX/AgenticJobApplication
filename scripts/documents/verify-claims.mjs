#!/usr/bin/env node
// Deterministic truthfulness verifier — the core guardrail.
//
// Usage:
//   node scripts/documents/verify-claims.mjs resume <file.md> [--job jobs/<slug>/job.json]
//        [--profile profile/profile.yaml] [--answers profile/answers.yaml]
//   node scripts/documents/verify-claims.mjs cover-letter <file.md> [same flags]
//
// Resume mode:
//   R1 every bullet line must carry <!-- fact:ID[,ID2] -->
//   R2 every cited fact id must exist in profile/answers
//   R3 every number in an annotated bullet must appear in a cited fact's text
//   R4 (shared) every number outside bullets must appear somewhere in the corpus
//   R5 (shared) every "Mon YYYY" date token must appear in the corpus
//   R6 (shared) every known tech term in the doc must appear in the corpus
//   R7 document must contain at least one annotated bullet
//
// Cover-letter mode: R4–R6 only. The corpus additionally includes the job's
// company and title (for addressing) — NEVER the posting body, so tech terms
// that appear only in the posting still fail R6.
//
// Output: JSON report on stdout; exit 0 = pass, 1 = violations, 2 = usage error.
import fs from "node:fs"
import {
  loadYamlFile,
  buildFactIndex,
  extractNumbers,
  extractMonthYears,
  techTermsIn,
  evidenceText,
} from "../lib/lib.mjs"

function fail(msg) {
  console.error(msg)
  process.exit(2)
}

const args = process.argv.slice(2)
const mode = args[0]
const file = args[1]
if (!["resume", "cover-letter"].includes(mode) || !file) {
  fail(
    "Usage: verify-claims.mjs <resume|cover-letter> <file.md> [--job j.json] [--profile p.yaml] [--answers a.yaml]",
  )
}
function flag(name, dflt) {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] ? args[i + 1] : dflt
}
const profilePath = flag("--profile", "profile/profile.yaml")
const answersPath = flag("--answers", "profile/answers.yaml")
const jobPath = flag("--job", null)

if (!fs.existsSync(file)) fail(`No such file: ${file}`)
if (!fs.existsSync(profilePath)) fail(`No such profile: ${profilePath}`)

const doc = fs.readFileSync(file, "utf8")
const profile = loadYamlFile(profilePath)
const answers = fs.existsSync(answersPath)
  ? loadYamlFile(answersPath)
  : { answers: [] }
const factIndex = buildFactIndex(profile, answers)

// Corpus = the text that may be treated as EVIDENCE (numbers/dates/tech are
// checked against it).
//
// NOT the raw bytes of answers.yaml. That file stores each form QUESTION beside
// its answer, and forms ask things like "which of these do you have experience
// with? [... 4 = Spring / Spring Boot; 5 = Cloud (AWS, Azure, or GCP)]". With
// the raw text as corpus, R6 accepted "Azure" and "Spring" — technologies the
// user does not have and, in Spring's case, explicitly did not select. See
// evidenceText() for the rule: an answer always counts, a question only counts
// when the answer is an unambiguous yes.
let corpus = evidenceText(
  fs.readFileSync(profilePath, "utf8"),
  fs.existsSync(answersPath) ? answers : { answers: [] },
)
if (jobPath) {
  if (!fs.existsSync(jobPath)) fail(`No such job file: ${jobPath}`)
  const job = JSON.parse(fs.readFileSync(jobPath, "utf8"))
  // Only the addressing fields — the posting body must never whitelist claims.
  corpus += `\n${job.company ?? ""} ${job.title ?? ""} ${job.slug ?? ""}`
}

const corpusNumbers = extractNumbers(corpus)
const corpusDates = extractMonthYears(corpus)
const corpusTech = new Set(techTermsIn(corpus))

const violations = []
const lines = doc.split(/\r?\n/)
const FACT_RE = /<!--\s*fact:\s*([A-Za-z0-9_,\s-]+?)\s*-->/
const BULLET_RE = /^\s*(?:[-*●]|\d+\.)\s+/

let annotatedBullets = 0

lines.forEach((line, i) => {
  const lineNo = i + 1
  const isBullet = BULLET_RE.test(line)
  const factMatch = line.match(FACT_RE)

  if (mode === "resume" && isBullet) {
    if (!factMatch) {
      violations.push({
        rule: "R1",
        line: lineNo,
        detail: `Bullet has no <!-- fact:ID --> annotation: "${line.trim().slice(0, 80)}"`,
      })
      return
    }
    annotatedBullets++
    const ids = factMatch[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    const factTexts = []
    for (const id of ids) {
      const fact = factIndex.get(id)
      if (!fact)
        violations.push({
          rule: "R2",
          line: lineNo,
          detail: `Unknown fact id "${id}"`,
        })
      else factTexts.push(fact.text)
    }
    if (factTexts.length) {
      const allowed = extractNumbers(factTexts.join(" "))
      const content = line.replace(FACT_RE, "")
      for (const n of extractNumbers(content)) {
        if (!allowed.has(n)) {
          violations.push({
            rule: "R3",
            line: lineNo,
            detail: `Number "${n}" not present in cited fact(s) [${ids.join(", ")}]`,
          })
        }
      }
    }
    return
  }

  // Non-bullet lines (and all cover-letter lines): numbers must exist in corpus.
  const content = line.replace(FACT_RE, "")
  for (const n of extractNumbers(content)) {
    if (!corpusNumbers.has(n)) {
      violations.push({
        rule: "R4",
        line: lineNo,
        detail: `Number "${n}" not found in any fact source`,
      })
    }
  }
})

// R5: date tokens anywhere in the document.
for (const d of extractMonthYears(doc)) {
  if (!corpusDates.has(d))
    violations.push({
      rule: "R5",
      detail: `Date "${d}" not found in any fact source`,
    })
}

// R6: tech terms anywhere in the document.
for (const term of techTermsIn(doc)) {
  if (!corpusTech.has(term))
    violations.push({
      rule: "R6",
      detail: `Tech term "${term}" not found in any fact source`,
    })
}

// R7: resume must actually cite facts.
if (mode === "resume" && annotatedBullets === 0) {
  violations.push({
    rule: "R7",
    detail:
      "Document contains no annotated bullets — nothing is traceable to the profile",
  })
}

// R8: keyword coverage. NON-BLOCKING by design.
//
// Every other rule here answers "is this true?", and a failure is a lie that
// must be fixed. R8 answers "is this complete?", and a miss is a trade-off: a
// one-page resume genuinely cannot carry every matched term, and dropping one
// to keep the page readable is a legitimate editorial call. Making it blocking
// would pressure the tailoring step into stuffing — the exact behaviour modern
// parsers penalise.
//
// So it reports and never fails. Reading `jobs/<slug>/keywords.json` when it
// exists; silent when it does not, so nothing about the existing flow changes.
let coverage = null
if (jobPath) {
  const planPath = jobPath.replace(/job\.json$/, "keywords.json")
  if (fs.existsSync(planPath)) {
    try {
      const plan = JSON.parse(fs.readFileSync(planPath, "utf8"))
      const docTerms = new Set(techTermsIn(doc))
      // A term counts as present if any of its ATS surface forms appears.
      const present = (m) =>
        docTerms.has(m.skill) ||
        (m.ats_forms ?? []).some((f) =>
          new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(doc),
        )
      const missing = (plan.must_use ?? []).filter((m) => !present(m))
      // Blocked terms ARE a truthfulness matter, but R6 already catches them
      // against the corpus. Reported here too so the message names the plan.
      const usedBlocked = (plan.blocked ?? [])
        .filter((b) => docTerms.has(b.skill))
        .map((b) => b.skill)
      coverage = {
        must_use: (plan.must_use ?? []).length,
        placed: (plan.must_use ?? []).length - missing.length,
        missing: missing.map((m) => m.skill),
        missing_required: missing.filter((m) => m.required).map((m) => m.skill),
        used_blocked: usedBlocked,
        title_mirror: plan.title_mirror?.mirror ?? null,
        title_mirrored: plan.title_mirror?.mirror
          ? new RegExp(
              plan.title_mirror.mirror.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
              "i",
            ).test(doc)
          : null,
      }
    } catch {
      // A malformed plan must never block verification of a truthful document.
      coverage = { error: "keywords.json unreadable — coverage not checked" }
    }
  }
}

const report = {
  mode,
  file,
  ok: violations.length === 0,
  checked: { annotatedBullets, lines: lines.length },
  violations,
  ...(coverage ? { coverage } : {}),
}
console.log(JSON.stringify(report, null, 2))
process.exit(report.ok ? 0 : 1)
