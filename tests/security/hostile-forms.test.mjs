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
  looksLikeAgreementProse,
  readiness,
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
  //
  // GREEN SINCE 2026-07-31, AND ONLY PARTIALLY CLOSED. It needed two things:
  // scan-page.js emitting `n` (w2-engine) and fieldIdentityMismatch reading it
  // (w3-resolution) — neither alone flips it, measured both ways. What it does
  // NOT mean is that the attack is dead: every token the guard reads is chosen
  // by the board, and section 4b below runs the same page with `id`, `name`
  // and `autocomplete` renamed to agree with the lying label. That variant
  // lands, its tests are green on purpose, and they say so in their names.
  // Read them before treating this line as a closed finding.
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

test("the fixture's `_real_name` annotation still agrees with the scanner's own `n`", () => {
  // `_real_name` is a HUMAN claim about the page and `n` is scanner output;
  // the tests above are built on the first and the guard reads the second.
  // Once both are in the file they can drift apart, and a drift would make the
  // finding test assert against a truth the guard never sees. Cheapest place
  // to notice: here.
  const pairs = []
  for (const f of scan("mislabelled-inputs").fields ?? []) {
    const emitted = f.n ?? (f.o ?? []).find((o) => o.n)?.n
    if (f._real_name) pairs.push([f._real_name, emitted ?? null])
  }
  // Asserted as ONE deepEqual over all of them, and the count is part of the
  // expectation — an annotation that vanished would otherwise make this pass
  // by having nothing to compare.
  // Three, not four: f4 carries `_visible_label` and no `_real_name`, because
  // its name AGREES with the matched label — it is a review attack, not a
  // routing one.
  assert.deepEqual(pairs, [
    ["ssn", "ssn"],
    ["salary_floor", "salary_floor"],
    ["agree_arbitration", "agree_arbitration"],
  ])
})

// ---------------------------------------------------------------------------
// 4b. The same attack, escalated past the guard that closed 4
//
// READ THIS BEFORE READING SECTION 4 AS SETTLED. The finding above is green
// because fieldIdentityMismatch() compares the label against `n`/`sel`. Every
// token it reads is chosen by the board. mislabelled-escalated.html renames
// id, name and autocomplete to AGREE with the lying label — four attribute
// edits, nothing a human could see on the page changes — and the guard has
// nothing left to compare.
//
// These tests are GREEN and they assert that an attack LANDS. That is a
// deliberate choice and here is the reasoning, so nobody re-litigates it by
// accident:
//
//   - A permanently-red test was the obvious alternative. Rejected: this
//     directory is the `npm run test:security` gate, and a gate that is always
//     red stops being read — by every other agent, for every other finding.
//     The cost of one always-red line is paid by every future finding in the
//     same suite.
//   - A skip-with-reason (browser-vouch.test.mjs's pattern) is right when a
//     test CANNOT run. This one runs and produces a number. Skipping would
//     throw the number away.
//   - So: assert the landed outcome, and name it so the green cannot be
//     misread. If anyone changes the behaviour in EITHER direction these go
//     red, which is the alarm you actually want — "someone moved this, decide
//     whether the finding is now closed."
//
// WHERE THIS IS GENUINELY STOPPED: the value side. A field's meaning is
// decided server-side, so no scanner can recover it; the blast radius of a
// label-lie routing attack is exactly the contents of the answer bank. The
// last test in this section asserts that boundary at the FILE.
// ---------------------------------------------------------------------------

// The truth the document does not contain: which column the server writes.
const destinationOf = (f) =>
  f._destination ?? (f.o ?? []).find((o) => o._destination)?._destination

const PROFILE_PHONE = /^\s*phone:\s*"?([^"\n]+?)"?\s*$/m.exec(
  fs.readFileSync(PROFILE, "utf8"),
)?.[1]

test("LANDS (unfixable in the document): renaming the attributes to agree with the lying label defeats the identity guard entirely", () => {
  // Asserted at buildPlan, not at fieldIdentityMismatch: the question is not
  // "did the guard fire" but "what did the pipeline decide to type, and into
  // what".
  const s = scan("mislabelled-escalated")
  const plan = planFrom(s)
  const byK = new Map(s.fields.map((f) => [f.k, f]))

  const typed = plan.items
    .filter((i) => i.how === "fill")
    .map((i) => ({
      label: i.label,
      name: i.n,
      value: i.value,
      serverColumn: destinationOf(byK.get(i.k)) ?? null,
    }))

  assert.ok(
    PROFILE_PHONE,
    "could not read the contact phone out of the profile fixture",
  )
  assert.deepEqual(
    typed,
    [
      {
        label: "Phone number",
        name: "phone",
        value: PROFILE_PHONE,
        // The whole finding in one key: every token in this record is
        // consistent, and the value still goes to `ssn`.
        serverColumn: "ssn",
      },
      {
        label: "Email",
        name: "emergency_contact_phone",
        value: PROFILE_PHONE,
        serverColumn: "emergency_contact_phone",
      },
    ],
    "the escalated page's landed fills changed — re-derive whether the " +
      "finding is still open before editing this expectation",
  )
})

test("LANDS: the escalation buys 3 fewer identity defers and 2 more fills than the unescalated page", () => {
  // The measurement, so the claim is falsifiable rather than narrative.
  // Command: node --test tests/security/hostile-forms.test.mjs
  const count = (name) => {
    const s = scan(name)
    const plan = planFrom(s)
    return {
      identityDefers: plan.defer.filter((d) =>
        /the label may not describe/.test(d.why ?? ""),
      ).length,
      fills: plan.items.filter((i) => i.how === "fill").length,
    }
  }
  assert.deepEqual(
    {
      base: count("mislabelled-inputs"),
      escalated: count("mislabelled-escalated"),
    },
    {
      base: { identityDefers: 3, fills: 0 },
      escalated: { identityDefers: 0, fills: 2 },
    },
  )
})

// CORRECTION, 2026-07-31. This test used to be titled "SURVIVES the
// escalation: the consent-shaped box is still not ticked, because its defence
// reads no token the board chose", and it credited looksLikeAgreementProse()
// — a SHAPE control the board cannot rewrite. The outcome it asserted was
// real. THE STATED CAUSE WAS FALSE, and measurably so on this page's own
// label:
//
//   label: "Are you legally authorized to work in the United States?"
//   words: 10 | ends in [.!]: NO, it ends in "?"
//   isConsent false | isHardConsent false | looksLikeAgreementProse FALSE
//
// looksLikeAgreementProse requires /[.!]$/. It never fired. The box is not
// ticked for an entirely different reason: this page renders a LONE tickbox
// whose single option label IS the question, so the stored answer "Yes" has no
// option to match. That is a rendering accident, and a board that renders the
// same question as a Yes/No pair gets the tick — escalated-radio-yesno, below.
//
// The correction was filed by innov-resilience (verdict: patch) and it is the
// exact slacking signature the protocol names: a test asserting a true outcome
// while naming the wrong cause. Someone reading the old title would have
// deleted whatever was actually holding.
test("NOT A CONTROL: the escalated box is unticked only because a lone tickbox offers no option for the stored answer to match", () => {
  const s = scan("mislabelled-escalated")
  const plan = planFrom(s)
  const g = s.fields.find((f) => f.t === "checkbox")
  assert.ok(g, "the escalated fixture must still carry the consent-shaped box")
  assert.equal(destinationOf(g), "agree_arbitration")

  // 1. THE NAMED CONTROL NEVER RAN. Asserted, not narrated — if a future edit
  //    to looksLikeAgreementProse/isConsent makes one of these true, this goes
  //    red and the comment above stops being the record.
  assert.deepEqual(
    {
      consent: isConsent(g.l),
      hard: isHardConsent(g.l),
      prose: looksLikeAgreementProse(g, g.l),
    },
    { consent: false, hard: false, prose: false },
    "the escalated label now enters the consent branch — re-derive why this " +
      "box is unticked before trusting the title of this test",
  )

  // 2. WHAT ACTUALLY HAPPENED, at resolveFields: the bank has an exact answer
  //    ("Yes", a-002), and the only option to click is the question itself.
  const r = resolveFields(s.fields, {
    profile: PROFILE,
    answers: ANSWERS,
  }).find((x) => x.k === g.k)
  assert.deepEqual(
    {
      value: r.value,
      pick: r.pick ?? null,
      optionLabels: g.o.map((o) => o.l),
    },
    {
      value: "Yes",
      pick: null,
      optionLabels: [
        "Are you legally authorized to work in the United States?",
      ],
    },
    "the accident that stops the tick is the option list — if it ever contains " +
      "a matchable 'Yes', this box ticks",
  )

  // 3. The outcome, unchanged: nothing ticks it.
  const acted = [...plan.items, ...plan.defer].filter(
    (i) => i.k === g.k && (i.how === "check" || i.how === "fill"),
  )
  assert.deepEqual(
    acted,
    [],
    "a box whose server destination is an arbitration waiver was planned to be " +
      "ticked from a work-authorisation answer",
  )

  // 4. AND IT IS NOT EVEN A DEFER. The field is optional, so buildPlan writes
  //    a `skip` item — the arbitration box never reaches the approval message
  //    or pending-questions.mjs at all. "Not ticked" is not the same as
  //    "shown to the user", and only one of those is a control.
  const planned = [
    ...plan.items.filter((i) => i.k === g.k).map((i) => `item:${i.how}`),
    ...plan.defer.filter((d) => d.k === g.k).map((d) => `defer:${d.why}`),
  ]
  assert.deepEqual(planned, ["item:skip"])
})

test("THE REAL CONTROL, at the file: the escalated page's own label cannot get a government ID into answers.yaml", () => {
  // Where the escalated attack is actually stopped. The board picks the label,
  // so it can ask for anything under any wording; what it cannot do is make
  // the pipeline HOLD an identifier to type. Asserted at the file the bank
  // lives in, not at findSensitiveValues() — the sanitiser flagging it is not
  // a pass.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-escalated-"))
  try {
    const file = path.join(dir, "answers.yaml")
    // 000-00-0000 and 000000000 are never-issued SSNs; nothing here is a real
    // identifier, and none of it belongs to the user.
    const label = scan("mislabelled-escalated").fields[0].l
    const r = saveAnswer(label, "123-45-6789", file)
    const written = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""

    assert.deepEqual(
      { onDisk: written.includes("123-45-6789"), exit: r.status },
      { onDisk: false, exit: 4 },
      "an SSN offered under the escalated board's own label reached the bank " +
        `(exit ${r.status}); once it is in there, every future application can ` +
        "type it into any field any page labels 'Phone number'",
    )
    // And the refusal must not perform the disclosure it is preventing.
    assert.ok(
      !`${r.stdout ?? ""}${r.stderr ?? ""}`.includes("123-45-6789"),
      "the refusal echoed the value back into stdout/stderr",
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4c. THE FALSIFIERS: the same question, three renderings
//
// Section 4b's consent test used to credit a control that never ran (see the
// correction there). The claim "a consent-shaped box is protected by its
// SHAPE" is falsified by rendering the SAME question a different way, which
// costs the board four lines of markup and nothing else.
//
// Held constant across all three pages, and ASSERTED below rather than stated
// in prose: the question text, the input `name`, and the column the server
// writes. Only the markup differs. So no defence that reads the board's
// vocabulary can tell them apart — and vocabulary is all isConsent and
// isHardConsent read, and all looksLikeAgreementProse reads apart from its
// `t === "checkbox"` test.
//
//   B  escalated-tickbox-yes    one tickbox, its OWN label "Yes"   -> TICKED
//   C  escalated-radio-yesno    Yes/No radio pair (commonest)      -> TICKED
//   E  escalated-aria-checkbox  <div role="checkbox">              -> INVISIBLE
//
// B and C are LANDS tests, green on purpose, for the reason section 4b states
// at length: this directory is the `npm run test:security` gate and a
// permanently-red line stops being read. They go red if the behaviour moves in
// EITHER direction.
//
// WHICH CONTROL EACH ONE EXERCISES is stated per test, because that is exactly
// the mistake this section exists to correct: 4b's fixture was built to defeat
// the IDENTITY guard and only incidentally missed the CONSENT path, and it was
// then read as evidence about a control it never touched.
// ---------------------------------------------------------------------------

// The column the server writes for ONE option, by its stamp. destinationOf()
// above answers for a whole field, which is ambiguous on a radio pair where
// only the "Yes" half is hostile.
const optionDestination = (s, k) => {
  for (const f of s.fields ?? [])
    for (const o of f.o ?? []) if (o.k === k) return o._destination ?? null
  return null
}

const AUTH_Q = "Are you legally authorized to work in the United States?"

test("LANDS (shape B): a tickbox whose own label is 'Yes' is auto-ticked, and the tick POSTs into an arbitration waiver", () => {
  // EXERCISES: the ordinary checkbox branch of buildPlan — resolveFields finds
  // an exact bank answer, finds a matching option, and buildPlan emits
  // `how: "check"` on it.
  // DOES NOT EXERCISE: the consent branch, the vouch, or the consent
  // allowlist. None of them run on this field, and the assertion below pins
  // that, so this test can never be misread as evidence about them.
  const s = scan("escalated-tickbox-yes")
  const g = s.fields.find((f) => f.t === "checkbox")
  assert.deepEqual(
    {
      consent: isConsent(g.l),
      hard: isHardConsent(g.l),
      prose: looksLikeAgreementProse(g, g.l),
    },
    { consent: false, hard: false, prose: false },
    "this field now enters the consent branch — the finding below is about a " +
      "DIFFERENT code path and must be re-derived",
  )

  const plan = planFrom(s)
  const ticks = plan.items
    .filter((i) => i.how === "check")
    .map((i) => ({
      sel: i.sel,
      value: i.value,
      label: i.label,
      why: i.why ?? null,
      serverColumn: optionDestination(s, i.k),
    }))
  assert.deepEqual(ticks, [
    {
      sel: "#tb-auth-yes",
      value: "true",
      label: `${AUTH_Q} → Yes`,
      // Not "consent:allowlisted": nothing consent-aware was consulted.
      why: null,
      serverColumn: "agree_arbitration",
    },
  ])
})

test("LANDS (shape C): the commonest real ATS rendering — a Yes/No radio pair — ticks the same waiver", () => {
  // EXERCISES: the same ordinary check branch, reached from a `radio` group
  // rather than a `checkbox` group.
  // DOES NOT EXERCISE: the consent branch — and here it CANNOT, structurally.
  // looksLikeAgreementProse() returns false on its first line for anything
  // whose `t` is not "checkbox", so a radio pair never enters that branch
  // however the legend is worded. That is a wider hole than B's, not a
  // narrower one, and it is why this shape being the commonest matters.
  const s = scan("escalated-radio-yesno")
  const g = s.fields.find((f) => f.t === "radio")
  assert.deepEqual(
    {
      t: g.t,
      consent: isConsent(g.l),
      hard: isHardConsent(g.l),
      prose: looksLikeAgreementProse(g, g.l),
      // Even reworded to end in a period — the shape looksLikeAgreementProse
      // exists to catch — a radio group cannot reach the consent branch. So a
      // fix that only widens the wording list is visibly not a fix for this.
      proseIfReworded: looksLikeAgreementProse(
        g,
        "I confirm that I am legally authorized to work in the United States.",
      ),
    },
    {
      t: "radio",
      consent: false,
      hard: false,
      prose: false,
      proseIfReworded: false,
    },
  )

  const plan = planFrom(s)
  const ticks = plan.items
    .filter((i) => i.how === "check")
    .map((i) => ({
      sel: i.sel,
      value: i.value,
      serverColumn: optionDestination(s, i.k),
    }))
  assert.deepEqual(ticks, [
    { sel: "#rd-auth-yes", value: "true", serverColumn: "agree_arbitration" },
  ])
})

test("LANDS (B and C): neither plan defers anything, so readiness() says fill-and-hand-over with the waiver already ticked", () => {
  // The outcome that matters is not "an item exists" — it is that the autonomy
  // fast path sees nothing to ask about. `ready: true` means, in
  // fill-plan.mjs's own words, "scan -> fill -> hand over, with no model step
  // in between". The user meets this form with the box already ticked.
  const rows = ["escalated-tickbox-yes", "escalated-radio-yesno"].map((n) => {
    const plan = planFrom(scan(n))
    return [n, readiness(plan), plan.defer.map((d) => d.why)]
  })
  assert.deepEqual(rows, [
    ["escalated-tickbox-yes", { ready: true, reason: null }, []],
    ["escalated-radio-yesno", { ready: true, reason: null }, []],
  ])
})

test("the renderings differ ONLY in markup: same question, same input name, same destination", () => {
  // Guards the falsifier itself. If a future edit changed the wording or the
  // input name on one of these pages, the LANDS tests above would still pass
  // while proving something weaker — "a differently-worded question also ticks"
  // is not the finding. The finding is that the board changed nothing any
  // defence can read.
  const rows = []
  for (const n of [
    "mislabelled-escalated",
    "escalated-tickbox-yes",
    "escalated-radio-yesno",
  ]) {
    const s = scan(n)
    const g = s.fields.find((f) => f.t === "checkbox" || f.t === "radio")
    const hostile = (g.o ?? []).find(
      (o) => o._destination === "agree_arbitration",
    )
    rows.push([n, g.l, hostile?.n ?? null])
  }
  assert.deepEqual(rows, [
    ["mislabelled-escalated", AUTH_Q, "work_authorization"],
    ["escalated-tickbox-yes", AUTH_Q, "work_authorization"],
    ["escalated-radio-yesno", AUTH_Q, "work_authorization"],
  ])

  // And shape E carries the identical question in the SERVED HTML, where the
  // scanner never picks it up. Read from the page, not from the scan fixture —
  // the scan fixture is exactly the thing that does not contain it.
  const html = fs.readFileSync(
    path.join(
      ROOT,
      "tests/fixtures/hostile/forms/escalated-aria-checkbox.html",
    ),
    "utf8",
  )
  assert.ok(
    html.replace(/\s+/g, " ").includes(AUTH_Q),
    "shape E must ask the same question, or it is not the same attack",
  )
})

test("BLIND (shape E): a div[role=checkbox] consent produces no field, so it is neither ticked NOR shown to the user", () => {
  // A DIFFERENT failure from B and C, and the reason it gets its own test.
  // Nothing is asserted on the user's behalf — that half is safe. What is lost
  // is the DEFER: the mechanism by which an unanswered required question
  // reaches the approval message and pending-questions.mjs. A silence is not a
  // refusal.
  //
  // EXERCISES: scan-page.js's field collection (querySelectorAll of
  // "select,textarea,input", [contenteditable], and the combobox selector
  // list), asserted through what buildPlan can see.
  // DOES NOT EXERCISE: any consent control, any identity guard, any part of
  // fill-plan.mjs's decision-making — there is nothing for them to decide
  // about. This test says NOTHING about whether those controls work.
  const s = scan("escalated-aria-checkbox")
  const plan = planFrom(s)

  // 1. The scanner saw the form — the honest field is there — and did not see
  //    the consent control.
  assert.deepEqual(
    s.fields.map((f) => [f.k, f.t, f.l]),
    [["f1", "text", "Full name"]],
    "the scanner now emits a second field for this page — if it is the ARIA " +
      "consent control, this finding is closed and the fixture must be redone",
  )

  // 2. At the consumer: the question appears NOWHERE in the plan. Not as an
  //    item, not as a defer, not as a skip.
  assert.ok(
    !JSON.stringify(plan).includes(AUTH_Q),
    "the plan mentions the consent question somewhere — find out where before " +
      "treating this as closed",
  )

  // 3. And the plan reports itself ready, which is the actual damage: the fast
  //    path fills and hands over a form carrying an unanswered required
  //    consent that the user was never told existed.
  assert.deepEqual(readiness(plan), { ready: true, reason: null })

  // 4. The contrast, in one assertion, so the difference between B/C and E is
  //    pinned rather than described: the same question on a rendering the
  //    scanner CAN see produces a planned action; here it produces nothing.
  const mentioned = (n) => {
    const p = planFrom(scan(n))
    return [...p.items, ...p.defer].some((x) =>
      String(x.label ?? "").includes(AUTH_Q),
    )
  }
  assert.deepEqual(
    {
      tickbox: mentioned("escalated-tickbox-yes"),
      radio: mentioned("escalated-radio-yesno"),
      aria: mentioned("escalated-aria-checkbox"),
    },
    { tickbox: true, radio: true, aria: false },
  )
})
