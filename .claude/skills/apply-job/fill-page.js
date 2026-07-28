// Deterministic form filler. Executes a plan built by scripts/fill-plan.mjs;
// makes no decisions of its own, so the model is not in this loop.
//
// It is written as a real function and shipped as SOURCE: the driver loads this
// file into the page via addScriptTag (which costs nothing in agent context),
// reads the string back out, and eval's it Playwright-side where `page` and
// real locators exist. Everything must therefore be self-contained — no closure
// over module scope, no imports.
//
// Sandbox notes: the Playwright MCP vm context has `page` and the standard
// built-ins, but NO setTimeout, console, or require. Use page.waitForTimeout.
// There is also no default action timeout in that context (stock 30s applies),
// so every locator call passes an explicit one.
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
  for (const item of items) {
    if (item.how === "upload" || item.how === "skip") continue
    const loc = await locate(item)
    if (!loc) {
      fail(item, "no unique element for " + (item.sel || item.k))
      continue
    }

    let kind
    try {
      kind = await kindOf(loc)
    } catch (e) {
      fail(item, "unreadable element: " + e.message)
      continue
    }
    if (String(kind).startsWith("forbidden:")) {
      fail(
        item,
        "refusing to touch a <" + kind.split(":")[1] + "> — not a form control",
      )
      continue
    }

    try {
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
        if (!r.ok) {
          fail(item, r.why)
          continue
        }
      } else {
        fail(item, "unknown verb " + item.how)
        continue
      }
      out.ok++
    } catch (e) {
      fail(item, e.message)
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
