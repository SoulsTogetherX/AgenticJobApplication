#!/usr/bin/env node
// Batch-resolve scanned application-form fields against the fact base.
// Deterministic lookup only: contact facts from profile.yaml, previously saved
// answers from answers.yaml. It NEVER invents an answer — anything it cannot
// resolve comes back UNKNOWN so the agent asks the user once, in one batch.
//
// Usage:
//   node scripts/scan.json | node scripts/apply/answer-bank.mjs            # fields on stdin
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
import { loadYamlFile, isTerse, parseDateRange } from "../lib/lib.mjs"

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

// ---------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------
function readStdin() {
  try {
    return fs.readFileSync(0, "utf8")
  } catch {
    return ""
  }
}
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
  console.error('Input must be a fields array or a scan object with "fields".')
  process.exit(2)
}

const profile = fs.existsSync(profileFile)
  ? (loadYamlFile(profileFile) ?? {})
  : {}
const answersDoc = fs.existsSync(answersFile)
  ? (loadYamlFile(answersFile) ?? {})
  : {}
const contact = profile.contact ?? {}
const bank = Array.isArray(answersDoc.answers) ? answersDoc.answers : []

// ---------------------------------------------------------------------------
// contact facts (label regex -> value derived from profile.contact only)
// ---------------------------------------------------------------------------
const nameParts = String(contact.name ?? "")
  .trim()
  .split(/\s+/)
  .filter(Boolean)
const locParts = String(contact.location ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

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

// Whether this same form already has its own field for something, so a
// catch-all "Other links" box does not duplicate what is captured elsewhere
// (user decision 2026-07-28).
const hasFieldFor = (re) => fields.some((f) => re.test(String(f.l ?? "")))
const otherLinksValue = () => {
  const parts = []
  if (contact.github && !hasFieldFor(/git-?hub/i)) parts.push(contact.github)
  if (
    contact.website &&
    !hasFieldFor(/\b(portfolio|personal (web)?site|website)\b/i)
  ) {
    parts.push(contact.website)
  }
  return parts.join("  ")
}

const CONTACT_RULES = [
  [/\b(first|given)\s*name\b/i, "contact.name", nameParts[0]],
  [
    /\b(last|family|sur)\s*name\b|\bsurname\b/i,
    "contact.name",
    nameParts.length > 1 ? nameParts[nameParts.length - 1] : "",
  ],
  [/\bmiddle\s*(name|initial)\b/i, null, ""],
  // "Name Pronunciation" asks how to say it, not what it is — an anchored
  // /^name\b/ answered that with the name itself on a real Affirm form.
  [/\bname pronunciation\b|\bpronounce\b/i, null, ""],
  [
    /^name\s*\*?\s*:?\s*$|\b(full|legal|preferred|display) name\b|\byour name\b/i,
    "contact.name",
    contact.name ?? "",
  ],
  [/e-?mail/i, "contact.email", contact.email ?? ""],
  [/\b(phone|mobile|cell|telephone)\b/i, "contact.phone", contact.phone ?? ""],
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
  // A street address is NOT the city-level `contact.location`. Greenhouse asks
  // for "Address Line 1" / "Address Line 2" alongside separate City/State/Postal
  // fields, and letting the generic location rule below match them put
  // "North Las Vegas, NV" in the street slot and then repeated it on line 2.
  // The street address is not a profile fact — it lives in the answer bank, so
  // these resolve from there by exact question match and nowhere else. An empty
  // result is UNKNOWN, which is correct: line 2 is optional and stays blank.
  [
    /\baddress\s*line\s*2\b|\b(apt|apartment|suite|unit)\b/i,
    "bank.address2",
    () => bankedAddress(/address\s*line\s*2|\b(apt|apartment|suite|unit)\b/i),
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

// Called only from the address rules above, after `bank` is populated.
const bankedAddress = (re) =>
  bank.find((a) => re.test(String(a.question ?? "")))?.answer ?? ""

// Labels phrased as questions are NOT profile fields, however many field-ish
// words they contain. Without this, "were you referred to this position by a
// senior leader?" was answered with the job title, and "authorized to work in
// the country where this position is located?" with the home city.
const IS_QUESTION =
  /\?\s*\*?\s*$|^\s*(are|do|did|does|have|has|were|was|will|would|can|could|is|to your knowledge|please confirm)\b/i

// ---------------------------------------------------------------------------
// employment + education facts
//
// Every application form asks for the current employer and the degree, and both
// are already in profile.yaml. Without these rules they came back UNKNOWN and
// the model had to answer six obvious questions per application — which is the
// opposite of the point. Values are read straight from the fact base; nothing
// here derives a claim the profile does not already make.
// ---------------------------------------------------------------------------
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
    !isCurrent && currentRange ? String(currentRange.end.getUTCFullYear()) : "",
  ],
  [
    /\bschool\b|\buniversity\b|\bcollege\b|\binstitution\b/i,
    "education",
    education.school ?? "",
  ],
  [/\bdegree\b/i, "education", degreeLevel],
  [/\bdiscipline\b|\bmajor\b|\bfield of study\b/i, "education", discipline],
]

// ---------------------------------------------------------------------------
// question-shaped rules
//
// PROFILE_RULES are skipped for anything phrased as a question (so "were you
// referred to this position" is not answered with a job title). These run for
// questions instead, and they cover the ones that appear on nearly every US
// application — which is why they pay off on every future form, not just this
// one. A rule's value may be a function of the label.
// ---------------------------------------------------------------------------
const employers = (profile.experience ?? [])
  .map((e) =>
    String(e.company ?? "")
      .toLowerCase()
      .trim(),
  )
  .filter(Boolean)

// "Have you previously been employed at Affirm?" Only the negative is answered
// here: the profile can prove someone is ABSENT from a complete employment
// history, but not in what capacity they were employed if they are present.
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
const heardAbout = () => {
  const banked = bank.find((a) =>
    /how did you (hear|first learn|find out|come to know)/i.test(a.question),
  )
  const chain = []
  if (banked?.answer) chain.push(banked.answer)
  chain.push("Other", "LinkedIn")
  return chain
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
const CONCEPTS = [
  ["sponsorship", /\bsponsor(ship|ed|s)?\b|\bvisa\b/i],
  [
    "work_authorization",
    /\b(legally\s+)?authoriz(ed|ation)\s+to\s+work\b|\bwork\s+authoriz(ation|ed)\b|\bright to work\b|\beligible to work\b/i,
  ],
]
const conceptOf = (text) =>
  CONCEPTS.find(([, re]) => re.test(String(text ?? "")))?.[0] ?? null

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

// ---------------------------------------------------------------------------
// exact-question lookup
// ---------------------------------------------------------------------------
// An answer saved for THIS exact question outranks every rule below.
//
// The rules fire first by design — they map a form's wording onto profile
// facts. But a rule that resolves a value the form does not actually offer
// returns NEEDS-CHOICE, and it will return NEEDS-CHOICE on that same field for
// every future application, because a rule hit short-circuits the bank and the
// pick the user approved last time is never consulted. Checking exact matches
// ahead of the rules is what makes an approved pick stick.
//
// Exact normalized text only. No fuzzy tier here: the 0.45 MAYBE band exists
// precisely because near-matches are unreliable, and this path skips the
// concept guard that keeps "require sponsorship" away from "authorized to
// work". Identical text cannot confuse those.
function normalizeQuestion(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[*:]+$/, "")
    .trim()
}

const exactBank = new Map()
for (const a of bank) {
  const key = normalizeQuestion(a.question)
  // First entry wins, so a later duplicate cannot shadow the original.
  if (key && !exactBank.has(key)) exactBank.set(key, a)
}

// ---------------------------------------------------------------------------
// option matching
// ---------------------------------------------------------------------------
const YES = /^(y|yes|true|1)$/i
const NO = /^(n|no|false|0)$/i

// Forms rarely offer a bare "Yes"/"No". Affirm's prior-employment question
// offers "I have not previously been employed at Affirm"; without these a
// resolved "No" came back NEEDS-CHOICE and went to the user for nothing.
const YES_LONG = /^(yes\b|y\b|true\b|i (do|have|am|was|would)\b(?!\s+not))/i
const NO_LONG =
  /^(no\b|n\b|false\b|i (do|have|am|was|would) not\b|i haven'?t\b|i'?m not\b|never\b|none\b|not applicable)/i

// Accepts a single value or an ordered list of acceptable answers; the first
// one the form actually offers wins.
function matchOption(value, opts) {
  const candidates = (Array.isArray(value) ? value : [value])
    .map((v) => String(v ?? "").trim())
    .filter(Boolean)
  const first = candidates[0] ?? ""
  if (!Array.isArray(opts) || !opts.length) return { value: first }
  const real = opts.filter((o) => o && !/^(select|choose|--|\s*)$/i.test(o))

  for (const v of candidates) {
    const exact = real.find((o) => o.trim().toLowerCase() === v.toLowerCase())
    if (exact) return { value: exact }
    const starts = real.find(
      (o) =>
        o.trim().toLowerCase().startsWith(v.toLowerCase()) ||
        v.toLowerCase().startsWith(o.trim().toLowerCase()),
    )
    if (starts) return { value: starts }
    if (YES.test(v) || NO.test(v)) {
      const want = YES.test(v) ? YES_LONG : NO_LONG
      const hit = real.find((o) => want.test(o.trim()))
      if (hit) return { value: hit }
    }
  }
  return { value: first, needsChoice: true }
}

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------
const SKIP_TYPES = new Set(["file", "richtext"])
const results = []

for (const f of fields) {
  const label = String(f.l ?? "").trim()
  const opts =
    f.opts ?? (Array.isArray(f.o) ? f.o.map((o) => o.l).filter(Boolean) : null)
  // Radio/checkbox groups have no element of their own; resolve the answer to
  // the stamped key of the option to click so filling stays mechanical.
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
    // pick/sel are first-class so a planner never has to regex them back out
    // of the human-readable note; the note keeps them for terse/human output.
    results.push({
      k: f.k,
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
  }

  if (SKIP_TYPES.has(f.t)) {
    push("SKIP", f.t, "", "attach the rendered PDF / paste the letter")
    continue
  }
  if (!label) {
    push("UNKNOWN", "-", "", "no label found — inspect the page")
    continue
  }

  // Ahead of EEO too: if the user actually answered a self-ID question, their
  // answer is the answer — auto-declining over it would discard it.
  const exact = exactBank.get(normalizeQuestion(label))
  if (exact) {
    const m = matchOption(exact.answer, opts)
    push(
      m.needsChoice ? "NEEDS-CHOICE" : "OK",
      `${exact.id}@exact${(exact.source ?? "user") === "model" ? ":model" : ""}`,
      m.value,
      m.needsChoice ? `options: ${opts.join(" | ")}` : undefined,
    )
    continue
  }

  if (EEO_RE.test(label)) {
    const decline = (opts ?? []).find((o) => DECLINE_RE.test(o))
    if (decline) push("OK", "eeo:decline", decline)
    else push("UNKNOWN", "eeo", "", "voluntary self-ID — ask the user")
    continue
  }

  let hit = null
  // QUESTION_RULES run for both shapes and take precedence; PROFILE_RULES are
  // field-label rules and must not fire on a question.
  const rules = IS_QUESTION.test(label)
    ? [...QUESTION_RULES, ...CONTACT_RULES]
    : [...QUESTION_RULES, ...CONTACT_RULES, ...PROFILE_RULES]
  for (const [re, source, value] of rules) {
    if (re.test(label)) {
      hit = {
        source,
        value: typeof value === "function" ? value(label) : value,
      }
      break
    }
  }
  if (hit) {
    // A rule may return a list of acceptable answers; an empty list is still
    // "no answer", and an empty array is truthy.
    const empty = Array.isArray(hit.value)
      ? !hit.value.filter(Boolean).length
      : !hit.value
    if (!hit.source || empty) {
      push(
        "UNKNOWN",
        hit.source ?? "-",
        "",
        `not in profile.${hit.source ?? "contact"}`,
      )
    } else {
      const m = matchOption(hit.value, opts)
      push(
        m.needsChoice ? "NEEDS-CHOICE" : "OK",
        hit.source,
        m.value,
        m.needsChoice ? `options: ${opts.join(" | ")}` : undefined,
      )
    }
    continue
  }

  const best = bestAnswer(label)
  if (best && best.score >= 0.7) {
    const m = matchOption(best.answer, opts)
    push(
      m.needsChoice ? "NEEDS-CHOICE" : "OK",
      `${best.id}@${best.score.toFixed(2)}`,
      m.value,
      m.needsChoice ? `options: ${opts.join(" | ")}` : undefined,
    )
  } else if (best && best.score >= 0.45) {
    push(
      "MAYBE",
      `${best.id}@${best.score.toFixed(2)}`,
      best.answer,
      `bank asks: ${best.question}`,
    )
  } else {
    push("UNKNOWN", "-", "", opts ? `options: ${opts.join(" | ")}` : undefined)
  }
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------
const counts = results.reduce((acc, r) => {
  acc[r.status] = (acc[r.status] ?? 0) + 1
  return acc
}, {})

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
