// THE POLARITY CORPUS — the falsifiable check for autonomy plan v2 item 2.1.
//
// For each of >= 12 question pairs differing only in NEGATION, the resolution
// must be either the correct typed intent or a defer. NEVER a confident
// inversion. That is the whole gate, and it is asserted twice for every
// question: once against intents.mjs directly (does the matcher return a typed
// intent with the right truth value) and once through the whole answer bank
// (does the pipeline that consumes it agree).
//
// WHY THE PAIRS ARE REAL PHRASINGS. "authorized to work WITHOUT sponsorship"
// versus "do you REQUIRE sponsorship" share nearly every token; toy strings
// share none, so a corpus of toy strings would pass against a matcher that
// still had the bug. Every question below is a phrasing an ATS actually
// renders, across the eight topics where a flipped answer is a misstatement
// the user signs: work authorisation, sponsorship, arbitration, background
// check, relocation, non-compete, prior employment at the company, and age
// eligibility.
//
// THE COUNTS AT THE BOTTOM ARE PART OF THE GATE. A test that lets everything
// defer cannot fail, so the suite asserts three numbers: that the corpus has
// at least 12 pairs, that every side of every pair was actually exercised
// (an empty or short-circuited run cannot pass), and that a MINIMUM number of
// sides resolved confidently — an implementation that answers "defer" to
// everything is not a correct implementation of item 2.1, it is a broken one,
// and this catches it.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { resolveIntent, typeQuestion } from "../../scripts/apply/intents.mjs"
import { createResolver } from "../../scripts/apply/answer-bank.mjs"
import { buildPlan } from "../../scripts/apply/fill-plan.mjs"

// A self-contained fact base. Written to a temp dir rather than
// tests/fixtures/ (another owner's directory) and never near profile/, which
// a PreToolUse hook blocks and which rule 2 puts off limits regardless.
//
// EVERY STORED QUESTION IS DELIBERATELY WORDED DIFFERENTLY FROM EVERY CORPUS
// QUESTION. The exact-question lookup in answer-bank.mjs short-circuits ahead
// of the intent pass — correctly, since identical text cannot be mismatched in
// polarity with itself — so a corpus question that happened to be byte-equal
// to a stored one would test the exact path and prove nothing about typing.
const BANK = [
  {
    id: "a-201",
    question: "Are you legally authorized to work in the U.S.?",
    answer: "Yes",
  },
  {
    id: "a-202",
    question:
      "Will you now or in the future require sponsorship for employment visa status?",
    answer: "No",
  },
  {
    id: "a-203",
    question: "Do you agree to the mutual arbitration agreement?",
    answer: "Yes",
  },
  {
    id: "a-204",
    question: "Do you consent to a background check?",
    answer: "Yes",
  },
  {
    id: "a-205",
    question: "Would you consider relocating for a role?",
    answer: "No",
  },
  {
    id: "a-206",
    question:
      "Are you bound by a non-compete agreement with your current employer?",
    answer: "No",
  },
  { id: "a-207", question: "Have you ever worked at Globex?", answer: "No" },
  {
    id: "a-208",
    question: "Are you at least 18 years of age?",
    answer: "Yes",
  },
]

// The employment history is the source of truth for prior_employment — the
// answer bank cannot supply it and profile.yaml can. "Globex" is absent, so
// the proposition "has previously been employed at Globex" is FALSE.
const PROFILE = {
  contact: { name: "Jane Test", email: "jane@example.com" },
  experience: [
    { company: "Acme Corp", title: "Engineer", dates: "2023—Present" },
  ],
}

const resolver = createResolver(PROFILE, { answers: BANK })
const YESNO = ["Yes", "No"]

// `truth` is the correct answer to THIS question, given the fact base above.
// A resolution may be that answer or a defer; anything else is the bug.
const PAIRS = [
  // --- work authorisation (the user IS authorized) -------------------------
  {
    topic: "work authorisation",
    concept: "work_authorization",
    aff: {
      q: "Are you legally authorized to work in the United States?",
      truth: true,
    },
    neg: {
      q: "Are you not legally authorized to work in the United States?",
      truth: false,
    },
  },
  {
    topic: "work authorisation (right-to-work wording)",
    concept: "work_authorization",
    aff: {
      q: "Do you have the legal right to work in the United States?",
      truth: true,
    },
    neg: {
      q: "Do you lack the legal right to work in the United States?",
      truth: false,
    },
  },
  // --- sponsorship (the user does NOT require it) --------------------------
  {
    topic: "sponsorship",
    concept: "sponsorship_required",
    aff: {
      q: "Will you now or in the future require sponsorship for an employment visa?",
      truth: false,
    },
    neg: {
      q: "Are you able to work in the United States without requiring sponsorship?",
      truth: true,
    },
  },
  {
    topic: "sponsorship (visa wording)",
    concept: "sponsorship_required",
    aff: {
      q: "Do you require visa sponsorship to work in the United States?",
      truth: false,
    },
    neg: {
      q: "Can you work in the United States without visa sponsorship?",
      truth: true,
    },
  },
  {
    // THE INCIDENT PAIR. The negated side is the exact label from the
    // 2026-07-30 bug report: it names the sponsorship concept while its
    // subject is work authorisation, so the ladder copied a sponsorship "No"
    // onto it and asserted the opposite of the truth. It must never come back
    // as a confident "No" again; a defer is the acceptable outcome and is what
    // this implementation produces (the "without" is a negation attached to a
    // DIFFERENT concept from the subject, which cannot be resolved by
    // inverting one boolean).
    topic: "sponsorship / authorisation compound (the original incident)",
    concept: "work_authorization",
    aff: {
      q: "Do you require sponsorship for employment visa status?",
      truth: false,
      concept: "sponsorship_required",
    },
    neg: {
      q: "Are you authorized to work in the U.S. without company sponsorship?",
      truth: true,
    },
  },
  // --- arbitration (always defers; assent is never resolved) ---------------
  {
    topic: "arbitration",
    concept: "arbitration_agreement",
    aff: {
      q: "Do you agree to binding arbitration of any dispute?",
      truth: true,
    },
    neg: {
      q: "Do you decline to agree to binding arbitration of any dispute?",
      truth: false,
    },
  },
  {
    topic: "arbitration (prose tickbox)",
    concept: "arbitration_agreement",
    aff: {
      q: "I agree to resolve any dispute through binding arbitration.",
      truth: true,
    },
    neg: {
      q: "I do not agree to resolve any dispute through binding arbitration.",
      truth: false,
    },
  },
  // --- background check (always defers) ------------------------------------
  {
    topic: "background check",
    concept: "background_check_consent",
    aff: { q: "Do you consent to a background screening?", truth: true },
    neg: { q: "Do you object to a background screening?", truth: false },
  },
  {
    topic: "background check (authorise wording)",
    concept: "background_check_consent",
    aff: {
      q: "Do you authorize Acme to conduct a background investigation?",
      truth: true,
    },
    neg: {
      q: "Do you decline to authorize a background investigation?",
      truth: false,
    },
  },
  // --- relocation (the user is NOT willing) --------------------------------
  {
    topic: "relocation",
    concept: "relocation_willingness",
    aff: { q: "Are you willing to relocate for this role?", truth: false },
    neg: { q: "Are you unwilling to relocate for this role?", truth: true },
  },
  {
    topic: "relocation (named city)",
    concept: "relocation_willingness",
    aff: { q: "Are you able to relocate to Austin, TX?", truth: false },
    neg: { q: "Are you unable to relocate to Austin, TX?", truth: true },
  },
  // --- non-compete (the user is NOT bound) ---------------------------------
  {
    topic: "non-compete",
    concept: "non_compete",
    aff: { q: "Are you bound by a non-compete agreement?", truth: false },
    neg: { q: "Are you free of any non-compete agreement?", truth: true },
  },
  {
    topic: "restrictive covenant",
    concept: "non_compete",
    aff: {
      q: "Are you currently subject to a restrictive covenant?",
      truth: false,
    },
    neg: {
      q: "Are you not subject to a restrictive covenant?",
      truth: true,
    },
  },
  // --- prior employment at the company (the user has NOT worked there) -----
  {
    topic: "prior employment",
    concept: "prior_employment",
    aff: { q: "Have you previously been employed at Globex?", truth: false },
    neg: { q: "Have you never been employed at Globex?", truth: true },
  },
  {
    topic: "prior employment (former-employee wording)",
    concept: "prior_employment",
    aff: { q: "Are you a former employee of Globex?", truth: false },
    neg: {
      q: "Have you not previously been employed at Globex?",
      truth: true,
    },
  },
  // --- age eligibility (the user IS at least 18) ---------------------------
  {
    topic: "age eligibility",
    concept: "age_eligibility",
    aff: { q: "Are you at least 18 years old?", truth: true },
    neg: { q: "Are you under 18 years of age?", truth: false },
  },
  {
    topic: "age eligibility (over-the-age wording)",
    concept: "age_eligibility",
    aff: { q: "Are you over the age of 18?", truth: true },
    neg: { q: "Are you younger than 18?", truth: false },
  },
]

const sides = () =>
  PAIRS.flatMap((p) => [
    { ...p.aff, pair: p, side: "affirmative" },
    { ...p.neg, pair: p, side: "negated" },
  ])

// --- the corpus, at the matcher --------------------------------------------

test("polarity corpus: every side resolves to the correct typed intent or defers, never an inversion", () => {
  let checked = 0
  let confident = 0
  for (const s of sides()) {
    const where = `${s.pair.topic} / ${s.side}: ${JSON.stringify(s.q)}`
    const r = resolveIntent(s.q, BANK)
    assert.ok(r, `${where} — must type to an intent, not fall through`)

    // A RESOLUTION IS TYPED, NOT A STRING. The four fields item 2.1 requires
    // are asserted on every single side of every pair, because "the matcher
    // returns a typed intent" is the capability and a value that happened to
    // be right without one would not be it.
    assert.equal(r.concept, s.concept ?? s.pair.concept, `${where} — concept`)
    assert.ok(
      ["affirmative", "negated", "unestablished"].includes(r.polarity),
      `${where} — polarity`,
    )
    assert.ok(["datum", "assertion"].includes(r.class), `${where} — class`)
    assert.ok(r.provenance && r.provenance.source, `${where} — provenance`)

    assert.ok(
      r.decision === "answer" || r.decision === "defer",
      `${where} — decision`,
    )
    if (r.decision === "defer") {
      assert.ok(
        typeof r.reason === "string" && r.reason.length > 10,
        `${where} — a defer must say WHY, in terms the user can act on`,
      )
    } else {
      confident++
      // THE GATE.
      assert.equal(
        r.value,
        s.truth,
        `${where} — CONFIDENT INVERSION: answered ${r.value}, truth is ${s.truth}`,
      )
      // A defer carries no polarity claim; an answer must.
      assert.notEqual(
        r.polarity,
        "unestablished",
        `${where} — answered without polarity`,
      )
    }
    checked++
  }

  // --- the counts that stop this test being unfailable ---------------------
  assert.ok(
    PAIRS.length >= 12,
    `corpus must hold >= 12 pairs, has ${PAIRS.length}`,
  )
  assert.equal(checked, PAIRS.length * 2, "every side of every pair must run")
  assert.ok(
    confident >= 20,
    `an implementation that defers everything is not item 2.1 — only ${confident} of ${checked} sides resolved`,
  )
})

test("polarity corpus: a negated pair never gets the SAME confident answer on both sides", () => {
  // The definitional form of an inversion, independent of what the fact base
  // says: two questions that differ only in negation cannot both be true.
  // This catches a matcher that lost the polarity entirely (both sides
  // resolving from the same bank string) even if, by luck, one side's value
  // happened to match its own truth.
  let compared = 0
  for (const p of PAIRS) {
    const a = resolveIntent(p.aff.q, BANK)
    const b = resolveIntent(p.neg.q, BANK)
    if (a?.decision !== "answer" || b?.decision !== "answer") continue
    assert.notEqual(
      a.value,
      b.value,
      `${p.topic}: both sides answered ${a.value} — the negation was dropped`,
    )
    compared++
  }
  assert.ok(compared >= 8, `only ${compared} pairs answered on both sides`)
})

// --- the corpus, through the whole answer bank -----------------------------

test("polarity corpus: the same guarantee holds end to end through answer-bank.mjs", () => {
  let checked = 0
  let confident = 0
  for (const s of sides()) {
    const where = `${s.pair.topic} / ${s.side}: ${JSON.stringify(s.q)}`
    const { results } = resolver.resolveAll([
      { k: "f1", t: "radio", l: s.q, opts: YESNO, req: true },
    ])
    const r = results[0]
    const wrong = s.truth ? "No" : "Yes"
    // The inversion is unreachable whatever the status: a deferred row must
    // not carry the wrong literal forward either, because a NEEDS-CHOICE with
    // a pre-selected wrong pick is one careless click from being submitted.
    assert.notEqual(
      r.value,
      wrong,
      `${where} — CONFIDENT INVERSION through the bank (status ${r.status})`,
    )
    if (r.status === "OK") {
      confident++
      assert.equal(r.value, s.truth ? "Yes" : "No", `${where} — wrong value`)
    }
    checked++
  }
  assert.equal(checked, PAIRS.length * 2)
  assert.ok(
    confident >= 20,
    `only ${confident} of ${checked} sides resolved OK`,
  )
})

// --- the ways a typed intent must still refuse ------------------------------

test("a parameterised intent is never answered from a DIFFERENT parameter", () => {
  // Same concept, different company. This is the same class of error as a
  // polarity flip — the right concept about the wrong proposition — and it is
  // exactly what an unparameterised concept match would get wrong.
  const r = resolveIntent("Have you previously been employed at Initech?", BANK)
  assert.equal(r.concept, "prior_employment")
  assert.equal(r.decision, "defer")
  assert.match(r.reason, /globex/i)

  const age = resolveIntent("Are you at least 21 years of age?", BANK)
  assert.equal(
    age.decision,
    "defer",
    "an 18 answer does not settle a 21 question",
  )
})

test("a concept with nothing banked defers rather than borrowing another concept's answer", () => {
  const thin = [BANK[0]] // work authorisation only
  const r = resolveIntent("Do you require visa sponsorship?", thin)
  assert.equal(r.concept, "sponsorship_required")
  assert.equal(r.decision, "defer")
  assert.equal(r.provenance.source, "none")
  assert.match(r.reason, /nothing in the fact base/i)
})

test("banked answers that disagree about a proposition defer instead of picking one", () => {
  const conflicted = [
    ...BANK,
    {
      id: "a-299",
      question: "Are you eligible to work in the United States?",
      answer: "No",
    },
  ]
  const r = resolveIntent(
    "Are you legally authorized to work in the United States?",
    conflicted,
  )
  assert.equal(r.decision, "defer")
  assert.match(r.reason, /disagree/i)
})

test("an agreement is never resolved from the bank, whatever its polarity", () => {
  // alwaysDefer. Typing arbitration and background-check consent is worth
  // doing — it stops the fuzzy tier string-copying a banked answer onto a
  // reworded box — but hard rule 6 says assent is the user's, so a typed
  // intent must not become the route around the consent rule.
  for (const q of [
    "Do you agree to binding arbitration of any dispute?",
    "Do you consent to a background screening?",
  ]) {
    const r = resolveIntent(q, BANK)
    assert.equal(r.decision, "defer", q)
    assert.match(r.reason, /user|assent|permission/i, q)
    // and it still typed, which is the half that makes the refusal auditable
    assert.ok(r.concept)
    assert.equal(r.class, "assertion")
  }
})

test("LAYERING: an exact bank hit outranks alwaysDefer, and the PLAN defers it anyway", () => {
  // A KNOWN AND DELIBERATE SEAM, pinned so nobody closes it by accident and
  // nobody assumes it is closed here.
  //
  // answer-bank.mjs's exact-question lookup runs BEFORE the intent pass, so a
  // consent question the user has saved under that exact wording resolves OK
  // at the bank layer — `alwaysDefer` does not reach it. That ordering is
  // kept: the exact path means the user typed that question and that answer
  // into their own file, and overriding an explicit saved answer with a
  // pattern-based refusal is how a control gets switched off.
  //
  // It is safe because the LOAD-BEARING control for hard rule 6 is not here.
  // `buildPlan`'s consent branch defers every consent box unconditionally, by
  // topic (isConsent) AND by shape (looksLikeAgreementProse), before anything
  // is filled — asserted below. The intent's alwaysDefer is a second,
  // independent refusal covering the fuzzy path that isConsent's pattern list
  // cannot be exhaustive over.
  //
  // THE RESIDUAL, stated rather than implied: a consent wording that escapes
  // BOTH isConsent and looksLikeAgreementProse AND has an exact bank entry
  // would fill. That is the pre-existing pattern-list limit (CLASS_LIMITS in
  // untrusted.mjs says the same thing), not something typed intents widened.
  const bank = [
    {
      id: "a-203",
      question: "Do you agree to binding arbitration?",
      answer: "Yes",
    },
  ]
  const res = createResolver(PROFILE, { answers: bank }).resolveAll([
    {
      k: "f1",
      t: "checkbox",
      sel: "#f1",
      l: "Do you agree to binding arbitration?",
      o: [{ k: "o1", l: "Yes" }],
    },
  ])
  assert.equal(res.results[0].status, "OK", "the exact path still answers")
  assert.match(res.results[0].source, /^a-203@exact/)

  const p = buildPlan({
    scan: {
      fields: [res.results[0]].map(() => ({
        k: "f1",
        t: "checkbox",
        sel: "#f1",
        l: "Do you agree to binding arbitration?",
        o: [{ k: "o1", l: "Yes" }],
      })),
      url: "u",
      heading: "h",
    },
    resolved: res.results,
    adapter: {
      id: "generic",
      comboStrategies: [],
      fileFields: [],
      fileOrder: [],
    },
    url: "u",
  })
  assert.deepEqual(p.items, [], "nothing is filled")
  assert.equal(p.defer[0].why, "consent", "the plan defers it on its own")
})

test("a double negative defers rather than attempting a re-inversion", () => {
  for (const q of [
    "Are you unable to work in the U.S. without company sponsorship?",
    "Are you not unwilling to relocate?",
  ]) {
    const r = resolveIntent(q, BANK)
    assert.equal(r.decision, "defer", q)
    assert.match(r.reason, /polarity/i, q)
  }
})

test("a question the closed set does not claim types to nothing at all", () => {
  // The fence has to have an outside. If typeQuestion() claimed everything,
  // the ordinary token-similarity tier would be dead and every unrecognised
  // question would defer — safe, but not the product.
  for (const q of [
    "How many years of React experience do you have?",
    "What are your salary expectations?",
    "How did you hear about this job?",
  ]) {
    assert.equal(typeQuestion(q), null, q)
    assert.equal(resolveIntent(q, BANK), null, q)
  }
})

// --- no model on this path --------------------------------------------------

test("the resolution path contains no model call and no network call", () => {
  // Stated as a property of the SOURCE, not of a run: an import that is never
  // exercised by these fixtures would still be a live path in production.
  for (const f of ["intents.mjs", "answer-bank.mjs", "disclosure.mjs"]) {
    const src = fs.readFileSync(
      path.join(import.meta.dirname, "..", "..", "scripts", "apply", f),
      "utf8",
    )
    assert.doesNotMatch(
      src,
      /\banthropic\b|\bopenai\b|\bfetch\s*\(|node:https?\b|require\(["']https?["']\)/i,
      `${f} must not reach a model or the network on the resolution path`,
    )
  }
})

// --- stray-negation scope: the sentence, not the label -----------------------

test("an advisory sentence AFTER the question does not defer it (Chime, 2026-08-23)", () => {
  // The measured failure: five straight live runs deferred a banked, correct
  // non-compete "No" because the label's trailing reassurance — "answering
  // yes will NOT disqualify your application" — put a negation marker in the
  // label. That "not" negates DISQUALIFICATION, a different proposition in a
  // different sentence; the question sentence's polarity is untouched. The
  // scan is now scoped to the sentence holding the phrase that set polarity.
  const label =
    "Are you currently subject to any agreement with a former employer/third " +
    "party (such as a non-solicitation or non-compete agreement) that may " +
    "potentially limit your ability to perform the duties of the position " +
    "you are applying for? If yes, you may be asked to provide a copy for " +
    "review. Please note, answering yes will not disqualify your " +
    "application from consideration."
  const r = resolveIntent(label, BANK)
  assert.equal(r.concept, "non_compete")
  assert.equal(r.decision, "answer", r.reason ?? "")
  // The bank entry says the user is NOT bound; "subject to" polarity is +1, so
  // the honest literal is false.
  assert.equal(r.value, false)
})

test("a negation in the SAME sentence as the polarity phrase still defers", () => {
  // The scoping must not weaken either founding defence: a stray marker
  // inside the question sentence is still a negation nobody accounted for.
  const sameSentence = resolveIntent(
    "Are you not currently subject to a non-compete agreement?",
    BANK,
  )
  assert.equal(sameSentence.decision, "defer")
  assert.match(sameSentence.reason ?? "", /negation/i)

  const compound = resolveIntent(
    "Are you authorized to work without company sponsorship?",
    BANK,
  )
  assert.equal(
    compound.decision,
    "defer",
    "the compound-question defence must survive the sentence scoping",
  )
})
