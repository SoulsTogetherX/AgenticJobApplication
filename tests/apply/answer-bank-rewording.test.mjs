// The token tier's morphological folding, and the two guards that pay for it.
//
// THE BUG, measured 2026-08-19 on a live Torc Robotics Greenhouse form. The
// fact base held "What is your earliest available start date / notice period?";
// the form asked "What is your availability or desired start date?*". Those are
// the same question, but the token tier compared raw words: `available` and
// `availability` are different strings, so three of the label's five content
// tokens matched instead of four and the pair scored 0.54 — under the 0.7 gate.
// The field deferred, and on the unattended path a deferred required field is a
// whole application not sent. The workaround at the time was to bank the form's
// exact phrasing a second time, which does not scale: every board words this
// question its own way.
//
// THE FIX is a suffix-only stemmer. THE PRICE is that folding makes weak
// coincidences match too, so two guards land with it, and most of this file
// pins those rather than the fix:
//
//   * the containment shortcut (which divides by the SHORTER side and so can
//     reach 0.9 on a single shared token) now needs either two shared stems or
//     one token shared LITERALLY — measured, the label "State" folded onto the
//     "States" of an unrelated banked question and scored 0.90;
//   * a bare yes/no banked answer is capped at MAYBE when the label and the
//     banked question disagree in negation parity, because a bag of words has
//     no truth value and that answer is nothing but one.
import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { stem } from "../../src/apply/answer-bank.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const FIXTURES = path.join(ROOT, "tests", "fixtures")

function resolveAll(fields) {
  const res = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "src", "apply", "answer-bank.mjs"),
      "--fields",
      JSON.stringify(fields),
      "--profile",
      path.join(FIXTURES, "profile.yaml"),
      "--answers",
      path.join(FIXTURES, "answers-rewording.yaml"),
      "--json",
    ],
    { cwd: ROOT, encoding: "utf8" },
  )
  assert.equal(res.status, 0, res.stderr)
  const byKey = new Map()
  for (const r of JSON.parse(res.stdout).results) byKey.set(r.k, r)
  return byKey
}

const one = (label, extra = {}) =>
  resolveAll([{ k: "f", t: "text", l: label, req: true, ...extra }]).get("f")

const yesNo = (label) =>
  resolveAll([
    { k: "f", t: "radio", l: label, opts: ["Yes", "No"], req: true },
  ]).get("f")

// ---------------------------------------------------------------------------
// THE MATCH
// ---------------------------------------------------------------------------

test("THE BUG: a reworded start-date field resolves from the banked phrasing", () => {
  const r = one("What is your availability or desired start date?*")
  assert.equal(r.status, "OK", `deferred with ${r.source}: ${r.note ?? ""}`)
  assert.equal(r.value, "Available immediately; two weeks notice if required")
  assert.match(r.source, /^a-001@/)
})

test("MEASURED: the same pair scored 0.54 unfolded and clears the gate folded", () => {
  // Pinning the NUMBER, not just the tier, so a later change to the scoring
  // function cannot leave this passing by a hair without anyone noticing.
  const r = one("What is your availability or desired start date?")
  assert.equal(r.source, "a-001@0.72")
})

test("BOUNDARY: folding does not make every question about dates match", () => {
  // Shares "start" and "date" with a-001 after folding and little else. The
  // failure direction this file always takes is that nothing matched.
  const r = one("On what date did you start your most recent role?")
  assert.notEqual(r.status, "OK", `filled ${r.value} from ${r.source}`)
})

// ---------------------------------------------------------------------------
// POLARITY — the inversion boundary
// ---------------------------------------------------------------------------

test("BOUNDARY: a negated rewording does NOT copy the bare yes/no answer out", () => {
  // The documented hazard, in the shape that survives the closed intent set:
  // the banked question sits ENTIRELY inside the label, so containment scores
  // it 0.9 and the only thing between "Yes" and a field that means the opposite
  // is the parity check. `without` is the whole difference.
  const r = yesNo("Will you be able to commute to our office without a car?")
  assert.notEqual(r.status, "OK", `auto-filled ${r.value} from ${r.source}`)
  assert.equal(r.status, "MAYBE")
  // The user still sees the candidate, and sees WHY it was not used.
  assert.match(r.note, /opposite polarity/)
})

test("SUCCESS SIDE: the same question at the same polarity still resolves", () => {
  // Without this, "the guard defers everything" would pass the test above.
  const r = yesNo("Will you be able to commute to our office each week?")
  assert.equal(r.status, "OK", `deferred with ${r.source}: ${r.note ?? ""}`)
  assert.equal(r.value, "Yes")
})

test("BOUNDARY: polarity is PARITY — two negations read as none", () => {
  // "not ... without" is the positive again. A counter rather than a parity
  // check would defer this: a wrong answer in the safe direction, which still
  // costs an application.
  const r = yesNo(
    "Will you be able to commute to our office if you could not get there without notice?",
  )
  assert.equal(r.status, "OK", `deferred with ${r.source}: ${r.note ?? ""}`)
  assert.equal(r.value, "Yes")
})

test("BOUNDARY: an incidental 'not' does not demote a SUBSTANTIVE answer", () => {
  // MEASURED: an unscoped parity check demoted four real, correct matches on
  // the live fact base, this shape among them. "Bachelor's degree" is the same
  // answer whichever way the question is put — only a bare yes/no can be
  // inverted by a rewording, so only a bare yes/no is guarded.
  const r = one(
    "What is the highest level of education completed? Do not include degrees that are in progress.",
  )
  assert.equal(r.status, "OK", `deferred with ${r.source}: ${r.note ?? ""}`)
  assert.equal(r.value, "Bachelor's degree")
})

test("THE SAFETY PROPERTY: the stemmer strips suffixes and never prefixes", () => {
  // English negates with prefixes, so a suffix-only rule set cannot fold a word
  // into its own negation. The polarity guard above is the second line of
  // defence; this is the first, and it is a property of the stemmer rather than
  // of any word list.
  for (const [a, b] of [
    ["unable", "able"],
    ["unwilling", "willing"],
    ["nonexempt", "exempt"],
    ["disqualified", "qualified"],
    ["unauthorized", "authorized"],
  ]) {
    assert.notEqual(stem(a), stem(b), `${a} folded onto ${b}`)
  }
  // ... while the pairs it exists for do fold.
  for (const [a, b] of [
    ["availability", "available"],
    ["relocation", "relocate"],
    ["employment", "employed"],
    ["currently", "current"],
    ["years", "year"],
  ]) {
    assert.equal(stem(a), stem(b), `${a} did not fold onto ${b}`)
  }
  // Short words are left alone rather than eaten down to a fragment.
  assert.equal(stem("need"), "need")
  // "ss"/"us"/"is" endings are not plurals.
  assert.equal(stem("address"), "address")
  assert.equal(stem("status"), "status")
  assert.equal(stem("analysis"), "analysis")
})

// ---------------------------------------------------------------------------
// THE CONTAINMENT GUARD — what folding had to buy back
// ---------------------------------------------------------------------------

test("BOUNDARY: one STEM-ONLY shared token is not enough to resolve a field", () => {
  // MEASURED on the real fact base: the Greenhouse field "State" folded onto
  // the "States" of an unrelated banked question, and containment divides by
  // the shorter side — one token out of one — so it scored 0.90 and would have
  // filled a US state field with "Yes". (The live case is now caught earlier
  // still, by the contact rule that answers "State" from the profile; this
  // fixture uses "Statement", which stems to the same "stat" and reaches the
  // token tier, so the guard itself is what is under test.)
  //
  // VERIFIED BY EXECUTION 2026-08-19: with the guard removed this same call
  // returns OK "No" from a-004@0.90.
  const r = one("Statement")
  assert.notEqual(r.status, "OK", `filled ${r.value} from ${r.source}`)
})

test("SUCCESS SIDE: one LITERAL shared token still carries the shortcut", () => {
  // The guard is about stem-only coincidences. A banked question sitting
  // literally inside the label is the case containment was added for, and it
  // has to keep working or the guard costs more than folding gained.
  //
  // This pair also sits just above the far-coverage floor below: one shared
  // token out of the label's three is 33%, against a floor of 30%. That is
  // deliberate and it is why the floor is 0.3 and not 0.4.
  const r = one("Discipline / Field of Study")
  assert.equal(r.status, "OK", `deferred with ${r.source}: ${r.note ?? ""}`)
  assert.equal(r.value, "Computer Science")
})

// ---------------------------------------------------------------------------
// THE FAR-COVERAGE FLOOR — a wrong fill is worse than a defer
// ---------------------------------------------------------------------------

test("BOUNDARY: a one-word label does not take the answer to a long question", () => {
  // MEASURED 2026-08-19 across all 265 labels the field cache has recorded:
  // "Office" resolved OK to the "No" banked for "Are you able to work from our
  // San Francisco office three days per week?" — one shared token out of nine,
  // scored 0.90 because containment divides by the shorter side. Six fields
  // were being filled this way with an answer about something else.
  const r = one("Office")
  assert.notEqual(r.status, "OK", `filled ${r.value} from ${r.source}`)
})

test("EEO IS EXEMPT, and this is the measurement that says why", () => {
  // The floor costs SEVEN correct self-ID answers when applied here, because
  // these labels carry their whole option list in the text on several boards
  // and the banked question is a few words — the far side can never be 30%
  // explained. Everywhere else a lost match falls through to a defer. Here it
  // falls through to an AUTO-DECLINE, which does not ask the user anything: it
  // replaces the answer they gave with "prefer not to say". That is the bug
  // measured 2026-08-06 and fixed by putting the fuzzy pass ahead of the
  // decline, and the floor would have re-opened it.
  const r = resolveAll([
    {
      k: "f",
      t: "select",
      l: "Race",
      opts: ["Hispanic or Latino", "White", "Decline to self-identify"],
      req: true,
    },
  ]).get("f")
  assert.equal(r.status, "OK", `deferred with ${r.source}: ${r.note ?? ""}`)
  assert.equal(
    r.value,
    "Hispanic or Latino",
    "auto-declined over an answer the user actually gave",
  )
})
