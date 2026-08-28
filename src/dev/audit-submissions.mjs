#!/usr/bin/env node
// AUDIT — did the clicks this repo recorded as submissions actually submit?
//
// Usage: node src/dev/audit-submissions.mjs [--json]
//
// WHY THIS EXISTS. Every live click this pipeline has made classified
// `unclassified`, and not one carries a confirmation_url. That is consistent
// with two very different worlds: the boards confirmed and the classifier
// could not read them, or the submits never completed. On 2026-08-24 one
// staged capture settled it for one job — the post-click page for the Eliza
// click is the APPLICATION FORM, unchanged: "Submit Application" still
// present, no success wording. So at least one recorded submission sent
// nothing, and the follow-up queue is acting on it.
//
// Following up on a job you never applied to is a real cost, which is why
// this runs before any follow-up rather than after.
//
// WHAT IT WILL NOT DO. It does not touch the ledger. A staged capture is a
// CANDIDATE, not evidence — the same rule that governs promotion into the
// classifier's corpus (classify.mjs, `evidence.source === "capture"`). A page
// that looks like a confirmation to a regex is exactly the thing that must not
// silently mark an application real, because the failure is unrecoverable in
// the one direction that matters: a page misread as a confirmation records an
// application that was never sent, and nothing later corrects it.
//
// So the output is a table for a human, with an explicit `needs inbox check`
// column. The owner's confirmation emails are the only authority here, and
// corrections go through `applications.mjs remove <slug> --confirm`, which is
// hard rule 2's sanctioned path: removal corrects a mistake, never rewrites
// history.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { openDb } from "../lib/db.mjs"
import { positionals } from "../lib/args.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const STAGE_DIR = path.join(ROOT, "jobs", ".auto", "post-submit")

// THE TEST, and it is deliberately the crude one. A confirmation page has
// stopped offering the submit. This is not a classifier and must never grow
// into one — `src/auto/classify.mjs` owns that, bounded by captured
// evidence per host. Here the only job is to sort pages into "obviously still
// the form" and "everything else a human should look at".
//
// The asymmetry is on purpose: STILL-A-FORM is a confident negative (the page
// is asking to be submitted, so it was not), while anything else is reported
// as UNCLEAR rather than as a confirmation. There is no verdict in this file
// that says an application definitely landed.
const SUBMIT_RE =
  /submit\s+application|submit\s+your\s+application|\bapply\s+now\b|<button[^>]*>\s*submit\b/i
const SUCCESS_RE =
  /application\s+success|thank(s| you)[^.<]{0,40}(apply|application|submission)|we(?:'ve| have)\s+received\s+your\s+application|successfully\s+submitted/i

function verdictFor(html) {
  const submit = SUBMIT_RE.test(html)
  const success = SUCCESS_RE.test(html)
  if (submit && !success) return "STILL-A-FORM"
  if (success && !submit) return "looks-confirmed"
  if (success && submit) return "UNCLEAR (both markers)"
  return "UNCLEAR (neither marker)"
}

function loadCaptures() {
  const byslug = new Map()
  let files = []
  try {
    files = fs.readdirSync(STAGE_DIR).filter((f) => f.endsWith(".json"))
  } catch {
    return byslug
  }
  for (const f of files) {
    let meta
    try {
      meta = JSON.parse(fs.readFileSync(path.join(STAGE_DIR, f), "utf8"))
    } catch {
      continue
    }
    if (!meta?.slug) continue
    const htmlPath = path.join(STAGE_DIR, `${meta.id}.html`)
    let html = null
    try {
      html = fs.readFileSync(htmlPath, "utf8")
    } catch {
      /* a metadata file with no page is reported as a missing capture */
    }
    const list = byslug.get(meta.slug) ?? []
    list.push({ ...meta, html, htmlPath })
    byslug.set(meta.slug, list)
  }
  // Newest first: a slug can be clicked more than once, and the capture that
  // matters is the one nearest the submission being audited.
  for (const list of byslug.values())
    list.sort((a, b) =>
      String(b.captured_at).localeCompare(String(a.captured_at)),
    )
  return byslug
}

function main(argv = process.argv.slice(2)) {
  const asJson = argv.includes("--json")
  void positionals(argv, [])

  const db = openDb()
  const rows = db
    .prepare(
      `SELECT slug, mode, outcome, confirmation_url, submitted_at, company, title
         FROM auto_submissions
        WHERE mode = 'live'
        ORDER BY submitted_at`,
    )
    .all()
  db.close()

  const captures = loadCaptures()
  const out = rows.map((r) => {
    const cap = (captures.get(r.slug) ?? [])[0] ?? null
    const verdict = cap?.html ? verdictFor(cap.html) : "no-capture"
    // A confirmation_url is the ONLY positive evidence this repo trusts, and
    // no row has one. Absent that, anything not provably still-a-form needs a
    // human with an inbox.
    const needsInbox = !r.confirmation_url && verdict !== "looks-confirmed"
    return {
      slug: r.slug,
      recorded: r.outcome,
      submitted_at: r.submitted_at,
      confirmation_url: r.confirmation_url ?? null,
      capture: cap ? cap.id : null,
      capture_verdict: verdict,
      needs_inbox_check: needsInbox,
    }
  })

  if (asJson) {
    console.log(JSON.stringify({ submissions: out }, null, 2))
    return 0
  }

  const pad = (s, n) =>
    String(s ?? "")
      .slice(0, n)
      .padEnd(n)
  console.log(
    pad("slug", 46),
    pad("recorded", 10),
    pad("capture verdict", 22),
    "inbox?",
  )
  for (const r of out)
    console.log(
      pad(r.slug, 46),
      pad(r.recorded, 10),
      pad(r.capture_verdict, 22),
      r.needs_inbox_check ? "YES" : "-",
    )

  const stillForm = out.filter((r) => r.capture_verdict === "STILL-A-FORM")
  const noCap = out.filter((r) => r.capture_verdict === "no-capture")
  console.log(
    `\nlive_rows=${out.length} still_a_form=${stillForm.length} ` +
      `no_capture=${noCap.length} with_confirmation_url=` +
      `${out.filter((r) => r.confirmation_url).length}`,
  )
  if (stillForm.length)
    console.log(
      `\nPROBABLY NEVER SENT (the captured page still offers its submit):\n  ` +
        stillForm.map((r) => r.slug).join("\n  "),
    )
  if (noCap.length)
    console.log(
      `\nNO CAPTURE — these predate the stagePostSubmit hook (2026-08-24), so\n` +
        `the page was read and thrown away. Only the inbox can settle them:\n  ` +
        noCap.map((r) => r.slug).join("\n  "),
    )
  console.log(
    `\nNothing here changes the ledger. Correct a wrong row with:\n` +
      `  node src/applications/applications.mjs remove <slug> --confirm`,
  )
  return 0
}

if (
  process.argv[1] &&
  import.meta.url ===
    new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href
) {
  process.exit(main())
}

export { verdictFor, main }
