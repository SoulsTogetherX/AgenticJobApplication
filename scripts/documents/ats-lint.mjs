#!/usr/bin/env node
// Will an ATS actually be able to read this resume?
//
// The user chose PDF-only (2026-07-29) over adding a DOCX renderer, which makes
// the PDF's text layer the single point of failure for every application. Two
// things already went wrong there once, and both are invisible when you look at
// the rendered page:
//
//   * CSS ::marker bullets. Chrome draws them without emitting any text, so a
//     role's title, dates and every bullet under it extracted as ONE line.
//   * Link hrefs. They live only in PDF link annotations, so a resume showing
//     "LinkedIn | GitHub" handed the parser no URL at all.
//
// atsPostProcess() in render-pdf.mjs fixes both by putting real text into the
// document. This turns that fix into something checkable instead of a comment
// that a future edit can quietly break.
//
// WHAT THIS CHECKS, HONESTLY: the markdown and the intermediate .render.html —
// which is the exact input Chrome turns into the PDF — plus a structural check
// that the PDF is text-based rather than an image. It does NOT decode the PDF
// text layer itself: Chrome subsets fonts with Identity-H encoding, so reading
// that back needs a CMap parser and a PDF library this project deliberately
// does not have. Every hazard below is a property of the input, so checking the
// input catches them; a font-level regression inside Chrome would not be caught.
//
// Usage:
//   node scripts/documents/ats-lint.mjs <resume.md> [--html <f.render.html>]
//        [--pdf <f.pdf>] [--plan jobs/<slug>/keywords.json] [--json]
// Exit: 0 clean (warnings allowed), 1 problems found, 2 usage error.
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { isTerse } from "../lib/lib.mjs"
import { techTermsIn } from "../lib/lib.mjs"
import { checkWrittenForm } from "../lib/keywords.mjs"

function flag(args, name, fallback = null) {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

// Standard headings. A parser segments a resume by these; inventing creative
// ones ("Where I've Been") is a common way to lose an entire work history.
const EXPECTED_SECTIONS = [
  { name: "SUMMARY", re: /^#+\s*(summary|profile|objective)\b/im },
  { name: "EXPERIENCE", re: /^#+\s*(experience|employment|work history)\b/im },
  { name: "SKILLS", re: /^#+\s*(technical\s+)?skills\b/im },
  { name: "EDUCATION", re: /^#+\s*education\b/im },
]

// Pure core (exported for tests).
export function lintMarkdown(md) {
  const problems = []
  const warnings = []

  for (const s of EXPECTED_SECTIONS) {
    if (!s.re.test(md)) {
      warnings.push(
        `no standard "${s.name}" heading — parsers segment on these`,
      )
    }
  }

  // Tables and multi-column layouts are the single most reliable way to scramble
  // extraction order across every ATS tested.
  if (/^\s*\|.*\|\s*$/m.test(md)) {
    problems.push("markdown table found — tables reorder text in extraction")
  }
  if (/<(table|td|tr|th)\b/i.test(md)) {
    problems.push("HTML table markup found — same problem as a markdown table")
  }
  if (/<img\b/i.test(md)) {
    problems.push("image found — an ATS reads no text out of an image")
  }

  // Contact details must be real text, not a graphic or a bare link label.
  if (!/[\w.+-]+@[\w-]+\.[\w.]+/.test(md)) {
    problems.push("no email address in the document text")
  }

  const bullets = md.split(/\r?\n/).filter((l) => /^\s*[-*]\s+/.test(l))
  if (!bullets.length) warnings.push("no bullet lines found")

  // Written form. These are WARNINGS, never problems: writing "Javascript" is
  // careless, not untruthful, and this file's problems list is reserved for
  // things that cost the reader the content entirely.
  const form = checkWrittenForm(md)
  for (const f of form) {
    warnings.push(
      f.issue === "noncanonical_spelling"
        ? `"${f.found}" should be written "${f.prefer}" — ${f.note}`
        : `"${f.found}" appears without its partner form; write "${f.prefer}" once — ${f.note}`,
    )
  }

  return { problems, warnings, bullets: bullets.length, written_form: form }
}

export function lintHtml(html) {
  const problems = []
  const warnings = []

  // atsPostProcess injects a literal "• " span into every <li>, because Chrome
  // does not emit CSS ::marker glyphs into the PDF text layer. Without it a
  // whole role extracts as one merged line.
  const lis = (html.match(/<li>/g) ?? []).length
  const marks = (html.match(/<span class="bullet">/g) ?? []).length
  if (lis && marks < lis) {
    problems.push(
      `${lis - marks} of ${lis} list items have no literal bullet text — ` +
        "CSS ::marker glyphs never reach the PDF text layer (see atsPostProcess)",
    )
  }

  // Link hrefs live only in PDF annotations. A link whose visible text is
  // "GitHub" gives the parser no URL at all.
  for (const m of html.matchAll(
    /<a href="(https?:\/\/[^"]+)"[^>]*>([^<]*)<\/a>/g,
  )) {
    const bare = m[1]
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/$/, "")
    if (!m[2].toLowerCase().includes(bare.slice(0, 12).toLowerCase())) {
      problems.push(`link "${m[2]}" hides its URL — an ATS extracts no address`)
    }
  }

  // Fact annotations are for the verifier, never for the reader.
  if (/<!--\s*fact:/.test(html)) {
    problems.push("fact annotations leaked into the rendered HTML")
  }

  // Multi-column layout in the rendered output.
  if (/<table\b/i.test(html)) {
    problems.push("table in rendered HTML — extraction order is not guaranteed")
  }
  if (/column-count|display:\s*grid|display:\s*flex/i.test(html)) {
    warnings.push("multi-column CSS detected — verify extraction order by hand")
  }

  return { problems, warnings, list_items: lis, bullet_marks: marks }
}

// Structural check only: is there a text layer at all, or is this a picture of
// a resume? Fonts present + text-showing operators means real text.
export function lintPdf(buf) {
  const problems = []
  const s = buf.toString("latin1")
  if (!/^%PDF-/.test(s)) {
    problems.push("not a PDF")
    return { problems, warnings: [] }
  }
  const warnings = []
  if (!/\/Font\b/.test(s)) {
    problems.push("no font objects — the PDF has no extractable text layer")
  }
  if (!/\/Type\s*\/Page\b/.test(s)) warnings.push("no page objects found")
  // A resume that is one big image.
  if (/\/Subtype\s*\/Image/.test(s) && !/\/Font\b/.test(s)) {
    problems.push("image-only PDF — an ATS will read nothing")
  }
  return { problems, warnings, bytes: buf.length }
}

export function checkCoverage(md, plan) {
  if (!plan?.must_use?.length) return null
  const terms = new Set(techTermsIn(md))
  const missing = plan.must_use.filter(
    (m) =>
      !terms.has(m.skill) &&
      !(m.ats_forms ?? []).some((f) =>
        new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(md),
      ),
  )
  return {
    must_use: plan.must_use.length,
    placed: plan.must_use.length - missing.length,
    missing: missing.map((m) => m.skill),
  }
}

function main() {
  const args = process.argv.slice(2)
  const mdPath = args.find((a) => !a.startsWith("--"))
  if (!mdPath) {
    console.error(
      "usage: ats-lint.mjs <resume.md> [--html <f.render.html>] [--pdf <f.pdf>] [--plan <keywords.json>] [--json]",
    )
    process.exit(2)
  }
  if (!fs.existsSync(mdPath)) {
    console.error(`no such file: ${mdPath}`)
    process.exit(2)
  }

  const md = fs.readFileSync(mdPath, "utf8")
  const results = { markdown: lintMarkdown(md) }

  // Default to the .render.html render-pdf.mjs leaves beside the PDF.
  let htmlPath = flag(args, "--html")
  if (!htmlPath) {
    const guess = path.join(
      path.dirname(mdPath),
      path.basename(mdPath, ".md") + ".render.html",
    )
    if (fs.existsSync(guess)) htmlPath = guess
  }
  if (htmlPath && fs.existsSync(htmlPath)) {
    results.html = lintHtml(fs.readFileSync(htmlPath, "utf8"))
  }

  const pdfPath = flag(args, "--pdf")
  if (pdfPath && fs.existsSync(pdfPath)) {
    results.pdf = lintPdf(fs.readFileSync(pdfPath))
  }

  let planPath = flag(args, "--plan")
  if (!planPath) {
    const guess = path.join(path.dirname(mdPath), "keywords.json")
    if (fs.existsSync(guess)) planPath = guess
  }
  if (planPath && fs.existsSync(planPath)) {
    try {
      results.coverage = checkCoverage(
        md,
        JSON.parse(fs.readFileSync(planPath, "utf8")),
      )
    } catch {}
  }

  const problems = Object.values(results).flatMap((r) => r?.problems ?? [])
  const warnings = Object.values(results).flatMap((r) => r?.warnings ?? [])

  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: !problems.length, results }, null, 2))
    process.exit(problems.length ? 1 : 0)
  }

  if (isTerse()) {
    for (const p of problems) console.log(`PROBLEM|${p}`)
    for (const w of warnings) console.log(`warn|${w}`)
    const c = results.coverage
    console.log(
      `ok=${!problems.length} problems=${problems.length} warnings=${warnings.length}` +
        (c ? ` keywords=${c.placed}/${c.must_use}` : "") +
        (results.html
          ? ` bullets=${results.html.bullet_marks}/${results.html.list_items}`
          : "") +
        (results.pdf
          ? ` pdf_text_layer=${results.pdf.problems.length ? "no" : "yes"}`
          : ""),
    )
    process.exit(problems.length ? 1 : 0)
  }

  console.log(`\nATS readability check — ${mdPath}\n`)
  if (problems.length) {
    console.log("PROBLEMS (an ATS will lose or scramble this):")
    for (const p of problems) console.log(`  - ${p}`)
  } else {
    console.log("No structural problems found.")
  }
  if (warnings.length) {
    console.log("\nWorth a look:")
    for (const w of warnings) console.log(`  - ${w}`)
  }
  if (results.coverage) {
    const c = results.coverage
    console.log(
      `\nKeywords placed: ${c.placed}/${c.must_use}` +
        (c.missing.length ? ` — missing: ${c.missing.join(", ")}` : ""),
    )
  }
  if (!results.html) {
    console.log(
      "\nNote: no .render.html found, so the bullet and link checks did not run." +
        "\nRender the PDF first, or pass --html.",
    )
  }
  process.exit(problems.length ? 1 : 0)
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) main()
