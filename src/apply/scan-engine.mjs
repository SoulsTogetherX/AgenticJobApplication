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

// --- WHAT THE PROBE IS ALLOWED TO CLICK ------------------------------------
//
// A probe exists to DISCOVER OPTIONS, and it is an optimisation: the cost of
// not probing a control is that the user picks that value themselves. The cost
// of probing the wrong control is a click on someone's live application, fired
// by the SCANNER — before a plan exists, before anything has been approved,
// and on the unattended path with nobody watching. Those costs are not
// symmetric, so this refuses on any doubt.
//
// scan-page.js identifies dropdowns by SHAPE ALONE ([role=combobox],
// [aria-haspopup=listbox], [class*=select__control], [data-ui=select]) and
// shape cannot tell a country picker from a button a board decorated with
// role="combobox" and labelled "Withdraw my application". In
// tests/fixtures/hostile/forms/destructive-combobox.html the honest and the
// hostile controls are deliberately identical in shape, so no shape rule can
// separate them and a rule that tries is theatre.
//
// TWO RULES. ONLY THE FIRST IS STRUCTURAL:
//
//   1. A PICKER'S NAME COMES FROM OUTSIDE IT; A BUTTON'S NAME IS ITS OWN TEXT.
//      A dropdown renders a placeholder ("Select...") or its current value and
//      takes its NAME from a separate label — that is what makes it a picker.
//      A control whose accessible name is exactly the words rendered inside it
//      is a button wearing a dropdown's clothes. This is a property of the
//      widget, and it is what separates the fixture's #country from its
//      #withdraw, #delete and #submit-now.
//   2. A WORD LIST, as a backstop, named as one. It has a word list's weakness
//      — the next rewording is free — and it exists only to catch shapes rule 1
//      misses. Nothing rests on it alone, and adding a 27th word is not a fix.
//
// Mirrored, because a click happens in three places and none of them can
// import this: .claude/skills/apply-job/scan.driver.mjs (the MCP vm has no
// module loader) and scan-page.js's own PROBE loop (page context). This file
// is the canonical copy; tests/apply/fill-page.test.mjs pins all three
// character-for-character so a drift is loud.
export const DESTRUCTIVE_LABEL =
  /\b(withdraw|delete|deactivate|remove|revoke)\b|\bsubmit\b|\bsend (my |the )?applicat|\bconfirm and\b|\bclose (my )?(account|profile)\b/i

// "" when the probe may open this control, else the reason it may not.
export function probeRefusal(f, norm = (s) => key(s)) {
  const name = norm(f?.l)
  const own = norm(f?.v)
  // Nothing identifies it as a picker, and a control with no label cannot be
  // resolved by the answer bank either — so refusing costs a field that was
  // already going to defer.
  if (!name) return "no label to identify it as a picker"
  if (
    own &&
    (name === own ||
      (own.length >= 12 && (name.startsWith(own) || own.startsWith(name))))
  ) {
    return "its name is its own text, so it is a button, not a picker"
  }
  if (DESTRUCTIVE_LABEL.test(String(f?.l ?? ""))) {
    return "label reads as an action on the application, not a choice"
  }
  return ""
}

const key = (s) =>
  String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()

// scan-page.js's text is an ASSIGNMENT — `window.__ajScan = async (PROBE...`.
// Everything from the arrow onward is the function on its own, which the
// scanner's own header already documents as the paste-able form. We need that
// form because the authoritative scan must NOT be called through a global.
// Anchored on the ASSIGNMENT at the start of a line, not on the arrow's own
// text: scan-page.js's header comment quotes "async (PROBE" when it tells a
// human where to paste from, so searching for that lands inside the comment
// and returns prose. The result is checked by a test that parses it.
//
// It stops at scan-page.js's end marker, because the file is a SCRIPT with a
// second statement after the function (it locks window.__ajScan non-writable),
// and slicing to end-of-file would hand eval two statements instead of one
// expression.
export const SCANNER_END = "// --- scanner ends here"

export function scannerExpression(src = readScannerSource()) {
  const m = /^window\.__ajScan\s*=\s*/m.exec(String(src))
  if (!m) {
    throw new Error(
      "scan-page.js no longer starts with a `window.__ajScan =` assignment " +
        "at the start of a line — scannerExpression() depends on it",
    )
  }
  const rest = src.slice(m.index + m[0].length)
  const end = rest.indexOf(SCANNER_END)
  return (end < 0 ? rest : rest.slice(0, end)).trim()
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

  // --- THE PAGE MAY RE-RENDER ITSELF UNDER THE SCAN --------------------------
  //
  // MEASURED on Greenhouse's embed form (job-boards.greenhouse.io/embed/job_app,
  // Attentive token 4363395009 and Torc 8677422002), 2026-08-18, and it is the
  // whole of "13 of 19 required combos failed to probe" on that host, not the
  // aria/portal defects fixed on 2026-08-07:
  //
  //   goto (domcontentloaded)                 ~430ms
  //   first control attached                  ~670ms
  //   structure scan done, 24 stamps          ~730ms
  //   document.documentElement REPLACED       ~860ms   <- with or without a scan
  //   [data-aj] elements on the page               0
  //
  // The board is a Remix app hydrating over its server-rendered form; on this
  // host the client render replaces the WHOLE document root ~200ms after
  // `load`, whether or not anything scanned it (verified with no scanner
  // installed at all). Every `data-aj` stamp the structure scan wrote lives on
  // a node that no longer exists, so each probe click waited its full 6s for
  // `[data-aj="fN"]` and every combo came back
  //   probe_error: "locator.click: Timeout 6000ms exceeded" — 61s for a scan
  // that should take 4. The stamps were dead before the first click; the
  // scan itself was fine.
  //
  // WHAT IS DONE ABOUT IT, and what is deliberately not:
  //   * NOT a wait before scanning. A flat or "quiet DOM" wait taxes every
  //     board to cover one host's hydration, and this pipeline is benchmarked
  //     on latency. A page that never re-renders pays nothing below.
  //   * DETECT the loss, cheaply and everywhere: the number of `[data-aj]`
  //     elements on the page is compared with the number of stamps the scan
  //     handed out (one page.evaluate, ~1ms) before the probe starts and after
  //     it ends, and each control's stamp is checked to be attached before it
  //     is clicked (locator.count(), no wait) rather than waited on for 6s.
  //   * RE-SCAN once, after the page settles. A fresh structure scan re-stamps
  //     the NEW nodes with keys assigned in DOM order — the same keys for the
  //     same form — and the probe pass runs again over that scan. The re-scan
  //     is a full replacement, never a merge: whatever the first pass read off
  //     nodes that were then thrown away is discarded with them, so a menu
  //     read mid-swap cannot leak into the field cache as a complete list.
  //   * ONCE. A page that loses its stamps again after the re-scan is one that
  //     re-renders on a timer, and no number of retries decides that; the
  //     second pass keeps whatever it got and says so in `scan.signals` and
  //     `scan.probe.rescans`, so the runner's defer names the cause rather
  //     than "no options".
  //
  // STATED LIMIT: a swap that lands after this function returns (a form with
  // nothing to probe scans in ~80ms and returns before the ~860ms swap) is not
  // caught here — the fill engine resolves `sel` first for exactly that reason,
  // and a control with no `sel` then fails to locate, which is a stated fill
  // failure and blocks the submit rather than filling the wrong thing.
  const stampsIn = (s) => {
    const keys = new Set()
    for (const f of s.fields || []) {
      if (f.k && !Array.isArray(f.o)) keys.add(f.k)
      for (const o of f.o || []) if (o && o.k) keys.add(o.k)
    }
    for (const b of s.btns || []) if (b && b.k) keys.add(b.k)
    return keys.size
  }
  const stampsAlive = () =>
    page
      .evaluate(() => document.querySelectorAll("[data-aj]").length)
      .catch(() => 0)
  const stampsLost = async (s) => (await stampsAlive()) < stampsIn(s)
  // After a re-render: wait for the control count to hold still. A CONDITION
  // WITH A CEILING, not a sleep — the same rule every other wait in this file
  // follows: the count must read the same on two consecutive polls 150ms apart
  // (so at least one poll interval passes), bounded at 2s. Only ever paid by a
  // page that already lost its stamps once.
  const settleAfterRerender = () =>
    page
      .waitForFunction(
        () => {
          const n = document.querySelectorAll(
            "input,select,textarea,[role='combobox']",
          ).length
          const same = window.__ajSettleCount === n
          window.__ajSettleCount = n
          return same
        },
        undefined,
        { polling: 150, timeout: 2000 },
      )
      .catch(() => {})

  // --- which dropdowns are worth opening ------------------------------------
  // Probing is the most expensive part of a scan: a real click plus the menu
  // render, per dropdown, up to 18 of them. Options only exist to CHOOSE an
  // answer, so a dropdown whose answer is already known does not need any:
  // `knownOpts` is what the field cache remembers about this form, `skipProbe`
  // is the labels the fact base already resolves. A field nobody has told us
  // about is still probed — too little information is the expensive failure
  // here, not too much.
  //
  // `knownFor(scan)` IS THE SAME TWO MAPS, SUPPLIED LATE (Phase 5, 2026-08-14).
  // The field cache keys what it knows on the form's FINGERPRINT — a hash of
  // the fields' required labels — which no caller can compute before the
  // structure scan above has run. So a caller that wants the cache to feed the
  // probe hands over a function instead of a value: it is called here, once,
  // with the structure scan, and returns `{knownOpts, skipProbe}` (or null)
  // that merge over anything passed directly. Absent, this block is
  // byte-for-byte the old behaviour. NON-FATAL: a callback that throws costs
  // its hints, never the scan — the fallback is the full probe, which is the
  // safe direction (a scan with too little information is expensive; a scan
  // that did not happen is a job that defers "nothing to fill").
  //
  // (Read inside probePass, per pass: a re-scan after a re-render is a new
  // structure scan and may fingerprint differently.)
  const hintsFor = async (s) => {
    let late = null
    if (typeof opts.knownFor === "function") {
      try {
        late = (await opts.knownFor(s)) || null
      } catch {
        late = null
      }
    }
    const known = new Map(
      Object.entries({
        ...(opts.knownOpts || {}),
        ...((late && late.knownOpts) || {}),
      }).map(([k, v]) => [key(k), v]),
    )
    const skip = new Set(
      [...(opts.skipProbe || []), ...((late && late.skipProbe) || [])].map(key),
    )
    return { known, skip }
  }
  // RAISED 18 -> 24, measured on Coinbase's Greenhouse form 2026-08-07: it has
  // 23 comboboxes, so the old cap skipped 5 of them outright and each one came
  // back NEEDS-CHOICE with no options — a deferral caused by the cap rather
  // than by anything the form did. The cap exists so a long form cannot spend a
  // minute in here; 24 is the smallest number that clears the largest real
  // form measured to date, which is the right way to move it. It is still a
  // cap, and a form past it still states `probe_skipped: "probe cap"`.
  const probeMax = opts.probeMax === undefined ? 24 : opts.probeMax
  // AND THE BOUND THAT WAS ACTUALLY MEANT IS TIME, NOT COUNT.
  //
  // The line above has always said "a long form should not spend a minute in
  // here", and a COUNT only stands in for that while the per-control ceilings
  // are small. This change moved both in the expensive direction at once — 18
  // -> 24 controls, and 2s -> 6s of click patience plus 5s of scroll — so the
  // pathological form (every control times out) went from ~72s to ~264s. That
  // is a latency regression hiding inside a coverage fix, and it would only
  // ever show up on the slowest boards, which are the ones already hurting.
  //
  // So the stated intent is now enforced directly: the probe stops when the
  // budget is gone, whatever the count. The worst case is back to ~60s plus
  // one in-flight control — what it was before this change — while a HEALTHY
  // 24-combo form (~0.5s each) never approaches the budget and so gains the
  // full coverage the raised cap was for.
  //
  // A field cut by the budget states its own reason rather than looking like a
  // field that was probed and found empty — same rule as the cap.
  const probeBudgetMs =
    opts.probeBudgetMs === undefined ? 60000 : opts.probeBudgetMs
  // The clock is injectable ONLY so the bound is testable. A test that sets a
  // 1ms budget and hopes the loop is slower than that is a coin flip — the
  // stub page probes 26 controls inside a single millisecond on a fast box and
  // inside two on a slow one, which is exactly the flake it produced first
  // time. Nothing in production passes this, so the default is the real clock.
  const nowMs = typeof opts.now === "function" ? opts.now : Date.now
  // The budget spans BOTH passes when a re-render forces a second one: the
  // bound is time in this function, not time per pass.
  const probeStart = nowMs()

  // One probe PASS over `scan`: choose the controls worth opening, open each,
  // read its menu. Returns true when the page re-rendered under it — the
  // stamps it was probing are gone — so the caller can re-scan and run it
  // again. `stats` is per pass on purpose: the numbers describe the scan that
  // is returned, not the one that was thrown away.
  let stats = null
  const probePass = async () => {
    const { known, skip } = await hintsFor(scan)
    // Dead before the first click: the swap landed between the structure scan
    // and here. Nothing to gain from probing nodes that no longer exist.
    if (await stampsLost(scan)) return true
    stats = { probed: 0, cached: 0, skipped: 0, capped: 0, refused: 0 }
    const todo = []
    for (const f of scan.fields || []) {
      if (f.t !== "combo" || (f.opts && f.opts.length)) continue
      // Before anything else, and independent of what the caller asked for: a
      // caller that forgets to pass skipProbe must not be able to make the
      // scanner click Withdraw. See probeRefusal above.
      const refusal = probeRefusal(f)
      if (refusal) {
        f.probe_refused = refusal
        stats.refused++
        continue
      }
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

    // THE ELEMENT WE STAMPED IS NOT ALWAYS THE ELEMENT THAT CARRIES THE ARIA.
    //
    // MEASURED on Coinbase's Greenhouse form (job-boards.greenhouse.io,
    // token 8113286), 2026-08-07: 13 of 19 required combos failed to probe.
    //
    // react-select renders
    //   <div class="select__control">                 <- matches COMBO_SEL, STAMPED
    //     <div class="select__value-container">
    //       <input class="select__input" role="combobox"
    //              aria-controls="react-select-3-listbox" aria-expanded="false">
    // and the wrapper carries NO aria attributes at all. Reading `aria-controls`
    // off the stamped element therefore returned null, so:
    //   * menuOf() found no ids and fell back to a class-name guess;
    //   * `aria-expanded` read null rather than "false", so the chevron-toggle
    //     fallback — the whole Ashby fix above — never fired either.
    // Both halves of the probe were reading the shell and finding nothing.
    //
    // Identity MUST stay on the shell: it is what a human clicks, what
    // scan-page.js stamps, and what every `data-aj` selector resolves to. So the
    // element is not re-chosen — only the ATTRIBUTE READ is redirected, and only
    // when the shell itself is silent. A shell that states its own aria-controls
    // (every Oracle Recruiting Cloud picker, where role=combobox is on the input
    // and the input IS the stamped element) is unaffected: it answers first and
    // the inner lookup never runs.
    const ariaOf = (k, attr) =>
      page
        .evaluate(
          ([ajKey, a]) => {
            const el = document.querySelector('[data-aj="' + ajKey + '"]')
            if (!el || !el.getAttribute) return null
            const own = el.getAttribute(a)
            if (own != null) return own
            const inner =
              el.querySelector &&
              el.querySelector(
                "input[role='combobox'],input[aria-controls],input[aria-expanded]," +
                  "[role='combobox'][aria-controls],[role='combobox'][aria-expanded]",
              )
            return inner ? inner.getAttribute(a) : null
          },
          [k, attr],
        )
        .catch(() => null)

    for (const f of todo) {
      // Checked BEFORE the control is touched, so the budget can only stop work
      // that has not started — never abandon a control mid-probe with a menu
      // left open for the next one to read.
      if (probeBudgetMs > 0 && nowMs() - probeStart > probeBudgetMs) {
        f.probe_skipped = "probe budget"
        stats.capped++
        continue
      }
      const loc = page.locator('[data-aj="' + f.k + '"]')
      // ATTACHED WITHIN 250ms, OR GONE. A stamp that is not on the page by
      // now is not late, it is gone (see the re-render note above): the click
      // below would wait its full 6s for a node that will never come back, and
      // did, on every combo of every Greenhouse embed form. So the pass ends
      // here and the caller re-scans. An attached control resolves this at
      // once; only a dead stamp pays the 250ms.
      const attached = await loc
        .waitFor({ state: "attached", timeout: 250 })
        .then(() => true)
        .catch(() => false)
      if (!attached) return true
      try {
        // NON-FATAL, AND THAT IS THE FIX. Measured on Oracle Recruiting Cloud
        // 2026-08-04: every required picker on the form came back with
        //   probe_error: "locator.scrollIntoViewIfNeeded: Timeout 2000ms exceeded"
        // and no options at all, because this call threw before the click was
        // ever attempted. Scrolling is preparation, not the probe: a control
        // already in view needs none, and one that genuinely cannot be reached
        // fails the CLICK below, which is the honest error and the one whose
        // message tells a reader what actually went wrong. Swallowing it here
        // costs nothing and stops a scroll quirk from reading as "this board
        // refuses to open its menus".
        //
        // 2000 -> 5000, measured on the same Coinbase form: the page is heavy
        // enough that the scroll itself did not settle inside 2s on a control
        // low in a 23-combo form. Non-fatal either way, so the only cost of the
        // old ceiling was arriving at the click before the control was in view.
        await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {})
        // NOT force:true. A forced click skips every actionability check —
        // "is it visible", "is it covered by an overlay", "does it receive
        // pointer events" — which is precisely "click something the user could
        // not have clicked". The scanner has no business doing that before a
        // plan exists. A control that is genuinely unclickable now fails here,
        // is caught below as probe_error, and defers to the user, which is the
        // designed failure mode for a probe.
        //
        // 2000 -> 6000, measured on Coinbase's Greenhouse form 2026-08-07, where
        // the 2s ceiling produced `locator.click: Timeout 2000ms exceeded` on
        // control after control that a human clicks without noticing a delay. A
        // timeout that fires on a clickable control is not a safety property —
        // it defers a field that would have answered. The actionability checks,
        // which ARE the safety property, are unchanged; only the patience is.
        await loc.click({ timeout: 6000 })
        // Wait for the menu to RENDER, not for 300ms. When the control NAMES its
        // menu, wait for that element to be visible — that is this control's own
        // menu rather than a guess, so the wait ends when the thing about to be
        // read is actually on screen. Otherwise react-select's own class: a bare
        // [role=option] also matches the phone country-code widget, which is
        // always in the DOM — so waiting on that would return instantly on every
        // form with a phone field, and reading it would hand every dropdown the
        // same list of countries.
        const menuId = await ariaOf(f.k, "aria-controls")
        const menuSel = menuId
          ? '[id="' +
            String(menuId)
              .split(/\s+/)[0]
              .replace(/(["\\])/g, "\\$1") +
            '"]'
          : "[class*='__option']"
        await page
          .locator(menuSel)
          .first()
          .waitFor({ state: menuId ? "visible" : "attached", timeout: 300 })
          .catch(() => {})
        // THE BOX IS NOT ALWAYS WHAT OPENS THE MENU.
        //
        // MEASURED on Ashby (jobs.ashbyhq.com), 2026-08-04, on a live Render
        // application. Its dropdowns are
        //   <div class="_inputContainer_">
        //     <input role="combobox" aria-expanded="false">
        //     <button class="_toggleButton_"><svg chevron/></button>
        // and clicking the INPUT only focuses it — the menu opens from the
        // button beside it. So every Ashby dropdown probed as zero options and
        // came back NEEDS-CHOICE, blocking the submit on a form whose lists are
        // perfectly readable: an 11-option "How did you hear about us?" was
        // deferred to a human for no reason at all.
        //
        // aria-expanded is the PAGE'S OWN report of whether it opened, which is
        // why it is the trigger rather than "no options were found" — that is
        // also what a genuinely empty menu looks like, and retrying on it would
        // add a click to every empty dropdown on every board.
        //
        // WHAT MAY BE CLICKED IS BOUNDED HARD: a <button> inside the control's
        // OWN container with NO NAME OF ITS OWN. A chevron has none; "Withdraw
        // my application" has plenty. That is exactly the distinction
        // probeRefusal() draws above — a picker is named from outside itself, an
        // action names itself — applied to the toggle instead of to the box, so
        // this can never become a click on a labelled action button.
        const shut = await ariaOf(f.k, "aria-expanded")
        if (shut === "false") {
          const toggleSel = await page.evaluate((k) => {
            const el = document.querySelector('[data-aj="' + k + '"]')
            const box = el && el.parentElement
            if (!box) return null
            const norm = (s) =>
              String(s == null ? "" : s)
                .replace(/\s+/g, " ")
                .trim()
            const cand = [...box.querySelectorAll("button")].find(
              (b) => !norm(b.innerText) && !norm(b.getAttribute("aria-label")),
            )
            if (!cand) return null
            cand.setAttribute("data-aj-toggle", k)
            return '[data-aj-toggle="' + k + '"]'
          }, f.k)
          if (toggleSel) {
            await page.locator(toggleSel).click({ timeout: 6000 })
            // Re-read: a control that was closed may only NAME its menu once it
            // has one.
            const openedId = await ariaOf(f.k, "aria-controls")
            const openedSel = openedId
              ? '[id="' +
                String(openedId)
                  .split(/\s+/)[0]
                  .replace(/(["\\])/g, "\\$1") +
                '"]'
              : menuSel
            await page
              .locator(openedSel)
              .first()
              .waitFor({
                state: openedId ? "visible" : "attached",
                timeout: 300,
              })
              .catch(() => {})
          }
        }
        // THE CUT IS STATED, NOT SILENT. A 200-option country list came back as
        // 40 with nothing recording that anything was dropped, so the field
        // cache stored the short list as the whole list and an answer the form
        // really does offer — past the cut — resolved as "not on offer" and was
        // deferred to the user for no reason. `total` is what the menu actually
        // rendered; the caller flags the field when it exceeds what we kept.
        // READ THE MENU THIS CONTROL NAMES, AND TAKE ITS LEAVES.
        //
        // MIRRORS scan-page.js's optionTexts()/rowsIn() — that file is the
        // canonical statement of the rule and carries the full reasoning; this
        // runs in page context and cannot import it. The two are pinned against
        // each other BEHAVIOURALLY rather than by source text, in
        // tests/apply/oracle-orc.test.mjs: both paths read the same ORC fixture
        // and must return the same list, so a change to one that does not reach
        // the other goes red.
        //
        // WHAT THE OLD VERSION DID ON ORC (measured 2026-08-04): nothing. The
        // rows are not [class*='__option'] and not [role='option'], so `all` was
        // empty and three required pickers were reported with no options —
        // silently, since an empty list is indistinguishable from a menu that
        // did not open.
        // Named so it can run a second time when the first read found only a
        // loading placeholder (below).
        const readMenu = () =>
          page.evaluate((ajKey) => {
            const norm = (s) =>
              String(s == null ? "" : s)
                .replace(/\s+/g, " ")
                .trim()
            const el = document.querySelector('[data-aj="' + ajKey + '"]')
            // The click landed and the page then re-rendered before the read: the
            // stamped node is gone, and whatever menu is on screen now belongs
            // to nobody this pass knows. Say so rather than sweep the page.
            if (!el) return { lost: true }
            const vis = (n) => {
              if (!n || !n.isConnected) return false
              const r = n.getBoundingClientRect()
              const st = getComputedStyle(n)
              return (
                (r.width > 0 || r.height > 0) &&
                st.visibility !== "hidden" &&
                st.display !== "none" &&
                st.opacity !== "0"
              )
            }
            // A container is not a row.
            const leavesOnly = (list) =>
              list.filter(
                (n) =>
                  !list.some((o) => o !== n && n.contains && n.contains(o)),
              )
            // Same redirection as ariaOf() above, for the same measured reason:
            // react-select's stamped shell carries no aria, and the ids live on the
            // inner input. The shell is asked first, so a control that names its
            // own menu is untouched.
            const ariaAttr = (c, a) => {
              if (!c || !c.getAttribute) return ""
              const own = c.getAttribute(a)
              if (own != null) return own
              const inner =
                c.querySelector &&
                c.querySelector(
                  "input[role='combobox'],input[aria-controls],input[aria-owns]," +
                    "[role='combobox'][aria-controls],[role='combobox'][aria-owns]",
                )
              return (inner && inner.getAttribute(a)) || ""
            }
            const menuOf = (c) => {
              if (!c || !c.getAttribute) return null
              const ids = norm(
                ariaAttr(c, "aria-controls") || ariaAttr(c, "aria-owns") || "",
              ).split(/\s+/)
              for (const id of ids) {
                if (!id) continue
                let m = null
                try {
                  m = document.getElementById(id)
                } catch {}
                if (m && vis(m)) return m
              }
              return null
            }
            // THE MENU IS NOT ALWAYS INSIDE THE CONTROL.
            //
            // MEASURED on the same Coinbase form: react-select renders
            // `.select__menu` in a PORTAL — a sibling of <body>, not a descendant
            // of the control's container — so every container-scoped lookup misses
            // it, and when the control names no menu there is nothing left to read
            // but the page-wide selector list.
            //
            // ONLY ONE MENU IS OPEN AT A TIME. That is what makes this safe rather
            // than a guess: the probe opens exactly one control, reads it, and
            // presses Escape before the next. So a SINGLE visible menu-list on the
            // page is unambiguously the one just opened. Two or more visible means
            // the assumption does not hold — a stale menu, or a board that renders
            // several at once — and this declines to choose between them and falls
            // through to the existing page-wide read, which is what happens today.
            const portalMenu = () => {
              let found = []
              try {
                found = [
                  ...document.querySelectorAll(
                    "[class*='select__menu-list'],[class*='Select__menu-list']",
                  ),
                ].filter(vis)
              } catch {
                return null
              }
              return found.length === 1 ? found[0] : null
            }
            const rowsIn = (menu) => {
              const declared = [...menu.querySelectorAll("[role='option']")]
              if (declared.length) return declared
              const nodes = [...menu.querySelectorAll("*")]
              if (nodes.length > 400) return leavesOnly(nodes.filter(vis))
              const out = []
              const seen = new Set()
              for (const n of nodes) {
                const t = norm(n.innerText)
                if (!t) continue
                let leaf = true
                for (const c of n.querySelectorAll("*")) {
                  if (norm(c.innerText)) {
                    leaf = false
                    break
                  }
                }
                if (!leaf) continue
                let best = n
                for (
                  let p = n.parentElement;
                  p && p !== menu;
                  p = p.parentElement
                ) {
                  if (norm(p.innerText) !== t) break
                  best = p
                }
                if (seen.has(best)) continue
                seen.add(best)
                out.push(best)
              }
              return out
            }
            const menu = menuOf(el) || portalMenu()
            const rows = menu
              ? rowsIn(menu)
              : leavesOnly([
                  ...document.querySelectorAll(
                    "[role='option'],[role='listbox'] li,[class*='__option'],[class*='menu'] li",
                  ),
                ])
            // AN EMPTY-STATE MESSAGE IS NOT AN OPTION.
            //
            // MEASURED on Ashby, 2026-08-04. An async Location typeahead opened
            // with no query renders
            //   <div role="listbox"><div class="_noResults_"><p>No results</p>
            // and declares NO [role=option] at all — so the leaf fallback above,
            // which exists for menus that genuinely do not use role=option, read
            // the decoration and returned ["No results"] AS THE OPTION LIST.
            //
            // That is worse than returning nothing. The field cache stores a
            // returned list as the COMPLETE one, so the real answer then resolves
            // as "not on offer" and the field defers on every future application
            // to this board — the same silent-wrongness the truncation note below
            // is about, arrived at from the other end.
            //
            // The filter only ever REMOVES, so its failure mode is a field that
            // defers rather than one filled with a wrong value, which is the
            // direction this pipeline always errs in.
            //
            // "LOADING..." IS NOT AN OPTION EITHER. MEASURED on Greenhouse embed
            // forms 2026-08-18 (Torc, Cloudflare): School / Degree / Discipline
            // are async lists whose menu mounts at once with a single
            //   <div class="select__menu-notice--loading">Loading...</div>
            // and fills in later. The read landed inside that window and the
            // field cache stored ["Loading..."] as the COMPLETE list — the
            // "No results" defect above, from the other end. Filtered here, and
            // reported as `loading` so the caller can wait for the rows once.
            const EMPTY_STATE =
              /^(no results?|no options?|no matches?|nothing found|start typing|type to search|loading\b)/i
            const shown = rows.filter(vis).map((e) => norm(e.innerText))
            const loading = shown.some((t) => /^loading\b/i.test(t))
            const all = [
              ...new Set(
                shown
                  .map((t) => t.slice(0, 60))
                  .filter((t) => t && !EMPTY_STATE.test(t)),
              ),
            ]
            // 250, raised from 40 on 2026-08-21 (with scan-page.js MAX_OPTS):
            // a 197-row country list cut to 40 lost the one option the banked
            // answer named, and the field deferred on every run. The cap
            // bounds pathological lists; optsTruncated still states any cut.
            return { opts: all.slice(0, 250), total: all.length, loading }
          }, f.k)
        let raw = await readMenu()
        // A page.evaluate return is DATA FROM THE PAGE and its shape is never
        // assumed: an unexpected one used to become `probe_error` on every
        // dropdown at once, which reads as "this board refuses to open its
        // menus" and is indistinguishable from the real thing. A bare array is
        // the shape this returned before the truncation flag existed.
        if (raw && raw.lost === true) {
          // Close whatever opened, then hand the pass back to the caller: the
          // node this menu belonged to is gone, and so is every other stamp.
          await page.keyboard.press("Escape").catch(() => {})
          return true
        }
        // ROWS THAT HAVE NOT ARRIVED YET ARE NOT AN EMPTY LIST. Only a menu
        // showing a loading notice and nothing else earns the second read, and
        // the wait is a condition with a ceiling — the notice must go away —
        // never a sleep. A list that never arrives is left as unprobed, which
        // is the honest answer for it.
        if (
          raw &&
          raw.loading === true &&
          !(Array.isArray(raw.opts) && raw.opts.length)
        ) {
          await page
            .waitForFunction(
              () =>
                ![
                  ...document.querySelectorAll(
                    "[class*='menu'] *,[role='listbox'] *",
                  ),
                ].some(
                  (n) =>
                    n.getClientRects().length &&
                    /^loading\b/i.test(String(n.innerText || "").trim()),
                ),
              undefined,
              { polling: 100, timeout: 1500 },
            )
            .catch(() => {})
          raw = await readMenu()
          if (raw && raw.lost === true) {
            await page.keyboard.press("Escape").catch(() => {})
            return true
          }
        }
        const found = Array.isArray(raw)
          ? { opts: raw, total: raw.length }
          : {
              opts: Array.isArray(raw && raw.opts) ? raw.opts : [],
              total: Number((raw && raw.total) || 0),
            }
        if (found.opts.length) f.opts = found.opts
        if (found.total > found.opts.length) {
          f.optsTruncated = true
          f.optsTotal = found.total
        }
        stats.probed++
        await page.keyboard.press("Escape")
        // Stop the NEXT dropdown's probe from reading THIS menu's rows. The read
        // above falls back to a document-wide sweep whenever it cannot find the
        // control's own menu, so a menu still on screen when the next control is
        // clicked can hand its options to the wrong field — and a returned list
        // is cached as the COMPLETE one, so that field then defers on every
        // future application to the board. Same silent-wrongness as the
        // empty-state note above, reached from the other end.
        //
        // IT DOES NOT EXIT EARLY, AND DID NOT ON ANY RUN MEASURED. MEASURED
        // 2026-08-13 against all four page fixtures: every one renders the menu
        // as a static container toggled with `hidden`, so the rows are never
        // removed from the DOM and `detached` cannot fire. Three consecutive
        // scans of greenhouse-step1 paid 82.5, 82.2 and 81.9ms of the 80ms
        // ceiling. The guard still lands — 80ms is long enough for any menu to
        // close — but it lands on the TIMEOUT, which makes this exactly the flat
        // sleep the early exit was written to replace. Real react-select unmounts
        // its menu and would detach; whether the live boards do was not checked.
        //
        // DO NOT "FIX" THAT BY SWITCHING TO state:"hidden" ALONE. Playwright
        // reads hidden as "not visible OR not in the DOM", and this locator is
        // page-wide with .first(), so it resolves against the first __option in
        // DOM order — on a form carrying a persistent country-code widget (the
        // one the open wait above already dodges) that element is ALREADY
        // hidden, the wait returns instantly, and the guard is silently gone
        // while the scan merely looks 80ms faster per dropdown. Scoping this to
        // the control's own menu via aria-controls, as the open wait does, is a
        // precondition for that change and not an independent improvement.
        await page
          .locator("[class*='__option']")
          .first()
          .waitFor({ state: "detached", timeout: 80 })
          .catch(() => {})
      } catch (e) {
        f.probe_error = String(e.message).slice(0, 60)
      }
    }
    // The pass is over; are the stamps it leaves behind still on the page? A
    // swap that landed after the last control was clicked would otherwise hand
    // the planner a scan whose keys resolve to nothing at fill time.
    return stampsLost(scan)
  }

  // Run the pass; if the page re-rendered under it, re-scan ONCE and run it
  // again over the fresh stamps. See the re-render note above for the bound.
  let rescans = 0
  for (;;) {
    const lost = await probePass()
    if (!lost) break
    if (rescans >= 1) {
      scan.signals = [
        ...(scan.signals ?? []),
        "page re-rendered again after a re-scan; stamps may not resolve at fill time",
      ]
      break
    }
    await settleAfterRerender()
    scan = await runScan(false)
    rescans++
    scan.signals = [
      ...(scan.signals ?? []),
      "page re-rendered after the structure scan (hydration); re-scanned and re-probed",
    ]
  }
  scan.probe = {
    ...(stats ?? { probed: 0, cached: 0, skipped: 0, capped: 0, refused: 0 }),
    rescans,
  }

  // --- THE VOUCH LEAVES OUT OF BAND -----------------------------------------
  //
  // `labelExact` used to travel as a boolean INSIDE the scan, and a boolean
  // inside the data that crosses a trust boundary is not a boundary — it is a
  // field, and every producer of a scan object can set it. There are three
  // producers: this file, .claude/skills/apply-job/scan.driver.mjs, and the
  // bare `browser_evaluate () => window.__ajScan(false)` re-scan that
  // apply-job/SKILL.md documents for page 2 onward, which runs neither of the
  // other two and whose output still becomes scan-p<N>.json.
  //
  // So the vouch is now a SECOND RETURN VALUE. `vouchedLabels` is an array of
  // complete visible label strings, held in this process. It never goes into
  // the page, it is never stashed, and it is not in the scan written to disk.
  // buildPlan takes it as an explicit parameter and ignores
  // scan.fields[].labelExact entirely — so a scan file, however it was
  // produced and whoever wrote it, can no longer assert anything.
  //
  // It is collected ONLY when `expr` is set, i.e. when the scanner was called
  // through a local binding and we therefore know whose function answered.
  const vouchedLabels = []
  if (expr) {
    const seen = new Set()
    for (const f of scan.fields || []) {
      if (f.labelExact !== true) continue
      const l = String(f.l ?? "")
      if (!l || seen.has(l)) continue
      seen.add(l)
      vouchedLabels.push(l)
    }
  }
  untrustScan(
    scan,
    expr
      ? "the vouch is carried out of band and is not in this file"
      : "the scanner was called through window.__ajScan",
  )

  // Stashed so the scan can be written to disk without paying for it twice:
  //   browser_evaluate { function: "() => window.__ajLastScan",
  //                      filename: "scan-p1.json" }
  // Nothing above survives into it, so the getter risk on __ajLastScan is now
  // only about the scan's DATA, which was always the page's to write anyway.
  await page.evaluate((s) => (window.__ajLastScan = s), scan)
  return { scan, vouchedLabels }
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
