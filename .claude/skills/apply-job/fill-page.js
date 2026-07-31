// Deterministic form filler. Executes a plan built by scripts/apply/fill-plan.mjs;
// makes no decisions of its own, so the model is not in this loop.
//
// It is written as a real function and shipped as SOURCE: scripts/apply/
// fill-plan.mjs reads this file's text off disk (an ordinary Node process,
// outside any sandbox) and embeds it as a string in the generated
// jobs/<slug>/fill-plan.js bootstrap, loaded whole via
// `browser_run_code_unsafe { filename }`. That bootstrap injects the embedded
// string into the page with page.evaluate((s) => { (0, eval)(s); }, s), reads
// window.__ajFillSrc back out, and eval's it Playwright-side where `page` and
// real locators exist. Everything here must therefore be self-contained — no
// closure over module scope, no imports.
//
// NOT page.addScriptTag({ path }): that inserts a real inline <script>
// element, which a nonce-based CSP board refuses to execute outright (Ashby:
// "Executing inline script violates the following Content Security Policy
// directive 'script-src 'nonce-...' https://cdn.ashbyprd.com ...'").
// page.evaluate instead drives the page over CDP (Runtime.evaluate), which is
// not a script the page itself loaded, so the page's CSP does not gate it —
// the same reason a browser's own DevTools console can run arbitrary code on
// a CSP-locked page. Verified live: this loads on both Greenhouse (addScriptTag
// happened to work there too) and Ashby (addScriptTag fails outright; this
// does not). Do not "fix" the loading path back to addScriptTag/addInitScript
// — see scripts/apply/fill-plan.mjs's buildDriverSource() for the other half.
//
// Sandbox notes: the Playwright MCP vm context (browser_run_code_unsafe) has
// `page` and the standard built-ins, but NO setTimeout, console, or require.
// Use page.waitForTimeout. There is also no default action timeout in that
// context (stock 30s applies), so every locator call passes an explicit one.
//
// Dynamic import is not a usable substitute for the missing `require`, and
// this was verified rather than assumed: reading playwright-core's own
// runCode.ts (packages/playwright-core/src/tools/backend/runCode.ts, bundled
// into playwright-core/lib/coreBundle.js) shows it calling
// `vm.runInContext("(" + code + ")", context2)` with no third argument, so no
// `importModuleDynamically` callback is ever supplied. Reproducing that exact
// call confirms a bare `await import("node:fs")` at the top level compiles
// fine but THROWS AT CALL TIME with ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING —
// unconditionally, and identically whether the code arrived via the tool's
// `code` parameter or its `filename` parameter, since both converge on that
// same call (`filename` only changes how the `code` string is populated —
// via a real, unrestricted `fs.readFile` done by the MCP server BEFORE this
// point, which is a one-time read of whatever single file `filename` names,
// not something the driver can invoke a second time for another file). There
// is no in-sandbox fix for this; it is fixed behavior of the installed
// @playwright/mcp version. The actual fix is to keep file I/O OUTSIDE this vm
// entirely — fill-plan.mjs (an ordinary, unrestricted Node process) reads
// this file and the plan and embeds both as strings in the generated
// bootstrap, so nothing in here ever needs fs/require/import.
//
// WHY the odd interaction choices (learned the hard way on Greenhouse):
//   - dispatchEvent(new MouseEvent(...)) does NOT register in React state; the
//     value appears on screen and the field still validates as empty.
//   - Custom dropdowns need real input events: locator.click(), keyboard.type(),
//     keyboard.press('Enter') — verified against react-select.
//   - locator.setInputFiles() DOES register with React (verified on Greenhouse:
//     the input is swapped for the attached-file view). Do not "fix" this into
//     a real file chooser — Playwright MCP owns the filechooser event, so a
//     waitForEvent in here never fires and stalls the call as a pending modal.
//   - Uploads remount the form, and data-aj stamps do not survive that; hence
//     uploads first, and sel-first resolution everywhere else.
//   - A stale/detached-element error right after locate() (seen on Ashby:
//     resume-autofill parses the uploaded PDF and remounts the form
//     asynchronously, after the upload settle delay already waited for the
//     upload itself) is retried ONCE with a freshly re-resolved locator before
//     it counts as a real failure — see isStaleError below. fill/select/check
//     are idempotent, so replaying one item is safe.
//
// SAFETY: there is deliberately no verb that clicks a button. "Never click
// submit" is not a rule this engine follows — it is a thing it cannot express.
window.__ajFillSrc = String(async (page, plan) => {
  const out = {
    ok: 0,
    failed: 0,
    deferred: (plan.defer || []).length,
    ms: 0,
    url: page.url(),
    failures: [],
    verify: { mismatch: [], errors: [], requiredEmpty: [] },
    defer: plan.defer || [],
    next: null,
    signals: [],
  }
  const started = Date.now()
  const items = plan.items || []

  // A plan is built against one specific form. Filling a different page with
  // it would silently put answers in the wrong fields.
  const bare = (u) =>
    String(u || "")
      .split("#")[0]
      .split("?")[0]
  if (plan.urlGuard && bare(plan.urlGuard) !== bare(page.url())) {
    out.failed++
    out.failures.push({
      k: "-",
      how: "guard",
      why: "plan built for " + plan.urlGuard + " but page is " + page.url(),
    })
    out.ms = Date.now() - started
    return out
  }

  // sel first: it is app-owned and survives remounts. data-aj is only a
  // fallback, and only valid while no re-scan has renumbered the keys.
  const locate = async (item) => {
    const cands = []
    if (item.sel) cands.push(item.sel)
    if (item.k) cands.push('[data-aj="' + item.k + '"]')
    for (const sel of cands) {
      try {
        const loc = page.locator(sel)
        if ((await loc.count()) === 1) return loc
      } catch {}
    }
    return null
  }

  // Refuse anything that is not a real form control, whatever the plan says.
  const kindOf = (loc) =>
    loc.evaluate((el) => {
      const tag = el.tagName.toLowerCase()
      if (tag === "input" || tag === "textarea" || tag === "select") return tag
      if (el.isContentEditable) return "richtext"
      const cls = String(el.className || "")
      if (
        el.getAttribute("role") === "combobox" ||
        el.getAttribute("aria-haspopup") === "listbox" ||
        /select__control|Select__control/.test(cls)
      ) {
        return "combo"
      }
      return "forbidden:" + tag
    })

  const shownValue = (loc) =>
    loc.evaluate((el) => {
      const tag = el.tagName.toLowerCase()
      if (tag === "input" && (el.type === "checkbox" || el.type === "radio")) {
        return el.checked ? "true" : ""
      }
      if (tag === "input" || tag === "textarea" || tag === "select") {
        return el.value || ""
      }
      const sv = el.querySelector(
        "[class*='single-value'], [class*='singleValue']",
      )
      return (sv ? sv.innerText : el.innerText || "").trim()
    })

  const fail = (item, why) => {
    out.failed++
    out.failures.push({
      k: item.k,
      how: item.how,
      why: String(why).slice(0, 140),
    })
  }

  const norm = (s) =>
    String(s || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()

  // --- combo strategies ----------------------------------------------------
  // Ordered per-ATS by the planner. Every one of these drives the widget with
  // real input events, which is the whole point.
  const openCombo = async (loc) => {
    await loc.scrollIntoViewIfNeeded({ timeout: 2500 })
    await loc.click({ timeout: 2500 })
    await page.waitForTimeout(220)
  }
  const optionLocator = (value) =>
    page
      .locator("[class*='__option'], [role='option']")
      .filter({ hasText: value })
      .first()

  const strategies = {
    // Typeahead: filter the list, then commit the highlighted row.
    "type-enter": async (loc, value) => {
      await openCombo(loc)
      await page.keyboard.type(String(value).slice(0, 60), { delay: 20 })
      await page.waitForTimeout(500)
      await page.keyboard.press("Enter")
    },
    // Filter, then click the exact row — safer when Enter picks a near-match.
    "type-click": async (loc, value) => {
      await openCombo(loc)
      await page.keyboard.type(String(value).slice(0, 40), { delay: 20 })
      await page.waitForTimeout(500)
      await optionLocator(value).click({ timeout: 2500 })
    },
    // Short lists that do not filter at all.
    "click-option": async (loc, value) => {
      await openCombo(loc)
      await optionLocator(value).click({ timeout: 2500 })
    },
  }

  const setCombo = async (loc, item) => {
    const order = plan.comboStrategies || [
      "type-enter",
      "type-click",
      "click-option",
    ]
    let last = "no strategy ran"
    for (const name of order) {
      const run = strategies[name]
      if (!run) continue
      try {
        await run(loc, item.value)
        await page.waitForTimeout(200)
        const got = await shownValue(loc)
        if (
          got &&
          (norm(got) === norm(item.value) ||
            norm(got).includes(norm(item.value)))
        ) {
          return { ok: true, via: name }
        }
        last = "after " + name + ' the field reads "' + got + '"'
      } catch (e) {
        last = name + ": " + e.message
      }
      // Leave the widget closed before the next attempt.
      try {
        await page.keyboard.press("Escape")
        await page.waitForTimeout(120)
      } catch {}
    }
    return { ok: false, why: last }
  }

  // --- uploads go first ----------------------------------------------------
  // They trigger the remount that invalidates every data-aj on the page, so
  // doing them last would corrupt everything already filled.
  // The input is found by the text AROUND it rather than by a stamp, because
  // the first upload remounts the form and invalidates every stamp on the page
  // — including the one for the second upload.
  //
  // setInputFiles, NOT the real file chooser: Playwright MCP installs its own
  // filechooser handler, so a page.waitForEvent("filechooser") in here never
  // fires — it just stalls the whole call as a pending modal. Verified on
  // Greenhouse that React does process the resulting change event and swaps
  // the input out for the attached-file view.
  const stampInput = (pattern, tag) =>
    page.evaluate(
      (arg) => {
        const re = new RegExp(arg.pattern, "i")
        const inputs = [...document.querySelectorAll("input[type=file]")]
        for (const el of inputs) {
          let n = el
          for (let i = 0; i < 8 && n; i++) {
            n = n.parentElement
            if (!n) break
            const s = (n.innerText || "").replace(/\s+/g, " ").trim()
            if (s && re.test(s)) {
              el.setAttribute("data-ajup", arg.tag)
              return true
            }
          }
        }
        // Some boards put the heading outside anything the walk can reach;
        // fall back to the first input still awaiting a file, in plan order.
        if (inputs.length) {
          inputs[0].setAttribute("data-ajup", arg.tag)
          return true
        }
        return false
      },
      { pattern, tag },
    )

  let uploadN = 0
  for (const item of items.filter((i) => i.how === "upload")) {
    const tag = "u" + ++uploadN
    const pattern = item.labelMatch || "resume"
    let found = false
    try {
      found = await stampInput(pattern, tag)
    } catch (e) {
      fail(item, "file input lookup failed: " + e.message)
      continue
    }
    if (!found) {
      fail(item, "no file input left for /" + pattern + "/")
      continue
    }
    try {
      await page
        .locator('[data-ajup="' + tag + '"]')
        .setInputFiles(item.paths, { timeout: 5000 })
      // The remount is how we know React accepted it; let it settle before the
      // next lookup runs against the DOM.
      await page.waitForTimeout(1000)
      out.ok++
    } catch (e) {
      fail(item, e.message)
    }
  }

  // --- everything else -----------------------------------------------------
  // kindOf + the verb-specific action for ONE item against a given locator,
  // pulled out so the stale-element retry below can replay the exact same
  // sequence against a freshly re-resolved locator without duplicating the
  // verb dispatch. Throws on any failure; the caller decides what to do
  // about it (fail outright, or retry once).
  const actOn = async (loc, item) => {
    let kind
    try {
      kind = await kindOf(loc)
    } catch (e) {
      throw new Error("unreadable element: " + e.message)
    }
    if (String(kind).startsWith("forbidden:")) {
      throw new Error(
        "refusing to touch a <" + kind.split(":")[1] + "> — not a form control",
      )
    }
    await loc.scrollIntoViewIfNeeded({ timeout: 2500 })
    if (item.how === "fill") {
      await loc.fill(String(item.value), { timeout: 2500 })
    } else if (item.how === "select") {
      await loc.selectOption({ label: String(item.value) }, { timeout: 2500 })
    } else if (item.how === "check") {
      const on = item.value === false || item.value === "false" ? false : true
      if (on) await loc.check({ timeout: 2500 })
      else await loc.uncheck({ timeout: 2500 })
    } else if (item.how === "type") {
      await loc.click({ timeout: 2500 })
      await page.keyboard.type(String(item.value), { delay: 15 })
    } else if (item.how === "combo") {
      const r = await setCombo(loc, item)
      if (!r.ok) throw new Error(r.why)
    } else {
      throw new Error("unknown verb " + item.how)
    }
  }

  // Ashby's resume-autofill parses the uploaded PDF and remounts the form
  // ASYNCHRONOUSLY, well after the upload's own settle delay — so this can
  // land between locate() and the interaction that follows it, detaching the
  // element mid-action. Playwright reports that as "Element is not attached
  // to the DOM" on whichever call was in flight (kindOf's evaluate,
  // scrollIntoViewIfNeeded, or the fill/select/check/combo itself) — a value
  // can therefore land correctly (the remount's own re-render, or a later
  // scan) while this exact call still throws. Re-resolving once and replaying
  // the same item is safe: fill/select/check are idempotent, and a genuine
  // (non-stale) failure still reaches `fail` after the retry rather than
  // being retried forever.
  const isStaleError = (e) =>
    /not attached to the dom/i.test(String((e && e.message) || e))

  for (const item of items) {
    if (item.how === "upload" || item.how === "skip") continue
    const loc = await locate(item)
    if (!loc) {
      fail(item, "no unique element for " + (item.sel || item.k))
      continue
    }

    try {
      await actOn(loc, item)
      out.ok++
    } catch (e) {
      if (!isStaleError(e)) {
        fail(item, e.message)
        continue
      }
      // Give an in-flight remount a moment to finish, then re-resolve and
      // retry this one item exactly once.
      await page.waitForTimeout(200)
      const retryLoc = await locate(item)
      if (!retryLoc) {
        fail(
          item,
          "no unique element for " +
            (item.sel || item.k) +
            " after a stale-locator retry",
        )
        continue
      }
      try {
        await actOn(retryLoc, item)
        out.ok++
      } catch (e2) {
        fail(item, e2.message)
      }
    }
  }

  // --- verify once ---------------------------------------------------------
  await page.evaluate(
    () => document.activeElement && document.activeElement.blur(),
  )
  await page.waitForTimeout(450)

  const probes = items
    .filter((i) => i.how !== "skip")
    .map((i) => ({
      k: i.k,
      sel: i.sel || (i.k ? '[data-aj="' + i.k + '"]' : null),
      want: i.how === "upload" ? null : i.value,
      how: i.how,
    }))

  out.verify = await page.evaluate((list) => {
    const res = { mismatch: [], errors: [], requiredEmpty: [] }
    const n = (s) =>
      String(s || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase()
    const read = (el) => {
      const tag = el.tagName.toLowerCase()
      if (tag === "input" && (el.type === "checkbox" || el.type === "radio")) {
        return el.checked ? "true" : ""
      }
      if (tag === "input" || tag === "textarea" || tag === "select")
        return el.value || ""
      const sv = el.querySelector(
        "[class*='single-value'], [class*='singleValue']",
      )
      return (sv ? sv.innerText : el.innerText || "").trim()
    }
    for (const p of list) {
      if (!p.sel) continue
      let el = null
      try {
        el = document.querySelector(p.sel)
      } catch {}
      if (!el) continue
      const got = read(el)
      if (p.want != null && p.how !== "upload") {
        if (!n(got) || (n(got) !== n(p.want) && !n(got).includes(n(p.want)))) {
          res.mismatch.push({
            k: p.k,
            want: String(p.want).slice(0, 40),
            got: got.slice(0, 40),
          })
        }
      }
      const required =
        el.required || el.getAttribute("aria-required") === "true"
      if (required && !n(got)) res.requiredEmpty.push(p.k)
    }
    // Rendered validation text is the only reliable signal that the app itself
    // considers a field unset — element state alone lied to us before.
    const seen = new Set()
    for (const e of document.querySelectorAll(
      "[class*='error-message'], [class*='errorMessage'], [role='alert'], [id$='-error']",
    )) {
      const t = (e.innerText || "").replace(/\s+/g, " ").trim()
      if (!t || seen.has(t) || t.length > 120) continue
      seen.add(t)
      res.errors.push({ text: t })
    }
    return res
  }, probes)

  // Report the way forward; never take it.
  try {
    const scan = await page.evaluate(() =>
      typeof window.__ajScan === "function" ? window.__ajScan(false) : null,
    )
    if (scan) {
      out.signals = scan.signals || []
      const btn = (scan.btns || []).find(
        (b) => b.r === "next" || b.r === "submit",
      )
      if (btn) out.next = { btn: btn.k, label: btn.l, role: btn.r }
    }
  } catch {}

  out.ms = Date.now() - started
  return out
})
