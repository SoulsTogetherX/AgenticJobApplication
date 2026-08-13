// ASHBY'S DROPDOWNS — why the probe read none of them, measured 2026-08-04.
//
// Found while applying to a live Render posting. Two independent defects, both
// of which end in the same place: a dropdown whose options are perfectly
// readable comes back with NO options, resolves as NEEDS-CHOICE, and blocks
// the submit. On the Render form that was an 11-option "How did you hear about
// Render?" deferred to a human for no reason at all.
//
//   1. THE MENU OPENS FROM THE CHEVRON. Ashby renders
//        <div class="_inputContainer_">
//          <input role="combobox" aria-expanded="false">
//          <button class="_toggleButton_"><svg/></button>
//      and clicking the INPUT — which is what the probe clicked — only focuses
//      it. Nothing opens, nothing is read.
//
//   2. AN EMPTY MENU IS NOT A ONE-OPTION MENU. An async typeahead with no
//      query renders a "No results" box and declares no [role=option], so the
//      reader's leaf fallback returned ["No results"] AS THE OPTION LIST. That
//      is the worse of the two: the field cache stores a returned list as the
//      complete one, so the real answer resolves as "not on offer" and the
//      field defers on every future application to that board.
//
// The third test is the bound, and it is the one that matters most if this
// code is ever changed: the toggle is identified by having NO NAME OF ITS OWN.
// A chevron has none. "Withdraw application" has plenty, and sits in exactly
// the same container, so nothing but that distinction stops the probe from
// clicking it.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import scanPage from "../../scripts/apply/scan-engine.mjs"
import { launchBrowser } from "../../scripts/apply/browser.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const SCANNER_TEXT = fs.readFileSync(
  path.join(ROOT, ".claude", "skills", "apply-job", "scan-page.js"),
  "utf8",
)
// NOT in tests/fixtures/boards/pages/ — that is the honest-board corpus, and
// fill-page.test.mjs sweeps it to prove the scanner invents no fields there. A
// deliberate reproduction of broken markup belongs outside it, exactly as
// tests/fixtures/oracle/ does. See this directory's README.
const PAGE = fs.readFileSync(
  path.join(ROOT, "tests", "fixtures", "ashby", "ashby-toggle-combo.html"),
  "utf8",
)

// Skipped with a STATED reason when no Chromium is usable — a leg that skips
// silently is indistinguishable from one that passes.
const NO_BROWSER = await (async () => {
  try {
    const s = await launchBrowser({ headless: true })
    await s.close()
    return null
  } catch (e) {
    return "no usable Chromium: " + String(e.message).slice(0, 90)
  }
})()

const scanFixture = async () => {
  const s = await launchBrowser({ headless: true })
  try {
    await s.page.setContent(PAGE)
    const { scan } = await scanPage(s.page, { scannerSrc: SCANNER_TEXT })
    const withdrawn = await s.page.evaluate(() =>
      document.body.getAttribute("data-withdrawn"),
    )
    return { scan, withdrawn }
  } finally {
    await s.close()
  }
}

const byLabel = (scan, label) =>
  (scan.fields || []).find((f) => (f.l || "").startsWith(label))

test("a menu that opens only from its chevron is still probed", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const { scan } = await scanFixture()
  const f = byLabel(scan, "How did you hear")
  assert.ok(f, "the dropdown is reported as a field")
  assert.deepEqual(
    (f.opts || []).map(String),
    ["LinkedIn", "Careers page", "Employee referral"],
    "the real option list is read after the toggle opens the menu",
  )
})

test("an empty typeahead records NO options, not a 'No results' option", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const { scan } = await scanFixture()
  const f = byLabel(scan, "Location")
  assert.ok(f, "the typeahead is reported as a field")
  assert.ok(
    !(Array.isArray(f.opts) && f.opts.length),
    "an empty-state message must never be stored as the option list, because " +
      "the field cache would keep it as the COMPLETE list: got " +
      JSON.stringify(f.opts),
  )
})

test("Ashby's CSS-class required marker survives the whole scan path", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const { scan } = await scanFixture()
  assert.equal(byLabel(scan, "Location").req, true)
  assert.equal(byLabel(scan, "How did you hear").req, true)
  assert.ok(
    !byLabel(scan, "Team").req,
    "a field with no required marker stays optional",
  )
})

test("THE BOUND: a NAMED button beside a combobox is never clicked", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const { scan, withdrawn } = await scanFixture()
  assert.equal(
    withdrawn,
    null,
    "the probe clicked 'Withdraw application' — the toggle search must only " +
      "ever accept a button with no name of its own",
  )
  // And the field it sits beside simply goes unprobed, which is the designed
  // failure: it defers to a human rather than being opened by force.
  const team = byLabel(scan, "Team")
  assert.ok(
    !(Array.isArray(team.opts) && team.opts.length),
    "its menu stays shut rather than being opened by clicking a named action",
  )
})
