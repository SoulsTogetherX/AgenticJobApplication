#!/usr/bin/env node
// Deterministic manager for docs/job-sources.yaml (no LLM calls).
// `add` PRESCREENS the board with a live API call and refuses duplicates, so
// the daily sweep only ever hits boards that are known to work.
//
// Usage:
//   node src/leads/manage-sources.mjs add --type <ats> --slug <slug> --company "Name"
//   node src/leads/manage-sources.mjs add --type workday --company "Name" \
//     --host x.wd5.myworkdayjobs.com --tenant x --site SiteName
//   node src/leads/manage-sources.mjs remove "<company or slug>"
//   node src/leads/manage-sources.mjs verify            # live-check every board
//   node src/leads/manage-sources.mjs list
//
// docs/job-sources.yaml is edited line-by-line (entries are single-line flow
// maps) so the file's comments survive every add/remove.
import fs from "node:fs"
import { positionals } from "#lib/args.mjs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import yaml from "js-yaml"
import {
  fetchBoard,
  BOARD_TYPES,
  loadSources,
  loadLimits,
  DEFAULT_SEARCH_QUERY,
} from "./find-jobs.mjs"
import { isTerse } from "#lib/lib.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const SOURCES_PATH = path.join(ROOT, "docs", "job-sources.yaml")

// The same query cmdSearch actually sweeps with — a THIRD independently
// hardcoded "software engineer" used to sit here (alongside fetchBoard's own
// default), which meant a board's prescreen count could disagree with what
// the daily sweep finds for it, on the one fetcher of thirteen (Workday)
// where the query is a server-side filter (P5, retarget-readiness audit
// 2026-08).
// `limitsFile` exists so a test can point this at a fixture instead of the
// real docs/application-limits.yaml — without it, a test asserting the
// fallback would silently start failing the day the user actually adds
// roles.search_query, since it would then read their real, non-default value.
export function searchQuery(limitsFile = undefined) {
  try {
    return (
      loadLimits(...(limitsFile ? [limitsFile] : [])).roles?.search_query ??
      DEFAULT_SEARCH_QUERY
    )
  } catch {
    return DEFAULT_SEARCH_QUERY
  }
}

// ---------------------------------------------------------------------------
// Pure logic (exported for tests)
// ---------------------------------------------------------------------------

const norm = (s) =>
  String(s ?? "")
    .trim()
    .toLowerCase()

// A duplicate is the same company name, or the same type + board identity —
// one entry per employer per board. The identity field varies by ATS: slug for
// most, tenant+site for workday, site for oracle_cloud.
//
// Host-based ATSs need EVERY field that distinguishes one board, and both
// single-field identities were wrong in the same way — they matched boards
// that merely share infrastructure, and refused the second real employer:
//
//   workday: tenant alone. NSHE (nshe.wd1) carries UNLV on `UNLV-External` and
//   the College of Southern Nevada on `CSN-External`. Two employers, two job
//   lists — the second refused for sharing a landlord.
//
//   oracle_cloud: site alone. `CX_1` is Oracle's DEFAULT site name, not an
//   identifier: Caesars (edmn.fa.us2) and Southwest Gas (ebtw.fa.us2) both use
//   it. Site-only identity refused Southwest Gas as a duplicate of Caesars,
//   which would have capped this ATS at one employer forever.
//
// Both found by execution while adding boards on 2026-08-13.
const IDENTITY_FIELDS = {
  workday: ["tenant", "site"],
  oracle_cloud: ["host", "site"],
  successfactors: ["host"],
}
const identity = (b) =>
  norm(
    b.slug ??
      (IDENTITY_FIELDS[b.type] ?? ["host", "tenant", "site"])
        .map((f) => b[f] ?? "")
        .join("/"),
  )

export function findDuplicate(boards, entry) {
  return (
    boards.find(
      (b) =>
        norm(b.company) === norm(entry.company) ||
        (b.type === entry.type && identity(b) === identity(entry)),
    ) ?? null
  )
}

// Field order per ATS. Host-based boards carry no slug, and a missing field
// must be omitted rather than written as the string "undefined" — that is what
// silently produced two dead entries that still prescreened OK.
const ENTRY_FIELDS = {
  workday: ["type", "company", "host", "tenant", "site"],
  oracle_cloud: ["type", "company", "host", "site"],
  successfactors: ["type", "company", "host"],
  // eid is optional: the fetcher bootstraps it from the careers page, but
  // pinning it saves a request and survives a careers-page redesign.
  jobvite: ["type", "slug", "company", "eid"],
}
const DEFAULT_ENTRY_FIELDS = ["type", "slug", "company"]

export function formatEntry(entry) {
  const q = (v) =>
    /[:#'"{}\[\],&*?|>%@`]|^\s|\s$/.test(v) ? JSON.stringify(v) : v
  const fields = ENTRY_FIELDS[entry.type] ?? DEFAULT_ENTRY_FIELDS
  const body = fields
    .filter(
      (f) => entry[f] !== undefined && entry[f] !== null && entry[f] !== "",
    )
    .map((f) => `${f}: ${q(String(entry[f]))}`)
    .join(", ")
  return `  - { ${body} }`
}

// How a board is named in output: the identity field varies by ATS.
export const boardLabel = (b) =>
  `${b.type}:${b.slug ?? b.tenant ?? b.site ?? b.company}`

// Delete the single line whose flow map matches company or slug/tenant.
export function removeEntryFromText(text, key) {
  const lines = text.split("\n")
  const kept = []
  let removed = 0
  for (const line of lines) {
    if (/^\s*-\s*\{.*\}\s*$/.test(line)) {
      let entry = null
      try {
        entry = yaml.load(line.replace(/^\s*-\s*/, ""))
      } catch {}
      if (
        entry &&
        (norm(entry.company) === norm(key) || identity(entry) === norm(key))
      ) {
        removed++
        continue
      }
    }
    kept.push(line)
  }
  return { text: kept.join("\n"), removed }
}

export function addEntryToText(text, entry) {
  const line = formatEntry(entry)
  const out = text.endsWith("\n") ? text : text + "\n"
  return out + line + "\n"
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// The flags that take a VALUE, so positionals() never reads one as the key.
// `manage-sources.mjs remove --company Acme greenhouse:acme` used to look for
// a source keyed "Acme".
const VALUE_FLAGS = [
  "--company",
  "--eid",
  "--host",
  "--site",
  "--slug",
  "--tenant",
  "--type",
]

function getFlag(args, name, fallback = null) {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

function readSourcesText() {
  return fs.readFileSync(SOURCES_PATH, "utf8")
}

function writeSourcesText(text) {
  // Refuse to persist anything yaml can't parse back into a board list.
  const doc = yaml.load(text)
  if (!Array.isArray(doc?.boards)) {
    throw new Error("internal error: edited job-sources.yaml no longer parses")
  }
  fs.writeFileSync(SOURCES_PATH, text)
}

async function cmdAdd(args) {
  const entry = {
    type: getFlag(args, "--type"),
    company: getFlag(args, "--company"),
    slug: getFlag(args, "--slug") ?? undefined,
    eid: getFlag(args, "--eid") ?? undefined,
    host: getFlag(args, "--host") ?? undefined,
    tenant: getFlag(args, "--tenant") ?? undefined,
    site: getFlag(args, "--site") ?? undefined,
  }
  if (!entry.type || !entry.company) {
    throw new Error(
      "usage: add --type <ats> --company Name [--slug s | --host h --tenant t --site s]",
    )
  }
  if (!BOARD_TYPES.includes(entry.type)) {
    throw new Error(
      `unknown type "${entry.type}" (known: ${BOARD_TYPES.join(", ")})`,
    )
  }
  if (entry.type === "oracle_cloud" && !(entry.host && entry.site)) {
    throw new Error(
      "oracle_cloud boards need --host (e.g. edmn.fa.us2.oraclecloud.com) and --site (e.g. CX_1)",
    )
  }
  if (entry.type === "workday" && !(entry.host && entry.tenant && entry.site)) {
    throw new Error("workday boards need --host, --tenant, and --site")
  }
  if (entry.type === "successfactors" && !entry.host) {
    throw new Error(
      "successfactors boards need --host (e.g. jobs.igt.com), the career-site hostname",
    )
  }
  // Host-based ATSs identify a board by host+site rather than a slug.
  const HOST_BASED = new Set(["workday", "oracle_cloud", "successfactors"])
  if (!HOST_BASED.has(entry.type) && !entry.slug) {
    throw new Error(`${entry.type} boards need --slug`)
  }

  const dup = findDuplicate(loadSources(), entry)
  if (dup) {
    throw new Error(
      `duplicate: "${dup.company}" (${boardLabel(dup)}) is already tracked`,
    )
  }

  // Prescreen: the board must answer with a job list before it earns a slot.
  const jobs = await fetchBoard(entry, searchQuery())
  if (!Array.isArray(jobs))
    throw new Error("prescreen failed: no job list returned")

  writeSourcesText(addEntryToText(readSourcesText(), entry))
  console.log(
    `Added ${entry.company} (${boardLabel(entry)}) — prescreen OK, ${jobs.length} posting(s) visible right now.`,
  )
  if (jobs.length === 0) {
    console.log(
      "note: the board is live but currently empty; it stays in the daily sweep.",
    )
  }
}

function cmdRemove(args) {
  const key = positionals(args, VALUE_FLAGS)[0]
  if (!key) throw new Error('usage: remove "<company or slug>"')
  const { text, removed } = removeEntryFromText(readSourcesText(), key)
  if (!removed) throw new Error(`no tracked board matches "${key}"`)
  writeSourcesText(text)
  console.log(`Removed ${removed} board(s) matching "${key}".`)
}

async function cmdVerify() {
  let ok = 0
  let broken = 0
  const query = searchQuery()
  for (const b of loadSources()) {
    const label = boardLabel(b)
    try {
      const jobs = await fetchBoard(b, query)
      // Terse mode reports only what needs action; ok boards are just a count.
      if (!isTerse()) console.log(`ok      ${label} (${jobs.length} postings)`)
      ok++
    } catch (e) {
      console.log(`BROKEN  ${label} — ${e.message}`)
      broken++
    }
  }
  console.log(`\n${ok} ok, ${broken} broken.`)
  if (broken) process.exitCode = 1
}

function cmdList() {
  for (const b of loadSources()) {
    console.log(`${b.company}  (${boardLabel(b)})`)
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2)
  if (cmd === "add") await cmdAdd(args)
  else if (cmd === "remove") cmdRemove(args)
  else if (cmd === "verify") await cmdVerify()
  else if (cmd === "list") cmdList()
  else {
    console.error(
      "usage: manage-sources.mjs <add|remove|verify|list> [options]",
    )
    process.exit(2)
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  main().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
