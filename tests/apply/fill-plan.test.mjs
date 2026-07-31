// The planner is where every decision is made, so this is where the safety
// properties have to hold: consent is never agreed to, unresolved fields are
// never guessed, and a question is never mistaken for a profile field.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import vm from "node:vm"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  buildPlan,
  isConsent,
  isHardConsent,
  loadConsentAllowlist,
  readiness,
  submitReadiness,
  resolveScanPath,
  combosNeedingProbe,
  fieldIdentityMismatch,
  buildDriverSource,
  buildBootstrap,
} from "../../scripts/apply/fill-plan.mjs"
import { engineSandboxSource } from "../../scripts/apply/browser.mjs"
import { detectAts, ADAPTERS } from "../../scripts/apply/ats/index.mjs"
import greenhouse from "../../scripts/apply/ats/greenhouse.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

const files = {
  resume: "C:\\jobs\\x\\resume.pdf",
  cover: "C:\\jobs\\x\\cover-letter.pdf",
}

const scanOf = (fields) => ({
  url: "https://job-boards.greenhouse.io/x/jobs/1",
  fields,
})
const ok = (k, value, over = {}) => ({
  k,
  status: "OK",
  value,
  sel: `#${k}`,
  ...over,
})

// --- detection ------------------------------------------------------------

test("detects the boards we adapt, by host", () => {
  assert.equal(
    detectAts("https://job-boards.greenhouse.io/coinbase/jobs/8070574").id,
    "greenhouse",
  )
  assert.equal(
    detectAts("https://boards.greenhouse.io/x/jobs/1").id,
    "greenhouse",
  )
  assert.equal(detectAts("https://jobs.lever.co/allegiantair/abc").id, "lever")
  assert.equal(detectAts("https://jobs.ashbyhq.com/vanta/abc").id, "ashby")
})

test("an unknown board falls back to generic rather than failing", () => {
  const a = detectAts("https://careers.somecompany.example/apply/123")
  assert.equal(a.id, "generic")
  assert.ok(a.comboStrategies.length > 0)
})

test("Workday is a hand-off, not an adapter", () => {
  const a = detectAts(
    "https://acme.wd1.myworkdayjobs.com/en-US/careers/job/123",
  )
  assert.equal(a.id, "workday")
  assert.equal(a.handoff, true)
  assert.match(a.reason, /account/i, "must say why a human has to take over")
  assert.ok(
    !ADAPTERS.some((x) => x.id === "workday"),
    "must not be registered as a fillable adapter",
  )
})

test("a lookalike hostname does not match", () => {
  // "notgreenhouse.io.evil.test" must not be treated as Greenhouse.
  assert.equal(
    detectAts("https://notgreenhouse.io.evil.test/apply").id,
    "generic",
  )
})

// --- readiness --------------------------------------------------------------
//
// The planner already counted the defers, so "does this still need a human?"
// is its answer to give. Emitting it as a boolean is what lets the caller go
// scan -> fill -> hand over without reading the plan and forming an opinion.

test("readiness is true only when nothing is deferred and something is fillable", () => {
  const state = readiness({
    items: [{ k: "f1", how: "fill", value: "Jane" }],
    defer: [],
  })
  assert.equal(state.ready, true)
  assert.equal(state.reason, null)
})

test("any non-consent deferred field makes the plan not ready, and says how many", () => {
  const state = readiness({
    items: [{ k: "f1", how: "fill", value: "Jane" }],
    defer: [{ k: "f2", label: "Desired salary", why: "unknown" }],
  })
  assert.equal(state.ready, false)
  assert.match(state.reason, /1 deferred/)
})

// --- readiness vs. submitReadiness: two different questions ----------------
//
// docs/autonomy-plan.md's Phase 2 table names this the highest-leverage fix
// in the plan: `isConsent` pushes almost every real ATS's "I agree to the
// Terms" box to `defer` before anything else runs, and the OLD readiness()
// counted that defer the same as any other unresolved field — so `ready=true`
// was unreachable on any form this pipeline has ever actually met, however
// completely the fact base answered everything else. A consent box is not
// the "the fact base failed" problem readiness() exists to flag; it is a
// decision only the user may make (hard rule 6), and ticking it in a browser
// they are ALREADY reviewing costs zero model turns — so it does not block
// `ready`. It still blocks `submitReadiness`, the stricter "nothing at all
// is left for a human" gate neither function uses to authorise a submit
// click by itself.
test("a consent-only defer does not block readiness", () => {
  const state = readiness({
    items: [{ k: "f1", how: "fill", value: "Jane" }],
    defer: [{ k: "f2", label: "I agree to the Terms", why: "consent" }],
  })
  assert.equal(state.ready, true)
  assert.equal(state.reason, null)
})

test("a consent-only defer still blocks submitReadiness", () => {
  const state = submitReadiness({
    items: [{ k: "f1", how: "fill", value: "Jane" }],
    defer: [{ k: "f2", label: "I agree to the Terms", why: "consent" }],
  })
  assert.equal(state.ready, false)
  assert.match(state.reason, /1 deferred/)
})

test("a mix of a consent defer and a real defer is not ready either way", () => {
  // Ready must count ONLY the non-consent defer; submitReady counts both, so
  // the two functions must not simply agree by coincidence on a plan with
  // just one kind of defer.
  const plan = {
    items: [{ k: "f1", how: "fill", value: "Jane" }],
    defer: [
      { k: "f2", label: "I agree to the Terms", why: "consent" },
      { k: "f3", label: "Desired salary", why: "unknown" },
    ],
  }
  assert.equal(readiness(plan).ready, false)
  assert.match(readiness(plan).reason, /1 deferred/, "consent must not count")
  assert.equal(submitReadiness(plan).ready, false)
  assert.match(submitReadiness(plan).reason, /2 deferred/)
})

test("a plan of nothing but skips is not ready", () => {
  // Every field optional-and-unresolved is a plan that would fill nothing;
  // reporting that as ready would send the engine at an empty form.
  const state = readiness({
    items: [
      { k: "f1", how: "skip", why: "optional and not in the fact base" },
      { k: "f2", how: "skip", why: "picker half of a composite widget" },
    ],
    defer: [],
  })
  assert.equal(state.ready, false)
  assert.equal(state.reason, "nothing to fill")
})

test("readiness survives a plan with no items or defer arrays at all", () => {
  assert.equal(readiness({}).ready, false)
})

test("a real built plan carries its readiness", () => {
  const notReady = buildPlan({
    scan: scanOf([
      { k: "f1", t: "text", l: "First Name", req: true },
      { k: "f2", t: "text", l: "Desired Salary", req: true },
    ]),
    resolved: [ok("f1", "Jane"), { k: "f2", status: "UNKNOWN", value: "" }],
    adapter: greenhouse,
    files,
  })
  assert.equal(readiness(notReady).ready, false, "an unresolved fact blocks it")

  const ready = buildPlan({
    scan: scanOf([{ k: "f1", t: "text", l: "First Name", req: true }]),
    resolved: [ok("f1", "Jane")],
    adapter: greenhouse,
    files,
  })
  assert.equal(readiness(ready).ready, true)

  // An unresolvable consent box, by itself, is a real defer (never silently
  // dropped or auto-filled) but no longer the kind that blocks `ready` — see
  // the readiness()-vs-submitReadiness() tests above for why.
  const readyDespiteConsent = buildPlan({
    scan: scanOf([
      { k: "f1", t: "text", l: "First Name", req: true },
      { k: "f2", t: "checkbox", l: "I agree to the Terms and Conditions" },
    ]),
    resolved: [ok("f1", "Jane")],
    adapter: greenhouse,
    files,
  })
  assert.equal(readyDespiteConsent.defer[0].why, "consent")
  assert.equal(readiness(readyDespiteConsent).ready, true)
  assert.equal(submitReadiness(readyDespiteConsent).ready, false)
})

// --- consent --------------------------------------------------------------

test("consent phrasing is recognised", () => {
  for (const label of [
    "Please confirm receipt of the above linked Global Data Privacy Notice and US Arbitration Agreement.",
    "I understand that Coinbase may use AI tools to assist in the application process.",
    "I agree to the Terms and Conditions",
    "Electronic signature",
    "Do you consent to a background check?",
  ]) {
    assert.ok(isConsent(label), label)
  }
})

test("work authorization is a fact, not a consent", () => {
  // Deferring genuine profile questions as "consent" would be just as wrong as
  // agreeing to things — it would bury them in the wrong bucket.
  assert.ok(
    !isConsent("Are you legally authorized to work in the United States?"),
  )
  assert.ok(
    !isConsent("Will you require sponsorship for employment visa status?"),
  )
})

test("a consent field is deferred even when the bank resolved it confidently", () => {
  const scan = scanOf([
    {
      k: "f1",
      t: "combo",
      l: "Please confirm receipt of the Arbitration Agreement",
      opts: ["Confirmed"],
    },
  ])
  const plan = buildPlan({
    scan,
    resolved: [ok("f1", "Confirmed")],
    adapter: greenhouse,
    files,
  })
  assert.equal(
    plan.items.length,
    0,
    "an agreement must never become a plan item",
  )
  assert.equal(plan.defer[0].why, "consent")
})

// --- consent allowlist + vouch: the readiness fast path ---------------------
//
// readiness() was unreachable on any real form: `isConsent` pushes every
// agreement to `defer` before anything else runs, and nearly every ATS has at
// least one ("I agree to the Terms and Conditions"). pending-questions.mjs
// already excluded consent from its own "worth asking about" set — these
// tests pin the actual fix: an exact, user-approved label THAT OUR OWN
// SCANNER ALSO VOUCHES FOR moves a checkbox from `defer` into `items` as a
// `check`. `readiness()`'s own fix (a consent-only defer does not block
// `ready`) is what makes ready=true reachable EVEN WITHOUT a tick — see the
// "readiness vs. submitReadiness" block above; the tests below are about the
// narrower, riskier question of when a box may be auto-CHECKED at all.
//
// `vouchedLabels` is the scanner's own in-process assertion (an array of
// complete visible label strings, built by scan-engine.mjs's scanPage() —
// see fill-plan.mjs's own consent-branch comment for the full four-hole
// history of why this is an ARGUMENT and not a field read off the scan
// object). `checkboxConsent` builds an ordinary scan field with no
// labelExact at all — buildPlan ignores that field unconditionally now, so
// setting it here would test nothing; a test that wants the "vouched" case
// passes `vouchedLabels` explicitly, which is what actually exercises the
// real mechanism.
const checkboxConsent = (label, optCount = 1) => ({
  k: "g1",
  t: "checkbox",
  l: label,
  o: Array.from({ length: optCount }, (_, i) => ({
    k: `f${i}`,
    l: label,
    sel: `#c${i}`,
  })),
})

test("an allowlisted, scanner-vouched consent checkbox is auto-checked", () => {
  const label = "I agree to the Terms and Conditions"
  const scan = scanOf([checkboxConsent(label)])
  const plan = buildPlan({
    scan,
    resolved: [],
    adapter: greenhouse,
    files,
    consentAllowlist: new Set([label.toLowerCase()]),
    vouchedLabels: [label],
  })
  assert.equal(plan.defer.length, 0)
  assert.equal(plan.items.length, 1)
  assert.equal(plan.items[0].how, "check")
  assert.equal(plan.items[0].k, "f0", "targets the checkbox's own stamped key")
  assert.equal(plan.items[0].sel, "#c0")
  assert.equal(plan.items[0].why, "consent:allowlisted")
})

test("an allowlisted consent box defers when the scanner does not vouch for it", () => {
  // No vouchedLabels passed at all — the honest state on every path that
  // exists today (the CLI reads a scan already written to disk, downstream
  // of the process boundary the vouch cannot cross). Three exploits used to
  // turn on exactly this gap when the vouch was a boolean INSIDE the scan
  // instead of an argument: an aria-label saying "I certify the information
  // is true" over a visible "I agree to binding arbitration"; a 131-char
  // certification and an arbitration-appended variant that truncated to the
  // same 120 chars; and a hand-built scan asserting labelExact:true with no
  // scanner behind it at all (tests/security/rce-round-trip.test.mjs).
  const label = "I agree to the Terms and Conditions"
  const scan = scanOf([checkboxConsent(label)])
  const plan = buildPlan({
    scan,
    resolved: [],
    adapter: greenhouse,
    files,
    consentAllowlist: new Set([label.toLowerCase()]),
  })
  assert.equal(plan.items.length, 0, "an unvouched label must never tick")
  assert.equal(plan.defer.length, 1)
  assert.equal(plan.defer[0].why, "consent")
})

test("a page-set labelExact on the scan is not a vouch — buildPlan never reads it", () => {
  // The exact scenario innov-resilience demonstrated against a real
  // buildPlan(): a scan object (however produced — a bug, a hand-authored
  // fixture, a future producer nobody has audited yet) carrying
  // `labelExact: true` must carry NO weight at all. Only the `vouchedLabels`
  // argument does.
  const label = "I agree to the Terms and Conditions"
  const scan = scanOf([{ ...checkboxConsent(label), labelExact: true }])
  const plan = buildPlan({
    scan,
    resolved: [],
    adapter: greenhouse,
    files,
    consentAllowlist: new Set([label.toLowerCase()]),
    // still no vouchedLabels
  })
  assert.equal(plan.items.length, 0, "a flag inside the scan is not a boundary")
  assert.equal(plan.defer[0].why, "consent")
})

test("readiness is reachable whether or not the consent box could be ticked", () => {
  const label = "I agree to the Terms and Conditions"
  const scan = scanOf([
    { k: "f1", t: "text", l: "First Name", req: true },
    checkboxConsent(label),
  ])
  const vouchedAndAllowed = buildPlan({
    scan,
    resolved: [ok("f1", "Jane")],
    adapter: greenhouse,
    files,
    consentAllowlist: new Set([label.toLowerCase()]),
    vouchedLabels: [label],
  })
  assert.equal(
    vouchedAndAllowed.items.some((i) => i.how === "check"),
    true,
  )
  assert.equal(readiness(vouchedAndAllowed).ready, true)

  const unvouched = buildPlan({
    scan,
    resolved: [ok("f1", "Jane")],
    adapter: greenhouse,
    files,
    consentAllowlist: new Set([label.toLowerCase()]),
    // no vouchedLabels — the box defers instead of ticking...
  })
  assert.equal(unvouched.defer[0].why, "consent")
  // ...but readiness is reached anyway: the box is still there for the user
  // to tick in the browser they are reviewing, which costs no model turn.
  assert.equal(readiness(unvouched).ready, true)
  assert.equal(submitReadiness(unvouched).ready, false)
})

test("without the allowlist entry, the same box still never ticks (but no longer blocks readiness)", () => {
  const label = "I agree to the Terms and Conditions"
  const scan = scanOf([
    { k: "f1", t: "text", l: "First Name", req: true },
    checkboxConsent(label),
  ])
  const plan = buildPlan({
    scan,
    resolved: [ok("f1", "Jane")],
    adapter: greenhouse,
    files,
    vouchedLabels: [label],
    // no consentAllowlist passed at all — must match the pre-existing default
  })
  assert.equal(
    plan.items.some((i) => i.how === "check"),
    false,
  )
  assert.equal(plan.defer[0].why, "consent")
  assert.equal(readiness(plan).ready, true, "consent no longer blocks ready")
  assert.equal(submitReadiness(plan).ready, false, "but submit is stricter")
})

test("arbitration is excluded regardless of the allowlist, EVEN when vouched", () => {
  const label = "I agree to resolve disputes through binding arbitration"
  const scan = scanOf([checkboxConsent(label)])
  const plan = buildPlan({
    scan,
    resolved: [],
    adapter: greenhouse,
    files,
    consentAllowlist: new Set([label.toLowerCase()]),
    vouchedLabels: [label],
  })
  assert.equal(plan.items.length, 0, "arbitration must never auto-check")
  assert.equal(plan.defer[0].why, "consent")
})

test("background checks and e-signatures are excluded regardless of the allowlist, EVEN when vouched", () => {
  for (const label of [
    "I authorize a background check as part of this application",
    "By checking this box you provide your electronic signature",
  ]) {
    const scan = scanOf([checkboxConsent(label)])
    const plan = buildPlan({
      scan,
      resolved: [],
      adapter: greenhouse,
      files,
      consentAllowlist: new Set([label.toLowerCase()]),
      vouchedLabels: [label],
    })
    assert.equal(plan.items.length, 0, label)
    assert.equal(plan.defer[0].why, "consent", label)
  }
})

test("isHardConsent identifies exactly the legally-weighted categories", () => {
  assert.ok(isHardConsent("I agree to binding arbitration"))
  assert.ok(isHardConsent("Consent to a background check"))
  assert.ok(isHardConsent("Electronic signature required"))
  assert.ok(
    !isHardConsent("I agree to the Terms and Conditions"),
    "a routine agreement is not legally weighted the same way",
  )
})

// --- FINDING (w3-resolution + innov-resilience, hostile-forms.test.mjs:419):
// a topic pattern list cannot be the load-bearing control — the 26th
// rewording is free. looksLikeAgreementProse() is the structural, topic-
// agnostic door into the SAME protected branch: a long single tickbox ending
// like a sentence, whether or not any word on the pattern list appears in it.
// These pin the mechanism directly, with a label engineered to defeat every
// CONSENT_PATTERNS entry on purpose (no "agree/accept/consent/certify/...",
// no "arbitration", no "background check", no "signature").

test("a wording that defeats every topic pattern still defers as consent, never auto-checks via the ordinary path", () => {
  const label =
    "By checking this box you grant the reviewing party unlimited rights to use, retain, and share every fact stated above with any third party they select."
  assert.equal(
    isConsent(label),
    false,
    "the label must defeat the topic list for this test to mean anything",
  )
  const scan = scanOf([checkboxConsent(label)])
  const plan = buildPlan({
    scan,
    // A bank hit exists for the EXACT label text (as a saved literal answer
    // would), so the ordinary checkbox path COULD auto-check it if nothing
    // routed this into the protected branch.
    resolved: [
      { k: "g1", status: "OK", value: label, pick: "f0", pickSel: "#c0" },
    ],
    adapter: greenhouse,
    files,
    // No allowlist, no vouch — the honest default state.
  })
  assert.equal(
    plan.items.some((i) => i.how === "check"),
    false,
    "a topic-pattern-defeating agreement must never silently auto-check",
  )
  assert.equal(plan.defer[0]?.why, "consent")
})

test("the same defeating wording DOES auto-tick once vouched and allowlisted — the door works both ways", () => {
  const label =
    "By checking this box you grant the reviewing party unlimited rights to use, retain, and share every fact stated above with any third party they select."
  const scan = scanOf([checkboxConsent(label)])
  const plan = buildPlan({
    scan,
    resolved: [],
    adapter: greenhouse,
    files,
    consentAllowlist: new Set([label.toLowerCase()]),
    vouchedLabels: [label],
  })
  assert.equal(plan.items.length, 1)
  assert.equal(plan.items[0].how, "check")
  assert.equal(plan.items[0].why, "consent:allowlisted")
})

test("looksLikeAgreementProse ignores short, ordinary checkboxes — 'Current role' stays on the normal path", () => {
  const scan = scanOf([
    {
      k: "g1",
      t: "checkbox",
      l: "Current role",
      o: [{ k: "f9", l: "Current role", sel: "#cr" }],
    },
  ])
  const plan = buildPlan({
    scan,
    resolved: [
      {
        k: "g1",
        status: "OK",
        value: "Current role",
        pick: "f9",
        pickSel: "#cr",
      },
    ],
    adapter: greenhouse,
    files,
  })
  assert.equal(
    plan.items[0].how,
    "check",
    "a short factual toggle must not be swept into consent",
  )
  assert.equal(plan.defer.length, 0)
})

test("looksLikeAgreementProse requires BOTH length and sentence shape — a long question is not consent-shaped", () => {
  // Ends in "?", not "." or "!" — a factual question, not a clause an
  // agreement is stating. Length alone must not be sufficient.
  const scan = scanOf([
    {
      k: "g1",
      t: "checkbox",
      l: "Are you legally authorized to work in the United States of America right now?",
      o: [{ k: "f9", l: "authorized", sel: "#auth" }],
    },
  ])
  const plan = buildPlan({
    scan,
    resolved: [
      { k: "g1", status: "OK", value: "Yes", pick: "f9", pickSel: "#auth" },
    ],
    adapter: greenhouse,
    files,
  })
  assert.equal(
    plan.items[0].how,
    "check",
    "a factual question must not be swept into consent by length alone",
  )
  assert.equal(plan.defer.length, 0)
})

test("the allowlist match is exact text, never a pattern — even when vouched", () => {
  const trueLabel = "I agree to the Updated Terms and Conditions"
  const scan = scanOf([checkboxConsent(trueLabel)])
  const plan = buildPlan({
    scan,
    resolved: [],
    adapter: greenhouse,
    files,
    // Approved a DIFFERENT (superficially similar) wording only.
    consentAllowlist: new Set(["i agree to the terms and conditions"]),
    // The scanner vouches for the TRUE text, which only proves the vouch and
    // the allowlist are two independent checks, neither of which alone is
    // enough.
    vouchedLabels: [trueLabel],
  })
  assert.equal(plan.items.length, 0, "a near-miss label must still defer")
  assert.equal(plan.defer[0].why, "consent")
})

test("a combo/select-shaped consent field is never auto-checked", () => {
  // There is no clean single "check" action for a dropdown — see the
  // existing "confirm receipt" combo test above, unaffected by the allowlist.
  const label = "Please confirm receipt of the Company Handbook"
  const scan = scanOf([{ k: "f1", t: "combo", l: label, opts: ["Confirmed"] }])
  const plan = buildPlan({
    scan,
    resolved: [ok("f1", "Confirmed")],
    adapter: greenhouse,
    files,
    consentAllowlist: new Set([label.toLowerCase()]),
    vouchedLabels: [label],
  })
  assert.equal(plan.items.length, 0)
  assert.equal(plan.defer[0].why, "consent")
})

test("a checkbox group with more than one option is never auto-checked", () => {
  // Ambiguous which box the user meant to pre-approve — never guess.
  const label = "I agree to the following"
  const scan = scanOf([checkboxConsent(label, 2)])
  const plan = buildPlan({
    scan,
    resolved: [],
    adapter: greenhouse,
    files,
    consentAllowlist: new Set([label.toLowerCase()]),
    vouchedLabels: [label],
  })
  assert.equal(plan.items.length, 0)
  assert.equal(plan.defer[0].why, "consent")
})

test("loadConsentAllowlist reads a JSON array of exact labels, normalized", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "consent-allowlist-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, "allowlist.json")
  fs.writeFileSync(
    file,
    JSON.stringify(["  I Agree to the Terms and Conditions  *"]),
  )
  const set = loadConsentAllowlist(file)
  assert.ok(set.has("i agree to the terms and conditions"))
})

test("loadConsentAllowlist tolerates a missing or corrupt file", () => {
  assert.equal(loadConsentAllowlist(null).size, 0)
  assert.equal(loadConsentAllowlist("/no/such/file.json").size, 0)
})

// --- a label that lies about the field it wraps -----------------------------
//
// FINDING (qa-adversary, tests/fixtures/hostile/forms/mislabelled-inputs.html):
// every resolution in this pipeline is keyed on the LABEL, and the label is
// whatever the page says — <label for="m-phone">Phone number</label> wrapping
// <input name="ssn"> plans the user's real phone number into a field named
// "ssn", and the approval message shows "Phone number", so the substitution
// is invisible in review. fieldIdentityMismatch() is the guard: it checks the
// ELEMENT's own exposed identity (scan-page.js's `sel`) against the category
// the LABEL claims, using only real, always-present scan data — never a
// fixture-only property.

test("fieldIdentityMismatch: a name-attribute selector that contradicts the label is caught", () => {
  assert.match(
    fieldIdentityMismatch({
      k: "f1",
      l: "Phone number",
      sel: 'input[name="ssn"]',
    }),
    /"phone".*"ssn"/,
  )
  assert.match(
    fieldIdentityMismatch({
      k: "f2",
      l: "Preferred start date",
      sel: 'input[name="salary_floor"]',
    }),
    /"date".*"salary"/,
  )
})

test("fieldIdentityMismatch: an id selector consistent with the label is silent", () => {
  assert.equal(
    fieldIdentityMismatch({ k: "f1", l: "Email", sel: "#email-field" }),
    "",
  )
  // No category on either side: not evidence of anything, in either
  // direction — must never manufacture a mismatch out of an opaque id.
  assert.equal(
    fieldIdentityMismatch({ k: "f1", l: "Twitter handle", sel: "#q_182818" }),
    "",
  )
})

test("fieldIdentityMismatch: a checkbox/radio group is checked on its OPTION's selector", () => {
  // Groups have no `sel` of their own (buildPlan's own "groups have no
  // element of their own" comment) — the identity lives on `o[].sel`.
  assert.match(
    fieldIdentityMismatch({
      k: "g1",
      l: "Email address",
      o: [{ k: "f3", sel: 'input[name="agree_arbitration"]' }],
    }),
    /"email".*"arbitration"/,
  )
  // The mislabelled-inputs.html fixture's own g1 ("Are you legally
  // authorized to work in the United States?", wired to
  // name="agree_arbitration") is the harder, documented limit: the label
  // names no category this list tracks, so there is nothing to contradict —
  // this function is a floor, not a ceiling (see its own doc comment).
  assert.equal(
    fieldIdentityMismatch({
      k: "g1",
      l: "Are you legally authorized to work in the United States?",
      o: [{ k: "f3", sel: "#m-authorized" }],
    }),
    "",
  )
})

// --- identityStatements: `n` (the real name attribute) outranks `sel` ------
//
// w2-engine landed `n` (verbatim scan-page.js `name`) because `sel` alone is
// unreachable on the shape it was written for: stableSel() tries `#id`
// FIRST, so a page whose inputs all carry ids never exposes `name` through
// `sel` at all, and a hostile board can choose an id that agrees with the
// lying label while the name attribute still disagrees.

test("fieldIdentityMismatch: a name attribute that contradicts the label is caught even with no `sel` at all", () => {
  assert.match(
    fieldIdentityMismatch({ k: "f1", l: "Phone number", n: "ssn" }),
    /"phone".*its name attribute.*"ssn"/,
  )
})

test("fieldIdentityMismatch: an id chosen to agree with the label cannot hide a disagreeing name attribute", () => {
  // The exact shape w2-engine measured: a page whose id READS as the label's
  // own category (so the old `sel`-only guard saw no disagreement) but whose
  // `name` still says otherwise.
  const why = fieldIdentityMismatch({
    k: "f1",
    l: "Phone number",
    sel: "#phone-field",
    n: "ssn",
  })
  assert.match(why, /"phone".*its name attribute.*"ssn"/)
})

test("fieldIdentityMismatch: falls back to the selector when there is no name attribute to read", () => {
  const why = fieldIdentityMismatch({
    k: "f1",
    l: "Phone number",
    sel: 'input[name="ssn"]',
  })
  assert.match(why, /"phone".*its selector.*"ssn"/)
})

test("fieldIdentityMismatch: a name attribute that agrees with the label does not suppress a disagreeing selector", () => {
  // f4 in mislabelled-inputs.html: name="emergency_contact_phone" (agrees
  // with the "phone" category the label claims) but id="m-email" (reads as
  // "email"). The first statement agreeing must not short-circuit the loop.
  const why = fieldIdentityMismatch({
    k: "f4",
    l: "Emergency contact phone",
    sel: "#m-email",
    n: "emergency_contact_phone",
  })
  assert.match(why, /"phone".*its selector.*"email"/)
})

test("fieldIdentityMismatch: a checkbox/radio group reads its option's name attribute too", () => {
  assert.match(
    fieldIdentityMismatch({
      k: "g1",
      l: "Email address",
      o: [{ k: "f3", n: "agree_arbitration" }],
    }),
    /"email".*its name attribute.*"arbitration"/,
  )
})

test("fieldIdentityMismatch: renaming both id and name to agree with the label defeats the guard (the documented limit)", () => {
  // Pinning the LIMIT, not the capability — see fieldIdentityMismatch's own
  // "WHAT THIS IS WORTH" comment. Every token here is page-chosen.
  assert.equal(
    fieldIdentityMismatch({
      k: "f1",
      l: "Phone number",
      sel: "#phone-field",
      n: "phone_field",
    }),
    "",
  )
})

// --- t/ac are deliberately never read -------------------------------------

test("fieldIdentityMismatch: an autocomplete value alone (no name, no selector identity) is never treated as evidence", () => {
  assert.equal(
    fieldIdentityMismatch({ k: "f1", l: "Phone number", ac: "ssn" }),
    "",
  )
})

test("fieldIdentityMismatch: a type attribute alone is never treated as evidence", () => {
  assert.equal(
    fieldIdentityMismatch({ k: "f1", l: "Phone number", t: "ssn" }),
    "",
  )
})

// --- f.n rides on the plan record beside the label -------------------------
//
// innov-resilience's point: every token fieldIdentityMismatch reads is
// chosen by the page, so a substitution that renames both id and name to
// agree with the label defeats DETECTION in one line. Showing the real
// target name beside the label makes the substitution non-silent even when
// undetected — that is the half which survives the rename.

test("an item/defer record carries the field's real name attribute beside the label", () => {
  const scan = scanOf([
    { k: "f1", t: "text", l: "Phone number", n: "phone_field", req: true },
  ])
  const plan = buildPlan({
    scan,
    resolved: [ok("f1", "(702) 810-4950")],
    adapter: greenhouse,
    files,
  })
  assert.equal(plan.items.length, 1)
  assert.equal(plan.items[0].n, "phone_field")
})

test("a deferred field's record also carries the real name attribute", () => {
  const scan = scanOf([
    { k: "f1", t: "text", l: "Twitter handle", n: "twitter", req: true },
  ])
  const plan = buildPlan({
    scan,
    resolved: [],
    adapter: greenhouse,
    files,
  })
  assert.equal(plan.defer.length, 1)
  assert.equal(plan.defer[0].n, "twitter")
})

test("a field with no name attribute carries no `n` on its record at all", () => {
  const scan = scanOf([
    { k: "f1", t: "text", l: "Twitter handle", sel: "#tw", req: true },
  ])
  const plan = buildPlan({
    scan,
    resolved: [],
    adapter: greenhouse,
    files,
  })
  assert.equal("n" in plan.defer[0], false)
})

test("a checkbox group's record carries its option's name attribute, not the group's own (which does not exist)", () => {
  const scan = scanOf([
    {
      k: "g1",
      t: "checkbox",
      l: "Are you legally authorized to work in the United States?",
      req: true,
      o: [{ k: "f3", n: "agree_arbitration" }],
    },
  ])
  const plan = buildPlan({
    scan,
    resolved: [],
    adapter: greenhouse,
    files,
  })
  assert.equal(plan.defer.length, 1)
  assert.equal(plan.defer[0].n, "agree_arbitration")
})

test("a field whose identity contradicts its label always defers, never fills — required or not", () => {
  const scan = scanOf([
    { k: "f1", t: "text", l: "Phone number", sel: 'input[name="ssn"]' },
    {
      k: "f2",
      t: "text",
      l: "Preferred start date",
      sel: 'input[name="salary_floor"]',
      req: true,
    },
  ])
  const plan = buildPlan({
    scan,
    resolved: [ok("f1", "(702) 810-4950"), ok("f2", "2026-08-01")],
    adapter: greenhouse,
    files,
  })
  assert.equal(plan.items.length, 0, "neither must be planned as a fill")
  assert.deepEqual(
    plan.defer.map((d) => d.k),
    ["f1", "f2"],
    "both must be visible to the user, required or not",
  )
  for (const d of plan.defer) assert.match(d.why, /label.*identity/)
})

test("an honest form with matching labels and selectors is unaffected", () => {
  const scan = scanOf([
    { k: "f1", t: "email", l: "Email", sel: 'input[name="email"]' },
    { k: "f2", t: "tel", l: "Phone", sel: 'input[name="phone"]', req: true },
  ])
  const plan = buildPlan({
    scan,
    resolved: [ok("f1", "jane@test.example"), ok("f2", "(702) 810-4950")],
    adapter: greenhouse,
    files,
  })
  assert.equal(plan.defer.length, 0)
  assert.equal(plan.items.length, 2)
})

// --- the label shown to the user vs. the label matched on -------------------
//
// FINDING (qa-adversary, "the label the plan shows the user is not the label
// on the page"): an input can carry BOTH a visible <label for>Email</label>
// AND aria-label="Emergency contact phone"; labelOf() reads the attribute
// first, so the OLD single `label` put "Emergency contact phone" in the
// approval message for a field the page shows as "Email". scan-page.js
// reports this divergence as `lSeen` — the REAL, documented field (never the
// qa-adversary fixture's own `_visible_label` convenience property, which
// this file does not and must not read).

test("item.label shows the PAGE's visible text (lSeen) when it disagrees with the matched label", () => {
  const scan = scanOf([
    {
      k: "f1",
      t: "email",
      l: "Emergency contact phone",
      lSeen: "Email",
      sel: 'input[name="emergency_contact_phone"]',
    },
  ])
  const plan = buildPlan({
    scan,
    resolved: [ok("f1", "jane@test.example")],
    adapter: greenhouse,
    files,
  })
  assert.equal(plan.items[0].label, "Email", "shows what the page shows")
  assert.equal(
    plan.items[0].matchedLabel,
    "Emergency contact phone",
    "the matched string rides along, never lost",
  )
})

test("item.label carries no matchedLabel at all when there is nothing to disagree with", () => {
  const scan = scanOf([{ k: "f1", t: "text", l: "First Name" }])
  const plan = buildPlan({
    scan,
    resolved: [ok("f1", "Jane")],
    adapter: greenhouse,
    files,
  })
  assert.equal(plan.items[0].label, "First Name")
  assert.equal(
    "matchedLabel" in plan.items[0],
    false,
    "absent rather than redundant, so JSON.stringify drops it",
  )
})

// --- lNone: no readable label exists on the control at all ------------------
//
// The residual w2-engine flagged rather than acting on unilaterally: lSeen
// covers "the page shows DIFFERENT text than what matched" but has nothing to
// report when the page shows NO text at all (an input with only an
// aria-label, no visible <label>). Requested by w3-resolution; consumed here
// so it is not dead code the moment the producer side lands.

test("f.lNone: the approval message says plainly that no visible label exists, instead of showing attribute text as if it were on screen", () => {
  const scan = scanOf([
    { k: "f1", t: "text", l: "Referral source code", lNone: true },
  ])
  const plan = buildPlan({
    scan,
    resolved: [ok("f1", "abc123")],
    adapter: greenhouse,
    files,
  })
  assert.match(plan.items[0].label, /no visible label/i)
  assert.doesNotMatch(
    plan.items[0].label,
    /^Referral source code$/,
    "the attribute string must not be presented as page text",
  )
  assert.equal(plan.items[0].matchedLabel, "Referral source code")
  assert.equal(plan.items[0].noVisibleLabel, true)
})

test("f.lNone is ignored once lSeen supplies a real visible alternative", () => {
  const scan = scanOf([
    {
      k: "f1",
      t: "text",
      l: "Emergency contact phone",
      lSeen: "Email",
      lNone: true, // producer bug or stale flag; lSeen must win regardless
    },
  ])
  const plan = buildPlan({
    scan,
    resolved: [ok("f1", "jane@test.example")],
    adapter: greenhouse,
    files,
  })
  assert.equal(plan.items[0].label, "Email")
  assert.equal("noVisibleLabel" in plan.items[0], false)
})

test("f.lNone false or absent changes nothing", () => {
  const scan = scanOf([{ k: "f1", t: "text", l: "First Name", lNone: false }])
  const plan = buildPlan({
    scan,
    resolved: [ok("f1", "Jane")],
    adapter: greenhouse,
    files,
  })
  assert.equal(plan.items[0].label, "First Name")
  assert.equal("noVisibleLabel" in plan.items[0], false)
})

test("a deferred field also shows the visible label, not the matched one", () => {
  const scan = scanOf([
    {
      k: "f1",
      t: "text",
      l: "matched-only text",
      lSeen: "Twitter Handle",
      req: true,
    },
  ])
  const plan = buildPlan({
    scan,
    resolved: [{ k: "f1", status: "UNKNOWN", value: "" }],
    adapter: greenhouse,
    files,
  })
  assert.equal(plan.defer[0].label, "Twitter Handle")
  assert.equal(plan.defer[0].matchedLabel, "matched-only text")
})

test("routing (which bank rule fires) still uses the matched label, not the visible one", () => {
  // scan-page.js's own reasoning for never repointing `l`: routing must not
  // grow a new cost on a real board just because a DIFFERENT field's display
  // string changed. A file-slot field whose lSeen looks like "Attach" but
  // whose matched label says "Resume/CV" must still route on "Resume/CV".
  const scan = scanOf([
    { k: "f1", t: "file", l: "Resume/CV", lSeen: "Attach" },
    { k: "f2", t: "file", l: "Attach", lSeen: "Cover Letter Upload" },
  ])
  const plan = buildPlan({ scan, resolved: [], adapter: greenhouse, files })
  assert.deepEqual(
    plan.items.map((i) => i.paths[0]),
    [files.resume, files.cover],
    "routing followed the MATCHED text, ignoring the display-only lSeen",
  )
})

test("a question about the name is not answered with the name", async () => {
  // Caught live on Affirm: "Name Pronunciation" was filled with "Xavier
  // Alvarez", which is not an answer to what was asked.
  const { resolveFields } = await import("../../scripts/apply/fill-plan.mjs")
  const rows = resolveFields(
    [
      { k: "f1", t: "text", l: "Name Pronunciation" },
      { k: "f2", t: "text", l: "Preferred Name" },
    ],
    {
      profile: "tests/fixtures/profile.yaml",
      answers: "tests/fixtures/answers-bank.yaml",
    },
  )
  const byKey = Object.fromEntries(rows.map((r) => [r.k, r]))
  assert.notEqual(byKey.f1.status, "OK", "pronunciation is not the name")
  assert.equal(byKey.f2.status, "OK", "but a preferred name still resolves")
})

// --- resolution -> verbs --------------------------------------------------

test("field types map to the right verb", () => {
  const scan = scanOf([
    { k: "f1", t: "text", l: "First Name" },
    { k: "f2", t: "select", l: "Country" },
    { k: "f3", t: "combo", l: "School" },
    { k: "f4", t: "textarea", l: "Why us" },
  ])
  const plan = buildPlan({
    scan,
    resolved: [
      ok("f1", "Xavier"),
      ok("f2", "USA"),
      ok("f3", "UNLV"),
      ok("f4", "text"),
    ],
    adapter: greenhouse,
    files,
  })
  assert.deepEqual(
    plan.items.map((i) => i.how),
    ["fill", "select", "combo", "fill"],
  )
})

test("checkbox groups target the option element, not the group", () => {
  const scan = scanOf([
    {
      k: "g1",
      t: "checkbox",
      l: "Current role",
      o: [{ k: "f9", l: "Current role", sel: "#cr" }],
    },
  ])
  const plan = buildPlan({
    scan,
    resolved: [
      {
        k: "g1",
        status: "OK",
        value: "Current role",
        pick: "f9",
        pickSel: "#cr",
      },
    ],
    adapter: greenhouse,
    files,
  })
  assert.equal(plan.items[0].k, "f9", "a group has no element of its own")
  assert.equal(plan.items[0].sel, "#cr")
  assert.equal(plan.items[0].how, "check")
})

test("unresolved REQUIRED fields are deferred, never guessed", () => {
  const scan = scanOf([
    { k: "f1", t: "text", l: "A", req: true },
    { k: "f2", t: "text", l: "B", req: true },
    { k: "f3", t: "combo", l: "C", req: true, opts: ["x", "y"] },
    { k: "f4", t: "text", l: "D", req: true },
  ])
  const plan = buildPlan({
    scan,
    resolved: [
      { k: "f1", status: "UNKNOWN", value: "" },
      { k: "f2", status: "MAYBE", value: "maybe-ish" },
      { k: "f3", status: "NEEDS-CHOICE", value: "z" },
      { k: "f4", status: "OK", value: "" },
    ],
    adapter: greenhouse,
    files,
  })
  assert.equal(plan.items.length, 0)
  assert.equal(plan.defer.length, 4)
  assert.deepEqual(plan.defer.find((d) => d.k === "f3").options, ["x", "y"])
})

test("a truncated option list is flagged on the defer entry, not presented as complete", () => {
  // field-cache.mjs sets optsTruncated when a list may be incomplete (AUDIT
  // H3). buildPlan must carry that flag through to the human-facing defer
  // entry rather than silently dropping it.
  const scan = scanOf([
    {
      k: "f1",
      t: "combo",
      l: "Country",
      req: true,
      opts: ["Andorra", "Belgium"],
      optsTruncated: true,
    },
  ])
  const plan = buildPlan({
    scan,
    resolved: [{ k: "f1", status: "NEEDS-CHOICE", value: "" }],
    adapter: greenhouse,
    files,
  })
  assert.equal(plan.defer[0].optsTruncated, true)
})

test("an untruncated option list carries no truncation flag at all", () => {
  const scan = scanOf([
    { k: "f1", t: "combo", l: "Country", req: true, opts: ["Andorra"] },
  ])
  const plan = buildPlan({
    scan,
    resolved: [{ k: "f1", status: "NEEDS-CHOICE", value: "" }],
    adapter: greenhouse,
    files,
  })
  assert.equal(plan.defer[0].optsTruncated, undefined)
})

test("unresolved OPTIONAL fields are left blank, not turned into questions", () => {
  // Asking for a Twitter handle the user does not have is noise, and noise is
  // what makes an approval message get skimmed. Still visible as a skip item.
  const scan = scanOf([
    { k: "f1", t: "text", l: "Twitter" },
    { k: "f2", t: "textarea", l: "Other Links" },
    { k: "f3", t: "text", l: "Preferred Name", req: true },
  ])
  const plan = buildPlan({
    scan,
    resolved: [
      { k: "f1", status: "UNKNOWN", value: "" },
      { k: "f2", status: "UNKNOWN", value: "" },
      { k: "f3", status: "UNKNOWN", value: "" },
    ],
    adapter: greenhouse,
    files,
  })
  assert.deepEqual(
    plan.defer.map((d) => d.k),
    ["f3"],
    "only the required field is worth the user's attention",
  )
  const skipped = plan.items.filter((i) => i.how === "skip")
  assert.deepEqual(
    skipped.map((i) => i.k),
    ["f1", "f2"],
  )
  assert.match(skipped[0].why, /optional/)
})

// --- attachments ----------------------------------------------------------

test("attachments fall back to document order when labels say only 'Attach'", () => {
  // Exactly what Greenhouse does: the real heading sits outside the element.
  const scan = scanOf([
    { k: "f1", t: "file", l: "Attach" },
    { k: "f2", t: "file", l: "Attach" },
  ])
  const plan = buildPlan({ scan, resolved: [], adapter: greenhouse, files })
  assert.deepEqual(
    plan.items.map((i) => i.paths[0]),
    [files.resume, files.cover],
    "resume slot comes first on every board we adapt",
  )
})

test("an informative label wins over position", () => {
  const scan = scanOf([
    { k: "f1", t: "file", l: "Cover Letter" },
    { k: "f2", t: "file", l: "Resume/CV" },
  ])
  const plan = buildPlan({ scan, resolved: [], adapter: greenhouse, files })
  assert.deepEqual(
    plan.items.map((i) => i.paths[0]),
    [files.cover, files.resume],
  )
})

test("a missing document defers instead of planning a broken upload", () => {
  const scan = scanOf([{ k: "f1", t: "file", l: "Resume/CV" }])
  const plan = buildPlan({ scan, resolved: [], adapter: greenhouse, files: {} })
  assert.equal(plan.items.length, 0)
  assert.match(plan.defer[0].why, /no rendered resume/)
})

// --- composite widgets and current-role handling --------------------------

test("the picker half of a phone widget is skipped, not filled", () => {
  const scan = scanOf([
    { k: "f1", t: "combo", l: "Phone" },
    { k: "f2", t: "tel", l: "Phone" },
  ])
  const plan = buildPlan({
    scan,
    resolved: [ok("f1", "(702) 810-4950"), ok("f2", "(702) 810-4950")],
    adapter: greenhouse,
    files,
  })
  const combo = plan.items.find((i) => i.k === "f1")
  assert.equal(
    combo.how,
    "skip",
    "the number must not go into the country picker",
  )
  assert.equal(plan.items.find((i) => i.k === "f2").how, "fill")
})

test("end dates are dropped once the current-role box is ticked", () => {
  const scan = scanOf([
    {
      k: "g1",
      t: "checkbox",
      l: "Current role",
      o: [{ k: "f9", l: "Current role", sel: "#cr" }],
    },
    { k: "f2", t: "combo", l: "End date month" },
    { k: "f3", t: "text", l: "End date year" },
  ])
  const plan = buildPlan({
    scan,
    resolved: [
      {
        k: "g1",
        status: "OK",
        value: "Current role",
        pick: "f9",
        pickSel: "#cr",
      },
      { k: "f2", status: "UNKNOWN", value: "" },
      { k: "f3", status: "UNKNOWN", value: "" },
    ],
    adapter: greenhouse,
    files,
  })
  assert.equal(plan.defer.length, 0, "end dates must not be asked about")
  assert.equal(plan.items.filter((i) => i.how === "skip").length, 2)
})

// --- plan shape -----------------------------------------------------------

test("the plan carries the url guard and the adapter's strategy order", () => {
  const scan = scanOf([{ k: "f1", t: "text", l: "First Name" }])
  const plan = buildPlan({
    scan,
    resolved: [ok("f1", "Xavier")],
    adapter: greenhouse,
    files,
    url: "https://job-boards.greenhouse.io/x/jobs/1",
  })
  assert.equal(plan.urlGuard, "https://job-boards.greenhouse.io/x/jobs/1")
  assert.deepEqual(plan.comboStrategies, greenhouse.comboStrategies)
  assert.equal(plan.ats, "greenhouse")
  assert.equal(plan.v, 1)
})

test("the plan carries the adapter's valueAliases (AUDIT H8)", () => {
  // greenhouse.mjs defines valueAliases for its country picker; it was never
  // copied onto the plan the engine actually reads, so the fix it documents
  // never fired.
  const scan = scanOf([{ k: "f1", t: "text", l: "First Name" }])
  const plan = buildPlan({
    scan,
    resolved: [ok("f1", "Xavier")],
    adapter: greenhouse,
    files,
  })
  assert.ok(Array.isArray(plan.valueAliases))
  assert.deepEqual(plan.valueAliases, greenhouse.valueAliases)
  assert.ok(plan.valueAliases.length > 0)
})

test("a combo item carries a cached via hint when the field has one", () => {
  const scan = scanOf([
    { k: "f1", t: "combo", l: "School", opts: ["UNLV"], via: "type-click" },
  ])
  const plan = buildPlan({
    scan,
    resolved: [ok("f1", "UNLV")],
    adapter: greenhouse,
    files,
  })
  assert.equal(plan.items[0].via, "type-click")
})

test("a combo item with no cached via carries none", () => {
  const scan = scanOf([{ k: "f1", t: "combo", l: "School", opts: ["UNLV"] }])
  const plan = buildPlan({
    scan,
    resolved: [ok("f1", "UNLV")],
    adapter: greenhouse,
    files,
  })
  assert.equal(plan.items[0].via, undefined)
})

// --- which combos are worth probing -----------------------------------------

test("combosNeedingProbe: a required combo is worth it even with no bank hit", () => {
  const fields = [{ k: "f1", t: "combo", l: "Custom Question", req: true }]
  assert.deepEqual(
    combosNeedingProbe(fields, [{ k: "f1", status: "UNKNOWN" }]),
    ["f1"],
  )
})

test("combosNeedingProbe: an optional combo the fact base knows nothing about is skipped", () => {
  const fields = [{ k: "f1", t: "combo", l: "Twitter Handle" }]
  assert.deepEqual(
    combosNeedingProbe(fields, [{ k: "f1", status: "UNKNOWN" }]),
    [],
  )
})

test("combosNeedingProbe: an optional combo the bank can answer is still worth it", () => {
  const fields = [{ k: "f1", t: "combo", l: "Degree" }]
  assert.deepEqual(combosNeedingProbe(fields, [{ k: "f1", status: "OK" }]), [
    "f1",
  ])
})

test("combosNeedingProbe: an EEO field is worth it (probing may surface 'decline')", () => {
  const fields = [{ k: "f1", t: "combo", l: "Gender" }]
  assert.deepEqual(
    combosNeedingProbe(fields, [{ k: "f1", status: "UNKNOWN", source: "eeo" }]),
    ["f1"],
  )
})

test("combosNeedingProbe: already-probed and non-combo fields are never listed", () => {
  const fields = [
    { k: "f1", t: "combo", l: "Already probed", req: true, opts: ["x"] },
    { k: "f2", t: "text", l: "First Name", req: true },
    { k: "f3", t: "select", l: "Country", req: true },
  ]
  assert.deepEqual(
    combosNeedingProbe(fields, [
      { k: "f1", status: "OK" },
      { k: "f2", status: "OK" },
      { k: "f3", status: "UNKNOWN" },
    ]),
    [],
  )
})

// FINDING (qa-adversary, tests/fixtures/hostile/forms/destructive-combobox.html):
// scan-page.js identifies a dropdown by SHAPE alone ([role=combobox] etc.), so
// a button reading "Withdraw my application" dressed the same way used to
// come back as "worth probing" here whenever it was required — and whatever
// reads that output (a human reading the printed `probe\t...` line today; a
// future `skipProbe` wiring tomorrow) would be told clicking it is a good
// idea, before any plan exists. Reuses scan-engine.mjs's own probeRefusal()
// so this can never drift from what the real scanner already refuses to
// click — not a re-implementation of the word list, an import of it.
test("combosNeedingProbe: destructive controls are never recommended for a probe, even when required", () => {
  const fields = [
    { k: "f1", t: "combo", l: "Country", req: true },
    { k: "f2", t: "combo", l: "Withdraw my application", req: true },
    {
      k: "f3",
      t: "combo",
      l: "Delete my candidate account and all application history",
      req: true,
    },
    { k: "f4", t: "combo", l: "Submit application now", req: true },
  ]
  const resolved = fields.map((f) => ({ k: f.k, status: "UNKNOWN" }))
  assert.deepEqual(combosNeedingProbe(fields, resolved), ["f1"])
})

test("combosNeedingProbe: a button whose own text equals its name is refused structurally, not just by wordlist", () => {
  // scan-engine.mjs's rule 1: a PICKER's name comes from OUTSIDE it; a BUTTON's
  // name is its own rendered text. Catches a destructive control the word list
  // was never taught, the same way the real scanner's structural check does.
  const fields = [
    {
      k: "f1",
      t: "combo",
      l: "Deactivate my profile permanently",
      v: "Deactivate my profile permanently",
      req: true,
    },
  ]
  assert.deepEqual(
    combosNeedingProbe(fields, [{ k: "f1", status: "UNKNOWN" }]),
    [],
  )
})

// --- the CSP-safe bootstrap ------------------------------------------------
//
// addScriptTag inserts a real inline <script> element, which any board with a
// nonce-based CSP (Ashby) refuses to run outright — that broke the fill step
// live. The fix embeds the engine source and the plan as strings in the file
// fill-plan.mjs writes, loaded whole via `filename` and injected with
// page.evaluate + eval, which is not gated by the page's CSP the way an
// injected <script> tag is. These tests cover what does not need a browser:
// the generated text's shape, and that it is valid, self-installing JS.

test("buildBootstrap points at the plan file by filename, never inline code", () => {
  const bootstrap = buildBootstrap("jobs/acme-swe/fill-plan.js")
  assert.match(bootstrap, /browser_run_code_unsafe/)
  assert.match(bootstrap, /filename/)
  assert.match(bootstrap, /jobs\/acme-swe\/fill-plan\.js/)
  assert.ok(
    !bootstrap.includes("code:"),
    "must not fall back to the inline-code form",
  )
})

// The engine reaches the sandbox the way engineSandboxSource() delivers it: a
// bare function declaration whose completion value is the function. It is NOT
// an assignment to a window global any more — that assignment, and the read
// that paired with it, WERE the vulnerability. See the RCE tests below.
const FAKE_ENGINE =
  "async function fillPage(page, plan) { return { ok: 1, sawSlug: plan.slug } }\nfillPage\n"

test("buildDriverSource never regresses to the CSP-broken loader", () => {
  const driverSrc = buildDriverSource(
    { v: 1, slug: "x", items: [], defer: [] },
    FAKE_ENGINE,
  )
  // "addScriptTag" legitimately appears in this file's own warning comments
  // ("do not fix this back to addScriptTag") — that is the point, so check
  // for the FUNCTIONAL CALL, not the word, ignoring comment lines the same
  // way fill-page.test.mjs's own sandbox-timeout test does.
  const code = driverSrc
    .split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n")
  assert.ok(
    !/\.addScriptTag\(/.test(code),
    "addScriptTag inserts an inline <script> — nonce-based CSP boards block it",
  )
  assert.ok(!/\.addInitScript\(/.test(code))

  // With no scanner supplied the driver touches the page ZERO times before
  // running the engine — nothing is injected and nothing is read. That is
  // stronger than the property this test originally asserted, back when the
  // engine itself was pushed into the page.
  assert.ok(
    !/page\.evaluate/.test(code),
    "with no scanner there is nothing to put in the page",
  )

  // The scanner is the one thing that genuinely runs page-side, and it must go
  // in over CDP rather than as an inline <script>, which a nonce-CSP board
  // (Ashby) refuses outright — that broke a live application.
  const withScanner = buildDriverSource(
    { v: 1, slug: "x", items: [], defer: [] },
    FAKE_ENGINE,
    "window.__ajScan = function () { return { fields: [] } }",
  )
  const scannerCode = withScanner
    .split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n")
  assert.ok(!/\.addScriptTag\(/.test(scannerCode))
  assert.match(scannerCode, /page\.evaluate/)
  assert.match(scannerCode, /\(0,\s*eval\)/)
})

test("buildDriverSource embeds the exact engine source and plan as literals", () => {
  const plan = { v: 1, slug: "acme", items: [], defer: [] }
  const driverSrc = buildDriverSource(plan, FAKE_ENGINE)
  assert.ok(
    driverSrc.includes(JSON.stringify(FAKE_ENGINE)),
    "the engine text must appear verbatim, not paraphrased or truncated",
  )
  assert.ok(
    driverSrc.includes(JSON.stringify(plan)),
    "the plan must be embedded as a literal the driver passes as an ARGUMENT",
  )
})

// --- the round-trip RCE, and why the naive assertion is wrong ---------------
//
// This test replaces one that asserted the driver MUST contain
// `window.__ajPlan = ...`. That assertion pinned the vulnerability into the
// contract: the fix could not pass it. It is the reason a green suite read as
// "RCE closed" for as long as it did.
//
// Note the comment-stripping. A naive !/window\.__ajFillSrc/ check FAILS on a
// CORRECT fix, because the embedded engine's own header comment describes the
// hole it fixed — and deleting that comment to make a grep pass would throw
// away the incident record. Assert on code, not on prose.
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
}

test("the generated driver never reads executable code back out of the page", () => {
  const driverSrc = buildDriverSource(
    { v: 1, slug: "x", items: [], defer: [] },
    FAKE_ENGINE,
  )
  const code = codeOnly(driverSrc)
  assert.ok(
    !/__ajFillSrc/.test(code),
    "reading window.__ajFillSrc back out of the page is the RCE — a board " +
      "defining that getter chooses what runs with a live `page` handle",
  )
  assert.ok(
    !/window\.__ajPlan/.test(code),
    "the plan must travel as an argument; a page-owned global can be replaced",
  )
})

test("a hostile page that defines __ajFillSrc/__ajPlan getters owns nothing", async () => {
  // The test this replaces used a FRIENDLY fake page ({ window: {} }), so it
  // could not observe the exploit even while the exploit worked. This one is
  // hostile by construction: both globals are getters that count their reads.
  let touched = 0
  let submitClicked = false
  const ATTACK =
    '(async (page) => { globalThis.__PWNED = true; await page.click("button[type=submit]"); return { ok: 99 } })'

  const hostileWindow = {}
  for (const g of ["__ajFillSrc", "__ajPlan"]) {
    Object.defineProperty(hostileWindow, g, {
      get() {
        touched++
        return g === "__ajFillSrc" ? ATTACK : { items: [], defer: [] }
      },
      configurable: true,
    })
  }

  const plan = { v: 1, slug: "acme-swe", items: [], defer: [] }
  const driverSrc = buildDriverSource(plan, FAKE_ENGINE)

  const ctx = {
    window: hostileWindow,
    page: {
      evaluate: async (fn, arg) => fn.call(hostileWindow, arg),
      click: async () => {
        submitClicked = true
      },
    },
  }
  vm.createContext(ctx)
  const driverFn = vm.runInContext("(" + driverSrc + ")", ctx)
  const result = await driverFn(ctx.page)

  assert.equal(touched, 0, "the driver must never read a page-owned global")
  assert.ok(!ctx.__PWNED && !globalThis.__PWNED, "attacker code must not run")
  assert.ok(!submitClicked, "hard rule 6: only the user clicks submit")

  // ...and it still does its actual job, from the literal it was given.
  assert.equal(result.ok, 1)
  assert.equal(result.sawSlug, "acme-swe")
})

test("buildDriverSource output is valid JS wrapped exactly as browser_run_code_unsafe wraps it", () => {
  // packages/playwright-core/src/tools/backend/runCode.ts (bundled into
  // playwright-core/lib/coreBundle.js) does
  // `vm.runInContext("(" + code + ")", context2)` — verified by reading that
  // bundle directly, not assumed. Reproduce the exact expression shape.
  const driverSrc = buildDriverSource(
    { v: 1, slug: "x", items: [], defer: [] },
    FAKE_ENGINE,
  )
  assert.doesNotThrow(() => new Function("(" + driverSrc + ")"))
})

test("the eval stays indirect, so the engine's own function name cannot collide", () => {
  // This looks like style and is not. A DIRECT sloppy-mode eval hoists the
  // engine's own `function fillPage` declaration into the calling scope, where
  // it collides with a `const fillPage = eval(...)` — a run-time SyntaxError
  // that would surface only in the browser, only in production. Hence
  // `(0, eval)` and a local that is deliberately NOT named fillPage.
  const driverSrc = buildDriverSource(
    { v: 1, slug: "x", items: [], defer: [] },
    FAKE_ENGINE,
  )
  const code = codeOnly(driverSrc)
  assert.match(code, /\(0,\s*eval\)\(ENGINE\)/)
  assert.ok(
    !/const\s+fillPage\s*=/.test(code),
    "naming the local fillPage collides with the engine's own declaration",
  )
})

test("end to end: the CLI embeds the real engine and points the bootstrap at the written file", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fill-plan-bootstrap-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const slug = "ashby-co"
  const jobDir = path.join(dir, slug)
  fs.mkdirSync(jobDir, { recursive: true })

  const scan = {
    url: "https://jobs.ashbyhq.com/acme/11111111-2222-3333-4444-555555555555",
    fields: [
      {
        k: "f1",
        t: "text",
        l: "First Name",
        req: true,
        sel: "#_systemfield_name",
      },
    ],
  }
  fs.writeFileSync(path.join(jobDir, "scan-p1.json"), JSON.stringify(scan))

  const res = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "apply", "fill-plan.mjs"),
      slug,
      "--jobs-dir",
      dir,
      "--profile",
      path.join(ROOT, "tests", "fixtures", "profile.yaml"),
      "--answers",
      path.join(ROOT, "tests", "fixtures", "answers-bank.yaml"),
      "--json",
    ],
    { cwd: ROOT, encoding: "utf8" },
  )
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout)
  assert.equal(out.plan.ats, "ashby")

  const jsPath = path.join(jobDir, "fill-plan.js")
  assert.ok(fs.existsSync(jsPath))
  const written = fs.readFileSync(jsPath, "utf8")

  // The REAL engine, not a stand-in, must be what got embedded — and it now
  // comes from scripts/apply/fill-engine.mjs via engineSandboxSource(), which
  // is an ordinary ESM module the local runner imports directly. The old
  // .claude/skills/apply-job/fill-page.js was only ever a string to push into
  // the page, and pushing it there was the vulnerability.
  const engineForSandbox = engineSandboxSource()
  assert.ok(
    written.includes(JSON.stringify(engineForSandbox)),
    "the generated bootstrap must embed the real engine source verbatim",
  )
  assert.ok(
    !codeOnly(written).includes("__ajFillSrc"),
    "the real generated driver must not read the engine back out of the page",
  )
  // The embedded engine source legitimately mentions "addScriptTag" in its
  // own warning comments (escaped onto one long line by JSON.stringify) — so
  // check the DRIVER'S OWN orchestration code for a live call by dropping
  // that one giant embedded-content line rather than string-matching the
  // whole file.
  const templateOnly = written
    .split(/\r?\n/)
    .filter((l) => l.length < 500)
    .join("\n")
  assert.ok(
    !/\.addScriptTag\(/.test(templateOnly),
    "the driver's own orchestration code must never call addScriptTag",
  )

  // The printed bootstrap must point at exactly this file.
  const relJs = path.relative(ROOT, jsPath).replace(/\\/g, "/")
  assert.equal(out.bootstrap, buildBootstrap(relJs))
  assert.match(out.bootstrap, /filename/)

  // And the whole written file must parse as the single expression
  // browser_run_code_unsafe requires.
  assert.doesNotThrow(() => new Function("(" + written + ")"))
})

// --- scan path resolution ---------------------------------------------------
//
// fill-plan.mjs used to hardcode scan-p1.json regardless of how many pages had
// been scanned. urlGuard cannot catch a wrong page on a single-URL
// multi-step form (the URL never changes between steps), so page 2's answers
// were silently planned against page 1's fields. These pin the fix: an
// unambiguous single scan resolves automatically; more than one scan refuses
// to guess.

test("resolveScanPath: --scan wins outright, even over a --page value", () => {
  const r = resolveScanPath("/jobs/x", {
    scanFlag: "/explicit/path.json",
    pageFlag: "2",
  })
  assert.equal(r.path, "/explicit/path.json")
})

test("resolveScanPath: --page N maps to scan-pN.json", () => {
  const r = resolveScanPath(path.join("jobs", "x"), { pageFlag: "2" })
  assert.equal(r.path, path.join("jobs", "x", "scan-p2.json"))
})

test("resolveScanPath: a job dir with exactly one scan resolves it automatically", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-path-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, "scan-p2.json"), "{}")
  const r = resolveScanPath(dir, {})
  assert.equal(r.path, path.join(dir, "scan-p2.json"))
})

test("resolveScanPath: a job dir with two scans refuses to guess", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-path-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, "scan-p1.json"), "{}")
  fs.writeFileSync(path.join(dir, "scan-p2.json"), "{}")
  const r = resolveScanPath(dir, {})
  assert.ok(!r.path, "must not silently pick one")
  assert.match(r.error, /scan-p1\.json/)
  assert.match(r.error, /scan-p2\.json/)
  assert.match(r.error, /--scan|--page/)
})

test("resolveScanPath: an unscanned job dir falls back to the pre-existing default", () => {
  // Preserves the existing "no scan at ... run the page scanner first" error
  // message for a job that was never scanned at all.
  const r = resolveScanPath(path.join("jobs", "brand-new"), {})
  assert.equal(r.path, path.join("jobs", "brand-new", "scan-p1.json"))
})

test("end to end: page 2's scan is never silently planned as page 1", (t) => {
  // The exact reproduction of the bug: a job directory with BOTH scan-p1.json
  // and scan-p2.json (a multi-step form, both pages already scanned), and
  // fill-plan.mjs invoked the way the skill's documented flow calls it — with
  // no --scan flag at all. Before the fix this silently re-planned page 1;
  // now it must refuse outright rather than guess.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fill-plan-page-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const slug = "multi-step-co"
  const jobDir = path.join(dir, slug)
  fs.mkdirSync(jobDir, { recursive: true })

  const page1 = {
    url: "https://job-boards.greenhouse.io/x/apply",
    fields: [{ k: "f1", t: "text", l: "First Name", req: true }],
  }
  const page2 = {
    url: "https://job-boards.greenhouse.io/x/apply", // same URL — urlGuard alone cannot tell these apart
    fields: [{ k: "g1", t: "text", l: "Desired Salary", req: true }],
  }
  fs.writeFileSync(path.join(jobDir, "scan-p1.json"), JSON.stringify(page1))
  fs.writeFileSync(path.join(jobDir, "scan-p2.json"), JSON.stringify(page2))

  const res = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "apply", "fill-plan.mjs"),
      slug,
      "--jobs-dir",
      dir,
      "--profile",
      path.join(ROOT, "tests", "fixtures", "profile.yaml"),
      "--answers",
      path.join(ROOT, "tests", "fixtures", "answers-bank.yaml"),
    ],
    { cwd: ROOT, encoding: "utf8" },
  )
  assert.equal(res.status, 2, "must refuse rather than guess a page")
  assert.match(res.stderr, /scan-p1\.json/)
  assert.match(res.stderr, /scan-p2\.json/)

  // And --page 2 (the fix's intended fast path for the skill to adopt) plans
  // page 2's own field, not page 1's.
  const withPage = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "apply", "fill-plan.mjs"),
      slug,
      "--jobs-dir",
      dir,
      "--page",
      "2",
      "--profile",
      path.join(ROOT, "tests", "fixtures", "profile.yaml"),
      "--answers",
      path.join(ROOT, "tests", "fixtures", "answers-bank.yaml"),
      "--json",
    ],
    { cwd: ROOT, encoding: "utf8" },
  )
  assert.equal(withPage.status, 0, withPage.stderr)
  const out = JSON.parse(withPage.stdout)
  const keys = [...out.plan.items, ...out.plan.defer].map((x) => x.k)
  assert.ok(keys.includes("g1"), "page 2's own field must be in the plan")
  assert.ok(
    !keys.includes("f1"),
    "page 1's field must not leak into page 2's plan",
  )
})
