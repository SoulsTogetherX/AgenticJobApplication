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
// therefore cannot be a module. Keep the two in step — they drifted once
// already, and the flat sleeps this file removed sat in the driver, which is
// the path that actually runs today.
//
// ONE THING THE TWO DELIBERATELY DO NOT SHARE: `labelExact`, the flag
// fill-plan.mjs requires before it will tick a consent box unattended. It
// means anything only if the code that computed it AND the channel that
// carried it are both out of the page's reach. Here, both are (the scanner is
// called through a local binding; the vouched object is returned in-process).
// In the driver, neither is, so it strips every vouch. See untrustScan below.
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

// scan-page.js's text is an ASSIGNMENT — `window.__ajScan = async (PROBE...`.
// Everything from the arrow onward is the function on its own, which the
// scanner's own header already documents as the paste-able form. We need that
// form because the authoritative scan must NOT be called through a global.
// Anchored on the ASSIGNMENT at the start of a line, not on the arrow's own
// text: scan-page.js's header comment quotes "async (PROBE" when it tells a
// human where to paste from, so searching for that lands inside the comment
// and returns prose. The result is checked by a test that parses it.
export function scannerExpression(src = readScannerSource()) {
  const m = /^window\.__ajScan\s*=\s*/m.exec(String(src))
  if (!m) {
    throw new Error(
      "scan-page.js no longer starts with a `window.__ajScan =` assignment " +
        "at the start of a line — scannerExpression() depends on it",
    )
  }
  return src.slice(m.index + m[0].length).trim()
}

export default async function scanPage(page, opts = {}) {
  const scannerPath = opts.scannerPath || SCANNER_PATH
  const scannerSrc =
    opts.scannerSrc === undefined
      ? readScannerSource(scannerPath)
      : opts.scannerSrc

  // WHY THIS NO LONGER ASKS THE PAGE WHETHER THE SCANNER IS ALREADY THERE.
  //
  // It used to skip installation when `typeof window.__ajScan === "function"`,
  // and then call window.__ajScan(). A board that defines that global before
  // the runner arrives was therefore "ready", the real scanner was never
  // installed, and every field key, label, selector and FLAG in the scan was
  // chosen by the board. The flag that matters is `labelExact`: fill-plan.mjs
  // treats it as the precondition for ticking a consent box unattended, so a
  // page-supplied scanner could assert it over any wording it liked.
  //
  // So: install unconditionally (one CDP round trip, ~1ms), and read the
  // authoritative scan through a LOCAL BINDING that no page script can reach.
  // window.__ajScan is still installed, but only for the cheap re-scan call
  // in SKILL.md — nothing here trusts it.
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

  // The scanner as a local const inside the page-side arrow. A board can define
  // window.__ajScan all it likes; nothing below ever reads it.
  //
  // A source we cannot reduce to one expression FALLS BACK to the global
  // rather than throwing: a scanner that refuses to run is worse than one
  // whose provenance is unknown, and the unknown case is failed closed at the
  // bottom of this function (every vouch stripped).
  let expr = null
  try {
    if (scannerSrc) expr = scannerExpression(scannerSrc)
  } catch {
    expr = null
  }
  const runScan = (probe) =>
    expr
      ? page.evaluate((a) => (0, eval)("(" + a.scanner + ")")(a.probe), {
          scanner: expr,
          probe,
        })
      : // No source to embed, so this caller has no choice but the global —
        // and therefore no way to know whose function answered. Everything
        // vouched is stripped below.
        page.evaluate(() => window.__ajScan(false))

  // Scanning before React hydrates returns the raw inputs behind the custom
  // widgets instead of the widgets themselves — and no buttons at all, which is
  // the tell. Wait for a button to EXIST rather than for a flat 1.5 seconds,
  // then re-scan. Same ceiling; a page that hydrates in 200ms costs 200ms.
  await page.waitForLoadState("load").catch(() => {})
  let scan = await runScan(false)
  if (!scan.btns || !scan.btns.length) {
    await page
      .locator("button, [role='button'], input[type=submit]")
      .first()
      .waitFor({ state: "attached", timeout: 1500 })
      .catch(() => {})
    scan = await runScan(false)
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
  if (!expr) untrustScan(scan, "the scanner was called through window.__ajScan")

  // Stashed so the scan can be written to disk without paying for it twice:
  //   browser_evaluate { function: "() => window.__ajLastScan",
  //                      filename: "scan-p1.json" }
  //
  // A VOUCH NEVER CROSSES THIS LINE. Whatever is stashed here is read back out
  // of the page by that call, and the page can redefine __ajLastScan as a
  // getter returning anything it likes — so a labelExact that goes in can come
  // back out attached to wording the user never approved. The copy that keeps
  // its vouch is the one RETURNED from this function, in this process, which
  // never touches the page again.
  await page.evaluate(
    (s) => (window.__ajLastScan = s),
    untrustScan(structuredClone(scan), "read back out of the page").scan,
  )
  return scan
}

// Strip every vouch from a scan whose provenance we cannot establish, and say
// why in the scan's own signals. Done PLAYWRIGHT-SIDE, where the page cannot
// reach it, and it fails closed: with no labelExact, fill-plan.mjs defers every
// consent box and the user ticks it in the browser.
//
// The honest limit, so nobody treats this as more than it is: `labelExact` is
// still COMPUTED in the page, so a board that patches HTMLElement.prototype
// (innerText, getBoundingClientRect, getComputedStyle) can lie to an honest
// scanner. No Playwright-based scanner can close that — locator.innerText()
// runs in the page too. What IS closed is the page choosing WHICH FUNCTION
// answers. Against a prototype-patching board the remaining controls are the
// positive allowlist (the attacker must reproduce wording the user typed
// themselves), isHardConsent, and the fact that --consent-allowlist is opt-in
// and empty by default.
export function untrustScan(scan, why) {
  let stripped = 0
  for (const f of scan?.fields ?? []) {
    if (f.labelExact) {
      delete f.labelExact
      f.labelWhy = why
      stripped++
    }
    for (const o of f.o ?? []) delete o.labelExact
  }
  if (stripped && scan) {
    scan.signals = [...(scan.signals ?? []), `scan not vouched: ${why}`]
  }
  return { scan, stripped }
}
