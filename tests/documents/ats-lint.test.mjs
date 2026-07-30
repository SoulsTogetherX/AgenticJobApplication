// ats-lint exists to catch two regressions that are invisible on the rendered
// page and fatal to an ATS: CSS ::marker bullets that emit no text, and links
// whose URL lives only in a PDF annotation. Both were real bugs. These tests
// mostly assert that the linter still fails when they come back.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  lintMarkdown,
  lintHtml,
  lintPdf,
  checkCoverage,
} from "../../scripts/documents/ats-lint.mjs"

// render-pdf.mjs validates its argv at module top level and process.exit(2)s
// when there is none, so it cannot be imported — the existing render-pdf test
// spawns it for the same reason. The end-to-end test at the bottom of this file
// runs the real renderer through a subprocess instead, which is a stronger
// check than importing atsPostProcess would have been: it proves what Chrome
// actually receives, not just what one function returns.
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

// What atsPostProcess is contracted to produce.
const POST_PROCESSED_LI = '<ul><li><span class="bullet">• </span>one</li></ul>'
const POST_PROCESSED_LINK =
  '<a href="https://github.com/xalva">github.com/xalva</a>'

const GOOD_MD = [
  "# Xavier Alvarez",
  "",
  "test@example.com | 555-1234",
  "",
  "## SUMMARY",
  "Full-Stack Developer.",
  "",
  "## EXPERIENCE",
  "",
  "- Built things <!-- fact:a -->",
  "",
  "## TECHNICAL SKILLS",
  "React, Node.js",
  "",
  "## EDUCATION",
  "State University",
].join("\n")

test("a well-formed resume passes the markdown checks", () => {
  const r = lintMarkdown(GOOD_MD)
  assert.deepEqual(r.problems, [])
  assert.deepEqual(r.warnings, [])
  assert.equal(r.bullets, 1)
})

test("a table is a problem, not a warning", () => {
  const r = lintMarkdown(GOOD_MD + "\n\n| Skill | Years |\n| --- | --- |\n")
  assert.ok(r.problems.some((p) => /table/.test(p)))
})

test("HTML table markup is caught too", () => {
  const r = lintMarkdown(GOOD_MD + "\n<table><tr><td>x</td></tr></table>")
  assert.ok(r.problems.some((p) => /table/.test(p)))
})

test("an image is a problem — no text comes out of it", () => {
  const r = lintMarkdown(GOOD_MD + '\n<img src="me.png">')
  assert.ok(r.problems.some((p) => /image/.test(p)))
})

test("a missing email is a problem", () => {
  const r = lintMarkdown(GOOD_MD.replace("test@example.com | ", ""))
  assert.ok(r.problems.some((p) => /email/.test(p)))
})

test("non-standard section headings warn but do not fail", () => {
  const r = lintMarkdown(GOOD_MD.replace("## EXPERIENCE", "## Where I've Been"))
  assert.deepEqual(r.problems, [])
  assert.ok(r.warnings.some((w) => /EXPERIENCE/.test(w)))
})

// --- the two real regressions -----------------------------------------------

test("list items with no literal bullet text are caught", () => {
  // The bug: Chrome draws CSS ::marker discs without emitting any text, so a
  // role's title, dates and every bullet under it extracted as ONE line.
  const raw = "<ul><li>one</li><li>two</li></ul>"
  const r = lintHtml(raw)
  assert.ok(
    r.problems.some((p) => /literal bullet/.test(p)),
    "must fail when atsPostProcess has not run",
  )
})

test("post-processed list items pass the bullet check", () => {
  const r = lintHtml(POST_PROCESSED_LI)
  assert.deepEqual(r.problems, [])
  assert.equal(r.bullet_marks, 1)
  assert.equal(r.list_items, 1)
})

test("a link that hides its URL is caught", () => {
  // "LinkedIn" as link text hands the parser no address at all: hrefs live only
  // in PDF link annotations.
  const r = lintHtml('<a href="https://github.com/xalva">GitHub</a>')
  assert.ok(r.problems.some((p) => /hides its URL/.test(p)))
})

test("a link showing its address passes the link check", () => {
  assert.deepEqual(lintHtml(POST_PROCESSED_LINK).problems, [])
})

test("leaked fact annotations are caught", () => {
  const r = lintHtml("<p>Built things <!-- fact:a --></p>")
  assert.ok(r.problems.some((p) => /fact annotations/.test(p)))
})

test("html with no lists is fine rather than failing", () => {
  assert.deepEqual(lintHtml("<p>hello</p>").problems, [])
})

// --- pdf structure -----------------------------------------------------------

test("a PDF with fonts and pages is accepted as text-based", () => {
  const fake = Buffer.from(
    "%PDF-1.4\n/Type /Page\n/Font <</F1 1 0 R>>\n",
    "latin1",
  )
  assert.deepEqual(lintPdf(fake).problems, [])
})

test("a PDF with no fonts has no extractable text", () => {
  const fake = Buffer.from("%PDF-1.4\n/Type /Page\n", "latin1")
  assert.ok(lintPdf(fake).problems.some((p) => /no extractable text/.test(p)))
})

test("an image-only PDF is caught", () => {
  const fake = Buffer.from("%PDF-1.4\n/Type /Page\n/Subtype /Image\n", "latin1")
  assert.ok(
    lintPdf(fake).problems.some((p) => /image-only|no extractable/.test(p)),
  )
})

test("a non-PDF is reported rather than crashing", () => {
  assert.ok(lintPdf(Buffer.from("hello")).problems.includes("not a PDF"))
})

// --- coverage ----------------------------------------------------------------

test("coverage counts a term placed via any of its ATS forms", () => {
  const plan = {
    must_use: [
      { skill: "CI/CD", ats_forms: ["CI/CD", "continuous integration"] },
      { skill: "Docker", ats_forms: ["Docker"] },
    ],
  }
  const c = checkCoverage("We ran continuous integration daily.", plan)
  assert.equal(c.placed, 1)
  assert.deepEqual(c.missing, ["Docker"])
})

test("no plan means no coverage section", () => {
  assert.equal(checkCoverage("x", null), null)
  assert.equal(checkCoverage("x", { must_use: [] }), null)
})

// --- end to end --------------------------------------------------------------

// The check that actually matters: run the REAL renderer and lint what it
// produces. Everything above tests the linter against hand-written HTML; this
// tests the linter against Chrome's actual input, so a regression in
// atsPostProcess or document.css fails here rather than silently shipping.
test("a real rendered resume passes the linter", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atslint-"))
  const md = path.join(dir, "resume.md")
  fs.writeFileSync(
    md,
    [
      "# Xavier Alvarez",
      "",
      "test@example.com | [GitHub](https://github.com/example)",
      "",
      "## SUMMARY",
      "",
      "Full-Stack Developer.",
      "",
      "## EXPERIENCE",
      "",
      "- Built web applications <!-- fact:a -->",
      "- Shipped services <!-- fact:b -->",
      "",
      "## TECHNICAL SKILLS",
      "",
      "React, Node.js",
      "",
      "## EDUCATION",
      "",
      "State University",
    ].join("\n"),
  )
  const pdf = path.join(dir, "resume.pdf")
  const render = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "documents", "render-pdf.mjs"), md, pdf],
    { cwd: ROOT, encoding: "utf8", timeout: 90_000 },
  )
  if (render.status === 3) {
    // No Edge/Chrome on this machine — the same skip the render-pdf test uses.
    return t.skip("no browser available to render a PDF")
  }
  assert.equal(render.status, 0, render.stderr)

  const lint = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "documents", "ats-lint.mjs"),
      md,
      "--pdf",
      pdf,
      "--json",
    ],
    { cwd: ROOT, encoding: "utf8" },
  )
  const report = JSON.parse(lint.stdout)
  assert.equal(
    report.ok,
    true,
    `real render failed the ATS lint: ${JSON.stringify(report.results)}`,
  )
  // The two regressions, proven against real output.
  assert.equal(
    report.results.html.bullet_marks,
    report.results.html.list_items,
    "every bullet must carry literal text in the render",
  )
  assert.deepEqual(
    report.results.pdf.problems,
    [],
    "PDF must have a text layer",
  )
})
