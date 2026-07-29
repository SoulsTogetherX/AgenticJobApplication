#!/usr/bin/env node
// Whole-pipeline digest in ONE call — deterministic, no LLM. Replaces the
// several separate commands (and the model round-trips between them) that
// answering "where do things stand?" used to take.
//
// Usage: node scripts/status.mjs [--json] [--days N]
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { loadYamlFile, isTerse } from "./lib.mjs"
import { dueFollowUps } from "./follow-ups.mjs"
import { readLeadStore, readApplications } from "./db.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const tally = (items, key) =>
  items.reduce((a, i) => {
    const k = i[key] ?? "applied"
    a[k] = (a[k] ?? 0) + 1
    return a
  }, {})

// Pure core (exported for tests).
export function buildStatus(
  leads,
  applications,
  { now = new Date(), days = 10 } = {},
) {
  const due = dueFollowUps(applications, now, days)
  const openStatuses = new Set(["applied", "followed_up"])
  return {
    leads: { total: leads.length, by_status: tally(leads, "status") },
    applications: {
      total: applications.length,
      by_status: tally(applications, "status"),
      awaiting_response: applications.filter((a) =>
        openStatuses.has(a.status ?? "applied"),
      ).length,
    },
    follow_ups_due: due.length,
    due_list: due.map((d) => ({
      slug: d.slug,
      company: d.company,
      days: d.days_since_last_touch,
    })),
  }
}

function flag(args, name) {
  const i = args.indexOf(name)
  return i !== -1 ? (args[i + 1] ?? true) : null
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return fallback
  }
}

function main() {
  const args = process.argv.slice(2)
  const days = Number(flag(args, "--days") || 10)
  const leads = readLeadStore().leads ?? []
  const applications = readApplications()

  const s = buildStatus(leads, applications, { days })

  if (args.includes("--json")) {
    console.log(JSON.stringify(s, null, 2))
    return
  }
  const kv = (o) =>
    Object.entries(o)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ") || "none"
  if (isTerse()) {
    console.log(`leads total=${s.leads.total} ${kv(s.leads.by_status)}`)
    console.log(
      `applications total=${s.applications.total} ${kv(s.applications.by_status)} awaiting=${s.applications.awaiting_response}`,
    )
    console.log(
      `followups due=${s.follow_ups_due}${s.due_list.length ? " " + s.due_list.map((d) => `${d.slug}(${d.days}d)`).join(" ") : ""}`,
    )
    return
  }
  console.log(`Leads: ${s.leads.total} (${kv(s.leads.by_status)})`)
  console.log(
    `Applications: ${s.applications.total} (${kv(s.applications.by_status)}); ${s.applications.awaiting_response} awaiting a response`,
  )
  console.log(`Follow-ups due: ${s.follow_ups_due}`)
  for (const d of s.due_list)
    console.log(`  ${d.company} (${d.slug}) — ${d.days} days`)
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) main()
