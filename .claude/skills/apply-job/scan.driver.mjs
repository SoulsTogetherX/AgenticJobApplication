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
  const runScan = () => page.evaluate(() => window.__ajScan(false))
  let scan = await runScan()
  if (!scan.btns || !scan.btns.length) {
    await page
      .locator("button, [role='button'], input[type=submit]")
      .first()
      .waitFor({ state: "attached", timeout: 1500 })
      .catch(() => {})
    scan = await runScan()
  }

  // THE PAGE MAY RE-RENDER ITSELF UNDER THE SCAN — mirrored from
  // scripts/apply/scan-engine.mjs, which carries the measurement. In short:
  // Greenhouse's embed form (a Remix app) replaces its whole document root
  // ~200ms after `load`, with or without a scanner on the page, so every
  // data-aj stamp the structure scan wrote is on a node that no longer exists
  // and every probe click waited its full 6s for nothing. Detected cheaply
  // (stamp count before and after the pass, an attached-check per control),
  // then ONE re-scan over the fresh nodes and the pass runs again. A page that
  // never re-renders pays nothing.
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
  // A CONDITION WITH A CEILING, not a sleep: the control count must read the
  // same on two consecutive polls 150ms apart (so at least one poll interval
  // passes), bounded at 2s. Only ever paid by a page that lost its stamps.
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

  // THE BOUND THAT WAS ACTUALLY MEANT IS TIME, NOT COUNT — mirrored from
  // scan-engine.mjs, which carries the reasoning. In short: the cap has always
  // stood in for "a long form should not spend a minute in here", and raising
  // it 18 -> 24 alongside 2s -> 6s of click patience took the pathological
  // form from ~72s to ~264s. The budget enforces the stated intent directly,
  // so the worst case returns to ~60s while a healthy form keeps the coverage.
  // It spans both passes when a re-render forces a second one.
  const probeBudgetMs = 60000
  const probeStart = Date.now()

  // One probe PASS over `scan`; returns true when the page re-rendered under
  // it (its stamps are gone) so the caller can re-scan and run it again.
  // `stats` is per pass: the numbers describe the scan that is returned.
  let stats = null
  const probePass = async () => {
  if (await stampsLost(scan)) return true
  stats = { probed: 0, cached: 0, skipped: 0, capped: 0, refused: 0 }
  const todo = []
  for (const f of scan.fields || []) {
    if (f.t !== "combo" || (f.opts && f.opts.length)) continue
    const refusal = probeRefusal(f)
    if (refusal) {
      f.probe_refused = refusal
      stats.refused++
      continue
    }
    // 18 -> 24, mirrored from scan-engine.mjs, which carries the measurement:
    // Coinbase's Greenhouse form has 23 combos, so the old cap skipped 5 and
    // deferred them for no reason the form was responsible for.
    if (todo.length >= 24) {
      f.probe_skipped = "probe cap"
      stats.capped++
      continue
    }
    todo.push(f)
  }

  // THE ELEMENT WE STAMPED IS NOT ALWAYS THE ELEMENT THAT CARRIES THE ARIA —
  // mirrored from scripts/apply/scan-engine.mjs, which carries the full
  // reasoning. In short, measured on Coinbase's Greenhouse form 2026-08-07:
  // react-select stamps the `.select__control` shell, which has no aria at all,
  // while `aria-controls`/`aria-expanded` live on the inner `input.select__input`.
  // Reading them off the shell returned null, so the menu was never named AND
  // the chevron-toggle fallback never fired — 13 of 19 required combos failed.
  // Identity stays on the shell; only the ATTRIBUTE READ is redirected, and
  // only when the shell itself is silent.
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
    if (probeBudgetMs > 0 && Date.now() - probeStart > probeBudgetMs) {
      f.probe_skipped = "probe budget"
      stats.capped++
      continue
    }
    const loc = page.locator('[data-aj="' + f.k + '"]')
    // ATTACHED WITHIN 250ms, OR GONE — mirrored from scan-engine.mjs: a stamp
    // not on the page by now is on a node the page threw away; the pass ends
    // and the caller re-scans. An attached control resolves this at once.
    const attached = await loc
      .waitFor({ state: "attached", timeout: 250 })
      .then(() => true)
      .catch(() => false)
    if (!attached) return true
    try {
      // NON-FATAL — mirrored from scan-engine.mjs, which carries the
      // measurement: on Oracle Recruiting Cloud this threw before the click was
      // ever attempted and every required picker came back as a probe_error
      // with no options. Scrolling is preparation, not the probe.
      //
      // 2000 -> 5000 and 2000 -> 6000 below, mirrored from the engine: measured
      // on Coinbase's Greenhouse form 2026-08-07, the 2s ceilings fired on
      // controls a human clicks without noticing a delay, and a timeout that
      // fires on a clickable control defers a field that would have answered.
      await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {})
      // NOT force:true — a forced click skips every actionability check, which
      // is "click something the user could not have clicked". See the engine.
      // The actionability checks are the safety property and are unchanged;
      // only the patience moved.
      await loc.click({ timeout: 6000 })
      // Wait for the menu to RENDER, not for a flat 300ms. When the control
      // NAMES its menu (aria-controls), wait for that element: it is this
      // control's own menu rather than a guess. Otherwise react-select's own
      // class — a bare [role=option] also matches the phone country-code
      // widget, which is always in the DOM, so waiting on that would return
      // instantly on every form with a phone field, and reading it would hand
      // every dropdown the same list of countries.
      const menuId = await ariaOf(f.k, "aria-controls")
      const menuSel = menuId
        ? '[id="' + String(menuId).split(/\s+/)[0].replace(/(["\\])/g, "\\$1") + '"]'
        : "[class*='__option']"
      await page
        .locator(menuSel)
        .first()
        .waitFor({ state: menuId ? "visible" : "attached", timeout: 300 })
        .catch(() => {})
      // THE BOX IS NOT ALWAYS WHAT OPENS THE MENU — mirrored from
      // scripts/apply/scan-engine.mjs, which carries the full reasoning. In
      // short, measured on Ashby 2026-08-04: the menu opens from a chevron
      // BUTTON beside the combobox, not from the box, so every Ashby dropdown
      // probed as zero options and deferred to a human for no reason. The
      // trigger is aria-expanded — the page's own report — and the only thing
      // this may click is a button inside the control's own container with no
      // name of its own, which is a chevron and never a labelled action.
      const shut = await ariaOf(f.k, "aria-expanded")
      if (shut === "false") {
        const toggleSel = await page.evaluate((k) => {
          const el = document.querySelector('[data-aj="' + k + '"]')
          const box = el && el.parentElement
          if (!box) return null
          const norm = (s) =>
            String(s == null ? "" : s).replace(/\s+/g, " ").trim()
          const cand = [...box.querySelectorAll("button")].find(
            (b) => !norm(b.innerText) && !norm(b.getAttribute("aria-label")),
          )
          if (!cand) return null
          cand.setAttribute("data-aj-toggle", k)
          return '[data-aj-toggle="' + k + '"]'
        }, f.k)
        if (toggleSel) {
          await page.locator(toggleSel).click({ timeout: 6000 })
          const openedId = await ariaOf(f.k, "aria-controls")
          const openedSel = openedId
            ? '[id="' + String(openedId).split(/\s+/)[0].replace(/(["\\])/g, "\\$1") + '"]'
            : menuSel
          await page
            .locator(openedSel)
            .first()
            .waitFor({ state: openedId ? "visible" : "attached", timeout: 300 })
            .catch(() => {})
        }
      }
      // THE CUT IS STATED, NOT SILENT — mirrored from scan-engine.mjs, which
      // carries the reasoning: 40 survivors of a 200-option country list are
      // indistinguishable from a genuine 40-option list, so the cache stores
      // the short list as complete and an answer past the cut is deferred as
      // unofferable.
      //
      // SO IS THE OPTION READ ITSELF, mirrored from the same file and from
      // scan-page.js's optionTexts(): read the menu the control NAMES and take
      // its LEAVES. The old page-wide selector list returned every ORC option
      // as one 60-character blob, because the only <li> inside the listbox is
      // the scroller that holds them all and a container's text is not an
      // option.
      // Named so it can run a second time when the first read found only a
      // loading placeholder (below) — mirrored from scan-engine.mjs.
      const readMenu = () =>
        page.evaluate((ajKey) => {
        const norm = (s) =>
          String(s == null ? "" : s)
            .replace(/\s+/g, " ")
            .trim()
        const el = document.querySelector('[data-aj="' + ajKey + '"]')
        // Re-rendered between the click and the read: say so, sweep nothing.
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
        const leavesOnly = (list) =>
          list.filter(
            (n) => !list.some((o) => o !== n && n.contains && n.contains(o)),
          )
        // Same redirection as ariaOf() above, mirrored from scan-engine.mjs:
        // react-select's stamped shell carries no aria, the ids live on the
        // inner input. The shell answers first, so a control that names its own
        // menu is untouched.
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
        // THE MENU IS NOT ALWAYS INSIDE THE CONTROL — mirrored from
        // scan-engine.mjs, which carries the reasoning. react-select renders
        // `.select__menu` in a PORTAL, a sibling of <body>, so every
        // container-scoped lookup misses it. Safe because the probe opens
        // exactly ONE control at a time and Escapes before the next, so a
        // SINGLE visible menu-list is unambiguously the one just opened; two or
        // more means that assumption does not hold, and this declines to choose
        // and falls through to the page-wide read.
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
            for (let p = n.parentElement; p && p !== menu; p = p.parentElement) {
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
        // AN EMPTY-STATE MESSAGE IS NOT AN OPTION — mirrored from
        // scripts/apply/scan-engine.mjs, which carries the reasoning. Measured
        // on Ashby 2026-08-04: an async typeahead opened with no query renders
        // a "No results" box and declares no [role=option], so the leaf
        // fallback read the decoration and returned it as the option list.
        // The cache would then store that as the COMPLETE list and the real
        // answer would resolve as "not on offer" forever. Removal-only, so it
        // can only cause a defer, never a wrong fill.
        // "Loading..." is not an option either — mirrored from scan-engine.mjs
        // (Greenhouse's async School / Degree / Discipline lists mount with a
        // loading notice and fill in later); reported as `loading` so the
        // caller can wait for the rows once.
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
        // 250, raised from 40 on 2026-08-21 in step with scan-engine.mjs and
        // scan-page.js MAX_OPTS — a 197-row country list cut to 40 lost the
        // banked answer's option. optsTruncated still states any cut.
        return { opts: all.slice(0, 250), total: all.length, loading }
      }, f.k)
      let raw = await readMenu()
      if (raw && raw.lost === true) {
        await page.keyboard.press("Escape").catch(() => {})
        return true
      }
      // Rows that have not arrived yet are not an empty list — a condition
      // with a ceiling (the loading notice must go away), then ONE re-read.
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
      const opts = Array.isArray(raw) ? raw : (raw && raw.opts) || []
      const total = Array.isArray(raw) ? raw.length : Number((raw && raw.total) || 0)
      if (opts.length) f.opts = opts
      if (total > opts.length) {
        f.optsTruncated = true
        f.optsTotal = total
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
  return stampsLost(scan)
  }

  // Run the pass; if the page re-rendered under it, re-scan ONCE and run it
  // again over the fresh stamps — mirrored from scan-engine.mjs.
  let rescans = 0
  for (;;) {
    const lost = await probePass()
    if (!lost) break
    if (rescans >= 1) {
      scan.signals = (scan.signals || []).concat(
        "page re-rendered again after a re-scan; stamps may not resolve at fill time",
      )
      break
    }
    await settleAfterRerender()
    scan = await runScan()
    rescans++
    scan.signals = (scan.signals || []).concat(
      "page re-rendered after the structure scan (hydration); re-scanned and re-probed",
    )
  }
  scan.probe = Object.assign(
    {},
    stats || { probed: 0, cached: 0, skipped: 0, capped: 0, refused: 0 },
    { rescans },
  )

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
