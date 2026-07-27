#!/usr/bin/env node
// Deterministic manager for docs/job-sources.yaml (no LLM calls).
// `add` PRESCREENS the board with a live API call and refuses duplicates, so
// the daily sweep only ever hits boards that are known to work.
//
// Usage:
//   node scripts/manage-sources.mjs add --type <ats> --slug <slug> --company "Name"
//   node scripts/manage-sources.mjs add --type workday --company "Name" \
//     --host x.wd5.myworkdayjobs.com --tenant x --site SiteName
//   node scripts/manage-sources.mjs remove "<company or slug>"
//   node scripts/manage-sources.mjs verify            # live-check every board
//   node scripts/manage-sources.mjs list
//
// docs/job-sources.yaml is edited line-by-line (entries are single-line flow
// maps) so the file's comments survive every add/remove.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import yaml from "js-yaml"
import { fetchBoard, BOARD_TYPES, loadSources } from "./find-jobs.mjs"
import { isTerse } from "./lib.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SOURCES_PATH = path.join(ROOT, "docs", "job-sources.yaml")

// ---------------------------------------------------------------------------
// Pure logic (exported for tests)
// ---------------------------------------------------------------------------

const norm = (s) =>
  String(s ?? "")
    .trim()
    .toLowerCase()

// A duplicate is the same company name, or the same type+slug (or workday
// tenant) — one entry per employer per board.
export function findDuplicate(boards, entry) {
  return (
    boards.find(
      (b) =>
        norm(b.company) === norm(entry.company) ||
        (b.type === entry.type &&
          norm(b.slug ?? b.tenant) === norm(entry.slug ?? entry.tenant)),
    ) ?? null
  )
}

export function formatEntry(entry) {
  const q = (v) =>
    /[:#'"{}\[\],&*?|>%@`]|^\s|\s$/.test(v) ? JSON.stringify(v) : v
  const fields =
    entry.type === "workday"
      ? ["type", "company", "host", "tenant", "site"]
      : ["type", "slug", "company"]
  const body = fields.map((f) => `${f}: ${q(String(entry[f]))}`).join(", ")
  return `  - { ${body} }`
}

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
        (norm(entry.company) === norm(key) ||
          norm(entry.slug ?? entry.tenant) === norm(key))
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
  if (entry.type === "workday" && !(entry.host && entry.tenant && entry.site)) {
    throw new Error("workday boards need --host, --tenant, and --site")
  }
  if (entry.type !== "workday" && !entry.slug) {
    throw new Error(`${entry.type} boards need --slug`)
  }

  const dup = findDuplicate(loadSources(), entry)
  if (dup) {
    throw new Error(
      `duplicate: "${dup.company}" (${dup.type}:${dup.slug ?? dup.tenant}) is already tracked`,
    )
  }

  // Prescreen: the board must answer with a job list before it earns a slot.
  const jobs = await fetchBoard(entry, "software engineer")
  if (!Array.isArray(jobs))
    throw new Error("prescreen failed: no job list returned")

  writeSourcesText(addEntryToText(readSourcesText(), entry))
  console.log(
    `Added ${entry.company} (${entry.type}:${entry.slug ?? entry.tenant}) — prescreen OK, ${jobs.length} posting(s) visible right now.`,
  )
  if (jobs.length === 0) {
    console.log(
      "note: the board is live but currently empty; it stays in the daily sweep.",
    )
  }
}

function cmdRemove(args) {
  const key = args.find((a) => !a.startsWith("--"))
  if (!key) throw new Error('usage: remove "<company or slug>"')
  const { text, removed } = removeEntryFromText(readSourcesText(), key)
  if (!removed) throw new Error(`no tracked board matches "${key}"`)
  writeSourcesText(text)
  console.log(`Removed ${removed} board(s) matching "${key}".`)
}

async function cmdVerify() {
  let ok = 0
  let broken = 0
  for (const b of loadSources()) {
    const label = `${b.type}:${b.slug ?? b.tenant}`
    try {
      const jobs = await fetchBoard(b, "software engineer")
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
    console.log(`${b.company}  (${b.type}:${b.slug ?? b.tenant})`)
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
