// Items 2.2 (long bank-sourced free text defers on the unattended path) and
// 2.3 (the per-form disclosure declaration), plus the shared limit loading.
//
// The two properties that would be easy to break and are asserted repeatedly:
//
//   * 2.2 DEFERS A FIELD, NOT AN APPLICATION. Every over-threshold case below
//     also asserts that the rest of the form still fills and that exactly one
//     entry moved. Deferring the application would be a volume bug, and the
//     user's unlimited-volume decision is explicit.
//   * 2.3's budget is a NUMBER WITH A BASIS, and the basis is in
//     disclosure.mjs. The tests here pin the arithmetic (floor vs fraction,
//     which rows count) rather than the constant, so re-measuring the constant
//     against a real distribution does not require rewriting them.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  DEFAULT_LIMITS,
  loadDisclosureLimits,
  longFreeTextReason,
  buildDisclosure,
} from "../../src/apply/disclosure.mjs"
import {
  buildPlan,
  readiness,
  submitReadiness,
} from "../../src/apply/fill-plan.mjs"

const ADAPTER = {
  id: "generic",
  comboStrategies: [],
  fileFields: [],
  fileOrder: [],
}

const scanOf = (fields) => ({
  slug: "acme-dev",
  url: "https://boards.greenhouse.io/acme/jobs/1",
  heading: "Apply to Acme",
  fields,
})

const plan = (fields, resolved, opts = {}) =>
  buildPlan({
    scan: scanOf(fields),
    resolved,
    adapter: ADAPTER,
    url: scanOf(fields).url,
    ...opts,
  })

// 240 characters of prose, 40 over the default limit.
const LONG =
  "I am drawn to this team because of the problems it works on. ".repeat(4)
const SHORT = "Two weeks."

const row = (k, over = {}) => ({
  k,
  sel: `#${k}`,
  t: "text",
  status: "OK",
  source: "a-019@0.81",
  value: SHORT,
  label: "",
  ...over,
})

// ===========================================================================
// 2.2 — long bank-sourced free text
// ===========================================================================

test("2.2 success: a SHORT bank-sourced textarea answer still fills", () => {
  // The complement first. If this ever fails, the rule stopped being a length
  // rule and became "textareas do not fill", which is not the item.
  const p = plan(
    [{ k: "f1", t: "textarea", sel: "#f1", l: "Notice period?" }],
    [row("f1", { t: "textarea", value: SHORT })],
  )
  assert.equal(p.defer.length, 0, JSON.stringify(p.defer))
  assert.equal(p.items[0].how, "fill")
  assert.equal(p.items[0].value, SHORT)
})

test("2.2 failure: a LONG bank-sourced textarea answer defers with a stated reason", () => {
  const p = plan(
    [
      { k: "f1", t: "text", sel: "#f1", l: "Full name" },
      {
        k: "f2",
        t: "textarea",
        sel: "#f2",
        l: "Anything else we should know?",
      },
    ],
    [
      row("f1", { source: "contact.name", value: "Jane Test" }),
      row("f2", { t: "textarea", value: LONG }),
    ],
  )
  const d = p.defer.find((x) => x.k === "f2")
  assert.ok(d, "the long textarea must defer")
  assert.equal(d.why, "long-free-text")
  assert.equal(d.value, LONG, "the text travels so the user can paste it")
  assert.match(d.note, new RegExp(`${LONG.length} characters`))
  assert.match(d.note, /a-019/, "the note names the bank entry")
  assert.match(d.note, /paste or edit it by hand/)

  // A FIELD, NOT AN APPLICATION.
  assert.equal(p.defer.length, 1, "nothing else was deferred")
  assert.equal(p.items.length, 1, "the rest of the form still fills")
  assert.equal(p.items[0].k, "f1")
  assert.equal(p.items[0].value, "Jane Test")
})

test("2.2 boundary: exactly at the limit fills, one character over defers", () => {
  const at = "x".repeat(DEFAULT_LIMITS.freeTextMaxChars)
  const over = "x".repeat(DEFAULT_LIMITS.freeTextMaxChars + 1)
  const field = { k: "f1", t: "textarea", sel: "#f1", l: "Tell us more" }

  const atPlan = plan([field], [row("f1", { t: "textarea", value: at })])
  assert.equal(atPlan.defer.length, 0, "<= the limit is not over the limit")
  assert.equal(atPlan.items[0].value, at)

  const overPlan = plan([field], [row("f1", { t: "textarea", value: over })])
  assert.equal(overPlan.defer[0].why, "long-free-text")
})

test("2.2 scope: a long PROFILE-sourced value is untouched, and so is a long option value", () => {
  // Scoped to the bank on purpose (see disclosure.mjs): profile.yaml is a
  // fixed curated set with no narratives in it, and a choice-shaped field's
  // value is bounded by what the page offered.
  const fromProfile = plan(
    [{ k: "f1", t: "textarea", sel: "#f1", l: "Summary" }],
    [row("f1", { t: "textarea", value: LONG, source: "experience.current" })],
  )
  assert.equal(fromProfile.defer.length, 0)

  const fromSelect = plan(
    [{ k: "f1", t: "select", sel: "#f1", l: "Country", opts: [LONG] }],
    [row("f1", { t: "select", value: LONG })],
  )
  assert.equal(
    fromSelect.defer.find((d) => d.why === "long-free-text"),
    undefined,
  )
})

test("2.2: an OPTIONAL long free-text defer does not block readiness; a REQUIRED one does", () => {
  // The attended/unattended split. `readiness()` answers for a human who is
  // already looking at the form; `submitReadiness()` answers for nobody.
  const fields = (req) => [
    { k: "f1", t: "text", sel: "#f1", l: "Full name" },
    { k: "f2", t: "textarea", sel: "#f2", l: "Anything else?", req },
  ]
  const rows = [
    row("f1", { source: "contact.name", value: "Jane Test" }),
    row("f2", { t: "textarea", value: LONG }),
  ]

  const optional = plan(fields(false), rows)
  assert.equal(
    readiness(optional).ready,
    true,
    readiness(optional).reason ?? "",
  )
  assert.equal(
    submitReadiness(optional).ready,
    false,
    "the UNATTENDED gate must block — that is what 'defers on the unattended path' means",
  )
  assert.match(submitReadiness(optional).reason, /deferred field/)

  const required = plan(fields(true), rows)
  assert.equal(
    readiness(required).ready,
    false,
    "a required field left blank means the form cannot be submitted at all",
  )
})

test("2.2 unit: longFreeTextReason is null for every non-triggering shape", () => {
  const L = DEFAULT_LIMITS
  const long = { source: "a-019@exact", value: "y".repeat(300) }
  assert.ok(longFreeTextReason({ t: "textarea" }, long, L))
  assert.ok(longFreeTextReason({ t: "text" }, long, L))
  assert.equal(longFreeTextReason({ t: "select" }, long, L), null)
  assert.equal(longFreeTextReason({ t: "combo" }, long, L), null)
  assert.equal(longFreeTextReason({ t: "file" }, long, L), null)
  assert.equal(
    longFreeTextReason(
      { t: "textarea" },
      { source: "eeo:decline", value: "y".repeat(300) },
      L,
    ),
    null,
  )
  assert.equal(
    longFreeTextReason(
      { t: "textarea" },
      { source: "a-019@exact", value: "" },
      L,
    ),
    null,
  )
  assert.equal(longFreeTextReason({ t: "textarea" }, undefined, L), null)
  assert.equal(longFreeTextReason(undefined, long, L), null)
})

// ===========================================================================
// 2.3 — the per-form disclosure declaration
// ===========================================================================

const bankFields = (n) =>
  Array.from({ length: n }, (_, i) => ({
    k: `b${i}`,
    t: "text",
    sel: `#b${i}`,
    l: `Question ${i}`,
  }))
const bankRows = (n) =>
  Array.from({ length: n }, (_, i) =>
    row(`b${i}`, { source: `a-${100 + i}@exact`, value: `answer ${i}` }),
  )

test("2.3: the plan NAMES the bank ids it will disclose", () => {
  const p = plan(bankFields(3), bankRows(3), { bankSize: 40 })
  assert.deepEqual(p.disclosure.ids, ["a-100", "a-101", "a-102"])
  assert.equal(p.disclosure.count, 3)
  assert.equal(p.disclosure.unusual, false)
  assert.equal(
    p.defer.find((d) => d.k === "__disclosure__"),
    undefined,
  )
})

test("2.3: profile-sourced fields are declared separately and are NOT budgeted", () => {
  const p = plan(
    [
      { k: "f1", t: "text", sel: "#f1", l: "Full name" },
      { k: "f2", t: "text", sel: "#f2", l: "Email" },
      { k: "f3", t: "text", sel: "#f3", l: "Q" },
    ],
    [
      row("f1", { source: "contact.name", value: "Jane" }),
      row("f2", { source: "contact.email", value: "j@e.com" }),
      row("f3", { source: "a-100@exact", value: "x" }),
    ],
    { bankSize: 40 },
  )
  assert.deepEqual(p.disclosure.ids, ["a-100"])
  assert.deepEqual(p.disclosure.profileFields, [
    "contact.email",
    "contact.name",
  ])
})

test("2.3 failure: an unusual set defers the application, with the numbers in the reason", () => {
  const n = DEFAULT_LIMITS.disclosureFloor + 1
  const p = plan(bankFields(n), bankRows(n), { bankSize: 40 })
  assert.equal(p.disclosure.unusual, true)
  assert.equal(p.disclosure.count, n)
  assert.equal(p.disclosure.budget, DEFAULT_LIMITS.disclosureFloor)
  const d = p.defer.find((x) => x.k === "__disclosure__")
  assert.ok(d, "an unusual disclosure set must defer")
  assert.equal(d.why, "disclosure-budget")
  assert.match(d.note, new RegExp(`${n} distinct banked facts`))
  assert.match(d.note, /a-100/)
  // Blocks BOTH gates: unlike a long textarea, "this form wants more of your
  // fact base than any real form measured" is something a human should read
  // before the engine runs, not only before a submit.
  assert.equal(readiness(p).ready, false)
  assert.equal(submitReadiness(p).ready, false)
})

test("2.3 boundary: exactly at the budget is not unusual", () => {
  const n = DEFAULT_LIMITS.disclosureFloor
  const p = plan(bankFields(n), bankRows(n), { bankSize: 40 })
  assert.equal(p.disclosure.count, n)
  assert.equal(p.disclosure.unusual, false)
  assert.equal(readiness(p).ready, true, readiness(p).reason ?? "")
})

test("2.3: the budget scales with the bank, so a bigger fact base is not throttled", () => {
  const big = buildDisclosure(
    bankFields(30).map((f, i) => ({ k: f.k, how: "fill", value: `v${i}` })),
    bankRows(30),
    { bankSize: 200, limits: DEFAULT_LIMITS },
  )
  assert.equal(big.budget, 50, "ceil(200 * 0.25) overtakes the floor")
  assert.equal(big.unusual, false)

  const small = buildDisclosure(
    bankFields(30).map((f, i) => ({ k: f.k, how: "fill", value: `v${i}` })),
    bankRows(30),
    { bankSize: 40, limits: DEFAULT_LIMITS },
  )
  assert.equal(small.budget, DEFAULT_LIMITS.disclosureFloor)
  assert.equal(small.unusual, true)
})

test("2.3: a DEFERRED or SKIPPED row discloses nothing and is not counted", () => {
  // The number must not rise as the pipeline gets MORE cautious — a deferred
  // value goes into the approval message, not into the page.
  const n = DEFAULT_LIMITS.disclosureFloor + 4
  const fields = bankFields(n).map((f, i) =>
    // half the fields become consent boxes, which always defer
    i % 2
      ? { ...f, t: "checkbox", l: "I agree to the terms and conditions" }
      : f,
  )
  const p = plan(fields, bankRows(n), { bankSize: 40 })
  assert.ok(p.disclosure.count < n, "deferred rows were counted")
  assert.equal(p.disclosure.unusual, false)

  const skipped = buildDisclosure(
    [
      { k: "b0", how: "fill", value: "x" },
      { k: "b1", how: "skip", value: "" },
      { k: "b2", how: "upload", paths: ["/tmp/r.pdf"], value: "x" },
    ],
    bankRows(3),
    { bankSize: 40, limits: DEFAULT_LIMITS },
  )
  assert.deepEqual(skipped.ids, ["a-100"])
})

test("2.3: a refused page (login wall) still carries a disclosure declaration", () => {
  // Uniform shape. A consumer reading plan.disclosure.count must not have to
  // know which branch of buildPlan produced the plan.
  const p = buildPlan({
    scan: { ...scanOf([]), kind: "login" },
    resolved: [],
    adapter: ADAPTER,
    url: "https://boards.greenhouse.io/acme/jobs/1",
  })
  assert.equal(p.disclosure.count, 0)
  assert.deepEqual(p.disclosure.ids, [])
})

// ===========================================================================
// limits: configurable, not magic
// ===========================================================================

test("limits: the user's application-limits.yaml can move both numbers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aj-limits-"))
  try {
    const file = path.join(dir, "limits.yaml")
    fs.writeFileSync(
      file,
      "auto_apply:\n  max_freetext_chars: 500\n  disclosure_budget: 30\n  disclosure_fraction: 0.5\n",
    )
    const l = loadDisclosureLimits({ limitsFile: file })
    assert.equal(l.freeTextMaxChars, 500)
    assert.equal(l.disclosureFloor, 30)
    assert.equal(l.disclosureFraction, 0.5)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("limits: a caller override beats the file, and a bad value is IGNORED not obeyed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aj-limits-"))
  try {
    const file = path.join(dir, "limits.yaml")
    fs.writeFileSync(
      file,
      "auto_apply:\n  max_freetext_chars: 500\n  disclosure_budget: nope\n  disclosure_fraction: 7\n",
    )
    const l = loadDisclosureLimits({
      limitsFile: file,
      overrides: { freeTextMaxChars: "120" },
    })
    assert.equal(l.freeTextMaxChars, 120, "the override wins")
    assert.equal(
      l.disclosureFloor,
      DEFAULT_LIMITS.disclosureFloor,
      "an unparsable number falls back to the default, never to 'off'",
    )
    assert.equal(
      l.disclosureFraction,
      DEFAULT_LIMITS.disclosureFraction,
      "a fraction above 1 is not a fraction",
    )
    // Zero and negative are the dangerous shapes — they would read as "no
    // limit" if coerced instead of rejected.
    const z = loadDisclosureLimits({
      limitsFile: file,
      overrides: { freeTextMaxChars: "0", disclosureFloor: "-5" },
    })
    assert.equal(z.freeTextMaxChars, 500)
    assert.equal(z.disclosureFloor, DEFAULT_LIMITS.disclosureFloor)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("limits: a missing or unreadable limits file leaves the defaults standing", () => {
  const l = loadDisclosureLimits({
    limitsFile: path.join(os.tmpdir(), "definitely-not-here-9f2a.yaml"),
  })
  assert.deepEqual(l, { ...DEFAULT_LIMITS })
})

test("buildPlan defaults are the STRICT end when a caller passes neither limits nor bankSize", () => {
  // An existing caller that has not been updated must not get an open gate.
  const n = DEFAULT_LIMITS.disclosureFloor + 1
  const p = plan(bankFields(n), bankRows(n))
  assert.equal(p.disclosure.bankSize, 0)
  assert.equal(p.disclosure.budget, DEFAULT_LIMITS.disclosureFloor)
  assert.equal(p.disclosure.unusual, true)
})
