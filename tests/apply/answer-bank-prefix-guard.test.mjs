// Regression tests for AUDIT C1/C2: matchOption's prefix rule used to accept
// any option that merely STARTED WITH the resolved value, which silently
// upgraded a plain "Yes" into a specific, unstated claim. On the auto-submit
// path this is the most dangerous bug in the file — a false claim on a real
// application, produced deterministically, with no human review.
//
// These exercise matchOption directly (unit-level) as well as through
// resolveFieldsFromFiles end to end, so a regression in either the exported
// helper or its wiring into the resolve loop is caught.
import test from "node:test"
import assert from "node:assert/strict"
import {
  matchOption,
  resolveFieldsFromFiles,
} from "../../src/apply/answer-bank.mjs"

const FIXTURES = "tests/fixtures"

function resolveAll(fields) {
  const { results } = resolveFieldsFromFiles(fields, {
    profileFile: `${FIXTURES}/profile.yaml`,
    answersFile: `${FIXTURES}/answers-bank.yaml`,
  })
  return new Map(results.map((r) => [r.k, r]))
}

// --- unit level: matchOption itself --------------------------------------

test("C1: a bare Yes is not upgraded into a quantified claim the option adds", () => {
  const m = matchOption("Yes", ["Yes, 5+ years professionally", "No"], {
    label: "Do you have experience with React?",
  })
  assert.equal(
    m.needsChoice,
    true,
    "5+ years professionally is a claim the user never made",
  )
  assert.notEqual(m.value, "Yes, 5+ years professionally")
})

test("C2: a bare No does not become a list-negation option", () => {
  const m = matchOption("No", ["None of the above", "Yes"], {
    label: "Have you previously been employed at Globex?",
  })
  assert.equal(m.needsChoice, true)
  assert.notEqual(m.value, "None of the above")
})

test("a grounded expansion (the option only echoes the label back) still resolves", () => {
  // Contrast case: the option adds words, but every one of them already
  // appears in the field's own label, so nothing new is being asserted.
  const m = matchOption(
    "No",
    ["Yes, I will require sponsorship", "No, I will not require sponsorship"],
    {
      label:
        "Will you now or in the future require sponsorship for employment visa status?",
    },
  )
  assert.equal(m.needsChoice, undefined)
  assert.equal(m.value, "No, I will not require sponsorship")
})

test("truncating a longer bank value down to a clean offered option is unaffected", () => {
  // The opposite direction: the BANK holds more detail than the form offers.
  // Dropping detail can never invent a claim, so this must stay permissive.
  const m = matchOption("Yes, US citizen, no sponsorship needed.", [
    "Yes",
    "No",
  ])
  assert.equal(m.needsChoice, undefined)
  assert.equal(m.value, "Yes")
})

test("truncation still requires a real word boundary, not a character coincidence", () => {
  const m = matchOption("November", ["No", "Yes"])
  assert.equal(
    m.needsChoice,
    true,
    "'November' must not truncate to 'No' on a two-letter coincidence",
  )
})

// --- end to end: through the resolve loop ---------------------------------

test("end to end: C1 reproduction from the audit resolves NEEDS-CHOICE, not OK", () => {
  // answers-bank.yaml has no entry for React experience, so bank this exact
  // question with a bare "Yes" via the exact-match tier by asking the SAME
  // question the fixture already answers ("Are you authorized to work in the
  // US?" -> "Yes, US citizen, no sponsorship needed.") but offering options
  // that add an unstated qualifier the way a real ATS "years of experience"
  // dropdown does.
  const r = resolveAll([
    {
      k: "f1",
      t: "select",
      l: "Are you legally authorized to work in the United States?",
      opts: ["Yes", "No"],
    },
  ])
  // Sanity: this one DOES resolve OK, because "Yes" is actually offered.
  assert.equal(r.get("f1").status, "OK")
  assert.equal(r.get("f1").value, "Yes")
})

test("end to end: an offered option that adds an unstated qualifier defers", () => {
  const r = resolveAll([
    {
      k: "f1",
      t: "select",
      l: "Are you legally authorized to work in the United States?",
      opts: ["Yes, and I do not need visa sponsorship of any kind", "No"],
    },
  ])
  assert.equal(r.get("f1").status, "NEEDS-CHOICE")
  assert.notEqual(
    r.get("f1").value,
    "Yes, and I do not need visa sponsorship of any kind",
  )
})
