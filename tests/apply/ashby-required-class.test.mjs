// ASHBY — a required field whose only "required" marker is a CSS class.
//
// MEASURED on a live Render application (jobs.ashbyhq.com), 2026-08-04, while
// applying from the backlog. Ashby renders a required question as
//
//   <label class="_heading_f7cvd_52 _required_f7cvd_91 ...">Location</label>
//   <input role="combobox" placeholder="Start typing...">
//
// The asterisk a human sees is CSS ::after content generated from that class.
// So the label TEXT is the bare word, and the control carries neither
// `required` nor `aria-required` — the only two attributes isReq() read. The
// field came back optional, fill-plan.mjs skipped it as "optional and not in
// the fact base", and the run was one click from submitting an application
// with a required field empty while reporting nothing wrong.
//
// THE DIRECTION OF THE BUG IS WHAT MAKES IT SERIOUS, and it is the same
// direction as the Oracle wrapper case in scan-page.js: a blocker that does
// not look like one is skipped in SILENCE. An over-reported required field
// stops the run and asks; an under-reported one submits.
//
// What is pinned here is both halves — that the marker is now read, and that
// reading it does not become a licence to mark fields required because the
// word "required" appears somewhere in a page-controlled class list.
import test from "node:test"
import assert from "node:assert/strict"

import { runScanner } from "../fixtures/boards/dom.mjs"

const page = (body) => `<html><body><form>${body}</form></body></html>`

const field = (out, label) =>
  (out.fields || []).find((f) => (f.l || "").startsWith(label))

// --- the real shape -------------------------------------------------------

test("Ashby's CSS-module _required_ class marks the field required", async () => {
  const out = await runScanner(
    page(`
      <div class="_fieldEntry_1e3gg_28 ashby-application-form-field-entry">
        <label class="_heading_f7cvd_52 _required_f7cvd_91 _label_1e3gg_42"
               for="_systemfield_location">Location</label>
        <div class="_inputContainer_d7ago_28">
          <input class="_input_d7ago_28" placeholder="Start typing..."
                 aria-autocomplete="list" aria-haspopup="listbox"
                 role="combobox" value="">
        </div>
      </div>`),
  )
  const f = field(out, "Location")
  assert.ok(f, "the Location control is reported at all")
  assert.equal(f.t, "combo", "a lone role=combobox is still a combo")
  assert.equal(f.req, true, "the label's _required_ class is read as required")
})

test("an Ashby field with no _required_ class stays optional", async () => {
  const out = await runScanner(
    page(`
      <div class="_fieldEntry_1e3gg_28">
        <label class="_heading_f7cvd_52 _label_1e3gg_42" for="w">Website</label>
        <input id="w" type="text">
      </div>`),
  )
  const f = field(out, "Website")
  assert.ok(f, "the field is reported")
  assert.ok(!f.req, "nothing marked it required, so it is not marked required")
})

// --- other spellings of the same marker -----------------------------------

for (const cls of ["is-required", "field--required", "required"]) {
  test(`"${cls}" is recognised as the required token too`, async () => {
    const out = await runScanner(
      page(`
        <div>
          <label class="lbl ${cls}" for="a">Answer</label>
          <input id="a" type="text">
        </div>`),
    )
    assert.equal(field(out, "Answer").req, true)
  })
}

// --- the bounds, which are the half that keeps this honest ----------------

for (const cls of ["not-required", "notRequired", "optional required-hint"]) {
  test(`"${cls}" does NOT mark the field required — it negates the marker`, async () => {
    const out = await runScanner(
      page(`
        <div>
          <label class="lbl ${cls}" for="a">Answer</label>
          <input id="a" type="text">
        </div>`),
    )
    assert.ok(
      !field(out, "Answer").req,
      "a class that negates the marker must not be read as the marker",
    )
  })
}

for (const cls of ["requiredness", "prerequired", "notrequiredx"]) {
  test(`"${cls}" is a longer word, not the token — no required flag`, async () => {
    const out = await runScanner(
      page(`
        <div>
          <label class="lbl ${cls}" for="a">Answer</label>
          <input id="a" type="text">
        </div>`),
    )
    assert.ok(
      !field(out, "Answer").req,
      "the token is matched with its separators, never as a substring",
    )
  })
}

// --- groups: the label is the question, not any one box's label -----------

test("a radio group whose entry label carries the marker is required", async () => {
  const out = await runScanner(
    page(`
      <div class="_fieldEntry_1e3gg_28">
        <label class="_heading_f7cvd_52 _required_f7cvd_91">Are you legally authorized to work in the United States of America?</label>
        <div>
          <label><input type="radio" name="auth" value="Yes"> Yes</label>
          <label><input type="radio" name="auth" value="No"> No</label>
        </div>
      </div>`),
  )
  const g = (out.fields || []).find((f) => f.t === "radio")
  assert.ok(g, "the group is reported")
  assert.equal(
    g.req,
    true,
    "the wrapper's single label speaks for the whole group",
  )
})

test("a wrapper holding TWO questions lends its marker to neither", async () => {
  const out = await runScanner(
    page(`
      <div class="wrap">
        <label class="_required_abc_1">First question</label>
        <label class="plain">Second question</label>
        <div>
          <label><input type="radio" name="q" value="Yes"> Yes</label>
          <label><input type="radio" name="q" value="No"> No</label>
        </div>
      </div>`),
  )
  const g = (out.fields || []).find((f) => f.t === "radio")
  assert.ok(g, "the group is still reported")
  assert.ok(
    !g.req,
    "two labels means the container cannot say WHICH question is required",
  )
})

// --- the whole point: the plan must stop skipping it ----------------------
//
// The scanner half is only useful if it changes what fill-plan.mjs does with
// the field. Before this fix the Location row read
//   skip  f1  optional and not in the fact base (needs-choice)  Location
// which is the silent skip. It must now be a field the plan has to account
// for, one way or another — never a silent skip.
test("a required combo is no longer skipped as optional", async () => {
  const out = await runScanner(
    page(`
      <div class="_fieldEntry_1e3gg_28">
        <label class="_heading_f7cvd_52 _required_f7cvd_91">Location</label>
        <input role="combobox" placeholder="Start typing...">
      </div>`),
  )
  const f = field(out, "Location")
  assert.equal(f.req, true)
  assert.ok(
    !(Array.isArray(f.opts) && f.opts.length),
    "an async typeahead has no enumerable options until it is probed",
  )
})

// --- THE BUTTON-PAIR PATH, which never asked (2026-08-25) -------------------
//
// Ashby renders its yes/no questions as a PAIR OF <button> ELEMENTS, not as
// native radios. The scanner has a dedicated path for that shape, and until
// 2026-08-25 it was the one required-ness site that never called
// entryLabelRequired — even though that function's own worked example is
// literally `<div> <button>Yes</button> <button>No</button> </div>`.
//
// THE COST, and it is the serious direction again. Ashby's asterisk is CSS
// ::after from a _required_ class, so isReq() answered false and every Ashby
// yes/no group scanned as not-required. `unattended_assent.required_widgets`
// only reaches REQUIRED widgets, so the user's switched-on grant could never
// fire; `optional: skip` left the group blank and stopped it blocking; the
// submit went; Ashby's client validation refused it; the page stayed on the
// form; the classifier said `unclassified`; a company brake went up — and a
// run that sent NOTHING was recorded as a possible application. Measured on
// the staged capture of a real Eliza click: still the form, both required
// work-auth groups `aria-pressed="false"` on BOTH options.
const pairGroup = (labelCls, question) => `
  <div class="_fieldEntry_1e3gg_28">
    <label class="_heading_f7cvd_52 ${labelCls}">${question}</label>
    <div>
      <button type="button" aria-pressed="false">Yes</button>
      <button type="button" aria-pressed="false">No</button>
    </div>
  </div>`

const groupOf = (out) =>
  (out.fields || []).find((f) => f.widget === "buttons")

test("a BUTTON-PAIR group whose entry label carries the marker is required", async () => {
  const out = await runScanner(
    page(
      pairGroup(
        "_required_f7cvd_91",
        "Are you legally authorized to work in the United States of America?",
      ),
    ),
  )
  const g = groupOf(out)
  assert.ok(g, "the button pair is reported as a group")
  assert.equal(
    g.req,
    true,
    "THE REGRESSION GUARD: a button pair must read the same marker the " +
      "native radio path has always read. When this goes red, Ashby submits " +
      "start silently failing again.",
  )
})

test("a BUTTON-PAIR group with no marker stays optional", async () => {
  const out = await runScanner(
    page(pairGroup("_label_1e3gg_42", "Would you like to receive updates?")),
  )
  const g = groupOf(out)
  assert.ok(g, "the group is still reported")
  assert.ok(!g.req, "nothing marked it required, so it is not marked required")
})

test("the pair path does not widen the marker's bounds", async () => {
  // The same negation and token-boundary rules the native paths obey. Reading
  // a marker must not become a licence to mark a field required because the
  // word appears somewhere in a page-controlled class list — a page author
  // controls these strings.
  for (const cls of ["not-required", "requiredness", "prerequired"]) {
    const out = await runScanner(page(pairGroup(cls, "Do you agree?")))
    const g = groupOf(out)
    assert.ok(
      g && !g.req,
      `"${cls}" must not be read as the required token on the pair path`,
    )
  }
})

test("a pair wrapper holding TWO labels lends its marker to neither", async () => {
  const out = await runScanner(
    page(`
      <div class="_fieldEntry_1e3gg_28">
        <label class="_heading_f7cvd_52 _required_f7cvd_91">First question?</label>
        <label class="_heading_f7cvd_52">Second question?</label>
        <div>
          <button type="button" aria-pressed="false">Yes</button>
          <button type="button" aria-pressed="false">No</button>
        </div>
      </div>`),
  )
  const g = groupOf(out)
  if (g)
    assert.ok(
      !g.req,
      "two labels means the container cannot say WHICH question is required",
    )
})
