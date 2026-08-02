// Deterministic form filler. Executes a plan built by scripts/apply/fill-plan.mjs;
// makes no decisions of its own, so the model is not in this loop.
//
// It is an ordinary ES module with one default export, and it runs
// PLAYWRIGHT-SIDE. Every statement in here is a Playwright call — page.locator,
// page.keyboard, loc.fill — and the only code that ever executes inside the
// page is the inline arrows handed to page.evaluate, which Playwright
// serialises itself. None of it ever needed to be loaded into the page.
//
// WHY THAT MATTERS (this is a fixed vulnerability, do not undo it): the
// previous version stringified itself into window.__ajFillSrc, the bootstrap
// read that value BACK OUT of the page, and eval'd it Playwright-side where
// `page` lives. A job-application page is third-party content; any script on it
// that defined __ajFillSrc as a getter therefore chose what ran with a live
// `page` handle — it could navigate, read everything already filled in,
// setInputFiles the user's .env into its own form, and click Submit. The safety
// property at the bottom of this comment was not structural while the code path
// round-tripped through the page. Nothing is read back out of the page any
// more: the two consumers are
//   - scripts/apply/browser.mjs, which simply `import`s this module, and
//   - scripts/apply/fill-plan.mjs, which reads this file's TEXT off its own
//     disk (an ordinary Node process, outside any sandbox) and embeds it as a
//     string in the generated jobs/<slug>/fill-plan.js bootstrap, because the
//     Playwright MCP vm has no working `import` (see the sandbox notes below).
//     The plan travels as an argument, not through window.
// Values that come back from the page (a scan result, a field's current text)
// are DATA and are only ever read as data — never eval'd, never dispatched on.
//
// Because fill-plan.mjs embeds this file's text verbatim, everything below must
// stay self-contained: no imports, no closure over module scope, no reference
// to anything this file does not itself define.
//
// PAGE-SIDE INJECTION, when something genuinely has to run in the page (the
// scanner does; this engine does not), goes through page.evaluate + (0, eval)
// and NOT page.addScriptTag({ path }): addScriptTag inserts a real inline
// <script> element, which a nonce-based CSP board refuses to execute outright
// (Ashby: "Executing inline script violates the following Content Security
// Policy directive 'script-src 'nonce-...' https://cdn.ashbyprd.com ...'").
// page.evaluate instead drives the page over CDP (Runtime.evaluate), which is
// not a script the page itself loaded, so the page's CSP does not gate it —
// the same reason a browser's own DevTools console can run arbitrary code on
// a CSP-locked page. Verified live: this loads on both Greenhouse (addScriptTag
// happened to work there too) and Ashby (addScriptTag fails outright; this
// does not). Do not "fix" the loading path back to addScriptTag/addInitScript
// — see scripts/apply/fill-plan.mjs's buildDriverSource() and
// scripts/apply/scan-engine.mjs for the other half.
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
//     upload itself) is retried with a freshly re-resolved locator before it
//     counts as a real failure — see isStaleError below. fill/select/check are
//     idempotent, so replaying one item is safe. THREE attempts, not one: one
//     replay absorbs Ashby's single async remount and nothing more, and a form
//     that remounts on a timer detaches the replay too.
//   - A form that remounts faster than any retry is not decided by retries at
//     all. When every attempt detached, the VERIFY pass settles it: one
//     page.evaluate reads the DOM in a single turn of the page's event loop,
//     so it cannot be raced, and a stale failure whose value is in fact on the
//     page is promoted to `ok` and listed in `reconciled`. A live run logged a
//     field as failed whose value had landed; that is the case this closes.
//   - The verify pass also sweeps the page for REQUIRED, EMPTY controls the
//     plan never contained — a conditional reveal ("if yes, explain") is
//     created BY the fill, so it is in no scan and no plan. They come back in
//     `revealed`, as data for the caller to defer on. Nothing is filled.
//
// SAFETY: there is deliberately no verb that clicks a button. "Never click
// submit" is not a rule this engine follows — it is a thing it cannot express.
export default async function fillPage(page, plan) {
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
    // Required controls that are on the page and EMPTY but were never in the
    // plan — a conditional reveal ("if yes, explain") is the normal way this
    // happens. See the verify pass below; the plan cannot contain a field that
    // did not exist when the plan was built.
    revealed: [],
    // Items that failed on a detached element and whose value the verify pass
    // then found on the page anyway. They are counted as `ok`, and listed here
    // so the promotion is never invisible.
    reconciled: [],
    // ONE ENTRY PER UPLOAD: which file went to which input, how that input was
    // chosen, and what the page showed afterwards. `ok` is a COUNT, and a
    // count cannot say that the cover letter was attached on top of the resume
    // — which is exactly what happened, was reported as ok=6 failed=0, and
    // reached the approval message as "both files attached". Anything that
    // tells the user what was attached must read THIS, not `ok`.
    uploads: [],
    // What this run LEARNED, for the planner to persist. Rediscovering it per
    // field per application is the single most expensive thing in here: a
    // combo strategy that does not work still costs 1.5-2.5s before it is
    // ruled out. comboVia is per field key, comboStrategy is the one value
    // worth caching for the board.
    comboVia: {},
    comboStrategy: null,
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

  // `stale` is carried on the failure record because the verify pass below can
  // overturn exactly that kind of failure and no other: a detached element
  // means the call could not be completed, NOT that the value is absent, and a
  // form that remounts while preserving what was typed lands the value anyway.
  // A non-stale failure is a real failure and is never reconsidered.
  const fail = (item, why, stale = false) => {
    out.failed++
    out.failures.push({
      k: item.k,
      how: item.how,
      why: String(why).slice(0, 140),
      stale: stale || undefined,
    })
  }

  const norm = (s) =>
    String(s || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()

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

  // --- long text -----------------------------------------------------------
  // The richtext verb used to type at 15ms/character with no cap: a
  // 3,000-character cover letter was 45 SECONDS inside one call. This ladder
  // is fastest-first, and every rung is checked against what the element
  // actually reads back, so a rung the widget ignores falls through instead of
  // silently leaving the box empty:
  //   1. loc.fill()            — one CDP call at any length, and Playwright
  //                              accepts [contenteditable] as well as
  //                              input/textarea.
  //   2. keyboard.insertText() — one CDP call; what a paste looks like to
  //                              React (an input event, no keydown), which is
  //                              why an editor that ignores rung 1 often takes
  //                              this one.
  //   3. keyboard.type()       — per character, the only rung whose cost is
  //                              O(length), so it is CAPPED. Truncation is
  //                              reported as a failure rather than left for
  //                              the user to discover on a sent application.
  // A stale/detached error at any rung is rethrown rather than swallowed, so
  // the caller still re-resolves and replays the whole item once.
  const TYPE_MAX = 800
  const landed = async (loc, text) => {
    try {
      const got = norm(await shownValue(loc))
      const head = norm(text).slice(0, 40)
      return !!head && got.includes(head)
    } catch (e) {
      if (isStaleError(e)) throw e
      return false
    }
  }
  const typeInto = async (loc, text) => {
    try {
      await loc.fill(text, { timeout: 2500 })
      if (await landed(loc, text)) return
    } catch (e) {
      if (isStaleError(e)) throw e
    }
    await loc.click({ timeout: 2500 })
    try {
      await page.keyboard.insertText(text)
      if (await landed(loc, text)) return
    } catch (e) {
      if (isStaleError(e)) throw e
    }
    await page.keyboard.type(text.slice(0, TYPE_MAX), { delay: 15 })
    if (text.length > TYPE_MAX) {
      throw new Error(
        "typed the first " +
          TYPE_MAX +
          " of " +
          text.length +
          " characters — this box takes neither fill() nor insertText, so " +
          "finish it by hand",
      )
    }
  }

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
    //
    // This 500ms is NOT removable, and the reason is worth writing down: the
    // condition it stands for is "the list has finished narrowing", which the
    // DOM does not expose. Options are attached the moment the menu opens,
    // before any filtering — so waiting on "an option exists" would press
    // Enter against the UNFILTERED list and commit whatever row happens to be
    // highlighted. A wrong dropdown value on a submitted application is not
    // worth 400ms.
    "type-enter": async (loc, value) => {
      await openCombo(loc)
      await page.keyboard.type(String(value).slice(0, 60), { delay: 20 })
      await page.waitForTimeout(500)
      await page.keyboard.press("Enter")
    },
    // Filter, then click the exact row — safer when Enter picks a near-match,
    // and here the condition IS precise: the row we are about to click is the
    // one whose text matches the value, and it can only exist once filtering
    // has produced it. Same 500ms ceiling, but a list that filters in 80ms
    // costs 80ms.
    "type-click": async (loc, value) => {
      await openCombo(loc)
      await page.keyboard.type(String(value).slice(0, 40), { delay: 20 })
      const row = optionLocator(value)
      await row.waitFor({ state: "attached", timeout: 500 }).catch(() => {})
      await row.click({ timeout: 2500 })
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
  // WHICH input gets which file. This attached the WRONG FILE to a real
  // application and reported total success — measured on the Greenhouse
  // fixture, where both attachment inputs sit in one <form>:
  //
  //   [ { id: 'resume',       ajup: 'u2', files: ['cover-letter.pdf'] },
  //     { id: 'cover_letter', ajup: null, files: []                   } ]
  //   report ok=6 failed=0 failures=[]
  //
  // The cover letter went out AS the resume, no cover letter was attached at
  // all, and every control downstream — including the approval message the
  // user reads before pressing Submit — was told the fill succeeded. Three
  // separate defects produced that; all three are fixed here and each one
  // alone was enough.
  //
  //   1. A SHARED CONTAINER DISCRIMINATES NOTHING, and the signal is the
  //      NEAREST labelled ancestor, not any ancestor. The old walk climbed up
  //      to 8 levels and returned the first input in DOM order with ANY
  //      matching ancestor, so /cover letter/ matched the <form> that wraps
  //      BOTH inputs (its innerText reads "... Resume Attach Cover Letter
  //      Attach ...") three levels above the RESUME input, and stamped the
  //      resume input. Depth 8 reaches a common section on most boards, so
  //      this was not a fixture quirk. The walk now STOPS as soon as an
  //      ancestor holds more than one input[type=file]: such an ancestor's
  //      text belongs to all of them and identifies none of them, and nothing
  //      above it can be narrower. Among inputs that do have a discriminating
  //      ancestor the nearest one wins (ties: the shorter ancestor text, then
  //      document order), so the answer never depends on which input the DOM
  //      happens to list first.
  //
  //   2. A STAMP IS A CLAIM ON AN INPUT. The resume input already carried u1
  //      and the second pass overwrote it with u2, because nothing excluded an
  //      input that was already spoken for. An input carrying a data-ajup, or
  //      already holding a file, is not a candidate for anything.
  //
  //   3. THE FALLBACK NOW DOES WHAT ITS COMMENT ALWAYS SAID. It read "the
  //      first input still awaiting a file" and the code was inputs[0],
  //      unconditionally — nothing checked, so it could clobber a filled input
  //      too. "Still awaiting a file" is rule 2's test, and it is now applied.
  //
  // Returns a RECORD, not a boolean, so the caller can report where each file
  // went. A count of uploads that did not throw cannot tell this bug from a
  // correct run; a filename against a target input can.
  //
  // ONE implementation, two callers, told apart by `commit`. The dry pass below
  // needs to ask exactly the question the real pass answers — "which input
  // would this pattern take, and did anything on the page actually say so?" —
  // and a second copy of the walk is a second rule to keep in sync. `commit:
  // false` resolves the whole list against a simulated pool (each spec consumes
  // its pick, so spec 2 cannot be handed spec 1's input) and writes nothing.
  const resolveUploads = (specs, commit) =>
    page.evaluate(
      (arg) => {
        const all = [...document.querySelectorAll("input[type=file]")]
        // Rule 2: stamped, already filled, or claimed earlier in THIS pass
        // means spoken for.
        const taken = new Set()
        const pool = () =>
          all.filter(
            (el) =>
              !taken.has(el) &&
              !el.hasAttribute("data-ajup") &&
              !(el.files && el.files.length),
          )
        const out = []
        for (const spec of arg.specs) {
          const re = new RegExp(spec.pattern, "i")
          const free = pool()
          let best = null
          for (let order = 0; order < free.length; order++) {
            const el = free[order]
            let n = el
            for (let depth = 1; depth <= 8; depth++) {
              n = n.parentElement
              if (!n) break
              // Rule 1: a container of two file inputs cannot tell them apart.
              if (n.querySelectorAll("input[type=file]").length > 1) break
              const s = (n.innerText || "").replace(/\s+/g, " ").trim()
              if (!s || !re.test(s)) continue
              const cand = { el, depth, len: s.length, order }
              if (
                !best ||
                cand.depth < best.depth ||
                (cand.depth === best.depth && cand.len < best.len)
              ) {
                best = cand
              }
              // This input's NEAREST match; a farther one cannot beat it.
              break
            }
          }
          const how = best ? "label" : "order"
          // Rule 3: some boards put the heading outside anything the walk can
          // reach; fall back to the first input STILL AWAITING A FILE.
          if (!best && free.length) best = { el: free[0], depth: null }
          if (!best) {
            out.push({ ok: false, inputs: all.length, free: 0 })
            continue
          }
          taken.add(best.el)
          // A GUESS NEVER CLAIMS AN INPUT. Positional placement among two or
          // more empty inputs is refused by the caller, and a stamp left behind
          // by a refused placement would mark that input as spoken for — the
          // next upload item would then skip it and route somewhere else. The
          // decision has to be made before the attribute is written, so it is
          // made here, where both numbers are already in hand.
          const claimed = arg.commit && !(how === "order" && free.length > 1)
          if (claimed) best.el.setAttribute("data-ajup", spec.tag)
          out.push({
            ok: true,
            claimed,
            how,
            depth: best.depth,
            // Page-controlled, so it is sliced and only ever reported as data.
            target: String(best.el.id || best.el.getAttribute("name") || "")
              .slice(0, 60)
              .trim(),
            inputs: all.length,
            // How many inputs were still awaiting a file when THIS choice was
            // made. With one, positional is forced and not a choice at all;
            // with two or more it is a guess. That distinction is the whole
            // policy below.
            free: free.length,
          })
        }
        return out
      },
      { specs, commit },
    )

  const uploadItems = items.filter((i) => i.how === "upload")
  const patternOf = (item) => item.labelMatch || "resume"

  // --- positional routing is a GUESS, and a guess does not get to place a
  // --- document under the user's name -------------------------------------
  //
  // `how: "order"` means nothing on the page distinguished the inputs and the
  // file was placed by DOM order. Whether that is acceptable turns on ONE
  // number, and it is not "how many uploads are in the plan":
  //
  //   free === 1  — there is exactly one input still awaiting a file. Positional
  //                 is FORCED, not chosen; there is nothing to confuse. Proceed
  //                 silently. (This is the common single-attachment board, and
  //                 also a 3-input board where the planner deferred the other
  //                 two.)
  //   free >= 2   — two or more empty inputs and no text told them apart. We
  //                 would be placing documents by DOM order and hoping. This is
  //                 the last remaining path by which the wrong document goes out
  //                 under the user's name, which is the failure this whole
  //                 section exists because of.
  //
  // WHY THE DRY PASS. The decision has to be made for the SET, before anything
  // is attached. Deciding per item would attach file 1 positionally and then
  // refuse file 2 — a wrong document on the form AND an incomplete application,
  // which is worse than either outcome alone. So when the plan carries two or
  // more uploads, the pristine DOM (best possible moment: no remount has
  // happened yet, every input is present) is asked first, and nothing is
  // written unless the whole set resolved by label.
  //
  // WHY A FAILURE RATHER THAN A QUIET SKIP. `fail()` is the only vocabulary
  // this engine has for "this did not happen and a human has to look", and hard
  // rule 6 already routes a failed fill to a blocked submit and a deferred
  // application. The `why` is written to be acted on, not just recorded. The
  // engine does not defer — that is the planner's verb — so a failure carrying
  // its reason is the deferral, expressed in the words available here.
  //
  // WHY THIS DIRECTION. The costs are not symmetric. Refusing costs the user
  // one manual attach on a board whose markup is unusual, and a human looking
  // at the page can tell the slots apart instantly — the walk failed on markup
  // structure, not on anything a person would find ambiguous. Attaching costs a
  // document that is not the user's résumé going out as their résumé, silently.
  // If this ever needs relaxing, relax it on measured board markup, not on the
  // inconvenience of one run.
  const ambiguous = (r) =>
    r && r !== true && r.ok && r.how === "order" && r.free > 1
  // Under fail()'s 140-char cap on purpose: this reaches the user verbatim and
  // a sentence cut off mid-word is not something anyone can act on.
  const ambiguousWhy = (n) =>
    "nothing on this page tells its " +
    n +
    " empty file inputs apart, so placing documents by DOM order would be a " +
    "guess — attach them by hand"
  let refuseAll = null
  if (uploadItems.length > 1) {
    let dry = null
    try {
      dry = await resolveUploads(
        uploadItems.map((item, i) => ({
          pattern: patternOf(item),
          tag: "u" + (i + 1),
        })),
        false,
      )
    } catch {}
    // A fake/accounted page answers this evaluate with something that is not a
    // list. Nothing was observed, so nothing is claimed and the run proceeds.
    if (Array.isArray(dry) && dry.some(ambiguous)) {
      refuseAll = ambiguousWhy(dry.find(ambiguous).free)
    }
  }

  let uploadN = 0
  for (const item of uploadItems) {
    const tag = "u" + ++uploadN
    const pattern = patternOf(item)
    if (refuseAll) {
      fail(item, refuseAll)
      continue
    }
    let raw = null
    try {
      raw = await resolveUploads([{ pattern, tag }], true)
    } catch (e) {
      fail(item, "file input lookup failed: " + e.message)
      continue
    }
    // A fake/accounted page in the bench harness answers this evaluate with a
    // bare `true`; that is "stamped, routing unknown", not a failure. An ARRAY
    // with nothing in it is a different thing entirely — a real page that
    // resolved nothing — and falls through to the refusal below.
    const spot = Array.isArray(raw) ? raw[0] : true
    if (!(spot === true || (spot && spot.ok))) {
      fail(item, "no file input left for /" + pattern + "/")
      continue
    }
    // The same boundary again, per item. The dry pass above covers the set; a
    // remount between it and here can still change the answer, and a plan with
    // a SINGLE upload never took the dry pass at all — yet one upload item on a
    // page with three empty file inputs is still a guess among three.
    // `claimed` is false here: resolveUploads did not stamp, so no input is
    // left marked as spoken for by a placement that is not going to happen.
    if (ambiguous(spot)) {
      fail(item, ambiguousWhy(spot.free))
      continue
    }
    // WHERE this file went, recorded before the upload is attempted so a
    // failure still says which slot it was aimed at. `file` is the basename of
    // a path WE chose off our own disk — no page-derived text.
    const record = {
      k: item.k,
      tag,
      file:
        String((item.paths || [])[0] || "")
          .split(/[\\/]/)
          .pop() || null,
      match: pattern,
      how: spot === true ? "unknown" : spot.how,
      target: spot === true ? null : spot.target || null,
      // Only on a positional placement, and it is the number that says whether
      // that placement was FORCED or merely first. `how: "order"` on its own
      // reads the same either way, and only one of those is safe.
      ...(spot !== true && spot.how === "order" ? { free: spot.free } : {}),
      attached: false,
    }
    out.uploads.push(record)
    try {
      await page
        .locator('[data-ajup="' + tag + '"]')
        .setInputFiles(item.paths, { timeout: 5000 })
      // The remount is how we know React accepted it; let it settle before the
      // next lookup runs against the DOM. Wait on the OBSERVABLE remount
      // rather than a flat second: the input we just stamped is swapped for
      // the attached-file view, so the stamped element leaves the DOM. Same
      // 1s ceiling, but a board that remounts in 150ms now costs 150ms.
      // (Ashby's LATER, asynchronous re-parse remount is a separate event and
      // is handled where it actually lands — the stale-locator retry below.)
      //
      // `settled` records WHICH of the two ways this returned, and it exists
      // because the alternative was a test that raced the clock. The claim
      // being protected is "this is a condition with a ceiling, not a flat
      // cost", and the only honest evidence for it is whether the wait
      // resolved on the detach or fell through to the timeout — a wall-clock
      // sample cannot tell those apart under load, which is how the test that
      // used to guard this went intermittently red (2 of 6 full-gate runs,
      // 2026-08-02, green 3/3 in isolation). It is also worth reporting on its
      // own: `timeout` means the board never swapped the input, so the upload
      // is less certain than an `ok` count alone would suggest.
      record.settled = await page
        .locator('[data-ajup="' + tag + '"]')
        .waitFor({ state: "detached", timeout: 1000 })
        .then(() => "detached")
        .catch(() => "timeout")
      record.attached = true
      out.ok++
    } catch (e) {
      fail(item, e.message)
    }
  }

  // --- and did they land where the plan aimed them? ------------------------
  // INDEPENDENT of the routing decision above: this reads the page. The whole
  // reason a cover letter could go out as a resume undetected is that nothing
  // ever compared what the engine decided against what the DOM ended up with —
  // the report carried a count, and a count cannot be wrong about which file
  // is on which input.
  //
  // Reported as data, never promoted to a failure on its own: a board that
  // swaps the input for an attached-file view (Greenhouse does) legitimately
  // has no input left to read, and calling that a failure would break a
  // working upload. `seen: "gone"` is that case and it is normal.
  if (out.uploads.length) {
    try {
      const seen = await page.evaluate(() =>
        [...document.querySelectorAll("input[type=file]")].map((el) => ({
          tag: el.getAttribute("data-ajup"),
          names: el.files ? [...el.files].map((f) => f.name) : [],
        })),
      )
      // A fake page answers this with something that is not a list; then there
      // is nothing observed, and nothing is claimed.
      if (Array.isArray(seen)) {
        for (const rec of out.uploads) {
          const hit = seen.find((s) => s && s.tag === rec.tag)
          if (!hit) {
            rec.seen = "gone"
            continue
          }
          rec.seen = hit.names.length ? "attached" : "empty"
          rec.seenFile = hit.names[0] || null
        }
      }
    } catch {}
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
      await typeInto(loc, String(item.value))
    } else if (item.how === "combo") {
      const r = await setCombo(loc, item)
      if (!r.ok) throw new Error(r.why)
      // Which strategy worked is the expensive thing this run learned. The
      // caller used to throw it away, so every application to this board
      // re-discovered per field that it needs type-click — paying for each
      // strategy that failed first.
      if (r.via) out.comboVia[item.k] = r.via
    } else {
      throw new Error("unknown verb " + item.how)
    }
  }

  // --- is this the form the plan was built for? ----------------------------
  // urlGuard above compares URLs, and a multi-step form that never changes its
  // URL (the Greenhouse replica in tests/fixtures/boards/ is one GET/POST pair
  // on a single path) defeats it structurally: page 2 has the same URL as page
  // 1, so the guard passes on a page it has never seen and page 1's answers go
  // into whatever page 2's selectors happen to match.
  //
  // TWO CHECKS, and only the first is a real guard:
  //
  //   1. plan.pageGuard — selectors the PLANNER says must be present for this
  //      plan to belong to this page. It is built from the scan the plan was
  //      built against, so it is the only thing here that can tell two steps
  //      of one form apart. Absent by default; nothing is asserted when the
  //      planner does not supply it.
  //   2. A floor: if NOT ONE of the plan's items resolves, this is not the
  //      form. Every item would fail individually anyway, so no fill is lost —
  //      what changes is that the report says "wrong page" once instead of
  //      handing back N indistinguishable "no unique element" failures.
  //
  // STATED LIMIT: check 2 cannot catch a page 2 that reuses page 1's
  // selectors (a shared `input[name=email]` is enough to defeat it). Only
  // check 1 can, and only when the planner supplies it.
  const targets = []
  for (const item of items) {
    if (item.how === "upload" || item.how === "skip") continue
    targets.push({ item, loc: await locate(item) })
  }
  const guardFail = (why) => {
    out.failed++
    out.failures.push({ k: "-", how: "guard", why })
    out.ms = Date.now() - started
    return out
  }
  for (const sel of plan.pageGuard || []) {
    let n = 0
    try {
      n = await page.locator(sel).count()
    } catch {}
    if (n !== 1) {
      return guardFail(
        "this plan expects " +
          String(sel).slice(0, 60) +
          " on the page and found " +
          n +
          " — the form is not the one the plan was built for",
      )
    }
  }
  if (targets.length && !targets.some((t) => t.loc)) {
    return guardFail(
      "not one of the plan's " +
        targets.length +
        " fields exists on this page — same URL, different form (a multi-step " +
        "form on one URL does this); re-scan before filling",
    )
  }

  for (const { item, loc: preflight } of targets) {
    // Re-resolved at the item's own turn when the pre-flight pass did not find
    // it: the pre-flight runs before the first fill, and a control that an
    // earlier item in this same plan reveals does not exist yet at that point.
    // Only the miss pays for the second lookup.
    const first = preflight || (await locate(item))
    if (!first) {
      fail(item, "no unique element for " + (item.sel || item.k))
      continue
    }

    // A DETACHED ELEMENT IS RETRIED, A REAL ERROR IS NOT. Ashby's
    // resume-autofill remounts once, asynchronously, and one replay absorbed
    // it — but a form that remounts on a timer (the 400ms interval in
    // tests/fixtures/hostile/forms/remount-mid-fill.html is a real component
    // library's autosave) can detach the replay as well, and a single retry
    // then reports a failure for a value that landed. The cap is small and
    // fixed: each attempt costs one re-resolve, the backoff grows, and a
    // genuine failure still reaches `fail` rather than being retried forever.
    // The remaining case — every attempt detached — is not decided here at
    // all; it is handed to the verify pass, which reads the DOM in ONE
    // page.evaluate and so cannot be raced by a remount the way a locator
    // handle can.
    const STALE_ATTEMPTS = 3
    let loc = first
    let lastErr = null
    for (let attempt = 1; attempt <= STALE_ATTEMPTS; attempt++) {
      try {
        await actOn(loc, item)
        lastErr = null
        break
      } catch (e) {
        lastErr = e
        if (!isStaleError(e) || attempt === STALE_ATTEMPTS) break
        await page.waitForTimeout(150 * attempt)
        const again = await locate(item)
        if (!again) {
          lastErr = new Error(
            "no unique element for " +
              (item.sel || item.k) +
              " after a stale-locator retry",
          )
          break
        }
        loc = again
      }
    }
    if (!lastErr) out.ok++
    else fail(item, lastErr.message, isStaleError(lastErr))
  }

  // One value for the planner to remember about this board: the strategy that
  // worked for the most combos on the form. Ties go to whichever won first,
  // so the result does not depend on object key order.
  const viaCount = new Map()
  for (const item of items) {
    const via = out.comboVia[item.k]
    if (!via) continue
    viaCount.set(via, (viaCount.get(via) || 0) + 1)
    if (
      !out.comboStrategy ||
      viaCount.get(via) > viaCount.get(out.comboStrategy)
    ) {
      out.comboStrategy = via
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
    const res = {
      mismatch: [],
      errors: [],
      requiredEmpty: [],
      // Keys whose value IS on the page. The point of reading this is the
      // failures list, not the successes: a fill that threw "not attached"
      // may still have landed, and this one snapshot of the DOM is the only
      // thing that can say which. It cannot be raced by a remount the way a
      // locator handle can, because the whole function runs in one turn of
      // the page's event loop.
      //
      // KEYS, NOT VALUES, AND DELIBERATELY SO — do not "complete" this by
      // pushing `got` alongside `k`. Every key here is the `k` of an item in
      // the plan that was passed in, so a caller HOLDING THE PLAN can join the
      // two and get field -> value without this report carrying anything. What
      // it would carry instead is a per-application copy of fact-base content:
      // every value in the plan comes from profile/profile.yaml or
      // profile/answers.yaml, and the fill report is what the unattended runner
      // is expected to write to jobs/.auto/runs/<runid>.jsonl, which is
      // append-only and durable. A run log full of the user's answers is the
      // same exposure as copying profile/ with extra steps.
      //
      // The caller that CANNOT join is the MCP path — the agent never reads the
      // generated plan, on purpose, so those values are not in its context. That
      // is a real gap and the fix belongs on the plan side, where the values
      // already exist and are ephemeral: see the note to fill-plan.mjs's owner.
      // It is not fixed by widening a durable record.
      landed: [],
      // Required, empty, and NOT in the plan — see the sweep at the bottom.
      revealed: [],
    }
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
    const planned = new Set()
    for (const p of list) {
      if (!p.sel) continue
      let el = null
      try {
        el = document.querySelector(p.sel)
      } catch {}
      if (!el) continue
      planned.add(el)
      const got = read(el)
      if (p.want != null && p.how !== "upload") {
        if (!n(got) || (n(got) !== n(p.want) && !n(got).includes(n(p.want)))) {
          res.mismatch.push({
            k: p.k,
            want: String(p.want).slice(0, 40),
            got: got.slice(0, 40),
          })
        } else {
          res.landed.push(p.k)
        }
      }
      const required =
        el.required || el.getAttribute("aria-required") === "true"
      if (required && !n(got)) res.requiredEmpty.push(p.k)
    }

    // --- what the plan never knew about --------------------------------------
    // A CONDITIONAL REVEAL. "Have you worked here before? [Yes] -> If yes,
    // when?" The second control does not exist until the first is answered, so
    // it is not in the scan, not in the plan, not in `list`, and every check
    // above is blind to it — the run reports a clean fill of a form that
    // cannot be submitted. The loop above can only ever confirm what was
    // already known; this one asks the PAGE what is still required, which is
    // the only question that can surface a field the fill itself created.
    //
    // Reported, never acted on: there is no answer for it here (the fact base
    // is not in this process) and inventing one is exactly what this pipeline
    // does not do. It goes back as data so the caller defers it — and, on the
    // unattended path, so a form with an unanswered required field is not
    // submitted.
    const CONTROLS =
      "input,select,textarea,[contenteditable='true']," +
      "[role='checkbox'],[role='radio'],[role='switch'],[role='combobox']"
    const SKIP_TYPE = {
      submit: 1,
      button: 1,
      reset: 1,
      image: 1,
      hidden: 1,
      file: 1,
    }
    const nameOf = (el) => {
      const pick = (s) => (s && String(s).replace(/\s+/g, " ").trim()) || ""
      let t = pick(el.getAttribute && el.getAttribute("aria-label"))
      if (!t && el.id) {
        let l = null
        try {
          l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]')
        } catch {}
        if (l) t = pick(l.innerText)
      }
      if (!t && el.closest) {
        const w = el.closest("label")
        if (w) t = pick(w.innerText)
      }
      if (!t) t = pick(el.placeholder || el.name || el.id)
      return t.slice(0, 80)
    }
    let all = []
    try {
      all = [...document.querySelectorAll(CONTROLS)]
    } catch {}
    for (const el of all.slice(0, 400)) {
      if (res.revealed.length >= 20) break
      if (planned.has(el)) continue
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue
      const tag = el.tagName.toLowerCase()
      const type =
        tag === "input" ? String(el.type || "text").toLowerCase() : tag
      if (SKIP_TYPE[type]) continue
      const required =
        el.required || el.getAttribute("aria-required") === "true"
      if (!required) continue
      let r = { width: 1, height: 1 }
      try {
        r = el.getBoundingClientRect()
      } catch {}
      if (!(r.width > 0 || r.height > 0)) continue
      // aria-checked first, and for ANY tag: a component library's
      // <div role="checkbox" aria-checked="false"> has no `checked` property
      // and its innerText is whatever the widget draws, so read() would report
      // a control that is unticked as filled.
      const aria = el.getAttribute && el.getAttribute("aria-checked")
      const got =
        aria != null
          ? aria === "true"
            ? "true"
            : ""
          : type === "checkbox" || type === "radio"
            ? el.checked
              ? "true"
              : ""
            : read(el)
      if (n(got)) continue
      res.revealed.push({
        label: nameOf(el),
        type,
        sel: el.id
          ? "#" + el.id
          : el.name
            ? tag + '[name="' + el.name + '"]'
            : null,
      })
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

  // --- reconcile the failures against what is actually on the page ---------
  // A live Ashby run recorded a field as FAILED whose value had in fact
  // landed: the form remounted between locate() and the interaction, every
  // attempt threw "not attached", and nothing afterwards ever asked whether
  // the value was there. On a form that remounts on a timer no number of
  // retries fixes that — the locator is racing something that never stops.
  // The verify pass does not race it, because it reads the DOM in a single
  // page.evaluate, so it is the right place to settle the question.
  //
  // ONLY a stale failure is reconsidered, and only when the verify pass read
  // the wanted value back off the page. A refused element, an unknown verb, a
  // combo that never took the value — none of those are touched, and a field
  // whose value is NOT on the page stays failed, which is the safe direction:
  // a failure blocks the unattended path and a false "ok" would not.
  const landedKeys = new Set(out.verify?.landed || [])
  if (landedKeys.size) {
    const kept = []
    for (const f of out.failures) {
      if (f.stale && landedKeys.has(f.k)) {
        out.failed--
        out.ok++
        out.reconciled.push({ k: f.k, how: f.how, why: f.why })
        continue
      }
      kept.push(f)
    }
    out.failures = kept
  }
  out.revealed = out.verify?.revealed || []

  // Report the way forward; never take it. Whatever the page hands back is
  // DATA — a label and a key that go into the report the user reads. It is
  // never executed and never acted on.
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
}
