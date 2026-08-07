// A DROPDOWN REPORTED FILLED THAT IS EMPTY — measured on Affirm's Greenhouse
// form, 2026-08-04, while applying from the backlog.
//
// All ten comboboxes came back `verify.landed`, `comboVia: type-enter`, zero
// failures. Every backing input (#question_*) was still EMPTY, and the page
// itself was rendering "This field is required." next to three of them. The
// application could not have been submitted, and nothing in the run said so.
//
// WHY THE EXISTING GUARD DID NOT CATCH IT. committedValue() blurs before
// reading, which is the Oracle fix: a widget that did not commit REVERTS on
// blur, and a widget that did keeps its value. That works only for widgets that
// revert. Affirm's leaves the typed text sitting in the box, so blurring
// changed nothing and the readback was still satisfied by the act of typing —
// the very thing the Oracle note says a readback must never be.
//
// THE RULE THAT REPLACES IT: a combobox input's own `value` is the SEARCH
// FILTER. Where the widget has a committed store — a rendered single-value node
// or a non-visible backing input in the same field wrapper — that store is the
// answer and the filter text stops counting as evidence at all.
//
// The three widgets below are deliberately indistinguishable from the outside;
// only what they do on commit differs. #a is the defect, #b is the widget the
// naive opposite fix ("did the box keep the text") would break, and #c is the
// plain typeahead that must keep working.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import fillPage from "../../scripts/apply/fill-engine.mjs"
import { launchBrowser } from "../../scripts/apply/browser.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const PAGE = fs.readFileSync(
  path.join(ROOT, "tests", "fixtures", "greenhouse", "combo-commit.html"),
  "utf8",
)

const NO_BROWSER = await (async () => {
  try {
    const s = await launchBrowser({ headless: true })
    await s.close()
    return null
  } catch (e) {
    return "no usable Chromium: " + String(e.message).slice(0, 90)
  }
})()

const plan = (items, over = {}) => ({
  v: 1,
  slug: "x",
  ats: "greenhouse",
  items,
  defer: [],
  ...over,
})

const run = async (items, over) => {
  const s = await launchBrowser({ headless: true })
  try {
    await s.page.setContent(PAGE)
    const out = await fillPage(s.page, plan(items, over))
    const stores = await s.page.evaluate(() => ({
      a: document.getElementById("a-store").value,
      aBox: document.getElementById("a").value,
      b: document.getElementById("b-store").value,
      c: document.getElementById("c").value,
    }))
    return { out, stores }
  } finally {
    await s.close()
  }
}

const combo = (k, sel, value) => ({ k, sel, how: "combo", value })

test("a filter-only combo that never commits is reported FAILED", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const { out, stores } = await run([combo("f1", "#a", "No")])
  assert.equal(
    stores.a,
    "",
    "precondition: this widget genuinely never commits",
  )
  assert.ok(
    stores.aBox.length > 0,
    "precondition: and it KEEPS the typed text, which is what fooled the check",
  )
  assert.equal(out.failed, 1, "an uncommitted dropdown must fail")
  assert.equal(out.ok, 0)
  assert.deepEqual(
    (out.verify.landed || []).filter((k) => k === "f1"),
    [],
    "and must never be reported as landed",
  )
  // The verify pass carries its OWN copy of the readback, because it reads the
  // DOM in a single page.evaluate and cannot go through a locator. Both copies
  // are pinned here: a fix applied to one and not the other is exactly how the
  // empty dropdowns kept coming back in `landed` after the fill had already
  // started failing them.
  const mm = (out.verify.mismatch || []).find((m) => m.k === "f1")
  assert.ok(mm, "the verify pass must report the mismatch, not just the fill")
  assert.equal(
    mm.got,
    "",
    "and must report the store as empty, not the filter text",
  )
})

test("a react-select combo that clears its box IS reported filled", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // The false-failure this guards: on a successful commit the search input is
  // empty, so any check that reads the input alone calls this a failure and
  // defers a fill that worked.
  const { out, stores } = await run([combo("f1", "#b", "No")])
  assert.equal(stores.b, "No", "precondition: it really did commit")
  assert.equal(
    out.failed,
    0,
    "a committed dropdown must not fail: " + JSON.stringify(out.failures),
  )
  assert.equal(out.ok, 1)
})

test("a plain typeahead with no store still reads from its own box", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // Ashby's Location shape. There is no store to find, so the input IS the
  // value and behaviour must be unchanged.
  const { out, stores } = await run([
    combo("f1", "#c", "North Las Vegas, Nevada, United States"),
  ])
  assert.equal(stores.c, "North Las Vegas, Nevada, United States")
  assert.equal(out.failed, 0, JSON.stringify(out.failures))
  assert.equal(out.ok, 1)
})

test("the always-attached country list never answers another question", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // THE REASON THE DEFECT WAS INVISIBLE. intl-tel-input's list is the only
  // [role=listbox] on the real page, is always attached, is hidden, and
  // contains rows reading "Yes" and "No". A page-wide option search for a
  // control that names no menu of its own finds those rows first.
  //
  // The assertion is about #a, which can never legitimately succeed: if it
  // reports OK, the value came from a menu that is not its own.
  const { out, stores } = await run([combo("f1", "#a", "No")], {
    comboStrategies: ["click-option", "type-click", "type-enter"],
  })
  assert.equal(
    stores.a,
    "",
    "nothing committed, because this widget cannot commit",
  )
  assert.equal(
    out.ok,
    0,
    "a hidden row in a foreign menu must not be clickable, and must never " +
      "be read back as this field's answer",
  )
  assert.equal(out.failed, 1)
})
