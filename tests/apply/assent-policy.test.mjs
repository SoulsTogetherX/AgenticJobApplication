// The unattended-assent policy (2026-08-18): what the user's own config keys
// let buildPlan act on, and how submitReadiness tells a granted actuation from
// an ungranted one.
//
// The property every test here is really about: WITH THE POLICY OFF, NOTHING
// CHANGES. Every grant defaults off, so every existing test in this suite is
// still asserting today's behaviour; the tests below turn the keys on one at a
// time and assert exactly the widening the user chose — "if required, fuzzy
// exact; otherwise leave them alone" and "tick required, except legal-weight".
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  ASSENT_OFF,
  GRANTS,
  loadAssentPolicy,
  normalizeAssentPolicy,
  grantEnabled,
  anyGrant,
} from "../../scripts/apply/assent-policy.mjs"
import {
  buildPlan,
  submitReadiness,
  readiness,
} from "../../scripts/apply/fill-plan.mjs"
import greenhouse from "../../scripts/apply/ats/greenhouse.mjs"

const files = {
  resume: "C:\\jobs\\x\\resume.pdf",
  cover: "C:\\jobs\\x\\cover-letter.pdf",
}
const scanOf = (fields) => ({
  url: "https://job-boards.greenhouse.io/x/jobs/1",
  fields,
})

/** The policy the user chose on 2026-08-18. */
const USER_POLICY = Object.freeze({
  required_assertions: true,
  required_widgets: true,
  required_consent: "non-legal",
  optional: "skip",
})

const plan = (fields, resolved, over = {}) =>
  buildPlan({
    scan: scanOf(fields),
    resolved,
    adapter: greenhouse,
    files,
    ...over,
  })

// --- the loader ---------------------------------------------------------------

test("every grant is OFF by default, and OFF is byte-for-byte today's behaviour", () => {
  assert.deepEqual(normalizeAssentPolicy(undefined), ASSENT_OFF)
  assert.deepEqual(normalizeAssentPolicy(null), ASSENT_OFF)
  assert.deepEqual(normalizeAssentPolicy("yes"), ASSENT_OFF)
  assert.deepEqual(normalizeAssentPolicy([]), ASSENT_OFF)
  assert.equal(anyGrant(ASSENT_OFF), false)
})

test("a key that is not the literal on-value is the off-value — a typo cannot switch a grant on", () => {
  const p = normalizeAssentPolicy({
    required_assertions: "true", // a string, not the boolean
    required_widgets: 1,
    required_consent: "yes",
    optional: "leave",
  })
  assert.deepEqual(p, ASSENT_OFF)
})

test("the user's chosen policy parses to exactly what they wrote", () => {
  const p = normalizeAssentPolicy(USER_POLICY)
  assert.deepEqual(p, USER_POLICY)
  assert.equal(grantEnabled(p, GRANTS.REQUIRED_ASSERTION), true)
  assert.equal(grantEnabled(p, GRANTS.REQUIRED_WIDGET), true)
  assert.equal(grantEnabled(p, GRANTS.REQUIRED_CONSENT), true)
  assert.equal(grantEnabled(p, "made-up-grant"), false)
  assert.equal(anyGrant(p), true)
})

test("loadAssentPolicy reads auto_apply.unattended_assent from the limits file, and a missing or broken file is OFF", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aj-assent-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, "limits.yaml")
  fs.writeFileSync(
    file,
    [
      "auto_apply:",
      "  enabled: true",
      "  unattended_assent:",
      "    required_assertions: true",
      "    required_widgets: false",
      "    required_consent: non-legal",
      "    optional: skip",
      "",
    ].join("\n"),
  )
  assert.deepEqual(loadAssentPolicy({ limitsFile: file }), {
    required_assertions: true,
    required_widgets: false,
    required_consent: "non-legal",
    optional: "skip",
  })
  assert.deepEqual(
    loadAssentPolicy({ limitsFile: path.join(dir, "absent.yaml") }),
    ASSENT_OFF,
  )
  fs.writeFileSync(file, "auto_apply: [this is: not: yaml\n  - broken")
  assert.deepEqual(loadAssentPolicy({ limitsFile: file }), ASSENT_OFF)
})

// --- required assertions (confirm-field) -----------------------------------------

const authQ = "Are you legally authorized to work in the United States?"
const confirmText = (req) => ({
  k: "f1",
  sel: "#auth",
  t: "text",
  l: authQ,
  ...(req ? { req: true } : {}),
})
const confirmed = (over = {}) => ({
  k: "f1",
  status: "CONFIRM",
  value: "Yes",
  sel: "#auth",
  source: "a-002@fuzzy",
  classDescription: "assertion (work authorisation)",
  ...over,
})

test("policy OFF: a required assertion still defers as confirm — nothing changed", () => {
  const p = plan([confirmText(true)], [confirmed()])
  assert.equal(p.items.length, 0)
  assert.equal(p.defer[0].why, "confirm")
  assert.equal(p.actuated.length, 0)
})

test("required_assertions: a REQUIRED assertion at status OK (fuzzy source) is filled and named in actuated with its grant", () => {
  const p = plan([confirmText(true)], [confirmed()], { assent: USER_POLICY })
  assert.equal(p.defer.length, 0)
  assert.equal(p.items.length, 1)
  assert.equal(p.items[0].how, "fill")
  assert.equal(p.items[0].value, "Yes")
  assert.equal(p.items[0].assent, true)
  assert.equal(p.items[0].grant, GRANTS.REQUIRED_ASSERTION)
  assert.deepEqual(
    p.actuated.map((a) => [a.k, a.grant, a.value]),
    [["f1", GRANTS.REQUIRED_ASSERTION, "Yes"]],
    "the act is on record",
  )
})

test("required_assertions on a required radio/checkbox GROUP ticks the banked pick, and records it", () => {
  const group = {
    k: "g1",
    t: "radio",
    l: authQ,
    req: true,
    o: [
      { k: "f2", sel: "#auth-yes", l: "Yes" },
      { k: "f3", sel: "#auth-no", l: "No" },
    ],
  }
  const p = plan(
    [group],
    [confirmed({ k: "g1", sel: undefined, pick: "f2", pickSel: "#auth-yes" })],
    { assent: USER_POLICY },
  )
  assert.equal(p.defer.length, 0)
  assert.equal(p.items[0].how, "check")
  assert.equal(p.items[0].sel, "#auth-yes")
  assert.equal(p.items[0].pick, "f2")
  assert.equal(p.actuated[0].grant, GRANTS.REQUIRED_ASSERTION)
})

test("an OPTIONAL assertion is left empty under optional=skip — a skip item, not a defer, and not an act", () => {
  const p = plan([confirmText(false)], [confirmed()], { assent: USER_POLICY })
  assert.equal(p.defer.length, 0)
  assert.equal(p.items.length, 1)
  assert.equal(p.items[0].how, "skip")
  assert.match(p.items[0].why, /optional assertion left empty/)
  assert.equal(p.actuated.length, 0, "leaving alone is not an act")
})

test("an OPTIONAL assertion still defers under optional=defer, even with required_assertions on", () => {
  const p = plan([confirmText(false)], [confirmed()], {
    assent: { ...USER_POLICY, optional: "defer" },
  })
  assert.equal(p.items.length, 0)
  assert.equal(p.defer[0].why, "confirm")
  assert.equal(p.defer[0].req, false)
})

test("a required assertion the engine cannot operate (f.widget) still defers under the policy — no recorded act that never happened", () => {
  const p = plan([{ ...confirmText(true), widget: "aria" }], [confirmed()], {
    assent: USER_POLICY,
  })
  assert.equal(p.items.length, 0)
  assert.equal(p.defer[0].why, "confirm")
})

test("required_assertions off, required_widgets on: an assertion is not a widget grant — it still defers", () => {
  const p = plan([confirmText(true)], [confirmed()], {
    assent: { ...ASSENT_OFF, required_widgets: true },
  })
  assert.equal(p.items.length, 0)
  assert.equal(p.defer[0].why, "confirm")
})

// --- required widgets (confirm-widget) -----------------------------------------

const eeo = (req) => ({
  k: "g1",
  t: "radio",
  l: "Race",
  ...(req ? { req: true } : {}),
  o: [
    { k: "f4", sel: "#race-1", l: "Asian" },
    { k: "f5", sel: "#race-9", l: "Decline to self-identify" },
  ],
})
const eeoOk = (source) => ({
  k: "g1",
  status: "OK",
  value: "Decline to self-identify",
  pick: "f5",
  pickSel: "#race-9",
  source,
})

test("policy OFF: a required widget from a FUZZY hit still defers as confirm-widget", () => {
  const p = plan([eeo(true)], [eeoOk("a-010@fuzzy")])
  assert.equal(p.items.length, 0)
  assert.equal(p.defer[0].why, "confirm-widget")
})

test("required_widgets: a REQUIRED group with an OK fuzzy pick is ticked and recorded with the widget grant", () => {
  const p = plan([eeo(true)], [eeoOk("a-010@fuzzy")], { assent: USER_POLICY })
  assert.equal(p.defer.length, 0)
  assert.equal(p.items[0].how, "check")
  assert.equal(p.items[0].pick, "f5")
  assert.equal(p.items[0].grant, GRANTS.REQUIRED_WIDGET)
  assert.equal(p.actuated[0].grant, GRANTS.REQUIRED_WIDGET)
})

test("required_widgets: an EXACT hit on a required group is a policy tick too — one grant per act", () => {
  const p = plan([eeo(true)], [eeoOk("a-010@exact")], { assent: USER_POLICY })
  assert.equal(p.items[0].grant, GRANTS.REQUIRED_WIDGET)
})

test("the 2026-08-03 exact-bank exemption is unchanged with the policy off: ticked, recorded, and carrying NO grant", () => {
  const p = plan([eeo(false)], [eeoOk("a-010@exact")])
  assert.equal(p.items[0].how, "check")
  assert.equal(p.items[0].grant, undefined)
  assert.equal(p.actuated[0].grant, undefined)
})

test("an OPTIONAL widget under optional=skip is left untouched — even from an exact hit ('otherwise leave them alone')", () => {
  const p = plan([eeo(false)], [eeoOk("a-010@exact")], { assent: USER_POLICY })
  assert.equal(p.items[0].how, "skip")
  assert.match(p.items[0].why, /optional assent widget left untouched/)
  assert.equal(p.actuated.length, 0)
  assert.equal(p.defer.length, 0)
})

test("a group the bank could not ground (NEEDS-CHOICE) still defers under the policy — nothing is resolved by a grant", () => {
  const p = plan(
    [eeo(true)],
    [
      {
        k: "g1",
        status: "NEEDS-CHOICE",
        value: "Prefer not to say",
        options: ["Asian", "Decline to self-identify"],
      },
    ],
    { assent: USER_POLICY },
  )
  assert.equal(p.items.filter((i) => i.how === "check").length, 0)
  assert.equal(p.defer.length, 1)
  assert.equal(p.actuated.length, 0)
})

// --- required consent (consent-tickbox) --------------------------------------------

const box = (label, over = {}) => ({
  k: "g1",
  t: "checkbox",
  l: label,
  o: [{ k: "f6", sel: "#agree", l: label }],
  ...over,
})
const CERTIFY =
  "I certify that the information provided in this application is true and complete."
const ARBITRATION =
  "I agree to resolve any dispute through binding arbitration and waive my right to a jury trial."

test("policy OFF: a required, vouched consent box still defers", () => {
  const p = plan([box(CERTIFY, { req: true })], [], {
    vouchedLabels: [CERTIFY],
  })
  assert.equal(p.items.length, 0)
  assert.equal(p.defer[0].why, "consent")
})

test("required_consent=non-legal: a REQUIRED, VOUCHED, non-legal box is ticked and named with the consent grant", () => {
  const p = plan([box(CERTIFY, { req: true })], [], {
    vouchedLabels: [CERTIFY],
    assent: USER_POLICY,
  })
  assert.equal(p.defer.length, 0)
  assert.equal(p.items[0].how, "check")
  assert.equal(p.items[0].value, true)
  assert.equal(p.items[0].sel, "#agree")
  assert.equal(p.items[0].grant, GRANTS.REQUIRED_CONSENT)
  assert.equal(p.actuated[0].grant, GRANTS.REQUIRED_CONSENT)
  assert.equal(p.actuated[0].legalWeight, undefined)
})

test("an UNVOUCHED required consent box still defers under the policy, and the defer says why", () => {
  // The MCP/CLI path: the scan crossed a process boundary, so nothing vouches.
  const p = plan([box(CERTIFY, { req: true })], [], { assent: USER_POLICY })
  assert.equal(p.items.length, 0)
  assert.equal(p.defer[0].why, "consent")
  assert.match(p.defer[0].note, /could not vouch/)
})

test("legal-weight consent (arbitration) stays the user's under non-legal — deferred, vouched or not, and the defer says so", () => {
  const p = plan([box(ARBITRATION, { req: true })], [], {
    vouchedLabels: [ARBITRATION],
    assent: USER_POLICY,
  })
  assert.equal(p.items.length, 0)
  assert.equal(p.defer[0].why, "consent")
  assert.match(p.defer[0].note, /legal-weight/)
})

test("required_consent=all admits a required, vouched legal-weight box — an explicit choice, flagged legalWeight on the record", () => {
  const p = plan([box(ARBITRATION, { req: true })], [], {
    vouchedLabels: [ARBITRATION],
    assent: { ...USER_POLICY, required_consent: "all" },
  })
  assert.equal(p.items[0].how, "check")
  assert.equal(p.items[0].legalWeight, true)
  assert.equal(p.actuated[0].legalWeight, true)
})

test("an OPTIONAL consent box is left unticked under optional=skip — a skip item, out of defer, no act", () => {
  const p = plan(
    [box("Subscribe me to job alerts and marketing emails from Acme.")],
    [],
    {
      vouchedLabels: [
        "Subscribe me to job alerts and marketing emails from Acme.",
      ],
      assent: USER_POLICY,
    },
  )
  assert.equal(p.defer.length, 0)
  assert.equal(p.items[0].how, "skip")
  assert.match(p.items[0].why, /consent: optional, left unticked/)
  assert.equal(p.actuated.length, 0)
})

test("an OPTIONAL consent box still defers under optional=defer", () => {
  const p = plan([box(CERTIFY)], [], {
    vouchedLabels: [CERTIFY],
    assent: { ...USER_POLICY, optional: "defer" },
  })
  assert.equal(p.items.length, 0)
  assert.equal(p.defer[0].why, "consent")
})

test("a consent-shaped RADIO GROUP with a banked OK pick under required_widgets is a widget the user answered — ticked, marked consentShaped", () => {
  const texts = {
    k: "g1",
    t: "radio",
    l: "Do you consent to receive text messages about your application?",
    req: true,
    o: [
      {
        k: "f7",
        sel: "#sms-yes",
        l: "Yes - I consent to receiving text messages",
      },
      { k: "f8", sel: "#sms-no", l: "No" },
    ],
  }
  const p = plan(
    [texts],
    [
      {
        k: "g1",
        status: "OK",
        value: "No",
        pick: "f8",
        pickSel: "#sms-no",
        source: "a-020@fuzzy",
      },
    ],
    { assent: USER_POLICY },
  )
  assert.equal(p.defer.length, 0)
  assert.equal(p.items[0].how, "check")
  assert.equal(p.items[0].pick, "f8")
  assert.equal(p.items[0].consentShaped, true)
  assert.equal(p.actuated[0].grant, GRANTS.REQUIRED_WIDGET)
  assert.equal(p.actuated[0].consentShaped, true)
})

test("a consent-shaped radio group with NO banked pick still defers under the policy — nobody picks for the user", () => {
  const texts = {
    k: "g1",
    t: "radio",
    l: "Do you consent to receive text messages about your application?",
    req: true,
    o: [
      {
        k: "f7",
        sel: "#sms-yes",
        l: "Yes - I consent to receiving text messages",
      },
      { k: "f8", sel: "#sms-no", l: "No" },
    ],
  }
  const p = plan([texts], [{ k: "g1", status: "UNKNOWN" }], {
    assent: USER_POLICY,
  })
  assert.equal(p.items.filter((i) => i.how === "check").length, 0)
  assert.equal(p.defer[0].why, "consent")
})

// --- submitReadiness: the second key ------------------------------------------------

test("submitReadiness admits a granted actuation ONLY under a policy that enables the grant", () => {
  const p = plan(
    [eeo(true), confirmText(true)],
    [eeoOk("a-010@fuzzy"), confirmed()],
    {
      assent: USER_POLICY,
    },
  )
  assert.equal(p.actuated.length, 2)
  assert.equal(
    readiness(p).ready,
    true,
    "the attended fast path is fine with it",
  )

  // No policy handed to the gate: refused, exactly as an ungranted tick is.
  const off = submitReadiness(p, null)
  assert.equal(off.ready, false)
  assert.match(off.reason, /ticked from banked answers/)
  assert.match(off.reason, /grant is present but the policy/)

  // The user's policy: admitted.
  const on = submitReadiness(p, null, { assent: USER_POLICY })
  assert.equal(on.ready, true, on.reason)

  // A stricter policy than the one the plan was built under: the widget grant
  // is admitted, the assertion grant is not, and the whole plan is refused.
  const stricter = submitReadiness(p, null, {
    assent: { ...USER_POLICY, required_assertions: false },
  })
  assert.equal(stricter.ready, false)
  assert.match(stricter.reason, /1 widget\(s\)/)
})

test("submitReadiness still refuses an UNGRANTED actuation under any policy — the exact-bank exemption is the user-directed path's rule", () => {
  const p = plan([eeo(false)], [eeoOk("a-010@exact")]) // policy off at build: exempt, no grant
  assert.equal(p.actuated[0].grant, undefined)
  const r = submitReadiness(p, null, { assent: USER_POLICY })
  assert.equal(r.ready, false)
  assert.match(r.reason, /ticked from banked answers/)
})

test("a plan with only skips left by the policy and one real fill is READY unattended", () => {
  const p = plan(
    [
      { k: "f0", sel: "#first", t: "text", l: "First name", req: true },
      confirmText(false),
      eeo(false),
    ],
    [
      { k: "f0", status: "OK", value: "X", sel: "#first" },
      confirmed(),
      eeoOk("a-010@exact"),
    ],
    { assent: USER_POLICY },
  )
  assert.equal(p.defer.length, 0)
  assert.equal(p.actuated.length, 0)
  assert.equal(submitReadiness(p, null, { assent: USER_POLICY }).ready, true)
})
