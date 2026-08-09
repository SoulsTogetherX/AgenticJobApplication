// Shared helpers for the job-application pipeline. Pure/deterministic — no LLM.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import yaml from "js-yaml"

// Output mode. A human at a terminal gets readable prose; an agent (whose
// stdout is a pipe, never a TTY) gets compact records — same information,
// far fewer tokens. --verbose / --quiet override the detection.
export function outputMode(argv = process.argv) {
  if (argv.includes("--verbose")) return "human"
  if (argv.includes("--quiet")) return "terse"
  return process.stdout.isTTY ? "human" : "terse"
}

export const isTerse = (argv = process.argv) => outputMode(argv) === "terse"

export function loadYamlFile(file) {
  return yaml.load(fs.readFileSync(file, "utf8"))
}

// Bounded-concurrency map, preserving input order. Board sweeps are entirely
// network-bound, so running them one at a time was leaving the wall clock on
// the table; the cap keeps us from hammering any ATS.
export async function mapPool(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        out[i] = await fn(items[i], i)
      }
    },
  )
  await Promise.all(workers)
  return out
}

export function dumpYaml(obj) {
  return yaml.dump(obj, { lineWidth: 100 })
}

// ---------------------------------------------------------------------------
// HTTP + HTML primitives. These live here rather than in find-jobs.mjs because
// two modules now fetch postings: the sweep (list endpoints) and enrich.mjs
// (per-posting detail endpoints). find-jobs.mjs re-exports textSnippet and
// SNIPPET_MAX so its existing importers keep working.
// ---------------------------------------------------------------------------

export const UA = "agentic-job-application/0.1 (personal job search tool)"

// Every fetch is bounded. Neither of these carried a signal, so a board that
// accepted the connection and never answered held one of mapPool's eight
// workers until the OS gave up on the TCP connection — minutes, for one dead
// board, on the wall clock the user benchmarks against Jobright. Measured
// before this: a loopback server that accepts and never replies was STILL
// HANGING after 8s with no sign of stopping.
//
// 15s is far past a healthy ATS list endpoint and far short of the OS timeout.
// Per-call override via the options bag, because a probe wants to give up
// sooner than a paged sweep.
export const FETCH_TIMEOUT_MS = 15000

// A timeout is reported as the SAME shape as an HTTP failure — a thrown Error
// carrying the URL — because that is what every caller already handles.
// find-jobs.mjs catches per board and stores `e.message` as that board's
// failure; enrich.mjs catches per lead and flags it `no_description`. So a slow
// board costs one board, never the sweep. Raw, the abort surfaces as a
// DOMException named TimeoutError whose message ("The operation was aborted due
// to timeout") names neither the URL nor the budget, which is the difference
// between a warn line a human can act on and one they cannot.
//
// AbortSignal.timeout covers the body read as well as the headers, so a server
// that sends "200 OK" and then stalls mid-JSON is bounded too — verified, not
// assumed.
async function withTimeout(url, timeoutMs, fn) {
  try {
    return await fn(AbortSignal.timeout(timeoutMs))
  } catch (e) {
    // The abort can arrive raw or wrapped in a TypeError by fetch, so check the
    // cause as well as the error itself.
    const timedOut = [e?.name, e?.cause?.name].some(
      (n) => n === "TimeoutError" || n === "AbortError",
    )
    if (timedOut) throw new Error(`timeout after ${timeoutMs}ms for ${url}`)
    throw e
  }
}

export async function fetchJson(
  url,
  body = null,
  { timeoutMs = FETCH_TIMEOUT_MS } = {},
) {
  return withTimeout(url, timeoutMs, async (signal) => {
    const res = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: {
        "user-agent": UA,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    return res.json()
  })
}

export async function fetchText(url, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  return withTimeout(url, timeoutMs, async (signal) => {
    const res = await fetch(url, {
      headers: {
        "user-agent": UA,
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    return res.text()
  })
}

// Out-of-range numeric entities are left as written rather than crashing the
// sweep: a malformed ad is a bad snippet, not a lost lead.
const codePoint = (n, original) => {
  if (!Number.isInteger(n) || n < 1 || n > 0x10ffff) return original
  try {
    return String.fromCodePoint(n)
  } catch {
    return original
  }
}

export const decodeEntities = (s) =>
  String(s)
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#0?39;|&rsquo;|&apos;/gi, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/gi, '"')
    .replace(/&amp;/gi, "&")
    // Numeric entities, decimal and hex. SmartRecruiters emits &#xa0; for the
    // non-breaking spaces inside its ad sections, which survived the named-
    // entity list above and left literal "&#xa0;" wedged between words — enough
    // to stop a keyword or blocker pattern matching across it.
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, h) => codePoint(parseInt(h, 16), m))
    .replace(/&#(\d{1,7});/g, (m, d) => codePoint(Number(d), m))

// Boards return postings as HTML (Greenhouse double-encodes it). The screen
// only needs enough text to spot blockers — a clearance demand or a seniority
// bar — so store a stripped, capped snippet rather than the whole ad; the lead
// store holds dozens of these.
export const SNIPPET_MAX = 4000

export function textSnippet(...parts) {
  const raw = parts.filter(Boolean).join("\n")
  if (!raw) return null
  const txt = decodeEntities(
    decodeEntities(raw)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      // Block boundaries become newlines BEFORE tags are stripped.
      //
      // This used to collapse every run of whitespace, newlines included, so a
      // Greenhouse body arrived as one 4,000-character line. That threw away
      // the only structure the posting had: "<h3>Minimum Qualifications</h3>"
      // and the bullet list under it became indistinguishable from running
      // prose. The L2 fit stage reads that structure to tell a REQUIRED skill
      // from a "nice to have" one, and it found a requirements heading in 0 of
      // 92 stored leads until this changed.
      //
      // Only block-level tags produce a break; inline markup (<b>, <a>, <span>)
      // still collapses to a space so a bolded word does not split a sentence.
      .replace(
        /<\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|blockquote|pre)\b[^>]*>/gi,
        "\n",
      )
      .replace(/<[^>]+>/g, " "),
  )
    // Horizontal whitespace collapses; newlines survive but never stack up.
    .replace(/[^\S\n]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim()
  return txt ? txt.slice(0, SNIPPET_MAX) : null
}

// ---------------------------------------------------------------------------
// Fact index: id -> { id, text } from profile.yaml (+ answers.yaml)
// ---------------------------------------------------------------------------
export function buildFactIndex(profile, answers) {
  const index = new Map()
  const add = (id, text) => {
    if (!id) return
    if (index.has(id)) throw new Error(`Duplicate fact id: ${id}`)
    // Reading a field the profile schema does not define used to land here as
    // the literal string "undefined" — a fact that silently verifies against
    // nothing, so every real claim citing it fails R3. That was live for
    // `organizations` (it read org.name; the field is org.text). Throwing
    // turns a whole class of schema drift into a loud failure at load time.
    if (text === undefined || text === null) {
      throw new Error(`Fact ${id} has no text — check the profile field name`)
    }
    index.set(id, { id, text: String(text) })
  }

  for (const s of profile.summary ?? []) add(s.id, s.text)

  for (const exp of profile.experience ?? []) {
    add(exp.id, `${exp.title} ${exp.company} ${exp.dates}`)
    for (const b of exp.bullets ?? []) add(b.id, b.text)
  }
  for (const prj of profile.projects ?? []) {
    add(
      prj.id,
      `${prj.name} ${prj.tech ?? ""} ${prj.year ?? ""} ${prj.role ?? ""}`,
    )
    for (const b of prj.bullets ?? []) add(b.id, b.text)
  }
  for (const sk of profile.skills ?? [])
    add(sk.id, `${sk.group}: ${(sk.items ?? []).join(", ")}`)
  for (const edu of profile.education ?? []) {
    add(
      edu.id,
      `${edu.school} ${edu.degrees} ${edu.graduated ?? ""} GPA ${edu.gpa ?? ""} ${edu.honors ?? ""} ` +
        `${(edu.coursework ?? []).join(", ")}`,
    )
  }
  for (const org of profile.organizations ?? []) add(org.id, org.text)
  for (const ex of profile.extras ?? []) add(ex.id, ex.text)

  for (const a of answers?.answers ?? []) add(a.id, `${a.question} ${a.answer}`)

  return index
}

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------
export function extractNumbers(text) {
  // "4,000" -> "4000"; "45+" -> "45"; "3.75" stays; "100,000-spin" -> "100000"
  const out = new Set()
  for (const m of String(text).matchAll(/\d+(?:,\d{3})*(?:\.\d+)?/g)) {
    out.add(m[0].replaceAll(",", ""))
  }
  return out
}

export function extractMonthYears(text) {
  const out = new Set()
  const re =
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{4})\b/g
  for (const m of String(text).matchAll(re)) out.add(`${m[1]} ${m[2]}`)
  return out
}

// ---------------------------------------------------------------------------
// Professional tenure (used by the seniority gate in screen.mjs)
// ---------------------------------------------------------------------------
const MONTH_INDEX = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
}

// Training roles, not professional tenure — a posting asking for "5 years"
// does not mean five years of tutoring.
const NON_PROFESSIONAL_TITLE =
  /\b(intern|internship|teacher assistant|teaching assistant|tutor|volunteer)\b/i

// "Jan 2024 – Present" / "Jul 2024 - Mar 2025" -> {start, end}. Returns null
// when no month-year can be read, so callers can skip the entry rather than
// guess at a duration.
export function parseDateRange(dates, now = new Date()) {
  const s = String(dates ?? "")
  const re =
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{4})\b/gi
  const points = [...s.matchAll(re)].map(
    (m) => new Date(Date.UTC(Number(m[2]), MONTH_INDEX[m[1].toLowerCase()], 1)),
  )
  if (!points.length) return null
  const start = points[0]
  const end = /\b(present|current|now|ongoing)\b/i.test(s)
    ? now
    : (points[1] ?? points[0])
  return end < start ? null : { start, end }
}

function monthsBetween(a, b) {
  return Math.max(
    0,
    (b.getUTCFullYear() - a.getUTCFullYear()) * 12 +
      (b.getUTCMonth() - a.getUTCMonth()),
  )
}

// Total professional years from profile.experience, unioning overlapping
// ranges so concurrent roles are not double-counted.
export function yearsOfExperience(profile, now = new Date()) {
  const ranges = []
  for (const ex of profile?.experience ?? []) {
    if (NON_PROFESSIONAL_TITLE.test(String(ex.title ?? ""))) continue
    const r = parseDateRange(ex.dates, now)
    if (r) ranges.push(r)
  }
  if (!ranges.length) return 0

  ranges.sort((a, b) => a.start - b.start)
  let months = 0
  let cur = { ...ranges[0] }
  for (const r of ranges.slice(1)) {
    if (r.start <= cur.end) {
      if (r.end > cur.end) cur.end = r.end
    } else {
      months += monthsBetween(cur.start, cur.end)
      cur = { ...r }
    }
  }
  months += monthsBetween(cur.start, cur.end)
  return Math.round((months / 12) * 10) / 10
}

// Dictionary of tech terms the verifier watches for. Includes both terms the
// user knows AND common terms they do NOT — so invented experience is caught.
//
// The list itself moved to scripts/lib/keywords.mjs (2026-07-29), which is now
// the single source for every "what technology is named here?" question. It was
// duplicated: this list drove verify-claims R6 while a SEPARATE regex lexicon in
// profile-gaps.mjs drove lead_keywords, and the two had already drifted — this
// one knew Cognito and EventBridge, that one knew Svelte and Kafka. Re-exported
// rather than moved outright so every existing importer keeps working.
export { TECH_TERMS } from "./keywords.mjs"
import { TECH_TERMS, CASE_SENSITIVE_SURFACE } from "./keywords.mjs"

// The text that may be treated as EVIDENCE of the user's experience.
//
// This exists because the obvious version — concatenate profile.yaml and
// answers.yaml and search that — is wrong, and was wrong in the truthfulness
// verifier itself. answers.yaml stores the QUESTION as well as the answer, and
// application forms ask questions that enumerate technologies:
//
//   question: "Which of these do you have experience with? [1 = REST APIs;
//              ... 4 = Spring / Spring Boot; 5 = Cloud (AWS, Azure, or GCP)]"
//   answer:   "1, 2, 3, 5"
//
// Treating that whole record as evidence made "Azure" and "Spring" pass
// verify-claims R6 — so a tailored resume could have claimed Spring Boot
// experience the user explicitly did NOT select, and Azure when what they have
// is AWS. That is precisely the invention rule 1 forbids.
//
// So: an answer's text is always evidence, because the user wrote it. The
// question's text is evidence only when the answer is an unambiguous yes —
// "Do you have experience with React?" / "Yes" really does evidence React,
// while "1, 2, 3, 5" evidences nothing but itself.
// EXPORTED so the answer-bank rescan can answer "which stored entries currently
// promote their QUESTION into the R6 corpus?" using the same predicate the
// corpus builder uses. A second copy of this regex living in the auditor would
// drift from this one, and the audit would then report on a corpus that is not
// the corpus. One definition, two readers.
export const AFFIRMATIVE = /^\s*(yes|y|true|yes\.|yes,? i (do|have|am))\s*$/i

// THE SIBLING CASE, and the one the fix above left open.
//
// The rule "a question counts when the answer is an unambiguous yes" reads the
// ANSWER and never the shape of the QUESTION — and the employer writes the
// question. So a compound label whitelists everything it happens to mention:
//
//   question: "Are you legally authorized to work in the United States?
//              (Our stack is Kubernetes, Terraform, Kotlin, Rust and Scala.)"
//   answer:   "Yes"
//
// One "Yes" about work authorisation made Kubernetes, Terraform, Kotlin, Rust
// and Scala all pass R6 — verified ok:true against a real document. The user
// only ever said yes to being allowed to work here.
//
// Two narrowings, both deliberately conservative, because R6 is the control
// that stops a posting putting a false claim on a document signed with the
// user's name:
//
//   1. Parentheticals and bracketed asides are stripped before the question
//      counts. They are context the employer added, not the thing being asked.
//   2. What remains evidences a skill only when it names exactly ONE. "Do you
//      have experience with React?" / "Yes" is unambiguous. "Experience with
//      React, Vue and Angular?" / "Yes" is not — all three? any one? — and an
//      ambiguous yes must never become evidence. The user can always record
//      each skill outright with save-answer.mjs, which is unambiguous by
//      construction.
// Both narrowings are UNCONDITIONAL, deliberately. An earlier draft injected
// the term-counter so lib.mjs would not have to reach for the lexicon — but
// techTermsIn lives in this same file, so there was never a cycle to avoid, and
// an optional guard is a guard a future caller forgets. Safe by default.
//
//   3. THE HOLE THE FIRST TWO LEFT. Both narrowings above are about how MUCH a
//      label mentions; neither is about WHAT WAS ASKED. Drop the brackets and
//      name exactly one technology, and a single "Yes" still whitelists it:
//
//        question: "Authorized to work in the US? This role uses Kubernetes."
//        answer:   "Yes"
//
//      One tech term, no parentheses, both earlier guards satisfied, and
//      Kubernetes is evidence for every document from then on. The employer
//      writes the label and can put any sentence they like after the question
//      mark.
//
//      So a bare "Yes" now evidences only the CLAUSE THAT WAS ASKED: the text
//      up to the first question mark, or up to the first sentence break when
//      there is no question mark at all. Anything the employer appended after
//      it is not something the user said yes to.
//
//      The sentence break is "period, space, capital" rather than just a
//      period, because "Do you have experience with Node.js?" must not lose
//      its own subject to the dot in the middle of a tech term.
const ASIDE = /[([{][^)\]}]*[)\]}]/g
const SENTENCE_BREAK = /(?<=\.)\s+(?=[A-Z])/

export function questionEvidence(question) {
  const stripped = String(question ?? "").replace(ASIDE, " ")
  const mark = stripped.indexOf("?")
  const asked =
    mark === -1
      ? stripped.split(SENTENCE_BREAK)[0].trim()
      : stripped.slice(0, mark + 1).trim()
  return techTermsIn(asked).length > 1 ? "" : asked
}

export function evidenceText(profileRaw, answersDoc) {
  const parts = [String(profileRaw ?? "")]
  for (const a of answersDoc?.answers ?? []) {
    const answer = a?.answer == null ? "" : String(a.answer)
    parts.push(answer)
    if (AFFIRMATIVE.test(answer)) parts.push(questionEvidence(a?.question))
  }
  return parts.join("\n")
}

// Case-insensitive by default, exact for the terms keywords.mjs lists as
// ordinary English words. This used to have no "i" flag at all, which left the
// truthfulness gate a case-shaped hole — see CASE_SENSITIVE_SURFACE for what
// the flag costs when applied to "Go", "REST" or "Spring", and why the answer is
// an enumerated exception list rather than either extreme.
function termRegex(term, flags = "") {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  // Boundaries that tolerate ".", "+", "#" inside terms (C++, Node.js, C#).
  return new RegExp(
    `(?<![A-Za-z0-9+#.])${escaped}(?![A-Za-z0-9+#])`,
    CASE_SENSITIVE_SURFACE.has(term) ? flags : `${flags}i`,
  )
}

// Which TECH_TERMS appear in `text`? Longest-first so "React Native" wins and
// its "React" substring is not separately reported.
export function techTermsIn(text) {
  const found = []
  let remaining = String(text)
  for (const term of [...TECH_TERMS].sort((a, b) => b.length - a.length)) {
    if (termRegex(term).test(remaining)) {
      found.push(term)
      // Blank what matched, using the SAME regex rather than a literal
      // replaceAll: a term matched case-insensitively is not removed by a
      // literal replace, so "react native" would report "React Native" and then
      // "React" as well. The longest-first suppression has to survive casing.
      remaining = remaining.replace(termRegex(term, "g"), " ")
    }
  }
  return found
}

// ---------------------------------------------------------------------------
// Set similarity — "are these two postings the same job in different clothes?"
// ---------------------------------------------------------------------------

// Seniority and employment-type words never distinguish one posting from
// another in this pipeline (the limits file already fixed the seniority band),
// so they are dropped before comparing: "Senior Full-Stack Engineer II" and
// "Full Stack Developer" should read as the same title.
const TITLE_STOP = new Set(
  "a an the of and or for to in at with senior sr junior jr staff lead principal i ii iii remote contract fulltime full time parttime part".split(
    " ",
  ),
)

export function titleTokens(s) {
  return new Set(
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9+#\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t && !TITLE_STOP.has(t)),
  )
}

// Intersection over union. Empty on either side scores 0 rather than 1: two
// postings we know nothing about are not evidence of a match.
export function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

// ---------------------------------------------------------------------------
// Lightweight validators (mirror schemas/*.schema.json)
// ---------------------------------------------------------------------------
const STATUSES = ["pending", "drafted", "verified", "approved", "rendered"]

export function validateJob(job) {
  const errors = []
  if (!job || typeof job !== "object") return ["job.json is not an object"]
  for (const key of ["slug", "company", "title"]) {
    if (typeof job[key] !== "string" || !job[key].trim())
      errors.push(`job.${key} missing or empty`)
  }
  return errors
}

export function validateContext(ctx) {
  const errors = []
  if (!ctx || typeof ctx !== "object") return ["context.json is not an object"]
  if (typeof ctx.slug !== "string" || !ctx.slug.trim())
    errors.push("context.slug missing or empty")
  if (!ctx.analysis || typeof ctx.analysis !== "object") {
    errors.push("context.analysis missing")
  } else {
    if (!Array.isArray(ctx.analysis.key_requirements))
      errors.push("analysis.key_requirements must be an array")
    if (!Array.isArray(ctx.analysis.matched_fact_ids))
      errors.push("analysis.matched_fact_ids must be an array")
  }
  for (const section of ["resume", "cover_letter"]) {
    const s = ctx[section]
    if (!s || typeof s !== "object") errors.push(`context.${section} missing`)
    else if (!STATUSES.includes(s.status))
      errors.push(`${section}.status must be one of ${STATUSES.join("|")}`)
  }
  return errors
}

export function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
}
