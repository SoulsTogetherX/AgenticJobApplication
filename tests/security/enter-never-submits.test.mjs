// A KEYSTROKE IS NOT A CLICK, AND IT MUST NOT BE A SUBMIT EITHER.
//
// MEASURED on Torc's Greenhouse embed form, 2026-08-18. The fill engine's
// type-enter strategy typed a location into react-select's input, waited its
// 500ms, and pressed Enter before the server-queried suggestions had arrived.
// react-select handles Enter only while a row is focused; otherwise the keydown
// falls through to the browser, and Enter in a text input inside a <form> is
// the browser's IMPLICIT SUBMISSION. The board's submit handler ran and painted
// "First Name is required." on every empty field. Nothing was sent that time
// only because required fields were still empty. On a form whose last required
// control is a typeahead, the fill engine would have submitted the application
// — past the token, the ledger and the classifier in submit.mjs. The
// click-surface invariant (tests/auto/click-surface.test.mjs) counts `.click(`
// calls; it never counted a key.
//
// Two controls now stand between a keystroke and a submit, and this file pins
// both against real Chromium and the real engine:
//   1. type-enter presses Enter ONLY when the page reports a focused row
//      (aria-activedescendant naming an element, or a focused row in the menu
//      the control names). With none, no Enter is sent at all.
//   2. for the whole fill a window-capture `submit` listener cancels every
//      submit event and stops it before the page's own handler sees it — a
//      widget that lies about its focused row, or any other key that reaches
//      the form, still cannot send anything. What it stopped is counted and
//      reported (`submitsBlocked`, plus a signal), never swallowed.
//   3. the guard is gone when fillPage returns: a submit that happens
//      AFTERWARDS (the runner's own click) is not affected.
import test from "node:test"
import assert from "node:assert/strict"

import fillPage from "../../src/apply/fill-engine.mjs"
import { launchBrowser } from "../../src/apply/browser.mjs"

const NO_BROWSER = await (async () => {
  try {
    const s = await launchBrowser({ headless: true })
    await s.close()
    return null
  } catch (e) {
    return "no usable Chromium: " + String(e.message).slice(0, 90)
  }
})()

// A native form: Enter in the text input submits it (GET to the same page
// with ?sent=1), and the page records every keydown and every submit its own
// handler sees.
const page = ({ focusedRow }) => `<!doctype html><html><body>
  <form id="f" action="" method="get">
    <label for="a">Country</label>
    <input id="a" name="country" role="combobox" aria-expanded="true"
      ${focusedRow ? 'aria-activedescendant="opt1"' : ""} autocomplete="off" />
    <div id="menu" role="listbox">
      <div id="opt1" role="option">United States</div>
    </div>
    <input type="hidden" name="sent" value="1" />
    <button type="submit">Send</button>
  </form>
  <script>
    window.__keys = []
    window.__pageSawSubmit = 0
    document.addEventListener("keydown", (e) => window.__keys.push(e.key))
    document.getElementById("f").addEventListener("submit", () => {
      window.__pageSawSubmit++
    })
  </script>
</body></html>`

const plan = {
  v: 1,
  slug: "x",
  ats: "generic",
  items: [{ k: "f1", sel: "#a", how: "combo", value: "United States" }],
  defer: [],
  comboStrategies: ["type-enter", "type-click", "click-option"],
}

const run = async (html) => {
  const s = await launchBrowser({ headless: true })
  try {
    await s.page.setContent(html)
    const before = s.page.url()
    const out = await fillPage(s.page, plan)
    const state = await s.page.evaluate(() => ({
      keys: window.__keys,
      pageSawSubmit: window.__pageSawSubmit,
      url: location.href,
      guardsLeft: (window.__ajSubmitGuards || []).length,
    }))
    return { out, state, before, page: s.page, close: () => s.close() }
  } catch (e) {
    await s.close()
    throw e
  }
}

test("with no focused row the engine never presses Enter, so nothing can submit", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const r = await run(page({ focusedRow: false }))
  try {
    assert.ok(
      !r.state.keys.includes("Enter"),
      `Enter was sent: ${r.state.keys}`,
    )
    assert.equal(r.state.pageSawSubmit, 0)
    assert.equal(r.out.submitsBlocked, 0)
    assert.ok(!/[?&]sent=1/.test(r.state.url), "the form did not submit")
  } finally {
    await r.close()
  }
})

test("a widget that reports a focused row but forwards Enter cannot submit: the guard stops it and the report says so", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const r = await run(page({ focusedRow: true }))
  try {
    assert.ok(r.state.keys.includes("Enter"), "Enter WAS pressed here")
    assert.equal(
      r.state.pageSawSubmit,
      0,
      "the page's own submit handler never ran — stopped at window capture",
    )
    assert.ok(!/[?&]sent=1/.test(r.state.url), "no navigation happened")
    assert.ok(
      r.out.submitsBlocked >= 1,
      `the block is counted: ${JSON.stringify(r.out.submitsBlocked)}`,
    )
    assert.ok(
      (r.out.signals || []).some((s) => /submission attempt/.test(s)),
      `and said in the signals: ${JSON.stringify(r.out.signals)}`,
    )
    assert.equal(
      r.state.guardsLeft,
      0,
      "the guard is gone when fillPage returns",
    )
    // And a submit that happens AFTER the fill is not affected: the runner's
    // own click still reaches the page.
    await r.page.click("button[type=submit]")
    await r.page.waitForTimeout(300)
    const after = await r.page.evaluate(() => location.href)
    assert.ok(
      /[?&]sent=1/.test(after),
      `a real submit after the fill goes through: ${after}`,
    )
  } finally {
    await r.close()
  }
})
