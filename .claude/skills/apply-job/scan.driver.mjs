// scan.driver.mjs — installs the page scanner, runs it, and probes every custom
// dropdown for its options, in ONE tool call with no pasted code:
//
//   mcp__playwright__browser_run_code_unsafe
//     { filename: ".claude/skills/apply-job/scan.driver.mjs" }
//
// The scanner source lives in scan-page.js (single source of truth); Playwright
// reads it off disk, so this file stays small — it is echoed back in the tool
// result, and a big driver would put that cost straight back into context.
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
// NOT a module: the Playwright MCP server eval's these contents as a bare
// function expression in a vm sandbox — no imports, no require, no fs, no
// setTimeout, and no leading semicolon (see .prettierignore).
async (page) => {
  const path = ".claude/skills/apply-job/scan-page.js"
  const ready = await page.evaluate(() => typeof window.__ajScan === "function")
  if (!ready) {
    await page.addInitScript({ path })
    try {
      // this document, without losing anything already typed into it
      await page.addScriptTag({ path })
    } catch {
      // strict CSP blocks injected script tags; the init script survives a reload
      await page.reload({ waitUntil: "domcontentloaded" })
    }
  }
  // Scanning before React hydrates returns the raw inputs behind the custom
  // widgets instead of the widgets themselves — and no buttons at all, which is
  // the tell. Wait, then retry once if the page still looks unhydrated.
  await page.waitForLoadState("load").catch(() => {})
  let scan = await page.evaluate(() => window.__ajScan(false))
  if (!scan.btns || !scan.btns.length) {
    await page.waitForTimeout(1500)
    scan = await page.evaluate(() => window.__ajScan(false))
  }

  // Capped: a long form should not spend a minute here, and the field cache
  // means this only runs once per board anyway.
  const todo = (scan.fields || [])
    .filter((f) => f.t === "combo" && !(f.opts && f.opts.length))
    .slice(0, 18)

  for (const f of todo) {
    const loc = page.locator('[data-aj="' + f.k + '"]')
    try {
      await loc.scrollIntoViewIfNeeded({ timeout: 2000 })
      await loc.click({ timeout: 2000, force: true })
      await page.waitForTimeout(300)
      // react-select's own class first: a bare [role=option] also matches the
      // phone country-code widget, which is always in the DOM and would hand
      // every dropdown the same list of countries.
      const opts = await page.evaluate(() => {
        const pick = (sel) =>
          [...document.querySelectorAll(sel)]
            .map((e) => (e.innerText || "").replace(/\s+/g, " ").trim())
            .filter(Boolean)
        const a = pick("[class*='__option']")
        return (a.length ? a : pick("[role='option']")).slice(0, 40)
      })
      if (opts.length) f.opts = opts
      await page.keyboard.press("Escape")
      await page.waitForTimeout(80)
    } catch (e) {
      f.probe_error = String(e.message).slice(0, 60)
    }
  }

  // Stashed so the scan can be written to disk without paying for it twice:
  //   browser_evaluate { function: "() => window.__ajLastScan",
  //                      filename: "scan-p1.json" }
  await page.evaluate((s) => (window.__ajLastScan = s), scan)
  return scan
}
