// Two shapes of required consent that the user's `unattended_assent` keys could
// not reach, both fixed on 2026-08-20 by their decision, and both fenced here.
//
// The measurement that prompted it: an unattended run submitted 0 of 10, and
// the consent deferrals came from forms where `required_consent: all` had been
// on since 2026-08-18. The key was never the problem — it could not see the
// controls.
//
//   ASHBY   every consent box sits in its own <fieldset>, and a legend-sourced
//           label is refused the vouch, so the grant died at the vouch check.
//           jobs.ashbyhq.com/openai scanned `vouched=0`.
//   REDDIT  the consent is a react-select, not a checkbox, so `singleBox` was
//           false and the grant was structurally unreachable.
//
// The tests below are two-sided on purpose. Each fix widens what a REQUIRED,
// vouched consent may do; neither may widen anything else, and the negative
// cases are the half that says so.
import test from "node:test"
import assert from "node:assert/strict"
import { runScanner } from "../fixtures/boards/dom.mjs"
import {
  buildPlan,
  CONSENT_AFFIRM,
  CONSENT_NEGATION,
} from "../../scripts/apply/fill-plan.mjs"

const ADAPTER = { id: "generic", comboStrategies: [], fileFields: [] }
const URL = "http://127.0.0.1:1/x"

const ALL_ON = {
  required_assertions: true,
  required_widgets: true,
  required_consent: "all",
  optional: "defer",
}

const page = (body) =>
  `<!doctype html><html><body><form>${body}</form></body></html>`

// ---------------------------------------------------------------- the vouch

test("a fieldset around ONE consent box is that box's label, and is vouched", async () => {
  const scan = await runScanner(
    page(`
      <fieldset>
        <legend>Arbitration Agreement Acknowledgement</legend>
        <label><input type="checkbox" name="arb" required>
          I acknowledge that I have read and understood the Arbitration Agreement.
        </label>
      </fieldset>`),
  )
  const g = scan.fields.find((f) => f.t === "checkbox")
  assert.ok(g, "the checkbox group should be scanned")
  assert.equal(g.labelExact, true, "a single-control fieldset must vouch")
  // The COMPLETE visible text, never the legend alone: vouching the heading
  // while the terms sit below it is the truncation attack in a new hat.
  assert.match(g.l, /Arbitration Agreement Acknowledgement/)
  assert.match(g.l, /read and understood the Arbitration Agreement/)
})

test("a legend over a BARE ANSWER TOKEN is a question, and never vouches", async () => {
  // The hostile-escalated-tickbox shape. Folding these two together would
  // append an affirmative to a question whose honest answer might be no.
  const scan = await runScanner(
    page(`
      <fieldset>
        <legend>Are you legally authorized to work in the United States?</legend>
        <label><input type="checkbox" name="work_authorization"> Yes</label>
      </fieldset>`),
  )
  const g = scan.fields.find((f) => f.t === "checkbox")
  assert.ok(g, "the checkbox group should be scanned")
  assert.notEqual(
    g.labelExact,
    true,
    "a question + answer token must not vouch",
  )
  assert.equal(
    g.l,
    "Are you legally authorized to work in the United States?",
    "the question must survive intact, with no answer appended",
  )
})

test("a fieldset around TWO controls still never vouches", async () => {
  const scan = await runScanner(
    page(`
      <fieldset>
        <legend>Select the terms you accept</legend>
        <label><input type="checkbox" name="a"> The privacy policy as published today.</label>
        <label><input type="checkbox" name="b"> The marketing terms as published today.</label>
      </fieldset>`),
  )
  for (const g of scan.fields.filter((f) => f.t === "checkbox")) {
    assert.notEqual(
      g.labelExact,
      true,
      "a legend over more than one control does not say WHICH box",
    )
  }
})

// -------------------------------------------------------- the consent combo

const comboScan = (options, { req = true, labelExact = true } = {}) => ({
  v: 1,
  url: URL,
  kind: "form",
  fields: [
    {
      k: "f1",
      t: "combo",
      sel: "#c",
      l: "By selecting I agree, you accept the Candidate Privacy Policy.",
      // What the real combo builder emits for a vouchable label since
      // 2026-08-21 — and what these tests were WRONG to hand-wave before:
      // the suite mapped every label into vouchedLabels directly, so the
      // dropdown grant tested green while the scanner could not vouch a
      // combo at all and the grant was dead on every real path.
      ...(labelExact ? { labelExact: true } : {}),
      req,
      opts: options,
      o: [],
    },
  ],
  btns: [],
  iframes: [],
  signals: [],
})

const planFor = (scan, { vouch = true } = {}) =>
  buildPlan({
    scan,
    resolved: [],
    adapter: ADAPTER,
    url: URL,
    assent: ALL_ON,
    // Derived exactly as scan-engine.mjs derives it — from labelExact — so a
    // combo the real scanner cannot vouch cannot be vouched here either
    // (tests/security/hostile-forms.test.mjs's asScanned pattern).
    vouchedLabels: vouch
      ? scan.fields.filter((f) => f.labelExact === true).map((f) => f.l)
      : [],
  })

test("a required consent DROPDOWN with one affirmative option is selected", () => {
  const plan = planFor(comboScan(["I agree", "I do not agree"]))
  const item = plan.items.find((i) => i.k === "f1")
  assert.ok(
    item,
    `expected an actuated item, got defer=${JSON.stringify(plan.defer)}`,
  )
  assert.equal(item.value, "I agree")
  assert.equal(item.assent, true)
  assert.ok(item.grant, "the act must carry the grant that permitted it")
  assert.ok(
    plan.actuated.some((a) => a.k === "f1"),
    "an actuated consent must be recorded for the report — assent is delegated, the record is not",
  )
})

test("TWO affirmative options defer — nothing decides which yes was meant", () => {
  const plan = planFor(comboScan(["I agree", "Yes, I accept"]))
  assert.equal(
    plan.items.find((i) => i.k === "f1"),
    undefined,
  )
  assert.ok(plan.defer.some((d) => d.k === "f1"))
})

test("NO affirmative option defers — there is nothing to agree with", () => {
  const plan = planFor(comboScan(["Select...", "Please choose"]))
  assert.equal(
    plan.items.find((i) => i.k === "f1"),
    undefined,
  )
  assert.ok(plan.defer.some((d) => d.k === "f1"))
})

test("an UNVOUCHED consent dropdown defers however the key is set", () => {
  const plan = planFor(comboScan(["I agree", "I do not agree"]), {
    vouch: false,
  })
  assert.equal(
    plan.items.find((i) => i.k === "f1"),
    undefined,
  )
  const d = plan.defer.find((x) => x.k === "f1")
  assert.ok(d, "an unvouched consent must defer")
  assert.match(String(d.note ?? ""), /could not vouch/)
})

test("an UNPROBED dropdown defers — the pick must come off the live form", () => {
  // opts: [] is the react-select-before-probe state. Guessing "I agree" here
  // would be rule 6's forbidden guess with the model removed.
  const plan = planFor(comboScan([]))
  assert.equal(
    plan.items.find((i) => i.k === "f1"),
    undefined,
  )
  assert.ok(plan.defer.some((d) => d.k === "f1"))
})

// ------------------------------------------------------- the two expressions

test("negation is caught on BOTH sides of the verb", () => {
  const affirmative = (t) => CONSENT_AFFIRM.test(t) && !CONSENT_NEGATION.test(t)
  assert.ok(affirmative("I agree"))
  assert.ok(affirmative("Agree"))
  assert.ok(affirmative("I acknowledge the above."))
  // Before the verb, and after it.
  assert.ok(!affirmative("I do not agree"))
  assert.ok(!affirmative("I agree, except to marketing email"))
  assert.ok(!affirmative("I decline"))
  assert.ok(!affirmative("No"))
  // Not affirmative at all.
  assert.ok(!affirmative("Select..."))
  assert.ok(!affirmative("Maybe later"))
})

// -------------------------------------------- the combo vouch, END TO END

// The gap the hand-built vouch above hid for a day: fill-plan requires the
// vouch, scan-engine derives the vouch from `labelExact`, and until
// 2026-08-21 NOTHING set labelExact on a combo — so the dropdown grant was
// dead code on every real path while these tests passed. These run the REAL
// scanner over the react-select shape and assert the vouch exists at the
// source.

test("a react-select consent combo is VOUCHED by the real scanner (labelExact)", async () => {
  const scan = await runScanner(
    page(`
      <label for="cc">By selecting I agree, I understand that the information I have provided as part of this job application will be processed per the Candidate Privacy Policy.</label>
      <div class="select__control" role="combobox" aria-expanded="false">
        <input id="cc" aria-required="true">
      </div>`),
  )
  const f = scan.fields.find((x) => x.t === "combo")
  assert.ok(f, "the combo should be scanned")
  assert.equal(f.labelExact, true, "a for-sourced combo label must vouch")
  // The COMPLETE text, past the 120-char cut every other label takes: a
  // vouched label is never truncated (the truncation attack).
  assert.match(f.l, /Candidate Privacy Policy\.$/)
  assert.ok(f.l.length > 120, "the vouched label must not be truncated")
})

test("a combo labelled only by an ARIA-LABEL never vouches — an attribute is not visible text", async () => {
  const scan = await runScanner(
    page(`
      <div class="select__control" role="combobox" aria-expanded="false">
        <input aria-label="I certify the information above is true.">
      </div>`),
  )
  const f = scan.fields.find((x) => x.t === "combo")
  assert.ok(f, "the combo should be scanned")
  assert.notEqual(f.labelExact, true, "an attribute source must not vouch")
})

// --- the Greenhouse remix nesting (measured live, Reddit, 2026-08-22) ------
//
// The remix frontend nests the react-select input FIVE wrappers deep:
// input → select__input-container → select__value-container → select__control
// → (unnamed div) → select-shell, with the label[for] a SIBLING of
// select-shell inside select__container. An adjacency chain walked from the
// inner input dies inside the widget's own plumbing, so a correctly-authored
// label[for] was refused as "not adjacent" and every remix consent combo
// deferred. The combo branch now measures adjacency from the widget's outer
// shell; the budget and every other check are unchanged.

const REMIX_CONSENT = `
  <div class="field-wrapper"><div class="select"><div class="select__container">
    <label id="q-1-label" for="q-1" class="label select__label">By selecting "I agree," I understand that the information I have provided as part of this job application will be processed in accordance with the Candidate Privacy Policy. <span aria-hidden="true">*</span></label>
    <div class="select-shell remix-css-b62m3t-container">
      <div>
        <div class="select__control remix-css-13cymwt-control">
          <div class="select__value-container remix-css-hlgwow">
            <div class="select__input-container remix-css-19bb58m">
              <input class="select__input" id="q-1" type="text" aria-autocomplete="list" aria-expanded="false" aria-haspopup="true" aria-labelledby="q-1-label" role="combobox" aria-required="true">
            </div>
          </div>
        </div>
      </div>
    </div>
  </div></div></div>`

test("the remix five-deep consent combo is VOUCHED — adjacency measures from the shell", async () => {
  const scan = await runScanner(page(REMIX_CONSENT))
  const f = scan.fields.find((x) => x.t === "combo")
  assert.ok(f, "the combo should be scanned")
  assert.equal(
    f.labelExact,
    true,
    `the remix nesting must vouch, got labelWhy=${JSON.stringify(f.labelWhy)}`,
  )
  assert.match(f.l, /Candidate Privacy Policy\./)
  assert.ok(f.l.length > 120, "the vouched label must not be truncated")
})

test("the same nesting with a DECOUPLED label still refuses, and says why", async () => {
  // The label's `for` (and the input's labelledby) point across the page at a
  // different control — the decoupling attack. The shell-origin chain must
  // not reach it, and the refusal is now visible on the record (labelWhy).
  const scan = await runScanner(
    page(`
      <div class="elsewhere">
        <label id="far-label" for="q-2" class="label">I agree to everything on this page without reading it.</label>
      </div>
      <div><div><div><div><div><div><div><div>
        <input id="unrelated" type="text">
      </div></div></div></div></div></div></div></div>
      <div class="field-wrapper"><div class="select"><div class="select__container">
        <div class="select-shell">
          <div>
            <div class="select__control">
              <div class="select__value-container">
                <div class="select__input-container">
                  <input class="select__input" id="q-2" type="text" aria-labelledby="far-label" role="combobox" aria-required="true">
                </div>
              </div>
            </div>
          </div>
        </div>
      </div></div></div>`),
  )
  const f = scan.fields.find(
    (x) => x.t === "combo" && /agree to everything/i.test(x.l ?? ""),
  )
  assert.ok(f, "the combo should be scanned")
  assert.notEqual(f.labelExact, true, "a decoupled label must not vouch")
  assert.equal(
    f.labelWhy,
    "label is not adjacent to the control",
    "the combo record must carry WHY the vouch failed",
  )
})
