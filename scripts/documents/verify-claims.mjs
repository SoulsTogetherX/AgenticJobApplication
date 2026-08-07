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
//
// SHAPE (Phase 3 item 3.4). This was a top-level script: importing it RAN it.
// It is now exported pure functions plus a thin CLI, for two reasons that are
// not tidiness. First, `assemble-resume.mjs` has to re-verify a rephrased
// document in-process — spawning a verifier from the assembler would put
// child_process in the assembler's import graph, which is the one thing the
// unattended path is asserted not to have. Second, `loadFactContext` builds the
// fact index and the evidence corpus ONCE and hands the same object to every
// document in a run; the old shape rebuilt both per invocation.
//
// The pure core does no I/O and never touches the database. Everything that
// reads a file, writes a row or exits lives below the CLI banner.
//
// IT ALSO WRITES A DURABLE ROW, and that is not bookkeeping. Before this,
// verification left no trace: the only later evidence that a document had been
// checked was that the file existed, so a draft nobody had verified, or one
// edited afterwards, read as verified on the path that decides whether an
// application may be sent unattended. The row records the exact bytes checked
// (doc_sha256) and the exact fact base they were checked against
// (profile_sha256, from lib/verification.mjs), so both editing the document and
// the user editing profile.yaml invalidate it — see that module's header.
//
// A row is written ONLY for a document inside a job workspace
// (jobs/<slug>/<file>). Verifying a scratch file or a fixture writes nothing,
// because there is no slug for it to vouch for. `--db <path>` and
// `--jobs-dir <path>` exist so that path is testable; `--no-record` skips it.
import fs from "node:fs"
import { pathToFileURL } from "node:url"
import path from "node:path"
import {
  loadYamlFile,
  buildFactIndex,
  extractNumbers,
  extractMonthYears,
  techTermsIn,
  evidenceText,
} from "../lib/lib.mjs"
import { canonicalSurface } from "../lib/keywords.mjs"
import { verificationIdentity, JOBS_DIR } from "../lib/verification.mjs"

const FACT_RE = /<!--\s*fact:\s*([A-Za-z0-9_,\s-]+?)\s*-->/
const BULLET_RE = /^\s*(?:[-*●]|\d+\.)\s+/

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

/**
 * Everything a run needs to know about the fact base, computed once.
 *
 * Corpus = the text that may be treated as EVIDENCE (numbers/dates/tech are
 * checked against it).
 *
 * NOT the raw bytes of answers.yaml. That file stores each form QUESTION beside
 * its answer, and forms ask things like "which of these do you have experience
 * with? [... 4 = Spring / Spring Boot; 5 = Cloud (AWS, Azure, or GCP)]". With
 * the raw text as corpus, R6 accepted "Azure" and "Spring" — technologies the
 * user does not have and, in Spring's case, explicitly did not select. See
 * evidenceText() for the rule: an answer always counts, a question only counts
 * when the answer is an unambiguous yes.
 */
export function factContextFrom({ profileRaw, profile, answers }) {
  const answersDoc = answers ?? { answers: [] }
  const evidence = evidenceText(profileRaw, answersDoc)
  return {
    profile,
    answers: answersDoc,
    factIndex: buildFactIndex(profile, answersDoc),
    evidence,
    corpusNumbers: extractNumbers(evidence),
    corpusDates: extractMonthYears(evidence),
    // Tech comes from the EVIDENCE ONLY — never from board-controlled
    // addressing. See addressingFor().
    corpusTech: new Set(techTermsIn(evidence)),
  }
}

/** The file-reading wrapper around factContextFrom. Build it once per run. */
export function loadFactContext({ profilePath, answersPath }) {
  const profile = loadYamlFile(profilePath)
  const answers =
    answersPath && fs.existsSync(answersPath)
      ? loadYamlFile(answersPath)
      : { answers: [] }
  return factContextFrom({
    profileRaw: fs.readFileSync(profilePath, "utf8"),
    profile,
    answers,
  })
}

// The addressing fields exist so a company name or a job title is not itself
// flagged as an unsupported claim. They are NOT evidence of a skill, and the
// distinction is load-bearing: the board writes them.
//
// The old comment here said "only the addressing fields — the posting body must
// never whitelist claims", which was true and insufficient, because
// techTermsIn() cannot tell a city from a technology. A posting titled
//
//   "Senior Engineer (Terraform / Kotlin / Elixir stack)"
//   at "Kubernetes Solutions LLC"
//
// whitelisted every one of those: a résumé claiming them FAILED R6 without
// --job and PASSED ok:true with it. A posting chooses its own title, so a
// posting could authorise claims on a document signed with the user's name —
// no hidden text and no injection phrasing needed, just a normal-looking title.
//
// So addressing text still counts for numbers and dates (a title like
// "Engineer II" legitimately carries one), and never for technology.
export function addressingFor(job) {
  if (!job) return ""
  return `\n${job.company ?? ""} ${job.title ?? ""} ${job.slug ?? ""}`
}

/**
 * R8: keyword coverage. NON-BLOCKING by design.
 *
 * Every other rule here answers "is this true?", and a failure is a lie that
 * must be fixed. R8 answers "is this complete?", and a miss is a trade-off: a
 * one-page resume genuinely cannot carry every matched term, and dropping one
 * to keep the page readable is a legitimate editorial call. Making it blocking
 * would pressure the tailoring step into stuffing — the exact behaviour modern
 * parsers penalise.
 */
export function coverageFor(doc, plan) {
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
  return {
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
}

/**
 * R1–R7 over one document. Pure: bytes and a fact context in, a report out.
 * No file is read, no row is written, nothing exits.
 */
export function verifyDocument({
  doc,
  mode,
  ctx,
  addressing = "",
  plan = null,
}) {
  const corpusNumbers = new Set(ctx.corpusNumbers)
  const corpusDates = new Set(ctx.corpusDates)
  for (const n of extractNumbers(addressing)) corpusNumbers.add(n)
  for (const d of extractMonthYears(addressing)) corpusDates.add(d)
  const corpusTech = ctx.corpusTech

  const violations = []
  const lines = String(doc).split(/\r?\n/)
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
        const fact = ctx.factIndex.get(id)
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
  //
  // Compared as SPELLINGS, not as raw strings. This used to be a plain
  // `corpusTech.has(term)`, so two spellings of one artifact were two different
  // skills: a profile saying "Postgres" and a resume saying "PostgreSQL" was an
  // R6 violation and exit 1 — while docs/tailoring-rules.md §8 instructs
  // "PostgreSQL not Postgres" and checkWrittenForm() tells the writer to make
  // exactly that edit (AUDIT C3). The gate and the documentation were fighting,
  // and each round cost a model turn plus a re-verify.
  //
  // canonicalSurface() folds ONLY the eight hand-enumerated sibling pairs in
  // keywords.mjs. It deliberately does NOT fold a whole `surface` list: an
  // abstraction's surface list holds different products (Testing's is
  // Jest/Vitest/Cypress/Selenium/…), so folding those would make a profile
  // mentioning Jest into evidence for a resume claiming Selenium — an invention
  // arriving through the truthfulness gate itself.
  const corpusSpellings = new Set([...corpusTech].map(canonicalSurface))
  for (const term of techTermsIn(doc)) {
    if (!corpusSpellings.has(canonicalSurface(term)))
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

  let coverage = null
  if (plan) {
    try {
      coverage = coverageFor(doc, plan)
    } catch {
      // A malformed plan must never block verification of a truthful document.
      coverage = { error: "keywords.json unreadable — coverage not checked" }
    }
  }

  return {
    mode,
    ok: violations.length === 0,
    checked: { annotatedBullets, lines: lines.length },
    violations,
    ...(coverage ? { coverage } : {}),
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function fail(msg) {
  console.error(msg)
  process.exit(2)
}

export async function main(args = process.argv.slice(2)) {
  const mode = args[0]
  const file = args[1]
  if (!["resume", "cover-letter"].includes(mode) || !file) {
    fail(
      "Usage: verify-claims.mjs <resume|cover-letter> <file.md> [--job j.json] [--profile p.yaml] [--answers a.yaml]",
    )
  }
  const flag = (name, dflt) => {
    const i = args.indexOf(name)
    return i !== -1 && args[i + 1] ? args[i + 1] : dflt
  }
  const profilePath = flag("--profile", "profile/profile.yaml")
  const answersPath = flag("--answers", "profile/answers.yaml")
  const jobPath = flag("--job", null)
  const jobsDir = flag("--jobs-dir", JOBS_DIR)
  // db.mjs is NOT imported at module scope: it loads node:sqlite, and this
  // script must stay cheap for the common case of verifying a file that is not
  // in a workspace at all. A null --db means db.mjs's own default store.
  const noRecord = args.includes("--no-record")
  const dbFlag = flag("--db", null)

  if (!fs.existsSync(file)) fail(`No such file: ${file}`)
  if (!fs.existsSync(profilePath)) fail(`No such profile: ${profilePath}`)

  const doc = fs.readFileSync(file, "utf8")
  const ctx = loadFactContext({ profilePath, answersPath })

  let addressing = ""
  let plan = null
  if (jobPath) {
    if (!fs.existsSync(jobPath)) fail(`No such job file: ${jobPath}`)
    addressing = addressingFor(JSON.parse(fs.readFileSync(jobPath, "utf8")))
    // Reading `jobs/<slug>/keywords.json` when it exists; silent when it does
    // not, so nothing about the existing flow changes.
    const planPath = jobPath.replace(/job\.json$/, "keywords.json")
    if (fs.existsSync(planPath)) {
      try {
        plan = JSON.parse(fs.readFileSync(planPath, "utf8"))
      } catch {
        plan = { __unreadable: true }
      }
    }
  }

  const core =
    plan?.__unreadable === true
      ? {
          ...verifyDocument({ doc, mode, ctx, addressing }),
          coverage: {
            error: "keywords.json unreadable — coverage not checked",
          },
        }
      : verifyDocument({ doc, mode, ctx, addressing, plan })

  const report = { mode: core.mode, file, ...core }

  // The durable verdict. Both outcomes are recorded, not just passes: a stored
  // 'fail' is what lets a later reader distinguish "checked and rejected" from
  // "never checked", and the reader (hasPassingVerification) requires
  // verdict='pass' anyway, so a failure can never be mistaken for evidence.
  //
  // Never fatal. verify-claims is hard rule 4's gate and its EXIT CODE is what
  // every caller reads; a database that is locked, missing or unwritable must
  // not turn a truthful document into a verification failure. A recording
  // problem is reported on the report and on stderr, where it is visible
  // without changing the verdict.
  const identity = noRecord
    ? null
    : verificationIdentity(file, { jobsDir, profilePath, answersPath })
  if (identity) {
    try {
      const { openDb, recordVerification } = await import("../lib/db.mjs")
      const db = openDb(dbFlag ?? undefined)
      try {
        recordVerification(db, {
          ...identity,
          mode,
          verdict: report.ok ? "pass" : "fail",
          doc: report,
        })
      } finally {
        db.close()
      }
      report.recorded = identity
    } catch (e) {
      report.recorded = { error: String(e?.message ?? e) }
      console.error(`verification not recorded: ${e?.message ?? e}`)
    }
  }

  console.log(JSON.stringify(report, null, 2))
  process.exit(report.ok ? 0 : 1)
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) await main()
