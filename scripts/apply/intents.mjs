// Typed intents — the resolution core that replaces the answer-bank ladder's
// concept/fuzzy/polarity tiers (autonomy plan v2 item 2.1, R3).
//
// WHAT WAS WRONG WITH THE LADDER, IN ONE SENTENCE: it mapped a question to an
// answer STRING, and nothing in that shape can tell "do you require
// sponsorship?" from "are you authorized to work without sponsorship?" —
// they share nearly every token, so token similarity picked the right CONCEPT
// and the wrong TRUTH VALUE. Every fix was another guard stacked on top
// (CONCEPTS, then remainderIsGrounded, then polarityMismatch). This module is
// the shape change those guards were approximating.
//
// WHAT A RESOLUTION IS HERE. Not a string. A resolution carries
// `{concept, polarity, class, provenance}`:
//
//   concept     an id from a CLOSED set (INTENTS below). Each names ONE
//               canonical proposition about the user, always stated in one
//               direction — e.g. `sponsorship_required` is always "the user
//               requires visa sponsorship", never "the user does not".
//   polarity    +1 when the question asks whether the proposition is TRUE,
//               -1 when it asks whether its NEGATION is true, and `null`
//               when neither could be established. `null` DEFERS. It never
//               guesses and never inverts on a hunch.
//   class       `datum` or `assertion` — the class of the PROPOSITION, declared
//               here. fill-plan.mjs's classifier gate reads the stored bank
//               entry's own class independently; the stricter of the two wins,
//               and neither is weakened by the other.
//   provenance  which bank entry (id + its stored question + its own polarity)
//               produced the truth value, or `{source:"none"}` when nothing in
//               the fact base could answer it.
//
// WHY POLARITY STOPS BEING A SPECIAL CASE. The bank stores an answer to the
// question the USER was asked, at that question's polarity. Typing both sides
// makes the truth of the canonical proposition recoverable:
//
//     P            = entryAnswerBool === (entryPolarity === +1)
//     fieldAnswer  = P === (fieldPolarity === +1)
//
// Two booleans and an equality, not a string copy. The prefix bug (AUDIT C1 —
// a banked "Yes" upgraded into "Yes, 5+ years professionally") becomes
// UNREPRESENTABLE on this path: the bank answer collapses to a boolean before
// anything is rendered, and a boolean cannot carry a sentence.
//
// THE FOUR WAYS THIS DEFERS RATHER THAN ANSWERS. Each is a `decision:"defer"`
// with a stated `reason` — never a silent skip, never an inversion:
//
//   1. polarity unestablished — no recognised affirmative or negated phrasing,
//      two disjoint phrasings of opposite polarity, or a negation marker left
//      over outside the phrase that set the polarity (this is what catches the
//      double negative "unable to work WITHOUT sponsorship", and what catches
//      the compound "authorized to work WITHOUT sponsorship", where the
//      subject is work authorisation and the negated qualifier belongs to a
//      DIFFERENT concept).
//   2. nothing in the bank types to this concept.
//   3. the banked answers that do disagree with each other about P.
//   4. `alwaysDefer` — an agreement is the user's to give. Arbitration and
//      background-check consent are typed so they are never string-copied,
//      and then deferred anyway whatever the bank says. Hard rule 6: typed
//      intents must not create a path around the consent rule.
//
// NOT A MODEL, ANYWHERE. Every decision below is a regex, a boolean and a
// comparison. Nothing in this module calls out to anything; a question this
// cannot type falls back to the caller's own handling and, failing that, to
// the user. Unattended throughput rises through adapters, probed option lists
// and banked answers — never through model resolution of an UNKNOWN.

// ---------------------------------------------------------------------------
// boolean parsing — the bank side
// ---------------------------------------------------------------------------
// Deliberately anchored at the START of the answer and nowhere else. "Yes, US
// citizen, no sponsorship needed." is a YES whose tail happens to contain
// "no"; scanning the whole string for a truth word is exactly how a tail
// clause flips a leading answer. The tail is DISCARDED here rather than
// parsed: this function's whole job is to reduce an answer to one bit, and
// anything it cannot reduce returns null (which defers).
const YES_ONLY = /^(?:y|yes|true|1|checked|affirmative)$/i
const NO_ONLY = /^(?:n|no|false|0|unchecked|negative)$/i
const YES_LEAD =
  /^(?:yes\b|y\b|true\b|i\s+(?:do|have|am|was|will|would)\b(?!\s+not))/i
const NO_LEAD =
  /^(?:no\b|n\b|false\b|i\s+(?:do|have|am|was|will|would)\s+not\b|i\s+haven'?t\b|i'?m\s+not\b|never\b|not\s+applicable\b)/i

export function parseBooleanAnswer(raw) {
  const s = String(raw ?? "").trim()
  if (!s) return null
  if (YES_ONLY.test(s)) return true
  if (NO_ONLY.test(s)) return false
  if (NO_LEAD.test(s)) return false
  if (YES_LEAD.test(s)) return true
  return null
}

// ---------------------------------------------------------------------------
// residual negation
// ---------------------------------------------------------------------------
// After the phrase that SET the polarity is blanked out, any negation marker
// still standing is a negation nobody accounted for. That is the whole
// double-negative defence and the whole compound-question defence, in one
// mechanism rather than two guards:
//
//   "Are you unable to work without sponsorship?"  -> "without ... sponsorship"
//       sets polarity -1; "unable" survives  -> defer.
//   "Are you authorized to work without company sponsorship?" -> "authorized
//       to work" sets polarity +1; "without" survives -> defer.
//   "Will you require sponsorship to maintain authorization to work?" ->
//       "require ... sponsorship" sets polarity +1; nothing negating survives
//       (the trailing clause is a purpose adverbial, not a negation) -> answer.
//
// "under"/"below"/"younger" are NOT markers here: they are how an age question
// states its own negation, and age_eligibility's negative patterns consume
// them. A marker list that included them would defer every age question.
const NEGATION_MARKER =
  /\b(?:not|never|without|unable|unwilling|cannot|can'?t|won'?t|don'?t|doesn'?t|didn'?t|isn'?t|aren'?t|no|nor|neither|none|decline[sd]?|refuse[sd]?|except|lack(?:s|ing)?)\b|\bopt[\s-]?out\b|\bfree\s+of\b|\bother\s+than\b/i

// ---------------------------------------------------------------------------
// placeholder subjects — the parameter of a parameterised intent
// ---------------------------------------------------------------------------
// WHAT THIS IS FOR NOW, AND WHAT IT IS NO LONGER FOR (2026-08-06). Everything
// below was written while this test was the thing standing between the owner
// and a fabricated "No" on a prior-employment question. IT IS NOT THAT ANY
// MORE. answer-bank.mjs's priorEmployment() now defers on BOTH branches —
// matched employer and unmatched alike — because the rule it fed was unsound
// however good this extractor got: `profile.yaml` is a distilled resume, not
// an exhaustive employment record, so absence from it never meant "never
// worked there". Read the comment block at priorEmployment() for the full
// argument and for the three rounds of extractor patching that failed before
// the design changed.
//
// This function survives for two smaller jobs and is kept because it does them
// well: it decides WHICH deferral reason the owner reads ("the question names
// no company" vs. "the fact base cannot establish absence"), and it keeps the
// parameterised-intent matching honest — an entry banked about a NAMED
// employer must not be voted onto a question that named nobody. Both of those
// fail soft. If the vocabulary below misses a phrase now, the cost is a
// slightly wrong sentence in a question put to the owner, not a false
// statement on a submitted form.
//
// The history, kept because it is the argument for the shape of the test:
//
// "Have you ever worked for our company before?" names no employer. The
// extractor below captured the literal "our company", answer-bank.mjs's
// priorEmployment() looked that up in profile.experience, found nothing, and
// concluded the proposition was FALSE — a flat "No" with status OK, typed onto
// a form and submitted with nobody reading it (found 2026-08-05). If the user
// HAS worked there, that is a false statement on a signed application.
//
// The rule's own justification is what fails here: the profile can prove
// someone is ABSENT from a complete employment history, but it cannot prove
// absence from a company the question never identified. So a placeholder
// subject yields `null` — the same result as no match at all, which routes the
// field to a stated defer.
//
// THE FIRST VERSION OF THIS TEST WAS A DENYLIST AND FAILED OPEN (proved by
// execution 2026-08-05). It called a phrase a placeholder only when EVERY
// token was in the hand-written vocabulary below, so ONE token nobody had
// enumerated turned a placeholder back into a "company name" and re-enabled
// the fabricated "No":
//
//   "Have you ever worked for this employer or its related entities?"
//     -> {"status":"OK","value":"No","param":"this employer or its related
//         entities"}          ("related" was the only unlisted token)
//
// and the near-identical real label "...our organization, its subsidiaries or
// affiliates" fails the same way the moment one qualifier is reworded. A
// denylist over third-party label text is unbounded by construction.
//
// SO THE TEST IS INVERTED: a phrase counts as a company NAME only when it
// carries positive evidence of naming one, and is a placeholder otherwise.
// Three mechanical conditions make it a placeholder, any one of them enough:
//
//   1. it carries a pronoun or possessive that names nobody — our, us, we,
//      your, its, their, my. "our organization, its subsidiaries or
//      affiliates" is caught by "our" AND by "its", whatever the qualifiers.
//   2. a demonstrative or article and a generic organisation noun both appear
//      in it — "this employer", "the company", "a related company", "this or
//      any related employer". ADJACENT, that is enough on its own; at any
//      other distance it counts only while nothing else in the phrase names
//      anybody, which is what keeps "The Walt Disney Company" a name.
//   3. every token is generic: no token carries positive evidence of a name.
//      Tokens are split on every non-alphanumeric run, so a hyphenated
//      qualifier cannot fuse into one unenumerated word and smuggle the
//      phrase back onto the name path.
//
// CONDITION 2 USED TO REQUIRE ADJACENCY, AND ONE WORD DEFEATED IT (proved by
// execution 2026-08-06). The test was `words[i]` demonstrative AND `words[i+1]`
// a generic organisation noun, so every one of these read as a company NAME
// and earned a fabricated "No" through buildPlan, status OK, how:"fill":
//
//   "Have you ever worked for this or any related employer?"   -> OK "No"
//   "...for a related company?"                                -> OK "No"
//   "...for the successor entity?"                             -> OK "No"
//   "...for any predecessor or successor organisation?"        -> OK "No"
//   "...for an affiliated entity?"                             -> OK "No"
//
// Two things were wrong and both are fixed here. The adjacency requirement is
// gone — an intervening qualifier is how a real ATS words this, not evidence
// that the phrase names anybody — and the vocabulary was missing the relation
// forms an intervening qualifier is made of (`affiliated`, `related`,
// `associated`, `successor`, `predecessor`, `sibling`, `wholly`, `owned`
// beside the `affiliate`/`subsidiary`/`parent` that were already there).
//
// THE GUARD THAT MAKES NON-ADJACENCY SAFE, STATED RATHER THAN ACCIDENTAL.
// Dropping adjacency on its own would have turned "The Walt Disney Company"
// into a placeholder — an article, a generic noun, and now no distance
// requirement between them. What still distinguishes it from "the successor
// entity" is that it CARRIES A TOKEN THAT IS NOT GENERIC ("walt", "disney"),
// and that is now the explicit rule: condition 2's non-adjacent half fires only
// when nothing in the phrase names anybody. Adjacency survives as its own
// UNGUARDED half, because an article sitting immediately in front of a generic
// organisation noun is a determiner phrase whatever else the label contains —
// that is what still catches "the company named in this posting", where
// "posting" is a token no vocabulary lists.
//
// Mechanically the guarded half IS the every-token-generic test, because
// PLACEHOLDER_TOKENS is BUILT from DEMONSTRATIVES ∪ GENERIC_ORG_NOUNS ∪ the
// rest below rather than spelled out a second time. That union is the point:
// it is what makes "an article and a generic noun are never naming evidence"
// true by construction instead of true because two hand-written lists happened
// to agree. tests/apply/intents.test.mjs asserts the containment directly, so
// a word added to either sub-set can never go missing from the other.
//
// THE EDGE CASE THIS MUST NOT BREAK, and it is asserted in both directions in
// tests/apply/intents.test.mjs: "The Home Depot", "The Walt Disney Company",
// "The Boeing Company", "The Coca-Cola Company", "The New York Times Company",
// "The Kroger Co" and "The Goldman Sachs Group" are genuine names that begin
// with an article. Every one of them carries a non-generic token, so every one
// stays a name and the named-company path runs exactly as it did before.
//
// WHAT THIS COSTS, stated rather than hidden: a real company name whose own
// tokens include one of the pronouns defers instead of resolving — "US Foods",
// "US Bank", "The Company Store" — and so does one built entirely from the
// relation vocabulary, "The Related Companies" being the real example. That is
// one question to the owner. The failure it replaces is a false statement
// about their employment history on a submitted application, which nothing
// downstream corrects.
//
// A CORRECTION TO THE RECORD, because the old version of this comment (and a
// test name in tests/apply/intents.test.mjs) asserted an IMPOSSIBILITY that is
// not true. It said the residual could not be closed because "the parameter
// reaches this function already lowercased, so the evidence is gone". The case
// evidence is NOT gone: param() below captures `m[1]` in its original case and
// only lowercases it on the line before the call, so passing the untouched
// string here is a one-word change.
//
// It is not used, and the reason is that capitalisation is not evidence of a
// proper noun in THIS input. Boards render field labels in Title Case and in
// ALL CAPS as a matter of house style, and "Have You Ever Worked For Our
// Company?" capitalises "Company" exactly as "The Walt Disney Company"
// capitalises "Disney". Reading a capital as proof of a name would therefore
// fail OPEN on the most common rendering of the very shape this function
// exists to catch — a fabricated "No" restored by a stylesheet. Case could
// only ever be used in the deferring direction (an all-lowercase interior as
// evidence AGAINST a name), and that buys nothing: the phrases it would catch
// are already caught by the vocabulary. So the claim was wrong and the
// decision it justified is still right, for a different reason.

// Condition 1. A phrase carrying one of these identifies nobody, however many
// other tokens surround it. "me"/"mine"/"i" are deliberately ABSENT: they
// never appear as the subject of an ATS prior-employment question, and they
// collide with real names ("Mine Safety Appliances").
const NON_NAMING_PRONOUNS = new Set(
  "we us our ours you your yours my they them their theirs it its".split(" "),
)

// Condition 2. Article/demonstrative + generic organisation noun. Both halves
// are required: the article alone is how a third of the S&P 500 spells its
// own name.
const DEMONSTRATIVES = new Set([
  "the",
  "a",
  "an",
  "this",
  "that",
  "these",
  "those",
])
const GENERIC_ORG_NOUNS = new Set(
  (
    "company companies organization organizations organisation organisations employer employers " +
    "firm firms business businesses agency agencies team teams entity entities institution institutions " +
    "group groups corporation corporations affiliate affiliates subsidiary subsidiaries " +
    "division divisions department departments unit units co"
  ).split(" "),
)

// The qualifiers a placeholder hangs off an organisation noun. Every one of
// them describes a RELATIONSHIP to a company rather than naming one, so none
// of them is evidence of a name. The five shapes at the top of this block were
// each one missing word away from resolving; `co` sits in GENERIC_ORG_NOUNS
// above for the same reason and closes "the co-employer", which was recorded
// as an open residual until now.
const RELATION_QUALIFIERS = new Set(
  (
    "parent subsidiary sibling affiliated affiliate associated related successor successors " +
    "predecessor predecessors wholly owned acquiring acquired surviving merged employing " +
    "current former formerly previous prior past present new prospective own hiring " +
    "above below named listed mentioned said aforementioned respective"
  ).split(" "),
)

// Pure function words. They join a placeholder together and never name one.
const GENERIC_FILLER = new Set(
  "of and or any all each either some other others various in at for to".split(
    " ",
  ),
)

// Condition 3's vocabulary, and the guard on condition 2's non-adjacent half.
// A UNION rather than a fourth hand-written list — see the block above for why
// that containment is load-bearing.
const PLACEHOLDER_TOKENS = new Set([
  ...NON_NAMING_PRONOUNS,
  ...DEMONSTRATIVES,
  ...GENERIC_ORG_NOUNS,
  ...RELATION_QUALIFIERS,
  ...GENERIC_FILLER,
  // Pronouns the naming test does not use as evidence but that are still not
  // names: NON_NAMING_PRONOUNS deliberately omits these (see its comment).
  ...["them", "mine", "me", "i"],
  ...["client", "clients", "brand", "brands", "office", "offices"],
  ...["location", "locations", "store", "stores", "site", "sites"],
])

// Exported for tests ONLY: the containment above is asserted directly rather
// than inferred from a phrase that happens to exercise it.
export const PLACEHOLDER_VOCABULARY = {
  NON_NAMING_PRONOUNS,
  DEMONSTRATIVES,
  GENERIC_ORG_NOUNS,
  RELATION_QUALIFIERS,
  GENERIC_FILLER,
  PLACEHOLDER_TOKENS,
}

// DEFENSIVE ABOUT ITS OWN INPUT. It lowercases first, which it did not do
// before: the non-alphanumeric normalisation alone turned "ACME" into "" and
// the empty-token filter then made the phrase read as "no tokens". That was
// safe only because the single caller lowercased first, which is not a
// property a second caller would know to preserve. A phrase with nothing left
// after normalisation now returns TRUE (placeholder) — no surviving token is
// no evidence of a name, and this function's whole job is to withhold the
// confident path without positive evidence.
// Exported for tests ONLY, and specifically so the defensive-input behaviour
// above is assertable directly rather than inferred from a caller that already
// lowercases.
export function isPlaceholderSubject(phrase) {
  const words = String(phrase ?? "")
    .toLowerCase()
    // "company's" is the same word as "company"; the possessive must not be
    // what makes a placeholder read as a name.
    .replace(/['’]s\b/g, "")
    // SPLIT on every non-alphanumeric run rather than deleting it inside a
    // token. Deleting it FUSED a hyphenated qualifier into one word nobody had
    // enumerated, and condition 3 then read the fused word as evidence of a
    // name: "the above-named company" became ["the","abovenamed","company"],
    // failed "every token generic", and came back a NAME. Splitting gives
    // ["the","above","named","company"] — all generic, correctly a placeholder.
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  if (!words.length) return true
  // 1 — a pronoun that names nobody.
  if (words.some((w) => NON_NAMING_PRONOUNS.has(w))) return true
  // 2a — ADJACENT determiner + generic organisation noun, UNGUARDED. "the
  // company", "this employer". A determiner sitting immediately in front of a
  // generic organisation noun is a determiner phrase however unfamiliar the
  // rest of the label is, so this still fires on "the company named in this
  // posting", where "posting" is in no vocabulary.
  for (let i = 0; i < words.length - 1; i++) {
    if (DEMONSTRATIVES.has(words[i]) && GENERIC_ORG_NOUNS.has(words[i + 1])) {
      return true
    }
  }
  // 2b + 3 — POSITIVE EVIDENCE OF A NAME is a token outside the generic
  // vocabulary, and there is none here. This one expression carries both
  // remaining conditions and that is deliberate, not an accident of factoring:
  // PLACEHOLDER_TOKENS is the union that CONTAINS DEMONSTRATIVES and
  // GENERIC_ORG_NOUNS, so "an article anywhere plus a generic organisation
  // noun anywhere, with nothing naming anybody" (2b, non-adjacent) cannot be
  // anything other than "every token is generic" (3). Writing 2b as a separate
  // branch would add a test that can never be the reason this returns.
  return words.every((w) => PLACEHOLDER_TOKENS.has(w))
}

// ---------------------------------------------------------------------------
// the closed set
// ---------------------------------------------------------------------------
// CLOSED means: a question that matches no `concept` below is not typed, and
// this module returns null for it — the caller keeps whatever it did before.
// Adding an intent is a deliberate edit here with a test in the polarity
// corpus, not a pattern quietly widened somewhere else.
//
// `positive` and `negative` are the phrasings that ESTABLISH polarity. A
// negative whose span CONTAINS the positive's wins (a negated phrasing
// subsumes the affirmative one it negates: "not authorized to work" contains
// "authorized to work"). Two DISJOINT matches of opposite polarity is genuine
// ambiguity and defers.
//
// `param` makes an intent parameterised: two questions share the concept but
// are only about the same proposition when the parameter matches. Without it,
// "have you worked at Globex?" would be answered from a banked "have you
// worked at Acme? -> No", which is the same class of error as a polarity flip
// (right concept, wrong proposition). Only the two intents where a mismatch
// is a real misstatement carry one; the rest are documented as unparameterised
// on purpose.
export const INTENTS = [
  {
    concept: "work_authorization",
    type: "boolean",
    class: "assertion",
    proposition:
      "the user is legally authorized to work in the country the role is in",
    match:
      /\bwork(?:ing)?\s+authoriz|\bauthoriz(?:ed|ation)\s+to\s+work\b|\bright\s+to\s+work\b|\beligible\s+to\s+work\b|\blegally\s+(?:eligible|entitled|permitted|allowed)\s+to\s+work\b|\bemployment\s+eligibilit/i,
    positive: [
      /\b(?:legally\s+)?authoriz(?:ed|ation)\s+to\s+work\b/i,
      /\bwork(?:ing)?\s+authoriz(?:ation|ed)\b/i,
      /\bright\s+to\s+work\b/i,
      /\beligible\s+to\s+work\b/i,
      /\blegally\s+(?:eligible|entitled|permitted|allowed)\s+to\s+work\b/i,
      /\bemployment\s+eligibilit\w*/i,
    ],
    negative: [
      /\b(?:not|never)\s+(?:currently\s+)?(?:legally\s+)?authoriz(?:ed)?\s+to\s+work\b/i,
      /\bunauthoriz(?:ed)?\s+to\s+work\b/i,
      /\black(?:ing)?\s+(?:the\s+)?(?:legal\s+)?(?:authoriz\w*|right)\s+to\s+work\b/i,
      /\bwithout\s+(?:legal\s+)?(?:work\s+)?authoriz\w*/i,
      /\b(?:not|never)\s+(?:legally\s+)?eligible\s+to\s+work\b/i,
    ],
  },
  {
    concept: "sponsorship_required",
    type: "boolean",
    class: "assertion",
    proposition:
      "the user requires visa/immigration sponsorship now or in the future",
    match: /\bsponsor(?:ship|ed|s|ing)?\b|\bvisa\b|\bh-?1b\b/i,
    positive: [
      /\b(?:requir\w*|need\w*|seek\w*|obtain\w*|want\w*)\b[^?.!]{0,40}?\bsponsor(?:ship)?\b/i,
      /\bsponsor(?:ship)?\s+(?:is\s+|will\s+be\s+)?(?:requir\w*|need\w*)/i,
      /\bvisa\s+sponsorship\b/i,
    ],
    negative: [
      /\bwithout\s+(?:\w+\s+){0,3}?sponsor(?:ship)?\b/i,
      /\b(?:do|does|will|would|are|is)\s+not\s+(?:requir\w*|need\w*)\b[^?.!]{0,40}?\bsponsor(?:ship)?\b/i,
      /\bnot\s+requir\w*\b[^?.!]{0,40}?\bsponsor(?:ship)?\b/i,
      /\bno\s+(?:\w+\s+){0,2}?sponsor(?:ship)?\s+(?:requir\w*|need\w*)/i,
    ],
  },
  {
    concept: "arbitration_agreement",
    type: "boolean",
    class: "assertion",
    // ALWAYS DEFERS. Typing it is still worth doing: it stops the fuzzy tier
    // string-copying a banked arbitration answer onto a reworded arbitration
    // box, which is the failure this whole module exists to make impossible.
    // What it must never do is become a route to auto-assent — hard rule 6.
    alwaysDefer:
      "an arbitration agreement is assent the user gives, never a value resolved from the fact base",
    proposition: "the user agrees to binding arbitration",
    match:
      /\barbitrat\w*|\bbinding\s+dispute\s+resolution\b|\bwaive\w*\b[^?.!]{0,25}?\bjury\b|\bjury\s+trial\s+waiver\b/i,
    positive: [
      /\b(?:agree|consent|accept|assent)\w*\b[^?.!]{0,40}?\b(?:arbitrat\w*|binding\s+dispute)/i,
      /\barbitrat\w*/i,
      /\bbinding\s+dispute\s+resolution\b/i,
    ],
    negative: [
      /\b(?:decline|refuse|reject|do\s+not\s+agree|not\s+agree|do\s+not\s+consent|not\s+consent)\w*\b[^?.!]{0,40}?\b(?:arbitrat\w*|binding\s+dispute)/i,
      /\barbitrat\w*[^?.!]{0,30}?\bopt[\s-]?out\b/i,
    ],
  },
  {
    concept: "background_check_consent",
    type: "boolean",
    class: "assertion",
    alwaysDefer:
      "authorising a background investigation is a permission the user grants, never a value resolved from the fact base",
    proposition: "the user consents to a background check",
    match:
      /\bbackground\s+(?:check|screen\w*|investigation|inquiry)|\bcredit\s+check\b|\bdrug\s+(?:test|screen)\w*|\breference\s+check\b/i,
    positive: [
      /\b(?:consent|agree|authoriz|permit|allow)\w*\b[^?.!]{0,40}?\b(?:background\s+(?:check|screen\w*|investigation|inquiry)|credit\s+check|drug\s+(?:test|screen)\w*)/i,
      /\bbackground\s+(?:check|screen\w*|investigation|inquiry)/i,
      /\bcredit\s+check\b/i,
      /\bdrug\s+(?:test|screen)\w*/i,
      /\breference\s+check\b/i,
    ],
    negative: [
      /\b(?:object|refuse|decline|withhold|do\s+not\s+consent|not\s+consent|do\s+not\s+agree)\w*\b[^?.!]{0,40}?\b(?:background\s+(?:check|screen\w*|investigation|inquiry)|credit\s+check|drug\s+(?:test|screen)\w*)/i,
    ],
  },
  {
    concept: "relocation_willingness",
    type: "boolean",
    class: "assertion",
    // UNPARAMETERISED on purpose. "Willing to relocate to Austin?" and
    // "Willing to relocate?" are treated as the same proposition. The
    // alternative (defer whenever a city is named) would defer nearly every
    // relocation question for no gain: the class is `assertion`, so
    // fill-plan.mjs's gate turns it into a CONFIRM defer before anything is
    // filled unattended either way.
    proposition: "the user is willing to relocate for the role",
    match: /\brelocat\w*/i,
    positive: [
      /\b(?:willing|able|open|prepared|happy|ready)\b[^?.!]{0,25}?\brelocat\w*/i,
      /\bwould\s+you\s+(?:consider\s+)?relocat\w*/i,
      /\brelocat\w*/i,
    ],
    negative: [
      /\b(?:unwilling|unable|not\s+willing|not\s+able|unprepared|opposed|decline)\w*\b[^?.!]{0,25}?\brelocat\w*/i,
      /\bwithout\s+relocat\w*/i,
    ],
  },
  {
    concept: "non_compete",
    type: "boolean",
    class: "assertion",
    proposition:
      "the user is bound by a non-compete or other restrictive covenant",
    match: /\bnon-?\s?compet\w*|\bnon-?\s?solicit\w*|\brestrictive\s+covenant/i,
    positive: [
      /\b(?:bound|subject|party|signed|have|currently)\b[^?.!]{0,30}?\b(?:non-?\s?(?:compet|solicit)\w*|restrictive\s+covenant)/i,
      /\bnon-?\s?(?:compet|solicit)\w*|\brestrictive\s+covenant/i,
    ],
    negative: [
      /\b(?:free\s+of|not\s+bound|never\s+signed|not\s+subject|without|no)\b[^?.!]{0,30}?\b(?:non-?\s?(?:compet|solicit)\w*|restrictive\s+covenant)/i,
    ],
  },
  {
    concept: "prior_employment",
    type: "boolean",
    // A datum, not an assertion: whether someone worked somewhere is a fact
    // about their history rather than a permission they grant. It is still
    // parameterised, because the fact is about a SPECIFIC employer.
    //
    // `datum` DOES NOT MEAN "profile.yaml can settle it". profile.yaml carries
    // an employment list, but a DISTILLED one — a resume, not an exhaustive
    // record — so it can never establish the negative ("I have never worked
    // there"). answer-bank.mjs's priorEmployment() therefore defers on every
    // branch; the only things that can answer this concept are the owner and
    // an answer they banked about the same named employer.
    class: "datum",
    proposition: "the user has previously been employed at the named company",
    match:
      /\b(?:employed|worked)\s+(?:at|by|for)\b|\bformer\s+employee\s+of\b/i,
    positive: [
      /\b(?:previously|formerly|ever|before|in\s+the\s+past)\b[^?.!]{0,30}?\b(?:employed|worked)\s+(?:at|by|for)\b/i,
      /\bformer\s+employee\s+of\b/i,
      /\b(?:employed|worked)\s+(?:at|by|for)\b/i,
    ],
    negative: [
      /\bnever\s+(?:been\s+)?(?:employed|worked)\s+(?:at|by|for)\b/i,
      /\b(?:not|have\s+not|haven'?t)\s+(?:previously\s+)?(?:been\s+)?(?:employed|worked)\s+(?:at|by|for)\b/i,
    ],
    param(text) {
      const s = String(text)
      const m = s.match(
        /(?:(?:employed|worked)\s+(?:at|by|for)|former\s+employee\s+of)\s+([A-Za-z0-9&.'\- ]{2,40})/i,
      )
      if (!m) return null
      // A CAPTURE CUT OFF MID-WORD IS NOT A SUBJECT, IT IS HALF OF ONE, and
      // the half fabricated a "No" (proved by execution 2026-08-06). The
      // {2,40} cap is greedy with nothing after it, so the only way the next
      // character can still be alphanumeric is that the cap — not the phrasing
      // — ended the match. "Have you ever worked for any predecessor or
      // successor organisation?" is 41 characters of subject, so it captured
      // "...successor organisatio": a stub in no vocabulary, which read as
      // positive evidence of a NAME and earned OK "No" about nobody. Whatever
      // the question named, this run did not see all of it, so it defers.
      const after = s[m.index + m[0].length]
      if (after && /[A-Za-z0-9]/.test(after)) return null
      const co = m[1]
        .replace(/\s+(?:for|in|at|during|before|previously)\b.*$/i, "")
        .replace(/[?*.,].*$/, "")
        .trim()
        .toLowerCase()
      if (!co) return null
      // "our company", "this organisation", "us", "a related company" — a
      // subject the question never named. See isPlaceholderSubject() above:
      // null here selects the "named no company" deferral reason and keeps a
      // banked answer about a NAMED employer from being voted onto a question
      // that named nobody. It is NO LONGER what prevents a fabricated "No" —
      // priorEmployment() defers on every branch now.
      //
      // `co` is deliberately the LOWERCASED form even though `m[1]` still
      // holds the original case one line up. That is a decision, not a
      // limitation — see "A CORRECTION TO THE RECORD" above: an ATS renders
      // "Our Company" and "Walt Disney" with identical capitalisation, so
      // treating a capital as proof of a proper noun fails open on exactly the
      // labels this call is here to catch.
      if (isPlaceholderSubject(co)) return null
      return co
    },
  },
  {
    concept: "age_eligibility",
    type: "boolean",
    class: "assertion",
    proposition: "the user meets the stated minimum age",
    match:
      /\bat\s+least\s+\d+\s+years?\b|\bover\s+the\s+age\s+of\s+\d+|\b\d+\s+years?\s+of\s+age\b|\b(?:under|below|younger\s+than)\s+(?:the\s+age\s+of\s+)?\d+\b|\blegal\s+working\s+age\b|\bminimum\s+age\b/i,
    positive: [
      /\bat\s+least\s+\d+\s+years?\b/i,
      /\bover\s+the\s+age\s+of\s+\d+/i,
      /\b\d+\s+years?\s+of\s+age\s+or\s+(?:older|above|more)\b/i,
      /\b\d+\s+years?\s+of\s+age\b/i,
      /\blegal\s+working\s+age\b/i,
    ],
    negative: [
      /\b(?:under|below|younger\s+than)\s+(?:the\s+age\s+of\s+)?\d+\b/i,
      /\bnot\s+(?:yet\s+)?(?:at\s+least\s+)?\d+\s+years?\s+(?:of\s+age|old)\b/i,
    ],
    // The threshold IS the proposition. "At least 18?" answered from a banked
    // "at least 21? -> Yes" is arithmetically sound in one direction and
    // wrong in the other, and encoding that asymmetry is more cleverness than
    // a form question is worth. Exact match or defer.
    param(text) {
      const m = String(text).match(/\b(\d{1,2})\b/)
      return m ? m[1] : null
    },
  },
]

const byConcept = new Map(INTENTS.map((i) => [i.concept, i]))
export const intentFor = (concept) => byConcept.get(concept) ?? null

// Earliest match among a list of patterns, or null. Patterns are never global,
// so `exec` is stateless here.
function earliest(patterns, text) {
  let best = null
  for (const re of patterns ?? []) {
    const m = re.exec(text)
    if (!m) continue
    if (!best || m.index < best.index) {
      best = { index: m.index, end: m.index + m[0].length, text: m[0] }
    }
  }
  return best
}

const contains = (outer, inner) =>
  outer.index <= inner.index && outer.end >= inner.end

/**
 * Type ONE question against one intent. Returns null when the intent's concept
 * is not present at all.
 */
function matchIntent(intent, text) {
  const cm = intent.match.exec(text)
  if (!cm) return null
  const pos = earliest(intent.positive, text)
  const neg = earliest(intent.negative, text)

  let polarity = null
  let span = null
  let reason = null
  if (neg && pos) {
    if (contains(neg, pos)) {
      polarity = -1
      span = neg
    } else if (contains(pos, neg)) {
      polarity = 1
      span = pos
    } else {
      reason = `both an affirmative ("${pos.text}") and a negated ("${neg.text}") phrasing of ${intent.concept} are present`
    }
  } else if (neg) {
    polarity = -1
    span = neg
  } else if (pos) {
    polarity = 1
    span = pos
  } else {
    reason = `no recognised affirmative or negated phrasing of ${intent.concept}`
  }

  if (polarity !== null) {
    const rest = `${text.slice(0, span.index)} ${text.slice(span.end)}`
    const stray = NEGATION_MARKER.exec(rest)
    if (stray) {
      polarity = null
      reason = `a negation ("${stray[0]}") sits outside the phrase that set the polarity ("${span.text}")`
    }
  }

  return {
    concept: intent.concept,
    intent,
    index: cm.index,
    polarity,
    reason,
    matched: span?.text ?? cm[0],
    param: intent.param ? intent.param(text) : null,
  }
}

/**
 * Type a question. Returns null when nothing in the closed set matches.
 *
 * SUBJECT SELECTION when more than one concept is present: the intent whose
 * concept appears EARLIEST is the subject and the rest are qualifiers. This is
 * not a guess about grammar — it is paired with the residual-negation rule, so
 * a qualifier that changes the truth of the sentence ("...to work WITHOUT
 * sponsorship") leaves a negation marker standing and the whole thing defers.
 * A qualifier that does not ("...sponsorship to maintain authorization to
 * work") leaves nothing standing and the subject answers. Those are exactly
 * the two real cases from the incident record.
 *
 * `all` carries every concept found, so a caller can report the compound.
 */
export function typeQuestion(text) {
  const s = String(text ?? "")
  if (!s.trim()) return null
  const hits = []
  for (const intent of INTENTS) {
    const h = matchIntent(intent, s)
    if (h) hits.push(h)
  }
  if (!hits.length) return null
  hits.sort((a, b) => a.index - b.index)
  const subject = hits[0]
  return {
    ...subject,
    all: hits.map((h) => h.concept),
    compound: hits.length > 1,
  }
}

/** Cheap predicate: is this text something the closed set claims? */
export const isTypedQuestion = (text) => typeQuestion(text) !== null

const polarityWord = (p) =>
  p === 1 ? "affirmative" : p === -1 ? "negated" : "unestablished"

/**
 * THE ENTRY POINT.
 *
 * @param {string} label     the form's own label — attacker-chosen text, used
 *                           ONLY to select a concept and a polarity, never as
 *                           evidence of anything.
 * @param {Array}  bank      answers.yaml entries: {id, question, answer, ...}
 * @returns {null|object}    null when the label types to no intent (the caller
 *                           keeps its own behaviour); otherwise a resolution
 *                           carrying {concept, polarity, class, provenance}
 *                           and either decision:"answer" with a boolean
 *                           `value`, or decision:"defer" with a `reason`.
 */
export function resolveIntent(label, bank = []) {
  const typed = typeQuestion(label)
  if (!typed) return null
  const intent = typed.intent

  // Voters: bank entries whose OWN stored question types to the SAME concept
  // as the subject. This is the structural half of "a question about one
  // concept is never answered from another" — it is not a similarity
  // threshold that could be tuned down, it is a set membership test.
  const candidates = []
  for (const entry of bank) {
    if (!entry?.question) continue
    const et = typeQuestion(entry.question)
    if (!et || et.concept !== typed.concept) continue
    candidates.push({ entry, typed: et })
  }

  const base = {
    concept: typed.concept,
    polarity: polarityWord(typed.polarity),
    polarityValue: typed.polarity,
    class: intent.class,
    type: intent.type,
    proposition: intent.proposition,
    compound: typed.compound,
    concepts: typed.all,
    matched: typed.matched,
    provenance: { source: "none" },
  }

  // A named-but-unusable candidate is still worth carrying: the caller can
  // show the user the related banked answer while refusing to copy it.
  const related = candidates[0]
    ? {
        source: "bank",
        id: candidates[0].entry.id ?? null,
        question: candidates[0].entry.question,
        answer: candidates[0].entry.answer,
        entryPolarity: polarityWord(candidates[0].typed.polarity),
      }
    : { source: "none" }

  if (intent.alwaysDefer) {
    return {
      ...base,
      provenance: related,
      decision: "defer",
      reason: intent.alwaysDefer,
    }
  }

  if (typed.polarity === null) {
    return {
      ...base,
      provenance: related,
      decision: "defer",
      reason: `polarity of ${typed.concept} could not be established — ${typed.reason}`,
    }
  }

  if (!candidates.length) {
    return {
      ...base,
      decision: "defer",
      reason: `nothing in the fact base answers ${typed.concept}`,
    }
  }

  // Parameterised intents: same concept is not the same proposition.
  const wantParam = typed.param
  const votes = []
  const skipped = []
  for (const c of candidates) {
    if (intent.param) {
      if (!wantParam || !c.typed.param || c.typed.param !== wantParam) {
        skipped.push(
          `${c.entry.id ?? "?"} is about "${c.typed.param ?? "an unnamed subject"}"`,
        )
        continue
      }
    }
    if (c.typed.polarity === null) {
      skipped.push(`${c.entry.id ?? "?"} has unestablished polarity`)
      continue
    }
    const bool = parseBooleanAnswer(c.entry.answer)
    if (bool === null) {
      skipped.push(`${c.entry.id ?? "?"} is not a yes/no answer`)
      continue
    }
    // P — the canonical proposition's truth, recovered from the entry.
    votes.push({ c, p: bool === (c.typed.polarity === 1) })
  }

  if (!votes.length) {
    return {
      ...base,
      provenance: related,
      decision: "defer",
      reason:
        `no usable banked answer for ${typed.concept}` +
        (skipped.length ? ` (${skipped.join("; ")})` : ""),
    }
  }
  if (votes.some((v) => v.p !== votes[0].p)) {
    return {
      ...base,
      provenance: related,
      decision: "defer",
      reason: `banked answers disagree about ${typed.concept} (${votes
        .map((v) => `${v.c.entry.id ?? "?"}=${v.p}`)
        .join(", ")})`,
    }
  }

  // The stamped provenance is the voter whose stored question is closest in
  // wording to the label — every voter agrees on P, so this picks WHICH entry
  // to name in the record and in fill-plan.mjs's classifier gate, not what the
  // answer is. Naming an unrelated-but-agreeing entry would make the record
  // harder to audit for no benefit.
  const chosen = votes.reduce((best, v) =>
    overlap(label, v.c.entry.question) > overlap(label, best.c.entry.question)
      ? v
      : best,
  )
  const P = votes[0].p
  return {
    ...base,
    provenance: {
      source: "bank",
      id: chosen.c.entry.id ?? null,
      question: chosen.c.entry.question,
      answer: chosen.c.entry.answer,
      entryPolarity: polarityWord(chosen.c.typed.polarity),
      agreed: votes.map((v) => v.c.entry.id ?? "?"),
    },
    decision: "answer",
    // P === (fieldPolarity === +1): the field asks the proposition directly
    // (+1) or asks its negation (-1). Two booleans and an equality.
    value: P === (typed.polarity === 1),
    propositionValue: P,
  }
}

// Token overlap, used ONLY to choose which of several AGREEING entries to name
// in the provenance record. It can never change a truth value — that is the
// point of it being here and not in the resolution path.
const OVERLAP_STOP = new Set(
  "a an the do does did you your are is was will would can could please if of to for in on at and or this that with have has any my me i we am been be now".split(
    " ",
  ),
)
const overlapTokens = (s) =>
  new Set(
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t && !OVERLAP_STOP.has(t)),
  )
function overlap(a, b) {
  const A = overlapTokens(a)
  const B = overlapTokens(b)
  if (!A.size || !B.size) return 0
  let n = 0
  for (const t of A) if (B.has(t)) n++
  return n / Math.min(A.size, B.size)
}

/** One line for a plan note or an approval message. */
export function describeIntent(r) {
  if (!r) return null
  const prov =
    r.provenance?.source === "bank"
      ? `${r.provenance.id} (${r.provenance.entryPolarity})`
      : "no banked fact"
  return `intent ${r.concept}/${r.polarity}/${r.class} from ${prov}`
}
