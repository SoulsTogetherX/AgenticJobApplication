// A PAGE THAT RE-RENDERS ITSELF UNDER THE SCAN — Greenhouse's embed form,
// measured 2026-08-18 (see tests/fixtures/greenhouse/embed-rerender.html for
// the timeline). The board replaces its whole document root ~200ms after
// `load`, so every data-aj stamp the structure scan wrote is on a node that no
// longer exists, and every probe click waited its full 6s for nothing:
// "13 of 19 required combos failed to probe", 61s per scan, on a form whose
// dropdowns are readable.
//
// What is pinned here, against real Chromium and the real scan-engine.mjs:
//   1. the probe notices the loss, re-scans ONCE, and reads every menu off the
//      fresh nodes — options come back, `scan.probe.rescans` is 1, and the
//      scan says so in `signals`;
//   2. the scan it returns is the one whose stamps are ON THE PAGE afterwards,
//      so the planner's keys resolve at fill time;
//   3. an async list whose menu mounts with "Loading..." is read after the rows
//      arrive — never as ["Loading..."], which is what the live field cache
//      held for School / Degree / Discipline;
//   4. the control: the same page with the swap disabled probes in one pass
//      (`rescans` 0, no signal) — a page that never re-renders pays nothing.
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
const PAGE = fs.readFileSync(
  path.join(ROOT, "tests", "fixtures", "greenhouse", "embed-rerender.html"),
  "utf8",
)
// The control variant: same page, swap disabled.
const STABLE = PAGE.replace("const RERENDER_MS = 250", "const RERENDER_MS = 0")
assert.notEqual(STABLE, PAGE, "the fixture's RERENDER_MS knob must exist")

const NO_BROWSER = await (async () => {
  try {
    const s = await launchBrowser({ headless: true })
    await s.close()
    return null
  } catch (e) {
    return "no usable Chromium: " + String(e.message).slice(0, 90)
  }
})()

const scanHtml = async (html) => {
  const s = await launchBrowser({ headless: true })
  try {
    await s.page.setContent(html)
    const { scan } = await scanPage(s.page, { scannerSrc: SCANNER_TEXT })
    // What the page looks like AFTER the scan returned — the state the planner
    // and the fill engine will meet.
    const after = await s.page.evaluate(() => ({
      stamped: document.querySelectorAll("[data-aj]").length,
      rerenders: window.__rerenders,
    }))
    return { scan, after }
  } finally {
    await s.close()
  }
}

const byLabel = (scan, label) =>
  (scan.fields || []).find((f) => (f.l || "").startsWith(label))
const stampsIn = (s) => {
  const keys = new Set()
  for (const f of s.fields || []) {
    if (f.k && !Array.isArray(f.o)) keys.add(f.k)
    for (const o of f.o || []) if (o && o.k) keys.add(o.k)
  }
  for (const b of s.btns || []) if (b && b.k) keys.add(b.k)
  return keys.size
}

let rerendered
const scanRerendered = async () => (rerendered ??= await scanHtml(PAGE))

test("a root swap during the probe is noticed, re-scanned once, and every menu is still read", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const { scan, after } = await scanRerendered()
  assert.equal(after.rerenders, 1, "the fixture swapped its root exactly once")
  assert.equal(
    scan.probe.rescans,
    1,
    `re-scanned once: ${JSON.stringify(scan.probe)}`,
  )
  assert.ok(
    (scan.signals || []).some((s) =>
      /re-rendered after the structure scan/.test(s),
    ),
    `the scan says why it re-scanned: ${JSON.stringify(scan.signals)}`,
  )
  const country = byLabel(scan, "Country")
  assert.ok(country, "Country* is in the scan")
  assert.equal(country.probe_error, undefined, "no 6s click timeout")
  assert.deepEqual(country.opts, [
    "United States +1",
    "Canada +1",
    "Germany +49",
  ])
  const sponsor = byLabel(scan, "Will you now")
  assert.deepEqual(sponsor.opts, ["Yes", "No"])
})

test("the scan that comes back is the one whose stamps are on the page", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const { scan, after } = await scanRerendered()
  assert.ok(
    stampsIn(scan) >= 4,
    `the scan stamped fields and buttons: ${stampsIn(scan)}`,
  )
  assert.ok(
    after.stamped >= stampsIn(scan),
    `every key the planner will use resolves after the scan: ${after.stamped} on page, ${stampsIn(scan)} in scan`,
  )
})

test('an async list is read after its rows arrive, never as ["Loading..."]', async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const { scan } = await scanRerendered()
  const school = byLabel(scan, "School")
  assert.ok(school, "School is in the scan")
  assert.deepEqual(
    school.opts,
    ["College of Southern Nevada", "UNLV", "Other"],
    `the rows, not the placeholder: ${JSON.stringify(school)}`,
  )
})

test("the control: with the swap disabled the probe runs in one pass and says nothing", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const { scan, after } = await scanHtml(STABLE)
  assert.equal(after.rerenders, 0)
  assert.equal(scan.probe.rescans, 0)
  assert.ok(!(scan.signals || []).some((s) => /re-rendered/.test(s)))
  assert.deepEqual(byLabel(scan, "Country").opts, [
    "United States +1",
    "Canada +1",
    "Germany +49",
  ])
  assert.deepEqual(byLabel(scan, "School").opts, [
    "College of Southern Nevada",
    "UNLV",
    "Other",
  ])
})
