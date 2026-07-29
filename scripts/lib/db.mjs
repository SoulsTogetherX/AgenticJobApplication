#!/usr/bin/env node
// Storage for the lead store. Deterministic, no LLM, no network.
//
// WHY SQLITE (and not MongoDB/MySQL, which were the other candidates):
// this is a single-user CLI on a Windows laptop. Mongo and MySQL both need a
// server daemon running before any script can do anything — if it is not up,
// the whole pipeline fails. SQLite is a single file with no daemon, it is
// built into Node 22.5+ as `node:sqlite` (so zero new dependencies on top of
// js-yaml and marked), and it is ACID.
//
// WHAT IT FIXES, measured on the real store (99 leads, 321 KB):
//   - jobs/leads.json was fully parsed AND fully rewritten on every mutation.
//     Marking 57 leads dismissed meant 57 full read+rewrite cycles — O(n^2).
//     A single-row UPDATE replaces that.
//   - reads filtered by status scanned every lead; now they hit an index.
//
// JSON is still a first-class input so tests can keep pointing --leads at a
// fixture, and so a store can be inspected or restored by hand.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadYamlFile } from "./lib.mjs"

// node:sqlite is stable enough to depend on but still emits an
// ExperimentalWarning on first use. These scripts are parsed by agents from
// stdout/stderr, so a warning on every invocation is real noise; drop just
// that one and leave every other warning intact.
const emitWarning = process.emitWarning.bind(process)
process.emitWarning = (warning, ...rest) => {
  if (String(warning).includes("SQLite is an experimental feature")) return
  return emitWarning(warning, ...rest)
}
const { DatabaseSync } = await import("node:sqlite")

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
export const DB_PATH = path.join(ROOT, "jobs", "leads.db")
// Legacy location only. There is no standing leads.json any more — it was a
// snapshot that went stale the moment a sweep ran. This remains so a repo that
// still has one (or a fresh checkout restoring from a snapshot) can be read
// before `migrate.mjs` builds the database.
export const JSON_PATH = path.join(ROOT, "jobs", "leads.json")
export const APPLICATIONS_PATH = path.join(ROOT, "profile", "applications.yaml")

// The lead is stored as its own JSON document, with only the queried fields
// denormalized into columns for indexing.
//
// This shape was chosen after a column-per-field version failed its own
// round-trip check on 73 of 99 real leads: mapping fields by hand cannot
// distinguish `flags: []` from no flags, or `notes: ""` from `notes: null`,
// and each such case silently altered a lead. Keeping the document verbatim
// makes fidelity structural rather than something 15 mappings must get right,
// and json_set() keeps the denormalized columns in step on update.
const INDEXED = ["status", "company", "title", "posted_at"]

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leads (
  id        TEXT PRIMARY KEY,
  status    TEXT,
  company   TEXT,
  title     TEXT,
  posted_at TEXT,
  doc       TEXT NOT NULL   -- the complete lead object, verbatim
);
CREATE INDEX IF NOT EXISTS idx_leads_status  ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_company ON leads(company);
CREATE INDEX IF NOT EXISTS idx_leads_posted  ON leads(posted_at);

-- Keywords (tech/tooling) seen in a lead's title and description, extracted
-- once at ingest instead of re-parsed from raw descriptions on every analysis.
-- A separate table rather than a field on the lead so the interesting question
-- is a GROUP BY: "what do the jobs that rejected me keep asking for?"
CREATE TABLE IF NOT EXISTS lead_keywords (
  lead_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  PRIMARY KEY (lead_id, keyword)
);
CREATE INDEX IF NOT EXISTS idx_kw_keyword ON lead_keywords(keyword);

-- Submitted applications. profile/applications.yaml stays on disk as the
-- user-owned backup, but it is append-only and unbounded, and every consumer
-- re-parsed the whole file; this makes lookups indexed and updates single-row.
CREATE TABLE IF NOT EXISTS applications (
  slug       TEXT PRIMARY KEY,
  company    TEXT,
  title      TEXT,
  applied_at TEXT,
  status     TEXT,
  doc        TEXT NOT NULL   -- the complete application object, verbatim
);
CREATE INDEX IF NOT EXISTS idx_apps_company ON applications(company);
CREATE INDEX IF NOT EXISTS idx_apps_applied ON applications(applied_at);

-- Per-lead screening verdicts, keyed by WHO produced them.
--
-- The source column is the whole point. The mechanical screen
-- (scripts/leads/screen.mjs) is regex over stored text and costs ~125 ms for
-- the entire store, so caching it saves nothing; it is kept because a verdict
-- with no history cannot be audited. The expensive source is "model" — the
-- pipeline-jobs Stage A read, which fetches the live posting and judges
-- ghost/scam/culture signals. That verdict used to be discarded, so
-- re-screening a lead paid for it again. Now it is looked up.
--
-- Latest verdict per (lead, source), not an append-only log: nothing reads
-- screening history, and a row per re-run grows without bound. A mechanical
-- verdict must never satisfy a caller looking for a model one, which is exactly
-- what a single-verdict-per-lead table would have allowed.
--
-- doc holds the verdict verbatim (signals, reason, years_required, whatever a
-- later screen learns to emit) for the same reason leads.doc does: columns
-- mapped by hand lose the difference between "no signals" and "not recorded".
-- The stack/keywords half of a screen is NOT duplicated here — lead_keywords
-- already extracts that at ingest.
CREATE TABLE IF NOT EXISTS screens (
  lead_id     TEXT NOT NULL,
  source      TEXT NOT NULL,   -- 'mechanical' | 'model'
  verdict     TEXT NOT NULL,
  screened_at TEXT NOT NULL,
  doc         TEXT NOT NULL,
  PRIMARY KEY (lead_id, source)
);
CREATE INDEX IF NOT EXISTS idx_screens_source ON screens(source, verdict);

-- Archived job workspaces. jobs/<slug>/ is the live form while an application
-- is open — editable, diffable, and what verify-claims and render-pdf already
-- read. Once an application closes the directory is folded in here and removed,
-- so a listing of jobs/ shows live work only. (It reached ~100 folders, at
-- which point nobody could see which application was actually in flight.)
--
-- One row per FILE, holding the exact bytes. Same reasoning as leads.doc: a
-- schema that re-maps a file's contents into fields cannot round-trip it, and
-- an archive that cannot round-trip is not an archive. The bytes and sha256
-- columns are derived from content, not a second-hand copy of it, and exist so
-- that a restore can prove itself.
--
-- content IS NULL means "regenerable, deliberately not stored": PDFs are
-- deterministic output of render-pdf.mjs, so the markdown is the artifact worth
-- keeping and the PDF is rebuilt on demand. The row survives so a restore can
-- still say what was there.
--
-- Nothing rebuilds this table. Unlike leads (re-derivable from a sweep) and
-- applications (exported to YAML), an archived workspace has no other on-disk
-- source once the directory is gone — migrate.mjs must never touch it.
CREATE TABLE IF NOT EXISTS documents (
  slug        TEXT NOT NULL,
  name        TEXT NOT NULL,   -- file name within jobs/<slug>/
  content     BLOB,            -- exact bytes, or NULL when regenerable
  bytes       INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  archived_at TEXT NOT NULL,
  PRIMARY KEY (slug, name)
);
CREATE INDEX IF NOT EXISTS idx_docs_slug ON documents(slug);

-- Board productivity over time. A single audit is a snapshot; pruning a board
-- should be driven by history, so every sweep appends its counts here.
CREATE TABLE IF NOT EXISTS board_stats (
  board_id           TEXT PRIMARY KEY,
  type               TEXT,
  slug               TEXT,
  company            TEXT,
  last_swept         TEXT,
  live_postings      INTEGER DEFAULT 0,
  qualifying         INTEGER DEFAULT 0,
  solid              INTEGER DEFAULT 0,
  leads_produced     INTEGER DEFAULT 0,
  last_qualifying_at TEXT
);
`

export function openDb(file = DB_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  // FIRST, before any other statement. WAL lets readers run alongside a writer,
  // but writers still serialize, and a writer that arrives while another holds
  // the lock fails IMMEDIATELY unless the connection has been told to wait.
  // That matters now that pipeline-jobs fans out several job-worker subagents,
  // each opening its own connection.
  //
  // The ordering is not cosmetic: switching the journal mode below takes a
  // brief exclusive lock, so four processes opening the same store at once used
  // to have three of them die on `PRAGMA journal_mode = WAL` itself — before
  // any timeout they set afterwards could apply. Every write here is one short
  // statement or a small transaction, so waiting is the right answer and 5s is
  // far beyond what any of them need.
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec("PRAGMA journal_mode = WAL")
  // Each `mark` is its own process, so per-call fsync cost is what the user
  // feels: at full durability 57 sequential updates cost ~246 ms, almost all
  // of it waiting on the disk. NORMAL is the documented companion to WAL —
  // still crash-safe, and it only risks losing the last commits on an OS-level
  // crash, which for a re-derivable lead store is an acceptable trade.
  db.exec("PRAGMA synchronous = NORMAL")
  try {
    // Before SCHEMA, not after: SCHEMA creates an index on screens(source),
    // and that statement is itself what fails against the old shape.
    healScreens(db)
    db.exec(SCHEMA)
  } catch (e) {
    // An open that throws must not leave the handle behind. On Windows a
    // leaked one keeps a lock on the file, so the next thing to touch it fails
    // with EPERM and the real error is two layers down.
    db.close()
    throw e
  }
  return db
}

// The flat CREATE TABLE IF NOT EXISTS schema has exactly one blind spot: a
// table whose SHAPE changes is left alone, because it already exists. `screens`
// gained a `source` column after being built and never written to, so every
// database in existence has the old four-column version with zero rows in it.
//
// Rebuilding an empty table is not a migration — there is nothing to migrate.
// If it somehow has rows, this refuses rather than dropping them, because
// silently discarding recorded verdicts to fix a schema is the kind of repair
// that loses data. Kept deliberately narrow: it heals this one known case and
// nothing else, so it never becomes an ad-hoc migration chain.
function healScreens(db) {
  const cols = db.prepare("PRAGMA table_info(screens)").all()
  if (!cols.length) return // fresh database — SCHEMA is about to create it
  if (cols.some((c) => c.name === "source")) return
  const { c } = db.prepare("SELECT COUNT(*) c FROM screens").get()
  if (c > 0) {
    throw new Error(
      `screens holds ${c} row(s) in the pre-source schema; back up jobs/leads.db and drop the table to rebuild`,
    )
  }
  db.exec("DROP TABLE screens")
}

// --- row <-> lead object -----------------------------------------------------

export function leadToRow(lead) {
  const row = { id: lead.id, doc: JSON.stringify(lead) }
  for (const c of INDEXED) row[c] = lead[c] ?? null
  return row
}

export function rowToLead(row) {
  return JSON.parse(row.doc)
}

// --- source resolution -------------------------------------------------------

// An explicit --leads path is always honoured verbatim (that is how the tests
// point at fixtures). Otherwise prefer the database, falling back to the JSON
// store so a repo that has not migrated yet still works.
export function resolveLeadSource(explicit = null) {
  if (explicit)
    return { kind: explicit.endsWith(".db") ? "db" : "json", file: explicit }
  if (fs.existsSync(DB_PATH)) return { kind: "db", file: DB_PATH }
  return { kind: "json", file: JSON_PATH }
}

// Returns { leads: [...] } — the same shape every consumer already expects.
export function readLeadStore(explicit = null) {
  const src = resolveLeadSource(explicit)
  if (src.kind === "json") {
    if (!fs.existsSync(src.file)) return { leads: [] }
    return JSON.parse(fs.readFileSync(src.file, "utf8"))
  }
  const db = openDb(src.file)
  try {
    const rows = db.prepare("SELECT * FROM leads").all()
    return { leads: rows.map(rowToLead) }
  } finally {
    db.close()
  }
}

export function writeLeadStore(store, explicit = null) {
  const src = resolveLeadSource(explicit)
  if (src.kind === "json") {
    fs.mkdirSync(path.dirname(src.file), { recursive: true })
    fs.writeFileSync(src.file, JSON.stringify(store, null, 2) + "\n")
    return
  }
  const db = openDb(src.file)
  try {
    upsertLeads(db, store.leads ?? [])
  } finally {
    db.close()
  }
}

// --- mutations ---------------------------------------------------------------

const UPSERT = `
INSERT INTO leads (id, ${INDEXED.join(", ")}, doc)
VALUES ($id, ${INDEXED.map((c) => "$" + c).join(", ")}, $doc)
ON CONFLICT(id) DO UPDATE SET
  ${INDEXED.map((c) => `${c} = excluded.${c}`).join(",\n  ")},
  doc = excluded.doc
`

export function upsertLeads(db, leads) {
  const stmt = db.prepare(UPSERT)
  db.exec("BEGIN")
  try {
    for (const l of leads) stmt.run(leadToRow(l))
    db.exec("COMMIT")
  } catch (e) {
    db.exec("ROLLBACK")
    throw e
  }
  return leads.length
}

// The whole point of the migration: one row, not one file. json_set keeps the
// stored document in step with the denormalized status column.
export function setLeadStatus(db, id, status, notes = undefined) {
  if (notes === undefined) {
    return db
      .prepare(
        "UPDATE leads SET status = ?, doc = json_set(doc, '$.status', ?) WHERE id = ?",
      )
      .run(status, status, id).changes
  }
  return db
    .prepare(
      "UPDATE leads SET status = ?, doc = json_set(doc, '$.status', ?, '$.notes', ?) WHERE id = ?",
    )
    .run(status, status, notes, id).changes
}

// --- keywords -----------------------------------------------------------------

// Replaces the whole keyword set for a lead, so re-ingesting a posting whose
// description changed cannot leave stale terms behind.
export function setLeadKeywords(db, leadId, keywords) {
  db.prepare("DELETE FROM lead_keywords WHERE lead_id = ?").run(leadId)
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO lead_keywords (lead_id, keyword) VALUES (?, ?)",
  )
  for (const k of new Set(keywords)) stmt.run(leadId, String(k))
  return new Set(keywords).size
}

export function keywordsFor(db, leadId) {
  return db
    .prepare(
      "SELECT keyword FROM lead_keywords WHERE lead_id = ? ORDER BY keyword",
    )
    .all(leadId)
    .map((r) => r.keyword)
}

// Every lead's keywords in one query. Clustering compares each lead against
// every other one, so the per-lead keywordsFor() would be N round trips to
// answer a question the store can hand over in a single pass.
export function keywordMap(db) {
  const map = new Map()
  for (const r of db
    .prepare("SELECT lead_id, keyword FROM lead_keywords ORDER BY lead_id")
    .all()) {
    let set = map.get(r.lead_id)
    if (!set) map.set(r.lead_id, (set = new Set()))
    set.add(r.keyword)
  }
  return map
}

// Demand counts across the stored leads, optionally narrowed to one status —
// e.g. what the dismissed pile kept asking for.
export function keywordDemand(db, { status = null, limit = 50 } = {}) {
  const sql = status
    ? `SELECT k.keyword, COUNT(*) n FROM lead_keywords k
         JOIN leads l ON l.id = k.lead_id WHERE l.status = ?
         GROUP BY k.keyword ORDER BY n DESC, k.keyword LIMIT ?`
    : `SELECT keyword, COUNT(*) n FROM lead_keywords
         GROUP BY keyword ORDER BY n DESC, keyword LIMIT ?`
  return status
    ? db.prepare(sql).all(status, limit)
    : db.prepare(sql).all(limit)
}

// --- applications --------------------------------------------------------------

// The applications TABLE is the source of truth (user decision, 2026-07-29:
// applications are only ever created by scripts/applications/log-application.mjs after the
// user confirms a submission — nobody hand-edits them, so a file pretending to
// be authoritative bought nothing but a sync problem).
//
// profile/applications.yaml is now a one-way GENERATED export: written after
// every change, never read back except to bootstrap a database that does not
// exist yet. It exists because jobs/ is gitignored and this is the user's whole
// application history — a plain-text copy is cheap disaster recovery.
export function resolveApplicationSource(explicit = null) {
  if (explicit)
    return { kind: explicit.endsWith(".db") ? "db" : "yaml", file: explicit }
  if (!fs.existsSync(DB_PATH)) return { kind: "yaml", file: APPLICATIONS_PATH }
  return { kind: "db", file: DB_PATH }
}

// Always returns a plain array, the shape every consumer already expects.
export function readApplications(explicit = null) {
  const src = resolveApplicationSource(explicit)
  if (src.kind === "yaml") {
    if (!fs.existsSync(src.file)) return []
    return loadYamlFile(src.file)?.applications ?? []
  }
  const db = openDb(src.file)
  try {
    return db
      .prepare("SELECT doc FROM applications ORDER BY applied_at, slug")
      .all()
      .map((r) => JSON.parse(r.doc))
  } finally {
    db.close()
  }
}

export function deleteApplication(db, slug) {
  return db.prepare("DELETE FROM applications WHERE slug = ?").run(slug).changes
}

// Write the whole table back out as YAML. One-way: nothing reads this file
// except bootstrap, so it can be regenerated at will and never merged.
export function exportApplicationsYaml(
  db,
  file = APPLICATIONS_PATH,
  dumpYaml = null,
) {
  const applications = db
    .prepare("SELECT doc FROM applications ORDER BY applied_at, slug")
    .all()
    .map((r) => JSON.parse(r.doc))
  const header =
    "# APPLICATION LOG — GENERATED, do not edit.\n" +
    "# Source of truth is the `applications` table in jobs/leads.db.\n" +
    "# Regenerate: node scripts/applications/applications.mjs export\n" +
    "# Entries are only ever created by scripts/applications/log-application.mjs, after the\n" +
    "# user confirms they submitted the application.\n"
  const body = dumpYaml
    ? dumpYaml({ applications })
    : JSON.stringify({ applications }, null, 2)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, header + body, "utf8")
  return applications.length
}

// Save an application to the store of record, then refresh the export.
// `writeApplication` is the ONLY path that creates or changes an application;
// the "user confirmed they applied" rule still lives in the callers.
export function writeApplication(application, dumpYaml, dbFile = DB_PATH) {
  const db = openDb(dbFile)
  try {
    upsertApplications(db, [application])
    if (path.resolve(dbFile) === path.resolve(DB_PATH)) {
      exportApplicationsYaml(db, APPLICATIONS_PATH, dumpYaml)
    }
    return true
  } finally {
    db.close()
  }
}

export function upsertApplications(db, applications) {
  const stmt = db.prepare(`
    INSERT INTO applications (slug, company, title, applied_at, status, doc)
    VALUES ($slug, $company, $title, $applied_at, $status, $doc)
    ON CONFLICT(slug) DO UPDATE SET
      company = excluded.company,
      title = excluded.title,
      applied_at = excluded.applied_at,
      status = excluded.status,
      doc = excluded.doc`)
  db.exec("BEGIN")
  try {
    for (const a of applications) {
      stmt.run({
        slug: a.slug,
        company: a.company ?? null,
        title: a.title ?? null,
        applied_at: a.applied_at ?? null,
        status: a.status ?? null,
        doc: JSON.stringify(a),
      })
    }
    db.exec("COMMIT")
  } catch (e) {
    db.exec("ROLLBACK")
    throw e
  }
  return applications.length
}

// Merge a partial update into one application without rewriting the rest.
export function updateApplication(db, slug, patch) {
  const row = db
    .prepare("SELECT doc FROM applications WHERE slug = ?")
    .get(slug)
  if (!row) return 0
  const merged = { ...JSON.parse(row.doc), ...patch }
  upsertApplications(db, [merged])
  return 1
}

// --- archived workspaces --------------------------------------------------

// Replaces the whole archive for a slug in one transaction, so a re-archive
// after a restore-and-edit cannot leave rows for files that no longer exist.
// Callers pass { name, content: Uint8Array|null, bytes, sha256 }.
export function writeDocuments(db, slug, files, at = null) {
  const archived_at = at ?? new Date().toISOString()
  const del = db.prepare("DELETE FROM documents WHERE slug = ?")
  const ins = db.prepare(
    `INSERT INTO documents (slug, name, content, bytes, sha256, archived_at)
     VALUES ($slug, $name, $content, $bytes, $sha256, $archived_at)`,
  )
  db.exec("BEGIN")
  try {
    del.run(slug)
    for (const f of files) {
      ins.run({
        slug,
        name: f.name,
        content: f.content ?? null,
        bytes: f.bytes,
        sha256: f.sha256,
        archived_at,
      })
    }
    db.exec("COMMIT")
  } catch (e) {
    db.exec("ROLLBACK")
    throw e
  }
  return files.length
}

export function readDocuments(db, slug) {
  return db
    .prepare(
      "SELECT name, content, bytes, sha256, archived_at FROM documents WHERE slug = ? ORDER BY name",
    )
    .all(slug)
}

// Summary only — deliberately does not select `content`, so listing an archive
// never pulls a megabyte of PDFs and markdown into memory to count them.
export function listDocuments(db) {
  return db
    .prepare(
      `SELECT slug,
              COUNT(*) files,
              SUM(bytes) bytes,
              SUM(content IS NULL) regenerable,
              MAX(archived_at) archived_at
         FROM documents GROUP BY slug ORDER BY archived_at DESC, slug`,
    )
    .all()
}

export function deleteDocuments(db, slug) {
  return db.prepare("DELETE FROM documents WHERE slug = ?").run(slug).changes
}

// --- screens ----------------------------------------------------------------

export const SCREEN_SOURCES = new Set(["mechanical", "model"])

// One screen = { lead_id, source, verdict, ...anything else the screen emits }.
// The extra fields ride along in doc untouched.
export function recordScreens(db, screens) {
  const stmt = db.prepare(
    `INSERT INTO screens (lead_id, source, verdict, screened_at, doc)
     VALUES ($lead_id, $source, $verdict, $screened_at, $doc)
     ON CONFLICT(lead_id, source) DO UPDATE SET
       verdict = excluded.verdict,
       screened_at = excluded.screened_at,
       doc = excluded.doc`,
  )
  db.exec("BEGIN")
  try {
    for (const s of screens) {
      if (!SCREEN_SOURCES.has(s.source))
        throw new Error(`unknown screen source: ${s.source}`)
      const screened_at = s.screened_at ?? new Date().toISOString()
      stmt.run({
        lead_id: s.lead_id,
        source: s.source,
        verdict: s.verdict,
        screened_at,
        doc: JSON.stringify({ ...s, screened_at }),
      })
    }
    db.exec("COMMIT")
  } catch (e) {
    db.exec("ROLLBACK")
    throw e
  }
  return screens.length
}

export function recordScreen(db, screen) {
  return recordScreens(db, [screen])
}

export function readScreens(db, { source = null } = {}) {
  const rows = source
    ? db.prepare("SELECT doc FROM screens WHERE source = ?").all(source)
    : db.prepare("SELECT doc FROM screens").all()
  return rows.map((r) => JSON.parse(r.doc))
}

// lead_id -> verdict document, for the "have we already paid for this?" check.
export function screenIndex(db, source) {
  const map = new Map()
  for (const s of readScreens(db, { source })) map.set(s.lead_id, s)
  return map
}

export function recordBoardStats(db, row) {
  db.prepare(
    `INSERT INTO board_stats
       (board_id, type, slug, company, last_swept, live_postings, qualifying, solid, leads_produced, last_qualifying_at)
     VALUES ($board_id, $type, $slug, $company, $last_swept, $live_postings, $qualifying, $solid, $leads_produced, $last_qualifying_at)
     ON CONFLICT(board_id) DO UPDATE SET
       last_swept = excluded.last_swept,
       live_postings = excluded.live_postings,
       qualifying = excluded.qualifying,
       solid = excluded.solid,
       leads_produced = board_stats.leads_produced + excluded.leads_produced,
       last_qualifying_at = CASE
         WHEN excluded.solid > 0 THEN excluded.last_swept
         ELSE board_stats.last_qualifying_at END`,
  ).run({
    board_id: row.board_id,
    type: row.type ?? null,
    slug: row.slug ?? null,
    company: row.company ?? null,
    last_swept: row.last_swept ?? new Date().toISOString(),
    live_postings: row.live_postings ?? 0,
    qualifying: row.qualifying ?? 0,
    solid: row.solid ?? 0,
    leads_produced: row.leads_produced ?? 0,
    // Must be decided here, not only in the ON CONFLICT branch: on a board's
    // FIRST sweep there is no conflict, so a CASE in the update clause never
    // runs and a productive board was being recorded as never having yielded.
    last_qualifying_at:
      row.last_qualifying_at ??
      ((row.solid ?? 0) > 0
        ? (row.last_swept ?? new Date().toISOString())
        : null),
  })
}
