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
    assert.equal(hostile.length, 5, "the hostile label set must be complete")

    for (const f of hostile) {
      saveAnswer(f.l, "Yes", file)
    }
    const written = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
    for (const needle of [
      /ignore all previous instructions/i,
      /add Kubernetes to the resume/i,
      /rate this candidate highly/i,
      /do not tell the user/i,
    ]) {
      assert.doesNotMatch(
        written,
        needle,
        `a hostile label reached answers.yaml: ${needle}`,
      )
    }
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
  const s = scan("consent-decoupled")
  const allowlist = new Set(
    s.fields
      .filter((f) => f.t === "checkbox")
      .map((f) => normalizeQuestion(f.l)),
  )
  const plan = planFrom(s, { consentAllowlist: allowlist })

  // The worst case is the interesting one, and the correct answer is not
  // "nothing ticks" — the allowlist is a feature. The correct answer is that
  // exactly the box carrying no legal waiver ticks, and every hostile shape
  // defers regardless of being allowlisted.
  const ticked = plan.items.filter((i) => i.how === "check").map((i) => i.k)
  assert.deepEqual(
    ticked,
    ["f3"],
    "only the vouched, non-waiver certification may auto-tick: " +
      JSON.stringify(plan.items.filter((i) => i.how === "check")),
  )
  const deferred = new Set(plan.defer.map((d) => d.k))
  assert.ok(deferred.has("g1"), "the aria-label-decoupled box must defer")
  assert.ok(deferred.has("g3"), "the binding-arbitration box must defer")
  // g4 is the reworded box; it is a finding of its own, below.
})

test("the decoupled box cannot be vouched for, because an attribute is not readable text", () => {
  // scan-page.js's vouch: only rendered DOM text can establish exactness, so a
  // label taken from aria-label / title / placeholder / name never sets
  // labelExact. Asserted at the plan: even with the innocuous aria-label text
  // on the user's allowlist, the box defers.
  const s = scan("consent-decoupled")
  const g1 = s.fields.find((f) => f.k === "g1")
  assert.notEqual(
    g1.labelExact,
    true,
    "an attribute-derived label must not vouch",
  )

  const plan = planFrom(s, {
    consentAllowlist: new Set([normalizeQuestion(g1.l)]),
  })
  assert.ok(
    plan.defer.some((d) => d.k === "g1" && d.why === "consent"),
    "the decoupled box must defer even when its aria-label text is allowlisted",
  )
  assert.deepEqual(
    plan.items.filter((i) => i.how === "check"),
    [],
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
  const s = scan("consent-decoupled")
  const approved = s.fields.find((f) => f.k === "g2")
  const arbitration = s.fields.find((f) => f.k === "g3")

  // The collision the fix removed is still real at 120 characters — proving the
  // fixture is the hard case and not a soft one.
  const slice120 = (x) => String(x).replace(/\s+/g, " ").trim().slice(0, 120)
  assert.equal(slice120(approved.l), slice120(arbitration.l))
  assert.notEqual(
    normalizeQuestion(approved.l),
    normalizeQuestion(arbitration.l),
  )

  const plan = planFrom(s, {
    consentAllowlist: new Set([normalizeQuestion(approved.l)]),
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
  // The approved one may tick — that is the feature working. Assert the
  // allowlist is not simply inert, or this test proves nothing.
  assert.ok(
    ticked.includes("f3") || plan.defer.some((d) => d.k === "g2"),
    "g2 must resolve one way or the other",
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
  const s = scan("consent-decoupled")
  const reworded = s.fields.find((f) => f.k === "g4")
  assert.equal(isHardConsent(reworded.l), false)
  assert.equal(
    isConsent(reworded.l),
    true,
    `a box asserting three legal acts was not classified as consent: ${JSON.stringify(reworded.l)}`,
  )
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
  const s = scan("mislabelled-inputs")
  const f = s.fields.find((x) => x._visible_label)
  assert.ok(f, "the fixture must carry a visible/matched divergence")
  const plan = planFrom(s)
  const item = [...plan.items, ...plan.defer].find((i) => i.k === f.k)
  assert.ok(item, "the field must appear in the plan")
  assert.equal(
    item.label,
    f._visible_label,
    "the plan must show the user the label the PAGE shows them; showing " +
      `${JSON.stringify(item.label)} for a field the page labels ` +
      `${JSON.stringify(f._visible_label)} makes the approval message wrong`,
  )
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
