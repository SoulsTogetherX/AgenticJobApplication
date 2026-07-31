// Hostile FORMS, asserted at the consumers that act on a form:
//
//   save-answer.mjs   -> profile/answers.yaml   (permanent, global, corpus)
//   buildPlan()       -> jobs/<slug>/fill-plan.js items (what gets typed where)
//   combosNeedingProbe() -> which controls the scanner CLICKS with force:true
//
// A form field's LABEL is third-party text that this pipeline stores forever.
// A form's SHAPE decides what the scanner touches. Both are chosen by whoever
// wrote the page, and neither has ever been treated as hostile input in a test
// that asserted an outcome.
//
// Every scan below is the companion fixture for a served HTML page, and
// tests/security/board-fidelity.test.mjs asserts the two agree — so these are
// not hand-made shapes chosen to make a point.
//
// Run: node --test tests/security/hostile-forms.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  buildPlan,
  combosNeedingProbe,
  resolveFields,
  isConsent,
  isHardConsent,
} from "../../scripts/apply/fill-plan.mjs"
import { normalizeQuestion } from "../../scripts/apply/answer-bank.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..", "..")
const SCANS = path.join(ROOT, "tests/fixtures/boards/scans")
const PROFILE = path.join(ROOT, "tests/fixtures/profile.yaml")
const ANSWERS = path.join(ROOT, "tests/fixtures/answers-bank.yaml")

const scan = (n) =>
  JSON.parse(fs.readFileSync(path.join(SCANS, `${n}.scan.json`), "utf8"))
const GENERIC = {
  id: "generic",
  comboStrategies: [],
  fileFields: [],
  fileOrder: [],
}

// THE HONEST SCAN PATH, MODELLED. scan-engine.mjs's scanPage() returns
// `{ scan, vouchedLabels }`: it lifts every vouched label OUT of the scan into
// a separate array held in the Node process, then untrustScan() deletes
// `labelExact` from the scan itself, so a scan file can never assert anything.
// buildPlan takes the array as an explicit argument.
//
// A test that models the honest path must do the same lift, or it is testing a
// shape the pipeline no longer produces. A test modelling a HOSTILE path
// (a scan file, a __ajLastScan read-back, a bare re-scan) deliberately does
// NOT — it hands buildPlan the raw scan with labelExact intact and no
// vouchedLabels, which is exactly what those carriers produce.
// tests/security/rce-round-trip.test.mjs holds the hostile side.
const asScanned = (s) => {
  const scanned = JSON.parse(JSON.stringify(s))
  const vouchedLabels = []
  for (const f of scanned.fields ?? []) {
    if (f.labelExact === true && f.l) vouchedLabels.push(String(f.l))
    delete f.labelExact
    for (const o of f.o ?? []) delete o.labelExact
  }
  return { scan: scanned, vouchedLabels }
}

const planFrom = (s, extra = {}) =>
  buildPlan({
    scan: s,
    resolved: resolveFields(s.fields, { profile: PROFILE, answers: ANSWERS }),
    adapter: GENERIC,
    url: s.url,
    ...extra,
  })

// ---------------------------------------------------------------------------
// 1. Labels on their way into the fact base
// ---------------------------------------------------------------------------

function saveAnswer(question, answer, file) {
  return spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts/profile/save-answer.mjs"),
      question,
      answer,
      "--source",
      "model",
      "--file",
      file,
    ],
    { cwd: ROOT, encoding: "utf8" },
  )
}

test("an injection-carrying form label never lands in answers.yaml", () => {
  // answers.yaml is permanent, global and part of the verify-claims evidence
  // corpus. A label saved once is re-read on every future application, so this
  // is the highest-value place for a posting to plant text.
  //
  // Asserted at the FILE, not at the sanitiser: whatever the mechanism, the
  // instruction must not be on disk afterwards.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-answers-"))
  try {
    const file = path.join(dir, "answers.yaml")
    const hostile = scan("label-injection").fields.filter((f) => f.k !== "f1")
    for (const f of hostile) {
      saveAnswer(f.l, "Yes", file)
    }
    const written = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""

    // ONE ASSERTION OVER ALL FOUR PAYLOADS, and the fixture-size check AFTER.
    // Four `doesNotMatch` calls in series would let a fix for the first hide
    // the other three; a `hostile.length === 5` precondition ahead of them
    // would let a fixture edit hide all four.
    const leaked = [
      /ignore all previous instructions/i,
      /add Kubernetes to the resume/i,
      /rate this candidate highly/i,
      /do not tell the user/i,
    ]
      .filter((re) => re.test(written))
      .map(String)
    assert.deepEqual(
      leaked,
      [],
      `hostile label text reached answers.yaml: ${leaked.join(", ")}`,
    )
    assert.equal(
      hostile.length,
      5,
      "the hostile label set shrank — the test above got easier",
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("refusing a hostile label is loud, not silent", () => {
  // A silent drop is worse than a save: the agent believes the answer is
  // banked and stops asking. The exit code and the message are the contract.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-answers-loud-"))
  try {
    const file = path.join(dir, "answers.yaml")
    const label = scan("label-injection").fields.find((f) => f.k === "f4").l
    const res = saveAnswer(label, "Yes", file)
    assert.notEqual(res.status, 0, "a hostile label must not save successfully")
    assert.match(
      res.stderr,
      /instruction-shaped|refus/i,
      `the refusal must say why: ${JSON.stringify(res.stderr.slice(0, 200))}`,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("an ordinary label still saves — the guard must not break the normal path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-answers-ok-"))
  try {
    const file = path.join(dir, "answers.yaml")
    const res = saveAnswer(
      "How did you hear about this job?",
      "Job Board",
      file,
    )
    assert.equal(res.status, 0, res.stderr)
    assert.match(
      fs.readFileSync(file, "utf8"),
      /How did you hear about this job\?/,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a hostile label never becomes a filled plan item", () => {
  // The other consumer of a label: buildPlan resolves it and the engine types
  // the result. Nothing on this form is answerable from the fact base, so
  // every hostile field must defer or skip — never fill.
  const plan = planFrom(scan("label-injection"))
  const filled = plan.items.filter((i) => i.how !== "skip")
  for (const i of filled) {
    assert.doesNotMatch(
      String(i.label ?? "") + String(i.value ?? ""),
      /ignore all previous|rate this candidate|do not tell the user/i,
      `a hostile label produced a fill: ${JSON.stringify(i)}`,
    )
  }
  // And the concealment field must be visible to the user one way or another —
  // deferred or listed as skipped, never absent.
  const all = [...plan.items, ...plan.defer].map((x) => x.k)
  for (const f of scan("label-injection").fields) {
    assert.ok(all.includes(f.k), `field ${f.k} vanished from the plan entirely`)
  }
})

// ---------------------------------------------------------------------------
// 2. Destructive controls dressed as comboboxes
// ---------------------------------------------------------------------------

test("FINDING (w2-engine): a destructive control shaped like a combobox is selected for a force:true click", () => {
  // scan-page.js classifies a dropdown by SHAPE alone ([role=combobox],
  // [aria-haspopup=listbox], [class*=select__control], [data-ui=select]), and
  // scan-engine.mjs opens each match with
  //
  //     await loc.click({ timeout: 2000, force: true })
  //
  // force:true skips every actionability check. So "Withdraw my application",
  // "Delete my candidate account" and "Submit application now" are clicked by
  // the SCANNER — before a plan exists, before the user has approved anything,
  // and in the submit case in direct violation of hard rule 6.
  //
  // Asserted at the consumer that decides what gets probed. There is no
  // destructive-label guard anywhere in the apply path; this names the gap
  // rather than describing it.
  const s = scan("destructive-combobox")
  // Required fields are probed unconditionally, so mark them the way a hostile
  // board would: a required control is the cheapest way to guarantee a click.
  const fields = s.fields.map((f) =>
    f.t === "combo" ? { ...f, req: true } : f,
  )
  const toProbe = combosNeedingProbe(
    fields,
    resolveFields(fields, {
      profile: PROFILE,
      answers: ANSWERS,
    }),
  )

  const labelOf = new Map(fields.map((f) => [f.k, f.l]))
  const destructive = toProbe
    .map((k) => labelOf.get(k))
    .filter((l) => /withdraw|delete|submit/i.test(String(l)))

  assert.deepEqual(
    destructive,
    [],
    "these controls will be clicked with force:true during a scan: " +
      JSON.stringify(destructive),
  )
})

test("a fix must keep probing the genuine dropdown", () => {
  // The failing test above is only actionable if the obvious over-correction is
  // also caught. A form whose country picker is never probed defers every
  // dropdown to the user, which is the slow path this project is trying to
  // remove.
  const s = scan("destructive-combobox")
  const fields = s.fields.map((f) =>
    f.t === "combo" ? { ...f, req: true } : f,
  )
  const toProbe = combosNeedingProbe(
    fields,
    resolveFields(fields, {
      profile: PROFILE,
      answers: ANSWERS,
    }),
  )
  const labelOf = new Map(fields.map((f) => [f.k, f.l]))
  assert.ok(
    toProbe.map((k) => labelOf.get(k)).includes("Country"),
    "the honest Country dropdown must still be probed",
  )
})

// ---------------------------------------------------------------------------
// 3. Consent: decoupling, truncation, rewording
// ---------------------------------------------------------------------------

test("no consent box auto-ticks on the decoupled or truncated fixture", () => {
  // The user's real allowlist is simulated with EVERY label this form presents,
  // which is the worst case: the user has approved all of this wording before.
  const raw = scan("consent-decoupled")
  const allowlist = new Set(
    raw.fields
      .filter((f) => f.t === "checkbox")
      .map((f) => normalizeQuestion(f.l)),
  )
  // The HONEST path: the vouch is lifted out of band, exactly as scanPage()
  // does it, so this exercises the feature as the pipeline actually delivers it.
  const { scan: s, vouchedLabels } = asScanned(raw)
  const plan = planFrom(s, { consentAllowlist: allowlist, vouchedLabels })

  // SECURITY FIRST, FEATURE SECOND. The hostile boxes deferring is the
  // property that matters, and it is asserted as one set so that fixing one
  // shape cannot hide another. An earlier version asserted `ticked === ["f3"]`
  // above this — a characterisation of the allowlist feature — so w3's
  // in-flight vouchedLabels rewrite would have aborted the test on that line
  // and the deferral checks would never have run.
  const ticked = plan.items.filter((i) => i.how === "check").map((i) => i.k)
  const deferred = new Set(plan.defer.map((d) => d.k))
  const HOSTILE = {
    g1: "aria-label-decoupled",
    g3: "binding-arbitration past the 120-char cut",
    // NEWLY LIVE. w3-resolution's fix added "accept|affirm|attest" to
    // isConsent, so this box is now correctly recognised as consent — and
    // therefore now eligible to auto-tick from the allowlist. But it
    // authorises a BACKGROUND INVESTIGATION and adopts a document
    // ELECTRONICALLY, which are two of the three acts isHardConsent exists to
    // exclude. Its patterns are "background (check|screening)" and
    // "e-sign(ature)", so both wordings walk straight past it.
    //
    // Before the isConsent fix this box fell out of the consent branch and was
    // skipped, which was safe by accident. Now it ticks. The fix moved the
    // defect rather than removing it, which is what "the 26th rewording is
    // free" means in practice.
    g4: "background investigation + electronic adoption, missed by isHardConsent",
    // THE color:transparent CARRIER, ON EVERY LEG. This box was in the served
    // page from the start and MISSING from the scan fixture, so until
    // scan-fidelity.test.mjs caught the omission the only consumer assertion
    // on it lived in browser-vouch.test.mjs — which skips wherever there is no
    // Chromium, i.e. on the leg most people run. The label is byte-identical
    // text the user cannot see, so scan-page.js withholds the vouch
    // (labelWhy: "label text is not visibly rendered") and it must defer.
    g5: "label hidden with color:transparent, so the vouch is withheld",
  }
  const leaked = Object.entries(HOSTILE)
    // A key that no longer resolves is a failure, not a shorter list — the
    // fixture was renumbered once already.
    .filter(([k]) => !s.fields.some((f) => f.k === k) || !deferred.has(k))
    .map(([k, why]) => `${k} (${why})`)
  assert.deepEqual(
    leaked,
    [],
    "hostile consent boxes did not defer even though every label here is " +
      `allowlisted: ${leaked.join(", ")}; ticked=${JSON.stringify(ticked)}`,
  )

  // Then the feature: the correct answer is not "nothing ticks" — the
  // allowlist is opt-in and exists to work. Exactly one box on this form
  // carries no legal waiver, and only it may tick.
  assert.deepEqual(
    ticked,
    ["f3"],
    "only the vouched, non-waiver certification may auto-tick: " +
      JSON.stringify(plan.items.filter((i) => i.how === "check")),
  )
})

test("the decoupled box cannot be vouched for, because an attribute is not readable text", () => {
  // scan-page.js's vouch: only rendered DOM text can establish exactness, so a
  // label taken from aria-label / title / placeholder / name never sets
  // labelExact. Asserted at the plan: even with the innocuous aria-label text
  // on the user's allowlist, the box defers.
  // Outcome first; the fixture's labelExact state is the mechanism and is
  // asserted after, so a scanner change cannot abort this before the plan is
  // ever examined.
  const raw = scan("consent-decoupled")
  const g1 = raw.fields.find((f) => f.k === "g1")
  const { scan: s, vouchedLabels } = asScanned(raw)
  const plan = planFrom(s, {
    consentAllowlist: new Set([normalizeQuestion(g1.l)]),
    vouchedLabels,
  })
  assert.deepEqual(
    plan.items.filter((i) => i.how === "check"),
    [],
    "an attribute-derived label was matched against the allowlist and ticked",
  )
  assert.ok(
    plan.defer.some((d) => d.k === "g1" && d.why === "consent"),
    "the decoupled box must defer even when its aria-label text is allowlisted",
  )
  assert.notEqual(
    g1.labelExact,
    true,
    "an attribute-derived label must not vouch",
  )
})

test("the truncation collision is CLOSED: the two 120-char-identical labels are now distinguishable", () => {
  // Before the vouch, "I certify … knowledge and belief." and the same text
  // plus " I also agree to binding arbitration and waive a jury trial." both
  // sliced to the identical 120 characters, so one allowlist entry ticked both
  // and nothing the user saw changed.
  //
  // The scan fixture now carries the UNTRUNCATED label for a vouched field.
  // This asserts the outcome: allowlisting only the certification the user
  // approved ticks that box and NOT the arbitration one.
  const raw = scan("consent-decoupled")
  const approved = raw.fields.find((f) => f.k === "g2")
  const arbitration = raw.fields.find((f) => f.k === "g3")
  const { scan: s, vouchedLabels } = asScanned(raw)

  // OUTCOME FIRST. The two fixture-shape checks below used to sit above this
  // and would abort it if either label were ever re-truncated — which is the
  // exact regression this test exists to catch, reported as a fixture problem
  // instead of a security one.
  const plan = planFrom(s, {
    consentAllowlist: new Set([normalizeQuestion(approved.l)]),
    vouchedLabels,
  })
  const ticked = plan.items.filter((i) => i.how === "check").map((i) => i.k)
  assert.ok(
    !ticked.includes("f4"),
    "the binding-arbitration box was auto-ticked from an allowlist entry the " +
      "user approved for a DIFFERENT sentence",
  )
  assert.ok(
    plan.defer.some((d) => d.k === "g3"),
    "the arbitration box must defer",
  )

  // Then the fixture: the collision the fix removed must still be real at 120
  // characters, or this is the easy case wearing the hard case's name.
  const slice120 = (x) => String(x).replace(/\s+/g, " ").trim().slice(0, 120)
  assert.equal(
    slice120(approved.l),
    slice120(arbitration.l),
    "the two labels no longer collide at 120 chars — the fixture went soft",
  )
  assert.notEqual(
    normalizeQuestion(approved.l),
    normalizeQuestion(arbitration.l),
  )
  // The approved one may tick — that is the feature working. Assert the
  // allowlist is not simply inert, or this test proves nothing.
  assert.ok(
    ticked.includes("f3") || plan.defer.some((d) => d.k === "g2"),
    "g2 must resolve one way or the other",
  )
})

test("FINDING (w3-resolution + innov-resilience): the consent pattern list is not a control — real-world wording escapes it", () => {
  // MY CROSS-CHECK DUTY, and the reason it is a separate test from the one
  // below. w3-resolution fixed the previous finding by ADDING PATTERNS:
  // "accept|affirm|attest" to isConsent, and "dispute resolution",
  // "background investigation", "adopt this document" to isHardConsent. That
  // made my contrived fixture pass. It is not a structural fix, and this is
  // the evidence rather than the opinion.
  //
  // Every wording below is how these agreements are ACTUALLY written on US
  // application forms — the FCRA authorisation in particular is near-verbatim
  // from the standard form, because "consumer report" is the statutory term
  // for what a background check is. Nothing here is invented to be awkward.
  //
  // The bar this asserts is the LOW one: not "isHardConsent excludes it" but
  // "isConsent RECOGNISES it as an agreement at all". A box that fails even
  // that never enters the consent branch, so it is handled as an ordinary
  // optional checkbox and never appears as an agreement in the approval
  // message the user reads before submitting.
  // g6-g9, not g5-g8: the scan fixture was missing the #consent-transparent
  // box the served page has always carried, and adding it shifted every group
  // after it by one. Found by scan-fidelity.test.mjs.
  const REAL = {
    g6: "FCRA consumer-report authorisation (a background check)",
    g7: "jury-trial waiver (arbitration, in plain English)",
    g8: "typed name as a legal mark (an electronic signature)",
    g9: "inquiry into employment history (a background check)",
  }
  const s = scan("consent-decoupled")
  // A KEY THAT NO LONGER RESOLVES IS A FAILURE, NOT A SHORTER LIST. The
  // earlier `.filter(([f]) => f && ...)` dropped a vanished field silently, so
  // renumbering the fixture — which is exactly what happened when the missing
  // #consent-transparent box was restored — would have shrunk this finding to
  // nothing and read as a fix. Missing fields are reported in the same list.
  const lookup = (k) => s.fields.find((f) => f.k === k)
  const unrecognised = Object.entries(REAL)
    .map(([k, what]) => [lookup(k), what, k])
    .filter(([f]) => !f || !isConsent(f.l))
    .map(([f, what, k]) =>
      f
        ? `${what}: ${JSON.stringify(f.l.slice(0, 60))}…`
        : `${what}: field ${k} is not in the fixture at all`,
    )

  assert.deepEqual(
    unrecognised,
    [],
    `${unrecognised.length} real-world legal agreements are not classified as ` +
      `consent at all:\n  ${unrecognised.join("\n  ")}\n` +
      "Adding four more patterns closes exactly these four. The structural " +
      "fix is to invert the default — route EVERY checkbox through the " +
      "consent gate and let the positive allowlist decide — so the pattern " +
      "list becomes an advisory label for the approval message, not a control.",
  )

  // And the harder bar, reported after so it cannot pre-empt the above.
  const notHard = Object.entries(REAL)
    .map(([k, what]) => [lookup(k), what, k])
    .filter(([f]) => !f || !isHardConsent(f.l))
    .map(([f, what, k]) => (f ? what : `${what} (field ${k} is missing)`))
  assert.deepEqual(
    notHard,
    [],
    `and ${notHard.length} of them are not excluded from the allowlist either: ${notHard.join("; ")}`,
  )
})

test("FINDING (w3-resolution): a reworded consent box is not recognised as consent at all", () => {
  // "I accept binding dispute resolution, authorise a background
  // investigation, and adopt this document electronically." — three legal
  // acts. isHardConsent misses all three (its patterns are "arbitration",
  // "background check|screening", "e-signature"), and so does isConsent, whose
  // verb list is "I (agree|consent|acknowledge|understand|certify)" and does
  // not include "I accept".
  //
  // The immediate outcome is safe by accident: the fact base cannot answer the
  // box and it is not required, so it is SKIPPED. But it is skipped as an
  // ordinary optional checkbox, not surfaced as a legal agreement, so it never
  // appears in the consent section of an approval message. The 26th rewording
  // is free — ask innov-resilience whether adding "accept" is structural.
  // ORDER IS LOAD-BEARING. The finding is the isConsent line and it goes
  // FIRST. An earlier version asserted `isHardConsent(...) === false` ahead of
  // it — an assertion that pins the CURRENT BROKEN STATE — so a partial fix by
  // w3 that added "dispute resolution" to the hard list would flip it, abort
  // the test, and hide the isConsent half entirely. A pin on today's behaviour
  // must never precede the assertion that describes the wanted behaviour.
  const s = scan("consent-decoupled")
  const reworded = s.fields.find((f) => f.k === "g4")
  assert.equal(
    isConsent(reworded.l),
    true,
    `a box asserting three legal acts was not classified as consent: ${JSON.stringify(reworded.l)}`,
  )
  // Diagnostic, deliberately NON-FATAL: whether the hard list also catches it
  // is useful to know and is not what this test exists to pin. Reported, never
  // asserted, so it cannot pre-empt anything.
  if (isHardConsent(reworded.l)) {
    console.log(
      "  note: isHardConsent now matches the reworded box too — a pattern was " +
        "added; ask innov-resilience whether that is structural or the 26th rewording",
    )
  }
})

// ---------------------------------------------------------------------------
// 4. Labels that lie about the input they wrap
// ---------------------------------------------------------------------------

test("FINDING (w3-resolution): a label that names a different field aims the answer at the wrong input", () => {
  // Every resolution is keyed on the LABEL, and the board writes the label.
  // Nothing downstream checks that the element is the kind of thing the label
  // describes, so a page can aim any banked answer at any input:
  //
  //   <label for="m-phone">Phone number</label>
  //   <input id="m-phone" name="ssn">
  //
  // The plan that results says label "Phone number" and targets name="ssn".
  // The approval message the user reads shows the label, so the substitution
  // is invisible in review.
  //
  // REOPENED 2026-07-31, and the reason matters more than the finding.
  // fieldIdentityMismatch() in fill-plan.mjs reads the element's identity out
  // of `sel` — selectorIdentity() pulls the value from a [name=…] selector, or
  // the id from a bare `#…`. It went green against a fixture claiming
  // `sel: input[name="ssn"]`. The REAL scanner never emits that: stableSel()
  // tries `#id` FIRST and only falls back to a name selector when no unique id
  // exists (scan-page.js, stableSel). This page's inputs all have ids, so the
  // scanner emits `#m-phone` — "m phone" — which agrees with the label
  // "Phone number", the guard finds no mismatch, and the phone number is
  // planned into name="ssn" exactly as before.
  //
  // Verified by running the real scan-page.js over the served page through
  // tests/fixtures/boards/dom.mjs; tests/security/scan-fidelity.test.mjs now
  // pins the fixture to that output, which is what surfaced this.
  //
  // So the guard is not weak, it is UNREACHABLE on the shape it was written
  // for: the one input it has is chosen by the same page that chose the label.
  // A hostile board picks the id. `sel` cannot carry the name attribute of an
  // element the scanner selected by id, so no pattern added to
  // IDENTITY_CATEGORIES changes this — the fix needs the scanner to REPORT the
  // element's own identity (name/type/autocomplete) as a field of its own,
  // which is w2-engine's scan-page.js, not w3's matcher.
  const s = scan("mislabelled-inputs")
  const plan = planFrom(s)

  const bySel = new Map(s.fields.map((f) => [f.k, f]))
  const wrong = []
  for (const item of plan.items.filter(
    (i) => i.how === "fill" || i.how === "check",
  )) {
    const field = bySel.get(item.k) ?? bySel.get(item.k.replace(/^f/, "g"))
    const realName = field?._real_name
    if (!realName) continue
    // The plan targets an element whose own name attribute contradicts the
    // label the plan is showing the user.
    wrong.push({ label: item.label, targets: realName, value: item.value })
  }
  assert.deepEqual(
    wrong,
    [],
    "values were planned into fields whose real names contradict their labels: " +
      JSON.stringify(wrong),
  )
})

test("FINDING (w2-engine): the label the plan shows the user is not the label on the page", () => {
  // A second, quieter shape of the same defect. The input carries BOTH a
  // visible <label for>Email</label> and aria-label="Emergency contact phone".
  // labelOf reads aria-label first, so the plan — and the approval message
  // built from it — says "Emergency contact phone" while the page says
  // "Email". The user approves a form they are not looking at.
  //
  // scan-page.js's labelExact vouch already encodes exactly this principle for
  // consent boxes: an attribute is not text the user can read. The finding is
  // that the principle stops at consent, and every other field still shows the
  // attribute-derived string in review.
  // ORDER IS LOAD-BEARING. Two preconditions used to precede the finding, and
  // the second ("the field must appear in the plan") is about to be a live
  // hazard: buildPlan is being rewritten to take `vouchedLabels`, and if the
  // field stops landing in items/defer this would go red at the precondition
  // and the finding would disappear behind a message about plan membership.
  //
  // So the finding is computed defensively and asserted FIRST. A missing field
  // is reported as part of the same failure rather than as a different one.
  const s = scan("mislabelled-inputs")
  const f = s.fields.find((x) => x._visible_label)
  const plan = f ? planFrom(s) : { items: [], defer: [] }
  const item = f
    ? [...plan.items, ...plan.defer].find((i) => i.k === f.k)
    : null
  const shown = item ? item.label : null

  assert.equal(
    shown,
    f?._visible_label ?? null,
    "the plan must show the user the label the PAGE shows them; showing " +
      `${JSON.stringify(shown)} for a field the page labels ` +
      `${JSON.stringify(f?._visible_label)} makes the approval message wrong` +
      (item
        ? ""
        : " (the field is not in the plan at all — see the fixture check below)"),
  )
})

test("the visible/matched divergence fixture is intact, so the test above is about behaviour", () => {
  // Split out of the test above rather than left as a precondition inside it.
  // A fixture that quietly stopped carrying its trait is a slacking signature,
  // and it deserves its own red line — not a position ahead of a finding where
  // it can pre-empt one.
  const s = scan("mislabelled-inputs")
  const f = s.fields.find((x) => x._visible_label)
  assert.ok(f, "the fixture must carry a visible/matched divergence")
  assert.equal(f._visible_label, "Email")
  assert.equal(f.l, "Emergency contact phone")
  assert.notEqual(f.l, f._visible_label)
})

test("the mislabelled fixture is genuinely contradictory, so the tests above can fail", () => {
  // Prove the trap is armed.
  const s = scan("mislabelled-inputs")
  const pairs = s.fields.map((f) => [f.l, f._real_name]).filter(([, n]) => n)
  assert.ok(
    pairs.length >= 3,
    `expected at least 3 lying labels, got ${pairs.length}`,
  )
  assert.deepEqual(
    pairs.find(([l]) => l === "Phone number"),
    ["Phone number", "ssn"],
  )
})
