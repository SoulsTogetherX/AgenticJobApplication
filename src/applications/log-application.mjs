#!/usr/bin/env node
// Record a submitted application — the ONLY sanctioned way for the agent to
// create an application record, and only after the user confirms they applied.
//
// Storage moved (2026-07-29): the `applications` table in jobs/leads.db is the
// source of truth, and profile/applications.yaml is regenerated from it after
// every write. The guardrail is unchanged; only the file underneath it is.
//
// Usage: node src/applications/log-application.mjs <slug> --company "X" --title "Y"
//        [--url <url>] [--date YYYY-MM-DD] [--notes "..."] [--file <yaml>]
// --file forces the legacy YAML-only path, which is what the tests use.
import fs from "node:fs"
import { loadYamlFile, dumpYaml } from "#lib/lib.mjs"
import { readApplications, writeApplication } from "#lib/db.mjs"

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
// No --file means "use the real store"; an explicit --file keeps the old
// YAML-only behaviour so tests never touch the production database.
const file = flag("--file", null)
const company = flag("--company", null)
const title = flag("--title", null)
const url = flag("--url", null)
const date = flag("--date", new Date().toISOString().slice(0, 10))
const notes = flag("--notes", null)
const slug = args[0]

if (!slug?.trim() || !company?.trim() || !title?.trim()) {
  console.error(
    'Usage: log-application.mjs <slug> --company "X" --title "Y" [--url U] [--date YYYY-MM-DD] [--notes N]',
  )
  process.exit(2)
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
  console.error(`Invalid --date "${date}" (expected YYYY-MM-DD)`)
  process.exit(2)
}

const entry = {
  slug: slug.trim(),
  company: company.trim(),
  title: title.trim(),
  applied_at: date,
  source_url: url,
  notes,
}

const existing = file
  ? fs.existsSync(file)
    ? (loadYamlFile(file)?.applications ?? [])
    : []
  : readApplications()

const dup = existing.find((a) => a.slug === entry.slug)
if (dup) {
  console.error(
    `Already logged: applied to ${dup.company} — ${dup.title} on ${dup.applied_at} (slug ${dup.slug}).\n` +
      `Change it with update-application.mjs, or remove it with:\n` +
      `  node src/applications/applications.mjs remove ${dup.slug} --confirm`,
  )
  process.exit(1)
}

if (file) {
  // Legacy YAML-only path (tests, or an explicit alternate store).
  const data = { applications: [...existing, entry] }
  fs.writeFileSync(file, dumpYaml(data), "utf8")
} else {
  writeApplication(entry, dumpYaml)
}
console.log(`Logged application: ${company.trim()} — ${title.trim()} (${date})`)
