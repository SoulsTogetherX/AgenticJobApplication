// A DATE PICKER WEARING AN <input type="text"> — the scan-side half.
//
// THE INCIDENT. Seven OpenAI applications on Ashby deferred between
// 2026-08-25 and 2026-09-02, four of them in run
// 2026-09-02T19-28-11-322Z-cec481 alone, every one with the same line:
//
//   unknown-field: submit_readiness: 1 field(s) did not hold the value that
//   was typed after the fill: When can you start a new role? (f8)
//   (wanted "Available immediately.", the page shows "")
//
// It looks exactly like the Greenhouse react-select readback traps — a value
// that goes in and reads back empty — and it is NOT one. The readback was
// telling the truth: the field really was empty, and the application really
// could not have been submitted (it is `required`). What went in was prose,
// and the control is a calendar that clears whatever it cannot parse as a
// date. Nothing on the page said so, because scan-page.js reports `t` as the
// element's own `type` attribute and the element says "text".
//
// THE MARKUP BELOW IS MEASURED, not invented — read off
// jobs.ashbyhq.com/openai/ec317080-.../application on 2026-09-02, including
// the hashed class names, which are here precisely so that a test cannot pass
// by matching them. Only the unhashed, third-party-owned names may be read:
// react-datepicker's own wrapper classes and Ashby's own
// `ashby-application-form-*` family.
//
// The answer-bank half — what is then FILLED into a control marked this way,
// and what must still not be — lives in tests/apply/answer-bank.test.mjs under
// "THE DATE PICKER WEARING AN <input type=text>".
import test from "node:test"
import assert from "node:assert/strict"

import { runScannerOnDom } from "../fixtures/boards/dom.mjs"
import {
  dateWidgetMarks,
  DATE_WIDGET_MARKERS,
} from "../../src/apply/scan-engine.mjs"
import fillPage from "../../src/apply/fill-engine.mjs"
import { launchBrowser } from "../../src/apply/browser.mjs"

const page = (body) => `<html><body><form>${body}</form></body></html>`

// The measured field, verbatim.
const OPENAI_START_DATE = `
  <div class="_fieldEntry_1e3gg_28 ashby-application-form-field-entry"
       data-field-path="3f4e05d4-dd62-48ef-96ca-d9f293ae18d4">
    <label class="_heading_f7cvd_52 _required_f7cvd_91 _label_1e3gg_42 ashby-application-form-question-title"
           for="3f4e05d4-dd62-48ef-96ca-d9f293ae18d4">When can you start a new role?</label>
    <div class="react-datepicker-wrapper">
      <div class="react-datepicker__input-container">
        <input type="text" placeholder="Pick date..."
               class="_input_gc9ve_28  _greedy_gc9ve_61 ashby-application-form-input-date"
               required value="">
      </div>
    </div>
  </div>`

// Its neighbour on the same form: a genuine free-text custom question, which
// carries the uuid id/name every plain Ashby field carries and which the
// picker deliberately does not.
const OPENAI_PREFERRED_NAME = `
  <div class="_fieldEntry_1e3gg_28 ashby-application-form-field-entry">
    <label class="_heading_f7cvd_52 _label_1e3gg_42 ashby-application-form-question-title"
           for="09a328e0-8d57-4f88-86ab-688de1657b17">Preferred Name (if applicable)</label>
    <input id="09a328e0-8d57-4f88-86ab-688de1657b17"
           name="09a328e0-8d57-4f88-86ab-688de1657b17"
           type="text" class="_input_gc9ve_28 ashby-application-form-input">
  </div>`

const marksFor = async (html) => {
  const { scan, doc } = await runScannerOnDom(page(html))
  return { scan, marks: dateWidgetMarks(doc) }
}

const fieldFor = (scan, label) =>
  (scan.fields || []).find((f) => String(f.l || "").startsWith(label))

// --- the failure mode ------------------------------------------------------

test("THE BUG: the scanner calls the OpenAI start-date picker a text box", async () => {
  // Pinning the thing that is NOT being changed. `t` reports the attribute the
  // page wrote, and it stays that way — the recognition is added beside it, so
  // a consumer that has a reason to care about the raw type still can.
  const { scan } = await marksFor(OPENAI_START_DATE)
  const f = fieldFor(scan, "When can you start")
  assert.ok(f, "the control is scanned at all")
  assert.equal(f.t, "text")
  assert.equal(f.sel, undefined, "and it carries no app-owned selector either")
})

test("THE FIX: the picker is marked, keyed by the stamp the scan handed out", async () => {
  const { scan, marks } = await marksFor(OPENAI_START_DATE)
  const f = fieldFor(scan, "When can you start")
  assert.equal(marks[f.k], "react-datepicker")
  assert.ok(DATE_WIDGET_MARKERS.has(marks[f.k]))
})

// --- the boundaries --------------------------------------------------------

test("BOUNDARY: the free-text field beside it is NOT marked", async () => {
  // The direction that would hurt: marking a prose box turns the user's own
  // availability wording into a bare date on forms that wanted the wording.
  const { scan, marks } = await marksFor(
    OPENAI_PREFERRED_NAME + OPENAI_START_DATE,
  )
  const plain = fieldFor(scan, "Preferred Name")
  const picker = fieldFor(scan, "When can you start")
  assert.equal(marks[plain.k], undefined)
  assert.equal(marks[picker.k], "react-datepicker")
})

test("BOUNDARY: Ashby's own class is read even with no react-datepicker wrapper", async () => {
  // A board that swaps the picker library keeps its own `ashby-application-
  // form-*` hooks; a board that keeps react-datepicker under different app
  // classes keeps the wrapper. Either alone is enough.
  const { scan, marks } = await marksFor(`
    <label class="_heading_f7cvd_52 _required_f7cvd_91" for="d">When can you start a new role?</label>
    <input id="d" type="text" class="_input_gc9ve_28 ashby-application-form-input-date">`)
  assert.equal(
    marks[fieldFor(scan, "When can you start").k],
    "ashby-application-form-input-date",
  )
})

test("BOUNDARY: a HASHED class that merely contains the word date is not a marker", async () => {
  // The build-output names on the real element (`_input_gc9ve_28`) change on
  // every deploy, so nothing may key on them — and a class that only happens
  // to end in "-date" is not Ashby's hook. Substring matching would take both.
  const { scan, marks } = await marksFor(`
    <label for="d">When can you start a new role?</label>
    <input id="d" type="text" class="_inputDate_gc9ve_28 my-application-form-input-dateish">`)
  assert.equal(marks[fieldFor(scan, "When can you start").k], undefined)
})

test("BOUNDARY: a native date input is left alone — it already reports itself", async () => {
  const { scan, marks } = await marksFor(`
    <label for="d">When can you start a new role?</label>
    <div class="react-datepicker-wrapper"><input id="d" type="date"></div>`)
  const f = fieldFor(scan, "When can you start")
  assert.equal(f.t, "date")
  assert.equal(marks[f.k], undefined)
})

test("BOUNDARY: a non-text control inside a picker wrapper is never marked", async () => {
  // react-datepicker renders its calendar inside the same wrapper; nothing in
  // there that is not the visible text box is a place a date is typed.
  const { scan, marks } = await marksFor(`
    <div class="react-datepicker-wrapper">
      <label for="d">When can you start a new role?</label>
      <input id="d" type="text">
      <label for="c">Remind me</label>
      <input id="c" type="checkbox">
    </div>`)
  assert.equal(
    marks[fieldFor(scan, "When can you start").k],
    "react-datepicker",
  )
  assert.equal(marks[fieldFor(scan, "Remind me").k], undefined)
})

test("BOUNDARY: an unstamped input contributes nothing, so no key can be invented", async () => {
  // dateWidgetMarks only ever answers about `[data-aj]` elements, and
  // scanPage() only ever applies a mark onto a key the scan itself produced.
  // Between them there is no path for a page to put a key on the scan.
  const { doc } = await runScannerOnDom(
    page(`<div class="react-datepicker-wrapper"><input type="text"></div>`),
  )
  const el = doc.querySelector("input")
  el.attrs.delete("data-aj")
  assert.deepEqual(dateWidgetMarks(doc), {})
})

// ---------------------------------------------------------------------------
// THE POPPER — what the fill itself opens, and over what
//
// MEASURED off the live widget's React props, 2026-09-02:
//   preventOpenOnFocus: false   -> focus opens the calendar, and fill() focuses
//   withPortal: false, no portal node anywhere in the document
//   popperClassName: "…ashby-application-form-input-date-popup"
// so the calendar renders INLINE and absolutely positioned. The three fields
// immediately below the start-date question on that form, in DOM order, are
// the work-authorisation, sponsorship and in-office Yes/No pairs — the next
// three controls the engine acts on.
//
// The damage is not a wrong click: Playwright requires the target to be the
// element at the click point, so a covered control waits out its timeout and
// reaches fail(), which blocks the submit. It costs an application and reads
// as a mysterious timeout. Both directions are asserted below, because a test
// that only shows the fix passing cannot tell you the risk was ever real.
// ---------------------------------------------------------------------------

const NO_BROWSER = await (async () => {
  try {
    const s = await launchBrowser({ headless: true })
    await s.close()
    return null
  } catch (e) {
    return "no usable Chromium: " + String(e.message).slice(0, 90)
  }
})()

// react-datepicker's observable behaviour, reduced to the two facts that
// matter here: focus opens an absolutely-positioned panel, blur closes it.
const PICKER_OVER_BUTTONS = `<!doctype html>
<html><body style="margin:0">
  <div class="react-datepicker-wrapper">
    <div class="react-datepicker__input-container">
      <input data-aj="f1" type="text" placeholder="Pick date..."
             class="_input_gc9ve_28 ashby-application-form-input-date">
    </div>
  </div>
  <div id="pop" class="ashby-application-form-input-date-popup"
       style="display:none;position:absolute;top:24px;left:0;width:100%;height:240px;background:#fff;z-index:99"></div>
  <div style="margin-top:40px">
    <label>Are you authorized to work in the country where the job is located?</label>
    <button type="button" data-aj="g1a" aria-pressed="false">Yes</button>
    <button type="button" data-aj="g1b" aria-pressed="false">No</button>
  </div>
  <script>
    const inp = document.querySelector('input[data-aj="f1"]')
    const pop = document.getElementById('pop')
    inp.addEventListener('focus', () => { pop.style.display = 'block' })
    inp.addEventListener('blur', () => { pop.style.display = 'none' })
    for (const b of document.querySelectorAll('button[data-aj]')) {
      b.addEventListener('click', () => {
        for (const o of document.querySelectorAll('button[data-aj]'))
          o.setAttribute('aria-pressed', String(o === b))
      })
    }
  </script>
</body></html>`

const DATE_ITEM = (marked) => ({
  k: "f1",
  how: "fill",
  sel: '[data-aj="f1"]',
  value: "09/02/2026",
  label: "When can you start a new role?",
  ...(marked ? { dateWidget: "react-datepicker" } : {}),
})

const YESNO_ITEM = {
  k: "g1",
  how: "widget",
  widget: "buttons",
  sel: '[data-aj="g1a"]',
  pick: "g1a",
  value: "Yes",
  label: "Are you authorized to work in the country where the job is located?",
  options: [
    { k: "g1a", l: "Yes" },
    { k: "g1b", l: "No" },
  ],
  assent: true,
  req: true,
}

const runFill = async (marked) => {
  const s = await launchBrowser({ headless: true })
  try {
    await s.page.setContent(PICKER_OVER_BUTTONS)
    const report = await fillPage(s.page, {
      items: [DATE_ITEM(marked), YESNO_ITEM],
      defer: [],
    })
    return report
  } finally {
    await s.close()
  }
}

// NOT asserted here: whether the panel is open when fillPage returns. It never
// is — the settle step blurs document.activeElement before the verify pass, so
// the panel is shut by then whatever happened during the fill, and a test
// reading it would pass identically with the fix reverted. The signal that
// actually separates the two runs is whether the control UNDERNEATH the panel
// could be clicked while the fill was in progress.

test("THE RISK IS REAL: unmarked, the calendar buries the next control", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const report = await runFill(false)
  assert.equal(report.ok, 1, "the date landed and the question did not")
  assert.equal(report.failed, 1, JSON.stringify(report.failures))
  assert.equal(report.failures[0].k, "g1", "the BURIED control is what failed")
  // The shape the run log would have shown: not "covered field", just a
  // timeout on a control that is right there on the page.
  assert.match(report.failures[0].why, /Timeout \d+ms exceeded/)
  assert.deepEqual(report.verify.landed, ["f1"])
})

test("THE FIX: a marked picker is blurred, so the control below is reachable", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const report = await runFill(true)
  assert.equal(report.failed, 0, JSON.stringify(report.failures))
  assert.equal(report.ok, 2, "both the date and the question landed")
  assert.deepEqual(report.verify.mismatch, [])
  // And the blur COMMITS the date rather than discarding it — the direction
  // this fix must not be wrong in.
  assert.deepEqual(report.verify.landed, ["f1", "g1"])
})
