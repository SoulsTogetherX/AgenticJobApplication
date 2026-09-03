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
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { runScannerOnDom } from "../fixtures/boards/dom.mjs"
import scanPage, {
  dateWidgetMarks,
  DATE_WIDGET_MARKERS,
} from "../../src/apply/scan-engine.mjs"
import fillPage from "../../src/apply/fill-engine.mjs"
import { launchBrowser } from "../../src/apply/browser.mjs"
import {
  buildPlan,
  resolveFields,
  submitReadiness,
} from "../../src/apply/fill-plan.mjs"
import ashby from "../../src/apply/ats/ashby.mjs"

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
)

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

// ---------------------------------------------------------------------------
// END TO END — the production failure, reproduced and then cleared
//
// Everything above tests one link. This runs the whole chain the unattended
// runner runs — the REAL scanner over the REAL markup, resolveFields against a
// fact base holding the user's prose availability answer, buildPlan, fillPage
// in a browser, and finally submitReadiness, which is the function that
// actually emitted the deferral in run 2026-09-02T19-28-11-322Z-cec481.
//
// The page below models the widget from its own measured props rather than
// from a guess about it: focus opens the panel (preventOpenOnFocus false),
// blur closes it, blur parses with MM/dd/yyyy first (dateFormat), falls back
// to `new Date(v)` (strictParsing false — this is what shifted ISO by a day on
// 2026-08-21), and CLEARS what neither can read. That last clause is the whole
// bug: it is why prose came back "".
// ---------------------------------------------------------------------------

const PICKER_SCRIPT = [
  "const d = document.querySelector('.react-datepicker__input-container input')",
  "const cal = document.getElementById('cal')",
  "d.addEventListener('focus', () => { cal.style.display = 'block' })",
  "d.addEventListener('blur', () => {",
  "  cal.style.display = 'none'",
  "  const v = String(d.value || '').trim()",
  "  if (!v) return",
  // dateFormat "MM/dd/yyyy" — the widget's own format, parsed as LOCAL.
  "  const m = /^(\\d{2})\\/(\\d{2})\\/(\\d{4})$/.exec(v)",
  "  if (m) { d.value = m[1] + '/' + m[2] + '/' + m[3]; return }",
  // strictParsing false -> Date-constructor fallback. An ISO string is UTC
  // midnight there, which renders a day early west of Greenwich.
  "  const t = new Date(v)",
  "  if (!isNaN(t.getTime())) {",
  "    d.value = String(t.getMonth() + 1).padStart(2, '0') + '/' +",
  "              String(t.getDate()).padStart(2, '0') + '/' + t.getFullYear()",
  "    return",
  "  }",
  // Unparseable: the widget keeps nothing. THIS is the production failure.
  "  d.value = ''",
  "})",
].join("\n")

const ASHBY_FORM = `<!doctype html>
<html><body style="margin:0">
<form>
  <div class="_fieldEntry_1e3gg_28 ashby-application-form-field-entry">
    <label class="_heading_f7cvd_52 _required_f7cvd_91 ashby-application-form-question-title"
           for="_systemfield_name">Legal Name</label>
    <input id="_systemfield_name" name="_systemfield_name" type="text"
           class="_input_gc9ve_28 ashby-application-form-input" required>
  </div>
  <div class="_fieldEntry_1e3gg_28 ashby-application-form-field-entry">
    <label class="_heading_f7cvd_52 _required_f7cvd_91 ashby-application-form-question-title"
           for="_systemfield_email">Email</label>
    <input id="_systemfield_email" name="_systemfield_email" type="email"
           class="_input_gc9ve_28 ashby-application-form-input" required>
  </div>
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
  </div>
  <button type="submit">Submit Application</button>
</form>
<div id="cal" class="ashby-application-form-input-date-popup"
     style="display:none;position:absolute;top:0;left:0;width:100%;height:200px;background:#eee;z-index:99"></div>
<script>${PICKER_SCRIPT}</script>
</body></html>`

// The user's own banked availability answer, in the wording that was live when
// the four jobs deferred on 2026-09-02.
const PROSE_BANK = [
  "answers:",
  "  - id: a-128",
  '    question: "When can you start a new role?"',
  '    answer: "Available immediately."',
  "",
].join("\n")

// The LOCAL calendar day, matching answer-bank.mjs's own reading of "now" —
// see the TZ block in tests/apply/answer-bank.test.mjs for why a wall-clock
// "today" is local while a profile date stays UTC. Computing this in UTC here
// made the assertion below fail on any evening west of Greenwich, which is
// how this comment came to exist.
const usDateLocal = (d) =>
  String(d.getMonth() + 1).padStart(2, "0") +
  "/" +
  String(d.getDate()).padStart(2, "0") +
  "/" +
  d.getFullYear()

const endToEnd = async ({ stripMarker }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aj-datewidget-"))
  const answersFile = path.join(dir, "answers.yaml")
  fs.writeFileSync(answersFile, PROSE_BANK)
  const s = await launchBrowser({ headless: true })
  try {
    await s.page.setContent(ASHBY_FORM)
    const { scan } = await scanPage(s.page)
    // The plan's own urlGuard compares against the live page, and setContent
    // leaves that at about:blank — so the plan is built for the page it will
    // actually be filled on. Nothing here turns on the URL: the adapter is
    // passed explicitly rather than detected from it.
    const url = s.page.url()
    scan.url = url
    const marked = (scan.fields || []).filter((f) => f.dateWidget)
    // The pre-fix world, produced by removing exactly the one thing the fix
    // adds — so the two runs differ in nothing else.
    if (stripMarker) for (const f of scan.fields || []) delete f.dateWidget
    const resolved = resolveFields(scan.fields ?? [], {
      profile: path.join(FIXTURES, "profile.yaml"),
      answers: answersFile,
    })
    const plan = buildPlan({
      scan,
      resolved,
      adapter: ashby,
      url,
      files: {},
    })
    const report = await fillPage(s.page, plan)
    const shown = await s.page.evaluate(
      () =>
        document.querySelector(".react-datepicker__input-container input")
          .value,
    )
    return {
      marked,
      plan,
      report,
      shown,
      readiness: submitReadiness(plan, report),
    }
  } finally {
    await s.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const startItem = (plan) =>
  plan.items.find((i) => /start a new role/i.test(i.label ?? ""))

test("END TO END, PRE-FIX: the prose is typed, the widget eats it, the gate refuses", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const { plan, shown, readiness } = await endToEnd({ stripMarker: true })
  assert.equal(
    startItem(plan).value,
    "Available immediately.",
    "the banked prose went in",
  )
  assert.equal(shown, "", "and the widget kept nothing")
  assert.equal(readiness.ready, false)
  // The production line, in its distinctive parts.
  assert.match(readiness.reason, /did not hold the value that was typed/)
  assert.match(readiness.reason, /When can you start a new role\?/)
  assert.match(
    readiness.reason,
    /wanted "Available immediately\.", the page shows ""/,
  )
})

test("END TO END, FIXED: the scan marks it, a date goes in, the gate passes", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const { marked, plan, report, shown, readiness } = await endToEnd({
    stripMarker: false,
  })
  assert.equal(marked.length, 1, "the real scanner + scanPage marked one field")
  assert.equal(marked[0].dateWidget, "react-datepicker")

  const item = startItem(plan)
  assert.equal(item.dateWidget, "react-datepicker")
  // Today, in the widget's own format, computed — never a banked string.
  assert.equal(item.value, usDateLocal(new Date()))
  // The widget round-tripped it UNSHIFTED — the 2026-08-21 off-by-one cannot
  // happen because the Date-constructor fallback is never reached.
  assert.equal(shown, usDateLocal(new Date()))
  assert.equal(report.failed, 0, JSON.stringify(report.failures))
  assert.deepEqual(report.verify.mismatch, [])
  assert.equal(readiness.ready, true, readiness.reason ?? "")
})

test("END TO END: ISO into this widget is a day early — why the FORMAT is the fix", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // Not a test of our code: a test of the CLAIM our code rests on, run against
  // the widget's own measured parsing rules. Typing ISO is what the pipeline
  // did on 2026-08-21, and "08/17/2026" is what came back. If this ever stops
  // shifting, the reasoning in answer-bank.mjs's startDateFor() has changed
  // underneath us and should be re-read rather than trusted.
  const s = await launchBrowser({ headless: true })
  try {
    await s.page.setContent(ASHBY_FORM)
    const shown = await s.page.evaluate(() => {
      const d = document.querySelector(
        ".react-datepicker__input-container input",
      )
      d.focus()
      d.value = "2026-08-18"
      d.blur()
      return d.value
    })
    assert.notEqual(shown, "08/18/2026", "ISO does NOT round-trip here")
    assert.match(shown, /^08\/1[78]\/2026$/, `got ${shown}`)
  } finally {
    await s.close()
  }
})
