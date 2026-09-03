// Deterministic form filler. Executes a plan built by src/apply/fill-plan.mjs;
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
//   - src/apply/browser.mjs, which simply `import`s this module, and
//   - src/apply/fill-plan.mjs, which reads this file's TEXT off its own
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
// — see src/apply/fill-plan.mjs's buildDriverSource() and
// src/apply/scan-engine.mjs for the other half.
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
//   - setInputFiles not throwing is not evidence a file attached. The DOM is
//     asked afterwards, and a file input STILL ON THE PAGE holding zero files
//     (`seen: "empty"`) is a failure, not an ok — that exact shape shipped an
//     application with no resume while the report read ok=4 failed=0. An input
//     that is GONE is the opposite case and stays a success; see that pass.
//
// SAFETY: this engine cannot express clicking a SUBMIT. That is still not a
// rule it follows but a thing it cannot say — no verb targets an action
// control, and `armSubmitGuard` blocks a submission raised as a side effect of
// any fill, for the whole run.
//
// UNTIL 2026-08-25 THE SENTENCE HERE WAS BROADER — "there is deliberately no
// verb that clicks a button" — and that breadth is what silently stopped
// applications going out. Ashby renders its REQUIRED work-authorisation
// questions as pairs of <button> elements; no verb could touch them, so the
// run left them blank, clicked submit, and Ashby's own validation refused the
// form. The staged capture of a real live click is that page, still offering
// its submit.
//
// The property that replaces it is narrower and checkable: there is exactly
// ONE verb that clicks a non-native control (`widget`), it is admitted only
// for a shape the SCANNER grouped as one question with a closed answer set,
// that control must DECLARE ITS OWN STATE (aria-pressed / aria-checked) or the
// click is refused outright, and the act is confirmed by reading that state
// back — including that no sibling option also reads selected — or the item
// fails. A click this engine cannot verify is a claim it does not make.
// `tests/apply/fill-page.test.mjs` pins all of it, and the verb list is closed
// so a second such verb cannot arrive unnoticed.
//
// The settle ceilings are per-call options (opts.settle) so tests can compress
// them; every production caller passes nothing and gets the defaults. They are
// ceilings on CONDITIONS, not durations that are paid: see the settle stage.
export default async function fillPage(page, plan, opts = {}) {
  const SETTLE = {
    // How long after the LAST setInputFiles a board gets to react to a file —
    // swap the input out (Greenhouse), or read it and reset the input (the
    // async parse remount Ashby does at ~700ms). This is the old per-upload
    // detach ceiling, unchanged in size, but paid ONCE and overlapped with the
    // rest of the fill instead of serially after each upload.
    uploadMs: 1000,
    // Ceiling for the post-blur quiet arm — the old flat pre-verify sleep,
    // kept at its old size on purpose (see the settle stage: silence pays it).
    quietMs: 450,
    // One evaluate per poll, one flat sleep between polls. 90 is the shorter
    // ceiling in five — five chances to observe the board inside the quiet
    // window — and it divides that ceiling EVENLY, which is what keeps the
    // accounted bench honest: that harness sums the arguments the engine
    // passed rather than sleeping them (bench-apply.mjs's header), so a gap
    // that overshot the ceiling would report a total the wall clock never
    // paid, and read as a regression that did not happen.
    pollMs: 90,
    ...(opts.settle || {}),
  }
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

  // --- NO SUBMIT LEAVES THIS ENGINE, WHATEVER KEY IS PRESSED -----------------
  //
  // The header says "never click submit" is a thing this engine cannot
  // express. MEASURED on Torc's Greenhouse embed form (2026-08-18), it could:
  // Enter pressed in a combobox input whose menu had no focused row is the
  // browser's implicit form submission, and the board's submit handler ran.
  // The type-enter guard above stops that keystroke at its source; this is
  // the structural half, for anything the guard cannot see (a widget that
  // reports no focused row yet still forwards Enter, a key sent by any other
  // verb): for the duration of this fill a CAPTURE listener on `window` — the
  // first thing in the dispatch order, ahead of the root listener React and
  // Remix attach to `document` — cancels every `submit` event and stops it
  // dead, so neither the native navigation nor the board's onSubmit runs. It
  // is removed before this function returns, so the runner's own click in
  // submit.mjs (and advance.mjs's `next`) is untouched. Every submit it had to
  // stop is counted and reported as a signal, never swallowed: a fill that
  // tried to submit is a fill with a defect in it, and the report says so.
  const armSubmitGuard = () =>
    page
      .evaluate(() => {
        const g = (e) => {
          window.__ajSubmitsBlocked = (window.__ajSubmitsBlocked || 0) + 1
          e.preventDefault()
          e.stopImmediatePropagation()
        }
        window.__ajSubmitGuards = window.__ajSubmitGuards || []
        window.__ajSubmitGuards.push(g)
        window.__ajSubmitsBlocked = 0
        window.addEventListener("submit", g, true)
      })
      .catch(() => {})
  const disarmSubmitGuard = () =>
    page
      .evaluate(() => {
        for (const g of window.__ajSubmitGuards || [])
          window.removeEventListener("submit", g, true)
        delete window.__ajSubmitGuards
        const n = Number(window.__ajSubmitsBlocked || 0)
        delete window.__ajSubmitsBlocked
        return n
      })
      .then((n) => Number(n) || 0)
      .catch(() => 0)
  await armSubmitGuard()

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

  // A COMBOBOX INPUT'S OWN `value` IS THE SEARCH FILTER, NOT THE ANSWER.
  //
  // MEASURED on Affirm's Greenhouse form, 2026-08-04, and this is the same
  // defect the Oracle note at committedValue() describes — reopened on a board
  // where blurring does NOT clear the box. All ten dropdowns were reported
  // `verify.landed`, `comboVia: type-enter`, no failures; every backing input
  // (#question_*) was still EMPTY and the page itself rendered "This field is
  // required." The application could not have been submitted, and nothing in
  // the run said so: reading `el.value` off a role=combobox input reads back
  // the string we just typed, so the check was satisfied by the act of typing.
  //
  // Blurring first (committedValue) is necessary but NOT sufficient. It only
  // catches widgets that revert on blur; one that leaves its filter text
  // sitting in the box defeats it completely. The reliable question is not
  // "what does the box show" but "what would this form SEND", so where the
  // widget has a committed store, that store is the answer and the filter text
  // stops counting as evidence at all.
  //
  // WHERE THE STORE IS LOOKED FOR, and why each bound is here:
  //   1. A rendered selection node ([class*='single-value']) FIRST. react-select
  //      clears its search input on a successful commit, so the box is empty and
  //      only this node holds the choice — checking the input first would read
  //      "" and fail a fill that actually worked.
  //   2. Otherwise a NON-VISIBLE input/select in the same field wrapper: that is
  //      a backing store, which is exactly what gets submitted. VISIBLE inputs
  //      are excluded deliberately — a neighbouring visible textbox belongs to a
  //      different question (intl-tel-input's number sits beside its country
  //      picker), and reading one would answer this field from another's value.
  //   3. FOUR ANCESTORS, stopping at the form, matching every other bounded
  //      ancestor walk in this pipeline.
  //
  // A widget with NO store falls through to `el.value` unchanged, which is the
  // right reading for a plain typeahead that commits into its own box (Ashby's
  // Location). So this can only ever make the check STRICTER, never looser, and
  // its failure mode is a fill reported failed that actually worked — which
  // defers. The failure mode it removes is an empty required field reported
  // filled, which submits.
  const shownValue = (loc) =>
    loc.evaluate((el) => {
      const txt = (s) =>
        String(s == null ? "" : s)
          .replace(/\s+/g, " ")
          .trim()
      const tag = el.tagName.toLowerCase()
      if (tag === "input" && (el.type === "checkbox" || el.type === "radio")) {
        return el.checked ? "true" : ""
      }
      // BY SHAPE, NOT BY TAG. MEASURED on Affirm 2026-08-04: the element the
      // scanner stamps for a Greenhouse dropdown is the react-select CONTROL,
      // a <div class="select__control"> — role and aria-* live on an inner
      // node, not on it. An input-only test therefore skipped the widget that
      // motivated this whole fix and fell through to reading the control's
      // innerText, which contains the typed text. Same list kindOf() uses.
      const isCombo =
        el.getAttribute("role") === "combobox" ||
        el.getAttribute("aria-autocomplete") === "list" ||
        el.getAttribute("aria-haspopup") === "listbox" ||
        /select__control|Select__control/.test(String(el.className || ""))
      if (isCombo) {
        // WHAT COUNTS AS "NOT PAINTED" IS WIDER THAN display:none.
        //
        // Greenhouse's required store is a real, laid-out text input rendered
        // with `opacity:0; pointer-events:none; position:absolute` and about
        // 3px of width — visibility:visible, display:block, non-zero rect. It
        // exists so the browser can raise "please fill in this field" on a
        // custom widget. Every one of the obvious tests says it is visible, so
        // the first version of this fix walked straight past the only element
        // that holds the answer.
        const unpainted = (n) => {
          if (n.type === "hidden") return true
          const r = n.getBoundingClientRect()
          if (r.width < 5 || r.height < 5) return true
          const st = getComputedStyle(n)
          return (
            st.visibility === "hidden" ||
            st.display === "none" ||
            st.opacity === "0" ||
            st.pointerEvents === "none"
          )
        }
        // AN EMPTY STORE IS STILL A STORE, and this is the whole fix.
        //
        // Returning only NON-EMPTY findings and otherwise falling through to
        // el.value reproduces the defect exactly: an uncommitted widget has an
        // empty store, so it falls through and answers with the filter text
        // again. Once a store has been found, it is the authority whether or
        // not it holds anything — "this widget has somewhere to put an answer
        // and there is nothing in it" is precisely the observation that was
        // missing.
        let sawStore = false
        // STARTS AT `el`, NOT AT ITS PARENT: when the stamped element is the
        // react-select CONTROL, the store and the rendered selection are its
        // own descendants. For an <input> this costs nothing, since an input
        // has none.
        for (let p = el, i = 0; p && i < 5; p = p.parentElement) {
          // THE CONTAINER MUST SPEAK FOR THIS CONTROL ALONE — the same bound
          // the scanner's groupRequired() applies, and it is load-bearing here
          // for a reason found by test: without it the walk reaches the <form>,
          // where EVERY other question's hidden store is in scope. A plain
          // typeahead that has no store of its own then "finds" a neighbour's,
          // reads it empty, and a fill that worked is reported failed.
          //
          // Stopping at the form/body is not enough on a single-question form,
          // where the form level would still hand over unrelated hidden inputs
          // (CSRF tokens and the like). Counting comboboxes is the precise
          // test: a container holding two of them cannot say which store
          // belongs to which. On the real Affirm page this is what stops the
          // walk at `field-wrapper`, one level below `application--questions`,
          // which holds six of them.
          if (
            p.tagName === "FORM" ||
            p.tagName === "BODY" ||
            p.tagName === "HTML"
          ) {
            break
          }
          if (
            p !== el &&
            p.querySelectorAll(
              "[role='combobox'], [aria-autocomplete='list'], [class*='select__control']",
            ).length > 1
          ) {
            break
          }
          const sv = p.querySelector(
            "[class*='single-value'], [class*='singleValue']",
          )
          if (sv) {
            sawStore = true
            if (txt(sv.innerText)) return txt(sv.innerText)
          }
          // A MULTI PICKER'S COMMITTED STORE IS ITS TOKEN LIST. react-select
          // renders one [class*='multi-value'] node per committed choice and
          // NO single-value node; its backing store is one hidden input PER
          // choice, so the input walk below would report a two-token commit
          // as its first token alone. The __label child is preferred (the
          // token container also holds the × remove control); a widget
          // without label children falls back to the outermost token nodes.
          // Joined in DOM order with ", " — the same rendering the plan's
          // joined `value` uses.
          const mv = [
            ...p.querySelectorAll(
              "[class*='multi-value'], [class*='multiValue']",
            ),
          ]
          if (mv.length) {
            sawStore = true
            const labels = mv.filter((x) =>
              /label/i.test(String(x.className || "")),
            )
            const use = labels.length
              ? labels
              : mv.filter((x) => !mv.some((o) => o !== x && o.contains(x)))
            const joined = use
              .map((x) => txt(x.innerText))
              .filter(Boolean)
              .join(", ")
            if (joined) return joined
          }
          for (const n of p.querySelectorAll("input, select")) {
            if (n === el) continue
            // A CHECKBOX IS NEVER A COMBO'S STORE. MEASURED on Flock Safety's
            // Ashby form 2026-08-18: the only combobox on the page (Location)
            // walked up to a container holding Ashby's display:none backing
            // checkboxes for its Yes/No button pairs, read the first one's
            // default value — "on" — as the committed selection, and a
            // location that had landed was reported failed. A tick has no
            // text value; neither does a file, button or submit input.
            if (
              n.tagName === "INPUT" &&
              /^(checkbox|radio|file|submit|button|reset|image)$/i.test(
                String(n.type || ""),
              )
            )
              continue
            if (!unpainted(n)) continue
            sawStore = true
            if (txt(n.value)) return txt(n.value)
          }
          i++
        }
        // A store exists and every one of them is empty: nothing committed.
        // Never el.value / innerText here — that is the filter text.
        if (sawStore) return ""
        // No store anywhere: the box IS the value (plain typeahead, Ashby).
        return tag === "input" ? el.value || "" : txt(el.innerText)
      }
      if (tag === "select" && el.multiple) {
        // el.value on a multi select is only the FIRST selected option — and
        // its value attribute, not its text. The committed answer is every
        // selected option's rendered text.
        return [...el.selectedOptions]
          .map((o) => txt(o.text))
          .filter(Boolean)
          .join(", ")
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
    await loc.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {})
    await loc.click({ timeout: 2500 })
    await page.waitForTimeout(220)
  }

  // --- picking the RIGHT row -----------------------------------------------
  // TWO DEFECTS, MEASURED ON A REAL ORACLE RECRUITING CLOUD APPLICATION
  // (2026-08-04). Between them they put a materially false claim about the user
  // on a submitted form: "Veteran Status" ended up holding "Protected Veteran".
  //
  //   1. THE MATCH WAS A SUBSTRING. `filter({ hasText: value })` is Playwright's
  //      "contains", so on a list reading
  //         I am not a protected veteran
  //         Protected Veteran
  //         I do not wish to identify my protected veteran status
  //      more than one row matches almost anything, and `.first()` picks
  //      whichever the board happened to render first. A near-miss on a
  //      dropdown is not a near-miss in meaning: these three options are three
  //      different statements and two of them are untrue.
  //   2. THE SEARCH WAS PAGE-WIDE. Every open menu, every closed-but-attached
  //      menu, and the phone country-code widget were all in scope, so a row
  //      belonging to a DIFFERENT question could win.
  //
  // Both are fixed by asking the control which menu is its own — aria-controls
  // is the page's own statement, read off the element at fill time rather than
  // carried through the plan, so it works on a cached scan too — and then
  // matching the row's WHOLE text. Where a control names no menu the behaviour
  // is unchanged except for exactness.
  const rxEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  // Whole-string, whitespace-tolerant, case-insensitive. Case is the one
  // liberty taken: boards routinely upper-case option text in CSS and in
  // markup, and no two options on a real list differ only by case.
  const exactRe = (value) =>
    new RegExp(
      "^\\s*" + rxEsc(norm(value)).replace(/ /g, "\\s+") + "\\s*$",
      "i",
    )
  const menuScope = async (loc) => {
    let id = null
    try {
      id = await loc.getAttribute("aria-controls")
    } catch {}
    id = String(id || "").split(/\s+/)[0]
    if (!id) return null
    const scope = page.locator('[id="' + id.replace(/(["\\])/g, "\\$1") + '"]')
    try {
      if ((await scope.count()) === 1) return scope
    } catch {}
    return null
  }
  const optionLocator = async (loc, value) => {
    const named = await menuScope(loc)
    const scope = named ?? page
    // A PAGE-WIDE SEARCH MUST AT LEAST BE RESTRICTED TO ROWS A HUMAN COULD
    // CLICK. Defect 2 above says the search was page-wide; this is the case it
    // could not fix, because a control that names no menu has no scope to
    // narrow to.
    //
    // MEASURED on Affirm's Greenhouse form, 2026-08-04: that page holds exactly
    // ONE [role=listbox] at all times — intl-tel-input's country list, 244 rows,
    // permanently attached and usually hidden. So an unfiltered page-wide
    // search answers every unnamed dropdown out of a list of countries, which
    // is how "Afghanistan+93" becomes the first candidate row for a question
    // about pronouns. Visibility is the honest discriminator: a menu the user
    // could choose from is on screen, and a detached-but-attached one is not.
    const rowSel = named
      ? "[class*='__option'], [role='option']"
      : "[class*='__option']:visible, [role='option']:visible"
    const rows = scope.locator(rowSel)
    try {
      const exact = rows.filter({ hasText: exactRe(value) })
      if ((await exact.count()) > 0) return exact.first()
    } catch {}
    // No declared option rows, or none of them says this: fall back to the
    // text itself, still whole-string. getByText returns the innermost element
    // holding it, and a click on that bubbles to whatever the widget listens
    // on, so nothing needs to know how the row is built. Same visibility bound
    // when the search is page-wide, and for the same reason.
    const byText = scope.getByText(exactRe(value))
    return named ? byText.first() : byText.locator("visible=true").first()
  }

  // ENTER IS PRESSED ONLY WHEN THE PAGE SAYS A ROW IS FOCUSED, and this is a
  // SAFETY rule before it is a correctness one.
  //
  // MEASURED on Torc's Greenhouse embed form, 2026-08-18. type-enter typed the
  // location into react-select's input, waited its 500ms, and pressed Enter
  // before the server-queried suggestions had arrived. react-select handles
  // Enter ONLY when its menu is open with a focused option; otherwise it lets
  // the keydown through — and Enter in a text input inside a <form> is the
  // browser's IMPLICIT SUBMISSION. The board received a submit event, ran its
  // whole-form validation and painted "First Name is required." on every empty
  // field. Nothing was sent that time only because required fields were still
  // empty. A form whose LAST required control is a typeahead would have been
  // submitted by this engine, from a keystroke, past every gate in submit.mjs
  // — the click-surface invariant broken by a key nobody counted as a click.
  //
  // So Enter is pressed only when the focused control reports a focused row:
  // `aria-activedescendant` naming an element that exists (react-select,
  // react-aria and every WAI-ARIA combobox set it while a row is highlighted),
  // or a focused/selected row inside the menu the control names. Nothing
  // reported means nothing to commit, and this strategy FAILS to the next one
  // (type-click clicks the row it can see; no key is sent). The submit guard
  // installed by fillPage() catches what this misses; this stops the keystroke
  // at its source and stops the board from validating a half-filled form on
  // every fill.
  //
  // `ajFocusedOptionProbe` names this evaluate for the instrumented page in
  // src/dev/bench-apply.mjs, exactly as `ajSettleProbe` names the settle
  // probe: the double must be able to answer it in its own terms.
  const focusedOptionShown = () =>
    page
      .evaluate(() => {
        const ajFocusedOptionProbe = true
        const a = document.activeElement
        if (!a || !a.getAttribute || !ajFocusedOptionProbe) return false
        const id = String(a.getAttribute("aria-activedescendant") || "").trim()
        if (id && document.getElementById(id)) return true
        const menuId = String(
          a.getAttribute("aria-controls") || a.getAttribute("aria-owns") || "",
        )
          .trim()
          .split(/\s+/)[0]
        const menu = menuId ? document.getElementById(menuId) : null
        if (
          menu &&
          menu.querySelector(
            "[aria-selected='true'],[class*='is-focused'],[class*='--is-focused']," +
              "[class*='highlighted'],[class*='Highlighted'],[data-focused='true']",
          )
        )
          return true
        return false
      })
      .catch(() => false)

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
    "type-enter": async (loc, value, open = openCombo) => {
      await open(loc)
      await page.keyboard.type(String(value).slice(0, 60), { delay: 20 })
      await page.waitForTimeout(500)
      if (!(await focusedOptionShown())) {
        throw new Error(
          "no row focused after typing — Enter not pressed (it would submit the form)",
        )
      }
      await page.keyboard.press("Enter")
    },
    // Filter, then click the exact row — safer when Enter picks a near-match,
    // and here the condition IS precise: the row we are about to click is the
    // one whose text matches the value, and it can only exist once filtering
    // has produced it. Same 500ms ceiling, but a list that filters in 80ms
    // costs 80ms.
    "type-click": async (loc, value, open = openCombo) => {
      await open(loc)
      await page.keyboard.type(String(value).slice(0, 40), { delay: 20 })
      const row = await optionLocator(loc, value)
      await row.waitFor({ state: "attached", timeout: 500 }).catch(() => {})
      await row.click({ timeout: 2500 })
    },
    // Short lists that do not filter at all.
    "click-option": async (loc, value, open = openCombo) => {
      await open(loc)
      const row = await optionLocator(loc, value)
      await row.click({ timeout: 2500 })
    },
  }

  // WHAT THE FORM WILL SEND, NOT WHAT THE BOX IS SHOWING.
  //
  // MEASURED ON ORACLE RECRUITING CLOUD, 2026-08-04, and this is the half of
  // the dropdown defect that made the other half INVISIBLE. On ORC the visible
  // input is a FILTER: text typed into it is not an answer, and the value the
  // form submits lives in the widget's own model. Reading the control straight
  // after typing therefore reads back the string we just typed — the check
  // passed, the strategy was recorded as the one that worked, and the field
  // reverted to empty the moment focus left it. The application was submitted
  // with three required pickers empty and the run reported every one filled.
  //
  // A readback that can be satisfied by the act of typing is not a readback.
  // Blurring first is what separates "the widget accepted this" from "the box
  // is showing what I typed": a widget that committed keeps its value, and one
  // that did not reverts, which is exactly the distinction being measured. It
  // costs one CDP call and 150ms per attempt, and it also leaves the menu shut
  // before the next strategy runs.
  const committedValue = async (loc) => {
    try {
      await loc.evaluate((el) => el.blur && el.blur())
      await page.waitForTimeout(150)
    } catch (e) {
      if (isStaleError(e)) throw e
    }
    return await shownValue(loc)
  }

  // A LONGER SPELLING OF THE ANSWER IS ACCEPTED; A DIFFERENT ANSWER THAT
  // HAPPENS TO CONTAIN IT IS NOT.
  //
  // This used to be `got.includes(want)`, which accepts any superstring in any
  // position — so "Protected Veteran" satisfied a request for "Veteran", and a
  // wrong, materially false selection was reported as a success. Containment
  // was there for the real case where a widget renders a fuller form of what
  // was asked for ("United States" -> "United States of America"), and a PREFIX
  // at a word boundary keeps exactly that case and drops the rest: an option
  // that merely mentions the words later in its text is a different option.
  // PUNCTUATION IS NOT MEANING. MEASURED on Quora's Ashby form 2026-08-18: the
  // bank spells the school "University of Nevada - Las Vegas", the board's own
  // list spells it "University of Nevada, Las Vegas", the typeahead committed
  // the right row and the readback failed on a hyphen. The last resort below
  // compares the two with separators folded to spaces — EQUALITY only, never
  // a prefix, so "1-3 years" and "13 years" stay different ("1 3" vs "13") and
  // an option that merely contains the words is still not the value.
  const foldPunct = (s) =>
    norm(s)
      .replace(/[,;:.\-–—/()]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  // THE SAME CALENDAR DAY IS THE SAME VALUE, whatever the widget renders.
  // MEASURED on OpenAI's Ashby form 2026-08-21: a react date widget backed by
  // a text input was typed "2026-08-18" and re-rendered it "08/18/2026", so
  // every strategy "failed" on a field the widget had committed correctly and
  // the job deferred at submit_readiness. Recognised shapes only — ISO
  // YYYY-MM-DD and US MM/DD/YYYY (both sides tried both ways) — and EQUALITY
  // of all three parts, never a fuzzy parse: "08/18/2026" equals
  // "2026-08-18" and nothing else does.
  const dateParts = (s) => {
    let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
    if (m) return `${m[1]}-${m[2]}-${m[3]}`
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s)
    if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`
    return null
  }
  const accepts = (got, want) => {
    const g = norm(got)
    const w = norm(want)
    if (!g || !w) return false
    if (g === w) return true
    if (g.startsWith(w) && /[\s(,\-:/]/.test(g.charAt(w.length))) return true
    const gd = dateParts(g)
    if (gd && gd === dateParts(w)) return true
    // A bare-year value equals Jan 1 of that year AND NOTHING ELSE — the
    // deterministic expansion actOn() types into a date widget that refuses
    // a bare year (measured Quora/Ashby 2026-08-23). Any other day in the
    // year is NOT accepted: this is recognising our own expansion, never a
    // fuzzy "same year is close enough".
    if (/^\d{4}$/.test(w) && gd === `${w}-01-01`) return true
    return foldPunct(g) === foldPunct(w)
  }

  // WHERE THE BOARD RENDERS A CHOSEN VALUE DIFFERENTLY FROM ITS OPTION TEXT.
  //
  // MEASURED on Torc's Greenhouse embed form, 2026-08-18: Country* offers
  // "United States +1" and, once chosen, shows "+1". accepts() rightly says
  // "+1" is not "United States +1", so every strategy "failed", the item was
  // reported failed and the verify pass mismatched it — on a field the widget
  // had committed correctly. ats/greenhouse.mjs has declared exactly this
  // shape as a valueAlias since 2026-07-27, and AUDIT H8 (2026-08-04) copied
  // the aliases onto the plan "the engine actually reads" — but nothing in this
  // file ever read them. Both readbacks now do: the strategy ladder's commit
  // check and the verify pass. An alias is knowledge from an adapter, keyed on
  // the field's LABEL and the planned VALUE, and it only ever widens what is
  // ACCEPTED as the readback of a value the plan already resolved — it never
  // chooses a value.
  //
  // A RegExp does not survive JSON, and the plan crosses JSON on the MCP path
  // (fill-plan.json, the embedded bootstrap). So an alias part may arrive as a
  // RegExp (in-process runner), as `{source, flags}` (serialised by
  // browser.mjs's embedLiteral / fill-plan.mjs's writer), or as a bare string;
  // all three are read. Anything else is not an alias and is ignored.
  const toRe = (x) => {
    if (x instanceof RegExp) return x
    if (x && typeof x === "object" && typeof x.source === "string") {
      try {
        return new RegExp(x.source, typeof x.flags === "string" ? x.flags : "")
      } catch {
        return null
      }
    }
    if (typeof x === "string" && x) {
      try {
        return new RegExp(x, "i")
      } catch {
        return null
      }
    }
    return null
  }
  const aliasFor = (item) => {
    for (const a of Array.isArray(plan.valueAliases) ? plan.valueAliases : []) {
      const l = toRe(a && a.label)
      const v = toRe(a && a.value)
      const acc = toRe(a && a.accept)
      if (!l || !v || !acc) continue
      if (l.test(String(item.label || "")) && v.test(String(item.value || "")))
        return acc
    }
    return null
  }
  const acceptsFor = (item, got) => {
    if (accepts(got, item.value)) return true
    const acc = aliasFor(item)
    return !!(acc && norm(got) && acc.test(String(got || "")))
  }

  // WHICH LADDER THIS FIELD CLIMBS, AND WHY A HINT ONLY REORDERS IT.
  //
  // `plan.comboStrategies` is the BOARD's order — an adapter's list, with the
  // board-level cached winner already hoisted to the front by fill-plan.mjs.
  // `item.via` is narrower and is better evidence: the strategy that actually
  // committed THIS field on THIS form last time. field-cache.mjs's applyCache
  // serves it back onto the scan (`f.via`) and buildPlan copies it onto the
  // item, and since Phase 4 both the attended CLI and the unattended stages
  // record it — but nothing here read it, so every application re-paid for the
  // board's losing strategy on a field whose winner was already known. That is
  // 1.5-2.5s per combo, the same cost plan.comboStrategies exists to avoid,
  // and a board whose per-field widgets disagree (one picker filters, another
  // does not) cannot be fixed by a single board-level order at all.
  //
  // REORDER, NEVER SHORTEN. A hint goes stale exactly when a board changes its
  // widget — which is the moment trusting it would fail the field outright —
  // so the whole ladder still runs behind it: a wrong hint costs one extra
  // attempt, never an unfilled field. A name no strategy implements (a retired
  // strategy still sitting in an old cache entry) is dropped rather than run.
  // And the array returned is always a NEW one: plan.comboStrategies is the
  // board's, shared by every item, and one field's hint must not reorder it
  // for the rest of the form.
  const comboOrder = (first) => {
    const order = plan.comboStrategies || [
      "type-enter",
      "type-click",
      "click-option",
    ]
    if (!first || !strategies[first]) return order
    return [first, ...order.filter((n) => n !== first)]
  }

  const setCombo = async (loc, item) => {
    let last = "no strategy ran"
    for (const name of comboOrder(item.via)) {
      const run = strategies[name]
      if (!run) continue
      try {
        await run(loc, item.value)
        await page.waitForTimeout(200)
        const got = await committedValue(loc)
        if (acceptsFor(item, got)) return { ok: true, via: name }
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

  // --- multi-token pickers -------------------------------------------------
  // The multi twin of openCombo. Once a token picker holds selections, the
  // control's CENTRE can be a token's × remove control — a centre click would
  // DELETE a committed choice instead of opening the menu. The inner combobox
  // input always sits after the last token and never carries a remove
  // control, so it is the click target whenever one exists; a control with no
  // inner input (ORC stamps the input itself) gets the ordinary click, where
  // there are no tokens to hit. Single-select combos keep openCombo
  // unchanged: their centre is the placeholder/value text, and rerouting a
  // click that works on every measured board is not worth the symmetry.
  const openComboMulti = async (loc) => {
    await loc.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {})
    const inner = loc
      .locator(
        "input[role='combobox'], [class*='__input'] input, " +
          "input[class*='__input']",
      )
      .first()
    let found = 0
    try {
      found = await inner.count()
    } catch {}
    if (found) await inner.click({ timeout: 2500 })
    else await loc.click({ timeout: 2500 })
    await page.waitForTimeout(220)
  }

  // The token list a multi picker currently shows — the same bounded walk and
  // the same token/label preference as shownValue()'s multi branch, returned
  // as a LIST so the per-value loop below can check one value without being
  // fooled by another's text. A verify-class read: DOM out as data, nothing
  // more.
  const multiTokens = (loc) =>
    loc.evaluate((el) => {
      const txt = (s) =>
        String(s == null ? "" : s)
          .replace(/\s+/g, " ")
          .trim()
      for (let p = el, i = 0; p && i < 5; p = p.parentElement) {
        if (
          p.tagName === "FORM" ||
          p.tagName === "BODY" ||
          p.tagName === "HTML"
        ) {
          break
        }
        if (
          p !== el &&
          p.querySelectorAll(
            "[role='combobox'], [aria-autocomplete='list'], [class*='select__control']",
          ).length > 1
        ) {
          break
        }
        const mv = [
          ...p.querySelectorAll(
            "[class*='multi-value'], [class*='multiValue']",
          ),
        ]
        if (mv.length) {
          const labels = mv.filter((x) =>
            /label/i.test(String(x.className || "")),
          )
          const use = labels.length
            ? labels
            : mv.filter((x) => !mv.some((o) => o !== x && o.contains(x)))
          return use.map((x) => txt(x.innerText)).filter(Boolean)
        }
        i++
      }
      return []
    })

  // One value at a time: select it, verify its TOKEN appeared, move on. A
  // token picker's committed store is its token list (see shownValue), so
  // per-value verification reads that and nothing else — a filter box keeping
  // typed text proves nothing here either. Values whose token is already
  // present are SKIPPED, which is what makes the item-level stale-locator
  // replay safe: a replay re-selects only what the remount lost instead of
  // re-driving (and on a toggling widget, un-selecting) what survived. One
  // value that lands on no token fails the whole item — a partial selection
  // reported ok would ship an answer the user never gave.
  const setComboMulti = async (loc, item) => {
    const wants = (item.values || []).map((v) => String(v))
    const tokensNow = async () => {
      try {
        return await multiTokens(loc)
      } catch (e) {
        if (isStaleError(e)) throw e
        return []
      }
    }
    const has = (tokens, want) => tokens.some((t) => accepts(t, want))
    // WHAT WORKED FOR VALUE 1 IS TRIED FIRST FOR VALUE 2, and VALUE 1 STARTS
    // FROM THE CACHED HINT. A strategy this widget ignores still costs 1.5-2.5s
    // before it is ruled out (the same measurement plan.comboStrategies exists
    // because of), and a multi field walks the ladder once PER VALUE — so a
    // 3-value picker on a board whose first strategy does not work paid that
    // failure three times. The order is only reordered, never shortened: if
    // either the remembered winner or this run's own winner stops working
    // mid-field, the rest of the ladder still runs.
    //
    // `via` is what THIS run proved and `item.via` is only what a previous one
    // remembered, so `via` wins once it exists — and only `via` is returned. A
    // field whose tokens were all already present ran no strategy and therefore
    // reports nothing, rather than re-asserting the hint as a fresh measurement
    // and feeding it to the board-level count in fillPage().
    let via = null
    for (const value of wants) {
      if (has(await tokensNow(), value)) continue
      let done = false
      let last = "no strategy ran"
      const tryOrder = comboOrder(via ?? item.via)
      for (const name of tryOrder) {
        const run = strategies[name]
        if (!run) continue
        try {
          await run(loc, value, openComboMulti)
          await page.waitForTimeout(200)
          const got = await tokensNow()
          if (has(got, value)) {
            done = true
            via = name
            break
          }
          last = "after " + name + ' the tokens read "' + got.join(", ") + '"'
        } catch (e) {
          last = name + ": " + e.message
        }
        // Leave the widget closed before the next attempt.
        try {
          await page.keyboard.press("Escape")
          await page.waitForTimeout(120)
        } catch {}
      }
      if (!done) return { ok: false, why: '"' + value + '": ' + last }
    }
    // Shut and blurred before the verify pass reads it, same as
    // committedValue leaves a single-select.
    try {
      await page.keyboard.press("Escape")
    } catch {}
    try {
      await loc.evaluate((el) => el.blur && el.blur())
      await page.waitForTimeout(150)
    } catch (e) {
      if (isStaleError(e)) throw e
    }
    return { ok: true, via }
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
          // RULE 0 (2026-08-18): THE SCANNER'S OWN SELECTOR FOR THIS INPUT
          // BEATS ANY TEXT WALK. The plan carries `sel` when the scanner
          // stamped an app-owned selector on the file input (`#resume`,
          // `#_systemfield_resume`); an id survives the remount the text walk
          // was invented for, and it names ONE element. The walk stays as the
          // fallback for inputs the scanner could not name.
          //
          // MEASURED on a live Ashby form (Eliza, dry run): the walk matched
          // /resume|\bcv\b/ against the "Autofill from resume" helper input's
          // heading — a nearer ancestor than the real slot's — and stamped the
          // résumé onto the helper. `#_systemfield_resume` (required) then read
          // empty at verify, so the fill was refused; on the attended path the
          // same routing had put the résumé through the board's parser instead
          // of into the slot. The selector goes first because it is the one
          // thing on the page the board wrote for exactly this purpose.
          if (spec.sel) {
            let target = null
            try {
              const hits = [...document.querySelectorAll(spec.sel)]
              if (hits.length === 1) target = hits[0]
            } catch {}
            if (
              target &&
              target.tagName === "INPUT" &&
              target.type === "file" &&
              free.includes(target)
            )
              best = {
                el: target,
                depth: 0,
                len: 0,
                order: free.indexOf(target),
              }
          }
          for (let order = 0; !best && order < free.length; order++) {
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
          // `selector` is the scanner's own selector (rule 0 above): as
          // decisive as a label, and reported distinctly so a run log can say
          // which mechanism placed each file.
          const how = best ? (best.depth === 0 ? "selector" : "label") : "order"
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
  // When the LAST file landed on an input. The settle stage before verify
  // gives boards SETTLE.uploadMs from this moment to react (swap the input
  // out, or read the file and reset it) before the readback judges them.
  let lastUploadAt = 0

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
          sel: typeof item.sel === "string" && item.sel ? item.sel : null,
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
  // Which plan item each stamp belongs to. The DOM readback below runs after
  // this loop and only holds the RECORD, but fail() takes the item — so the
  // link is kept here rather than rediscovered by matching `k`, which assumes
  // keys are unique across the plan.
  const itemByTag = new Map()
  for (const item of uploadItems) {
    const tag = "u" + ++uploadN
    const pattern = patternOf(item)
    if (refuseAll) {
      fail(item, refuseAll)
      continue
    }
    let raw = null
    try {
      raw = await resolveUploads(
        [
          {
            pattern,
            sel: typeof item.sel === "string" && item.sel ? item.sel : null,
            tag,
          },
        ],
        true,
      )
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
    itemByTag.set(tag, item)
    try {
      await page
        .locator('[data-ajup="' + tag + '"]')
        .setInputFiles(item.paths, { timeout: 5000 })
      // NO WAIT HERE, on measured evidence. This used to wait up to 1s for the
      // stamped input to leave the DOM ("the remount is how we know React
      // accepted it") — and on every fixture board, every run, it paid the
      // full second: no board detaches the stamp, so the "condition" was a
      // flat cost wearing one's clothes (docs/measurements.md, B1: 2×1007ms on
      // Greenhouse, ~73% of the fill wall). The next lookup does not need it
      // either — resolveUploads re-queries the DOM per item and skips stamped
      // or filled inputs, so a mid-swap board cannot mis-route the next file.
      //
      // What the wait was ACTUALLY buying is time for a board's asynchronous
      // reaction — Greenhouse swapping the input for an attached-file view,
      // Ashby's resume-parse remount dropping the FileList at ~700ms — to land
      // before the readback judges the upload. That window still exists, with
      // the same ceiling, but it is now the settle stage before the verify
      // pass: anchored at the LAST upload (`lastUploadAt`), overlapped with
      // the non-upload fills instead of paid serially per upload, and able to
      // end early the moment every stamp has visibly reacted. `settled` is
      // recorded there, where the watching actually happens.
      record.settled = "unknown"
      record.attached = true
      out.ok++
      lastUploadAt = Date.now()
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
  // A BARE YEAR TYPED INTO A DATE-PARSING WIDGET LANDS IN THE WRONG YEAR.
  // MEASURED on Quora's Ashby form 2026-08-23: a react date input typed "2019"
  // parsed it as an ISO year — midnight UTC, 2019-01-01 — and rendered the
  // LOCAL time of that instant: "12/31/2018". Not a display quirk like the
  // 08-21 case in accepts(): the committed value is genuinely a day in the
  // wrong year, and the verify pass rightly deferred the job on it. The
  // correction is EVIDENCE-DRIVEN: only after blurring (the ORC lesson —
  // committed, not displayed) and only when the widget demonstrably
  // re-rendered the year as a full calendar date in a DIFFERENT year is the
  // field re-filled with "01/01/<year>" — a slash date, which JS parses as
  // LOCAL time, so the year holds. The day is the widget's demand, not a
  // claimed fact: the plan's value stays the bare year the fact base holds,
  // and accepts()/the verify pass treat <year> and Jan 1 of <year> as the
  // same value — that pair and nothing else. The poll exists because the
  // widget normalises ASYNCHRONOUSLY after blur: a single early read sees the
  // raw "2019" still in the box, concludes nothing is wrong, and the wrong
  // year surfaces only at the verify pass, where nothing refills. Three reads
  // over ~2s bound the wait; a widget that never re-renders costs the field
  // 2s once and is left exactly as typed.
  // A poll-and-correct version of this (blur, wait up to 2.1s, re-fill if the
  // widget re-rendered the year as a date in the wrong year) was tried first
  // and never fired: the widget normalises LAZILY — later than any bounded
  // wait, sometimes not until the form validates — so every read saw the raw
  // "2019" still in the box and the wrong year surfaced only at the verify
  // pass, where nothing refills. Hence preemptive: the label's word "date" is
  // used ONLY to pick a FORMAT (rule 0 note: attacker-controlled text routes
  // no value here — the year typed is the fact base's year either way, and
  // the worst a lying label earns is a date-shaped rendering of the same
  // year). A "…year" label without "date" keeps the bare year.
  // A DATE PICKER OPENS A CALENDAR OVER THE REST OF THE FORM, AND A FILL IS
  // WHAT OPENS IT.
  //
  // MEASURED off the live widget's own React props (jobs.ashbyhq.com, the
  // start-date field, 2026-09-02): `preventOpenOnFocus: false`,
  // `withPortal: false`, `popperClassName: "…ashby-application-form-input-
  // date-popup"`, and no portal node anywhere in the document. So the calendar
  // renders INLINE, absolutely positioned by popper — and `loc.fill()` focuses
  // before it types, which is precisely the event that opens it.
  //
  // WHAT IS UNDERNEATH IT on that form, in DOM order, is the next three
  // controls this engine acts on: the work-authorisation, sponsorship and
  // in-office Yes/No pairs. A popper covering one of those does not cause a
  // WRONG click — Playwright's actionability check requires the target to be
  // the element at the click point, so it would wait out its timeout and the
  // item would reach fail(), which blocks the submit. That is the safe
  // direction and it is why this was never seen: it costs an application, in
  // a way that reads as a mysterious timeout rather than as a covered field.
  //
  // Blur is the widget's OWN close path (react-datepicker's handleBlur calls
  // setOpen(false)) and it is also its own COMMIT path, so this does two
  // things at once: the calendar goes away, and the value we typed is parsed
  // and re-rendered by the widget before anything reads it back. Escape would
  // also close it, but a synthetic key on a live application form is a bigger
  // claim than taking focus off a field — and fillPage already treats a key
  // press on a form as a thing to be careful with.
  //
  // SCOPED TO MARKED CONTROLS. Blurring after EVERY fill would be a change to
  // the behaviour of every text field on every board — boards validate on
  // blur, and `verify.errors` is a submit-gate input — for the benefit of one
  // widget shape. A field with no `dateWidget` is untouched, and a plan built
  // before this existed carries no such key, so it is a no-op there too.
  //
  // FAILURE HERE IS NOT THE ITEM'S FAILURE. The value is already typed; a
  // detached element or a page that refuses the call means the calendar may
  // still be open, which is the situation this had before. Throwing would
  // turn a landed fill into a reported failure, which is the one outcome
  // worse than the problem.
  const closeDatePicker = async (loc, item) => {
    if (!item || !item.dateWidget) return
    try {
      await loc.evaluate((el) => el.blur())
    } catch {
      /* see above: the fill stands whatever the blur did */
    }
  }

  const expandBareYearForDateField = (item) => {
    const v = String(item.value)
    return /^\d{4}$/.test(v) && /\bdate\b/i.test(String(item.label ?? ""))
      ? `01/01/${v}`
      : v
  }

  // THE WIDGET VERB — the one verb that clicks a control the DOM does not
  // classify as a form field, and the only one with its own admission test.
  //
  // WHY IT EXISTS. Ashby renders its Yes/No questions — work authorisation,
  // sponsorship, in-office — as PAIRS OF <button> ELEMENTS with a hidden
  // backing store. `kindOf()` answers "forbidden:button" for those, so no verb
  // could touch them: the plan deferred, or (before 2026-08-25, when the
  // scanner did not even mark them required) `optional: skip` left them blank,
  // the submit was clicked, and Ashby's own validation refused it. The staged
  // capture of a real Eliza click is that page — still the form, both required
  // groups unanswered. This verb is CLAUDE.md's sanctioned route: an adapter
  // that knows a board's shape, never a model resolving a field.
  //
  // ADMISSION IS STRICTER THAN kindOf, NOT LOOSER. kindOf still refuses a
  // <button> for every other verb; this branch runs before it and applies four
  // clauses of its own, and clause 2 is the load-bearing one:
  //
  //   1. actionable — visible, not disabled/aria-disabled/aria-hidden;
  //   2. IT DECLARES A READABLE STATE — aria-pressed or aria-checked present,
  //      or a role in the state-carrying set. A bare <button> is REFUSED. Ashby
  //      shipped exactly that shape before 2026: the chosen option was marked
  //      only by a build-hashed CSS class, and there is no honest way to read
  //      which answer is selected. No readback surface, no actuation — because
  //      a click we cannot verify is a claim we cannot make;
  //   3. the page agrees with the plan — the element's own text (or aria-label)
  //      normalises equal to the option the plan chose. A board that re-rendered
  //      between scan and fill fails here rather than having a stamp clicked
  //      blind;
  //   4. a backstop for clause 2's residue: refuse anything whose text reads as
  //      submit/apply/next/back/continue, in case a board puts aria-pressed on
  //      an action control.
  //
  // IDEMPOTENT BY CONSTRUCTION. actOn is replayed up to STALE_ATTEMPTS on a
  // detached element, and a TOGGLE re-clicked is a toggle turned off — unlike
  // fill/select/check, which are idempotent for free. So the state is read
  // FIRST and a satisfied control is left alone.
  const WIDGET_STATE_ROLES = new Set([
    "radio",
    "checkbox",
    "switch",
    "menuitemradio",
    "menuitemcheckbox",
    "option",
  ])
  const WIDGET_ACTION_TEXT =
    /^(submit|apply|apply now|next|continue|back|previous|save|cancel|close|delete|withdraw)\b/i

  // Reads the state of every option in the group in ONE evaluate — one turn of
  // the page's event loop, so it cannot be raced the way N locator reads can.
  // Returns null for an option that is absent or declares no state at all.
  const widgetStates = async (item) => {
    const sels = (item.options ?? [])
      .map((o) => o.sel || (o.k ? `[data-aj="${o.k}"]` : null))
      .filter(Boolean)
    if (!sels.length) return []
    return page.evaluate((list) => {
      const on = (el) => {
        if (!el) return null
        const p = el.getAttribute("aria-pressed")
        const c = el.getAttribute("aria-checked")
        if (p === null && c === null) return null
        return (p ?? c) === "true"
      }
      return list.map((s) => {
        let el = null
        try {
          el = document.querySelector(s)
        } catch {
          /* a selector the page rejects reads as absent */
        }
        return { sel: s, present: !!el, on: on(el) }
      })
    }, sels)
  }

  const actOnWidget = async (loc, item) => {
    const want = norm(item.value)
    const admit = await loc.evaluate((el) => {
      const txt = (s) =>
        String(s || "")
          .replace(/\s+/g, " ")
          .trim()
      const style = el.ownerDocument.defaultView.getComputedStyle(el)
      return {
        disabled:
          !!el.disabled ||
          el.getAttribute("aria-disabled") === "true" ||
          el.getAttribute("aria-hidden") === "true",
        hidden:
          style.display === "none" ||
          style.visibility === "hidden" ||
          !(
            el.getBoundingClientRect().width ||
            el.getBoundingClientRect().height
          ),
        pressed: el.getAttribute("aria-pressed"),
        checked: el.getAttribute("aria-checked"),
        role: (el.getAttribute("role") || "").toLowerCase(),
        text: txt(
          el.innerText || el.textContent || el.getAttribute("aria-label"),
        ),
      }
    })
    if (admit.disabled || admit.hidden)
      throw new Error(
        "widget-admission: the control is disabled or not visible",
      )
    const declaresState =
      admit.pressed !== null ||
      admit.checked !== null ||
      WIDGET_STATE_ROLES.has(admit.role)
    if (!declaresState)
      throw new Error(
        "widget-admission: this control declares no readable state " +
          "(no aria-pressed/aria-checked, no state role) — a click that cannot " +
          "be verified is not an answer; resolve it by hand",
      )
    if (WIDGET_ACTION_TEXT.test(admit.text))
      throw new Error(
        `widget-admission: refusing to click an action control ("${admit.text.slice(0, 40)}")`,
      )
    if (norm(admit.text) !== want)
      throw new Error(
        `widget-admission: the page shows "${admit.text.slice(0, 40)}" where the ` +
          `plan chose "${String(item.value).slice(0, 40)}" — the page changed ` +
          `since it was scanned`,
      )

    // Read first: a satisfied group is left untouched, so a stale replay
    // cannot toggle a correct answer back off.
    const chosenSel = item.sel
    const satisfied = (states) => {
      const mine = states.find((s) => s.sel === chosenSel)
      if (!mine || mine.on !== true) return false
      return !states.some((s) => s.sel !== chosenSel && s.on === true)
    }
    const before = await widgetStates(item)
    if (before.length && satisfied(before)) return

    await loc.scrollIntoViewIfNeeded({ timeout: 2500 })
    await loc.click({ timeout: 2500 })

    // Poll for positive evidence only, exiting early when it arrives — the
    // same asymmetry the settle stage uses: silence is not evidence.
    let states = []
    for (let i = 0; i < 3; i++) {
      states = await widgetStates(item)
      if (states.length && satisfied(states)) return
      await page.waitForTimeout(SETTLE.pollMs)
    }
    states = await widgetStates(item)
    if (states.length && satisfied(states)) return

    // FAIL CLOSED. Either the control never reported itself pressed, or more
    // than one option did. Both mean the answer on the page is not the answer
    // the plan made, and submitReadiness must refuse.
    const mine = states.find((s) => s.sel === chosenSel)
    const others = states.filter((s) => s.sel !== chosenSel && s.on === true)
    if (others.length)
      throw new Error(
        `widget-readback: clicked "${item.value}" but ${others.length} other ` +
          `option(s) also read selected — the group's answer is ambiguous`,
      )
    throw new Error(
      `widget-readback: clicked "${item.value}" and the control still reads ` +
        `unselected (${mine ? `state=${mine.on}` : "option not found"}) — this ` +
        `board does not report its own state; answer it by hand`,
    )
  }

  const actOn = async (loc, item) => {
    // Before kindOf, which refuses a <button> outright for every other verb.
    if (item.how === "widget") return actOnWidget(loc, item)
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
      await loc.fill(expandBareYearForDateField(item), { timeout: 2500 })
      await closeDatePicker(loc, item)
    } else if (item.how === "select") {
      // A plan item carrying `values` targets a <select multiple>. Playwright
      // replaces the whole selection with exactly this set, so a stale-retry
      // replay of the item cannot double or toggle anything.
      await loc.selectOption(
        Array.isArray(item.values) && item.values.length
          ? item.values.map((v) => ({ label: String(v) }))
          : { label: String(item.value) },
        { timeout: 2500 },
      )
    } else if (item.how === "check") {
      const on = item.value === false || item.value === "false" ? false : true
      if (on) await loc.check({ timeout: 2500 })
      else await loc.uncheck({ timeout: 2500 })
    } else if (item.how === "type") {
      await typeInto(loc, expandBareYearForDateField(item))
      await closeDatePicker(loc, item)
    } else if (item.how === "combo") {
      const r =
        Array.isArray(item.values) && item.values.length
          ? await setComboMulti(loc, item)
          : await setCombo(loc, item)
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
  const guardFail = async (why) => {
    out.failed++
    out.failures.push({ k: "-", how: "guard", why })
    // The submit guard is armed by now; a page-guard refusal must not leave it
    // on a page the runner may still walk.
    out.submitsBlocked = await disarmSubmitGuard()
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

  // --- settle, then verify --------------------------------------------------
  await page.evaluate(
    () => document.activeElement && document.activeElement.blur(),
  )
  // Replaces a flat 450ms sleep here and a serial 1s-per-upload wait above,
  // both measured settling by TIMEOUT on every fixture board in every run
  // (docs/measurements.md, B1). TWO conditions, one loop, overlapped:
  //
  //   quiet   — the board's rendered validation text has APPEARED and then
  //             stopped changing between two polls, or SETTLE.quietMs passed.
  //
  //             EARLY EXIT ONLY ON POSITIVE EVIDENCE, and this asymmetry is
  //             the whole design. "Nothing has rendered yet" is not evidence
  //             that nothing will: a 300ms debounce — ordinary in form
  //             libraries — looks identical at poll 0 and poll 1 to a board
  //             that will never say anything, so a stability rule that
  //             accepted silence would exit at 200ms and miss it. What it
  //             would miss is not cosmetic: `verify.errors` is a submit-gate
  //             input (fill-plan.mjs), so an unseen validation message is an
  //             application submitted into a form the board rejected. So
  //             silence pays the ceiling, exactly as the flat sleep did — no
  //             regression against it — and only a board that has spoken and
  //             repeated itself gets to end the wait sooner.
  //
  //             ON AN UPLOAD PAGE THIS COSTS NOTHING EXTRA. The two arms share
  //             one loop, and 450 < 1000: a page carrying an upload was going
  //             to be here anyway. The residual flat cost is a page with NO
  //             upload, which still pays up to 450 — measured and reported as
  //             such rather than shrunk on a guess (the 2026-08-05 audit's #25
  //             asked for a bounded wait with this ceiling, and that is what
  //             this is).
  //   uploads — every input this run stamped has visibly REACTED to its file:
  //             left the DOM (Greenhouse swaps in an attached-file view), or
  //             had its FileList taken (Ashby's async parse remount rebuilds
  //             the form and an innerHTML round trip cannot carry files). An
  //             input still HOLDING its file is indistinguishable from a board
  //             about to drop it, so held inputs are watched until
  //             SETTLE.uploadMs after the last setInputFiles. The readback
  //             below must not judge an upload while the board's reaction is
  //             still in flight — reading early and calling it good is exactly
  //             the ok-with-no-resume shape this engine exists to refuse.
  //
  // The probe reads NOTHING new off the page: the same input[type=file] walk
  // the readback below does, the same error selectors the verify pass reads,
  // reduced to one change-detection string that never leaves this loop. A page
  // that cannot answer it (the accounted bench double, a unit-test fake)
  // returns something unshaped and the loop stops at once — the readback and
  // verify passes carry their own guards, and such a page loses nothing but
  // the waiting.
  //
  // A FILL THAT TOUCHED NOTHING SETTLES NOTHING. Every item skipped or
  // deferred means no interaction happened, so there is no board reaction to
  // wait out and the verify pass reads a page this run never changed. The old
  // flat sleep was paid there too — 450ms per page for doing nothing, on every
  // page of a multi-page walk whose fields were all deferred.
  const watched = out.uploads.filter((u) => u.attached)
  const settleT0 = Date.now()
  const acted = out.ok > 0 || out.failed > 0
  // TWO CLOCKS, AND THE CEILING IS WHICHEVER SAYS "DONE" FIRST. The wall
  // clock is the real one, and it is the only one that credits this stage for
  // work already done — the upload window is measured from the last
  // setInputFiles, so every non-upload item filled since then has already
  // spent part of it. The poll count is the second, and it exists because the
  // accounted bench (bench-apply.mjs) and unit doubles RECORD waitForTimeout's
  // argument instead of sleeping it: on those pages the wall clock never
  // advances, and a wall-only ceiling would spin the loop instead of ending
  // it. `poll * pollMs` is what the same loop would have cost on a real page,
  // so the two agree by construction — a real page hits the wall deadline at
  // or before the poll budget, a double hits the poll budget exactly.
  const uploadDeadline = watched.length ? lastUploadAt + SETTLE.uploadMs : 0
  const ceilingPolls = Math.ceil(
    Math.max(SETTLE.uploadMs, SETTLE.quietMs) / SETTLE.pollMs,
  )
  let uploadsDone = watched.length === 0
  let quietDone = !acted
  let prevErr = null
  let lastUpl = null
  for (let poll = 0; acted; poll++) {
    let probe = null
    try {
      probe = await page.evaluate(
        (tags) => {
          const all = [...document.querySelectorAll("input[type=file]")]
          const upl = tags.map((tag) => {
            const el = all.find(
              (x) => x.getAttribute && x.getAttribute("data-ajup") === tag,
            )
            if (!el) return "gone"
            return el.files && el.files.length ? "held" : "empty"
          })
          // The SAME selector list the verify pass reads its `errors` from. It
          // is joined into one string and compared to the previous poll's;
          // nothing derived from it leaves this loop, so no page text enters
          // the report by this route.
          let err = ""
          try {
            for (const e of document.querySelectorAll(
              "[class*='error-message'], [class*='errorMessage'], [role='alert'], [id$='-error']",
            ))
              err += "|" + (e.innerText || "").trim()
          } catch {}
          // `ajSettleProbe` NAMES THIS ANSWER, and it is not decoration. A
          // page double tells the engine's evaluates apart by their SOURCE
          // TEXT, and the substrings this one would otherwise be recognised
          // by — an upload state list, an error string — also appear in the
          // verify pass's source ("upload", "errors"). A double that matched
          // on those answered the VERIFY call with this shape, and the
          // reconciliation that rescues a value landed under a remount then
          // saw no `landed` list and reported a failure for a field that was
          // filled (tests/apply/edge-cases.test.mjs, E4). One unambiguous key
          // is the fix; do not remove it to tidy the shape.
          return {
            ajSettleProbe: true,
            upl,
            err: err.replace(/\|/g, "").trim() ? err : "",
          }
        },
        watched.map((u) => u.tag),
      )
    } catch {}
    if (!probe || !Array.isArray(probe.upl)) break
    lastUpl = probe.upl
    const now = Date.now()
    const waited = poll * SETTLE.pollMs
    if (!uploadsDone)
      uploadsDone =
        probe.upl.every((s) => s !== "held") ||
        now >= uploadDeadline ||
        waited >= SETTLE.uploadMs
    if (!quietDone)
      quietDone =
        (probe.err !== "" && probe.err === prevErr) ||
        now - settleT0 >= SETTLE.quietMs ||
        waited >= SETTLE.quietMs
    prevErr = probe.err
    if ((uploadsDone && quietDone) || poll >= ceilingPolls) break
    try {
      await page.waitForTimeout(SETTLE.pollMs)
    } catch {
      break
    }
  }
  // What the watch concluded, per upload record: "detached" — the board
  // consumed the input (the Greenhouse swap); "reset" — the input is still on
  // the page and its FileList is gone (a board that read the file into its own
  // uploader, or one that dropped it — the readback below rules on which);
  // "held" — the file was still sitting on the input when the watching
  // stopped; "unknown" — the page could not be observed (a test double). The
  // old vocabulary was {detached, timeout}; "timeout" is gone because paying a
  // ceiling is a cost, not a conclusion about the page.
  for (let i = 0; i < watched.length; i++) {
    const s = lastUpl ? lastUpl[i] : null
    watched[i].settled =
      s === "gone" ? "detached" : s === "empty" ? "reset" : s || "unknown"
  }
  out.settle = {
    ms: Date.now() - settleT0,
    quiet: quietDone,
    uploads: uploadsDone,
  }

  // --- and did they land where the plan aimed them? ------------------------
  // INDEPENDENT of the routing decision in the upload loop: this reads the
  // page. The whole reason a cover letter could go out as a resume undetected
  // is that nothing ever compared what the engine decided against what the DOM
  // ended up with — the report carried a count, and a count cannot be wrong
  // about which file is on which input.
  //
  // It runs HERE, after the settle above, and not right after the uploads —
  // deliberately. This is the most-settled DOM the fill will ever see: the
  // settle has either watched every stamped input react or given the board
  // SETTLE.uploadMs to do so, which is what makes the answers below evidence
  // rather than a race. Ashby's parse remount lands at ~700ms and drops the
  // FileList; a readback that ran before it would have called that upload
  // good, and the remount would have unmade it after the report was written.
  //
  // ONE of the three answers is promoted to a failure, and only one:
  //
  //   "gone"     — the input is no longer in the DOM. A board that swaps it for
  //                an attached-file view (Greenhouse does) legitimately has
  //                nothing left to read, so this is a WORKING upload and
  //                calling it a failure would break every Greenhouse run. Data,
  //                never a failure. Do not "fix" this one.
  //   "attached" — the file is on the input. Success, and `seenFile` says which.
  //   "empty"    — the input is STILL ON THE PAGE and holds ZERO files. That is
  //                not "nothing observed", it is positive evidence that the file
  //                did not land, and until 2026-08-05 nothing in this repository
  //                read the field: 7/7 runs at 0b6db30 reported
  //                `fill: ok=4 failed=0 deferred=2` with `_systemfield_resume`
  //                holding no file (tests/dev/b1-browser-fill.test.mjs), i.e. an
  //                application submitted with no resume and a report saying
  //                everything succeeded. `fail()` is the only vocabulary this
  //                engine has for "this did not happen and a human has to look",
  //                and hard rule 6 routes a failed fill to a blocked submit — so
  //                that is what an empty input gets.
  //
  // `attached` is corrected to false along with it, because that key is what a
  // caller reads to say "the file is on the field" and the DOM has just said it
  // is not. Only a record we counted (`attached === true`) is demoted: an
  // upload whose setInputFiles threw already went through fail(), and failing
  // it twice would double-count one document.
  //
  // THE KNOWN FALSE POSITIVE, AND WHY IT IS NOT A REASON TO WEAKEN THIS.
  // Some boards read the file out of the input into their own XHR uploader and
  // then reset `input.value`. On such a board a WORKING upload reads `empty`
  // here, and this demotes it. The DOM cannot tell that page apart from a board
  // that simply dropped the file — both leave an input that is present and
  // holds nothing — so there is no reading of the evidence that gets both cases
  // right, and the choice is only which way to be wrong:
  //
  //   wrong here   -> a stated deferral. The user is told which document did
  //                   not appear to attach and can attach it by hand. One
  //                   question, recoverable, visible.
  //   wrong the
  //   other way    -> an application submitted in their name with no résumé,
  //                   reported as `ok`. That is the exact shape that shipped 7
  //                   runs out of 7 at 0b6db30, and nothing downstream corrects
  //                   it.
  //
  // So this fails CLOSED and stays that way. Do not "fix" it by trusting
  // setInputFiles, by demoting only when the board is unknown, or by
  // enumerating the boards that reset the input — a denylist over third-party
  // markup is exactly how the failure comes back.
  //
  // What IS owed to the false-positive case is legibility, and that is what the
  // `upload-readback-empty` tag in the reason below buys: a board that always
  // reset its inputs would produce that same tag on every application to it,
  // and a run log full of one tag on one board is a board behaviour the user
  // can see and act on (an adapter, §4.2's deterministic route), not a mystery
  // about their own file. One tag on one job is the ordinary failure.
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
          // THE PAGE'S OWN REPORT OF *WHICH* FILE LANDED, CHECKED RATHER THAN
          // MERELY RECORDED.
          //
          // `seenFile` has been written here for as long as this readback has
          // existed and was read by no code at all. The only thing comparing it
          // to `rec.file` was a sentence in SKILL.md asking the agent to eyeball
          // the two — which is not a control, and is not even present on the
          // unattended path, where nothing reads `uploads`.
          //
          // MEASURED 2026-08-06, on three live Ashby applications: those forms
          // carry a THIRD file input labelled "Name" that matches neither
          // `fileFields` regex, so it fell to the positional fallback, consumed
          // `fileOrder[0]` and was planned the resume — which planned the resume
          // TWICE. A document landing in a slot the user never meant it for was
          // counted `attached: true`, `ok++`, and reported as a clean fill.
          // `seen: "attached"` only ever meant "some file is here".
          //
          // MEMBERSHIP, NOT EQUALITY. A board that APPENDS to an input it had
          // already populated leaves our file present beside another one, which
          // is not a mis-target. Our file being ABSENT is the defect, and that
          // is the only thing this fires on.
          if (
            rec.seen === "attached" &&
            rec.attached &&
            rec.file &&
            !hit.names.some(
              (n) =>
                String(n).trim().toLowerCase() ===
                String(rec.file).trim().toLowerCase(),
            )
          ) {
            rec.attached = false
            out.ok--
            // Same 140-char discipline as the sibling below, and the same
            // reason for the tag going first. Nothing page-derived is quoted
            // into it: `seenFile` is the PAGE'S string, so it is recorded on
            // the record for the report and kept out of this sentence.
            fail(
              itemByTag.get(rec.tag) || { k: rec.k, how: "upload" },
              "upload-wrong-file: the input holds a file this run did not " +
                "send it — " +
                (rec.file || "the document") +
                " is not attached here; attach it by hand",
            )
          }
          if (rec.seen === "empty" && rec.attached) {
            rec.attached = false
            out.ok--
            // Under fail()'s 140-char cap: this reaches the user verbatim.
            // `rec.file` is the basename of a path WE chose off our own disk —
            // no page-derived text goes into a sentence addressed to a reader.
            //
            // THE TAG COMES FIRST so the 140-char cap can never eat it: it is
            // the one part of this sentence that has to survive to make a
            // board-wide pattern countable (see the false-positive note above).
            fail(
              itemByTag.get(rec.tag) || { k: rec.k, how: "upload" },
              "upload-readback-empty: the file input is still on the page " +
                "holding no file — " +
                (rec.file || "the document") +
                " did not attach; attach it by hand",
            )
          }
        }
      }
    } catch {}
  }

  const probes = items
    .filter((i) => i.how !== "skip")
    .map((i) => {
      const acc = i.how === "combo" || i.how === "select" ? aliasFor(i) : null
      return {
        k: i.k,
        sel: i.sel || (i.k ? '[data-aj="' + i.k + '"]' : null),
        // A CHECK ITEM IS VERIFIED BY ITS TICK, NOT BY ITS OPTION TEXT.
        // MEASURED on Torc 2026-08-18: a widget pick carries the banked
        // option text as `value` ("None/Not applicable"), the box reads back
        // "true", and every ticked group mismatched — a false refusal of the
        // submit on each. The pick already chose WHICH box; what is verified
        // here is that it is checked (or, for value false, unchecked).
        // A WIDGET ITEM IS VERIFIED BY ITS DECLARED STATE, for the same
        // reason a check item is verified by its tick. `read()` on a <button>
        // falls through to innerText and returns "Yes" — which would be
        // compared against the option label and pass whether or not the board
        // ever recorded the answer. What is verified here is that the control
        // says it is selected, and (via `others`) that no sibling does.
        want:
          i.how === "upload"
            ? null
            : i.how === "check" || i.how === "widget"
              ? i.value === false || i.value === "false"
                ? ""
                : "true"
              : i.value,
        // The group's OTHER options, so the verify pass can assert
        // exclusivity rather than only "the one I clicked went on". A radio
        // group showing two selected answers is not a filled field.
        others:
          i.how === "widget" && Array.isArray(i.options)
            ? i.options
                .map((o) => o.sel || (o.k ? '[data-aj="' + o.k + '"]' : null))
                .filter((s) => s && s !== (i.sel || `[data-aj="${i.k}"]`))
            : undefined,
        // Multi items verify per VALUE — the page renders tokens in its own
        // order, so equality against the joined `want` string would fail a
        // fill that landed every value.
        wants:
          i.how !== "upload" && Array.isArray(i.values) && i.values.length
            ? i.values
            : undefined,
        how: i.how,
        // The adapter's alias for this field, as {source, flags} — a RegExp
        // does not cross page.evaluate; see aliasFor.
        accept: acc ? { source: acc.source, flags: acc.flags } : undefined,
      }
    })

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
    // MIRRORED FROM shownValue(), which carries the full reasoning: a combobox
    // input's own `value` is the SEARCH FILTER, not the answer, and where the
    // widget has a committed store that store is the answer EVEN WHEN EMPTY.
    //
    // This pass reads the DOM directly inside one page.evaluate — that is what
    // makes it unraceable — so it cannot call shownValue through a locator and
    // has to carry its own copy. It had the identical bug, and that is why
    // Affirm's ten empty dropdowns came back in `landed` even once the fill
    // itself had started failing them correctly. Two readbacks, one rule:
    // tests/apply/combo-commit.test.mjs pins them to the same answers.
    const comboValue = (el) => {
      const tag = el.tagName.toLowerCase()
      const unpainted = (x) => {
        if (x.type === "hidden") return true
        const r = x.getBoundingClientRect()
        if (r.width < 5 || r.height < 5) return true
        const st = getComputedStyle(x)
        return (
          st.visibility === "hidden" ||
          st.display === "none" ||
          st.opacity === "0" ||
          st.pointerEvents === "none"
        )
      }
      let sawStore = false
      for (let p = el, i = 0; p && i < 5; p = p.parentElement) {
        if (
          p.tagName === "FORM" ||
          p.tagName === "BODY" ||
          p.tagName === "HTML"
        ) {
          break
        }
        if (
          p !== el &&
          p.querySelectorAll(
            "[role='combobox'], [aria-autocomplete='list'], [class*='select__control']",
          ).length > 1
        ) {
          break
        }
        const sv = p.querySelector(
          "[class*='single-value'], [class*='singleValue']",
        )
        if (sv) {
          sawStore = true
          if (n(sv.innerText)) return String(sv.innerText).trim()
        }
        // Token list = the multi picker's committed store; mirrored from
        // shownValue()'s multi branch, same reasoning, same preference for
        // the __label child over the token container.
        const mv = [
          ...p.querySelectorAll(
            "[class*='multi-value'], [class*='multiValue']",
          ),
        ]
        if (mv.length) {
          sawStore = true
          const labels = mv.filter((x) =>
            /label/i.test(String(x.className || "")),
          )
          const use = labels.length
            ? labels
            : mv.filter((x) => !mv.some((o) => o !== x && o.contains(x)))
          const joined = use
            .map((x) =>
              String(x.innerText || "")
                .replace(/\s+/g, " ")
                .trim(),
            )
            .filter(Boolean)
            .join(", ")
          if (joined) return joined
        }
        for (const x of p.querySelectorAll("input, select")) {
          if (x === el) continue
          // Mirrors shownValue(): a tick, a file or a button is never a
          // combo's store (Ashby's hidden backing checkboxes read "on").
          if (
            x.tagName === "INPUT" &&
            /^(checkbox|radio|file|submit|button|reset|image)$/i.test(
              String(x.type || ""),
            )
          )
            continue
          if (!unpainted(x)) continue
          sawStore = true
          if (n(x.value)) return String(x.value).trim()
        }
        i++
      }
      if (sawStore) return ""
      return tag === "input"
        ? el.value || ""
        : String(el.innerText || "").trim()
    }
    // A WIDGET'S ANSWER IS THE STATE IT DECLARES, never its label. Read this
    // before the tag dispatch below, because the control is typically a
    // <button> and would otherwise fall through to innerText and read back the
    // option's own text ("Yes") — which is on the page whether or not the
    // board ever recorded the answer, so the check would be satisfied by the
    // element merely existing.
    const readState = (el) => {
      if (!el) return ""
      const p = el.getAttribute("aria-pressed")
      const c = el.getAttribute("aria-checked")
      if (p === null && c === null) {
        // No declared state at act time is refused by admission, so reaching
        // here means the attribute went away after the click. Absent is not
        // "off" — it is unreadable, and unreadable must not pass.
        return ""
      }
      return (p ?? c) === "true" ? "true" : ""
    }
    const read = (el) => {
      const tag = el.tagName.toLowerCase()
      if (tag === "input" && (el.type === "checkbox" || el.type === "radio")) {
        return el.checked ? "true" : ""
      }
      const isCombo =
        el.getAttribute("role") === "combobox" ||
        el.getAttribute("aria-autocomplete") === "list" ||
        el.getAttribute("aria-haspopup") === "listbox" ||
        /select__control|Select__control/.test(String(el.className || ""))
      if (isCombo) return comboValue(el)
      if (tag === "select" && el.multiple) {
        // Mirrors shownValue(): el.value is only the first selected option's
        // value attribute; the answer is every selected option's text.
        return [...el.selectedOptions]
          .map((o) =>
            String(o.text || "")
              .replace(/\s+/g, " ")
              .trim(),
          )
          .filter(Boolean)
          .join(", ")
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
      const got = p.how === "widget" ? readState(el) : read(el)
      // EXCLUSIVITY, checked here and not only at act time. A group showing
      // two selected answers is not a filled field, and the act-time poll
      // could have exited before a late second selection rendered. Any
      // sibling reading selected turns this into a mismatch below.
      if (p.how === "widget" && Array.isArray(p.others)) {
        for (const os of p.others) {
          let oe = null
          try {
            oe = document.querySelector(os)
          } catch {
            /* an unusable selector is not evidence of a second answer */
          }
          if (oe && readState(oe) === "true") {
            res.mismatch.push({
              k: p.k,
              want: String(p.want).slice(0, 40),
              got: "two options selected",
            })
            planned.add(oe)
            continue
          }
          if (oe) planned.add(oe)
        }
      }
      if (p.want != null && p.how !== "upload") {
        // A multi item lands only when EVERY planned value appears in the
        // committed readback (tokens / selected options, joined) — the page
        // orders tokens however it likes, so per-value containment is the
        // check, not equality on the joined string. A single item is
        // unchanged. A check item is its tick: "true" or "" — see the probes.
        // An adapter alias (Greenhouse's Country* reads "+1" once chosen)
        // accepts the readback the board actually shows for the value.
        let aliasOk = false
        if (p.accept && p.accept.source) {
          try {
            aliasOk =
              !!n(got) &&
              new RegExp(p.accept.source, p.accept.flags || "").test(got)
          } catch {
            aliasOk = false
          }
        }
        // Separators folded to spaces, EQUALITY only — mirrors accepts()'s
        // last resort ("University of Nevada - Las Vegas" vs the board's
        // "University of Nevada, Las Vegas").
        const fold = (s) =>
          n(s)
            .replace(/[,;:.\-–—/()]+/g, " ")
            .replace(/\s+/g, " ")
            .trim()
        // The same calendar day is the same value — mirrors accepts()'s
        // date-equivalence (a react date widget re-renders a typed
        // "2026-08-18" as "08/18/2026"; measured on Ashby 2026-08-21).
        // Recognised shapes only, all three parts equal, never a fuzzy parse.
        const dayOf = (s) => {
          let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(n(s))
          if (m) return m[1] + "-" + m[2] + "-" + m[3]
          m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(n(s))
          if (m)
            return (
              m[3] + "-" + ("0" + m[1]).slice(-2) + "-" + ("0" + m[2]).slice(-2)
            )
          return null
        }
        const sameDay =
          dayOf(got) != null &&
          (dayOf(got) === dayOf(p.want) ||
            // Mirrors accepts(): a bare-year want equals Jan 1 of that year
            // and nothing else — actOn()'s deterministic expansion for a
            // date widget that refuses a bare year (Quora/Ashby 2026-08-23).
            (/^\d{4}$/.test(n(p.want)) && dayOf(got) === `${n(p.want)}-01-01`))
        const ok =
          // `widget` verifies exactly like `check`: strict equality on the
          // declared state. No alias, no containment, no date equivalence —
          // those exist for values a board may re-render, and "true" is not
          // a value a board reformats.
          p.how === "check" || p.how === "widget"
            ? n(got) === n(p.want)
            : Array.isArray(p.wants) && p.wants.length
              ? !!n(got) && p.wants.every((w) => n(got).includes(n(w)))
              : aliasOk ||
                sameDay ||
                !(
                  !n(got) ||
                  (n(got) !== n(p.want) &&
                    !n(got).includes(n(p.want)) &&
                    fold(got) !== fold(p.want))
                )
        if (!ok) {
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
    // A PLANNED CHOICE COVERS ITS WHOLE GROUP. MEASURED on Torc's Greenhouse
    // embed form, 2026-08-18: a required checkbox question renders as
    //   <fieldset class="checkbox" aria-required="true"><legend>question</legend>
    //     <input type="checkbox" required name="question_37618007002[]" …> Cuba
    //     <input type="checkbox" required name="question_37618007002[]" …> Iran
    //     … None/Not applicable
    // The plan ticked "None/Not applicable"; the other five boxes are required,
    // unchecked and not in the plan, so this sweep reported all five as
    // "revealed" and the submit was refused for a question that was answered.
    // A choice group is answered by ticking ONE of its members. So a required
    // checkbox/radio is not "revealed" when it shares a NAME with a planned box
    // (Greenhouse, Lever: one name per question) or sits in the same
    // <fieldset> / [role=group] / [role=radiogroup] as one — provided that
    // container holds nothing but checkboxes and radios (Ashby: one name per
    // box, one fieldset per question), so a section-wide wrapper holding other
    // controls cannot make an unrelated required box disappear.
    const groupOf = (el) =>
      el.closest
        ? el.closest("fieldset,[role='group'],[role='radiogroup']")
        : null
    const isChoiceInput = (el) => {
      if (!el || el.tagName !== "INPUT") return false
      const t = String(el.type || "").toLowerCase()
      return t === "checkbox" || t === "radio"
    }
    const pureChoiceGroup = (g) => {
      let cs = []
      try {
        cs = [...g.querySelectorAll("input,select,textarea")]
      } catch {
        return false
      }
      return cs.every(
        (c) =>
          isChoiceInput(c) ||
          (c.tagName === "INPUT" &&
            String(c.type || "").toLowerCase() === "hidden"),
      )
    }
    const plannedNames = new Set()
    const plannedGroups = new Set()
    for (const el of planned) {
      if (!isChoiceInput(el)) continue
      if (el.name) plannedNames.add(el.name)
      const g = groupOf(el)
      if (g && pureChoiceGroup(g)) plannedGroups.add(g)
    }
    const coveredByPlannedGroup = (el) => {
      if (!isChoiceInput(el)) return false
      if (el.name && plannedNames.has(el.name)) return true
      const g = groupOf(el)
      return !!(g && plannedGroups.has(g))
    }
    let all = []
    try {
      all = [...document.querySelectorAll(CONTROLS)]
    } catch {}
    for (const el of all.slice(0, 400)) {
      if (res.revealed.length >= 20) break
      if (planned.has(el)) continue
      if (coveredByPlannedGroup(el)) continue
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
      // A STORE IS NOT A FIELD. react-select renders one `requiredInput` per
      // required picker — a real, laid-out text input at opacity 0 with
      // pointer-events none, which is what lets the browser raise "please
      // fill in this field" on a custom widget, and which comboValue() above
      // reads as the committed value. MEASURED on Chime's Greenhouse embed
      // form 2026-08-18: the one deferred picker's store came back here as
      // {"label":"","type":"text","sel":null} beside the picker's own row. A
      // human cannot type into it; the picker it belongs to is what is
      // reported (by the plan's defer, or by this sweep through the picker
      // itself). Same rule as unpainted() above.
      try {
        const st = getComputedStyle(el)
        if (
          st.opacity === "0" ||
          st.pointerEvents === "none" ||
          st.visibility === "hidden"
        )
          continue
      } catch {}
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

  // The guard comes off LAST, after everything this engine does to the page,
  // and what it stopped is said out loud. `submitsBlocked` is a count the
  // caller can gate on; the signal is the sentence a reader sees.
  out.submitsBlocked = await disarmSubmitGuard()
  if (out.submitsBlocked > 0) {
    out.signals = [
      ...(out.signals || []),
      "the fill triggered " +
        out.submitsBlocked +
        " form submission attempt(s) — all blocked by the engine's submit guard; " +
        "a keystroke reached the form as a submit, which is a defect in the fill, not the page",
    ]
  }

  out.ms = Date.now() - started
  return out
}
