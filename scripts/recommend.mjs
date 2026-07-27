#!/usr/bin/env node
// Rank stored leads against the profile — deterministically, no LLM. This is
// the job the model used to do by reading every lead; now it only interprets
// a short ranked list (or nothing at all, if the user just runs it).
//
// Score = tech overlap with the profile + role-title fit + freshness
//         + salary signal - risk flags.
//
// Usage: node scripts/recommend.mjs [--top N] [--status new|recommended|all]
//        [--json] [--leads <path>] [--profile <path>] [--jobs-dir <path>]
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { loadYamlFile, isTerse } from "./lib.mjs"
import { extractTech, profileText } from "./profile-gaps.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

// Role fit from the title alone. The user targets full-stack first, back-end
// second (docs/application-limits.yaml); generic titles score lowest.
export function titleScore(title) {
  const t = String(title ?? "").toLowerCase()
  if (/full[- ]?stack/.test(t)) return 6
  if (/back[- ]?end|backend/.test(t)) return 4
  if (/software engineer|web developer|developer/.test(t)) return 2
  return 0
}

export function freshnessScore(postedAt, now = new Date()) {
  if (!postedAt) return 0
  const d = new Date(postedAt)
  if (Number.isNaN(d.getTime())) return 0
  const days = (now.getTime() - d.getTime()) / 86400000
  if (days <= 3) return 4
  if (days <= 7) return 3
  if (days <= 14) return 2
  if (days <= 21) return 1
  return 0
}

const FLAG_PENALTY = {
  remote_unverified: 3,
  unknown_location: 2,
  no_salary: 1,
  unknown_age: 1,
}

// Pure core (exported for tests).
export function scoreLead(lead, profileTech, now = new Date()) {
  const text = [lead.title, lead.job_text].filter(Boolean).join("\n")
  const leadTech = extractTech(text)
  const overlap = [...leadTech].filter((t) => profileTech.has(t))
  const missing = [...leadTech].filter((t) => !profileTech.has(t))

  let score = 0
  score += overlap.length * 2
  score += titleScore(lead.title)
  score += freshnessScore(lead.posted_at, now)
  if (lead.salary_max) score += 2
  for (const f of lead.flags ?? []) score -= FLAG_PENALTY[f] ?? 0

  return {
    id: lead.id,
    company: lead.company,
    title: lead.title,
    location: lead.location,
    url: lead.url,
    posted_at: lead.posted_at,
    score,
    matched_tech: overlap.sort(),
    missing_tech: missing.sort(),
    flags: lead.flags ?? [],
  }
}

export function rankLeads(
  leads,
  profileBlob,
  { top = 10, now = new Date() } = {},
) {
  const profileTech = extractTech(profileBlob)
  return leads
    .map((l) => scoreLead(l, profileTech, now))
    .sort((a, b) => b.score - a.score || a.company.localeCompare(b.company))
    .slice(0, top)
}

function flag(args, name) {
  const i = args.indexOf(name)
  return i !== -1 ? (args[i + 1] ?? true) : null
}

// Attach the captured posting text when a job workspace exists — richer than
// the title alone.
function withJobText(leads, jobsDir) {
  if (!fs.existsSync(jobsDir)) return leads
  const texts = new Map()
  for (const slug of fs.readdirSync(jobsDir)) {
    const f = path.join(jobsDir, slug, "job.json")
    if (!fs.existsSync(f)) continue
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf8"))
      if (j.source_url) {
        texts.set(
          j.source_url,
          [j.description, ...(j.requirements ?? [])].join("\n"),
        )
      }
    } catch {}
  }
  return leads.map((l) => ({ ...l, job_text: texts.get(l.url) }))
}

function main() {
  const args = process.argv.slice(2)
  const leadsPath =
    flag(args, "--leads") || path.join(ROOT, "jobs", "leads.json")
  const profilePath =
    flag(args, "--profile") || path.join(ROOT, "profile", "profile.yaml")
  const jobsDir = flag(args, "--jobs-dir") || path.join(ROOT, "jobs")
  const top = Number(flag(args, "--top") || 10)
  const status = flag(args, "--status") || "new"

  if (!fs.existsSync(profilePath)) {
    console.error(`profile not found at ${profilePath}`)
    process.exit(2)
  }
  if (!fs.existsSync(leadsPath)) {
    console.error(`no lead store at ${leadsPath} — run a search first`)
    process.exit(2)
  }
  const all = JSON.parse(fs.readFileSync(leadsPath, "utf8")).leads ?? []
  const leads = withJobText(
    all.filter((l) => status === "all" || l.status === status),
    jobsDir,
  )
  if (!leads.length) {
    console.error(`no leads with status "${status}"`)
    process.exit(2)
  }

  const ranked = rankLeads(leads, profileText(loadYamlFile(profilePath)), {
    top,
  })

  if (args.includes("--json")) {
    console.log(JSON.stringify(ranked, null, 2))
    return
  }
  if (isTerse()) {
    for (const r of ranked) {
      console.log(
        `${r.score}|${r.id}|${r.company}|${r.title}|match:${r.matched_tech.join(",") || "-"}|gap:${r.missing_tech.join(",") || "-"}|${r.url}`,
      )
    }
    console.log(`ranked=${ranked.length} of=${leads.length}`)
    return
  }
  for (const r of ranked) {
    console.log(
      `[${r.score}] ${r.company} — ${r.title}\n  ${r.location || "location?"} | matches: ${r.matched_tech.join(", ") || "none"}\n  ${r.url}`,
    )
  }
  console.log(
    `\nTop ${ranked.length} of ${leads.length} lead(s) with status "${status}".`,
  )
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) main()
