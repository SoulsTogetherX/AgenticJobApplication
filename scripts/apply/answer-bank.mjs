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

// Some questions are near-identical in wording but OPPOSITE in meaning.
// "Do you require sponsorship?" and "Are you legally authorized to work?" share
// almost every token, so token similarity ranked the authorization answer
// ("Yes") against the sponsorship question — which would have claimed the user
// needs a visa. Concepts are matched before, and constrain, the fuzzy pass.
//
// Order matters: a label naming both ("...sponsorship... to maintain
// authorization to work...") is about sponsorship.
//
// Concept alone is not enough: a label can name the sponsorship concept while
// actually negating it ("...authorized to work WITHOUT sponsorship..."). That
// is a polarity problem, not a concept problem — see the polarity guard
// further down, which runs after this match and can still defer a same-concept
// hit rather than copy its answer verbatim.
const CONCEPTS = [
  ["sponsorship", /\bsponsor(ship|ed|s)?\b|\bvisa\b/i],
  [
    "work_authorization",
    /\b(legally\s+)?authoriz(ed|ation)\s+to\s+work\b|\bwork\s+authoriz(ation|ed)\b|\bright to work\b|\beligible to work\b/i,
  ],
]
const conceptOf = (text) =>
  CONCEPTS.find(([, re]) => re.test(String(text ?? "")))?.[0] ?? null

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
export function matchOption(
  value,
  opts,
  { requireOptions = false, label = "" } = {},
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

  for (const v of candidates) {
    const exact = real.find((o) => o.trim().toLowerCase() === v.toLowerCase())
    if (exact) return { value: exact }

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
    if (grounded) return { value: grounded }

    if (YES.test(v) || NO.test(v)) {
      const want = YES.test(v) ? YES_LONG : NO_LONG
      const hit = real.find((o) => {
        const m = want.exec(o.trim())
        if (!m) return false
        return remainderIsGrounded(o.trim().slice(m[0].length), label)
      })
      if (hit) return { value: hit }
    }
  }
  return { value: first, needsChoice: true }
}

// ---------------------------------------------------------------------------
// polarity guard
// ---------------------------------------------------------------------------
// A fuzzy match can land on the right CONCEPT and still hand back the wrong
// TRUTH VALUE. "Are you authorized to work in the U.S. WITHOUT company
// sponsorship?" shares almost every token with a banked "Will you require
// sponsorship for employment visa status?" and both fall in the sponsorship
// concept bucket above — but "without sponsorship" inverts what the form is
// actually asking. The question's real subject is work authorization, using
// the sponsorship clause as a negated qualifier, not as its subject. Copying
// that bank entry's literal "No" verbatim would assert the OPPOSITE of the
// truth on the single highest-stakes field on the form.
//
// Below exact-label confidence there is no reliable way to tell a genuine
// restatement from an inverted one apart, so a polarity mismatch on a yes/no
// answer defers instead of guessing (2026-07-30). Auto-inverting was
// considered and rejected: "are you unable to work without sponsorship" is a
// double negative, and getting that flip subtly wrong is no safer than the
// bug this guards against — one extra question beats a silently flipped
// answer. The exact-question lookup above is untouched: identical text cannot
// be mismatched in polarity with itself.
const NEGATION_RE =
  /\bwithout\b|\bunable\b|\bcannot\b|\bcan'?t\b|\bnever\b|\bdon'?t\b|\bdoesn'?t\b|\bwon'?t\b|\bnot\b|\bno\b/i
const isNegated = (text) => NEGATION_RE.test(String(text ?? ""))

// The guard only applies to answers that are themselves a yes/no fact — a
// negation mismatch on a free-text answer (an employer name, a discipline)
// is not a truth value that inverting could flip, so there is nothing to
// protect against.
const isYesNoAnswer = (text) => {
  const t = String(text ?? "").trim()
  return YES_LONG.test(t) || NO_LONG.test(t)
}

// True when copying `match.answer` onto a field asking `label` risks stating
// the opposite of the truth: the stored answer is yes/no shaped, and exactly
// one side of the label/bank-question pair reads as negated.
const polarityMismatch = (label, match) =>
  !!match &&
  isYesNoAnswer(match.answer) &&
  isNegated(label) !== isNegated(match.question)

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
    [
      /\b(company|employer|organi[sz]ation)( name)?\b/i,
      "experience.current",
      currentJob.company ?? "",
    ],
    [
      /\b(job )?title\b|\bposition\b/i,
      "experience.current",
      currentJob.title ?? "",
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

  // "Have you previously been employed at Affirm?" Only the negative is
  // answered here: the profile can prove someone is ABSENT from a complete
  // employment history, but not in what capacity they were employed if they
  // are present.
  const priorEmployment = (label) => {
    const m = String(label).match(
      /previously\s+(?:been\s+)?(?:employed|worked)\s+(?:at|by|for)\s+([A-Za-z0-9&.'\- ]{2,40})/i,
    )
    if (!m) return ""
    const co = m[1]
      .replace(/\s+(for|in|at|during)\b.*$/i, "")
      .replace(/[?*.,].*$/, "")
      .trim()
      .toLowerCase()
    if (!co) return ""
    const worked = employers.some((e) => e.includes(co) || co.includes(e))
    return worked ? "" : "No"
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
      /previously\s+(been\s+)?(employed|worked)\s+(at|by|for)\b/i,
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

  function bestAnswer(label) {
    const want = conceptOf(label)
    if (want) {
      const onConcept = bank.filter((a) => conceptOf(a.question) === want)
      if (onConcept.length) {
        let best = null
        for (const a of onConcept) {
          const score = Math.max(similarity(label, a.question), 0.75)
          if (!best || score > best.score) best = { ...a, score }
        }
        return best
      }
    }

    let best = null
    for (const a of bank) {
      // Never let a question about one concept be answered from another.
      if (want && conceptOf(a.question) && conceptOf(a.question) !== want)
        continue
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

    // Radio/checkbox groups have no element of their own; resolve the answer
    // to the stamped key of the option to click so filling stays mechanical.
    const result = { k: f.k }
    const push = (status, source, value, note) => {
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
      const m = matchOption(out, opts, { requireOptions, label })
      return push(
        m.needsChoice ? "NEEDS-CHOICE" : "OK",
        idSource,
        m.value,
        noteFor(m),
      )
    }

    // Ahead of EEO too: if the user actually answered a self-ID question,
    // their answer is the answer — auto-declining over it would discard it.
    const exact = exactBank.get(normalizeQuestion(label))
    if (exact) {
      const m = matchOption(exact.answer, opts, { requireOptions, label })
      return push(
        m.needsChoice ? "NEEDS-CHOICE" : "OK",
        `${exact.id}@exact${(exact.source ?? "user") === "model" ? ":model" : ""}`,
        m.value,
        noteFor(m),
      )
    }

    if (EEO_RE.test(label)) {
      const decline = (opts ?? []).find((o) => DECLINE_RE.test(o))
      if (decline) return push("OK", "eeo:decline", decline)
      return push("UNKNOWN", "eeo", "", "voluntary self-ID — ask the user")
    }

    let hit = null
    // QUESTION_RULES run for both shapes and take precedence; PROFILE_RULES
    // are field-label rules and must not fire on a question.
    const rules = IS_QUESTION.test(label)
      ? [...QUESTION_RULES, ...ctx.CONTACT_RULES]
      : [...QUESTION_RULES, ...ctx.CONTACT_RULES, ...PROFILE_RULES]
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
        hit =
          out &&
          typeof out === "object" &&
          !Array.isArray(out) &&
          "value" in out
            ? { source: out.source ?? source, value: out.value }
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
          `not in profile.${hit.source ?? "contact"}`,
        )
      }
      const m = matchOption(hit.value, opts, { requireOptions, label })
      return push(
        m.needsChoice ? "NEEDS-CHOICE" : "OK",
        hit.source,
        m.value,
        noteFor(m),
      )
    }

    const best = bestAnswer(label)
    const mismatch = polarityMismatch(label, best)
    if (best && best.score >= 0.7 && !mismatch) {
      const m = matchOption(best.answer, opts, { requireOptions, label })
      return push(
        m.needsChoice ? "NEEDS-CHOICE" : "OK",
        `${best.id}@${best.score.toFixed(2)}`,
        m.value,
        noteFor(m),
      )
    }
    if (mismatch && best.score >= 0.45) {
      // Prefer deferring over auto-inverting (see the polarity guard above):
      // one extra question to the user beats a silently flipped
      // work-authorization answer. Leave value blank rather than surface the
      // untrustworthy literal.
      return push(
        "NEEDS-CHOICE",
        `${best.id}@${best.score.toFixed(2)}`,
        "",
        `bank question may be opposite polarity — confirm by hand: "${best.question}" -> ${best.answer}` +
          (opts && opts.length ? `; options: ${opts.join(" | ")}` : ""),
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
export function resolveFieldsFromFiles(
  fields,
  {
    profileFile = "profile/profile.yaml",
    answersFile = "profile/answers.yaml",
  } = {},
) {
  const profile = fs.existsSync(profileFile)
    ? (loadYamlFile(profileFile) ?? {})
    : {}
  const answersDoc = fs.existsSync(answersFile)
    ? (loadYamlFile(answersFile) ?? {})
    : {}
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
