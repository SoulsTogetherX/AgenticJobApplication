// THE VERIFY PASS AND CHOICE GROUPS, against real Chromium and the real
// engine. MEASURED on Torc's Greenhouse embed form, 2026-08-18: two required
// checkbox questions were answered by the plan (one box ticked each) and the
// submit was still refused, twice over —
//   1. every check item MISMATCHED: the probe wanted the banked option text
//      ("None/Not applicable") and the box read back "true";
//   2. the other five boxes of each question — required, unchecked, not in the
//      plan — were reported as REVEALED, as if the fill had uncovered five new
//      questions.
// A choice group is answered by ticking one of its members. What is pinned:
//   * a check item is verified by its tick, and lands;
//   * a required box that shares a NAME with a planned box (Greenhouse, Lever)
//     or its pure-choice <fieldset> (Ashby: one name per box) is covered by the
//     plan and never "revealed";
//   * the bound: a required box in a group the plan did NOT touch, and a
//     required box sharing a container that also holds a text input, are still
//     revealed — the rule cannot hide an unanswered question.
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

const PAGE = `<!doctype html><html><body><form>
  <!-- Greenhouse's shape: one name per question, every box required -->
  <fieldset class="checkbox" aria-required="true" id="q1">
    <legend>Are you a resident of any of the following?</legend>
    <div><input type="checkbox" required name="question_1[]" id="q1_a" value="a"><label for="q1_a">Cuba</label></div>
    <div><input type="checkbox" required name="question_1[]" id="q1_b" value="b"><label for="q1_b">Iran</label></div>
    <div><input type="checkbox" required name="question_1[]" id="q1_none" value="n"><label for="q1_none">None/Not applicable</label></div>
  </fieldset>
  <!-- Ashby's shape: one name per BOX, one fieldset per question -->
  <fieldset id="q2">
    <label class="_heading_ _required_">Select all that you are proficient in.</label>
    <div><input type="checkbox" required id="q2_0" name="Python"><label for="q2_0">Python</label></div>
    <div><input type="checkbox" required id="q2_1" name="Rust"><label for="q2_1">Rust</label></div>
    <div><input type="checkbox" required id="q2_2" name="Go"><label for="q2_2">Go</label></div>
  </fieldset>
  <!-- a radio group, Lever's shape -->
  <div class="application-question">
    <div class="application-label">Will you require sponsorship?</div>
    <label><input type="radio" required name="cards[x][field0]" id="r_yes" value="Yes"> Yes</label>
    <label><input type="radio" required name="cards[x][field0]" id="r_no" value="No"> No</label>
  </div>
  <!-- THE BOUND 1: a required group the plan never touched -->
  <fieldset id="q3">
    <legend>Untouched question</legend>
    <div><input type="checkbox" required name="question_3[]" id="q3_a" value="a"><label for="q3_a">Option A</label></div>
    <div><input type="checkbox" required name="question_3[]" id="q3_b" value="b"><label for="q3_b">Option B</label></div>
  </fieldset>
  <!-- THE BOUND 2: a wrapper that is NOT a pure choice group -->
  <fieldset id="mixed">
    <legend>Mixed</legend>
    <input type="text" id="mixed_text" name="mixed_text" required>
    <div><input type="checkbox" required id="m_a" name="Alpha"><label for="m_a">Alpha</label></div>
    <div><input type="checkbox" required id="m_b" name="Beta"><label for="m_b">Beta</label></div>
  </fieldset>
  <button type="submit">Send</button>
</form></body></html>`

const PLAN = {
  v: 1,
  slug: "x",
  ats: "generic",
  defer: [],
  items: [
    {
      k: "g1",
      sel: "#q1_none",
      how: "check",
      label: "Are you a resident…",
      value: "None/Not applicable",
      pick: "f3",
    },
    {
      k: "g2",
      sel: "#q2_0",
      how: "check",
      label: "Select all that you are proficient in.",
      value: "Python",
      pick: "f4",
    },
    {
      k: "g3",
      sel: "#r_no",
      how: "check",
      label: "Will you require sponsorship?",
      value: "No",
      pick: "f8",
    },
    {
      k: "f9",
      sel: "#mixed_text",
      how: "fill",
      label: "Mixed text",
      value: "x",
    },
    {
      k: "g4",
      sel: "#m_a",
      how: "check",
      label: "Mixed",
      value: "Alpha",
      pick: "f10",
    },
  ],
}

let cached
const run = async () => {
  if (cached) return cached
  const s = await launchBrowser({ headless: true })
  try {
    await s.page.setContent(PAGE)
    const out = await fillPage(s.page, PLAN)
    const checked = await s.page.evaluate(() =>
      [...document.querySelectorAll("input:checked")].map((i) => i.id),
    )
    cached = { out, checked }
    return cached
  } finally {
    await s.close()
  }
}

test("a check item is verified by its tick and lands — no mismatch against the option text", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const { out, checked } = await run()
  assert.deepEqual(checked.sort(), ["m_a", "q1_none", "q2_0", "r_no"])
  assert.equal(out.failed, 0, JSON.stringify(out.failures))
  assert.deepEqual(out.verify.mismatch, [], "no mismatch on a ticked box")
  for (const k of ["g1", "g2", "g3", "g4"])
    assert.ok(out.verify.landed.includes(k), `${k} landed`)
})

test("the other members of a planned choice group are covered, not 'revealed' — by name and by pure-choice fieldset", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const { out } = await run()
  const revealedSels = out.revealed.map((r) => r.sel)
  for (const sel of ["#q1_a", "#q1_b", "#q2_1", "#q2_2", "#r_yes"])
    assert.ok(
      !revealedSels.includes(sel),
      `${sel} is a sibling of a planned box: ${JSON.stringify(out.revealed)}`,
    )
})

test("THE BOUND: an untouched required group, and a required box in a mixed container, are still revealed", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const { out } = await run()
  const revealedSels = out.revealed.map((r) => r.sel)
  assert.ok(
    revealedSels.includes("#q3_a") && revealedSels.includes("#q3_b"),
    `the untouched question is still reported: ${JSON.stringify(out.revealed)}`,
  )
  // #m_b shares a fieldset with a planned box (#m_a) but that fieldset also
  // holds a text input, so the fieldset rule does not apply, and its name
  // ("Beta") is not a planned name — it stays revealed.
  assert.ok(
    revealedSels.includes("#m_b"),
    `a box in a mixed container is not covered: ${JSON.stringify(out.revealed)}`,
  )
})
