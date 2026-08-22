// Attachment slots (2026-08-18): the two shapes that deferred most of the
// 2026-08-17 live run for no document-related reason at all.
//
//   1. Ashby's résumé-autofill helper — a selector-less file input wearing the
//      next field's label ("Name") — was reported as an "unrecognised
//      attachment slot" on EVERY Ashby form. The adapter now recognises it and
//      buildPlan skips it, uploading nothing.
//   2. An OPTIONAL cover-letter slot with no cover letter rendered deferred the
//      whole application. It is now left empty, as a `skip` item that says so.
//
// And the taxonomy: "no rendered <doc>" is `doc-unrendered` (render-pdf is the
// fix), "unrecognised attachment slot" is `unknown-field` (an adapter is the
// fix). Neither is `doc-unverified` any more, which is about verification.
import test from "node:test"
import assert from "node:assert/strict"

import { buildPlan } from "../../scripts/apply/fill-plan.mjs"
import { kindForWhy, classifyPlanDefers } from "../../scripts/auto/taxonomy.mjs"
import ashby from "../../scripts/apply/ats/ashby.mjs"
import greenhouse from "../../scripts/apply/ats/greenhouse.mjs"

const RESUME = "C:\\jobs\\x\\resume.pdf"
const COVER = "C:\\jobs\\x\\cover-letter.pdf"

// The real Ashby shape, as scanned on Watershed 2026-08-08 (ids and labels
// verbatim; the phantom is f1).
const ashbyScan = () => ({
  url: "https://jobs.ashbyhq.com/watershed/abc/application",
  fields: [
    { k: "f1", t: "file", l: "Name", req: true },
    {
      k: "f2",
      sel: "#_systemfield_name",
      n: "_systemfield_name",
      t: "text",
      l: "Name",
      req: true,
    },
    { k: "f4", sel: "#_systemfield_resume", t: "file", l: "Resume", req: true },
    { k: "f6", sel: "#cover_letter", t: "file", l: "Cover Letter" },
  ],
})
const nameOk = {
  k: "f2",
  status: "OK",
  value: "X Y",
  sel: "#_systemfield_name",
}

test("ashby.helperFileInput recognises the autofill phantom and NOTHING else", () => {
  const s = ashbyScan()
  const [phantom, nameText, resume, cover] = s.fields
  assert.equal(ashby.helperFileInput(phantom, s), true)
  assert.equal(
    ashby.helperFileInput(resume, s),
    false,
    "a real slot has a selector",
  )
  assert.equal(ashby.helperFileInput(cover, s), false)
  assert.equal(ashby.helperFileInput(nameText, s), false, "not a file input")
  // Every clause is load-bearing: no borrowed label → not the phantom…
  assert.equal(
    ashby.helperFileInput({ k: "f9", t: "file", l: "Portfolio" }, s),
    false,
  )
  // …and no real résumé slot beside it → not safe to skip, so not the phantom.
  const alone = { url: s.url, fields: [phantom, nameText] }
  assert.equal(ashby.helperFileInput(phantom, alone), false)
})

test("the Ashby phantom is SKIPPED, uploads nothing, and the real résumé slot still gets the résumé", () => {
  const p = buildPlan({
    scan: ashbyScan(),
    resolved: [nameOk],
    adapter: ashby,
    files: { resume: RESUME },
  })
  const f1 = p.items.find((i) => i.k === "f1")
  assert.equal(f1.how, "skip")
  assert.match(f1.why, /helper file input/)
  const uploads = p.items.filter((i) => i.how === "upload")
  assert.equal(uploads.length, 1, "exactly one upload — the résumé")
  assert.equal(uploads[0].k, "f4")
  assert.deepEqual(uploads[0].paths, [RESUME])
  assert.deepEqual(
    p.defer.map((d) => d.k),
    [],
    "nothing deferred: not the phantom, and not the optional cover slot",
  )
})

test("an OPTIONAL cover-letter slot with no cover letter is left EMPTY — a skip item, not a defer", () => {
  const p = buildPlan({
    scan: ashbyScan(),
    resolved: [nameOk],
    adapter: ashby,
    files: { resume: RESUME },
  })
  const cover = p.items.find((i) => i.k === "f6")
  assert.equal(cover.how, "skip")
  assert.match(cover.why, /optional cover-letter slot left empty/)
})

test("a REQUIRED cover-letter slot with no cover letter still defers, and says it is required", () => {
  const s = ashbyScan()
  s.fields[3].req = true
  const p = buildPlan({
    scan: s,
    resolved: [nameOk],
    adapter: ashby,
    files: { resume: RESUME },
  })
  const d = p.defer.find((x) => x.k === "f6")
  assert.ok(d, "deferred")
  assert.equal(d.why, "no rendered cover")
  assert.equal(d.req, true)
})

test("a missing RÉSUMÉ always defers — the application IS the résumé, required flag or not", () => {
  const p = buildPlan({
    scan: ashbyScan(),
    resolved: [nameOk],
    adapter: ashby,
    files: {},
  })
  const d = p.defer.find((x) => x.k === "f4")
  assert.equal(d.why, "no rendered resume")
  assert.equal(p.items.filter((i) => i.how === "upload").length, 0)
})

test("when the cover letter IS rendered, both slots upload as before", () => {
  const p = buildPlan({
    scan: ashbyScan(),
    resolved: [nameOk],
    adapter: ashby,
    files: { resume: RESUME, cover: COVER },
  })
  const uploads = p.items
    .filter((i) => i.how === "upload")
    .map((i) => [i.k, i.paths[0]])
  assert.deepEqual(uploads, [
    ["f4", RESUME],
    ["f6", COVER],
  ])
})

test("Greenhouse's two 'Attach' inputs: résumé first by document order, an optional cover slot skipped, nothing deferred", () => {
  const scan = {
    url: "https://job-boards.greenhouse.io/x/jobs/1",
    fields: [
      { k: "f28", sel: "#resume", t: "file", l: "Attach" },
      { k: "f29", sel: "#cover_letter", t: "file", l: "Attach" },
    ],
  }
  const p = buildPlan({
    scan,
    resolved: [],
    adapter: greenhouse,
    files: { resume: RESUME },
  })
  const up = p.items.find((i) => i.how === "upload")
  assert.equal(up.k, "f28")
  assert.deepEqual(up.paths, [RESUME])
  assert.equal(p.items.find((i) => i.k === "f29").how, "skip")
  assert.deepEqual(p.defer, [])
})

test("a Greenhouse helper-less scan is untouched by the Ashby rule — the adapter that knows the shape decides", () => {
  // Greenhouse declares no helperFileInput; a selector-less file input there
  // is still an unrecognised slot when nothing identifies it.
  const scan = {
    url: "https://job-boards.greenhouse.io/x/jobs/1",
    fields: [
      { k: "f1", t: "file", l: "Name", req: true },
      { k: "f2", sel: "#first_name", t: "text", l: "Name", req: true },
      { k: "f3", sel: "#resume", t: "file", l: "Resume", req: true },
    ],
  }
  const p = buildPlan({
    scan,
    resolved: [{ k: "f2", status: "OK", value: "X", sel: "#first_name" }],
    adapter: greenhouse,
    files: { resume: RESUME },
  })
  const d = p.defer.find((x) => x.k === "f1")
  assert.equal(d.why, "unrecognised attachment slot")
})

// --- the taxonomy ----------------------------------------------------------------

test("'no rendered <doc>' is doc-unrendered and 'unrecognised attachment slot' is unknown-field — neither is doc-unverified", () => {
  assert.equal(kindForWhy("no rendered resume"), "doc-unrendered")
  assert.equal(kindForWhy("no rendered cover"), "doc-unrendered")
  assert.equal(kindForWhy("unrecognised attachment slot"), "unknown-field")
  const rec = classifyPlanDefers(
    [
      { k: "f4", label: "Resume", why: "no rendered resume" },
      { k: "f1", label: "Name", why: "unrecognised attachment slot" },
    ],
    { stage: "plan" },
  )
  // Policy tier outranks the understanding tier in DEFER_PRIORITY.
  assert.equal(rec.kind, "doc-unrendered")
  assert.match(rec.detail, /also unknown-field/)
})
