// THE WIDGET VERB — the one verb that clicks a control the DOM does not
// classify as a form field, and the tests that bound it.
//
// WHY IT EXISTS. Ashby renders its REQUIRED work-authorisation questions as
// pairs of <button> elements. `kindOf()` answers "forbidden:button", so no verb
// could touch them: the run left them blank, clicked submit, and Ashby's own
// client validation refused the form. The staged capture of a real live click
// (jobs/.auto/post-submit/board-22ccfdc08c99.html) is that page — still the
// form, both required groups unanswered — and the run recorded it as a possible
// application. Nine other recorded submissions have no capture at all.
//
// THE SHAPE OF THE SAFETY ARGUMENT, and every test below is one clause of it:
// the verb clicks only an option the SCANNER grouped, only when that control
// DECLARES ITS OWN STATE, only when the page's text still agrees with the plan,
// and it confirms by reading that state back — including that no sibling reads
// selected — or the item FAILS. A click this engine cannot verify is a claim it
// does not make.
//
// The failing-readback case is the most important test in this file. If it ever
// goes green by way of an `ok`, the verb has become a machine for reporting
// answers that are not on the page.
import test from "node:test"
import assert from "node:assert/strict"

import fillPage from "../../scripts/apply/fill-engine.mjs"
import { launchBrowser } from "../../scripts/apply/browser.mjs"

const NO_BROWSER = await (async () => {
  try {
    const s = await launchBrowser({ headless: true })
    await s.close()
    return null
  } catch (e) {
    return "no usable Chromium: " + String(e.message).slice(0, 90)
  }
})()

/** Ashby's real shape: a question label plus two stateful <button> options. */
const pair = ({
  live = true,
  both = false,
  preset = null,
} = {}) => `<!doctype html>
<html><body>
  <div class="_fieldEntry_1e3gg_28">
    <label class="_heading_f7cvd_52 _required_f7cvd_91">Are you legally authorized to work in the United States?</label>
    <div class="_container_1svni_28">
      <button type="button" data-aj="f1" aria-pressed="${preset === "yes" ? "true" : "false"}">Yes</button>
      <button type="button" data-aj="f2" aria-pressed="${preset === "no" ? "true" : "false"}">No</button>
    </div>
  </div>
  <script>
    window.__clicks = 0
    for (const b of document.querySelectorAll('button[data-aj]')) {
      b.addEventListener('click', () => {
        window.__clicks++
        ${
          live
            ? `for (const o of document.querySelectorAll('button[data-aj]'))
                 o.setAttribute('aria-pressed', ${both ? "'true'" : "String(o === b)"})`
            : `/* inert board: records nothing */`
        }
      })
    }
  </script>
</body></html>`

const ITEM = {
  k: "g1",
  how: "widget",
  widget: "buttons",
  sel: '[data-aj="f2"]',
  pick: "f2",
  value: "No",
  label: "Are you legally authorized to work in the United States?",
  options: [
    { k: "f1", l: "Yes" },
    { k: "f2", l: "No" },
  ],
  assent: true,
  req: true,
}

async function run(html, item = ITEM) {
  const s = await launchBrowser({ headless: true })
  try {
    await s.page.setContent(html)
    const report = await fillPage(s.page, { items: [item], defer: [] })
    const clicks = await s.page.evaluate(() => window.__clicks)
    return { report, clicks }
  } finally {
    await s.close()
  }
}

test("a stateful button pair is clicked and confirmed by readback", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const { report, clicks } = await run(pair())
  assert.equal(report.failed, 0, JSON.stringify(report.failures))
  assert.equal(report.ok, 1)
  assert.equal(clicks, 1)
  assert.deepEqual(report.verify.mismatch, [], "the state read back as chosen")
  assert.ok(report.verify.landed.includes("g1"))
})

test("AN UNCONFIRMED CLICK FAILS — the board that records nothing", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // THE TEST THAT MATTERS MOST. The click lands, the board ignores it, and the
  // control still reads unselected. Reporting `ok` here would be reporting an
  // answer that is not on the page — precisely the failure that put a form
  // through a submit with its required questions blank.
  const { report, clicks } = await run(pair({ live: false }))
  assert.equal(
    clicks,
    1,
    "it did click — this is a readback failure, not a refusal",
  )
  assert.equal(report.ok, 0)
  assert.equal(report.failed, 1)
  assert.match(report.failures[0].why, /widget-readback/)
})

test("NO DECLARED STATE IS REFUSED BEFORE THE CLICK", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // Ashby shipped exactly this before 2026: the chosen option marked only by a
  // build-hashed CSS class, with no honest way to read which answer is set.
  // No readback surface, no actuation — and crucially, no click either.
  const html = pair().replace(/ aria-pressed="[^"]*"/g, "")
  const { report, clicks } = await run(html)
  assert.equal(clicks, 0, "REFUSED, not clicked-then-failed")
  assert.equal(report.failed, 1)
  assert.match(report.failures[0].why, /widget-admission.*no readable state/s)
})

test("a page that no longer shows the planned option is refused, not clicked", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // The board re-rendered between scan and fill, so the stamp now sits on a
  // different answer. Clicking a stamp blind is how you answer "No" to a
  // question you meant to answer "Yes".
  const html = pair().replace(">No</button>", ">Maybe</button>")
  const { report, clicks } = await run(html)
  assert.equal(clicks, 0)
  assert.equal(report.failed, 1)
  assert.match(report.failures[0].why, /widget-admission.*page shows/s)
})

test("an action control is refused even if it declares state", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const html = pair().replace(">No</button>", ">Submit Application</button>")
  const item = { ...ITEM, value: "Submit Application" }
  const { report, clicks } = await run(html, item)
  assert.equal(clicks, 0, "never click a submit, whatever it claims to be")
  assert.equal(report.failed, 1)
  assert.match(report.failures[0].why, /widget-admission.*action control/s)
})

test("TWO options reading selected is a mismatch, not a fill", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // A group showing both answers has no answer. Exclusivity is checked at act
  // time and again in the verify pass, because a late second selection could
  // render after the act-time poll exits.
  const { report } = await run(pair({ both: true }))
  const ambiguous =
    report.failed > 0 || report.verify.mismatch.some((m) => m.k === "g1")
  assert.ok(
    ambiguous,
    "two selected options must never be reported as a clean fill",
  )
})

test("an already-correct group is left alone — the verb is idempotent", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // actOn is replayed on a detached element, and a TOGGLE re-clicked is a
  // toggle turned off. fill/select/check are idempotent for free; a click is
  // not, so the state is read before it is changed.
  const { report, clicks } = await run(pair({ preset: "no" }))
  assert.equal(clicks, 0, "nothing to do, so nothing was clicked")
  assert.equal(report.failed, 0, JSON.stringify(report.failures))
  assert.equal(report.ok, 1)
})
