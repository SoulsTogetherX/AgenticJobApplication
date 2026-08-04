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

  // --- which dropdowns are worth opening ------------------------------------
  // Probing is the most expensive part of a scan: a real click plus the menu
  // render, per dropdown, up to 18 of them. Options only exist to CHOOSE an
  // answer, so a dropdown whose answer is already known does not need any:
  // `knownOpts` is what the field cache remembers about this form, `skipProbe`
  // is the labels the fact base already resolves. A field nobody has told us
  // about is still probed — too little information is the expensive failure
  // here, not too much.
  const known = new Map(
    Object.entries(opts.knownOpts || {}).map(([k, v]) => [key(k), v]),
  )
  const skip = new Set((opts.skipProbe || []).map(key))
  const probeMax = opts.probeMax === undefined ? 18 : opts.probeMax

  const stats = { probed: 0, cached: 0, skipped: 0, capped: 0, refused: 0 }
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

  for (const f of todo) {
    const loc = page.locator('[data-aj="' + f.k + '"]')
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
      await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {})
      // NOT force:true. A forced click skips every actionability check —
      // "is it visible", "is it covered by an overlay", "does it receive
      // pointer events" — which is precisely "click something the user could
      // not have clicked". The scanner has no business doing that before a
      // plan exists. A control that is genuinely unclickable now fails here,
      // is caught below as probe_error, and defers to the user, which is the
      // designed failure mode for a probe.
      await loc.click({ timeout: 2000 })
      // Wait for the menu to RENDER, not for 300ms. When the control NAMES its
      // menu, wait for that element to be visible — that is this control's own
      // menu rather than a guess, so the wait ends when the thing about to be
      // read is actually on screen. Otherwise react-select's own class: a bare
      // [role=option] also matches the phone country-code widget, which is
      // always in the DOM — so waiting on that would return instantly on every
      // form with a phone field, and reading it would hand every dropdown the
      // same list of countries.
      const menuId = await loc.getAttribute("aria-controls").catch(() => null)
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
      const raw = await page.evaluate((ajKey) => {
        const norm = (s) =>
          String(s == null ? "" : s)
            .replace(/\s+/g, " ")
            .trim()
        const el = document.querySelector('[data-aj="' + ajKey + '"]')
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
            (n) => !list.some((o) => o !== n && n.contains && n.contains(o)),
          )
        const menuOf = (c) => {
          if (!c || !c.getAttribute) return null
          const ids = norm(
            c.getAttribute("aria-controls") ||
              c.getAttribute("aria-owns") ||
              "",
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
        const menu = menuOf(el)
        const rows = menu
          ? rowsIn(menu)
          : leavesOnly([
              ...document.querySelectorAll(
                "[role='option'],[role='listbox'] li,[class*='__option'],[class*='menu'] li",
              ),
            ])
        const all = [
          ...new Set(
            rows
              .filter(vis)
              .map((e) => norm(e.innerText).slice(0, 60))
              .filter(Boolean),
          ),
        ]
        return { opts: all.slice(0, 40), total: all.length }
      }, f.k)
      // A page.evaluate return is DATA FROM THE PAGE and its shape is never
      // assumed: an unexpected one used to become `probe_error` on every
      // dropdown at once, which reads as "this board refuses to open its
      // menus" and is indistinguishable from the real thing. A bare array is
      // the shape this returned before the truncation flag existed.
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
