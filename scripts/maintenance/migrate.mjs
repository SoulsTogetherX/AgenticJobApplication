#!/usr/bin/env node
// Build jobs/leads.db from the on-disk sources. Deterministic, no LLM.
//
// FLAT, NOT VERSIONED. There is no migration chain and no schema_version
// table: scripts/lib/db.mjs declares the whole schema with CREATE TABLE IF NOT
// EXISTS, and this script re-imports from the files that are still the
// user-owned source of truth. Running it twice is a no-op, running it after a
// schema addition just fills in the new tables. A single-user tool whose
// inputs are all re-derivable does not need incremental migrations — it needs
// one idempotent build step that can always be re-run.
//
// Bootstrap inputs, imported only to fill an empty table — never authoritative
// once jobs/leads.db exists:
//   profile/applications.yaml  → applications (also the generated export)
//   a leads JSON snapshot      → leads, via --leads-json <file>
//
// There is deliberately no standing jobs/leads.json. It was a frozen snapshot
// that drifted from the database the moment a sweep ran, and a stale duplicate
// of the store is worse than no duplicate. Leads are also re-derivable — a
// sweep rebuilds them from public boards — which applications are not, and
// that asymmetry is why applications keep a durable export and leads do not.
// Use `--export <file>` to take a point-in-time snapshot when you want one.
//
// The `documents` table is the exception to all of this and is never touched
// here. An archived workspace has no on-disk source once its directory is gone,
// so there is nothing to rebuild it FROM — re-running this must not be able to
// clear it. Back it up by copying jobs/leads.db itself.
//
// Usage: node scripts/maintenance/migrate.mjs [--dry-run] [--db <path>]
//        [--leads-json <path>] [--applications <path>]
//        node scripts/maintenance/migrate.mjs --export <file>   # snapshot leads
import fs from "node:fs"
import path from "node:path"
import { loadYamlFile } from "../lib/lib.mjs"
import { extractTech } from "../profile/profile-gaps.mjs"
import {
  openDb,
  upsertLeads,
  upsertApplications,
  setLeadKeywords,
  rowToLead,
  readLeadStore,
  DB_PATH,
  APPLICATIONS_PATH,
} from "../lib/db.mjs"

function flag(args, name, fallback = null) {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

// Keywords come from everything the lead actually says about the work.
export function leadKeywords(lead) {
  return [
    ...extractTech(
      [lead.title, lead.description, ...(lead.requirements ?? [])]
        .filter(Boolean)
        .join("\n"),
    ),
  ].sort()
}

const args = process.argv.slice(2)
const dbFile = flag(args, "--db", DB_PATH)
// No default: a default would recreate the stale-duplicate problem this
// removed. A snapshot is only read when you name one.
const leadsJson = flag(args, "--leads-json", null)
const appsYaml = flag(args, "--applications", APPLICATIONS_PATH)
const dryRun = args.includes("--dry-run")

// Point-in-time snapshot of the leads table, on demand. Not written on every
// change: at ~3 KB per lead that would reintroduce exactly the whole-file
// rewrite the SQLite migration removed.
const exportTo = flag(args, "--export", null)
if (exportTo) {
  const { leads: rows } = readLeadStore(dbFile)
  fs.mkdirSync(path.dirname(path.resolve(exportTo)), { recursive: true })
  fs.writeFileSync(exportTo, JSON.stringify({ leads: rows }, null, 2) + "\n")
  console.log(`exported ${rows.length} lead(s) to ${exportTo}`)
  process.exit(0)
}

const leads =
  leadsJson && fs.existsSync(leadsJson)
    ? (JSON.parse(fs.readFileSync(leadsJson, "utf8")).leads ?? [])
    : []
const applications = fs.existsSync(appsYaml)
  ? (loadYamlFile(appsYaml)?.applications ?? [])
  : []

console.log(
  `leads:        ${leads.length}${leadsJson ? ` from ${leadsJson}` : " (no snapshot given)"}`,
)
console.log(`applications: ${applications.length} from ${appsYaml}`)

if (dryRun) {
  console.log("dry run — nothing written")
  process.exit(0)
}

const db = openDb(dbFile)
try {
  // The two tables have DIFFERENT sources of truth, and conflating them is a
  // data-loss bug:
  //
  //   leads        — the database IS the live store once it exists (find-jobs
  //                  writes new leads and status changes straight to it).
  //                  jobs/leads.json is a frozen snapshot from the first
  //                  build. Re-importing it wholesale would roll statuses back
  //                  to that snapshot, so leads are only ever ADDED if their
  //                  id is not already present.
  //   applications — the TABLE is the source of truth (user decision,
  //                  2026-07-29). profile/applications.yaml is a generated
  //                  export, so it is only imported to BOOTSTRAP an empty
  //                  table. Re-importing it over a populated table would undo
  //                  every outcome recorded since the export was written.
  const existing = new Set(
    db
      .prepare("SELECT id FROM leads")
      .all()
      .map((r) => r.id),
  )
  const newLeads = leads.filter((l) => !existing.has(l.id))
  upsertLeads(db, newLeads)

  const appCount = db.prepare("SELECT COUNT(*) c FROM applications").get().c
  const bootstrapped = appCount === 0 && applications.length > 0
  if (bootstrapped) upsertApplications(db, applications)

  // Keywords are derived from what is actually IN the database — not from the
  // JSON snapshot, which may be missing every lead found since the first build.
  const stored = db
    .prepare("SELECT doc FROM leads")
    .all()
    .map((r) => JSON.parse(r.doc))
  let kwTotal = 0
  db.exec("BEGIN")
  try {
    for (const l of stored)
      kwTotal += setLeadKeywords(db, l.id, leadKeywords(l))
    db.exec("COMMIT")
  } catch (e) {
    db.exec("ROLLBACK")
    throw e
  }

  const appRows = db.prepare("SELECT doc FROM applications").all()
  const sortKeys = (o) =>
    Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)))
  const bad = []

  // Leads: every snapshot lead must be PRESENT. The count may legitimately be
  // higher (leads found since), and an existing lead's status may legitimately
  // differ from the snapshot — so only the rows just inserted are compared
  // field-for-field.
  const back = new Map(stored.map((l) => [l.id, l]))
  const missing = leads.filter((l) => !back.has(l.id)).map((l) => l.id)
  if (missing.length)
    throw new Error(
      `${missing.length} snapshot lead(s) missing after import: ${missing.slice(0, 5).join(", ")}`,
    )
  for (const l of newLeads) {
    const got = back.get(l.id)
    if (!got || JSON.stringify(sortKeys(l)) !== JSON.stringify(sortKeys(got)))
      bad.push(l.id)
  }

  // Applications: only verified when this run bootstrapped them. Otherwise the
  // table is authoritative and the YAML export is simply older than it.
  if (bootstrapped && appRows.length !== applications.length)
    throw new Error(
      `application count: ${appRows.length} in db vs ${applications.length} in yaml`,
    )
  const appBack = new Map(
    appRows.map((r) => {
      const a = JSON.parse(r.doc)
      return [a.slug, a]
    }),
  )
  if (bootstrapped) {
    for (const a of applications) {
      const got = appBack.get(a.slug)
      if (!got || JSON.stringify(sortKeys(a)) !== JSON.stringify(sortKeys(got)))
        bad.push(a.slug)
    }
  }
  if (bad.length)
    throw new Error(
      `${bad.length} record(s) did not round-trip: ${bad.slice(0, 5).join(", ")}`,
    )

  console.log(
    `built ${dbFile}: ${stored.length} leads (+${newLeads.length} imported), ` +
      `${appRows.length} applications${bootstrapped ? " (bootstrapped from yaml)" : ""}, ${kwTotal} keyword links`,
  )
  console.log(
    "verified: applications match the YAML and new records round-trip",
  )
  console.log("sources left untouched; delete the .db to roll back")
} catch (e) {
  console.error(`migration failed: ${e.message}`)
  process.exitCode = 1
} finally {
  db.close()
}
