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
  // Was something ALREADY answering to __ajScan before we installed anything?
  // A board that defines that global supplies the entire scan — every label,
  // selector and flag — because the next line is what decides whether the real
  // scanner is installed at all. It cannot be fixed here the way
  // scripts/apply/scan-engine.mjs fixes it (call the scanner through a local
  // binding), because that needs the scanner's TEXT and this vm has no fs: see
  // the header. So it is recorded, and every vouch is stripped below.
  const preOwned = await page.evaluate(
    () => typeof window.__ajScan === "function",
  )
  if (!preOwned) {
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

  // Capped: a long form should not spend a minute here, and the field cache
  // means this only runs once per board anyway.
  //
  // This driver cannot be told WHICH dropdowns to skip: browser_run_code_unsafe
  // takes a filename and passes no arguments, and this vm has no fs to read a
  // hint file with. scripts/apply/scan-engine.mjs — the ordinary-module twin
  // used by the local runner — takes { knownOpts, skipProbe } and probes only
  // what is genuinely unknown. Keep the two in step on everything that does
  // NOT need a parameter, which is every wait below.
  //
  // WHAT THE PROBE IS ALLOWED TO CLICK. Mirrored from scripts/apply/
  // scan-engine.mjs's probeRefusal(), which is the canonical copy and carries
  // the full reasoning; this vm has no module loader so it cannot import it,
  // and tests/apply/fill-page.test.mjs pins the two character-for-character.
  // In short: shape alone cannot tell a country picker from a button a board
  // decorated with role="combobox" and labelled "Withdraw my application", so
  // (1) a picker's name comes from OUTSIDE it while a button's name is its own
  // text, and (2) a word list as a named backstop.
  const KEY = (s) =>
    String(s || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
  const DESTRUCTIVE_LABEL =
    /\b(withdraw|delete|deactivate|remove|revoke)\b|\bsubmit\b|\bsend (my |the )?applicat|\bconfirm and\b|\bclose (my )?(account|profile)\b/i
  const probeRefusal = (f) => {
    const name = KEY(f && f.l)
    const own = KEY(f && f.v)
    if (!name) return "no label to identify it as a picker"
    if (
      own &&
      (name === own ||
        (own.length >= 12 && (name.startsWith(own) || own.startsWith(name))))
    ) {
      return "its name is its own text, so it is a button, not a picker"
    }
    if (DESTRUCTIVE_LABEL.test(String((f && f.l) || ""))) {
      return "label reads as an action on the application, not a choice"
    }
    return ""
  }

  const stats = { probed: 0, cached: 0, skipped: 0, capped: 0, refused: 0 }
  const todo = []
  for (const f of scan.fields || []) {
    if (f.t !== "combo" || (f.opts && f.opts.length)) continue
    const refusal = probeRefusal(f)
    if (refusal) {
      f.probe_refused = refusal
      stats.refused++
      continue
    }
    if (todo.length >= 18) {
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
      // NOT force:true — a forced click skips every actionability check, which
      // is "click something the user could not have clicked". See the engine.
      await loc.click({ timeout: 2000 })
      // Wait for the menu to RENDER, not for a flat 300ms. react-select's own
      // class first: a bare [role=option] also matches the phone country-code
      // widget, which is always in the DOM — so waiting on that would return
      // instantly on every form with a phone field, and reading it would hand
      // every dropdown the same list of countries.
      await page
        .locator("[class*='__option']")
        .first()
        .waitFor({ state: "attached", timeout: 300 })
        .catch(() => {})
      const opts = await page.evaluate(() => {
        const pick = (sel) =>
          [...document.querySelectorAll(sel)]
            .map((e) => (e.innerText || "").replace(/\s+/g, " ").trim())
            .filter(Boolean)
        const a = pick("[class*='__option']")
        return (a.length ? a : pick("[role='option']")).slice(0, 40)
      })
      if (opts.length) f.opts = opts
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

  // NO VOUCH EVER SURVIVES THIS PATH, and that is deliberate.
  //
  // labelExact is fill-plan.mjs's precondition for ticking a consent box
  // unattended. It can only mean anything if BOTH the code that computed it
  // and the channel that carried it are out of the page's reach. Neither is
  // true here: this driver cannot embed the scanner's text (no fs in this vm),
  // so it must call window.__ajScan and cannot know whose function answered;
  // and the scan is carried out of the page again by
  //   browser_evaluate { function: "() => window.__ajLastScan", filename }
  // where a getter on that global can return anything at all.
  //
  // scripts/apply/scan-engine.mjs — the ordinary-module twin — closes both
  // (local binding in, in-process object out) and is the path Phase 3's
  // unattended runner uses. Here the user is on the submit button anyway, so
  // the cost of stripping is one tick in the browser. Done PLAYWRIGHT-SIDE.
  const why = preOwned
    ? "a script on this page already defined __ajScan"
    : "the MCP scan path cannot vouch for a label"
  let stripped = 0
  for (const f of scan.fields || []) {
    if (f.labelExact) {
      delete f.labelExact
      f.labelWhy = why
      stripped++
    }
    for (const o of f.o || []) delete o.labelExact
  }
  if (stripped || preOwned) {
    scan.signals = (scan.signals || []).concat("scan not vouched: " + why)
  }

  // Stashed so the scan can be written to disk without paying for it twice:
  //   browser_evaluate { function: "() => window.__ajLastScan",
  //                      filename: "scan-p1.json" }
  await page.evaluate((s) => (window.__ajLastScan = s), scan)
  return scan
}
