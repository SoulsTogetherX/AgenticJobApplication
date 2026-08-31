#!/usr/bin/env node
// Whole-pipeline digest in ONE call — deterministic, no LLM. Replaces the
// several separate commands (and the model round-trips between them) that
// answering "where do things stand?" used to take.
//
// Usage: node src/status.mjs [--json] [--days N] [--cadence-hours H]
//        node src/status.mjs --db <path> --stop-path <path>   # fixtures
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { loadYamlFile, isTerse } from "./lib/lib.mjs"
import { dueFollowUps } from "./applications/follow-ups.mjs"
import { readLeadStore, readApplications, openDb, DB_PATH } from "./lib/db.mjs"
import {
  buildAutoStatus,
  formatAutoTerse,
  formatAutoProse,
  DEFAULT_CADENCE_MS,
} from "./auto/digest.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

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

// The auto section, read from the store rather than re-derived. Isolated so a
// digest of the ATTENDED pipeline still prints when the auto tables are absent
// or unreadable: "where do things stand?" must not fail because a feature the
// user has not switched on has no rows.
function autoSection(args, dbFile) {
  const cadenceHours = Number(flag(args, "--cadence-hours") || 0)
  const stopPath = flag(args, "--stop-path")
  let db = null
  try {
    db = openDb(dbFile)
    return buildAutoStatus(db, {
      cadenceMs: cadenceHours ? cadenceHours * 3_600_000 : DEFAULT_CADENCE_MS,
      ...(typeof stopPath === "string" ? { stopPath } : {}),
    })
  } catch (e) {
    return { unavailable: String(e?.message ?? e) }
  } finally {
    try {
      db?.close()
    } catch {
      /* nothing to do at this point but not hold the handle */
    }
  }
}

function main() {
  const args = process.argv.slice(2)
  const days = Number(flag(args, "--days") || 10)
  // --db / --stop-path point every read at a fixture instead of the real store.
  // They exist so the falsifiable check can run the CLI ITSELF rather than a
  // function that resembles it — a digest tested only through its exported core
  // proves nothing about the command a user actually types.
  const dbArg = flag(args, "--db")
  const dbFile = typeof dbArg === "string" ? dbArg : DB_PATH
  const leads =
    readLeadStore(typeof dbArg === "string" ? dbFile : null).leads ?? []
  const applications = readApplications(
    typeof dbArg === "string" ? dbFile : null,
  )

  const s = buildStatus(leads, applications, { days })
  s.auto = autoSection(args, dbFile)

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
    if (s.auto?.unavailable)
      console.log(`auto unavailable=${s.auto.unavailable}`)
    else for (const line of formatAutoTerse(s.auto)) console.log(line)
    return
  }
  console.log(`Leads: ${s.leads.total} (${kv(s.leads.by_status)})`)
  console.log(
    `Applications: ${s.applications.total} (${kv(s.applications.by_status)}); ${s.applications.awaiting_response} awaiting a response`,
  )
  console.log(`Follow-ups due: ${s.follow_ups_due}`)
  for (const d of s.due_list)
    console.log(`  ${d.company} (${d.slug}) — ${d.days} days`)
  if (s.auto?.unavailable)
    console.log(`Auto path: unavailable (${s.auto.unavailable})`)
  else for (const line of formatAutoProse(s.auto)) console.log(line)
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) main()
