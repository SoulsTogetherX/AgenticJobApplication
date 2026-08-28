// REACT-SELECT ON GREENHOUSE — why the probe read none of it, measured on a
// live Coinbase application 2026-08-07 (job-boards.greenhouse.io, token
// 8113286). 13 of 19 required combos came back
//   probe_error: "locator.click: Timeout 2000ms exceeded"
// or, once the click landed, with no menu found at all. Working around it by
// hand cost ~6 extra browser round trips on one application.
//
// Two independent defects, both confirmed against the live DOM:
//
//   1. THE ARIA IS ON THE INNER INPUT. The scanner stamps `.select__control`
//      — the shell, deliberately: it is what a human clicks and what every
//      data-aj selector resolves to. That shell carries no aria at all here;
//      `aria-controls` and `aria-expanded` are on `input.select__input`
//      inside it. Reading them off the shell returned null, so the menu was
//      never named AND `aria-expanded` never read "false", which meant the
//      chevron-toggle fallback (the Ashby fix) could not fire either. Both
//      halves of the probe were looking at an element that says nothing.
//
//   2. THE MENU IS IN A PORTAL. `.select__menu` is appended outside the
//      control's container, so container-scoped lookups miss it.
//
// These are the same class of failure as tests/apply/ashby-combo-probe.test.mjs
// — a readable dropdown reported as having no options, deferring a field the
// form answers perfectly well — but a different shape, and this fixture lives
// in tests/fixtures/greenhouse/ where the other Greenhouse shapes are.
//
// The third test is the bound and is the one that matters if this is changed:
// the portal read is a FALLBACK. A control that names its own menu must be
// read from the menu it named, even when something else is visible in the
// portal at that moment.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import scanPage from "../../src/apply/scan-engine.mjs"
import { launchBrowser } from "../../src/apply/browser.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const SCANNER_TEXT = fs.readFileSync(
  path.join(ROOT, ".claude", "skills", "apply-job", "scan-page.js"),
  "utf8",
)
// Not in tests/fixtures/boards/pages/ — that is the honest-board corpus and
// fill-page.test.mjs sweeps it to prove the scanner invents nothing there. A
// deliberate reproduction of a broken shape belongs outside it. See
// tests/fixtures/ashby/README.md, which states the rule.
const PAGE = fs.readFileSync(
  path.join(ROOT, "tests", "fixtures", "greenhouse", "portal-menu-combo.html"),
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
    return scan
  } finally {
    await s.close()
  }
}

const byLabel = (scan, label) =>
  (scan.fields || []).find((f) => (f.l || "").startsWith(label))

let cached
const scanOnce = async () => (cached ??= await scanFixture())

test("a combo whose aria lives on its inner input is probed", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const f = byLabel(await scanOnce(), "How did you hear")
  assert.ok(f, "the dropdown is reported as a field")
  assert.ok(!f.probe_error, `probe failed: ${f.probe_error}`)
  assert.deepEqual(
    (f.opts || []).map(String),
    ["LinkedIn", "Careers page", "Employee referral"],
    "the menu named by the INNER input is found and read; reading aria off " +
      "the stamped shell returns null and finds nothing",
  )
})

test("a portalled menu is read even when the control names nothing", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const f = byLabel(await scanOnce(), "Country")
  assert.ok(f, "the dropdown is reported as a field")
  assert.ok(!f.probe_error, `probe failed: ${f.probe_error}`)
  assert.deepEqual(
    (f.opts || []).map(String),
    ["United States", "Canada", "United Kingdom"],
    "with no aria-controls to follow, the single VISIBLE menu-list on the " +
      "page is this control's menu — the probe opens one at a time",
  )
})

test("THE BOUND: a control that names its own menu never reads the portal", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const f = byLabel(await scanOnce(), "Gender")
  assert.ok(f, "the dropdown is reported as a field")
  const opts = (f.opts || []).map(String)
  assert.deepEqual(
    opts,
    ["Man", "Woman", "I prefer not to say"],
    "the named menu wins; the portal read is a fallback for controls that " +
      "name nothing, not a replacement for what the page told us",
  )
  assert.ok(
    !opts.some((o) => /DECOY/.test(o)),
    "a decoy was visible in the portal while this control's own menu was " +
      "open, and it must not have been read: got " +
      JSON.stringify(opts),
  )
})

test("the required marker on the inner input survives the scan", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const scan = await scanOnce()
  // aria-required sits on the inner input, never on the stamped shell — the
  // same split that defeated the probe, in the half scan-page.js already
  // handles via labelHost(). Pinned here so a change to the aria redirection
  // cannot quietly take the label and req with it.
  for (const label of ["How did you hear", "Country", "Gender"]) {
    assert.equal(byLabel(scan, label).req, true, `${label} read as optional`)
  }
})
