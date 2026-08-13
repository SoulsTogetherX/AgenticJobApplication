// THE PARAMETER OF A PARAMETERISED INTENT — what "the same concept" is about.
//
// `prior_employment` is parameterised because two questions share the concept
// and are only about the same proposition when they name the same employer.
// The extractor that reads that name is the subject of this file; the polarity
// half of the same intent lives in intents-polarity.test.mjs.
//
// THE DEFECT (found 2026-08-05). "Have you ever worked for our company
// before?" names no employer at all, and param() returned the literal string
// "our company". answer-bank.mjs's priorEmployment() then looked that up in
// profile.experience, found nothing, and read the miss as proof of ABSENCE —
// answering "No", status OK, on a form filled and submitted with no human
// review. The profile can prove someone is absent from a complete employment
// history; it cannot prove absence from a company the question never
// identified. Observed before the fix, with Globex in the history:
//
//   {"q":"Have you ever worked for our company before?","param":"our company"}
//   {"k":"q1","label":"Have you ever worked for our company before?",
//    "status":"OK","source":"experience","value":"No"}
//
// The named-company path is the boundary and is asserted in both directions
// below: a real name must still be extracted, and both the "No" it earns and
// the defer it earns must still happen.
// THE FIRST FIX WAS A DENYLIST AND FAILED OPEN. It called a phrase a
// placeholder only when EVERY token sat in a hand-written vocabulary, so one
// token nobody had enumerated turned a placeholder back into a "company name":
//
//   "Have you ever worked for this employer or its related entities?"
//     -> {"status":"OK","value":"No","param":"this employer or its related
//         entities"}          ("related" was the only unlisted token)
//
// The test is now INVERTED — a phrase is a NAME only on positive evidence of
// naming one — and the boundary that inversion must not cross is the last
// block in this file: "The Home Depot" and "The Walt Disney Company" are real
// names that begin with an article.
//
// ROUND 3 (2026-08-06). The inverted test still fabricated a "No" three ways,
// each proved by execution before it was fixed:
//
//   * the article+generic-noun condition required ADJACENCY, so ONE
//     intervening word defeated it — "a related company", "this or any
//     related employer";
//   * its vocabulary had "affiliate"/"affiliates" but not "affiliated", and
//     no "related"/"successor"/"predecessor" at all — "an affiliated entity",
//     "the successor entity";
//   * param()'s {2,40} capture cut a 41-character subject off MID-WORD, and
//     the stub ("...successor organisatio") is in no vocabulary, so it read as
//     positive evidence of a name — "Have you ever worked for any predecessor
//     or successor organisation?" -> OK "No".
//
// All three are asserted closed below, and the article-led-real-name boundary
// is asserted wider than before, because dropping adjacency is exactly what
// would have broken it.
import test from "node:test"
import assert from "node:assert/strict"
import {
  typeQuestion,
  resolveIntent,
  isPlaceholderSubject,
  PLACEHOLDER_VOCABULARY,
} from "../../scripts/apply/intents.mjs"

const paramOf = (q) => typeQuestion(q)?.param ?? null

// Phrasings a real ATS renders. Each names the hiring company by a pronoun or
// a generic noun — which is to say, does not name it. The last five carry a
// qualifier NO vocabulary list contains, which is the whole point: they are
// the shapes the denylist let through.
const PLACEHOLDER_QUESTIONS = [
  "Have you ever worked for our company before?",
  "Have you ever worked for this company before?",
  "Have you ever been employed by us?",
  "Have you previously worked for our organization?",
  "Have you previously been employed by our organisation?",
  "Are you a former employee of the company?",
  "Have you ever been employed by any of our subsidiaries?",
  "Have you ever worked for this employer?",
  "Have you ever worked at our parent company?",
  "Have you previously been employed by our firm?",
  "Have you ever worked for this employer or its related entities?",
  "Have you ever worked for our organization, its subsidiaries or affiliates?",
  "Have you ever been employed by this company or any of its wholly-owned units?",
  "Are you a former employee of the organization or its predecessor entities?",
  "Have you previously been employed by us or any related employer?",
  // ROUND 3: a single intervening word used to defeat the adjacency test, and
  // every one of these came back OK "No" about a company nobody named.
  "Have you ever worked for this or any related employer?",
  "Have you ever worked for a related company?",
  "Have you ever worked for the successor entity?",
  "Have you ever worked for any predecessor or successor organisation?",
  "Have you ever worked for an affiliated entity?",
  "Have you ever worked for the co-employer?",
  "Have you ever worked for an associated business?",
  "Have you ever worked for a wholly-owned subsidiary?",
  "Have you ever worked for the parent or sibling entity?",
  // The ADJACENT half is deliberately still unguarded, so it fires even when a
  // later token ("posting") is in no vocabulary at all.
  "Have you ever worked for the company named in this posting?",
]

test("a placeholder subject yields no parameter at all", () => {
  for (const q of PLACEHOLDER_QUESTIONS) {
    const t = typeQuestion(q)
    assert.equal(t?.concept, "prior_employment", q)
    assert.equal(paramOf(q), null, `${q} named a company it does not name`)
  }
})

test("BOUNDARY: a named company is still extracted, unchanged", () => {
  // The whole value of the intent is here. Over-widening the placeholder
  // vocabulary would defer every prior-employment question, which is a
  // different defect, not a safer version of this one.
  assert.equal(paramOf("Have you ever worked for Globex before?"), "globex")
  assert.equal(paramOf("Have you ever worked at Acme Corp?"), "acme corp")
  assert.equal(
    paramOf("Have you previously been employed at Affirm for any length?"),
    "affirm",
  )
  assert.equal(paramOf("Are you a former employee of Initech?"), "initech")
  // A name whose FIRST token is generic is still a name: one token outside the
  // generic vocabulary is all it takes.
  assert.equal(
    paramOf("Have you ever worked at The Home Depot?"),
    "the home depot",
  )
  assert.equal(paramOf("Have you ever worked for Company X?"), "company x")
})

test("a placeholder-subject question defers instead of voting a banked answer onto it", () => {
  // End to end through resolveIntent: with the parameter gone, no banked entry
  // can be about the same proposition, so the decision is a stated defer. The
  // bank entry is deliberately a prior_employment answer, so this is the
  // parameter doing the work and not a concept mismatch.
  const bank = [
    { id: "a-207", question: "Have you ever worked at Globex?", answer: "No" },
  ]
  const r = resolveIntent("Have you ever worked for our company before?", bank)
  assert.equal(r.concept, "prior_employment")
  assert.equal(r.decision, "defer")
  assert.match(r.reason, /no usable banked answer/)
})

test("BOUNDARY: the same bank still answers the question it is actually about", () => {
  const bank = [
    { id: "a-207", question: "Have you ever worked at Globex?", answer: "No" },
  ]
  const r = resolveIntent("Have you previously been employed at Globex?", bank)
  assert.equal(r.decision, "answer")
  assert.equal(r.value, false)
  assert.equal(r.provenance.id, "a-207")
})

test("the other parameterised intent is untouched", () => {
  // age_eligibility's parameter is a number, not a noun phrase — the
  // placeholder test must never have been reachable from it.
  assert.equal(paramOf("Are you at least 18 years of age?"), "18")
})

// ---------------------------------------------------------------------------
// isPlaceholderSubject directly — both directions of the inverted test
// ---------------------------------------------------------------------------
test("a phrase with no positive evidence of naming a company is a placeholder", () => {
  const placeholders = [
    "our company",
    "this employer",
    "the organization",
    "us",
    "this employer or its related entities",
    "our organization, its subsidiaries or affiliates",
    "this company or any of its wholly-owned units",
    "the organization or its predecessor entities",
    "us or any related employer",
    "your firm",
    "that business",
    "the parent organisation",
    "any of our subsidiaries",
  ]
  for (const p of placeholders) {
    assert.equal(isPlaceholderSubject(p), true, `"${p}" read as a company name`)
  }
})

test("BOUNDARY: a real name beginning with an article is still a NAME", () => {
  // THE EDGE CASE DROPPING ADJACENCY WOULD HAVE BROKEN, and the reason the
  // non-adjacent half is guarded. Every one of these carries an article AND a
  // generic organisation noun, now at any distance — so the ONLY thing keeping
  // them names is that they also carry a token that is not generic. The list
  // is deliberately longer than the two names round 2 checked, because two
  // examples cannot show that the guard is the mechanism rather than a
  // coincidence of where "the" happened to sit.
  const names = [
    "the home depot",
    "the walt disney company",
    "the boeing company",
    "the coca-cola company",
    "the new york times company",
    "the kroger co",
    "the goldman sachs group",
    "the boston consulting group",
    "a. o. smith",
    "globex",
    "acme corp",
    "company x",
    "initech",
  ]
  for (const n of names) {
    assert.equal(isPlaceholderSubject(n), false, `"${n}" read as a placeholder`)
  }
})

test("the naming evidence is the NON-GENERIC token, and only that", () => {
  // Stated as a mechanism rather than left to be inferred from the list above:
  // take a real article-led name, replace its one naming token with a generic
  // word, and it must flip to a placeholder. Nothing else about the phrase
  // changes — same article, same generic noun, same length, same shape.
  assert.equal(isPlaceholderSubject("the boeing company"), false)
  assert.equal(isPlaceholderSubject("the parent company"), true)
  assert.equal(isPlaceholderSubject("the goldman sachs group"), false)
  assert.equal(isPlaceholderSubject("the affiliated subsidiary group"), true)
})

test("the two vocabularies cannot drift apart — asserted, not assumed", () => {
  // The guard on the non-adjacent half IS the every-token-generic test, and
  // that identity holds only while every article and every generic
  // organisation noun is inside PLACEHOLDER_TOKENS. It is built as a union for
  // that reason; this asserts the union rather than trusting three lists to
  // stay in step. Add "conglomerate" to GENERIC_ORG_NOUNS and forget
  // PLACEHOLDER_TOKENS, and "the acquiring conglomerate" silently becomes a
  // company NAME again.
  const {
    NON_NAMING_PRONOUNS,
    DEMONSTRATIVES,
    GENERIC_ORG_NOUNS,
    RELATION_QUALIFIERS,
    GENERIC_FILLER,
    PLACEHOLDER_TOKENS,
  } = PLACEHOLDER_VOCABULARY
  for (const [name, set] of [
    ["NON_NAMING_PRONOUNS", NON_NAMING_PRONOUNS],
    ["DEMONSTRATIVES", DEMONSTRATIVES],
    ["GENERIC_ORG_NOUNS", GENERIC_ORG_NOUNS],
    ["RELATION_QUALIFIERS", RELATION_QUALIFIERS],
    ["GENERIC_FILLER", GENERIC_FILLER],
  ]) {
    for (const w of set) {
      assert.ok(
        PLACEHOLDER_TOKENS.has(w),
        `${name} member "${w}" is missing from PLACEHOLDER_TOKENS`,
      )
    }
  }
  // And the relation forms round 3 added are actually in there.
  for (const w of [
    "affiliated",
    "associated",
    "related",
    "successor",
    "predecessor",
    "sibling",
    "wholly",
    "owned",
    "parent",
    "subsidiary",
    "former",
  ]) {
    assert.ok(PLACEHOLDER_TOKENS.has(w), `relation form "${w}" not enumerated`)
  }
})

test("GAP CLOSED: a hyphenated qualifier cannot fuse into an unenumerated token", () => {
  // Condition 3 is still the vocabulary test, so it turns on how the phrase is
  // TOKENISED. Deleting non-alphanumerics inside a token fused "above-named"
  // into "abovenamed" — a word no vocabulary contains — and the phrase came
  // back a company NAME, which is the same fabricated-"No" defect one
  // punctuation mark away. Splitting on the punctuation instead keeps every
  // generic word generic.
  const punctuated = [
    "the above-named company",
    "the above-mentioned company",
    "the parent-organisation",
    "the parent-company",
    "the above-named employer",
    "this employer/organization",
    "our-company",
  ]
  for (const p of punctuated) {
    assert.equal(isPlaceholderSubject(p), true, `"${p}" read as a company name`)
  }
})

test("BOUNDARY: a hyphenated REAL name is still a name", () => {
  // The other direction of the same change: hyphens are ordinary in company
  // names and splitting on them must not turn one into a placeholder.
  for (const n of ["coca-cola", "hewlett-packard", "e-trade", "a. o. smith"]) {
    assert.equal(isPlaceholderSubject(n), false, `"${n}" read as a placeholder`)
  }
})

test("GAP CLOSED (round 3): the shapes the previous round recorded as unfixable", () => {
  // These three assertions were `false` — recorded as a KNOWN RESIDUAL that
  // could not be closed. They are now `true`. What made them reachable was an
  // adjacency requirement plus three missing relation forms, and both were
  // ordinary bugs rather than the limit of what a lexical test can do.
  assert.equal(isPlaceholderSubject("an affiliated entity"), true)
  assert.equal(isPlaceholderSubject("the affiliated entity"), true)
  // "the co-employer" tokenises to ["the","co","employer"]; "co" is now in
  // GENERIC_ORG_NOUNS, and "The Kroger Co" stays a name on "kroger".
  assert.equal(isPlaceholderSubject("the co-employer"), true)
  assert.equal(isPlaceholderSubject("the kroger co"), false)
})

test("RESIDUAL, NARROWED NOT CLOSED, with the reason stated correctly this time", () => {
  // What is left after round 3, asserted so the suite shows it rather than a
  // submitted application doing so. A placeholder escapes when BOTH halves of
  // condition 2 miss: no article sits immediately in front of a generic
  // organisation noun (so the unguarded half does not fire) AND it carries one
  // token nobody enumerated (so the guarded half does not either).
  //
  // The reason is a bounded vocabulary meeting unbounded third-party label
  // text — the same shape as every denylist this module has retired, which is
  // why it is narrowed by adding words and never closed by adding words. It is
  // NOT the impossibility the previous round claimed: nothing here is blocked
  // by information having been thrown away.
  assert.equal(
    isPlaceholderSubject("this or any related employer thereof"),
    false,
  )
  assert.equal(isPlaceholderSubject("a related company thereof"), false)
  // The adjacent half still covers the far commoner rendering of the same
  // idea, which is why this is a narrow residual and not the old hole again.
  assert.equal(isPlaceholderSubject("this employer or any related one"), true)
  assert.equal(isPlaceholderSubject("the company named in this posting"), true)
})

test("THE CLAIM THAT WAS FALSE: the case evidence exists, and is not used on purpose", () => {
  // The retired test above justified its residual by asserting an
  // impossibility: "the parameter arrives here already lowercased, so that
  // evidence is gone". That was wrong on the facts. param() captures m[1] in
  // its ORIGINAL case and lowercases it on the line immediately before calling
  // isPlaceholderSubject, so the case was one keystroke away the whole time.
  //
  // It is still not used, for a reason that is about the input rather than the
  // plumbing: an ATS renders labels in Title Case and in ALL CAPS as house
  // style, so a capital is not evidence of a proper noun HERE. This asserts
  // that directly — the same phrase in three renderings must give the same
  // answer, or a stylesheet could restore the fabricated "No".
  for (const p of ["our company", "Our Company", "OUR COMPANY"]) {
    assert.equal(isPlaceholderSubject(p), true, `"${p}"`)
  }
  for (const p of [
    "the affiliated entity",
    "The Affiliated Entity",
    "THE AFFILIATED ENTITY",
  ]) {
    assert.equal(isPlaceholderSubject(p), true, `"${p}"`)
  }
  for (const p of [
    "the walt disney company",
    "The Walt Disney Company",
    "THE WALT DISNEY COMPANY",
  ]) {
    assert.equal(isPlaceholderSubject(p), false, `"${p}"`)
  }
})

test("GAP CLOSED (round 3): a subject cut off mid-word by the capture cap defers", () => {
  // param()'s capture is {2,40}. A 41-character subject came back as
  // "any predecessor or successor organisatio" — and the truncated stub is in
  // no vocabulary, so it read as positive evidence of a NAME and earned a
  // fabricated OK "No" end to end. A capture the cap ended is not a subject
  // this run has seen, so it yields no parameter.
  assert.equal(
    typeQuestion(
      "Have you ever worked for any predecessor or successor organisation?",
    )?.param,
    null,
  )
  // A real name past the cap defers too, and that is the correct direction:
  // nothing here knows what the rest of it said.
  assert.equal(
    typeQuestion(
      "Have you ever worked for International Business Machines Corporation of America?",
    )?.param,
    null,
  )
  // BOUNDARY: a subject that ends because the SENTENCE ended, not because the
  // cap did, is unaffected — the cap only fires when a word character is still
  // standing right after the match.
  assert.equal(
    typeQuestion("Have you ever worked at Acme Corp?")?.param,
    "acme corp",
  )
  assert.equal(
    typeQuestion("Have you ever worked for Globex before?")?.param,
    "globex",
  )
  // 39 characters of subject — just inside the cap, and still extracted.
  assert.equal(
    typeQuestion("Have you ever worked at Wolfeboro Falls Manufacturing?")
      ?.param,
    "wolfeboro falls manufacturing",
  )
})

test("LATENT HAZARD CLOSED: the function normalises its own input", () => {
  // It strips [^a-z0-9] from a string it never lowercased, and was safe only
  // because its single caller lowercases first. A second caller passing raw
  // label text would have had every token stripped to "" — so "OUR COMPANY"
  // read as a company NAME (words.length === 0 -> false) and the fabricated
  // "No" came straight back.
  assert.equal(isPlaceholderSubject("OUR COMPANY"), true)
  assert.equal(isPlaceholderSubject("Our Company"), true)
  assert.equal(isPlaceholderSubject("This Employer"), true)
  // ...and a real name is not mangled into nothing either.
  assert.equal(isPlaceholderSubject("ACME"), false)
  assert.equal(isPlaceholderSubject("The Home Depot"), false)
  // Nothing survives normalisation at all: no token is no evidence of a name,
  // so the answer is the deferring one.
  assert.equal(isPlaceholderSubject(""), true)
  assert.equal(isPlaceholderSubject("   "), true)
  assert.equal(isPlaceholderSubject("?!?"), true)
  assert.equal(isPlaceholderSubject(null), true)
  assert.equal(isPlaceholderSubject(undefined), true)
})
