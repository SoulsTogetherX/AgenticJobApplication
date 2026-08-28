#!/usr/bin/env node
// Read/write surface for the application store. Deterministic, no LLM.
//
// The `applications` table in jobs/leads.db is the source of truth;
// profile/applications.yaml is a generated export kept for readability and
// recovery. See scripts/lib/db.mjs.
//
// GUARDRAIL (CLAUDE.md rule 2 still applies, only the storage moved): an
// application is recorded ONLY after the user confirms they submitted it, and
// `remove` exists to correct mistakes — never to quietly rewrite history.
//
// Usage:
//   node scripts/applications/applications.mjs list [--status s] [--company X] [--json]
//   node scripts/applications/applications.mjs find "<company|title|slug>" [--json]
//   node scripts/applications/applications.mjs stats [--json]
//   node scripts/applications/applications.mjs remove <slug> --confirm
//   node scripts/applications/applications.mjs export
//
// Creating and updating entries stay where they were:
//   node scripts/applications/log-application.mjs <slug> --company X --title Y
//   node scripts/applications/update-application.mjs <slug> --status s [--followed-up]
import { pathToFileURL } from "node:url"
import path from "node:path"
import { isTerse, dumpYaml } from "../lib/lib.mjs"
import {
  openDb,
  readApplications,
  deleteApplication,
  exportApplicationsYaml,
  APPLICATIONS_PATH,
} from "../lib/db.mjs"
import { positionals } from "../lib/args.mjs"

// The flags that take a VALUE. Used by positionals() so a value is never read
// as the positional — `applications.mjs remove --company Acme my-slug` used to
// take "Acme" as the slug, because the positional was found with
// `args.find((a) => !a.startsWith("--"))` and the value was never spliced out.
const VALUE_FLAGS = ["--company", "--status", "--file"]

function flag(args, name, fallback = null) {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const norm = (s) =>
  String(s ?? "")
    .trim()
    .toLowerCase()

export function matchApplications(applications, query) {
  const q = norm(query)
  if (!q) return applications
  return applications.filter(
    (a) =>
      norm(a.slug).includes(q) ||
      norm(a.company).includes(q) ||
      norm(a.title).includes(q),
  )
}

export function summarize(applications) {
  const byStatus = {}
  for (const a of applications) {
    const k = a.status ?? "applied"
    byStatus[k] = (byStatus[k] ?? 0) + 1
  }
  const dates = applications
    .map((a) => a.applied_at)
    .filter(Boolean)
    .sort()
  return {
    total: applications.length,
    by_status: byStatus,
    first: dates[0] ?? null,
    latest: dates[dates.length - 1] ?? null,
    companies: new Set(applications.map((a) => norm(a.company))).size,
  }
}

function printRows(rows) {
  if (isTerse()) {
    for (const a of rows) {
      console.log(
        `${a.slug}|${a.status ?? "applied"}|${a.company}|${a.title}|${a.applied_at ?? "-"}`,
      )
    }
    console.log(`count=${rows.length}`)
    return
  }
  if (!rows.length) {
    console.log("No applications match.")
    return
  }
  for (const a of rows) {
    console.log(
      `${a.applied_at ?? "????-??-??"}  ${a.company} — ${a.title}\n  ${a.slug} [${a.status ?? "applied"}]${a.source_url ? `\n  ${a.source_url}` : ""}`,
    )
  }
  console.log(`\n${rows.length} application(s).`)
}

function main() {
  const [cmd, ...args] = process.argv.slice(2)
  const asJson = args.includes("--json")

  if (cmd === "list") {
    let rows = readApplications()
    const status = flag(args, "--status")
    const company = flag(args, "--company")
    if (status) rows = rows.filter((a) => (a.status ?? "applied") === status)
    if (company)
      rows = rows.filter((a) => norm(a.company).includes(norm(company)))
    if (asJson) return console.log(JSON.stringify(rows, null, 2))
    return printRows(rows)
  }

  if (cmd === "find") {
    const q = positionals(args, VALUE_FLAGS)[0]
    if (!q) {
      console.error('usage: applications.mjs find "<company|title|slug>"')
      process.exit(2)
    }
    const rows = matchApplications(readApplications(), q)
    if (asJson)
      return console.log(JSON.stringify({ query: q, matches: rows }, null, 2))
    return printRows(rows)
  }

  if (cmd === "stats") {
    const s = summarize(readApplications())
    if (asJson) return console.log(JSON.stringify(s, null, 2))
    if (isTerse()) {
      const st = Object.entries(s.by_status)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")
      return console.log(
        `total=${s.total} companies=${s.companies} first=${s.first ?? "-"} latest=${s.latest ?? "-"} ${st}`,
      )
    }
    console.log(`\n${s.total} application(s) to ${s.companies} companies`)
    console.log(`first: ${s.first ?? "-"}   latest: ${s.latest ?? "-"}`)
    for (const [k, v] of Object.entries(s.by_status))
      console.log(`  ${k}: ${v}`)
    return console.log("")
  }

  if (cmd === "remove") {
    const slug = positionals(args, VALUE_FLAGS)[0]
    if (!slug) {
      console.error("usage: applications.mjs remove <slug> --confirm")
      process.exit(2)
    }
    // Deleting an application destroys a record of something the user actually
    // did, so it takes an explicit flag rather than a bare command.
    if (!args.includes("--confirm")) {
      const hit = readApplications().find((a) => a.slug === slug)
      if (!hit) {
        console.error(`no application with slug "${slug}"`)
        process.exit(2)
      }
      console.error(
        `Would remove: ${hit.company} — ${hit.title} (${hit.applied_at ?? "no date"})\n` +
          `Re-run with --confirm to delete it.`,
      )
      process.exit(2)
    }
    const db = openDb()
    try {
      const n = deleteApplication(db, slug)
      if (!n) {
        console.error(`no application with slug "${slug}"`)
        process.exit(2)
      }
      exportApplicationsYaml(db, APPLICATIONS_PATH, dumpYaml)
      console.log(`removed ${slug}`)
    } finally {
      db.close()
    }
    return
  }

  if (cmd === "export") {
    const db = openDb()
    try {
      const n = exportApplicationsYaml(db, APPLICATIONS_PATH, dumpYaml)
      console.log(`exported ${n} application(s) to ${APPLICATIONS_PATH}`)
    } finally {
      db.close()
    }
    return
  }

  console.error(
    "usage: applications.mjs <list|find|stats|remove|export> [options]",
  )
  process.exit(2)
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) main()
