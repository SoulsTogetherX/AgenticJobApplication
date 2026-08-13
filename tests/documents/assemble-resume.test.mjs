// Phase 3 item 3.1 (+ 3.2's audit and 3.5's diff): deterministic assembly.
//
// The falsifiable check the plan asks for is check 1: for >= 6 job fixtures
// spanning different tech stacks, the assembler's output is byte-identical to a
// committed golden file, passes `verify-claims resume <out>` with exit 0, and
// every sentence in it appears verbatim in profile.yaml or answers.yaml.
//
// "Every sentence appears verbatim" is asserted TWO ways here, because one of
// them alone is weak:
//
//   RULE S  every annotated line whose fact is a profile `text:` field must
//           equal that fact EXACTLY, and that text must be findable in the raw
//           bytes of profile.yaml. This is the verbatim-emission property
//           itself, and it is the one that makes R1-R7 hold by construction.
//   RULE V  every span of every line decomposes into pieces that are each
//           either a declared structural label or a verbatim substring of
//           profile.yaml / answers.yaml. This one covers the composed lines
//           (headings, the skills block, the education line), which Rule S
//           cannot speak about, and it is what catches a fabricated word
//           anywhere in the document.
//
// Both were mutation-proved before landing: a word not in the fact base fails
// Rule V, and a rewritten bullet fails Rule S.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import yaml from "js-yaml"
import { buildFactIndex } from "../../scripts/lib/lib.mjs"
import {
  assembleResume,
  formatSelectionDiff,
  rephraseAudit,
  annotatedLines,
  DEFAULT_BUDGET,
} from "../../scripts/documents/assemble-resume.mjs"
import { buildPlan } from "../../scripts/documents/keyword-plan.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const FIX = path.join(ROOT, "tests", "documents", "assemble")
const GOLDEN = path.join(FIX, "golden")
const PROFILE = path.join(FIX, "profile.yaml")
const ANSWERS = path.join(FIX, "answers.yaml")

// The golden budget. Deliberately tighter than DEFAULT_BUDGET so that selection
// actually drops facts: at a budget everything fits under, all six postings
// produce the same document and the golden files would prove nothing about
// selection at all. (That degenerate case is pinned separately, below.)
const GOLDEN_BUDGET = 1400

const STACK_FIXTURES = [
  "react-frontend",
  "node-backend",
  "python-data",
  "cloud-platform",
  "graphql-api",
  "fullstack-generalist",
]

const readJob = (slug) =>
  JSON.parse(fs.readFileSync(path.join(FIX, "jobs", `${slug}.json`), "utf8"))
const rawProfile = fs.readFileSync(PROFILE, "utf8")
const rawAnswers = fs.readFileSync(ANSWERS, "utf8")
const profile = yaml.load(rawProfile)
const answers = yaml.load(rawAnswers)
const factIndex = buildFactIndex(profile, answers)
const SOURCES = [rawProfile, rawAnswers]

function assemble(slug, budget = GOLDEN_BUDGET) {
  const job = readJob(slug)
  const plan = buildPlan({
    job,
    profileBlob: rawProfile,
    targets: ["Developer", "Engineer"],
  })
  return assembleResume({ job, profile, answers, plan, budget })
}

// --- Rule S ----------------------------------------------------------------
// The ids whose profile source is a literal `text:` field — the SENTENCES.
// Collected from the YAML here, independently of the assembler's own item
// model, so this is a check on the assembler rather than a restatement of it.
function proseFactIds(p) {
  const ids = new Set()
  for (const s of p.summary ?? []) ids.add(s.id)
  for (const e of p.experience ?? [])
    for (const b of e.bullets ?? []) ids.add(b.id)
  for (const j of p.projects ?? [])
    for (const b of j.bullets ?? []) ids.add(b.id)
  return ids
}
const PROSE = proseFactIds(profile)

// --- Rule V ----------------------------------------------------------------
// Labels the template is allowed to write. Everything else must come from the
// fact base. Keep this list SHORT: every entry is a word the document may carry
// that nobody verified, so a long list is a hole.
const STRUCTURAL = new Set([
  "Summary",
  "Experience",
  "Projects",
  "Technical Skills",
  "Education",
  "GPA",
])
const SEPARATORS = [" — ", " | ", "(", ")", ", ", ": "]

function checkSpan(span, failures) {
  const t = span.trim()
  if (!t) return
  if (STRUCTURAL.has(t)) return
  if (SOURCES.some((src) => src.includes(t))) return
  for (const sep of SEPARATORS) {
    if (t.includes(sep)) {
      for (const part of t.split(sep)) checkSpan(part, failures)
      return
    }
  }
  const words = t.split(/\s+/)
  if (words.length > 1) {
    for (const w of words) checkSpan(w, failures)
    return
  }
  failures.push(t)
}

function unverbatimSpans(markdown) {
  const failures = []
  for (const raw of markdown.split("\n")) {
    const line = raw
      .replace(/<!--\s*fact:[^>]*-->/g, "")
      // A dates span is a separator, not something to delete: turning it into
      // " — " keeps the title / company / dates split tight instead of letting
      // the whole heading fall through to the word tier.
      .replace(/<span class="dates">/g, " — ")
      .replace(/<\/span>/g, "")
      .replace(/^\s*#{1,6}\s+/, "")
      .replace(/^\s*[-*●]\s+/, "")
    checkSpan(line, failures)
  }
  return failures
}

function verifyCli(file, extra = []) {
  const res = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "documents", "verify-claims.mjs"),
      "resume",
      file,
      "--profile",
      PROFILE,
      "--answers",
      ANSWERS,
      "--no-record",
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

function tmpdir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "asm-"))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

function workspace(t, slug) {
  const dir = tmpdir(t)
  fs.mkdirSync(path.join(dir, slug))
  fs.copyFileSync(
    path.join(FIX, "jobs", `${slug}.json`),
    path.join(dir, slug, "job.json"),
  )
  return dir
}

// ---------------------------------------------------------------------------
// Check 1 — golden bytes, verify-claims exit 0, verbatim sentences
// ---------------------------------------------------------------------------

test("six job fixtures across different stacks assemble byte-identically to their goldens", () => {
  assert.ok(
    STACK_FIXTURES.length >= 6,
    "the check requires at least six fixtures",
  )
  for (const slug of STACK_FIXTURES) {
    const { markdown } = assemble(slug)
    const golden = fs.readFileSync(path.join(GOLDEN, `${slug}.md`), "utf8")
    assert.equal(markdown, golden, `${slug} drifted from its golden file`)
  }
})

test("each golden passes verify-claims resume with exit 0", (t) => {
  const dir = tmpdir(t)
  for (const slug of STACK_FIXTURES) {
    const file = path.join(dir, `${slug}.md`)
    fs.writeFileSync(file, fs.readFileSync(path.join(GOLDEN, `${slug}.md`)))
    const { status, report } = verifyCli(file)
    assert.equal(
      status,
      0,
      `${slug}: ${JSON.stringify(report?.violations ?? report)}`,
    )
    assert.equal(report.ok, true)
    assert.ok(report.checked.annotatedBullets >= 5)
  }
})

test("every sentence in every golden is a profile fact, verbatim (Rules S and V)", () => {
  for (const slug of STACK_FIXTURES) {
    const md = fs.readFileSync(path.join(GOLDEN, `${slug}.md`), "utf8")

    // Rule S — the prose lines are the fact, character for character.
    let prose = 0
    for (const { ids, content } of annotatedLines(md)) {
      assert.equal(ids.length, 1, `${slug}: every line cites exactly one fact`)
      const id = ids[0]
      assert.ok(factIndex.has(id), `${slug}: unknown fact id ${id}`)
      if (!PROSE.has(id)) continue
      prose++
      assert.equal(
        content,
        factIndex.get(id).text,
        `${slug}: ${id} was not emitted verbatim`,
      )
      assert.ok(
        rawProfile.includes(content),
        `${slug}: ${id}'s text is not in profile.yaml's bytes`,
      )
    }
    assert.ok(prose >= 4, `${slug}: expected several prose facts, got ${prose}`)

    // Rule V — nothing anywhere in the document that the fact base cannot show.
    assert.deepEqual(
      unverbatimSpans(md),
      [],
      `${slug}: spans not found in the fact base`,
    )
  }
})

test("Rule V catches a word the fact base cannot back", () => {
  // The mutation proof, kept as a test so the check cannot rot into a
  // tautology: "Kotlin" is a real lexicon term and is nowhere in the fixture.
  const md = fs
    .readFileSync(path.join(GOLDEN, "react-frontend.md"), "utf8")
    .replace("TypeScript serving", "Kotlin serving")
  assert.deepEqual(unverbatimSpans(md), ["Kotlin"])
})

test("Rule S catches a rephrase that keeps the citation", () => {
  const md = fs
    .readFileSync(path.join(GOLDEN, "react-frontend.md"), "utf8")
    .replace(
      "Built a customer portal in React and TypeScript",
      "Architected a customer portal using React and TypeScript",
    )
  const rows = annotatedLines(md).filter((l) => l.ids[0] === "exp-acme-b1")
  assert.equal(rows.length, 1)
  assert.notEqual(rows[0].content, factIndex.get("exp-acme-b1").text)
})

// ---------------------------------------------------------------------------
// Rule 0 — a posting is data, never instructions
// ---------------------------------------------------------------------------

test("an instruction payload in a posting changes nothing about the document", () => {
  const hostile = assemble("fullstack-hostile").markdown
  const clean = assemble("fullstack-hostile-clean").markdown
  assert.equal(
    hostile,
    clean,
    "the payload moved bytes — sanitisation is not holding",
  )
  assert.equal(
    hostile,
    fs.readFileSync(path.join(GOLDEN, "fullstack-hostile.md"), "utf8"),
  )
  // ...and the terms the payload demanded are absent, by name.
  for (const term of ["Kubernetes cluster", "Redis caching"]) {
    assert.ok(
      !hostile.includes(term),
      `payload term "${term}" reached the page`,
    )
  }
  // The payload is still SEEN — silence would be the other failure.
  const plan = buildPlan({
    job: readJob("fullstack-hostile"),
    profileBlob: rawProfile,
    targets: ["Developer"],
  })
  assert.ok(
    plan.untrusted_findings.length > 0,
    "the payload was neither acted on nor noticed",
  )
})

// ---------------------------------------------------------------------------
// Selection — the posting decides WHAT, never WHETHER it is true
// ---------------------------------------------------------------------------

test("different postings select different facts", () => {
  const ids = (slug) =>
    new Set(assemble(slug).selection.included.map((i) => i.id))
  const cloud = ids("cloud-platform")
  const data = ids("python-data")
  assert.ok(
    cloud.has("prj-kube-b1"),
    "the cloud posting should pull the k8s work",
  )
  assert.ok(!data.has("prj-kube-b1"), "the data posting should not")
  assert.ok(
    data.has("prj-atlas-b1"),
    "the data posting should pull the importer",
  )
  assert.ok(!cloud.has("prj-atlas-b1"), "the cloud posting should not")
})

test("a budget that fits everything makes the posting irrelevant", () => {
  const a = assemble("cloud-platform", DEFAULT_BUDGET).markdown
  const b = assemble("python-data", DEFAULT_BUDGET).markdown
  assert.equal(a, b)
  assert.equal(
    a,
    fs.readFileSync(
      path.join(GOLDEN, "fullstack-generalist--default-budget.md"),
      "utf8",
    ),
  )
})

test("assembly is deterministic — same inputs, same bytes", () => {
  for (const slug of STACK_FIXTURES) {
    assert.equal(assemble(slug).markdown, assemble(slug).markdown)
  }
})

test("a budget too small for the mandatory sections says so rather than lying", () => {
  const { markdown, selection } = assemble("node-backend", 100)
  assert.equal(selection.over_budget, true)
  assert.ok(selection.chars_used > 100)
  // Still a valid resume: the structural facts survive, only bullets are cut.
  assert.match(markdown, /## Technical Skills/)
  assert.match(markdown, /## Education/)
  assert.equal(
    selection.included.every((i) => i.how === "mandatory"),
    true,
  )
  assert.ok(selection.dropped.length > 0)
})

test("selection covers required posting terms before optional ones", () => {
  const { selection } = assemble("graphql-api")
  const byId = new Map(selection.included.map((i) => [i.id, i]))
  const covering = [...byId.values()].filter((i) => i.how === "coverage")
  assert.ok(covering.length > 0, "nothing was selected for coverage")
  assert.deepEqual(selection.keyword_coverage.missing_required, [])
})

// ---------------------------------------------------------------------------
// Item 3.5 — the approval message is a mechanical selection diff
// ---------------------------------------------------------------------------

test("the selection diff names every fact id, in or out, with a reason", () => {
  const { selection } = assemble("cloud-platform")
  const text = formatSelectionDiff(selection)
  for (const i of selection.included) {
    assert.ok(text.includes(i.id), `${i.id} missing from the diff`)
    assert.ok(i.reason && i.reason.length > 8, `${i.id} has no reason`)
  }
  for (const d of selection.dropped) {
    assert.ok(text.includes(d.id), `${d.id} missing from the diff`)
    assert.match(
      d.reason,
      /budget exhausted|no bullet under it/,
      `${d.id}'s reason is not mechanical: ${d.reason}`,
    )
  }
  // A fact the shape has no place for is DISTINGUISHED from one that lost.
  assert.deepEqual(
    selection.not_emitted.map((n) => n.id),
    ["extra-oss", "ans-auth", "ans-remote"],
  )
  assert.match(text, /NOT CONSIDERED \(3\)/)
  assert.match(text, /No sentence in the document was written by a model/)
})

test("the diff accounts for every selectable fact exactly once", () => {
  const { selection } = assemble("react-frontend")
  const seen = [
    ...selection.included.map((i) => i.id),
    ...selection.dropped.map((d) => d.id),
    ...selection.not_emitted.map((n) => n.id),
  ]
  assert.equal(new Set(seen).size, seen.length, "a fact id appears twice")
  const everyProfileFact = [...factIndex.keys()]
  const unaccounted = everyProfileFact.filter(
    (id) => !seen.includes(id) && id !== "__contact",
  )
  assert.deepEqual(
    unaccounted,
    [],
    `facts neither used nor explained: ${unaccounted.join(", ")}`,
  )
})

// ---------------------------------------------------------------------------
// Item 3.2 — the rephrase pass stays available, and stays re-verified
// ---------------------------------------------------------------------------

test("rephraseAudit classifies verbatim, rephrased, dropped and added lines", () => {
  const baseline = assemble("node-backend").markdown
  const edited = baseline
    .replace(
      "Reduced API latency by 42% by adding PostgreSQL query caching behind an Express service.",
      "Cut API latency 42% with PostgreSQL query caching behind an Express service.",
    )
    .replace(
      /^- Built a customer portal.*\n/m,
      "- Shipped a metrics dashboard with 15 chart types in TypeScript. <!-- fact:prj-dash-b1 -->\n",
    )
  const audit = rephraseAudit({ baseline, edited, factIndex })
  const by = new Map(audit.rows.map((r) => [r.id, r.status]))
  assert.equal(by.get("exp-acme-b2"), "rephrased")
  assert.equal(by.get("exp-acme-b1"), "dropped")
  assert.equal(by.get("prj-dash-b1"), "added")
  assert.equal(by.get("skill-lang"), "verbatim")
  assert.equal(audit.ok, true)
})

test("rephraseAudit refuses a citation the fact base does not know", () => {
  const baseline = assemble("node-backend").markdown
  const edited = baseline.replace("fact:skill-lang", "fact:skill-invented")
  const audit = rephraseAudit({ baseline, edited, factIndex })
  assert.equal(audit.ok, false)
  assert.equal(audit.counts["unknown-fact"], 1)
})

function cli(args) {
  return spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "documents", "assemble-resume.mjs"),
      ...args,
      "--profile",
      PROFILE,
      "--answers",
      ANSWERS,
    ],
    { cwd: ROOT, encoding: "utf8" },
  )
}

test("--audit-rephrase passes a truthful rephrase and fails an invented one", (t) => {
  const dir = workspace(t, "node-backend")
  const good = path.join(dir, "good.md")
  const bad = path.join(dir, "bad.md")
  const baseline = assemble("node-backend").markdown
  fs.writeFileSync(
    good,
    baseline.replace(
      "Reduced API latency by 42% by adding PostgreSQL query caching behind an Express service.",
      "Cut API latency 42% with PostgreSQL query caching behind an Express service.",
    ),
  )
  fs.writeFileSync(
    bad,
    baseline.replace(
      "Reduced API latency by 42%",
      "Reduced API latency by 91%",
    ),
  )

  const ok = cli([
    "node-backend",
    "--jobs-dir",
    dir,
    "--budget",
    String(GOLDEN_BUDGET),
    "--audit-rephrase",
    good,
  ])
  assert.equal(ok.status, 0, ok.stdout + ok.stderr)
  const okReport = JSON.parse(ok.stdout)
  assert.equal(okReport.ok, true)
  assert.equal(okReport.counts.rephrased, 1)

  const fail = cli([
    "node-backend",
    "--jobs-dir",
    dir,
    "--budget",
    String(GOLDEN_BUDGET),
    "--audit-rephrase",
    bad,
  ])
  assert.equal(fail.status, 1)
  const failReport = JSON.parse(fail.stdout)
  assert.equal(failReport.ok, false)
  assert.ok(
    failReport.verification.violations.some(
      (v) => v.rule === "R3" && v.detail.includes("91"),
    ),
    JSON.stringify(failReport.verification.violations),
  )
})

test("--audit-rephrase is refused on the unattended path", (t) => {
  const dir = workspace(t, "node-backend")
  const f = path.join(dir, "x.md")
  fs.writeFileSync(f, assemble("node-backend").markdown)
  const res = cli([
    "node-backend",
    "--jobs-dir",
    dir,
    "--audit-rephrase",
    f,
    "--unattended",
  ])
  assert.equal(res.status, 2)
  assert.match(res.stderr, /ATTENDED/)
})

// ---------------------------------------------------------------------------
// CLI: writing, refusing
// ---------------------------------------------------------------------------

test("the CLI writes resume.md and the selection record beside it", (t) => {
  const dir = workspace(t, "graphql-api")
  const res = cli([
    "graphql-api",
    "--jobs-dir",
    dir,
    "--budget",
    String(GOLDEN_BUDGET),
  ])
  assert.equal(res.status ?? 0, 0, res.stderr)
  const out = path.join(dir, "graphql-api", "resume.md")
  assert.equal(
    fs.readFileSync(out, "utf8"),
    fs.readFileSync(path.join(GOLDEN, "graphql-api.md"), "utf8"),
  )
  const sel = JSON.parse(
    fs.readFileSync(
      path.join(dir, "graphql-api", "resume-selection.json"),
      "utf8",
    ),
  )
  assert.equal(sel.slug, "graphql-api")
  assert.ok(sel.included.length > 5)
})

test("an unapproved fact base is refused, not tailored against", (t) => {
  const dir = workspace(t, "graphql-api")
  const p = path.join(dir, "unapproved.yaml")
  fs.writeFileSync(
    p,
    rawProfile.replace("approved_by_user: true", "approved_by_user: false"),
  )
  const res = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "documents", "assemble-resume.mjs"),
      "graphql-api",
      "--jobs-dir",
      dir,
      "--profile",
      p,
      "--answers",
      ANSWERS,
    ],
    { cwd: ROOT, encoding: "utf8" },
  )
  assert.equal(res.status, 2)
  assert.match(res.stderr, /approved_by_user/)
  assert.equal(fs.existsSync(path.join(dir, "graphql-api", "resume.md")), false)
})

test("usage errors exit 2", (t) => {
  const dir = workspace(t, "graphql-api")
  assert.equal(cli(["--jobs-dir", dir]).status, 2) // no slug
  assert.equal(cli(["nope", "--jobs-dir", dir]).status, 2) // no workspace
  assert.equal(
    cli(["graphql-api", "--jobs-dir", dir, "--budget", "0"]).status,
    2,
  )
  assert.equal(
    cli(["graphql-api", "--jobs-dir", dir, "--budget", "nope"]).status,
    2,
  )
})
