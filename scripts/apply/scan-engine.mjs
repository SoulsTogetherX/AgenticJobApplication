// scan-engine.mjs — installs the page scanner, runs it, and probes every custom
// dropdown for its options, in one call with no pasted code.
//
// This is the Playwright-side half of scanning. The scanner itself
// (.claude/skills/apply-job/scan-page.js) is the single source of truth and
// genuinely runs PAGE-side; this file never does. Everything here is a
// Playwright call, and it is an ordinary ES module: scripts/apply/browser.mjs
// imports it. Nothing is ever read back out of the page except DATA (the scan
// result), which is never eval'd.
//
// The MCP twin of this file is .claude/skills/apply-job/scan.driver.mjs, which
// is eval'd as a bare function expression by browser_run_code_unsafe and
// therefore cannot be a module. Keep the two in step.
//
// WHY the probe lives here and not in scan-page.js: React ignores the
// programmatic el.click() that page-context code can make, so react-select
// menus never opened and every dropdown came back with no options — which meant
// the planner deferred them all to the user. Playwright's click is a real input
// event and does open them.
//
// addInitScript makes window.__ajScan survive every later navigation in the
// session, so a structure-only re-scan is the ~30-token call:
//   browser_evaluate  () => window.__ajScan(false)
//
// INSTALLING INTO THIS DOCUMENT goes through page.evaluate + (0, eval) when the
// caller hands us the scanner source, and NOT page.addScriptTag({ path }):
// addScriptTag inserts a real inline <script> element, which a nonce-based CSP
// board refuses outright (Ashby: "Executing inline script violates the
// following Content Security Policy directive 'script-src 'nonce-...'"), and
// that broke a live application. page.evaluate drives the page over CDP
// (Runtime.evaluate), which is not a script the page itself loaded, so the
// page's CSP does not gate it — the same reason DevTools can run code on a
// CSP-locked page. The addScriptTag path is kept only as the fallback for a
// caller that has no source string, and its own fallback is a reload, which
// costs whatever the user has already typed into the form.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

// Resolved from this file rather than from the cwd: the Node runner is started
// by a scheduled task whose working directory is not ours to assume.
export const SCANNER_PATH = path.join(
  ROOT,
  ".claude",
  "skills",
  "apply-job",
  "scan-page.js",
)

export function readScannerSource(file = SCANNER_PATH) {
  return fs.readFileSync(file, "utf8")
}

export default async function scanPage(page, opts = {}) {
  const scannerPath = opts.scannerPath || SCANNER_PATH
  const scannerSrc =
    opts.scannerSrc === undefined
      ? readScannerSource(scannerPath)
      : opts.scannerSrc
  const ready = await page.evaluate(() => typeof window.__ajScan === "function")
  if (!ready) {
    await page.addInitScript(
      scannerSrc ? { content: scannerSrc } : { path: scannerPath },
    )
    if (scannerSrc) {
      // CDP evaluation, not an inline <script>: see the header. This is the
      // path that works on a nonce-CSP board without a reload.
      await page.evaluate((s) => {
        ;(0, eval)(s)
      }, scannerSrc)
    } else {
      try {
        // this document, without losing anything already typed into it
        await page.addScriptTag({ path: scannerPath })
      } catch {
        // strict CSP blocks injected script tags; the init script survives a reload
        await page.reload({ waitUntil: "domcontentloaded" })
      }
    }
  }
  // Scanning before React hydrates returns the raw inputs behind the custom
  // widgets instead of the widgets themselves — and no buttons at all, which is
  // the tell. Wait for a button to EXIST rather than for a flat 1.5 seconds,
  // then re-scan. Same ceiling; a page that hydrates in 200ms costs 200ms.
  await page.waitForLoadState("load").catch(() => {})
  let scan = await page.evaluate(() => window.__ajScan(false))
  if (!scan.btns || !scan.btns.length) {
    await page
      .locator("button, [role='button'], input[type=submit]")
      .first()
      .waitFor({ state: "attached", timeout: 1500 })
      .catch(() => {})
    scan = await page.evaluate(() => window.__ajScan(false))
  }

  // --- which dropdowns are worth opening ------------------------------------
  // Probing is the most expensive part of a scan: a real click plus the menu
  // render, per dropdown, up to 18 of them. Options only exist to CHOOSE an
  // answer, so a dropdown whose answer is already known does not need any:
  // `knownOpts` is what the field cache remembers about this form, `skipProbe`
  // is the labels the fact base already resolves. A field nobody has told us
  // about is still probed — too little information is the expensive failure
  // here, not too much.
  const key = (s) =>
    String(s || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
  const known = new Map(
    Object.entries(opts.knownOpts || {}).map(([k, v]) => [key(k), v]),
  )
  const skip = new Set((opts.skipProbe || []).map(key))
  const probeMax = opts.probeMax === undefined ? 18 : opts.probeMax

  const stats = { probed: 0, cached: 0, skipped: 0, capped: 0 }
  const todo = []
  for (const f of scan.fields || []) {
    if (f.t !== "combo" || (f.opts && f.opts.length)) continue
    const cached = known.get(key(f.l)) || known.get(key(f.k))
    if (cached && cached.length) {
      f.opts = cached
      f.opts_from = "cache"
      stats.cached++
      continue
    }
    if (skip.has(key(f.l)) || skip.has(key(f.k))) {
      f.probe_skipped = "answer already known"
      stats.skipped++
      continue
    }
    // Capped: a long form should not spend a minute in here.
    if (todo.length >= probeMax) {
      f.probe_skipped = "probe cap"
      stats.capped++
      continue
    }
    todo.push(f)
  }

  for (const f of todo) {
    const loc = page.locator('[data-aj="' + f.k + '"]')
    try {
      await loc.scrollIntoViewIfNeeded({ timeout: 2000 })
      await loc.click({ timeout: 2000, force: true })
      // Wait for the menu to RENDER, not for 300ms. react-select's own class
      // first: a bare [role=option] also matches the phone country-code
      // widget, which is always in the DOM — so waiting on that would return
      // instantly on every form with a phone field, and reading it would hand
      // every dropdown the same list of countries.
      await page
        .locator("[class*='__option']")
        .first()
        .waitFor({ state: "attached", timeout: 300 })
        .catch(() => {})
      const found = await page.evaluate(() => {
        const pick = (sel) =>
          [...document.querySelectorAll(sel)]
            .map((e) => (e.innerText || "").replace(/\s+/g, " ").trim())
            .filter(Boolean)
        const a = pick("[class*='__option']")
        return (a.length ? a : pick("[role='option']")).slice(0, 40)
      })
      if (found.length) f.opts = found
      stats.probed++
      await page.keyboard.press("Escape")
      // Let the menu close before the next dropdown is clicked — for as long
      // as that actually takes, not a flat 80ms.
      await page
        .locator("[class*='__option']")
        .first()
        .waitFor({ state: "detached", timeout: 80 })
        .catch(() => {})
    } catch (e) {
      f.probe_error = String(e.message).slice(0, 60)
    }
  }
  scan.probe = stats

  // Stashed so the scan can be written to disk without paying for it twice:
  //   browser_evaluate { function: "() => window.__ajLastScan",
  //                      filename: "scan-p1.json" }
  await page.evaluate((s) => (window.__ajLastScan = s), scan)
  return scan
}
