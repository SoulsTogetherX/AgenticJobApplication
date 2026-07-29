#!/usr/bin/env node
// Mechanical first-pass screen for ghost-job / scam / vagueness signals —
// deterministic, offline, no LLM. It does NOT replace the judgment pass in
// the pipeline-jobs skill; it removes the parts that are just pattern
// matching, so the model only looks at what actually needs a human-like read.
//
// Verdicts: reject (a hard signal), caution (worth a closer look), pass.
//
// Usage: node scripts/screen.mjs [--status new] [--json]
//        [--leads <path>] [--jobs-dir <path>] [--limits <path>] [--profile <path>]
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { isTerse, loadYamlFile, yearsOfExperience } from "./lib.mjs"
import { loadLimits } from "./find-jobs.mjs"
import { readLeadStore, resolveLeadSource } from "./db.mjs"

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

// Requirements that applying cannot satisfy. A clearance is sponsored by an
// employer you already work for — you cannot obtain one to get the job — so
// these are hard rejects rather than judgment calls.
const BLOCKER_PATTERNS = [
  [/\b(TS\/SCI|top secret)\b/i, "clearance_required"],
  [
    /\bactive\s+(security\s+|government\s+|dod\s+)?clearance\b/i,
    "clearance_required",
  ],
  [/\bmust (have|possess|hold)\b.{0,30}\bclearance\b/i, "clearance_required"],
  [
    /\b(secret|public trust)\s+clearance\s+(is\s+)?required\b/i,
    "clearance_required",
  ],
  [/\b(ci|full scope|lifestyle)\s+polygraph\b/i, "polygraph_required"],
]

// How far above the candidate's own tenure a posting may reach before it stops
// being a stretch and starts being a waste. Overridable per-user in
// docs/application-limits.yaml (experience.stretch_years).
//
// Was 3, which put the ceiling at 5.5 years for a 2.5-year profile — so the
// single most common bar in practice, "5+ years", did not even raise a signal.
// Of 47 postings read on 2026-07-28 the sweep produced ZERO rejects for
// seniority while every one of them was in fact out of reach. 2 puts the
// ceiling at 4.5 and catches the 5+ band, which is where Senior actually sits.
const DEFAULT_STRETCH_YEARS = 2

// Highest years-of-experience demand in the posting. Deliberately narrow:
// requires an experience-ish word nearby, and skips "18 years of age", so a
// legal-minimum question is never read as a seniority bar.
export function extractYearsRequired(text) {
  let max = 0
  // The number may be fractional, and the lookbehind is load-bearing: with a
  // plain \b, "1.5+ years" matched the "5" (a decimal point is a word
  // boundary) and read an entry-level 1.5-year bar as a 5-year one — which
  // rejected precisely the junior postings this profile is looking for.
  const re =
    /(?<![\d.])(\d{1,2}(?:\.\d+)?)\s*\)?\s*\+?\s*years?\b([^.\n]{0,60})/gi
  for (const m of String(text).matchAll(re)) {
    const n = Number(m[1])
    const tail = m[2] ?? ""
    if (/\bof age\b|\bold\b/i.test(tail)) continue
    if (!/experien|background|track record/i.test(tail)) continue
    if (n > 0 && n <= 30 && n > max) max = n
  }
  return max
}

// Pure core (exported for tests). profileYears is the candidate's own tenure
// (see yearsOfExperience in lib.mjs); null disables the seniority gate.
export function screenJob(
  job,
  limits = {},
  now = new Date(),
  profileYears = null,
) {
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

  for (const [re, name] of BLOCKER_PATTERNS) {
    if (re.test(text)) {
      if (!signals.includes(name)) signals.push(name)
      verdict = "reject"
    }
  }

  // Seniority bar. This is the safety net for postings the title filter cannot
  // catch — Chainguard's "Software Engineer (Libraries Platform)" carried no
  // seniority word at all yet asked for 5+ years. A posting that states a bar
  // this far above the candidate's tenure is not a stretch, it is a waste, so
  // it rejects rather than cautions: cautions were being read and re-rejected
  // by hand, which is exactly the cost this is meant to remove.
  const demanded = extractYearsRequired(text)
  if (demanded && profileYears != null) {
    const ceiling =
      limits.experience?.max_years_required ??
      profileYears + (limits.experience?.stretch_years ?? DEFAULT_STRETCH_YEARS)
    if (demanded > ceiling) {
      signals.push(`over_bar_${demanded}y`)
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
  // Skipped when the text is a known-truncated aggregator teaser, which is
  // short because of the source, not because the posting is empty.
  if (
    !job.partial_description &&
    job.description &&
    job.description.length < 200
  ) {
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
  // Defaults to jobs/leads.db when it exists, else the legacy JSON store.
  const leadsPath = flag(args, "--leads") || resolveLeadSource().file
  const jobsDir = flag(args, "--jobs-dir") || path.join(ROOT, "jobs")
  const limitsPath =
    flag(args, "--limits") || path.join(ROOT, "docs", "application-limits.yaml")
  const status = flag(args, "--status") || "new"
  const profilePath =
    flag(args, "--profile") || path.join(ROOT, "profile", "profile.yaml")

  if (!fs.existsSync(leadsPath)) {
    console.error(`no lead store at ${leadsPath} — run a search first`)
    process.exit(2)
  }
  const limits = fs.existsSync(limitsPath) ? loadLimits(limitsPath) : {}

  // The seniority gate needs the candidate's own tenure; without a profile it
  // stays off rather than guessing a bar.
  const profile = fs.existsSync(profilePath)
    ? (loadYamlFile(profilePath) ?? {})
    : {}
  const profileYears = profile.experience ? yearsOfExperience(profile) : null

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

  const leads = (readLeadStore(leadsPath).leads ?? []).filter(
    (l) => status === "all" || l.status === status,
  )
  const results = leads.map((l) => {
    const captured = byUrl.get(l.url)
    // Prefer a full captured posting; fall back to the snippet the sweep
    // stored, so blockers are caught before a workspace ever exists.
    return screenJob(
      {
        ...l,
        description: captured?.description ?? l.description,
        requirements: captured?.requirements,
        partial_description: !captured?.description,
      },
      limits,
      new Date(),
      profileYears,
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
