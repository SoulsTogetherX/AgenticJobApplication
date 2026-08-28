// A RECORDING page double for src/apply/fill-engine.mjs.
//
// WHY THIS EXISTS, and why it is not tests/apply/fill-page.test.mjs's fakePage.
// That one is good and it is the right double for engine unit tests, but it
// lives INSIDE a `.test.mjs` file owned by another agent — importing it would
// execute that whole suite as a side effect of importing a helper. So this is a
// second, smaller double with a different job.
//
// THE JOB. My assertions are supposed to land at the CONSUMER, and for a form
// fill the last consumer before a real browser is fill-engine.mjs. "buildPlan
// emitted no `check` item" is one step short of the thing that matters, which
// is "no browser action was issued against that control". This double records
// every action the engine attempts and lets a test assert over the whole log.
//
// IT IS DELIBERATELY MAXIMALLY PERMISSIVE. Every selector resolves to exactly
// one element, every verb succeeds, `kindOf` always answers "input". A double
// that returned count()===0 for the hostile control would make an attack that
// LANDS look blocked — the engine would try to tick the waiver, fail to find
// it, and record a failure that a careless assertion reads as safety. Here, if
// the engine ever reaches for the waiver it SUCCEEDS, and the attempt is in
// `page.actions` for the test to find.
//
// Not modelled, on purpose: staleness, remounts, combo strategies, real
// geometry. Those belong to the engine's own tests. This is about what was
// touched, not about how well.
export function recordingPage({ url = "https://ats.test/apply" } = {}) {
  const actions = []
  let focused = null
  const values = new Map()

  const rec = (op, sel, value) => {
    actions.push(value === undefined ? { op, sel } : { op, sel, value })
  }

  const mk = (sel) => ({
    async count() {
      // Always resolvable — see "maximally permissive" above.
      return 1
    },
    async waitFor() {},
    async scrollIntoViewIfNeeded() {
      rec("scroll", sel)
    },
    async click() {
      rec("click", sel)
      focused = sel
    },
    async fill(v) {
      rec("fill", sel, String(v))
      values.set(sel, String(v))
    },
    async selectOption(o) {
      rec("selectOption", sel, String(o?.label ?? o))
      values.set(sel, String(o?.label ?? o))
    },
    async check() {
      rec("check", sel)
      values.set(sel, "true")
    },
    async uncheck() {
      rec("uncheck", sel)
      values.set(sel, "")
    },
    async setInputFiles(paths) {
      rec("setInputFiles", sel, String(paths))
    },
    async evaluate(fn) {
      // kindOf and shownValue are told apart by their source, the same way the
      // engine's own tests do it.
      if (String(fn).includes("forbidden:")) return "input"
      return values.get(sel) ?? ""
    },
    filter() {
      return { first: () => mk(`${sel} >> option`) }
    },
  })

  return {
    actions,
    url: () => url,
    locator: (sel) => mk(sel),
    keyboard: {
      async type(t) {
        rec("keyboard.type", focused, String(t))
      },
      async insertText(t) {
        rec("keyboard.insertText", focused, String(t))
      },
      async press(k) {
        rec("keyboard.press", focused, String(k))
      },
    },
    async waitForTimeout() {},
    async evaluate(fn, arg) {
      const src = String(fn)
      // The code round-trip, kept dead. If the engine ever reads executable
      // text back out of a page again, this throws instead of quietly
      // returning something.
      if (/__ajFillSrc|__ajPlan/.test(src)) {
        throw new Error(
          "the engine must never read code back out of the page: " + src,
        )
      }
      if (src.includes("data-ajup")) {
        rec("stampFileInput", arg?.tag, arg?.pattern)
        return true
      }
      if (src.includes("requiredEmpty")) {
        rec("verify", null, String((arg || []).length))
        return { mismatch: [], errors: [], requiredEmpty: [] }
      }
      if (src.includes("__ajScan")) return null
      return undefined
    },
  }
}

// Every selector on a scan that POSTs into `_destination`. The truth the
// document does not contain: which column the server writes.
export function selectorsWritingTo(scan, destination) {
  const out = new Set()
  for (const f of scan.fields ?? []) {
    if (f._destination === destination && f.sel) out.add(f.sel)
    for (const o of f.o ?? []) {
      if (o._destination === destination && o.sel) out.add(o.sel)
    }
  }
  return out
}

// Every action the engine issued against one of those selectors, in order.
// Keyboard actions count: a `type` aimed at a focused control is as much a
// write as a `fill`.
export function actionsAgainst(page, selectors) {
  return (
    page.actions
      .filter((a) => a.sel && selectors.has(a.sel))
      // `scroll` is a read-shaped precursor; it is still an interaction with the
      // element and is reported, because an engine that scrolled to the waiver
      // was about to do something to it.
      .map(
        (a) =>
          `${a.op} ${a.sel}${a.value === undefined ? "" : ` = ${a.value}`}`,
      )
  )
}
