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
// Fact index: id -> { id, text } from profile.yaml (+ answers.yaml)
// ---------------------------------------------------------------------------
export function buildFactIndex(profile, answers) {
  const index = new Map()
  const add = (id, text) => {
    if (!id) return
    if (index.has(id)) throw new Error(`Duplicate fact id: ${id}`)
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
  for (const org of profile.organizations ?? []) add(org.id, org.name)
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
export const TECH_TERMS = [
  // in profile
  "Python",
  "TypeScript",
  "JavaScript",
  "C++",
  "GDScript",
  "SQL",
  "HTML",
  "CSS",
  "React Native",
  "React",
  "Node.js",
  "Next.js",
  "AWS",
  "PostgreSQL",
  "Docker",
  "Vite",
  "GitHub Actions",
  "Git",
  "Godot",
  "GameMaker",
  "n8n",
  "nginx",
  "WebSockets",
  "Cognito",
  "EC2",
  "EventBridge",
  "Claude",
  "ChatGPT",
  "Codex",
  "MCP",
  "Monte Carlo",
  "JSON",
  "Agile",
  "Scrum",
  // common terms NOT in profile — presence in a document must be justified
  "Kubernetes",
  "Terraform",
  "Ansible",
  "Java",
  "C#",
  "Ruby",
  "Rust",
  "Golang",
  "PHP",
  "Swift",
  "Kotlin",
  "Scala",
  "Angular",
  "Vue",
  "Svelte",
  "Django",
  "Flask",
  "FastAPI",
  "Spring",
  "Rails",
  "Laravel",
  "GraphQL",
  "MongoDB",
  "Redis",
  "MySQL",
  "SQLite",
  "DynamoDB",
  "Kafka",
  "RabbitMQ",
  "Elasticsearch",
  "Azure",
  "GCP",
  "Firebase",
  "Heroku",
  "Vercel",
  "Netlify",
  "Jenkins",
  "CircleCI",
  "Webpack",
  "Babel",
  "Jest",
  "Mocha",
  "Cypress",
  "Playwright",
  "Selenium",
  "Puppeteer",
  "TensorFlow",
  "PyTorch",
  "Keras",
  "Pandas",
  "NumPy",
  "Spark",
  "Hadoop",
  "Tailwind",
  "Bootstrap",
  "jQuery",
  "Express",
  "NestJS",
  "Deno",
  "Bun",
  "Remix",
  "Astro",
  "Flutter",
  "Unity",
  "Unreal",
]

function termRegex(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  // Boundaries that tolerate ".", "+", "#" inside terms (C++, Node.js, C#).
  return new RegExp(`(?<![A-Za-z0-9+#.])${escaped}(?![A-Za-z0-9+#])`)
}

// Which TECH_TERMS appear in `text`? Longest-first so "React Native" wins and
// its "React" substring is not separately reported.
export function techTermsIn(text) {
  const found = []
  let remaining = String(text)
  for (const term of [...TECH_TERMS].sort((a, b) => b.length - a.length)) {
    if (termRegex(term).test(remaining)) {
      found.push(term)
      remaining = remaining.replaceAll(term, " ")
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
