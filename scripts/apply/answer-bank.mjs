#!/usr/bin/env node
// Batch-resolve scanned application-form fields against the fact base.
// Deterministic lookup only: contact facts from profile.yaml, previously saved
// answers from answers.yaml. It NEVER invents an answer: anything it cannot
// resolve comes back UNKNOWN so the agent asks the user once, in one batch.
//
// Two ways to use it:
//   import { resolveFieldsFromFiles } from "./answer-bank.mjs"   // in-process,
//     no subprocess spawn — this is what fill-plan.mjs and pending-questions.mjs
//     use. It also sidesteps the ~32,767-char argv ceiling Windows imposes on a
//     spawned command line, which a probed 200-option country list can blow.
//   node scripts/scan.json | node scripts/apply/answer-bank.mjs   # CLI, fields on stdin
//   node scripts/apply/answer-bank.mjs --fields '<json array>'
//   ... [--json] [--profile profile/profile.yaml] [--answers profile/answers.yaml]
//
// Input: the `fields` array from .claude/skills/apply-job/scan-page.js, i.e.
//   [{ k, t, l, req?, opts?, o? }, ...]   (a whole scan object is accepted too)
//
// Output (one line per field): <key> <TAB> <status> <TAB> <source> <TAB> <value>
//   OK           value is ready to fill
//   NEEDS-CHOICE resolved a value but no option matched — agent picks from opts
//   MAYBE        weak match against the answers bank — agent confirms wording
//   UNKNOWN      not in the fact base — ask the user, then save-answer.mjs
// Exit codes: 0 = ran fine, 2 = usage/parse error.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { loadYamlFile, isTerse, parseDateRange } from "../lib/lib.mjs"
// TYPED INTENTS (autonomy plan v2 item 2.1). The three ladder tiers that used
// to live in THIS file — the CONCEPTS bucket, the concept-constrained fuzzy
// pass, and the polarityMismatch guard bolted on after it — are gone, replaced
// by a closed set of typed propositions. See intents.mjs's header for the
// shape change and why it makes the polarity bug unrepresentable rather than
// merely guarded against. What remains here is the plain token-similarity tier
// for labels the closed set does NOT claim, and it is now fenced in both
// directions: a typed label never reaches it (resolveField returns from the
// intent pass, whatever the intent decided), and a typed BANK ENTRY is never
// offered to it (bestAnswer filters them out). Those two fences together are
// what "typed facts answer only typed questions" means mechanically.
import {
  resolveIntent,
  isTypedQuestion,
  describeIntent,
  typeQuestion,
  intentFor,
} from "./intents.mjs"

// ---------------------------------------------------------------------------
// pure helpers — none of these depend on profile.yaml, answers.yaml, or the
// batch of fields being resolved, so they live at module scope and are built
// once per process regardless of how many times a resolver is used.
// ---------------------------------------------------------------------------

// Option lists overwhelmingly spell states out ("Nevada") while a profile
// address abbreviates them ("NV"), so offer both and let the form pick.
const US_STATES = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
}
const stateCandidates = (raw) => {
  const s = String(raw ?? "").trim()
  if (!s) return ""
  const upper = s.toUpperCase()
  if (US_STATES[upper]) return [US_STATES[upper], upper]
  const abbrev = Object.keys(US_STATES).find(
    (k) => US_STATES[k].toLowerCase() === s.toLowerCase(),
  )
  return abbrev ? [s, abbrev] : s
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

// "B.S. Computer Science & B.S. Mathematics" -> "Bachelor's Degree", the
// wording ATS dropdowns actually offer. A restatement, not a new claim.
const DEGREE_LEVELS = [
  [/\bph\.?\s?d\b|doctor of philosophy/i, "Doctor of Philosophy (Ph.D.)"],
  [/\bm\.?b\.?a\b/i, "Master of Business Administration (M.B.A.)"],
  [/\bj\.?\s?d\b|juris doctor/i, "Juris Doctor (J.D.)"],
  [/\bm\.?\s?[sa]\.?\b|\bmaster'?s?\b/i, "Master's Degree"],
  [/\bb\.?\s?[sa]\.?\b|\bbachelor'?s?\b/i, "Bachelor's Degree"],
  [/\bassociate'?s?\b/i, "Associate's Degree"],
]

// Labels phrased as questions are NOT profile fields, however many field-ish
// words they contain. Without this, "were you referred to this position by a
// senior leader?" was answered with the job title, and "authorized to work in
// the country where this position is located?" with the home city.
const IS_QUESTION =
  /\?\s*\*?\s*$|^\s*(are|do|did|does|have|has|were|was|will|would|can|could|is|to your knowledge|please confirm)\b/i

// The role and the company being APPLIED TO are not the user's own. "Position
// Applied For" resolved OK with the CURRENT job title and "Company you are
// applying to" with the CURRENT employer (found 2026-08-05) — a wrong answer
// typed into a real employer's form and submitted with no human review,
// because an OK is what fill-plan.mjs turns into an automatic fill.
//
// The guard has to sit on the two current-job rules themselves: neither label
// is question-shaped, so IS_QUESTION does not divert them.
//
// THE FIRST FIX WAS A DENYLIST AND FAILED OPEN (proved by execution, same
// day). It dropped those two rules only when the label matched APPLIED_TO —
// i.e. it ASSUMED every other label meant the user's own job and subtracted
// the phrasings somebody had thought of. A board that names the requisition
// without any of those words walks straight through:
//
//   {"k":"f0","how":"fill","value":"Engineer","label":"Requisition Title"}
//   {"k":"f1","how":"fill","value":"Globex","label":"Hiring Company"}
//   "Vacancy Title"  -> "Engineer"
//   "Position Title" -> "Engineer"
//
// while "Position Applied For" in the same run correctly deferred — the guard
// firing on the labels someone enumerated and not on the others. A denylist
// over third-party label text is unbounded: there are as many ways to name a
// requisition as there are ATS vendors, and each new one re-opens the defect.
//
// SO THE TEST IS INVERTED. The two `current-job` rules answer exactly one
// question — "what is the applicant's CURRENT job?" — so they now run only on
// POSITIVE evidence that the label is asking it, and are dropped otherwise.
// Evidence is four things that must ALL hold, and nothing else:
//
//   (a) the LABEL says WHICH job (ASKS_CURRENT_JOB) — current / currently /
//       present(ly) / most recent / latest / existing; or
//   (b) the SECTION says whose job it is (isOwnEmploymentSection) —
//       scan-page.js stamps `f.section` with the heading a field sits under,
//       so a bare "Company" under a "Work Experience" heading is a
//       work-history row and is legitimately asking about the user's own job;
//   (c) AND, whichever of those supplied the evidence, the LABEL's own shape
//       must be a bare work-history field name (isBareOwnJobLabel);
//   (d) AND, if the label carries a row index at all, it must be row ONE
//       (rowOrdinal) — these two rules read profile.experience[0] and know
//       about no other job, so "Employer 2" is a question they cannot answer.
//
// AND THREE VETOES, any one of which withholds the answer whatever (a)-(d)
// said: APPLIED_TO (below), THIRD_PARTY_SUBJECT and PAST_EMPLOYMENT_HEADING
// (further down). A veto can only ever ADD a deferral. The reason there are
// three rather than one is that they contradict different halves of the claim
// — APPLIED_TO and PAST_EMPLOYMENT_HEADING say the answer is a different JOB,
// THIRD_PARTY_SUBJECT says it is a different PERSON — and folding them into
// one pattern would lose exactly that, which is what the comment at each one
// is for.
//
// (c) IS NOT DECORATION — it closes a second fail-open of the same shape,
// proved by execution 2026-08-06 while (a)+(b) alone were in place. (a) and
// (b) establish WHICH job and WHOSE job; neither establishes that the label is
// asking for an employer or a title at all, so the evidence leaked onto any
// label the two tagged rules' regexes happened to touch:
//
//   "Current Hiring Company"                  -> OK "Globex"
//   "Current Requisition Title"               -> OK "Engineer"
//   "Currently Recruiting Company"            -> OK "Globex"
//   "Requisition Title" [Work Experience]     -> OK "Engineer"
//   "Hiring Company"    [Employment History]  -> OK "Globex"
//
// Every one of those is the requisition again, arriving through the evidence
// rather than around it. (c) is an ALLOWLIST OVER TOKENS — one word outside
// the vocabulary ("requisition", "hiring", "recruiting", "posting", or
// whatever the next ATS vendor invents) and the label defers — so it fails in
// the same direction as (a) and (b) rather than needing the requisition
// vocabulary enumerated in advance.
//
// Everything else — including a bare "Employer" or "Job Title" with no
// heading above it — falls through to the answer bank (a banked answer to
// exactly that question still wins) and then to UNKNOWN, which defers. That
// is a real throughput cost and it is measured, not guessed: see
// REAL_ATS_LABELS in tests/apply/answer-bank.test.mjs.
//
// APPLIED_TO SURVIVES, BUT ONLY AS A VETO over every kind of evidence, and it
// is applied to the SECTION as well as the label — whatever text is being read
// as evidence is subject to it, or a prose heading ("Tell us about your
// experience with this position") grants a work-history reading it should not.
// The veto can only ever ADD a deferral, never grant one: a label carrying
// both signals ("Current openings you are applying for") is ambiguous and
// defers. A denylist that subtracts confidence is safe; a denylist that grants
// it is what failed above. `apply(ing)` does not match "applicable".
const APPLIED_TO =
  /\bapplied\b|\bapply(?:ing)?\b|\bdesired\b|\bsought\b|\bprospective\b|\bof interest\b|\binterested in\b|\bthis (?:position|role|job|opening|opportunity|vacancy)\b/i

// (a) The label itself names the applicant's own ongoing/most recent job.
// "present" is word-bounded so "presentation" is not evidence of anything.
const ASKS_CURRENT_JOB =
  /\bcurrent(?:ly)?\b|\bpresent(?:ly)?\b|\bmost[\s-]+recent\b|\blatest\b|\bexisting\b/i

// A SECTION HEADING THAT IS POSITIVELY ABOUT SOMEBODY ELSE, and the reason
// this is a THIRD kind of veto rather than another entry in APPLIED_TO.
//
// asksCurrentJob used to read `(a) || (b)` — label evidence OR section
// evidence — so a label carrying its own WHICH-job evidence never consulted
// the section at all. The section could GRANT and could never VETO, and that
// asymmetry fills a field about a different human being with the owner's job.
// Verified by execution 2026-08-06, before this existed:
//
//   "Current Employer"  [Emergency Contact]           -> OK "Globex"
//   "Current Employer"  [Reference 1]                 -> OK "Globex"
//   "Current Job Title" [References]                  -> OK "Engineer"
//   "Current Employer"  [Next of Kin / Beneficiary /
//                        Spouse / Parent or Guardian /
//                        Supervisor]                  -> OK "Globex"
//
// (a) establishes WHICH job and (b) establishes WHOSE job. A heading naming a
// referee, a relative or a next of kin is direct evidence that the answer is
// NOT the applicant's own job, and evidence against must outrank evidence for
// — a wrong employer typed into an emergency-contact block goes out on a
// signed application exactly like any other wrong answer.
//
// Like APPLIED_TO this can only ever ADD a deferral, so it is applied to the
// LABEL as well as the section: nothing here can grant an answer, which is
// what makes a loose word ("parent", which also occurs in "parent company")
// safe to list.
const THIRD_PARTY_SUBJECT =
  /\bemergency\b|\bnext\s+of\s+kin\b|\bbeneficiar(?:y|ies)\b|\breferences?\b|\breferees?\b|\bspouse\b|\bparents?\b|\bguardians?\b|\bsupervisors?\b|\bdependents?\b|\brelatives?\b|\bnominees?\b/i

// A PAST-TENSE HEADING CONTRADICTS "CURRENT" — it does not support it.
//
// `previous|prior|past` used to sit in OWN_EMPLOYMENT_SECTION's qualifier
// alternation, so "Previous Employment" was read as evidence that the field is
// about the applicant's own job and (b) granted the two current-job rules —
// which know only profile.experience[0]. Verified by execution 2026-08-06:
//
//   "Employer"  [Previous Employment]  -> OK "Globex"   (the CURRENT employer)
//   "Company"   [Prior Employment]     -> OK "Globex"
//   "Job Title" [Past Experience]      -> OK "Engineer"
//
// Those headings do say WHOSE job it is. What they also say is WHICH job, and
// they say a different one from the only job these rules can read — so the
// heading is evidence AGAINST the answer being offered, and it vetoes rather
// than merely failing to grant. That is why it also overrides (a): "Current
// Employer" under a "Previous Employment" heading is a label and a heading
// asserting opposite things, which is the definition of a field nothing
// deterministic has understood.
//
// Unanchored on purpose. It is a veto, so a heading it over-matches costs one
// deferral and never a wrong answer; an anchored form would miss "Employment
// History (previous 10 years)" for no gain. Note that "History"/"Record" alone
// is NOT past-tense here: every ATS files the current job under "Employment
// History", which is why that heading still grants.
const PAST_EMPLOYMENT_HEADING = /\b(?:previous|prior|past|former|earlier)\b/i

// (b) The heading the field sits under names the applicant's employment
// record. An ALLOWLIST of WHOLE heading shapes: the heading must BE one of
// them, not merely CONTAIN one, so a heading nobody enumerated grants nothing.
//
// THE FIRST VERSION'S FIRST ALTERNATIVE WAS A BARE `\bexperience\b`, WHICH
// CONTRADICTED THAT CLAIM AND FAILED OPEN (proved by execution 2026-08-06).
// One loose token matches an unbounded set of headings that are about the JOB,
// not about the applicant's history:
//
//   "Position Title" [Experience Required]   -> OK "Engineer"
//   "Company"        [Experience Required]   -> OK "Globex"
//   "Employer"       [Years of Experience]   -> OK "Globex"
//
// Anchoring is the fix, not a longer denylist of headings: "Experience
// Required" and "Years of Experience" are two of an unbounded set, the same
// way "Requisition Title" was one of an unbounded set of requisition labels.
//
// A bare "Experience" heading DOES grant — that is a resume-style work-history
// header and a real board emits it (asserted in the corpus below). A bare
// "Employment" grants for the same reason; it is listed now rather than
// assumed, which is what the earlier note about it meant. What does not grant
// is any heading with material either side of those words.
//
// `previous|prior|past` USED TO BE IN THE QUALIFIER LIST AND ARE GONE — see
// PAST_EMPLOYMENT_HEADING above. A heading that names a past job is not
// evidence for an answer read out of profile.experience[0].
//
// The heading is normalised first — lowercased, whitespace collapsed, and
// leading/trailing punctuation runs dropped — so "Work Experience *" and
// "Employment History:" match. Punctuation cannot carry a subject word, so
// that normalisation cannot let a different subject through; anything it does
// not reduce to a listed shape ("1. Work Experience", "Section 2: Employment")
// simply defers.
const OWN_EMPLOYMENT_SECTION =
  /^(?:experience|employment)$|^(?:work|employment|job|career|occupational|professional|current|recent)\s+(?:experience|history|record|background|employment)$|^positions?\s+held$|^employment\s+(?:information|details|history)$/i

const normalizeSection = (section) =>
  String(section ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "")
    .trim()

// The two vetoes are checked HERE as well as in resolveField, so that no
// caller can obtain a grant from this predicate without them: a heading that
// names somebody else, or a past job, is never own-current-employment
// evidence, whatever else it says.
const isOwnEmploymentSection = (section) => {
  const s = normalizeSection(section)
  if (PAST_EMPLOYMENT_HEADING.test(s) || THIRD_PARTY_SUBJECT.test(s)) {
    return false
  }
  return OWN_EMPLOYMENT_SECTION.test(s)
}

// (c) The label's own shape. An ALLOWLIST of the words a bare work-history
// field name is built from: the subjects the two tagged rules can actually
// answer (an employer, a job title), the qualifiers that say WHICH of the
// user's jobs is meant, and ordinary connective filler. Anything else in the
// label means it is naming some OTHER subject, and the confident path is
// withheld.
//
// `previous`/`prior`/`former`/`last` are in here DELIBERATELY. They keep the
// pre-existing "Previous Employer" behaviour byte-for-byte — that label under a
// work-history heading still answers with the CURRENT employer, which is a
// defect belonging to a different rule (the two tagged rules have no notion of
// WHICH of the user's jobs is asked for). Leaving it alone is the instruction;
// silently half-fixing it here would hide it. See the out-of-scope test.
//
// Deliberately NOT here: `this`/`that`/`these`/`those`. "This Employer" is the
// hiring company, not the user's.
//
// `any` and `no` are here for the numbered/optional row renderings measured
// below — "Current Employer, if any", "Employer No. 1". Both are pure function
// words: neither can name a different subject, which is the only property this
// vocabulary is allowed to admit a word on.
const OWN_JOB_LABEL_TOKENS = new Set(
  (
    "company companies employer employers organization organizations organisation organisations " +
    "business firm job jobs title titles position positions role roles occupation employment work name names " +
    "current currently present presently most recent latest existing previous prior former last " +
    "of the a an your my s and or if applicable optional required any no"
  ).split(" "),
)

// A numbered work-history row is a bare own-job label too: "Employer 1",
// "Company #2", "Job Title 1" are how a repeated block spells the same field,
// and a row index names no subject at all. Bounded to one or two digits so it
// stays a row index — "Employer 2019" and "Company 401k" keep deferring.
//
// DELIBERATELY ASCII. `\d` is ASCII-only in a non-`u` regex and that is the
// property wanted here: a numeral this file cannot read is not a row index it
// has understood, so it must fail the vocabulary rather than pass it. The
// Unicode-aware companion below exists to RECOGNISE such a numeral, never to
// admit it.
const ROW_ORDINAL = /^\d{1,2}$/
// Any decimal digit in any script — Arabic-Indic ٢, full-width ２, Devanagari
// २. Used only to tell "a numeral I cannot read" apart from "an ordinary word
// I do not know", so rowOrdinal can say which it met.
const NUMERAL_TOKEN = /^\p{Nd}{1,2}$/u
const isOwnJobToken = (w) => OWN_JOB_LABEL_TOKENS.has(w) || ROW_ORDINAL.test(w)

// A TOKEN THIS TOKENISER CANNOT REPRESENT MUST COUNT AS OUT OF VOCABULARY, NOT
// VANISH. The split used to be /[^a-z0-9]+/ over a lowercased string, which
// treats every non-ASCII character as a SEPARATOR — so a subject word written
// in another script was deleted outright and the label that survived read as a
// bare own-job label. Verified by execution 2026-08-06:
//
//   "Current Employer - Kompaniya" in Cyrillic  -> OK "Globex"
//   the same label with the subject in kanji    -> OK "Globex"
//   "Employer ٢" [Work Experience]              -> OK "Globex"  (row 1's value
//                                                  answered for row 2, because
//                                                  the numeral was deleted and
//                                                  rowOrdinal() saw no index)
//
// That is the allowlist failing OPEN through its own tokeniser: an allowlist
// can only reject what it is shown. Splitting on "not a letter, digit or
// combining mark" (Unicode-aware) keeps the foreign word as ONE token, which
// is then in no vocabulary and defers — the same outcome any other unknown
// subject word gets. Deliberately NOT NFKC-normalised: folding full-width
// letters back to ASCII would hand the vocabulary a match it never saw, and
// deferring on an exotic rendering is the direction that costs a question
// rather than an application.
const LABEL_TOKEN_SEPARATOR = /[^\p{L}\p{N}\p{M}]+/u

const labelTokens = (s) =>
  String(s ?? "")
    .toLowerCase()
    .split(LABEL_TOKEN_SEPARATOR)
    .filter(Boolean)

// A bracketed aside qualifies the field ("(if applicable)", "[required]"); it
// never names a different subject.
//
// THE STRIP USED TO RUN INSTEAD OF THE TOKEN TEST ON THE FULL TEXT, AND
// BRACKETS THEREFORE HID A SUBJECT WORD FROM THE ALLOWLIST (proved by
// execution 2026-08-06). Whatever sat inside the brackets was invisible, so
// the requisition walked back in wearing them:
//
//   "Current Employer (Hiring Company)"  -> OK "Globex"
//   "Current Title (Vacancy Title)"      -> OK "Engineer"
//   "Current Employer [Requisition]"     -> OK "Globex"
//
// The token test now has to pass on BOTH forms — the stripped text and the
// full text — so an out-of-vocabulary token defers wherever it sits. The two
// halves are kept separate rather than collapsed to the full-text test alone
// because they fail for different reasons and only one of them is implied by
// the other: the full-text test is what closes the hole above, and the
// stripped test is what keeps a label made of NOTHING BUT an aside
// ("(if applicable)") on the deferring path. NO TOKENS AT ALL IS NOT
// EVIDENCE — an empty, bracket-only or punctuation-only label returns false,
// like every other label the vocabulary does not cover.
const isBareOwnJobLabel = (label) => {
  const raw = String(label ?? "").toLowerCase()
  const stripped = labelTokens(raw.replace(/\([^)]*\)|\[[^\]]*\]/g, " "))
  const full = labelTokens(raw)
  if (!stripped.length || !full.length) return false
  return stripped.every(isOwnJobToken) && full.every(isOwnJobToken)
}

// WHICH row of a repeated work-history block the label is asking about, or
// null when it carries no index. The two `current-job` rules can only answer
// row ONE: they read profile.experience[0] and have no notion of any other
// job, so "Employer 2" under a work-history heading would be answered with the
// CURRENT employer — a false statement, and the same WHICH-job defect the
// out-of-scope "Previous Employer" test records. Admitting the digit into the
// vocabulary above without this would have turned that defect from a
// pre-existing one into a newly-created one. Highest index wins, so a label
// naming two rows defers.
//
// A NUMERAL IT CANNOT READ IS NOT "NO INDEX". Before the Unicode split above,
// "Employer ٢" lost its numeral in the tokeniser, this returned null, and the
// caller's `(rowOrdinal(label) ?? 1) === 1` therefore read the label as row
// ONE and answered row 2 with row 1's employer. Now the numeral survives as a
// token, and a numeral outside ASCII yields NaN rather than a row number:
// `NaN === 1` is false, so the caller defers. Do not "simplify" the NaN away —
// it is the third state (an index that was seen and not understood) and it has
// to be distinguishable from null (no index at all).
const rowOrdinal = (label) => {
  const nums = []
  for (const w of labelTokens(label)) {
    if (!NUMERAL_TOKEN.test(w)) continue
    nums.push(ROW_ORDINAL.test(w) ? Number(w) : Number.NaN)
  }
  if (!nums.length) return null
  return nums.some(Number.isNaN) ? Number.NaN : Math.max(...nums)
}

const EEO_RE =
  /\bgender\b|\brace\b|ethnic|hispanic|latino|veteran|disab|self-?identif|pronoun/i
// "I do not want to answer" (Affirm's disability option) was one word away from
// matching, so that field alone went to the user while the other three EEO
// questions resolved.
const DECLINE_RE =
  /decline|prefer not|don'?t wish|do not wish|don'?t want|do not want|rather not|not to (answer|say|disclose)|choose not|opt out/i

// ---------------------------------------------------------------------------
// answers-bank fuzzy match
// ---------------------------------------------------------------------------
const STOP = new Set(
  "a an the do does did you your are is was will would can could please select choose if of to for in on at and or this that with have has any my me i we am been be".split(
    " ",
  ),
)
const tokens = (s) =>
  new Set(
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t && !STOP.has(t)),
  )

function similarity(a, b) {
  const A = tokens(a)
  const B = tokens(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  const union = A.size + B.size - inter
  const jaccard = inter / union
  const containment = inter / Math.min(A.size, B.size)
  return Math.max(jaccard, containment * 0.9)
}

// RETIRED (item 2.1): `CONCEPTS` + `conceptOf` used to bucket a label into
// "sponsorship" or "work_authorization" and constrain the fuzzy pass to that
// bucket. It was the first guard stacked on the ladder and it could not
// express the actual bug — a bucket says WHICH concept, never which TRUTH
// VALUE, so "authorized to work WITHOUT sponsorship" landed in a bucket and
// copied the opposite answer out of it. intents.mjs replaces the bucket with a
// typed proposition carrying a polarity; there is nothing left here to keep.

// Field types where "no options recorded" means "unprobed", not "no options
// exist". A text input genuinely has no option list to check against; a
// select/combo/radio/checkbox does, and filling one without ever having seen
// its real options is exactly how a dropdown that was never probed ends up
// silently accepting whatever the fact base offered first (AUDIT: matchOption
// returned the first candidate when `opts` was empty, with no needsChoice).
const CHOICE_TYPES = new Set(["select", "combo", "radio", "checkbox"])

// ---------------------------------------------------------------------------
// option matching
// ---------------------------------------------------------------------------
const YES = /^(y|yes|true|1)$/i
const NO = /^(n|no|false|0)$/i

// Forms rarely offer a bare "Yes"/"No". Affirm's prior-employment question
// offers "I have not previously been employed at Affirm"; without these a
// resolved "No" came back NEEDS-CHOICE and went to the user for nothing.
//
// NOTE: `none\b` was deliberately removed from NO_LONG. "None of the above"
// passed this pattern and got silently substituted for a plain "No" (AUDIT
// C2) — correct on some 2-option forms, wrong on a real multi-select, and the
// pattern cannot tell those apart from the option text alone. Deferring one
// extra field beats guessing wrong on a form the engine cannot re-ask.
const YES_LONG = /^(yes\b|y\b|true\b|i (do|have|am|was|would)\b(?!\s+not))/i
const NO_LONG =
  /^(no\b|n\b|false\b|i (do|have|am|was|would) not\b|i haven'?t\b|i'?m not\b|never\b|not applicable)/i

// Cue words the yes/no match itself already accounts for — seeing them again
// in the surviving remainder is not "new" information.
const NEGATION_CUES = new Set(["yes", "no", "not", "never", "none", "n", "y"])

// A prefix (or long-form yes/no) match is only safe when whatever text
// survives beyond the matched cue is already implied by the FIELD's own
// label. "Will you require sponsorship?" -> "No, I will not require
// sponsorship" merely echoes "require sponsorship" back from the label —
// nothing new is asserted. "Do you have experience with React?" -> "Yes, 5+
// years professionally" invents a duration nowhere in the label or the banked
// "Yes" (AUDIT C1); "Have you previously been employed at Globex?" -> "None
// of the above" invents a list-negation the label never offered (AUDIT C2).
// An empty/punctuation-only remainder is trivially grounded (nothing new
// survives at all) — this is a strict superset of "empty or punctuation",
// wide enough to keep the legitimate long-form matches above working.
function remainderIsGrounded(remainder, label) {
  const extra = [...tokens(remainder)].filter((t) => !NEGATION_CUES.has(t))
  if (!extra.length) return true
  const known = tokens(label)
  return extra.every((t) => known.has(t))
}

// True when index `i` in `s` sits at a word boundary — end of string, or the
// next character is not alphanumeric. Guards the "value is longer than the
// option" direction below: without it "November".startsWith("No") would
// truncate a wholly unrelated word down to "No" on nothing but a two-letter
// coincidence.
const atWordBoundary = (s, i) => i >= s.length || !/[a-z0-9]/i.test(s[i])

// Accepts a single value or an ordered list of acceptable answers; the first
// one the form actually offers wins.
//
// `requireOptions`: true for choice-shaped fields (select/combo/radio/
// checkbox). When true and no options were recorded at all, the field is
// UNPROBED, not "a free-text field with nothing to check against" — return
// needsChoice instead of silently accepting the first candidate, because
// there is no way to know the value is actually offered.
//
// `multi`: true when the FIELD accepts several values (scan-page.js marks a
// <select multiple> and a react-select token picker with `f.multi`). It flips
// what a LIST answer means: on a single-value field a list is "ordered
// alternatives, first offered wins" (unchanged); on a multi field it is "all
// of these", so EVERY element must ground against the recorded options and
// the grounded set comes back in `values`. One element the form does not
// offer defers the whole field — a partial selection would silently drop part
// of the user's recorded answer, which is worse than asking. A SINGLE value
// on a multi field stays on the single ladder: selecting one option of many
// is a complete answer, not a degraded one.
export function matchOption(
  value,
  opts,
  { requireOptions = false, label = "", multi = false } = {},
) {
  const candidates = (Array.isArray(value) ? value : [value])
    .map((v) => String(v ?? "").trim())
    .filter(Boolean)
  const first = candidates[0] ?? ""
  if (!Array.isArray(opts) || !opts.length) {
    return requireOptions
      ? { value: first, needsChoice: true, unprobed: true }
      : { value: first }
  }
  const real = opts.filter((o) => o && !/^(select|choose|--|\s*)$/i.test(o))

  // The per-candidate ladder, exactly as it has always run: exact text, then
  // prefix-grounding in either direction, then the yes/no long forms. Hoisted
  // so the multi branch below grounds each element by the SAME rules — a
  // second copy of this ladder is a second rule to keep in sync.
  const groundOne = (v) => {
    const exact = real.find((o) => o.trim().toLowerCase() === v.toLowerCase())
    if (exact) return exact

    const grounded = real.find((o) => {
      const ot = o.trim()
      const vl = v.toLowerCase()
      const otl = ot.toLowerCase()
      // The option is LONGER and merely starts with the value: the option
      // may be asserting something new (AUDIT C1/C2) — only accept it when
      // whatever survives beyond the value is already implied by the label.
      if (otl.startsWith(vl))
        return remainderIsGrounded(ot.slice(v.length), label)
      // The value is LONGER and starts with the option: the option is a
      // clean truncation of a more detailed true statement ("Yes, US
      // citizen, no sponsorship needed." -> "Yes"). Truncation can only ever
      // DROP detail, never invent it, so no grounding check is needed —
      // just a real word boundary, so "November" cannot truncate to "No" on
      // a two-letter coincidence.
      if (vl.startsWith(otl)) return atWordBoundary(v, ot.length)
      return false
    })
    if (grounded) return grounded

    if (YES.test(v) || NO.test(v)) {
      const want = YES.test(v) ? YES_LONG : NO_LONG
      const hit = real.find((o) => {
        const m = want.exec(o.trim())
        if (!m) return false
        return remainderIsGrounded(o.trim().slice(m[0].length), label)
      })
      if (hit) return hit
    }
    return null
  }

  if (multi && Array.isArray(value) && candidates.length > 1) {
    const picked = []
    for (const v of candidates) {
      const hit = groundOne(v)
      if (!hit) return { value: candidates.join(", "), needsChoice: true }
      // Two spellings grounding to one option is one selection, not two.
      if (!picked.includes(hit)) picked.push(hit)
    }
    return { value: picked.join(", "), values: picked }
  }

  for (const v of candidates) {
    const hit = groundOne(v)
    if (hit) return { value: hit }
  }
  return { value: first, needsChoice: true }
}

// RETIRED (item 2.1): the polarity guard — `NEGATION_RE`, `isNegated`,
// `isYesNoAnswer`, `polarityMismatch`. It compared "is the label negated?"
// against "is the bank question negated?" and deferred when the two booleans
// disagreed. That was a DETECTOR bolted onto a design that could not represent
// polarity: it could only ever say "these two might be opposite", never which
// one is true, so it had to defer even the cases that are plainly answerable
// ("are you able to work without requiring sponsorship?" is a clean single
// negation of a fact the bank holds). intents.mjs makes polarity a first-class
// part of the resolution instead — established from the phrasing that set it,
// checked for stray negations left standing, and then applied as
// `P === (fieldPolarity === +1)`. Deferring on an unestablished polarity is
// kept exactly as it was; what changed is that "unestablished" is now a
// property of a typed resolution with a stated reason, not the absence of a
// pattern match.

// ---------------------------------------------------------------------------
// exact-question lookup
// ---------------------------------------------------------------------------
// Exact normalized text only. No fuzzy tier here: the 0.45 MAYBE band exists
// precisely because near-matches are unreliable, and this path skips the
// concept guard that keeps "require sponsorship" away from "authorized to
// work". Identical text cannot confuse those.
//
// Rendering-only variance folded into the exact key. Each of these is a
// measured miss, not a guess (2026-07-31): a-049 is stored as "Do you require
// sponsorship?" and a board rendering the same label WITHOUT the trailing "?"
// missed exact match and fell to fuzzy; "What's your notice period?" typed
// with a U+2019 apostrophe vs a board rendering ASCII "'" likewise missed.
// NFKC first, so a full-width/compatibility variant of any character below
// (or of anything else) collapses to its ordinary form before the folds run.
// This is deliberately narrower than "strip punctuation": every fold here
// maps several CODEPOINTS that render as the same glyph onto ONE, never
// discards a character that carries meaning ("C++"/"C#", "18+"/"18" stay
// distinct — see the rejected blanket-stripping proposal in the module
// history). Trailing "?" joins the existing trailing "*"/":" strip for the
// same reason those are stripped: a required-marker or sentence-terminator
// position, not interior content.
const CURLY_APOSTROPHE_RE = /[‘’ʼ′]/g
const CURLY_QUOTE_RE = /[“”„«»]/g
const UNICODE_DASH_RE = /[‐‑‒–—]/g

// Exported so fill-plan.mjs's --consent-allowlist can match a consent label
// against the user's own exact wording the same way a saved answer matches
// a form question — "exact" means the same thing in both places. Widening
// this key ALSO widens what the allowlist matches; every fold above is
// rendering-only variance (a Unicode compatibility form, a curly-vs-straight
// quote, a dash width) and never changes what the text asserts, so the
// allowlist's "the user's own exact wording" guarantee holds under it the
// same way exact-answer lookup's guarantee does.
export function normalizeQuestion(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .replace(CURLY_APOSTROPHE_RE, "'")
    .replace(CURLY_QUOTE_RE, '"')
    .replace(UNICODE_DASH_RE, "-")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[*:?]+$/, "")
    .trim()
}

const SKIP_TYPES = new Set(["file", "richtext"])

// ---------------------------------------------------------------------------
// bank-provenance contract for QUESTION_RULES / PROFILE_RULES value fns
// ---------------------------------------------------------------------------
// A rule's static `source` string (e.g. "experience", "answers") tells the
// human reading a printed plan where a value came from, but it is NOT what
// fill-plan.mjs's classifier gate keys on — that gate (BANK_ID_RE, "^a-\d+@")
// only fires when `source` starts with a real bank id, because only then does
// it have an `answers.yaml` entry to run answerClass()/datum-vs-assertion on.
//
// A rule whose value fn reads `bank` directly (not just profile.yaml) MUST
// return `bankHit(entry, value)` rather than a bare value, so the id travels
// with the answer. Returning a bare value when the value came from the bank
// is exactly the bug this closes (AUDIT N3): heardAbout() called
// `bank.find(...)` but stamped the rule's static "answers" source, so its
// row could never match BANK_ID_RE and never passed through the datum/
// assertion gate — harmless while "how did you hear about us" is always a
// datum, but the SAME shape on a future bank-reading rule would silently ship
// an unclassified assertion. `entry` may be undefined (no bank match found,
// e.g. heardAbout's "Other"/"LinkedIn" fallback chain) — bankHit degrades to
// a bare-value hit in that case, which is correct: there is no bank id to
// classify because nothing came from the bank.
function bankHit(entry, value) {
  return entry?.id ? { value, source: `${entry.id}@rule` } : { value }
}

// ---------------------------------------------------------------------------
// createResolver(profile, answersDoc) — everything that is a pure function of
// the fact base, built ONCE regardless of how many field batches are
// resolved against it. This is what lets fill-plan.mjs and
// pending-questions.mjs import the resolver directly instead of spawning a
// fresh `node answer-bank.mjs` process per call.
// ---------------------------------------------------------------------------
export function createResolver(profile = {}, answersDoc = {}) {
  const contact = profile.contact ?? {}
  const bank = Array.isArray(answersDoc.answers) ? answersDoc.answers : []

  const nameParts = String(contact.name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const locParts = String(contact.location ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

  // -------------------------------------------------------------------------
  // employment + education facts
  //
  // Every application form asks for the current employer and the degree, and
  // both are already in profile.yaml. Values are read straight from the fact
  // base; nothing here derives a claim the profile does not already make.
  // -------------------------------------------------------------------------
  // "Current" means the role still running, not the one that started most
  // recently — a short contract begun later must not displace the ongoing job.
  const ongoing = (e) =>
    /\b(present|current|now|ongoing)\b/i.test(String(e.dates ?? ""))
  const experience = [...(profile.experience ?? [])]
    .map((e) => ({ e, r: parseDateRange(e.dates) }))
    .sort(
      (a, b) =>
        Number(ongoing(b.e)) - Number(ongoing(a.e)) ||
        (b.r?.end ?? 0) - (a.r?.end ?? 0) ||
        (b.r?.start ?? 0) - (a.r?.start ?? 0),
    )
  const current = experience[0] ?? {}
  const currentJob = current.e ?? {}
  const currentRange = current.r ?? null
  const isCurrent = /\b(present|current|now|ongoing)\b/i.test(
    String(currentJob.dates ?? ""),
  )

  const education = profile.education?.[0] ?? {}
  const degreesText = String(education.degrees ?? "")
  const degreeLevel =
    (DEGREE_LEVELS.find(([re]) => re.test(degreesText)) ?? [])[1] ?? ""
  // Strip the credential to leave the field of study.
  const discipline = degreesText
    .split(/\s*&\s*|\s*,\s*|\s+and\s+/)[0]
    .replace(
      /^\s*(b\.?\s?[sa]\.?|m\.?\s?[sa]\.?|ph\.?\s?d\.?|j\.?\s?d\.?|bachelor'?s?( of)?|master'?s?( of)?|associate'?s?( of)?)\s*/i,
      "",
    )
    .replace(/\bdegree\b/i, "")
    .trim()

  const PROFILE_RULES = [
    // Must precede the title rule: "Current role" contains "role" and would
    // otherwise be answered with the job title instead of being ticked.
    [
      /\bcurrent role\b|\bi currently work here\b|\bpresent(ly)? employed here\b/i,
      "experience.current",
      isCurrent ? "Current role" : "",
    ],
    // The 4th element tags the two rules that answer with the user's OWN
    // employer/title, the way CONTACT_RULES' 4th element tags the identity
    // rules. resolveField DROPS BOTH UNLESS the label carries positive
    // evidence that it is asking for the applicant's current job — see the
    // block above APPLIED_TO for the three conditions and for why the earlier
    // "drop them when the label says 'applied'" denylist failed open. APPLIED_TO
    // is now only the veto over that evidence, never the whole test.
    [
      /\b(company|employer|organi[sz]ation)( name)?\b/i,
      "experience.current",
      currentJob.company ?? "",
      "current-job",
    ],
    [
      /\b(job )?title\b|\bposition\b/i,
      "experience.current",
      currentJob.title ?? "",
      "current-job",
    ],
    [
      /\bstart date\b.*\bmonth\b|\bmonth\b.*\bstart\b/i,
      "experience.current",
      currentRange ? MONTH_NAMES[currentRange.start.getUTCMonth()] : "",
    ],
    [
      /\bstart date\b.*\byear\b|\byear\b.*\bstart\b/i,
      "experience.current",
      currentRange ? String(currentRange.start.getUTCFullYear()) : "",
    ],
    // Only answerable when the role has ended; an ongoing role leaves this to
    // the "current role" checkbox.
    [
      /\bend date\b.*\bmonth\b/i,
      "experience.current",
      !isCurrent && currentRange
        ? MONTH_NAMES[currentRange.end.getUTCMonth()]
        : "",
    ],
    [
      /\bend date\b.*\byear\b/i,
      "experience.current",
      !isCurrent && currentRange
        ? String(currentRange.end.getUTCFullYear())
        : "",
    ],
    [
      /\bschool\b|\buniversity\b|\bcollege\b|\binstitution\b/i,
      "education",
      education.school ?? "",
    ],
    [/\bdegree\b/i, "education", degreeLevel],
    [/\bdiscipline\b|\bmajor\b|\bfield of study\b/i, "education", discipline],
  ]

  // -------------------------------------------------------------------------
  // question-shaped rules
  // -------------------------------------------------------------------------
  const employers = (profile.experience ?? [])
    .map((e) =>
      String(e.company ?? "")
        .toLowerCase()
        .trim(),
    )
    .filter(Boolean)

  // =========================================================================
  // PRIOR EMPLOYMENT — THIS RULE NO LONGER ANSWERS. EVER. READ THIS BEFORE
  // "FIXING" THE DEFERRAL.
  // =========================================================================
  // It used to answer "No" whenever the named company was absent from
  // `profile.experience`. Three rounds of patching tried to make that safe by
  // improving the SUBJECT EXTRACTOR, and all three failed:
  //
  //   round 1 (2026-08-05) — a placeholder DENYLIST. "our company" was caught;
  //     "this employer or its related entities" was not, because "related" was
  //     the one token nobody had listed -> OK "No".
  //   round 2 (2026-08-06) — the test INVERTED to require positive evidence of
  //     a name, with an adjacency rule. One intervening word defeated it:
  //     "a related company", "the successor entity", "an affiliated entity"
  //     -> OK "No". The {2,40} capture also cut a long subject off mid-word,
  //     and the stub read as evidence of a name -> OK "No" about nobody.
  //   round 3 (2026-08-06) — adjacency dropped, relation vocabulary widened,
  //     mid-word captures rejected. An adversary then drove 54 fresh
  //     prior-employment questions and 44 of them still fabricated OK "No"
  //     reaching how:"fill":
  //       "Have you ever been employed by the University?"        -> "No"
  //       "...by the Hospital?" "...the District?" "...the Trust?" -> "No"
  //       "...for the recruiting company?" "...the potential employer?" -> "No"
  //     The vocabulary of generic organisation nouns is a denylist over
  //     unbounded third-party label text, and it cannot be finished.
  //
  // THE DENYLIST WAS NEVER THE REAL BUG, AND THAT IS WHY THE DESIGN CHANGED
  // INSTEAD OF THE VOCABULARY. Even with a PERFECT extractor the rule is
  // unsound. It answers "No, I have never worked for X" by checking that X is
  // absent from `profile.experience` — and the fact base is a DISTILLED
  // RESUME, not an exhaustive employment history. A resume omits jobs: short
  // stints, unrelated work, anything its owner chose to leave off. So "absent
  // from profile.experience" has never meant "never worked there", and a "No"
  // built on it can be a FALSE STATEMENT ABOUT THE OWNER'S OWN HISTORY, made
  // in their name, on a real application, with a checkbox next to it. That is
  // hard rule 1 (documents and answers may only contain facts the fact base
  // holds), and no amount of vocabulary reaches it.
  //
  // SO BOTH BRANCHES DEFER, and each says WHICH case it is, because the owner
  // reads these notes in pending-questions.mjs:
  //
  //   * subject matches a company in profile.experience — the true answer is
  //     "Yes", and that is an assertion the owner makes about their own
  //     history (in what capacity, over what dates), not one the pipeline
  //     makes for them.
  //   * subject does not match, or the question named nobody — the fact base
  //     cannot establish absence, so there is no truthful answer to fill.
  //
  // RE-ENABLING THE AUTO-"No" REQUIRES AN EXHAUSTIVE EMPLOYMENT RECORD, WHICH
  // `profile.yaml` IS NOT. If a future fact base ever gains one — a field that
  // asserts "this list is complete", set by the owner, not inferred — then
  // this rule may answer the negative again, and only for subjects it
  // extracted whole. Until then, a deferral here is not a throughput bug to
  // revert: it is the system correctly reporting that nothing it holds can
  // answer the question. Throughput on this field rises the three lawful ways
  // (adapter, probed options, banked answer) — an exact banked answer already
  // wins, because the exact-bank lookup in resolveField runs BEFORE
  // QUESTION_RULES.
  //
  // isPlaceholderSubject() (intents.mjs) IS KEPT AND STILL EARNS ITS PLACE,
  // but its job is now much smaller and it is no longer what stands between
  // the owner and a fabricated statement: it only chooses WHICH deferral
  // reason the owner reads ("the question named no company" vs. "the fact base
  // cannot establish absence"). If it fails open now, the cost is a slightly
  // wrong sentence in a question, not a false answer on a form.
  const NO_COMPANY_NAMED =
    'the question names no company ("our company", "this employer", "us"), so there is nothing to check the employment history against — and profile.yaml could not settle it even if there were: it is a distilled resume, not an exhaustive employment record. Answer this one yourself.'
  const PRIOR_EMPLOYMENT_LISTED = (co) =>
    `profile.experience lists "${co}" — your own history shows this employer, so the truthful answer is not "No". Exactly what to say (and in what capacity and over what dates) is an assertion about your history that only you can make, so this is deferred rather than answered.`
  const PRIOR_EMPLOYMENT_ABSENT = (co) =>
    `"${co}" is not in profile.experience — but profile.yaml is a distilled resume, not an exhaustive employment record, so its silence is NOT evidence that you never worked there. Nothing in the fact base can establish a truthful "No". Answer this one yourself.`
  const priorEmployment = (label) => {
    const t = typeQuestion(label)
    if (!t || t.concept !== "prior_employment" || t.polarity === null) {
      return {
        value: "",
        note: "could not establish what this question asserts about prior employment",
      }
    }
    const co = t.param
    if (!co) return { value: "", note: NO_COMPANY_NAMED }
    const worked = employers.some((e) => e.includes(co) || co.includes(e))
    // NOTHING RETURNS A VALUE FROM HERE. `value: ""` sets `hit` with an empty
    // value, and resolveField's `if (hit)` branch turns that into UNKNOWN
    // carrying this note — a stated deferral the owner can act on, which is
    // what pending-questions.mjs surfaces.
    return {
      value: "",
      note: worked ? PRIOR_EMPLOYMENT_LISTED(co) : PRIOR_EMPLOYMENT_ABSENT(co),
    }
  }

  // User decision 2026-07-28: prefer the banked answer, fall back to "Other"
  // (with "found it online" as the written explanation), then LinkedIn.
  //
  // Returns bankHit(...) rather than a bare chain, so a `banked` hit carries
  // its bank id (see bankHit's comment above) and passes through fill-plan's
  // datum/assertion classifier gate the same as an exact/fuzzy bank match
  // does. When there is no banked entry the chain is pure fallback wording
  // ("Other"/"LinkedIn") with nothing from the bank to classify.
  const heardAbout = () => {
    const banked = bank.find((a) =>
      /how did you (hear|first learn|find out|come to know)/i.test(a.question),
    )
    const chain = []
    if (banked?.answer) chain.push(banked.answer)
    chain.push("Other", "LinkedIn")
    return bankHit(banked, chain)
  }

  const QUESTION_RULES = [
    [
      // The intent's OWN concept pattern, imported rather than re-spelled.
      // The literal that used to sit here required the word "previously", so
      // "Have you NEVER been employed at Globex?" and "Are you a former
      // employee of Globex?" never reached the rule at all — the profile
      // could answer both and did not. Sharing the pattern means the rule
      // fires on exactly the phrasings intents.mjs can type, and
      // priorEmployment() returns "" for anything it cannot settle, which
      // still lands on a defer.
      intentFor("prior_employment").match,
      "experience",
      priorEmployment,
    ],
    [
      /how did you (hear|first learn|find out|come to know)\b/i,
      "answers",
      heardAbout,
    ],
  ]

  const exactBank = new Map()
  for (const a of bank) {
    const key = normalizeQuestion(a.question)
    // First entry wins, so a later duplicate cannot shadow the original.
    if (key && !exactBank.has(key)) exactBank.set(key, a)
  }

  // Entries the closed intent set claims. Computed ONCE per resolver, not per
  // field: typeQuestion() runs a handful of regexes per entry and the bank is
  // re-scanned for every field otherwise.
  const untypedBank = bank.filter((a) => !isTypedQuestion(a.question))

  // The plain token-similarity tier, for labels the closed set does not claim.
  //
  // THE FENCE (item 2.1): it sees `untypedBank`, never the whole bank. A fact
  // the intent set has typed — a work-authorization answer, a sponsorship
  // answer, an age attestation — can only ever be reached through
  // resolveIntent(), where it arrives with a polarity attached. Token overlap
  // gets no vote on a typed fact in either direction: a typed LABEL never
  // reaches this function (see the intent pass in resolveField), and a typed
  // ENTRY is not in the list this function ranks. Without the second fence the
  // bug walks back in through the side door — an untyped label like "Visa
  // status" fuzzy-matching a banked sponsorship answer is the same
  // string-copy with the same failure mode.
  //
  // THE THIRD FENCE — `fuzzy: false` (2026-08-06). The own-job guard DROPS the
  // two `current-job` rules rather than blanking them, deliberately, so that a
  // banked answer to exactly that question still wins. With an EMPTY bank —
  // which is what every current-job test constructed — the label then fell to
  // UNKNOWN and the suite was green. With a REAL bank it falls to THIS
  // function, and a similarity of >= 0.7 refilled the requisition with the
  // owner's own job, re-opening three of the four holes the guard had just
  // closed. Verified by execution 2026-08-06 against a bank holding the
  // owner's own answers ("Current Employer" -> "Globex", "Job Title" ->
  // "Engineer"):
  //
  //   "Hiring Company"                       -> OK "Globex"   (a-003@0.90)
  //   "Requisition Title" / "Vacancy Title"  -> OK "Engineer"  (a-004@0.90)
  //   "Current Employer (Hiring Company)"    -> OK "Globex"   (a-001@0.90)
  //   "Employer" [Years of Experience]       -> OK "Globex"   (a-001@0.90)
  //
  // The INTENT was right and is kept: a banked answer to that exact question
  // should still win. The THRESHOLD is what was wrong. So when the own-job
  // evidence test failed on a label whose subject IS the own job, this tier is
  // restricted to an EXACT normalised match and nothing else — the same
  // `normalizeQuestion` key the exact-bank lookup uses, so "exact" means one
  // thing in this file and there is no second copy of the matching logic to
  // drift. (In practice such a label has already been answered by the exact
  // lookup at the top of resolveField, so this is belt and braces — and it
  // stays correct if that ordering is ever changed.)
  function bestAnswer(label, { fuzzy = true } = {}) {
    const wanted = fuzzy ? null : normalizeQuestion(label)
    let best = null
    for (const a of untypedBank) {
      if (wanted !== null && normalizeQuestion(a.question) !== wanted) continue
      const score = similarity(label, a.question)
      if (!best || score > best.score) best = { ...a, score }
    }
    return best
  }

  // Resolves ONE field. `ctx.hasFieldFor`/`ctx.otherLinksValue` close over the
  // CURRENT batch of fields (see resolveAll) — a catch-all "Other links" box
  // must only add what THIS form has no dedicated field for, so it cannot be
  // built once for the whole resolver the way PROFILE_RULES can.
  function resolveField(f, ctx) {
    const label = String(f.l ?? "").trim()
    const opts =
      f.opts ??
      (Array.isArray(f.o) ? f.o.map((o) => o.l).filter(Boolean) : null)
    const requireOptions = CHOICE_TYPES.has(f.t)
    // One options object for every matchOption call below, so no tier can
    // forget the multi flag and quietly collapse a list answer to its first
    // element on a token picker. `f.multi` is scan-page.js's statement that
    // the control ACCEPTS several values (<select multiple>, react-select
    // multi); checkbox GROUPS never carry it — they are t:"checkbox" with
    // stamped options, resolve one pick, and keep deferring as
    // confirm-widget in buildPlan regardless of anything here.
    const matchOpts = { requireOptions, label, multi: !!f.multi }

    // ---- own-job evidence, computed ONCE -----------------------------------
    // Read by the `current-job` rule filter further down AND by the fuzzy bank
    // tier's fence, which is why it is hoisted here rather than left beside
    // the rules: two call sites deciding "is this label about the applicant's
    // own current job?" with two different tests is how the bank tier came to
    // answer the labels the rules had just refused.
    const section = String(f.section ?? "").trim()
    // The three vetoes. Each says the answer is about a different JOB
    // (APPLIED_TO, PAST_EMPLOYMENT_HEADING) or a different PERSON
    // (THIRD_PARTY_SUBJECT), and any one of them withholds the current-job
    // answer whatever evidence (a)-(d) found.
    const vetoed =
      APPLIED_TO.test(label) ||
      APPLIED_TO.test(section) ||
      THIRD_PARTY_SUBJECT.test(label) ||
      THIRD_PARTY_SUBJECT.test(section) ||
      PAST_EMPLOYMENT_HEADING.test(normalizeSection(section))
    const asksCurrentJob =
      !vetoed &&
      isBareOwnJobLabel(label) &&
      // A numbered row other than the first is asking about a job these two
      // rules cannot see — see rowOrdinal(). NaN (a numeral in a digit system
      // this file cannot read) fails this test too, which is the point.
      (rowOrdinal(label) ?? 1) === 1 &&
      (ASKS_CURRENT_JOB.test(label) || isOwnEmploymentSection(section))
    // WHETHER THE FUZZY BANK TIER MAY ANSWER THIS LABEL AT ALL.
    //
    // `ownJobSubjectLabel` asks the two `current-job` rules' OWN regexes
    // whether this label's subject is the employer or the job title — derived
    // from PROFILE_RULES rather than re-spelled, so it cannot come to name a
    // different set of labels than the guard does. When the subject IS the own
    // job and the evidence test FAILED, this label is exactly the case the
    // guard just refused to answer from profile.yaml, and letting a 0.7 token
    // overlap answer it from the bank instead is the same wrong answer by a
    // longer route (see bestAnswer's third fence for the executed evidence).
    // Such a label may still be answered by an EXACT banked question, and by
    // nothing else.
    //
    // Every other label is untouched: the fuzzy tier is how an ordinary banked
    // answer reaches an ordinary reworded question, and narrowing it further
    // would be a throughput regression with no defect behind it.
    const ownJobSubjectLabel = PROFILE_RULES.some(
      (r) => r[3] === "current-job" && r[0].test(label),
    )
    const bankFuzzyAllowed = asksCurrentJob || !ownJobSubjectLabel

    // AND THE BANK IS SILENCED ENTIRELY — exact match included — when the veto
    // is about a different PERSON or a different JOB.
    //
    // `bankFuzzyAllowed` above closes the fuzzy route and deliberately leaves
    // the EXACT route open, because for APPLIED_TO the label means what it
    // says: someone who banked an answer to the literal question "Position
    // Applied For" answered that question, and their answer is the answer.
    //
    // THIRD_PARTY_SUBJECT and PAST_EMPLOYMENT_HEADING are not like that. There
    // the label text is identical to a question about the applicant and MEANS
    // something else because of where it sits, so an exact match on the words
    // is exactly the wrong reason to trust it. Verified by execution
    // 2026-08-06, with profile/answers.yaml holding a banked "Current
    // Employer" — the veto below already refused the profile rules, and the
    // bank answered the same field a few lines later:
    //
    //   "Current Employer" [Emergency Contact] -> OK "Globex"   (the OWNER's)
    //   "Current Employer" [Reference]         -> OK "Globex"
    //   "Current Employer" [Next of Kin]       -> OK "Globex"
    //
    // Narrow on purpose: it applies ONLY when the label's subject is the
    // applicant's own job (`ownJobSubjectLabel`). A banked "Emergency Contact
    // Name" or "Reference Phone" is untouched — those labels are not about the
    // owner's job, the pipeline is meant to fill them, and widening this to
    // every field under such a heading would defer a whole block the bank can
    // legitimately answer.
    const ownJobBankSilenced =
      ownJobSubjectLabel &&
      (THIRD_PARTY_SUBJECT.test(label) ||
        THIRD_PARTY_SUBJECT.test(section) ||
        PAST_EMPLOYMENT_HEADING.test(normalizeSection(section)))

    // Radio/checkbox groups have no element of their own; resolve the answer
    // to the stamped key of the option to click so filling stays mechanical.
    const result = { k: f.k }
    const push = (status, source, value, note, values) => {
      let extra = note
      let pick
      let pickSel
      if (Array.isArray(f.o) && value) {
        const opt = f.o.find(
          (o) =>
            String(o.l).trim().toLowerCase() ===
            String(value).trim().toLowerCase(),
        )
        if (opt) {
          pick = opt.k
          pickSel = opt.sel
          extra = extra ? `${extra}; pick=${opt.k}` : `pick=${opt.k}`
        }
      }
      Object.assign(result, {
        sel: f.sel,
        t: f.t,
        req: f.req || undefined,
        label,
        status,
        source,
        value,
        // The grounded set from matchOption's multi branch — every element an
        // option the form really offers. `value` stays the joined string so
        // every existing reader (defer entries, disclosure, the printed plan)
        // keeps seeing one displayable string.
        values: Array.isArray(values) && values.length ? values : undefined,
        pick,
        pickSel,
        note: extra,
      })
      return result
    }

    // A choice-shaped field with no recorded options is UNPROBED — that note
    // is more useful than a bare "options: " (which would otherwise read as
    // "no option matched an offered list" when really no list was ever seen).
    // A truncated (but non-empty) list gets a caveat instead: the field-cache
    // layer flags `optsTruncated` when the recorded list may not be complete
    // (see field-cache.mjs), and "no match in a possibly-incomplete list" is
    // not the same fact as "this value is not offered".
    const noteFor = (m) => {
      if (!m.needsChoice) return undefined
      if (m.unprobed) {
        return "field was not probed — no options were recorded, so the resolved value could not be checked against the real list"
      }
      const base = `options: ${(opts ?? []).join(" | ")}`
      if (!f.optsTruncated) return base
      // f.optsTotal, when field-cache or a scanner recorded the REAL count,
      // turns a bare caveat into a number the caller can act on ("verify by
      // hand" vs. "37 unseen options exist").
      const scale = f.optsTotal
        ? ` — ${(opts ?? []).length} of ${f.optsTotal} shown`
        : ""
      return `${base} (option list may be truncated${scale} — verify by hand before assuming the value is unavailable)`
    }

    if (SKIP_TYPES.has(f.t)) {
      return push("SKIP", f.t, "", "attach the rendered PDF / paste the letter")
    }
    if (!label) {
      return push("UNKNOWN", "-", "", "no label found — inspect the page")
    }

    // IDENTITY FIRST (Phase 0.7). Name, email and phone must go out
    // BYTE-IDENTICAL on every form, from profile.yaml and nowhere else.
    //
    // What this fixes: the exact-bank lookup immediately below runs before
    // ctx.CONTACT_RULES, so an answers.yaml entry whose question normalizes to
    // "email" or "phone" silently outranked profile.contact — and the answer
    // bank is where a per-board plus-alias ("jane+greenhouse@...") or a
    // differently punctuated phone number would live. Two forms would then
    // carry two different renderings of the same identity, which is both a
    // linkability leak across employers and the "format drift" 0.7 names.
    //
    // Deliberately NARROW. It applies only to rules flagged `"identity"` in
    // CONTACT_RULES; LinkedIn, GitHub, website, location and street address
    // are untouched, and an exact bank answer still outranks profile for all
    // of them. It also respects CONTACT_RULES ORDER by taking the FIRST rule
    // that matches — "Name Pronunciation" and "Middle Name" are earlier,
    // unflagged rules, so they still resolve as they did rather than being
    // handed the legal name.
    //
    // NO FALL-THROUGH when the profile is empty. If profile.contact has no
    // phone, the field is UNKNOWN and says so; it does NOT become the bank's
    // to answer. A single source is what makes byte-identity checkable at
    // all, and "profile, or nobody" is that source.
    const identityRule = (ctx.CONTACT_RULES ?? []).find(([re]) =>
      re.test(label),
    )
    if (identityRule && identityRule[3] === "identity") {
      const [, idSource, idValue] = identityRule
      const out = typeof idValue === "function" ? idValue(label) : idValue
      if (!out) {
        return push("UNKNOWN", idSource, "", `not in profile.${idSource}`)
      }
      const m = matchOption(out, opts, matchOpts)
      return push(
        m.needsChoice ? "NEEDS-CHOICE" : "OK",
        idSource,
        m.value,
        noteFor(m),
        m.values,
      )
    }

    // Ahead of EEO too: if the user actually answered a self-ID question,
    // their answer is the answer — auto-declining over it would discard it.
    //
    // `ownJobBankSilenced` is the one thing that outranks that, and only for a
    // label whose subject is the applicant's own job sitting under a heading
    // about somebody else or about a former job. This lookup is what actually
    // filled "Current Employer" [Emergency Contact] with the owner's employer
    // (source `a2@exact`) after the profile rules had already refused it — it
    // runs BEFORE them, so gating the later `bestAnswer` call alone changed
    // nothing. Both routes are gated now; see the definition for the reasoning.
    const exact = ownJobBankSilenced
      ? undefined
      : exactBank.get(normalizeQuestion(label))
    if (exact) {
      // The same decline-shape recognition the EEO branch below uses, and for
      // the same reason (see its comment) — an exact question match is if
      // anything the STRONGER signal, so it must not defer on a wording
      // mismatch a fuzzy match already resolves. MEASURED alongside it: banked
      // "Disability Status" -> "I do not want to answer" hit this exact branch
      // byte-for-byte on a live Twilio form and still deferred, because
      // Twilio's own decline option reads "I don't wish to answer" and
      // matchOption() does not ground synonyms. Scoped to EEO_RE labels only —
      // a decline is dispositive of intent specifically because these fields
      // are voluntary; a non-EEO exact match still must ground literally.
      if (EEO_RE.test(label) && DECLINE_RE.test(exact.answer)) {
        const decline = (opts ?? []).find((o) => DECLINE_RE.test(o))
        if (decline) {
          return push(
            "OK",
            `${exact.id}@exact${(exact.source ?? "user") === "model" ? ":model" : ""}`,
            decline,
          )
        }
      }
      const m = matchOption(exact.answer, opts, matchOpts)
      return push(
        m.needsChoice ? "NEEDS-CHOICE" : "OK",
        `${exact.id}@exact${(exact.source ?? "user") === "model" ? ":model" : ""}`,
        m.value,
        noteFor(m),
        m.values,
      )
    }

    if (EEO_RE.test(label)) {
      // The exact-match branch above honours a banked self-ID answer only when
      // the board words the question byte-identically to the way it was banked,
      // and no two boards word these the same.
      //
      // MEASURED 2026-08-06, against a bank holding "Race" -> "Hispanic or
      // Latino": the label "Race" resolved from the bank, while "Race /
      // Ethnicity", "What is your race/ethnicity?" and "Please select your
      // race" all resolved to "Decline to self identify" at status OK — filled
      // and submitted with no review, contradicting the answer the user had
      // actually given. Auto-declining is meant to spare the user a question
      // they did not answer, never to overwrite one they did.
      //
      // So the same fuzzy match the rest of this file trusts at 0.7 runs first,
      // for the reason stated above the exact branch: if the user answered a
      // self-ID question, their answer is the answer. Below 0.7 this still
      // declines rather than raising a MAYBE — these fields are voluntary, a
      // weak match is not worth a question, and declining asserts nothing about
      // the user. A banked answer that does not ground to an option on offer
      // defers, which is the wording mismatch being surfaced, not a value.
      const banked = bestAnswer(label, { fuzzy: bankFuzzyAllowed })
      if (banked && banked.score >= 0.7) {
        // MEASURED 2026-08-06, on a live Twilio application: profile/answers.yaml
        // banks EEO declines under several boards' own wording ("I do not want
        // to answer", "Decline to self-identify", "I don't wish to answer") —
        // each saved from a real form, none identical to another. Grounding
        // "Decline to self-identify" against Twilio's literal option text
        // ("I don't wish to answer") failed with no substring in common, so
        // gender and veteran status deferred to the user despite the bank
        // holding a clear decline and the board offering one to decline with.
        //
        // A decline is not a substantive claim the way "Hispanic or Latino"
        // is — every wording of it means the same one thing, so recognising it
        // by SHAPE (the same DECLINE_RE the auto-decline below already uses,
        // not a new vocabulary) and mapping it to THIS board's own decline
        // option is not inventing an answer; it is the identical mapping the
        // no-bank-hit path two lines down performs, reached one gate earlier.
        // A SUBSTANTIVE banked answer still falls through to matchOption()
        // and must still ground literally or defer — this shortcut fires only
        // when the bank itself already declined.
        if (DECLINE_RE.test(banked.answer)) {
          const decline = (opts ?? []).find((o) => DECLINE_RE.test(o))
          if (decline) {
            return push(
              "OK",
              `${banked.id}@${banked.score.toFixed(2)}`,
              decline,
            )
          }
        }
        const m = matchOption(banked.answer, opts, matchOpts)
        return push(
          m.needsChoice ? "NEEDS-CHOICE" : "OK",
          `${banked.id}@${banked.score.toFixed(2)}`,
          m.value,
          noteFor(m),
          m.values,
        )
      }
      const decline = (opts ?? []).find((o) => DECLINE_RE.test(o))
      if (decline) return push("OK", "eeo:decline", decline)
      return push("UNKNOWN", "eeo", "", "voluntary self-ID — ask the user")
    }

    let hit = null
    // The two `current-job` rules answer "what is the applicant's CURRENT
    // job?", so they run ONLY on positive evidence that this label is asking
    // it: WHICH job (ASKS_CURRENT_JOB on the label, or isOwnEmploymentSection
    // on the heading the field sits under) AND that the label is shaped like a
    // bare work-history field at all (isBareOwnJobLabel) AND that any row index
    // it carries is row one (rowOrdinal). APPLIED_TO vetoes every one of those,
    // on the section text as well as the label, because both are read as
    // evidence. See the block above APPLIED_TO for the four conditions in full,
    // for why the earlier "drop them when the label says 'applied'" test was
    // the wrong way round, and for the executed evidence that WHICH-job
    // evidence alone still handed "Current Hiring Company" the user's own
    // employer.
    //
    // They are DROPPED rather than blanked so the label still falls through to
    // the bank: a user who banked an answer to exactly this question still
    // gets it, and everything else lands on UNKNOWN, which defers to the user.
    // The other PROFILE_RULES are untouched. THAT FALL-THROUGH HAD A HOLE IN
    // IT — see `bankFuzzyAllowed` at the top of this function and bestAnswer's
    // third fence.
    const profileRules = asksCurrentJob
      ? PROFILE_RULES
      : PROFILE_RULES.filter((r) => r[3] !== "current-job")
    // QUESTION_RULES run for both shapes and take precedence; PROFILE_RULES
    // are field-label rules and must not fire on a question.
    const rules = IS_QUESTION.test(label)
      ? [...QUESTION_RULES, ...ctx.CONTACT_RULES]
      : [...QUESTION_RULES, ...ctx.CONTACT_RULES, ...profileRules]
    for (const [re, source, value] of rules) {
      if (re.test(label)) {
        const out = typeof value === "function" ? value(label) : value
        // A rule fn that pulled its answer from `bank` (not just from
        // profile.yaml) must say so by returning `bankHit(entry, value)`
        // instead of a bare value — see bankHit()'s comment. This is the
        // ONLY way a QUESTION_RULES/PROFILE_RULES hit's `source` can carry a
        // bank id; a bare value always gets the rule's own static source
        // string, which fill-plan.mjs's BANK_ID_RE cannot match, which means
        // it is NEVER run through answerClass()'s datum/assertion gate. That
        // was exactly how heardAbout() bypassed the gate (AUDIT N3) — it read
        // `bank.find(...)` directly and returned a bare value, so a banked
        // answer to a future rule shaped like a work-authorization question
        // would resolve OK unclassified.
        //
        // The same object return also carries an optional `note`: a rule that
        // knows WHY it cannot answer says so, instead of the generic
        // "not in profile.<source>" below. That generic line was actively
        // wrong for a placeholder-subject prior-employment question — the fact
        // base is not missing anything there, the question named no company —
        // and it is what the owner reads in pending-questions.mjs.
        hit =
          out &&
          typeof out === "object" &&
          !Array.isArray(out) &&
          "value" in out
            ? { source: out.source ?? source, value: out.value, note: out.note }
            : { source, value: out }
        break
      }
    }
    if (hit) {
      // A rule may return a list of acceptable answers; an empty list is
      // still "no answer", and an empty array is truthy.
      const empty = Array.isArray(hit.value)
        ? !hit.value.filter(Boolean).length
        : !hit.value
      if (!hit.source || empty) {
        return push(
          "UNKNOWN",
          hit.source ?? "-",
          "",
          hit.note ?? `not in profile.${hit.source ?? "contact"}`,
        )
      }
      const m = matchOption(hit.value, opts, matchOpts)
      return push(
        m.needsChoice ? "NEEDS-CHOICE" : "OK",
        hit.source,
        m.value,
        noteFor(m),
        m.values,
      )
    }

    // ---- TYPED INTENTS (item 2.1) ----------------------------------------
    // The load-bearing property is that this branch RETURNS on every path.
    // A label the closed set claims never falls through to token similarity,
    // whatever the intent decided — answer, defer for unestablished polarity,
    // defer for an empty fact base, defer because it is an agreement. That is
    // what makes the wrong-truth-value outcome unreachable rather than
    // merely unlikely: there is no second opinion to fall back on, so no
    // scoring threshold can be tuned until a string copy wins again.
    //
    // The value is a BOOLEAN by the time it gets here. It is rendered as
    // "Yes"/"No" and put through the same matchOption() grounding the rest of
    // this file uses, so a form offering "No, I will not require sponsorship"
    // still resolves and a form offering "Yes, 5+ years professionally" still
    // does not (AUDIT C1) — but the prefix bug cannot originate on this path
    // at all, because a boolean has no prefix to extend.
    const intent = resolveIntent(label, bank)
    if (intent) {
      const optNote =
        opts && opts.length ? `; options: ${opts.join(" | ")}` : ""
      if (intent.decision === "answer") {
        const m = matchOption(intent.value ? "Yes" : "No", opts, matchOpts)
        // The `a-NNN@` prefix is what fill-plan.mjs's BANK_ID_RE keys on, so
        // an assertion-class entry still routes through the datum/assertion
        // gate and still becomes a CONFIRM defer. A typed intent must not be
        // a way around that gate — it stamps the SAME shape of source a fuzzy
        // or exact bank hit stamps.
        const src = intent.provenance.id
          ? `${intent.provenance.id}@intent`
          : `intent:${intent.concept}`
        return push(
          m.needsChoice ? "NEEDS-CHOICE" : "OK",
          src,
          m.value,
          noteFor(m) ?? describeIntent(intent),
        )
      }
      // A defer with a related banked fact is NEEDS-CHOICE (the user already
      // told the fact base something adjacent — surface it, refuse to copy
      // it); a defer with nothing behind it is UNKNOWN, which is what routes
      // the question into pending-questions.mjs to be asked once and saved.
      if (intent.provenance.source === "bank") {
        return push(
          "NEEDS-CHOICE",
          `${intent.provenance.id}@intent`,
          "",
          `${intent.reason} — confirm by hand: "${intent.provenance.question}" -> ${intent.provenance.answer}${optNote}`,
        )
      }
      return push(
        "UNKNOWN",
        `intent:${intent.concept}`,
        "",
        `${intent.reason}${optNote}`,
      )
    }

    // `fuzzy: false` when the label's subject is the applicant's own job and
    // the evidence test refused it — the MAYBE tier below is gated on the same
    // `best`, so a requisition label cannot come back as a MAYBE carrying the
    // owner's employer either. `ownJobBankSilenced` goes further and withholds
    // the bank altogether; see its definition for why an EXACT match is the
    // wrong reason to trust a label sitting under someone else's heading.
    const best = ownJobBankSilenced
      ? null
      : bestAnswer(label, { fuzzy: bankFuzzyAllowed })
    if (best && best.score >= 0.7) {
      const m = matchOption(best.answer, opts, matchOpts)
      return push(
        m.needsChoice ? "NEEDS-CHOICE" : "OK",
        `${best.id}@${best.score.toFixed(2)}`,
        m.value,
        noteFor(m),
        m.values,
      )
    }
    if (best && best.score >= 0.45) {
      return push(
        "MAYBE",
        `${best.id}@${best.score.toFixed(2)}`,
        best.answer,
        `bank asks: ${best.question}`,
      )
    }
    return push(
      "UNKNOWN",
      "-",
      "",
      opts ? `options: ${opts.join(" | ")}` : undefined,
    )
  }

  // Whether this same form already has its own field for something, so a
  // catch-all "Other links" box does not duplicate what is captured elsewhere
  // (user decision 2026-07-28). Rebuilt per call because it depends on the
  // CURRENT batch of fields, not on the fact base.
  function resolveAll(fields) {
    const hasFieldFor = (re) => fields.some((f) => re.test(String(f.l ?? "")))
    const otherLinksValue = () => {
      const parts = []
      if (contact.github && !hasFieldFor(/git-?hub/i))
        parts.push(contact.github)
      if (
        contact.website &&
        !hasFieldFor(/\b(portfolio|personal (web)?site|website)\b/i)
      ) {
        parts.push(contact.website)
      }
      return parts.join("  ")
    }

    // The 4th element `"identity"` marks the name/email/phone rules that
    // resolveField() resolves BEFORE the answer bank (Phase 0.7): those three
    // go out byte-identically on every form, from profile.yaml only. Every
    // unflagged rule keeps the old precedence, where an exact bank answer
    // wins. Order still matters and is unchanged — the unflagged
    // middle-name and name-pronunciation rules sit ahead of the full-name
    // rule on purpose, and the identity pass takes the first match, not the
    // first identity match.
    const CONTACT_RULES = [
      [/\b(first|given)\s*name\b/i, "contact.name", nameParts[0], "identity"],
      [
        /\b(last|family|sur)\s*name\b|\bsurname\b/i,
        "contact.name",
        nameParts.length > 1 ? nameParts[nameParts.length - 1] : "",
        "identity",
      ],
      [/\bmiddle\s*(name|initial)\b/i, null, ""],
      // "Name Pronunciation" asks how to say it, not what it is — an anchored
      // /^name\b/ answered that with the name itself on a real Affirm form.
      [/\bname pronunciation\b|\bpronounce\b/i, null, ""],
      [
        /^name\s*\*?\s*:?\s*$|\b(full|legal|preferred|display) name\b|\byour name\b/i,
        "contact.name",
        contact.name ?? "",
        "identity",
      ],
      [/e-?mail/i, "contact.email", contact.email ?? "", "identity"],
      [
        /\b(phone|mobile|cell|telephone)\b/i,
        "contact.phone",
        contact.phone ?? "",
        "identity",
      ],
      [/linked-?in/i, "contact.linkedin", contact.linkedin ?? ""],
      [/git-?hub/i, "contact.github", contact.github ?? ""],
      [
        /\b(portfolio|personal (web)?site|website|blog|other url)\b/i,
        "contact.website",
        contact.website ?? "",
      ],
      [/\b(city|town)\b/i, "contact.location", locParts[0] ?? ""],
      [
        /\b(state|province|region)\b/i,
        "contact.location",
        stateCandidates(locParts[1]),
      ],
      [
        /\bother links\b|\badditional links\b|\bother profiles\b/i,
        "contact",
        otherLinksValue(),
      ],
      // A street address is NOT the city-level `contact.location`. Greenhouse
      // asks for "Address Line 1" / "Address Line 2" alongside separate
      // City/State/Postal fields, and letting the generic location rule below
      // match them put "North Las Vegas, NV" in the street slot and then
      // repeated it on line 2. The street address is not a profile fact — it
      // lives in the answer bank, so these resolve from there by exact
      // question match and nowhere else. An empty result is UNKNOWN, which is
      // correct: line 2 is optional and stays blank.
      [
        /\baddress\s*line\s*2\b|\b(apt|apartment|suite|unit)\b/i,
        "bank.address2",
        () =>
          bankedAddress(/address\s*line\s*2|\b(apt|apartment|suite|unit)\b/i),
      ],
      [
        /\baddress\s*line\s*1\b|\bstreet\s*address\b/i,
        "bank.address1",
        () => bankedAddress(/address\s*line\s*1|street\s*address/i),
      ],
      [
        /\b(current )?(location|address)\b|\bwhere are you (currently )?(located|based)\b/i,
        "contact.location",
        contact.location ?? "",
      ],
    ]

    const results = fields.map((f) => resolveField(f, { CONTACT_RULES }))
    const counts = results.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1
      return acc
    }, {})
    return { results, counts }
  }

  // Called only from the address rules above, after `bank` is populated.
  const bankedAddress = (re) =>
    bank.find((a) => re.test(String(a.question ?? "")))?.answer ?? ""

  return { resolveAll }
}

// Convenience: the common case of loading the fact base from disk once and
// resolving one batch of fields against it. `fill-plan.mjs`'s own
// `resolveFields` wraps this for its callers (which include
// `pending-questions.mjs` and, transitively, `automatability.mjs`).
// DEFAULT FACT-BASE PATHS. `factBasePath` and not a destructuring default,
// and that is the whole fix for QA-0.12-1 — a live defect since 147eb68
// (2026-07-30), found by qa's 0.12 measurement and confirmed here against
// jobs/coinbase-software-engineer/scan-p1.json: 15 OK / 3 CONFIRM / 8 UNKNOWN
// with the paths omitted, versus 2 OK / 31 UNKNOWN with them passed as `null`.
//
// A DESTRUCTURING DEFAULT FIRES ONLY ON `undefined`. All three callers
// (fill-plan.mjs's resolveFields, pending-questions.mjs, and
// automatability.mjs's batched classify) build their options object from a
// CLI flag helper that returns `null` when the flag is absent, so every
// documented no-flag invocation — `node scripts/apply/fill-plan.mjs <slug>` —
// passed `profileFile: null`. `fs.existsSync(null)` does not throw on Node 24;
// it returns false and emits DEP0187. So both files "did not exist", both
// loaded as `{}`, and the resolver ran against an EMPTY FACT BASE, resolving
// essentially everything UNKNOWN. The tier classifier has been reading the
// same empty base, which is a very plausible part of why green was never
// reachable.
//
// WHY COERCE RATHER THAN THROW. The failure mode worth designing out is that
// it fails OPEN into "I know nothing about the user" — silently, with every
// existing test still green, because a resolver that answers nothing answers
// nothing wrongly either. Throwing would also be loud, but "no path given"
// genuinely does mean "use the standard location" at all three call sites and
// on the CLI; making that the ONE meaning removes the ambiguity rather than
// moving it. What must never again mean "there is no fact base" is the
// ABSENCE of an argument. A path that is given and does not exist still
// yields `{}` — that case is a real answer to a real question ("this fixture
// has no bank"), and tests depend on it.
const factBasePath = (given, dflt) =>
  typeof given === "string" && given.trim() ? given : dflt

export function resolveFieldsFromFiles(
  fields,
  { profileFile, answersFile } = {},
) {
  const pFile = factBasePath(profileFile, "profile/profile.yaml")
  const aFile = factBasePath(answersFile, "profile/answers.yaml")
  const profile = fs.existsSync(pFile) ? (loadYamlFile(pFile) ?? {}) : {}
  const answersDoc = fs.existsSync(aFile) ? (loadYamlFile(aFile) ?? {}) : {}
  return createResolver(profile, answersDoc).resolveAll(fields)
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function readStdin() {
  try {
    return fs.readFileSync(0, "utf8")
  } catch {
    return ""
  }
}

function main() {
  const args = process.argv.slice(2)
  function flag(name, dflt) {
    const i = args.indexOf(name)
    if (i !== -1) {
      const v = args[i + 1]
      args.splice(i, 2)
      return v
    }
    return dflt
  }
  const profileFile = flag("--profile", "profile/profile.yaml")
  const answersFile = flag("--answers", "profile/answers.yaml")
  const inlineFields = flag("--fields", null)
  const asJson = args.includes("--json")

  const raw = inlineFields ?? readStdin()
  if (!raw.trim()) {
    console.error(
      'Usage: answer-bank.mjs --fields \'[{"k":"f1","t":"text","l":"Email"}]\' (or pipe the scan JSON on stdin)',
    )
    process.exit(2)
  }
  let fields
  try {
    const parsed = JSON.parse(raw)
    fields = Array.isArray(parsed) ? parsed : parsed.fields
  } catch (e) {
    console.error(`Could not parse input as JSON: ${e.message}`)
    process.exit(2)
  }
  if (!Array.isArray(fields)) {
    console.error(
      'Input must be a fields array or a scan object with "fields".',
    )
    process.exit(2)
  }

  const { results, counts } = resolveFieldsFromFiles(fields, {
    profileFile,
    answersFile,
  })

  if (asJson) {
    console.log(JSON.stringify({ counts, results }, null, 2))
  } else if (isTerse()) {
    for (const r of results) {
      console.log(
        [r.k, r.status, r.source, r.value, r.note ?? ""].join("\t").trimEnd(),
      )
    }
    console.log(
      `# ${results.length} fields: ` +
        Object.entries(counts)
          .map(([k, v]) => `${k}=${v}`)
          .join(" "),
    )
  } else {
    for (const r of results) {
      const head = `${r.k} [${r.status}] ${r.label}`
      console.log(r.value ? `${head}\n    -> ${r.value}  (${r.source})` : head)
      if (r.note) console.log(`    ${r.note}`)
    }
    console.log(
      `\n${results.length} fields — ` +
        Object.entries(counts)
          .map(([k, v]) => `${v} ${k}`)
          .join(", "),
    )
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) main()
