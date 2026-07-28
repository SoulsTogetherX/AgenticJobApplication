#!/usr/bin/env node
// Batch-resolve scanned application-form fields against the fact base.
// Deterministic lookup only: contact facts from profile.yaml, previously saved
// answers from answers.yaml. It NEVER invents an answer — anything it cannot
// resolve comes back UNKNOWN so the agent asks the user once, in one batch.
//
// Usage:
//   node scripts/scan.json | node scripts/answer-bank.mjs            # fields on stdin
//   node scripts/answer-bank.mjs --fields '<json array>'
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
import { loadYamlFile, isTerse, parseDateRange } from "./lib.mjs"

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
  [/\b(state|province|region)\b/i, "contact.location", locParts[1] ?? ""],
  [
    /\b(current )?(location|address)\b|\bwhere are you (currently )?(located|based)\b/i,
    "contact.location",
    contact.location ?? "",
  ],
]

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

const EEO_RE =
  /\bgender\b|\brace\b|ethnic|hispanic|latino|veteran|disab|self-?identif|pronoun/i
const DECLINE_RE =
  /decline|prefer not|don'?t wish|do not wish|not to (answer|say|disclose)|choose not/i

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

function bestAnswer(label) {
  let best = null
  for (const a of bank) {
    const score = similarity(label, a.question)
    if (!best || score > best.score) best = { ...a, score }
  }
  return best
}

// ---------------------------------------------------------------------------
// option matching
// ---------------------------------------------------------------------------
const YES = /^(y|yes|true|1)$/i
const NO = /^(n|no|false|0)$/i
function matchOption(value, opts) {
  if (!Array.isArray(opts) || !opts.length) return { value }
  const real = opts.filter((o) => o && !/^(select|choose|--|\s*)$/i.test(o))
  const v = String(value).trim()
  const exact = real.find((o) => o.trim().toLowerCase() === v.toLowerCase())
  if (exact) return { value: exact }
  const starts = real.find(
    (o) =>
      o.trim().toLowerCase().startsWith(v.toLowerCase()) ||
      v.toLowerCase().startsWith(o.trim().toLowerCase()),
  )
  if (starts) return { value: starts }
  if (YES.test(v) || NO.test(v)) {
    const want = YES.test(v) ? YES : NO
    const hit = real.find((o) => want.test(o.trim()))
    if (hit) return { value: hit }
  }
  return { value, needsChoice: true }
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

  if (EEO_RE.test(label)) {
    const decline = (opts ?? []).find((o) => DECLINE_RE.test(o))
    if (decline) push("OK", "eeo:decline", decline)
    else push("UNKNOWN", "eeo", "", "voluntary self-ID — ask the user")
    continue
  }

  let hit = null
  const rules = IS_QUESTION.test(label)
    ? CONTACT_RULES
    : [...CONTACT_RULES, ...PROFILE_RULES]
  for (const [re, source, value] of rules) {
    if (re.test(label)) {
      hit = { source, value }
      break
    }
  }
  if (hit) {
    if (!hit.source || !hit.value) {
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
