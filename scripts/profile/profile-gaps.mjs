#!/usr/bin/env node
// Profile-gap analysis (deterministic, no LLM calls): what do the jobs you're
// pursuing keep asking for that your profile doesn't evidence?
//
// Demand side: every captured job workspace (jobs/*/job.json description +
// requirements) and, weakly, stored lead titles (jobs/leads.json).
// Supply side: all text in profile/profile.yaml (bullets, tech, skills).
// Jobs whose application ended in rejection or silence count double — those
// are the requirements that are actually costing interviews.
//
// Usage: node scripts/profile/profile-gaps.mjs [--json] [--min-demand N]
//        [--profile <path>] [--jobs-dir <path>] [--leads <path>] [--applications <path>]
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { loadYamlFile, isTerse } from "../lib/lib.mjs"
import {
  readLeadStore,
  resolveLeadSource,
  readApplications,
  openDb,
  keywordMap,
} from "../lib/db.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

// The tech lexicon and extractTech moved to scripts/lib/keywords.mjs
// (2026-07-29), which is now the single source for every "what technology is
// named here?" question. There used to be TWO lists: this regex lexicon drove
// lead_keywords and this report, while a separate flat string list in lib.mjs
// drove verify-claims R6 — and they had already drifted apart in both
// directions. Re-exported rather than moved outright so existing importers
// (recommend.mjs, find-jobs.mjs) keep working unchanged.
export { TECH_LEXICON, extractTech } from "../lib/keywords.mjs"
import { TECH_LEXICON, extractTech } from "../lib/keywords.mjs"

// Flatten every string in the profile into one searchable blob.
export function profileText(profile) {
  const parts = []
  const walk = (v) => {
    if (typeof v === "string") parts.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === "object") Object.values(v).forEach(walk)
  }
  walk(profile)
  return parts.join("\n")
}

// Pure core: jobs = [{slug, weight, text?, terms?}] → ranked demand vs evidence.
//
// A job may supply `terms` (an iterable of canonical skill names) INSTEAD of
// `text`. That is how a stored lead contributes: its keywords were extracted
// once at ingest into lead_keywords, so re-parsing its description here is work
// the store has already done. It is also the only way a lead contributes
// anything real — gatherJobs used to hand over `text: lead.title`, so 92 stored
// descriptions were invisible to this report.
export function computeGaps(
  jobs,
  profileBlob,
  { minDemand = 2, lexicon = TECH_LEXICON } = {},
) {
  const evidenced = extractTech(profileBlob, lexicon)
  const demand = new Map() // term → { weight, jobs: [slug] }
  for (const job of jobs) {
    const terms = job.terms
      ? new Set(job.terms)
      : extractTech(job.text, lexicon)
    for (const t of terms) {
      const d = demand.get(t) ?? { weight: 0, jobs: [] }
      d.weight += job.weight ?? 1
      d.jobs.push(job.slug)
      demand.set(t, d)
    }
  }
  const rows = [...demand.entries()]
    .map(([tech, d]) => ({
      tech,
      demand: d.weight,
      jobs: d.jobs,
      evidenced: evidenced.has(tech),
    }))
    .filter((r) => r.demand >= minDemand)
    .sort((a, b) => b.demand - a.demand)
  return {
    gaps: rows.filter((r) => !r.evidenced),
    covered: rows.filter((r) => r.evidenced),
    profile_tech: [...evidenced].sort(),
  }
}

// Weight: jobs that got a rejection or silence after ≥1 follow-up teach the
// most — they demonstrably didn't convert.
export function jobWeight(application) {
  if (!application) return 1
  if (application.status === "rejected") return 2
  if (
    (application.status === "followed_up" ||
      application.status === "applied") &&
    (application.follow_ups?.length ?? 0) >= 1
  )
    return 2
  return 1
}

function flag(args, name) {
  const i = args.indexOf(name)
  return i !== -1 ? (args[i + 1] ?? true) : null
}

function gatherJobs(jobsDir, leadsPath, applications) {
  const bySlug = new Map(applications.map((a) => [a.slug, a]))
  const jobs = []
  if (fs.existsSync(jobsDir)) {
    for (const slug of fs.readdirSync(jobsDir)) {
      const jobFile = path.join(jobsDir, slug, "job.json")
      if (!fs.existsSync(jobFile)) continue
      try {
        const j = JSON.parse(fs.readFileSync(jobFile, "utf8"))
        jobs.push({
          slug,
          text: [j.title, j.description, ...(j.requirements ?? [])].join("\n"),
          weight: jobWeight(bySlug.get(slug)),
        })
      } catch {
        console.error(`warn: unreadable ${jobFile}, skipped`)
      }
    }
  }
  if (fs.existsSync(leadsPath)) {
    try {
      const { leads } = readLeadStore(leadsPath)
      // Keywords indexed at ingest, when available. This is the difference
      // between reading a lead's whole description and reading its title:
      // before this, every lead contributed `text: l.title` and the 92 stored
      // descriptions counted for nothing.
      let indexed = new Map()
      if (String(leadsPath).endsWith(".db")) {
        try {
          const db = openDb(leadsPath)
          try {
            indexed = keywordMap(db)
          } finally {
            db.close()
          }
        } catch (e) {
          console.error(`warn: keyword index unavailable (${e.message})`)
        }
      }
      for (const l of leads ?? []) {
        if (l.status === "dismissed") continue
        const terms = indexed.get(l.id)
        // Still weighted below a captured job workspace: a lead is a posting
        // nobody has committed effort to yet, so it should not outvote the
        // jobs that actually went out and came back rejected.
        jobs.push(
          terms?.size
            ? { slug: l.id, terms, weight: 0.5 }
            : { slug: l.id, text: l.title ?? "", weight: 0.5 },
        )
      }
    } catch {
      console.error(`warn: unreadable ${leadsPath}, skipped`)
    }
  }
  return jobs
}

function main() {
  const args = process.argv.slice(2)
  const profilePath =
    flag(args, "--profile") || path.join(ROOT, "profile", "profile.yaml")
  const jobsDir = flag(args, "--jobs-dir") || path.join(ROOT, "jobs")
  // Defaults to jobs/leads.db when it exists, else the legacy JSON store.
  const leadsPath = flag(args, "--leads") || resolveLeadSource().file
  const applicationsPath =
    flag(args, "--applications") ||
    path.join(ROOT, "profile", "applications.yaml")
  const minDemand = Number(flag(args, "--min-demand") || 2)

  if (!fs.existsSync(profilePath)) {
    console.error(`profile not found at ${profilePath}`)
    process.exit(2)
  }
  const profile = loadYamlFile(profilePath)
  const applications = readApplications(
    applicationsPath.endsWith("applications.yaml") ? null : applicationsPath,
  )
  const jobs = gatherJobs(jobsDir, leadsPath, applications)
  if (!jobs.length) {
    console.error(
      "no captured jobs or leads to analyze — run a search or capture some postings first",
    )
    process.exit(2)
  }

  const result = computeGaps(jobs, profileText(profile), { minDemand })
  if (args.includes("--json")) {
    console.log(
      JSON.stringify({ analyzed_jobs: jobs.length, ...result }, null, 2),
    )
    return
  }
  if (isTerse()) {
    const fmt = (rows) => rows.map((r) => `${r.tech}(${r.demand})`).join(" ")
    console.log(`analyzed=${jobs.length}`)
    console.log(`gaps: ${fmt(result.gaps) || "none"}`)
    console.log(`covered: ${fmt(result.covered) || "none"}`)
    return
  }
  console.log(`Analyzed ${jobs.length} job(s)/lead(s).\n`)
  console.log("GAPS (demanded, not evidenced in profile):")
  for (const g of result.gaps) console.log(`  ${g.tech}  (demand ${g.demand})`)
  if (!result.gaps.length) console.log("  none at this threshold")
  console.log("\nCOVERED (demanded and evidenced):")
  for (const c of result.covered)
    console.log(`  ${c.tech}  (demand ${c.demand})`)
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) main()
