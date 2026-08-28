// A FILE INPUT CAN BE A VERB.
//
// THE DEFECT (Oracle Recruiting Cloud, Caesars job/87550, observed 2026-08-04).
// adapter.fileFields matches `resume|\bcv\b` against a field's label, and
// Oracle renders a control labelled "Import your profile from resume" that is
// an input[type=file] with no id and no name. It matched. `report.uploads` came
// back with THREE entries — the import control, "Upload Resume" and "Upload
// Cover Letter" — all `attached: true`, and the run reported success.
//
// What the third upload actually did: it fired Oracle's résumé PARSER. The page
// answered "Profile successfully imported.", wrote the Experience and Education
// sections from the PDF's text, and remounted the form, invalidating every
// data-aj stamp mid-run. The Education row it wrote was wrong — "University of
// Nevada" for "University of Nevada, Las Vegas", the Mathematics degree dropped,
// "Fields to fix: 1".
//
// WHY THIS FILE ASSERTS A RULE 1 PROPERTY AND NOT A TIDINESS ONE. The wrong
// Education row is the symptom that got noticed; it is not the defect. The
// defect is that firing an import control puts PARSER-DERIVED TEXT into the
// application under the user's name — text produced by the employer's own code
// re-reading a PDF, which never came from profile/ and which the fact base
// never approved. A run where the parser happened to get every field right
// would be exactly as disallowed. So the assertions below are about WHICH
// CONTROL IS TOUCHED, never about the quality of what a parser produces.
//
// Run: node --test tests/apply/upload-import-control.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  buildPlan,
  resolveFields,
  readiness,
  isProfileImportControl,
  isUninformativeFileLabel,
} from "../../scripts/apply/fill-plan.mjs"
import { detectAts } from "../../scripts/apply/ats/index.mjs"
import fillPage from "../../scripts/apply/fill-engine.mjs"
import { start } from "../fixtures/boards/server.mjs"
import { runScanner } from "../fixtures/boards/dom.mjs"
import { recordingPage } from "../security/engine-double.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..", "..")
const PROFILE = path.join(ROOT, "tests/fixtures/profile.yaml")
const ANSWERS = path.join(ROOT, "tests/fixtures/answers-bank.yaml")

// Real paths. buildPlan does not stat them, but a fixture pointing at a file
// that does not exist would be claiming an upload it could not perform.
const FILES = {
  resume: path.join(ROOT, "tests/fixtures/boards/docs/resume.md"),
  cover: path.join(ROOT, "tests/fixtures/boards/docs/cover-letter.md"),
}

let board
let scan
let url
test.before(async () => {
  board = await start()
  url = board.pageUrl("oracle-import-parse")
  scan = await runScanner(await (await fetch(url)).text(), { url })
})
test.after(async () => {
  await board?.stop()
})

// The whole path, run end to end: served page -> real scanner -> real adapter
// detection -> resolveFields -> buildPlan -> the real fill engine.
function drive() {
  const adapter = detectAts(url)
  const resolved = resolveFields(scan.fields, {
    profile: PROFILE,
    answers: ANSWERS,
  })
  const plan = buildPlan({ scan, resolved, adapter, url, files: FILES })
  return { adapter, plan }
}

test("the fixture still reproduces the live page: an unidentifiable file input labelled 'Import your profile from resume', rendered FIRST", () => {
  // GUARDS THE FIXTURE AGAINST ITSELF. Every assertion below is only evidence
  // about the real Oracle page for as long as the fixture keeps the three
  // traits the live scan showed. Giving the import control an id, or moving it
  // below the attachment section, would leave the tests green while quietly
  // removing what they test.
  const files = scan.fields.filter((f) => f.t === "file")
  assert.deepEqual(
    files.map((f) => [f.l, f.sel ?? null]),
    [
      // No `sel`: no id, no name. The label is the ONLY signal there is —
      // which is why the fix cannot lean on field identity.
      ["Import your profile from resume", null],
      ["Upload Resume *", "#resume-file"],
      ["Upload Cover Letter", "#cover-file"],
    ],
    "the fixture stopped matching the live Oracle shape. Do NOT fix a failure " +
      "here by relabelling the fixture — it is the record of what was scanned",
  )
})

test("the import control is planned as a skip, and exactly one upload targets the real resume slot", () => {
  const { adapter, plan } = drive()
  assert.equal(adapter.id, "generic", "Oracle has no adapter of its own")

  // THE HEADLINE ASSERTION, as one deepEqual so a change that buys a passing
  // count by dropping a real attachment cannot slip through. Pre-fix this list
  // had three rows and the first was `how: "upload"` carrying resume.md.
  assert.deepEqual(
    plan.items
      .filter((i) => i.how === "upload" || i.how === "skip")
      .map((i) => [i.k, i.how, i.label, i.paths?.map((p) => path.basename(p))]),
    [
      ["f1", "skip", "Import your profile from resume", undefined],
      ["f6", "upload", "Upload Resume *", ["resume.md"]],
      ["f7", "upload", "Upload Cover Letter", ["cover-letter.md"]],
    ],
  )

  // Said the other way round, because "exactly one resume entry" is the
  // property the bug report names and a reader should not have to derive it.
  const resumeUploads = plan.items.filter(
    (i) => i.how === "upload" && i.paths?.some((p) => /resume/.test(p)),
  )
  assert.equal(resumeUploads.length, 1)
  assert.equal(resumeUploads[0].k, "f6")

  // A skip is not a defer: the control needs no human answer, it simply must
  // never be actuated. Deferring it would block every Oracle application on a
  // question nobody can answer.
  assert.deepEqual(plan.defer, [])
  assert.deepEqual(readiness(plan), { ready: true, reason: null })
})

test("report.uploads contains exactly one resume entry, and it is the attachment field", async () => {
  // THE ASSERTION AT THE LAYER THE BUG WAS OBSERVED AT. The plan above is what
  // is intended; `report.uploads` is what the engine did. The live run's three
  // `attached: true` rows were read off this structure, so this is where a
  // regression would be seen again.
  const { plan } = drive()
  const page = recordingPage({ url: plan.urlGuard })
  const report = await fillPage(page, plan)

  assert.deepEqual(
    report.uploads.map((u) => ({
      file: path.basename(u.file ?? u.paths?.[0] ?? ""),
      attached: u.attached,
    })),
    [
      { file: "resume.md", attached: true },
      { file: "cover-letter.md", attached: true },
    ],
    "report.uploads changed shape or count — three entries here is the " +
      "original defect, and the extra one fires the board's resume parser",
  )
  assert.deepEqual(report.failures, [])

  // And nothing was uploaded to an input the page did not identify as a slot.
  assert.equal(
    report.uploads.filter((u) => /import|parse/i.test(String(u.label ?? "")))
      .length,
    0,
  )
})

test("the exclusion also survives uninformative labels: an import control never consumes a document-order slot", () => {
  // THE OTHER HALF OF THE FIX, which the Oracle page itself cannot show.
  //
  // Oracle labels its real slots "Upload Resume" / "Upload Cover Letter", so
  // adapter.fileFields matches them by LABEL and document order never runs. On
  // a board that labels attachment inputs "Attach" — Greenhouse's older UI, and
  // the reason adapter.fileOrder exists at all — the doc-order fallback decides
  // instead, and then an import control that merely failed the label match
  // would still be handed slot 0 (the résumé). Worse, if it were skipped but
  // still advanced `fileIndex`, the REAL résumé field would be offered slot 1
  // and would receive the COVER LETTER — a mix-up with no error anywhere.
  //
  // Hand-built rather than a second fixture page: the point is the interaction
  // between the skip and `fileIndex`, and a scan is the smallest thing that
  // exercises it.
  const hand = {
    url: "https://board.test/apply",
    fields: [
      { k: "f1", t: "file", l: "Import your profile from resume" },
      { k: "f2", t: "file", l: "Attach", sel: "#a1", req: true },
      { k: "f3", t: "file", l: "Attach", sel: "#a2" },
    ],
  }
  const adapter = detectAts(hand.url)
  const plan = buildPlan({
    scan: hand,
    resolved: resolveFields(hand.fields, {
      profile: PROFILE,
      answers: ANSWERS,
    }),
    adapter,
    url: hand.url,
    files: FILES,
  })

  assert.deepEqual(
    plan.items.map((i) => [
      i.k,
      i.how,
      i.paths?.map((p) => path.basename(p)) ?? null,
    ]),
    [
      ["f1", "skip", null],
      // Slot 0 and slot 1, in document order, unshifted by the skipped control.
      ["f2", "upload", ["resume.md"]],
      ["f3", "upload", ["cover-letter.md"]],
    ],
    "an import control consumed a document-order file slot: the real resume " +
      "field has been shifted onto the cover-letter slot",
  )
})

test("isProfileImportControl matches import/parse verbs and leaves ordinary attachment labels alone", () => {
  // The predicate's own surface, listed rather than sampled, so widening it
  // later is a visible edit here and not a silent behaviour change. Both
  // columns matter: a false positive costs the user an unattached résumé,
  // which is quieter than the bug being fixed.
  const IMPORT = [
    "Import your profile from resume",
    "Import from LinkedIn",
    "Parse my resume",
    "Autofill with resume",
    "Fill in the form from your CV",
    "Fill out application from resume",
    "Populate profile from resume",
  ]
  const ATTACHMENT = [
    "Upload Resume",
    "Resume/CV *",
    "Attach",
    "Cover Letter",
    "Upload Cover Letter",
    "Resume",
    "CV",
    // Not an import verb, and it must not become one: this is a real
    // attachment slot on boards that ask for a portfolio.
    "Upload supporting documents",
  ]
  assert.deepEqual(
    {
      matched: IMPORT.filter(isProfileImportControl),
      wronglyMatched: ATTACHMENT.filter(isProfileImportControl),
    },
    { matched: IMPORT, wronglyMatched: [] },
  )

  // Empty and absent labels are NOT import controls. An unlabelled file input
  // is exactly the case the fix cannot see, and it must keep falling through
  // to the document-order fallback rather than being silently skipped — a
  // skipped attachment slot means no résumé is sent at all.
  for (const empty of ["", "   ", null, undefined]) {
    assert.equal(isProfileImportControl(empty), false)
  }
})

// ---------------------------------------------------------------------------
// A FILE INPUT CAN ALSO BE A SLOT NOBODY NAMED.
//
// THE DEFECT (Ashby, jobs.ashbyhq.com, three live Render applications,
// 2026-08-06). Those forms render THREE file inputs. The first is labelled
// "Name", carries no id and no name, and matches neither `resume|\bcv\b` nor
// `cover letter`. It is not an import control either — `isProfileImportControl`
// looks for a VERB and "Name" has none — so it fell through to the document
// order fallback, took `fileOrder[0]`, and was planned the résumé.
//
// The résumé was therefore planned TWICE: two upload items carrying the same
// document with the same `labelMatch`. Downstream the engine cannot tell the
// two apart, so on the three-input shape it refused every upload on the form,
// and on the two-input variant of the same shape it attached the résumé to the
// phantom and reported ok.
//
// The rule this pins: the doc-order fallback resolves an UNINFORMATIVE label,
// never merely an unmatched one. A label with real words in it that no spec
// matches is a slot the adapter does not know, and an unknown slot defers.
// ---------------------------------------------------------------------------
const planFor = (fields, url = "https://jobs.ashbyhq.com/acme/abc") => {
  const hand = { url, fields }
  return buildPlan({
    scan: hand,
    resolved: resolveFields(fields, { profile: PROFILE, answers: ANSWERS }),
    adapter: detectAts(url),
    url,
    files: FILES,
  })
}

test("an unrecognised file slot is never handed the resume by document order", () => {
  // The live Render/Ashby shape, field-for-field.
  const plan = planFor([
    { k: "f3", t: "file", l: "Name", req: true },
    {
      k: "f10",
      t: "file",
      l: "Resume",
      sel: "#_systemfield_resume",
      req: true,
    },
    { k: "f11", t: "file", l: "Cover Letter", sel: "#cover" },
  ])
  const uploads = plan.items.filter((i) => i.how === "upload")
  assert.deepEqual(
    uploads.map((i) => [i.k, i.paths.map((p) => path.basename(p))]),
    [
      ["f10", ["resume.md"]],
      ["f11", ["cover-letter.md"]],
    ],
    "the phantom slot was planned an attachment",
  )
  // The résumé is planned exactly ONCE. This is the assertion that would have
  // caught the live defect: pre-fix this count was 2.
  assert.equal(
    uploads.filter((i) => i.paths.some((p) => path.basename(p) === "resume.md"))
      .length,
    1,
    "the resume was planned more than once",
  )
  // And the unknown slot is reported, not silently dropped.
  assert.ok(
    plan.defer.some((d) => d.k === "f3"),
    "the unrecognised slot vanished instead of deferring",
  )
})

test("an unrecognised file slot does not consume a document-order position", () => {
  // The mirror-image half, the same one the import-control skip needs. If the
  // phantom advanced `fileIndex`, the real "Attach" after it would be offered
  // slot 1 and would receive the COVER LETTER with the resume never attached.
  const plan = planFor([
    { k: "f1", t: "file", l: "Name" },
    { k: "f2", t: "file", l: "Attach", sel: "#a1", req: true },
    { k: "f3", t: "file", l: "Attach", sel: "#a2" },
  ])
  assert.deepEqual(
    plan.items
      .filter((i) => i.how === "upload")
      .map((i) => [i.k, i.paths.map((p) => path.basename(p))]),
    [
      ["f2", ["resume.md"]],
      ["f3", ["cover-letter.md"]],
    ],
    "an unrecognised slot shifted the real attachment slots",
  )
})

test("BOUNDARY: two uninformative 'Attach' inputs still route by document order", () => {
  // The behaviour the fallback exists for, unchanged. A fix that bought its
  // correctness by disabling document order would break every Greenhouse form.
  const plan = planFor([
    { k: "f1", t: "file", l: "Attach", sel: "#a1", req: true },
    { k: "f2", t: "file", l: "Attach", sel: "#a2" },
  ])
  assert.deepEqual(
    plan.items
      .filter((i) => i.how === "upload")
      .map((i) => i.paths.map((p) => path.basename(p))),
    [["resume.md"], ["cover-letter.md"]],
  )
})

test("isUninformativeFileLabel: the vocabulary, listed rather than sampled", () => {
  // Widening this is a visible edit here. Both columns matter — a false
  // POSITIVE re-opens the defect above, a false NEGATIVE costs a Greenhouse
  // user an unattached résumé.
  for (const l of [
    "",
    "   ",
    "Attach",
    "Attach file",
    "Upload",
    "Upload a file",
    "Choose file",
    "Add file",
    "Drag and drop your file here",
    "Select a document",
    "Attachment (optional)",
    "File",
    "PDF or DOCX",
  ]) {
    assert.equal(isUninformativeFileLabel(l), true, `"${l}" read as evidence`)
  }
  for (const l of [
    "Name",
    "Legal Name",
    "Portfolio",
    "Transcript",
    "Writing sample",
    "References",
    "Photo",
    "Resume",
    "Cover Letter",
  ]) {
    assert.equal(
      isUninformativeFileLabel(l),
      false,
      `"${l}" read as carrying no evidence`,
    )
  }
})
