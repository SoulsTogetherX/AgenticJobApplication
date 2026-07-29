#!/usr/bin/env node
// Hybrid storage for job workspaces: files while an application is live, rows
// once it closes. Deterministic, no LLM.
//
// The problem this solves is not disk space. jobs/ reached ~100 directories and
// it stopped being possible to see which application was actually in flight, so
// the whole lot got deleted — audit trail included. Folding closed work into
// the database keeps `ls jobs/` down to live work without throwing anything
// away, and a full database was rejected as too opaque to inspect by hand.
//
//   ACTIVE  jobs/<slug>/ exactly as today. Editable, diffable, and what
//           verify-claims.mjs and render-pdf.mjs already read.
//   CLOSED  rows in the `documents` table, directory removed.
//
// Usage:
//   node scripts/maintenance/archive.mjs list [--json]
//   node scripts/maintenance/archive.mjs show <slug> [--json]
//   node scripts/maintenance/archive.mjs archive <slug> [--force]
//   node scripts/maintenance/archive.mjs archive --closed [--dry-run]
//   node scripts/maintenance/archive.mjs restore <slug> [--to <dir>] [--force]
//   ... plus [--jobs-dir <path>] [--db <path>] [--applications <path>]
//
// Exit codes: 0 ok, 1 refused / nothing to do, 2 usage.
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath, pathToFileURL } from "node:url"
import { isTerse } from "../lib/lib.mjs"
import {
  openDb,
  readApplications,
  writeDocuments,
  readDocuments,
  listDocuments,
  DB_PATH,
} from "../lib/db.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

// Outcomes that mean the application is finished. "applied" is deliberately NOT
// here, and neither is anything still in motion: a submitted application with
// no reply yet is exactly the case the user needs to see in `ls jobs/`.
export const CLOSED = new Set([
  "rejected",
  "closed",
  "withdrawn",
  "no_response",
])

// Statuses that make an automatic archive wrong and a manual one a mistake
// worth stopping for.
export const LIVE = new Set(["applied", "followed_up", "interviewing", "offer"])

// What happens to each file in a workspace.
//   store        bytes go into the table verbatim — the audit trail
//   regenerable  a row without content; render-pdf.mjs rebuilds it on demand
//   drop         an intermediate that was never worth keeping
export function classify(name) {
  if (/\.render\.html$/i.test(name)) return "drop"
  if (/\.pdf$/i.test(name)) return "regenerable"
  return "store"
}

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex")

// Pure core (exported for tests): which slugs may be archived, and why not.
export function planArchive(
  workspaces,
  applications,
  { slugs = null, closedOnly = false, force = false } = {},
) {
  const bySlug = new Map(applications.map((a) => [a.slug, a]))
  const archive = []
  const refuse = []

  for (const ws of workspaces) {
    if (slugs && !slugs.includes(ws.slug)) continue
    const status = bySlug.get(ws.slug)?.status ?? null

    if (closedOnly) {
      // The automatic path never guesses. No record and no recorded outcome
      // both mean "not known to be closed", which is not the same as closed.
      if (!status || !CLOSED.has(status)) {
        refuse.push({
          slug: ws.slug,
          reason: status
            ? `status "${status}" is not a closed outcome`
            : "no recorded outcome",
        })
        continue
      }
    } else if (LIVE.has(status) && !force) {
      refuse.push({
        slug: ws.slug,
        reason: `application is still live (status "${status}") — pass --force if you mean it`,
      })
      continue
    }

    archive.push({ slug: ws.slug, status })
  }

  if (slugs) {
    const seen = new Set([...archive, ...refuse].map((r) => r.slug))
    for (const s of slugs) {
      if (!seen.has(s)) refuse.push({ slug: s, reason: "no such workspace" })
    }
  }
  return { archive, refuse }
}

function readWorkspace(jobsDir, slug) {
  const dir = path.join(jobsDir, slug)
  const files = []
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    let st
    try {
      st = fs.statSync(full)
    } catch {
      continue
    }
    if (!st.isFile()) continue
    const how = classify(name)
    if (how === "drop") continue
    const buf = fs.readFileSync(full)
    files.push({
      name,
      // Regenerable files keep their size and hash but not their bytes, so a
      // restore can still report exactly what was there.
      content: how === "store" ? buf : null,
      bytes: buf.length,
      sha256: sha256(buf),
    })
  }
  return files.sort((a, b) => (a.name < b.name ? -1 : 1))
}

// Read every row back and prove it matches what was on disk BEFORE anything is
// deleted. migrate.mjs holds the same discipline for leads and applications;
// an archive step that removes the only copy on an unverified write is how an
// audit trail disappears.
function verifyArchive(db, slug, files) {
  const rows = readDocuments(db, slug)
  if (rows.length !== files.length) {
    return `${rows.length} row(s) stored for ${files.length} file(s)`
  }
  const byName = new Map(rows.map((r) => [r.name, r]))
  for (const f of files) {
    const r = byName.get(f.name)
    if (!r) return `${f.name} is missing from the archive`
    if (r.bytes !== f.bytes || r.sha256 !== f.sha256)
      return `${f.name}: metadata does not match the file on disk`
    if (f.content === null) {
      if (r.content != null) return `${f.name}: regenerable row stored content`
      continue
    }
    if (r.content == null) return `${f.name}: content was not stored`
    const back = Buffer.from(r.content)
    if (back.length !== f.content.length || sha256(back) !== f.sha256)
      return `${f.name}: stored bytes do not round-trip`
  }
  return null
}

function archiveOne(db, jobsDir, slug) {
  const files = readWorkspace(jobsDir, slug)
  if (!files.length) {
    // An empty (or intermediates-only) directory has nothing to preserve, so
    // removing it is safe — but say so rather than reporting an archive.
    fs.rmSync(path.join(jobsDir, slug), { recursive: true, force: true })
    return { slug, files: 0, bytes: 0, regenerable: 0, emptied: true }
  }
  writeDocuments(db, slug, files)
  const bad = verifyArchive(db, slug, files)
  if (bad) throw new Error(`${slug}: ${bad} — directory left in place`)

  fs.rmSync(path.join(jobsDir, slug), { recursive: true, force: true })
  return {
    slug,
    files: files.length,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    regenerable: files.filter((f) => f.content === null).length,
  }
}

function restoreOne(db, slug, dest, { force = false } = {}) {
  const rows = readDocuments(db, slug)
  if (!rows.length) return { slug, error: "nothing archived under that slug" }
  if (fs.existsSync(dest) && fs.readdirSync(dest).length && !force) {
    return { slug, error: `${dest} already exists and is not empty` }
  }
  fs.mkdirSync(dest, { recursive: true })

  const written = []
  const regenerable = []
  for (const r of rows) {
    if (r.content == null) {
      regenerable.push({ name: r.name, bytes: r.bytes })
      continue
    }
    const buf = Buffer.from(r.content)
    if (sha256(buf) !== r.sha256) {
      return { slug, error: `${r.name}: archived bytes failed their checksum` }
    }
    fs.writeFileSync(path.join(dest, r.name), buf)
    written.push(r.name)
  }
  return { slug, dest, written, regenerable }
}

function listWorkspaces(jobsDir) {
  if (!fs.existsSync(jobsDir)) return []
  return fs
    .readdirSync(jobsDir)
    .filter((n) => {
      try {
        return fs.statSync(path.join(jobsDir, n)).isDirectory()
      } catch {
        return false
      }
    })
    .map((slug) => ({ slug }))
}

function main() {
  const args = process.argv.slice(2)
  const flag = (name, dflt = null) => {
    const i = args.indexOf(name)
    if (i === -1) return dflt
    const v = args[i + 1]
    args.splice(i, 2)
    return v
  }
  const has = (name) => {
    const i = args.indexOf(name)
    if (i === -1) return false
    args.splice(i, 1)
    return true
  }

  const jobsDir = flag("--jobs-dir") || path.join(ROOT, "jobs")
  const dbFile = flag("--db") || DB_PATH
  const appsPath = flag("--applications")
  const to = flag("--to")
  const wantJson = has("--json")
  const force = has("--force")
  const dryRun = has("--dry-run")
  const closedOnly = has("--closed")

  const [cmd, ...rest] = args.filter((a) => !a.startsWith("--"))
  const applications = readApplications(
    appsPath ?? (dbFile === DB_PATH ? null : dbFile),
  )

  if (cmd === "list") {
    const db = openDb(dbFile)
    try {
      const rows = listDocuments(db)
      if (wantJson) return console.log(JSON.stringify(rows, null, 2))
      if (!rows.length) return console.log("nothing archived")
      if (isTerse()) {
        for (const r of rows)
          console.log(
            `${r.slug}\tfiles=${r.files}\tbytes=${r.bytes}\tregenerable=${r.regenerable}\t${r.archived_at}`,
          )
        return console.log(`archived=${rows.length}`)
      }
      console.log(`\n${rows.length} archived workspace(s):\n`)
      for (const r of rows)
        console.log(
          `  ${r.slug}\n    ${r.files} file(s), ${(r.bytes / 1024).toFixed(0)} KB, ` +
            `${r.regenerable} regenerable, archived ${r.archived_at.slice(0, 10)}`,
        )
      console.log(
        `\nRestore one with: node scripts/maintenance/archive.mjs restore <slug>\n`,
      )
      return
    } finally {
      db.close()
    }
  }

  if (cmd === "show") {
    const slug = rest[0]
    if (!slug) return usage()
    const db = openDb(dbFile)
    try {
      const rows = readDocuments(db, slug).map((r) => ({
        name: r.name,
        bytes: r.bytes,
        stored: r.content != null,
        sha256: r.sha256,
      }))
      if (wantJson) return console.log(JSON.stringify(rows, null, 2))
      if (!rows.length) {
        console.error(`nothing archived under "${slug}"`)
        process.exitCode = 1
        return
      }
      for (const r of rows)
        console.log(
          `${r.name}\t${r.bytes}\t${r.stored ? "stored" : "regenerable"}`,
        )
      return
    } finally {
      db.close()
    }
  }

  if (cmd === "archive") {
    const slugs = rest.length ? rest : null
    if (!slugs && !closedOnly) return usage()
    const { archive, refuse } = planArchive(
      listWorkspaces(jobsDir),
      applications,
      { slugs, closedOnly, force },
    )
    for (const r of refuse) console.log(`refused\t${r.slug}\t${r.reason}`)
    if (dryRun) {
      for (const a of archive) console.log(`would-archive\t${a.slug}`)
      console.log(`archive=${archive.length} refused=${refuse.length} dry-run`)
      return
    }
    if (!archive.length) {
      console.log(`archive=0 refused=${refuse.length}`)
      process.exitCode = refuse.length ? 1 : 0
      return
    }
    const db = openDb(dbFile)
    try {
      let done = 0
      for (const a of archive) {
        const r = archiveOne(db, jobsDir, a.slug)
        console.log(
          r.emptied
            ? `emptied\t${r.slug}\tno files worth keeping`
            : `archived\t${r.slug}\tfiles=${r.files}\tbytes=${r.bytes}\tregenerable=${r.regenerable}`,
        )
        done++
      }
      console.log(`archive=${done} refused=${refuse.length}`)
    } finally {
      db.close()
    }
    return
  }

  if (cmd === "restore") {
    const slug = rest[0]
    if (!slug) return usage()
    const dest = to ? path.resolve(to) : path.join(jobsDir, slug)
    const db = openDb(dbFile)
    try {
      const r = restoreOne(db, slug, dest, { force })
      if (r.error) {
        console.error(`${slug}: ${r.error}`)
        process.exitCode = 1
        return
      }
      console.log(`restored\t${r.slug}\t${r.written.length} file(s)\t${r.dest}`)
      for (const g of r.regenerable) {
        console.log(
          `regenerable\t${g.name}\trebuild with scripts/documents/render-pdf.mjs`,
        )
      }
      // Rows are kept on purpose: restoring is for inspecting or reusing, not
      // for taking the workspace back out of the archive. Re-archiving the
      // slug replaces them.
    } finally {
      db.close()
    }
    return
  }

  usage()
}

function usage() {
  console.error(
    "usage: archive.mjs list | show <slug> | archive <slug>... | archive --closed | restore <slug> [--to <dir>]",
  )
  process.exitCode = 2
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) main()
