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
import { answerClass, classifyAnswer } from "../../scripts/lib/untrusted.mjs"
import { loadYamlFile } from "../../scripts/lib/lib.mjs"
import { questionsFromPlans } from "../../scripts/apply/pending-questions.mjs"
import fillPage from "../../scripts/apply/fill-engine.mjs"
import {
  recordingPage,
  selectorsWritingTo,
  actionsAgainst,
} from "./engine-double.mjs"

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
  // It is still threaded through below even though buildPlan no longer reads
  // it for a grant (DELETED — see the consent branch's own "DELETED" comment
  // in scripts/apply/fill-plan.mjs): that is deliberate. Passing the worst-case
  // allowlist and asserting nothing ticks proves the defer is unconditional,
  // not merely untested with an allowlist absent.
  const raw = scan("consent-decoupled")
  const allowlist = new Set(
    raw.fields
      .filter((f) => f.t === "checkbox")
      .map((f) => normalizeQuestion(f.l)),
  )
  // The HONEST path: the vouch is lifted out of band, exactly as scanPage()
  // does it, so this exercises the pipeline as it actually delivers a scan.
  const { scan: s, vouchedLabels } = asScanned(raw)
  const plan = planFrom(s, { consentAllowlist: allowlist, vouchedLabels })

  // NOTHING TICKS, EVER — asserted first, ahead of the per-box deferral
  // checks below, for the same reason the comment this replaces gave: an
  // aborted test must not silently skip the property that matters most. This
  // used to read `ticked === ["f3"]` — the honest, no-waiver certification was
  // allowed to auto-tick from the allowlist. That grant was deleted outright
  // by w3-resolution + innov-resilience's blast-radius review (2026-08-01): it
  // was reachable the instant a caller supplied both `vouchedLabels` and
  // `consentAllowlist`, which is exactly what an in-process runner (or this
  // test) does. Rule 6 is "a consent box is the user's to tick, always, on any
  // path" — no exception for the box that happens to carry no legal waiver.
  const ticked = plan.items.filter((i) => i.how === "check").map((i) => i.k)
  assert.deepEqual(
    ticked,
    [],
    "a consent box auto-ticked even though nothing may, ever: " +
      JSON.stringify(plan.items.filter((i) => i.how === "check")),
  )
  const deferred = new Set(plan.defer.map((d) => d.k))
  const HOSTILE = {
    g1: "aria-label-decoupled",
    g3: "binding-arbitration past the 120-char cut",
    // HISTORICAL CONTEXT, now moot for ticking but still live for ROUTING.
    // w3-resolution's fix added "accept|affirm|attest" to isConsent, so this
    // box is now correctly recognised as consent at all — before that fix it
    // fell out of the consent branch entirely and was handled as an ordinary
    // checkbox, safe only by accident. It authorises a BACKGROUND
    // INVESTIGATION and adopts a document ELECTRONICALLY, which are two of the
    // three acts isHardConsent exists to exclude; its patterns are
    // "background (check|screening)" and "e-sign(ature)", so both wordings
    // walk straight past it. That gap in isHardConsent no longer lets this box
    // auto-tick — nothing does, since the grant itself is deleted — but it is
    // still the reason g4 depends on isConsent's routing rather than
    // isHardConsent's exclusion: had isConsent not been fixed, this box would
    // skip the consent branch and never defer, leaked instead as an ordinary
    // checkbox. "The 26th rewording is free" is about that routing gap, not
    // about ticking.
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

  // Then the box that used to be the exception: it must defer on the SAME
  // `why` as the hostile ones, not merely fail to tick by some other route
  // (e.g. falling out of the plan entirely, or resolving as "skip"). f3 is
  // the DOM checkbox the old grant checked; its group is g2 — the key the
  // consent branch actually defers on. If this ever ticks again, or defers
  // for a reason other than "consent", the grant is back in some form.
  assert.ok(
    plan.defer.some((d) => d.k === "g2" && d.why === "consent"),
    "the vouched, non-waiver certification must defer exactly like every " +
      `hostile box on this form: ${JSON.stringify(plan.defer)}`,
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
//   B  escalated-tickbox-yes    one tickbox, its OWN label "Yes"   -> was TICKED
//   C  escalated-radio-yesno    Yes/No radio pair (commonest)      -> was TICKED
//   E  escalated-aria-checkbox  <div role="checkbox">              -> was INVISIBLE
//
// CLOSED FOR E, 2026-07-31, BY A DIFFERENT MECHANISM AND IT IS WORTH SAYING
// WHICH. E was never a bad tick; it was a blindness — scan-page.js collected
// only from querySelectorAll("select,textarea,input"), [contenteditable] and
// its combobox list, so a div[role=checkbox] produced NO field and a required
// consent reached neither the tick path nor the defer path. w2-engine now
// emits it as `t: "aria-checkbox", widget: "aria"`, and the fix is that
// `aria-checkbox` is a type fill-plan.mjs has NO VERB FOR: it lands in the
// `unsupported field type` defer. Ticking one would need a CLICK, and the
// engine deliberately has no verb that clicks. THE DEFER IS THE FIX, not a
// placeholder for a fill path — asserted below at buildPlan AND at the engine,
// because "the scanner can see it now" is one consumer short of the point.
//
// CLOSED FOR B AND C, 2026-07-31. w1-security added answerClass() to
// scripts/lib/untrusted.mjs — an answer the user recorded is a `datum` (a fact:
// email, phone) or an `assertion` (work authorisation, relocation, background
// check, arbitration) — and w3-resolution wired it into resolveFields() in
// scripts/apply/fill-plan.mjs, which now stamps `status: "CONFIRM"` on any OK
// row resolved from an assertion-class bank entry, and into buildPlan(), which
// turns that into a `why: "confirm"` defer instead of an item.
//
// WHY THAT IS A FIX AND NOT THE 26TH PATTERN. It keys on what the USER
// recorded, in a file the board cannot write, and it reads `f.t`/`r.t`
// NOWHERE — which is the whole point of the B/C pair. Shape C exists precisely
// because a fix that branched on the widget would close B (a checkbox) and
// leave C (a radio pair) open, and the two tests below now assert that the
// identical treatment arrives at both.
//
// The three tests that pinned the landed attack were REWRITTEN to pin the fix,
// not flipped: each one now asserts at the fill ENGINE — no browser action is
// issued against the arbitration waiver — because "buildPlan emitted no check
// item" is one consumer short of the thing that matters. Canaried on
// 2026-07-31 by forcing answerClass() to return "datum" and, separately, by
// deleting buildPlan's CONFIRM branch; both make them red. See the report.
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

// THE CONSUMER, RUN. Builds the plan for a fixture and then hands it to the
// REAL fill engine against a recording page double, so the question a test asks
// is "what did the pipeline do to the browser?" rather than "what did a
// predicate return?".
//
// Every field of the returned record is evidence, and the tests below assert
// over the whole record in ONE deepEqual rather than in a sequence of checks.
// That is the rule this file earned twice in one day: an auxiliary assertion
// placed ahead of a finding assertion pre-empts it, and the finding then
// disappears behind a message about something else. It also removes the way
// this test could pass vacuously — `engineFilled` and `engineFailures` are in
// the same expectation as `waiverActions`, so an engine that bailed at the URL
// guard (and therefore touched nothing at all) fails instead of looking safe.
async function driveEngine(name) {
  const s = scan(name)
  const plan = planFrom(s)
  const page = recordingPage({ url: plan.urlGuard })
  const report = await fillPage(page, plan)
  const waiver = selectorsWritingTo(s, "agree_arbitration")
  return {
    scan: s,
    plan,
    page,
    report,
    waiverSelectors: [...waiver],
    // What the engine did to any control the server writes into
    // `agree_arbitration`. THE finding assertion, in every test below.
    waiverActions: actionsAgainst(page, waiver),
    // Proof the engine actually ran: the honest "Full name" datum is still
    // filled. A fix that deferred everything would be a regression, not a fix.
    engineFilled: page.actions
      .filter((a) => a.op === "fill")
      .map((a) => `${a.sel} = ${a.value}`),
    engineFailures: report.failures,
  }
}

test("FIX (shape B): a tickbox whose own label is 'Yes' is no longer ticked — the engine issues no action against the arbitration waiver", async () => {
  // EXERCISES: resolveFields()'s CONFIRM stamp (the answer for this question is
  // an assertion-class bank entry, a-002) and buildPlan()'s CONFIRM branch,
  // asserted through fill-engine.mjs — the last consumer before a real browser.
  // DOES NOT EXERCISE: the consent branch, the vouch, or the consent
  // allowlist. None of them run on this field. That is asserted AFTER the
  // finding, so this test can never be misread as evidence about them and the
  // characterisation can never pre-empt the security assertion.
  const d = await driveEngine("escalated-tickbox-yes")

  assert.deepEqual(
    {
      waiverActions: d.waiverActions,
      waiverSelectors: d.waiverSelectors,
      engineFilled: d.engineFilled,
      engineFailures: d.engineFailures,
    },
    {
      // Nothing. Not a check, not a click, not even a scroll.
      waiverActions: [],
      // The trap is armed: the fixture still carries a control the server
      // writes into an arbitration waiver. An empty list here would make the
      // line above meaningless.
      waiverSelectors: ["#tb-auth-yes"],
      // And the honest datum still lands, so this is a gate and not an outage.
      engineFilled: ["#tb-name = Jane Test"],
      engineFailures: [],
    },
    "a browser action reached the arbitration waiver, or the engine never ran",
  )

  // NOT TICKED IS NOT THE SAME AS SHOWN TO THE USER — section 4b's last test
  // records what that mistake looks like. The question must still reach the
  // approval message, carrying the value it WOULD have used and why it did not.
  assert.deepEqual(
    d.plan.defer.map((x) => ({
      k: x.k,
      why: x.why,
      value: x.value,
      pickSel: x.pickSel ?? null,
      classInfo: x.classInfo ?? null,
    })),
    [
      {
        k: "g1",
        why: "confirm",
        value: "Yes",
        pickSel: "#tb-auth-yes",
        classInfo: "assertion/inferred (work_authorization)",
      },
    ],
    "the deferred assertion must carry the value and the class to the user",
  )
  // And the plan must not ALSO contain an item for it — a defer beside a live
  // item would be the worst of both.
  assert.deepEqual(
    d.plan.items.filter((i) => i.k === "g1"),
    [],
  )

  // Characterisation last: which control did NOT do this. Nothing
  // consent-aware ran, so nobody can read the green above as evidence that
  // isConsent/isHardConsent/looksLikeAgreementProse were what stopped it.
  const g = d.scan.fields.find((f) => f.t === "checkbox")
  assert.deepEqual(
    {
      consent: isConsent(g.l),
      hard: isHardConsent(g.l),
      prose: looksLikeAgreementProse(g, g.l),
    },
    { consent: false, hard: false, prose: false },
    "this field now enters the consent branch too — re-derive WHICH control " +
      "is holding before trusting the title of this test",
  )
})

test("FIX (shape C): the commonest real ATS rendering — a Yes/No radio pair — is stopped by the same gate, because the gate never reads the widget", async () => {
  // THE POINT OF THE B/C PAIR, and the reason this is a separate test rather
  // than a second case in a loop. Shape C was built to defeat a fix that
  // branched on field type: looksLikeAgreementProse() returns false on its
  // first line for anything whose `t` is not "checkbox", so a radio pair can
  // never reach the consent branch however the legend is worded. Any fix that
  // lived in the consent path would close B and leave C open.
  //
  // The classifier gate keys on the class of the ANSWER THE USER RECORDED, so
  // both shapes resolve to the same a-002 entry and get identical treatment.
  const d = await driveEngine("escalated-radio-yesno")

  assert.deepEqual(
    {
      waiverActions: d.waiverActions,
      waiverSelectors: d.waiverSelectors,
      engineFilled: d.engineFilled,
      engineFailures: d.engineFailures,
    },
    {
      waiverActions: [],
      waiverSelectors: ["#rd-auth-yes"],
      engineFilled: ["#rd-name = Jane Test"],
      engineFailures: [],
    },
    "a browser action reached the arbitration waiver, or the engine never ran",
  )

  assert.deepEqual(
    d.plan.defer.map((x) => ({
      k: x.k,
      why: x.why,
      value: x.value,
      pickSel: x.pickSel ?? null,
      classInfo: x.classInfo ?? null,
    })),
    [
      {
        k: "g1",
        why: "confirm",
        value: "Yes",
        pickSel: "#rd-auth-yes",
        classInfo: "assertion/inferred (work_authorization)",
      },
    ],
  )
  assert.deepEqual(
    d.plan.items.filter((i) => i.k === "g1"),
    [],
  )

  // Characterisation last, as in B: the consent path still cannot see this
  // field, and could not even if the legend were reworded into agreement
  // prose. So the control that holds here is demonstrably not a wording list.
  const g = d.scan.fields.find((f) => f.t === "radio")
  assert.deepEqual(
    {
      t: g.t,
      consent: isConsent(g.l),
      hard: isHardConsent(g.l),
      prose: looksLikeAgreementProse(g, g.l),
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
})

test("FIX (B and C): both plans defer the assertion, so readiness() refuses the fill-and-hand-over fast path", async () => {
  // The outcome that matters is not only "no item exists" — it is that the
  // autonomy fast path no longer sees a form with nothing to ask about.
  // `ready: true` means, in fill-plan.mjs's own words, "scan -> fill -> hand
  // over, with no model step in between"; before the fix the user met this
  // form with the waiver already ticked.
  //
  // A "confirm" defer blocks ready, unlike a "consent" defer, and the two
  // shapes are asserted TOGETHER in one deepEqual so that a fix for one cannot
  // hide the other — and so that the engine evidence for both sits in the same
  // expectation as the readiness verdict.
  const rows = []
  for (const n of ["escalated-tickbox-yes", "escalated-radio-yesno"]) {
    const d = await driveEngine(n)
    rows.push([
      n,
      readiness(d.plan),
      d.plan.defer.map((x) => x.why),
      d.waiverActions,
      d.report.ok,
    ])
  }
  assert.deepEqual(rows, [
    [
      "escalated-tickbox-yes",
      { ready: false, reason: "1 deferred field(s) need a human" },
      ["confirm"],
      [],
      1,
    ],
    [
      "escalated-radio-yesno",
      { ready: false, reason: "1 deferred field(s) need a human" },
      ["confirm"],
      [],
      1,
    ],
  ])
})

test("FIX (B and C): a confirm defer is reviewed once, not re-asked forever — asserted at pending-questions.mjs", async () => {
  // THE SECOND CONSUMER of a defer, and the one where a wrong choice of status
  // would have been expensive rather than unsafe. answers.yaml is GLOBAL: a
  // question routed through UNKNOWN is asked, answered, and never asked again —
  // so re-routing an assertion the user ALREADY recorded through UNKNOWN would
  // re-ask it on every future application, forever, and the obvious way to stop
  // the nagging would be to re-approve it into the bank, which is where it
  // already is. CONFIRM is a distinct status for exactly that reason.
  //
  // Asserted at the consumer rather than at the comment that claims it:
  // questionsFromPlans() is what builds the batched question list.
  const plans = ["escalated-tickbox-yes", "escalated-radio-yesno"].map((n) => ({
    slug: n,
    plan: planFrom(scan(n)),
  }))
  assert.deepEqual(
    {
      deferWhy: plans.flatMap((p) => p.plan.defer.map((d) => d.why)),
      asked: questionsFromPlans(plans).map((q) => q.label),
    },
    {
      // The trap is armed: there ARE defers.
      deferWhy: ["confirm", "confirm"],
      // And none of them is turned into a question to ask the user again.
      asked: [],
    },
    "a confirm defer became a pending question — it will be re-asked on every " +
      "future application to a board that renders this question",
  )
})

test("FIX (B and C): the gate keys on the recorded ANSWER, not on the widget the board chose", async () => {
  // The structural claim, asserted rather than argued. Both fixtures resolve to
  // the SAME answers.yaml entry (a-002) through the same exact-label match, and
  // the classifier's verdict is identical across a `checkbox` and a `radio` —
  // the two renderings the board can freely swap between. If a future edit made
  // this gate consult `f.t` or `r.t`, these two rows would stop agreeing.
  const rows = []
  for (const n of ["escalated-tickbox-yes", "escalated-radio-yesno"]) {
    const s = scan(n)
    const r = resolveFields(s.fields, {
      profile: PROFILE,
      answers: ANSWERS,
    }).find((x) => x.k === "g1")
    rows.push([
      n,
      s.fields.find((f) => f.k === "g1").t,
      r.status,
      r.source,
      r.classDescription ?? null,
    ])
  }
  assert.deepEqual(rows, [
    [
      "escalated-tickbox-yes",
      "checkbox",
      "CONFIRM",
      "a-002@exact",
      "assertion/inferred (work_authorization)",
    ],
    [
      "escalated-radio-yesno",
      "radio",
      "CONFIRM",
      "a-002@exact",
      "assertion/inferred (work_authorization)",
    ],
  ])

  // And the honest datum on the SAME form is untouched by the gate: a fix that
  // deferred every field would pass every assertion above and be useless.
  const honest = resolveFields(scan("escalated-tickbox-yes").fields, {
    profile: PROFILE,
    answers: ANSWERS,
  }).find((x) => x.k === "f1")
  assert.deepEqual(
    { status: honest.status, source: honest.source },
    { status: "OK", source: "contact.name" },
  )
})

// ---------------------------------------------------------------------------
// 4d. THE REWORDING HOLE, CLOSED STRUCTURALLY (2026-07-31, second fix)
//
// HISTORY, because the shape of this correction is the finding. Section 4c's
// class gate closed shapes B and C by reading the CLASS OF THE ANSWER. It was
// the right axis and it is still in force — but answerClass() has two legs, and
// the leg every real fact-base entry takes (`inferred`) is classifyAnswer(), a
// regex list over the recorded question. So this file carried a LANDS test:
// a work-authorisation assertion the user had banked under a wording the list
// misses ("Do you now, or will you in the future, need immigration support?")
// was inferred `datum`, and the arbitration waiver was ticked again.
//
// MEASURED by innov-resilience against the real 49-entry fact base, on a page
// whose labels were all wordings the user had banked, every option wired to
// `agree_arbitration`: 34 of 49 entries auto-ticked with `ready: true` and no
// model step. The class gate that shipped in d945871 removed 14 of 48 (29%).
// RECLASSIFYING CLOSES NONE OF THE REMAINING 34 — they are honestly-classified
// data (Country, Gender, Veteran Status), correctly `datum`, and a better
// pattern list makes that number worse, not better.
//
// THE FIX (w3-resolution, scripts/apply/fill-plan.mjs, buildPlan's check-verb
// branch): a checkbox or radio group never auto-acts unattended, whatever the
// answer's class. A tick carries no value — it carries ASSENT, on a control the
// BOARD owns. The defer is `why: "confirm-widget"`, deliberately a different
// string from the class gate's `why: "confirm"`.
//
// WHY IT IS STRUCTURAL AND THE FOUR DEFENCES BEFORE IT WERE NOT: THE RULE READS
// NO WORDS. isConsent, isHardConsent, looksLikeAgreementProse and
// classifyAnswer each read one string the attacker chose, so each had a 26th
// rewording. This one decides on the widget's SHAPE, which is not a string at
// all. The tests below are written to pin exactly that property — a wording no
// pattern list has ever seen, and a wording where every word-reading control
// has been explicitly overridden, must both be stopped.
// ---------------------------------------------------------------------------

// tests/fixtures/hostile/answers-unseen-wordings.yaml — five bank entries, all
// answered "Yes" (so all five MATCH an option on shapes B and C), all carrying
// a DECLARED `class: datum` / `class_source: user`, which is the one leg of
// answerClass() that consults no pattern at all. See that file's header for
// what each row is for; w1 and w5 are the two that matter.
const UNSEEN_BANK = path.join(
  ROOT,
  "tests/fixtures/hostile/answers-unseen-wordings.yaml",
)
const UNSEEN = loadYamlFile(UNSEEN_BANK).answers

// The board's ONE genuine lever: it cannot rewrite the fact base, but it can
// render, verbatim, a question the user has already banked. So the page label
// becomes the stored wording and nothing else about the page changes — same
// option, same input name, same `agree_arbitration` column.
async function driveWording(shapeName, question, { req = false } = {}) {
  const s = scan(shapeName)
  const g = s.fields.find((f) => f.k === "g1")
  g.l = question
  if (req) g.req = true
  const resolved = resolveFields(s.fields, {
    profile: PROFILE,
    answers: UNSEEN_BANK,
  })
  const plan = buildPlan({ scan: s, resolved, adapter: GENERIC, url: s.url })
  const page = recordingPage({ url: plan.urlGuard })
  await fillPage(page, plan)
  const d = plan.defer.find((x) => x.k === "g1")
  return {
    resolved: resolved.find((r) => r.k === "g1"),
    plan,
    defer: d,
    waiverActions: actionsAgainst(
      page,
      selectorsWritingTo(s, "agree_arbitration"),
    ),
    honestFills: page.actions
      .filter((a) => a.op === "fill")
      .map((a) => `${a.sel} = ${a.value}`),
    ready: readiness(plan).ready,
  }
}

test("FIX (shapes B/C): no wording ticks the waiver — five bank wordings, both renderings, asserted at fill-engine.mjs", async () => {
  // THE FINDING ASSERTION for the rewording hole, and it is deliberately a
  // SWEEP rather than one case: the claim being pinned is about a CLASS of
  // attack ("any wording"), so one wording would record only that today's code
  // passes. Ten rows, one deepEqual, so a fix for one row cannot hide another.
  //
  // Each row carries four things at once, and every one of them is load-bearing:
  //
  //   status "OK"        the row RESOLVED. Without this the test could pass
  //                      because nothing matched, which is not the fix.
  //   pick "f2"          and it resolved to the hostile option specifically —
  //                      the pipeline knew exactly which box it would have
  //                      ticked and declined to tick it.
  //   why "confirm-widget"   stopped by the WIDGET rule, not by the class gate
  //                      ("confirm") and not by an unrelated guard.
  //   waiverActions []   THE OUTCOME. No browser action of any kind reached a
  //                      control the server writes into `agree_arbitration`.
  //
  // A word-reading exemption reintroduced anywhere on this path turns w5 (and
  // probably w1) red, because neither has any word left for a defence to read.
  const rows = []
  for (const shape of ["escalated-tickbox-yes", "escalated-radio-yesno"]) {
    for (const e of UNSEEN) {
      const d = await driveWording(shape, e.question)
      rows.push([
        shape,
        e.id,
        d.resolved.status,
        d.defer?.why ?? null,
        d.defer?.pick ?? null,
        d.waiverActions,
      ])
    }
  }
  const expected = []
  for (const shape of ["escalated-tickbox-yes", "escalated-radio-yesno"]) {
    for (const e of UNSEEN) {
      expected.push([shape, e.id, "OK", "confirm-widget", "f2", []])
    }
  }
  assert.deepEqual(
    rows,
    expected,
    "a wording reached the arbitration waiver — the check-verb rule in " +
      "buildPlan() has started reading words again, or an exemption was added",
  )
  assert.equal(
    UNSEEN.length,
    5,
    "the wording set shrank — the sweep above got easier",
  )
})

test("FIX (shapes B/C): the rule reads NO WORDS — w1 is an honest datum and w5 has every word-reading control switched off", () => {
  // WHY THE SWEEP ABOVE IS NOT MERELY "the pattern list got better".
  // Characterisation, placed AFTER the finding for this file's usual reason.
  //
  // w1 is an ordinary preference question with an ordinary "Yes". classifyAnswer
  // is RIGHT to call it a datum, so no classifier improvement could ever stop
  // it — that is innov-resilience's 34-of-49 in one row.
  //
  // w5 is the ceiling: classifyAnswer DOES match it (work_authorization), and a
  // declared `class: datum` from the USER overrides that, taking the leg of
  // answerClass() that reads no pattern. Every word-reading control in the
  // repository is either silent or overridden on w5, and it is still stopped.
  const rows = UNSEEN.map((e) => [
    e.id,
    classifyAnswer(e.question, e.answer).class,
    answerClass(e).class,
    answerClass(e).source,
  ])
  assert.deepEqual(rows, [
    // inferred datum AND declared datum: nothing to read, nothing to override.
    ["w1", "datum", "datum", "user"],
    ["w2", "datum", "datum", "user"],
    ["w3", "datum", "datum", "user"],
    ["w4", "datum", "datum", "user"],
    // the pattern list fires and is overridden by the user's own declaration.
    ["w5", "assertion", "datum", "user"],
  ])
})

test("FIX (shapes B/C): the axis is the WIDGET, not the words — the same entry in a TEXT input still fills", async () => {
  // THE ANTI-REGRESSION THAT MATTERS MOST, and the one a flipped `ok`/`not ok`
  // could never record. "No action reached the waiver" is also satisfied by a
  // rule that refuses to fill anything work-authorisation-shaped — which would
  // be a word-reading rule wearing the fix's name, and would have a 26th
  // rewording like all the others.
  //
  // So: same page, same stored entry (w5), same question text, same resolved
  // value "Yes", same `agree_arbitration` destination. Only the WIDGET differs.
  // A text input fills; the checkbox and the radio group never act. If these two
  // halves ever agree, the decision has moved off the widget and back onto the
  // text, and this test is the alarm.
  const q = UNSEEN.find((e) => e.id === "w5").question

  const s = scan("escalated-tickbox-yes")
  const i = s.fields.findIndex((f) => f.k === "g1")
  // The identical question rendered as the plainest possible control. `n` and
  // `_destination` are unchanged, so fieldIdentityMismatch() is not what
  // decides this either.
  s.fields[i] = {
    k: "g1",
    t: "text",
    sel: "#tb-auth-text",
    n: "work_authorization",
    l: q,
    _destination: "agree_arbitration",
  }
  const resolved = resolveFields(s.fields, {
    profile: PROFILE,
    answers: UNSEEN_BANK,
  })
  const plan = buildPlan({ scan: s, resolved, adapter: GENERIC, url: s.url })
  const page = recordingPage({ url: plan.urlGuard })
  await fillPage(page, plan)

  const widget = await driveWording("escalated-tickbox-yes", q)
  assert.deepEqual(
    {
      textStatus: resolved.find((r) => r.k === "g1").status,
      textActions: actionsAgainst(
        page,
        selectorsWritingTo(s, "agree_arbitration"),
      ),
      widgetStatus: widget.resolved.status,
      widgetActions: widget.waiverActions,
    },
    {
      // Identical resolution on both sides. The ONLY difference downstream is
      // the widget, and it is the whole difference.
      textStatus: "OK",
      textActions: ["scroll #tb-auth-text", "fill #tb-auth-text = Yes"],
      widgetStatus: "OK",
      widgetActions: [],
    },
    "the text and widget halves stopped disagreeing — either the rule now " +
      "reads the question text (a word-reading rule in the fix's clothing), " +
      "or it stopped covering the widget",
  )
})

test("FIX (shapes B/C): readiness() exempts ONLY a non-required confirm-widget — a required one still blocks the fast path", async () => {
  // THE FROZEN CONTRACT, at its consumer. `ready: true` is fill-plan.mjs's own
  // "scan -> fill -> hand over, with no model step in between", so what it does
  // with a confirm-widget defer decides whether the user meets this form with
  // the box already ticked (it is not — waiverActions is [] above), whether they
  // meet it at all, and whether the pipeline pays a model turn to ask.
  //
  // Both halves are asserted TOGETHER because the trap innov-resilience caught
  // before landing is exactly a half-fix: an earlier draft keyed the exemption
  // on `why === "confirm"`, the CLASS GATE's marker, and silently re-marked an
  // unreviewed work-authorisation defer as `ready: true`. The `confirm` row
  // below is that trap, armed — it must stay blocking, unconditionally, with no
  // `req` escape.
  const rows = []
  for (const shape of ["escalated-tickbox-yes", "escalated-radio-yesno"]) {
    for (const req of [false, true]) {
      const d = await driveWording(shape, UNSEEN[0].question, { req })
      rows.push([shape, `req=${req}`, d.defer.why, d.ready])
    }
  }
  // And the class gate's own marker on the SAME pages, which readiness() must
  // keep treating differently: NOT required, and still blocking.
  const classGate = ["escalated-tickbox-yes", "escalated-radio-yesno"].map(
    (n) => {
      const p = planFrom(scan(n))
      return [n, "req=false", p.defer[0].why, readiness(p).ready]
    },
  )
  assert.deepEqual(
    [...rows, ...classGate],
    [
      // The box sits there unticked for the user to review before Submit, at
      // zero extra model turns — same treatment as a consent box.
      ["escalated-tickbox-yes", "req=false", "confirm-widget", true],
      // The form insists on an answer and nobody has reviewed one, so it blocks.
      ["escalated-tickbox-yes", "req=true", "confirm-widget", false],
      ["escalated-radio-yesno", "req=false", "confirm-widget", true],
      ["escalated-radio-yesno", "req=true", "confirm-widget", false],
      // The trap: a `confirm` defer is NOT required here and is still blocking.
      ["escalated-tickbox-yes", "req=false", "confirm", false],
      ["escalated-radio-yesno", "req=false", "confirm", false],
    ],
    "readiness() changed how it treats a confirm/confirm-widget defer — if the " +
      "two markers have been merged, an unreviewed assertion is now ready:true",
  )
})

test("FIX (shapes B/C): the widget rule did not turn into 'defer everything' — the honest datum on the same page still fills", async () => {
  // The regression a defer-shaped fix invites, and the reason every assertion
  // above sits in a deepEqual with evidence the engine ran at all. A pipeline
  // that defers every field passes every security assertion in this section and
  // is useless.
  const d = await driveWording(
    "escalated-tickbox-yes",
    UNSEEN.find((e) => e.id === "w5").question,
  )
  assert.deepEqual(
    { fills: d.honestFills, deferred: d.plan.defer.map((x) => x.k) },
    { fills: ["#tb-name = Jane Test"], deferred: ["g1"] },
  )
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

  // And shape E carries the identical question. Read from the SERVED HTML as
  // well as the scan: while the scanner was blind to this control the page was
  // the only place the question existed, and keeping the page assertion means
  // the fixture can never be the sole witness that shape E is the same attack.
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
  assert.deepEqual(
    scan("escalated-aria-checkbox")
      .fields.filter((f) => f.l === AUTH_Q)
      .map((f) => [f.t, f.widget ?? null]),
    [["aria-checkbox", "aria"]],
    "shape E's control must still be the ARIA one and must still be SEEN — " +
      "the served page and the scan must agree on which question is asked",
  )
})

test("FIX (shape E): a div[role=checkbox] consent reaches the user as a DEFER, and the plan stops calling itself ready", () => {
  // REPLACED the BLIND (shape E) test on 2026-07-31, when w2-engine's scanner
  // fix landed. BLIND asserted the ABSENCE of a field on purpose, so that a
  // scanner fix would turn it red and the finding would be re-derived rather
  // than silently closed. That is what happened; this is the re-derivation.
  //
  // WHAT WAS LOST BEFORE, and what this now asserts is recovered: not the tick
  // (nothing was ever ticked here — that half was always safe) but the DEFER,
  // the mechanism by which an unanswered required question reaches the approval
  // message and pending-questions.mjs. A silence is not a refusal.
  //
  // EXERCISES: scan-page.js's ARIA-widget collection, and buildPlan's
  // unsupported-type branch, asserted at the plan.
  // DOES NOT EXERCISE: the class gate (answerClass) or the widget rule that
  // closed B and C. Shape E never reaches them — it is refused one step
  // earlier, for having no verb. A green here is NOT evidence about those two.
  const s = scan("escalated-aria-checkbox")
  const plan = planFrom(s)

  // 1. The scanner sees the form AND the consent control, and reports the
  //    control's ARIA facts: its accessible name and that it is required.
  assert.deepEqual(
    s.fields.map((f) => [f.k, f.t, f.l, f.req ?? false, f.widget ?? null]),
    [
      ["f1", "text", "Full name", false, null],
      ["f2", "aria-checkbox", AUTH_Q, true, "aria"],
    ],
    "shape E's scan changed. If the ARIA control has stopped being emitted, " +
      "the blindness is BACK and this is a regression, not a fixture drift",
  )

  // 2. At the consumer, in one record: the question is a DEFER with a stated
  //    reason, it is not an item, it is not a silent skip, and the deferral
  //    propagates to readiness — so the fast path can no longer fill and hand
  //    over a form carrying an unanswered required consent.
  const labelled = (x) => String(x.label ?? "").includes(AUTH_Q)
  assert.deepEqual(
    {
      defer: plan.defer.filter(labelled).map((d) => [d.k, d.why]),
      items: plan.items.filter(labelled).map((i) => [i.k, i.how]),
      readiness: readiness(plan),
      // Proof the plan is not empty, so none of the above is vacuous.
      honestItems: plan.items.map((i) => `${i.sel} = ${i.value}`),
    },
    {
      defer: [["f2", "unsupported field type aria-checkbox"]],
      items: [],
      readiness: { ready: false, reason: "1 deferred field(s) need a human" },
      honestItems: ["#ar-name = Jane Test"],
    },
    "the ARIA consent must be deferred with a reason. An item of ANY verb, a " +
      "silent skip, or ready:true is a regression",
  )

  // 3. The contrast, in one assertion, so the difference between B/C and E is
  //    pinned rather than described: all three renderings of the SAME question
  //    now reach the user, and none of them reaches the browser.
  const treatment = (n) => {
    const p = planFrom(scan(n))
    return {
      deferred: p.defer.filter(labelled).map((d) => d.why),
      acted: p.items.filter(labelled).map((i) => i.how),
    }
  }
  assert.deepEqual(
    {
      tickbox: treatment("escalated-tickbox-yes"),
      radio: treatment("escalated-radio-yesno"),
      aria: treatment("escalated-aria-checkbox"),
    },
    {
      tickbox: { deferred: ["confirm"], acted: [] },
      radio: { deferred: ["confirm"], acted: [] },
      aria: { deferred: ["unsupported field type aria-checkbox"], acted: [] },
    },
    "the three renderings must all defer. The REASONS differ on purpose and " +
      "collapsing them would hide which defence is actually load-bearing: B " +
      "and C are stopped HERE by the CLASS gate (`confirm`), because the " +
      "default bank answers this question with an assertion-class entry and " +
      "that gate fires first; section 4d re-runs the same two shapes against " +
      "wordings the class gate MISSES and gets `confirm-widget` from the " +
      "widget rule behind it. E is stopped by neither — it has no verb.",
  )
})

test("FIX (shape E) AT THE ENGINE: the visible ARIA consent control is deferred, and no browser action is ever issued against it", async () => {
  // WRITTEN BEFORE THE FIX, ON PURPOSE, and LIVE since 2026-07-31. This is the
  // sequencing argument that put shape E behind the classifier rather than in
  // front of it: making a control VISIBLE before it can DEFER converts a
  // blindness into a bad tick. So the assertion was armed while the scanner was
  // still blind, and it passed in that world for a stated reason rather than
  // by accident. w2-engine's scanner fix landed; this is now the live test.
  //
  // HOW IT BEHAVES IN EACH WORLD — the expectation is DERIVED from what the
  // scanner emits, so one test covers all of them:
  //   visible and deferred   scannerSees=true  -> expect no action, a defer   PASS
  //   visible and TICKED     acted is non-empty                               FAIL
  //   visible and SKIPPED    scannerSees=true, no defer                       FAIL
  //   invisible again        scannerSees=false                                FAIL
  // The last two rows are the ones worth stating out loud. A scanner that sees
  // the control and produces a silent `skip` item is NOT a fix — section 4b's
  // last test is the record of that mistake being made once already. And a
  // REGRESSION to blindness now fails here too: `scannerSees` was derived on
  // both sides of the deepEqual while the finding was open, which is what let
  // one test cover the before and the after, but leaving it derived after the
  // fix would let the pipeline go blind again silently. It is pinned `true`.
  //
  // `scannerSees` is not self-certifying. It is a fact about the scan fixture,
  // and tests/security/scan-fidelity.test.mjs holds that fixture to what the
  // real scan-page.js produces for the served page — so this cannot be made to
  // pass by editing the fixture alone. I own the fixture; I do not own
  // scan-page.js, and I have not touched it.
  //
  // CANARIED 2026-07-31 (pre-fix), three worlds, by temporarily adding a group
  // the scanner did not yet emit and (where stated) forcing the classifier to
  // "datum". Both mutations were reverted and verified byte-identical by md5.
  //   1. visible + gate intact ................................ PASS
  //   2. visible + gate broken + a matchable "Yes" option ...... FAIL
  //      (`acted: ["scroll #ar-auth-yes", "check #ar-auth-yes"]` — so the
  //       assertion is armed, and it catches the tick at the ENGINE)
  //   3. visible + gate broken, but the control's ONLY option label is the
  //      question itself ...................................... PASS
  //
  // RE-CANARIED 2026-07-31 (post-fix) against the shape the scanner ACTUALLY
  // emits — a single `t: "aria-checkbox"` field with no options — by deleting
  // buildPlan's unsupported-type defer: `deferred` goes false and this test
  // goes red. So the defer leg is armed against the real shape, not only
  // against the hypothetical one the pre-fix canary used.
  //
  // WHAT THIS TEST DOES NOT PROVE, and world 3 above is why. The emitted field
  // carries NO options, so there is nothing for a stored "Yes" to match even if
  // every gate were removed. `acted: []` is therefore evidence that the plan
  // issued no action, not evidence that the classifier would have refused one.
  // The tick leg for this exact question is covered by shapes B and C, which do
  // carry matchable options.
  const s = scan("escalated-aria-checkbox")
  const isAuth = (f) =>
    String(f.l ?? "")
      .replace(/\s+/g, " ")
      .includes(AUTH_Q)
  const authField = (s.fields ?? []).find(isAuth)
  const scannerSees = Boolean(authField)

  // Every selector belonging to that control — the field itself and every
  // option under it. Non-empty now that the control is visible, which is what
  // makes `acted: []` mean "the engine touched nothing of it" rather than
  // "there was nothing to touch".
  const sels = new Set()
  if (authField) {
    if (authField.sel) sels.add(authField.sel)
    for (const o of authField.o ?? []) if (o.sel) sels.add(o.sel)
  }

  const plan = planFrom(s)
  const page = recordingPage({ url: plan.urlGuard })
  const report = await fillPage(page, plan)

  const labelled = (x) => String(x.label ?? "").includes(AUTH_Q)
  assert.deepEqual(
    {
      scannerSees,
      // Every selector of the control is known, so this is a real search.
      watched: [...sels].sort(),
      acted: actionsAgainst(page, sels),
      deferred: plan.defer.some(labelled),
      skippedSilently: plan.items.some((i) => i.how === "skip" && labelled(i)),
      // Proof the engine ran at all, so `acted: []` is never vacuous.
      engineFilled: page.actions
        .filter((a) => a.op === "fill")
        .map((a) => `${a.sel} = ${a.value}`),
      engineFailures: report.failures,
    },
    {
      // Pinned, not derived: a regression to blindness fails here.
      scannerSees: true,
      watched: ["#ar-auth"],
      acted: [],
      // The load-bearing line: the scanner sees it, so it MUST be deferred.
      deferred: true,
      skippedSilently: false,
      engineFilled: ["#ar-name = Jane Test"],
      engineFailures: [],
    },
    "the ARIA consent control must reach the user as a defer and must never be " +
      "acted on. A tick, a silent skip, or the scanner going blind to it again " +
      "are all regressions.",
  )
})
