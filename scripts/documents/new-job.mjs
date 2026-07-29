#!/usr/bin/env node
// Scaffold a per-job workspace: jobs/<slug>/{job.json, context.json}
//
// Usage: node scripts/documents/new-job.mjs <slug> --company "Acme" --title "Full-Stack Developer" [--url <url>] [--root jobs]
//        node scripts/documents/new-job.mjs <slug> --from-lead <url|lead-id> [--leads <path>]
//
// --from-lead fills company/title/location/url/description straight out of the
// lead store instead of having a model re-read the live posting for fields the
// sweep already captured. Explicit --company/--title still win.
//
// Exit codes: 0 ok, 1 workspace exists, 2 usage, 4 --from-lead matched no lead
// (the caller falls back to reading the page).
import fs from "node:fs"
import path from "node:path"

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
let company = flag("--company", null)
let title = flag("--title", null)
let url = flag("--url", null)
const root = flag("--root", "jobs")
const fromLead = flag("--from-lead", null)
const leadsFile = flag("--leads", null)
const slug = args[0]

// Two URLs point at the same posting when they differ only by a trailing slash,
// a query string, or a fragment — ATS links get share/tracking params bolted on
// constantly, and a lead stored without them should still match.
function normalizeUrl(u) {
  const s = String(u ?? "").trim()
  if (!s) return ""
  return s
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .toLowerCase()
}

function findLead(leads, needle) {
  const want = String(needle ?? "").trim()
  if (!want) return null
  const byId = leads.find((l) => l.id === want)
  if (byId) return byId
  const byUrl = leads.find((l) => l.url === want)
  if (byUrl) return byUrl
  const norm = normalizeUrl(want)
  if (!norm) return null
  return leads.find((l) => normalizeUrl(l.url) === norm) ?? null
}

let location = null
let description = null

if (fromLead) {
  // Imported lazily: opening the lead store pulls in node:sqlite, and the
  // plain scaffold path has no business paying for that.
  const { readLeadStore } = await import("../lib/db.mjs")
  const lead = findLead(readLeadStore(leadsFile).leads ?? [], fromLead)
  if (!lead) {
    console.error(
      `no stored lead matches "${fromLead}" — read the posting page instead`,
    )
    process.exit(4)
  }
  company ??= lead.company
  title ??= lead.title
  url ??= lead.url
  location = lead.location ?? null
  // Blank and whitespace-only descriptions are the SuccessFactors case: the
  // fetcher returns no body at all. Treat those as absent so the caller knows
  // it still has to read the page; a short-but-real description is fine.
  description = String(lead.description ?? "").trim() || null
}

if (
  !slug ||
  !/^[a-z0-9][a-z0-9-]*$/.test(slug) ||
  !company?.trim() ||
  !title?.trim()
) {
  console.error(
    'Usage: new-job.mjs <kebab-slug> --company "X" --title "Y" [--url Z]\n' +
      "   or: new-job.mjs <kebab-slug> --from-lead <url|lead-id>",
  )
  process.exit(2)
}

const dir = path.join(root, slug)
if (fs.existsSync(dir)) {
  console.error(`Workspace already exists: ${dir}`)
  process.exit(1)
}
fs.mkdirSync(dir, { recursive: true })

const job = {
  slug,
  company: company.trim(),
  title: title.trim(),
  source_url: url,
  location,
  captured_at: new Date().toISOString().slice(0, 10),
  description,
  // Requirements are still an extraction job, not a stored field — left empty
  // for whoever fills the workspace in.
  requirements: [],
  questions: [],
}

const context = {
  slug,
  analysis: {
    key_requirements: [],
    matched_fact_ids: [],
    gaps: [],
    keywords: [],
    tone: null,
  },
  consistency: { emphasized_skills: [], lead_experience: null, notes: null },
  resume: { status: "pending", facts_used: [], dropped: [] },
  cover_letter: { status: "pending", facts_used: [], key_points: [] },
  pending_questions: [],
}

fs.writeFileSync(
  path.join(dir, "job.json"),
  JSON.stringify(job, null, 2) + "\n",
  "utf8",
)
fs.writeFileSync(
  path.join(dir, "context.json"),
  JSON.stringify(context, null, 2) + "\n",
  "utf8",
)
console.log(`Created ${dir}/job.json and context.json`)
if (fromLead) {
  // The caller branches on this: `missing` is the only case that still needs a
  // page read, so say it explicitly rather than making them open job.json.
  console.log(
    `from-lead=${fromLead} company=${job.company} title=${job.title} ` +
      `location=${location ?? "-"} description=${description ? description.length : "missing"}`,
  )
}
