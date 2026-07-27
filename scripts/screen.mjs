#!/usr/bin/env node
// Mechanical first-pass screen for ghost-job / scam / vagueness signals —
// deterministic, offline, no LLM. It does NOT replace the judgment pass in
// the pipeline-jobs skill; it removes the parts that are just pattern
// matching, so the model only looks at what actually needs a human-like read.
//
// Verdicts: reject (a hard signal), caution (worth a closer look), pass.
//
// Usage: node scripts/screen.mjs [--status new] [--json]
//        [--leads <path>] [--jobs-dir <path>] [--limits <path>]
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { isTerse } from "./lib.mjs"
import { loadLimits } from "./find-jobs.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

// Phrases that reliably indicate a scam or an ad that isn't a real job.
const SCAM_PATTERNS = [
  [
    /\b(pay|fee|payment|deposit)\s+(to\s+)?(apply|start|begin|register)/i,
    "pay_to_apply",
  ],
  [
    /\b(ssn|social security|bank account|routing number|credit card)\b/i,
    "asks_for_financial_id",
  ],
  [
    /\b(telegram|whatsapp|signal)\b.{0,30}\b(interview|contact|apply)/i,
    "offsite_chat_interview",
  ],
  [
    /\b(no experience (needed|required)).{0,40}\$\s*\d/i,
    "no_experience_high_pay",
  ],
  [
    /\b(immediate start|urgent hiring|hiring urgently|start today)\b/i,
    "urgency_pressure",
  ],
  [
    /\b(unlimited|guaranteed)\s+(earning|income|commission)\b/i,
    "guaranteed_income",
  ],
]

// Culture phrases that cluster in high-burnout postings. One is noise; the
// signal is the cluster, so this only ever produces "caution".
const CULTURE_PATTERNS = [
  [/\bwear (many|multiple) hats\b/i, "wear_many_hats"],
  [/\b(like a )?family\b/i, "family_culture"],
  [/\bwork hard,? play hard\b/i, "work_hard_play_hard"],
  [/\b(24\/7|around the clock|always on)\b/i, "always_on"],
  [/\brock ?star|ninja|guru\b/i, "rockstar_language"],
  [/\bfast[- ]paced\b/i, "fast_paced"],
]

// Pure core (exported for tests).
export function screenJob(job, limits = {}, now = new Date()) {
  const signals = []
  let verdict = "pass"
  const text = [job.title, job.description, ...(job.requirements ?? [])]
    .filter(Boolean)
    .join("\n")

  for (const [re, name] of SCAM_PATTERNS) {
    if (re.test(text)) {
      signals.push(name)
      verdict = "reject"
    }
  }

  const ghostAge = limits.ghost_signals?.repost_age_days ?? 45
  if (job.posted_at) {
    const d = new Date(job.posted_at)
    if (!Number.isNaN(d.getTime())) {
      const days = Math.floor((now.getTime() - d.getTime()) / 86400000)
      if (days >= ghostAge) {
        signals.push(`stale_${days}d`)
        if (verdict === "pass") verdict = "caution"
      }
    }
  }

  const culture = CULTURE_PATTERNS.filter(([re]) => re.test(text)).map(
    ([, n]) => n,
  )
  if (culture.length >= 3) {
    signals.push(...culture)
    if (verdict === "pass") verdict = "caution"
  }

  for (const f of job.flags ?? []) {
    if (
      f === "no_salary" ||
      f === "unknown_location" ||
      f === "remote_unverified"
    ) {
      signals.push(f)
      if (verdict === "pass") verdict = "caution"
    }
  }

  // A description this thin can't be evaluated and is a mild ghost signal.
  if (job.description && job.description.length < 200) {
    signals.push("thin_description")
    if (verdict === "pass") verdict = "caution"
  }
  if (!job.company || /^unknown$/i.test(job.company)) {
    signals.push("unidentified_company")
    if (verdict === "pass") verdict = "caution"
  }

  return {
    id: job.id,
    company: job.company,
    title: job.title,
    verdict,
    signals,
  }
}

function flag(args, name) {
  const i = args.indexOf(name)
  return i !== -1 ? (args[i + 1] ?? true) : null
}

function main() {
  const args = process.argv.slice(2)
  const leadsPath =
    flag(args, "--leads") || path.join(ROOT, "jobs", "leads.json")
  const jobsDir = flag(args, "--jobs-dir") || path.join(ROOT, "jobs")
  const limitsPath =
    flag(args, "--limits") || path.join(ROOT, "docs", "application-limits.yaml")
  const status = flag(args, "--status") || "new"

  if (!fs.existsSync(leadsPath)) {
    console.error(`no lead store at ${leadsPath} — run a search first`)
    process.exit(2)
  }
  const limits = fs.existsSync(limitsPath) ? loadLimits(limitsPath) : {}

  // Fold in captured posting text where a workspace exists.
  const byUrl = new Map()
  if (fs.existsSync(jobsDir)) {
    for (const slug of fs.readdirSync(jobsDir)) {
      const f = path.join(jobsDir, slug, "job.json")
      if (!fs.existsSync(f)) continue
      try {
        const j = JSON.parse(fs.readFileSync(f, "utf8"))
        if (j.source_url) byUrl.set(j.source_url, j)
      } catch {}
    }
  }

  const leads = (
    JSON.parse(fs.readFileSync(leadsPath, "utf8")).leads ?? []
  ).filter((l) => status === "all" || l.status === status)
  const results = leads.map((l) => {
    const captured = byUrl.get(l.url)
    return screenJob(
      {
        ...l,
        description: captured?.description,
        requirements: captured?.requirements,
      },
      limits,
    )
  })

  if (args.includes("--json")) {
    console.log(JSON.stringify(results, null, 2))
    return
  }
  const counts = results.reduce(
    (a, r) => ((a[r.verdict] = (a[r.verdict] ?? 0) + 1), a),
    {},
  )
  if (isTerse()) {
    // Only non-passing rows need attention; passes are just a count.
    for (const r of results.filter((r) => r.verdict !== "pass")) {
      console.log(`${r.verdict}|${r.id}|${r.company}|${r.signals.join(",")}`)
    }
    console.log(
      `pass=${counts.pass ?? 0} caution=${counts.caution ?? 0} reject=${counts.reject ?? 0}`,
    )
    return
  }
  for (const r of results) {
    console.log(
      `[${r.verdict}] ${r.company} — ${r.title}${r.signals.length ? `\n  signals: ${r.signals.join(", ")}` : ""}`,
    )
  }
  console.log(
    `\n${counts.pass ?? 0} pass, ${counts.caution ?? 0} caution, ${counts.reject ?? 0} reject.`,
  )
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) main()
