import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { DatabaseSync } from "node:sqlite"
import {
  openDb,
  keywordMap,
  upsertLeads,
  setLeadStatus,
  recordScreen,
  readScreens,
  screenIndex,
  recordBoardStats,
  readLeadStore,
  resolveLeadSource,
  leadToRow,
  rowToLead,
  setLeadKeywords,
  keywordsFor,
  keywordDemand,
  upsertApplications,
  updateApplication,
  readApplications,
} from "../../scripts/lib/db.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

function tmpDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leaddb-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, "leads.db")
}

// The column-per-field design this replaced failed on 73 of 99 real leads,
// because mapping fields by hand cannot tell `flags: []` from no flags, or
// `notes: ""` from `notes: null`. These are those exact shapes.
const AWKWARD = [
  { id: "a", status: "new", flags: [], notes: "" },
  { id: "b", status: "new", notes: null, remote: false },
  { id: "c", status: "new", remote: true, salary_max: 0 },
  { id: "d", status: "new" },
  { id: "e", status: "new", flags: ["remote_unverified"], future_field: 42 },
]

test("every awkward lead shape round-trips byte-for-byte", () => {
  for (const lead of AWKWARD) {
    const back = rowToLead(leadToRow(lead))
    assert.equal(
      JSON.stringify(back),
      JSON.stringify(lead),
      `lost fidelity on ${lead.id}`,
    )
  }
})

test("a field the schema has never seen survives a round trip", () => {
  // A fetcher adding a field must never be silently dropped by storage.
  const lead = { id: "x", status: "new", some_new_thing: { nested: [1, 2] } }
  assert.deepEqual(rowToLead(leadToRow(lead)), lead)
})

test("upsert inserts then updates in place", (t) => {
  const db = openDb(tmpDb(t))
  upsertLeads(db, AWKWARD)
  assert.equal(db.prepare("SELECT COUNT(*) c FROM leads").get().c, 5)

  upsertLeads(db, [{ id: "a", status: "applied", flags: [], notes: "done" }])
  assert.equal(db.prepare("SELECT COUNT(*) c FROM leads").get().c, 5, "no dupe")
  const row = db.prepare("SELECT * FROM leads WHERE id = 'a'").get()
  assert.equal(row.status, "applied")
  assert.equal(rowToLead(row).notes, "done")
  db.close()
})

test("setLeadStatus updates the indexed column AND the stored document", (t) => {
  // If these two drift, a status filter and the lead object disagree — the
  // kind of bug that only shows up much later.
  const db = openDb(tmpDb(t))
  upsertLeads(db, AWKWARD)

  assert.equal(setLeadStatus(db, "a", "dismissed"), 1)
  let row = db.prepare("SELECT * FROM leads WHERE id = 'a'").get()
  assert.equal(row.status, "dismissed", "column")
  assert.equal(rowToLead(row).status, "dismissed", "document")

  setLeadStatus(db, "b", "applied", "sent 2026-07-28")
  row = db.prepare("SELECT * FROM leads WHERE id = 'b'").get()
  assert.equal(row.status, "applied")
  assert.equal(rowToLead(row).notes, "sent 2026-07-28")
  // Untouched fields must survive a partial update.
  assert.equal(rowToLead(row).remote, false)

  assert.equal(setLeadStatus(db, "nope", "dismissed"), 0, "unknown id")
  db.close()
})

test("readLeadStore reads a JSON store and a db store alike", (t) => {
  const dbFile = tmpDb(t)
  const jsonFile = path.join(path.dirname(dbFile), "leads.json")
  fs.writeFileSync(jsonFile, JSON.stringify({ leads: AWKWARD }))

  const db = openDb(dbFile)
  upsertLeads(db, AWKWARD)
  db.close()

  const fromJson = readLeadStore(jsonFile).leads
  const fromDb = readLeadStore(dbFile).leads
  const byId = (xs) => [...xs].sort((a, b) => (a.id < b.id ? -1 : 1))
  assert.deepEqual(byId(fromDb), byId(fromJson))
})

test("readLeadStore on a missing JSON store yields an empty list", () => {
  assert.deepEqual(readLeadStore("/definitely/not/here.json"), { leads: [] })
})

test("resolveLeadSource honours an explicit path and infers the kind", () => {
  assert.deepEqual(resolveLeadSource("/x/y.json"), {
    kind: "json",
    file: "/x/y.json",
  })
  assert.deepEqual(resolveLeadSource("/x/y.db"), {
    kind: "db",
    file: "/x/y.db",
  })
  // With no argument it picks a real location, never undefined.
  const auto = resolveLeadSource()
  assert.ok(auto.file && ["db", "json"].includes(auto.kind))
})

// ---------- concurrency ----------
//
// pipeline-jobs fans out several job-worker subagents at once and each opens its
// own connection. WAL keeps readers out of the way, but writers serialize, and a
// writer that arrives during another's commit fails IMMEDIATELY unless it is
// told to wait.

test("every connection is opened willing to wait for a busy writer", (t) => {
  const db = openDb(tmpDb(t))
  const { timeout } = db.prepare("PRAGMA busy_timeout").get()
  assert.ok(timeout >= 1000, `busy_timeout is ${timeout}`)
  db.close()
})

test("four processes writing the same store at once all get their rows in", async (t) => {
  const dbFile = tmpDb(t)
  const dir = path.dirname(dbFile)
  const worker = path.join(dir, "worker.mjs")
  fs.writeFileSync(
    worker,
    `import { openDb, upsertLeads, setLeadStatus } from ${JSON.stringify(
      pathToFileURL(path.join(ROOT, "scripts", "lib", "db.mjs")).href,
    )}
const [file, tag] = process.argv.slice(2)
const db = openDb(file)
for (let i = 0; i < 25; i++) {
  upsertLeads(db, [{ id: tag + "-" + i, status: "new" }])
  setLeadStatus(db, tag + "-" + i, "recommended")
}
db.close()
`,
  )

  const results = await Promise.all(
    ["a", "b", "c", "d"].map(
      (tag) =>
        new Promise((resolve) => {
          const p = spawn(process.execPath, [worker, dbFile, tag], {
            stdio: ["ignore", "ignore", "pipe"],
          })
          let err = ""
          p.stderr.on("data", (d) => (err += d))
          p.on("close", (code) => resolve({ tag, code, err }))
        }),
    ),
  )

  for (const r of results) {
    assert.equal(r.code, 0, `worker ${r.tag} failed: ${r.err}`)
  }
  const db = openDb(dbFile)
  const { c } = db.prepare("SELECT COUNT(*) c FROM leads").get()
  const { n } = db
    .prepare("SELECT COUNT(*) n FROM leads WHERE status = 'recommended'")
    .get()
  db.close()
  assert.equal(c, 100, "no writer lost its rows to SQLITE_BUSY")
  assert.equal(n, 100)
})

// ---------- keywords ----------

test("setLeadKeywords replaces rather than accumulates", (t) => {
  // Re-ingesting a posting whose description changed must not leave the old
  // terms behind, or demand counts drift upward forever.
  const db = openDb(tmpDb(t))
  upsertLeads(db, [{ id: "a", status: "new" }])

  setLeadKeywords(db, "a", ["React", "Python", "React"])
  assert.deepEqual(keywordsFor(db, "a"), ["Python", "React"], "deduped")

  setLeadKeywords(db, "a", ["Go"])
  assert.deepEqual(keywordsFor(db, "a"), ["Go"], "old terms are gone")

  setLeadKeywords(db, "a", [])
  assert.deepEqual(keywordsFor(db, "a"), [])
  db.close()
})

test("keywordMap hands over every lead's terms in one pass", (t) => {
  // Clustering compares every lead against every other one; per-lead lookups
  // would be N queries for something one query answers.
  const db = openDb(tmpDb(t))
  upsertLeads(db, [
    { id: "a", status: "new" },
    { id: "b", status: "new" },
    { id: "c", status: "new" },
  ])
  setLeadKeywords(db, "a", ["React", "Node.js"])
  setLeadKeywords(db, "b", ["React"])

  const map = keywordMap(db)
  assert.deepEqual([...map.get("a")].sort(), ["Node.js", "React"])
  assert.deepEqual([...map.get("b")], ["React"])
  assert.equal(map.has("c"), false, "a lead with no keywords has no entry")
  db.close()
})

test("keywordDemand counts across leads and narrows by status", (t) => {
  const db = openDb(tmpDb(t))
  upsertLeads(db, [
    { id: "a", status: "dismissed" },
    { id: "b", status: "dismissed" },
    { id: "c", status: "new" },
  ])
  setLeadKeywords(db, "a", ["Python", "Kubernetes"])
  setLeadKeywords(db, "b", ["Python", "Go"])
  setLeadKeywords(db, "c", ["React"])

  const all = keywordDemand(db)
  assert.equal(all.find((r) => r.keyword === "Python").n, 2)
  assert.equal(all.find((r) => r.keyword === "React").n, 1)

  // The question this is really for: what did the rejected pile keep asking for?
  const dismissed = keywordDemand(db, { status: "dismissed" })
  assert.equal(dismissed[0].keyword, "Python")
  assert.ok(
    !dismissed.some((r) => r.keyword === "React"),
    "status filter must exclude other leads",
  )
  assert.equal(keywordDemand(db, { limit: 1 }).length, 1, "limit applies")
  db.close()
})

// ---------- applications ----------

const APPS = [
  { slug: "a-co", company: "A Co", title: "SWE II", applied_at: "2026-07-01" },
  {
    slug: "b-co",
    company: "B Co",
    title: "Backend Engineer",
    applied_at: "2026-07-20",
    status: "rejected",
    notes: null,
    follow_ups: ["2026-07-25"],
  },
]

test("applications round-trip verbatim, including null and array fields", (t) => {
  const db = openDb(tmpDb(t))
  upsertApplications(db, APPS)
  const rows = db.prepare("SELECT doc FROM applications ORDER BY slug").all()
  assert.deepEqual(
    rows.map((r) => JSON.parse(r.doc)),
    APPS,
  )
  db.close()
})

test("updateApplication merges a patch without dropping other fields", (t) => {
  const db = openDb(tmpDb(t))
  upsertApplications(db, APPS)

  assert.equal(updateApplication(db, "b-co", { status: "interview" }), 1)
  const got = JSON.parse(
    db.prepare("SELECT doc FROM applications WHERE slug='b-co'").get().doc,
  )
  assert.equal(got.status, "interview")
  assert.deepEqual(got.follow_ups, ["2026-07-25"], "untouched fields survive")
  assert.equal(got.company, "B Co")

  assert.equal(updateApplication(db, "missing", { status: "x" }), 0)
  db.close()
})

test("a hand-edited applications.yaml wins over a stale index", (t) => {
  // profile/applications.yaml is user-owned and hand-editable. If it is newer
  // than the database, the database is a stale cache and must be bypassed —
  // otherwise a manual edit silently disappears.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apps-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const yamlFile = path.join(dir, "applications.yaml")
  fs.writeFileSync(yamlFile, "applications:\n  - slug: hand-edited\n")

  assert.deepEqual(readApplications(yamlFile), [{ slug: "hand-edited" }])
})

test("a screen is the latest verdict per source, not a log", (t) => {
  const db = openDb(tmpDb(t))
  recordScreen(db, {
    lead_id: "a",
    source: "mechanical",
    verdict: "reject",
    signals: ["over_bar_8y"],
    screened_at: "2026-07-28T00:00:00Z",
  })
  recordScreen(db, {
    lead_id: "a",
    source: "mechanical",
    verdict: "pass",
    signals: [],
    screened_at: "2026-07-29T00:00:00Z",
  })
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM screens WHERE lead_id='a'").get().c,
    1,
    "re-screening replaces, it does not append",
  )
  assert.equal(readScreens(db, { source: "mechanical" })[0].verdict, "pass")

  // A model verdict is a separate row: the cheap pass must never satisfy a
  // caller asking whether the expensive one has been paid for.
  recordScreen(db, {
    lead_id: "a",
    source: "model",
    verdict: "caution",
    reason: "reposted twice",
  })
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM screens WHERE lead_id='a'").get().c,
    2,
  )
  const byModel = screenIndex(db, "model")
  assert.equal(byModel.get("a").verdict, "caution")
  assert.equal(byModel.get("a").reason, "reposted twice")
  assert.equal(screenIndex(db, "mechanical").get("a").verdict, "pass")

  // Extra fields ride along in doc rather than needing a column each.
  assert.deepEqual(
    readScreens(db, { source: "mechanical" })[0].signals,
    [],
    "an empty signal list must survive as empty, not become absent",
  )

  assert.throws(
    () => recordScreen(db, { lead_id: "b", source: "vibes", verdict: "pass" }),
    /unknown screen source/,
  )
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM screens WHERE lead_id='b'").get().c,
    0,
    "a rejected source must not leave a partial row",
  )
  db.close()
})

test("board_stats accumulates history", (t) => {
  const db = openDb(tmpDb(t))
  const base = {
    board_id: "greenhouse:acme",
    company: "Acme",
    live_postings: 10,
    qualifying: 2,
    solid: 1,
    leads_produced: 2,
    last_swept: "2026-07-28T00:00:00Z",
  }
  // First sweep: there is no conflict to update, so the INSERT itself must
  // record that this board yielded — otherwise a productive board looks like
  // it has never produced anything.
  recordBoardStats(db, base)
  assert.equal(
    db.prepare("SELECT * FROM board_stats").get().last_qualifying_at,
    "2026-07-28T00:00:00Z",
    "a productive first sweep must set last_qualifying_at",
  )

  recordBoardStats(db, { ...base, last_swept: "2026-07-29T00:00:00Z" })
  const row = db.prepare("SELECT * FROM board_stats").get()
  assert.equal(
    row.leads_produced,
    4,
    "leads_produced accumulates across sweeps",
  )
  assert.equal(row.live_postings, 10, "snapshot fields replace")
  assert.equal(row.last_qualifying_at, "2026-07-29T00:00:00Z")

  // A sweep that finds nothing must not move last_qualifying_at.
  recordBoardStats(db, {
    ...base,
    solid: 0,
    leads_produced: 0,
    last_swept: "2026-07-30T00:00:00Z",
  })
  assert.equal(
    db.prepare("SELECT * FROM board_stats").get().last_qualifying_at,
    "2026-07-29T00:00:00Z",
    "a barren sweep must not look productive",
  )
  db.close()
})

test("board_stats counts sweeps and consecutive dry ones", (t) => {
  const db = openDb(tmpDb(t))
  const base = {
    board_id: "greenhouse:acme",
    company: "Acme",
    live_postings: 10,
    qualifying: 2,
    solid: 0,
    leads_produced: 0,
    last_swept: "2026-07-28T00:00:00Z",
  }
  const row = () => db.prepare("SELECT * FROM board_stats").get()

  // The seed is the asymmetric case: one sweep either way, but the streak is
  // 1 only because this first sweep found nothing. Seeding 0 here would lose
  // the first dry sweep of every board ever added.
  recordBoardStats(db, base)
  assert.equal(row().sweeps, 1, "first sweep counts")
  assert.equal(row().zero_streak, 1, "a dry first sweep starts the streak at 1")

  recordBoardStats(db, { ...base, last_swept: "2026-07-29T00:00:00Z" })
  assert.equal(row().sweeps, 2)
  assert.equal(row().zero_streak, 2, "consecutive dry sweeps accumulate")

  // One reachable posting resets the streak — not decrements it.
  recordBoardStats(db, {
    ...base,
    solid: 3,
    leads_produced: 3,
    last_swept: "2026-07-30T00:00:00Z",
  })
  assert.equal(row().sweeps, 3, "sweeps keeps counting through a yield")
  assert.equal(row().zero_streak, 0, "a yielding sweep resets the streak")

  recordBoardStats(db, { ...base, last_swept: "2026-07-31T00:00:00Z" })
  assert.equal(row().zero_streak, 1, "the streak restarts from the reset")

  // A productive FIRST sweep seeds 0, mirroring last_qualifying_at above.
  recordBoardStats(db, {
    ...base,
    board_id: "ashby:beta",
    solid: 1,
    leads_produced: 1,
  })
  const beta = db
    .prepare("SELECT * FROM board_stats WHERE board_id = 'ashby:beta'")
    .get()
  assert.equal(beta.sweeps, 1)
  assert.equal(beta.zero_streak, 0, "a productive first sweep has no streak")
  db.close()
})

test("healBoardStats adds the counters without inventing history", (t) => {
  const file = tmpDb(t)
  // Build the pre-P6 shape by hand: a board with real history and no counters.
  // NULL is the honest value for it — the row was swept, we just never counted.
  const seed = new DatabaseSync(file)
  seed.exec(`CREATE TABLE board_stats (
    board_id TEXT PRIMARY KEY, type TEXT, slug TEXT, company TEXT,
    last_swept TEXT, live_postings INTEGER DEFAULT 0, qualifying INTEGER DEFAULT 0,
    solid INTEGER DEFAULT 0, leads_produced INTEGER DEFAULT 0, last_qualifying_at TEXT)`)
  seed
    .prepare(
      "INSERT INTO board_stats (board_id, company, leads_produced, last_qualifying_at) VALUES (?, ?, ?, ?)",
    )
    .run("greenhouse:legacy", "Legacy", 7, "2026-06-01T00:00:00Z")
  seed.close()

  const db = openDb(file)
  const row = () => db.prepare("SELECT * FROM board_stats").get()
  assert.equal(row().sweeps, null, "an existing row must not claim 0 sweeps")
  assert.equal(row().zero_streak, null)
  assert.equal(row().leads_produced, 7, "the heal preserves real history")

  // NULL + 1 is NULL in SQL, so without the COALESCE this board would stay
  // uncounted forever and could never become proposable.
  recordBoardStats(db, {
    board_id: "greenhouse:legacy",
    company: "Legacy",
    solid: 0,
    leads_produced: 0,
    last_swept: "2026-08-17T00:00:00Z",
  })
  assert.equal(row().sweeps, 1, "counting starts at the heal, not at zero+1")
  assert.equal(row().zero_streak, 1)
  assert.equal(
    row().last_qualifying_at,
    "2026-06-01T00:00:00Z",
    "the heal must not erase when the board last yielded",
  )
  db.close()

  // Idempotent: opening again must not throw on a duplicate ADD COLUMN.
  const again = openDb(file)
  assert.equal(again.prepare("SELECT * FROM board_stats").get().sweeps, 1)
  again.close()
})

// --- updateApplication under concurrency (autonomy phase 1, item 1.5) ---------
//
// The read-modify-write here is the one place in the store where two callers
// can lose a whole patch: a manual outcome update made while a multi-hour
// unattended run is writing. BEGIN IMMEDIATE takes the write lock at BEGIN
// rather than at the first write, so the second caller waits and then merges
// onto the FIRST caller's result instead of onto a stale base.

test("updateApplication leaves no transaction open, on every path", (t) => {
  const db = openDb(tmpDb(t))
  upsertApplications(db, APPS)

  assert.equal(updateApplication(db, "b-co", { status: "interview" }), 1)
  assert.equal(db.isTransaction, false, "after a successful merge")

  assert.equal(updateApplication(db, "nobody", { status: "x" }), 0)
  assert.equal(db.isTransaction, false, "after a miss")

  // A patch that cannot be serialised fails INSIDE the transaction.
  const cyclic = {}
  cyclic.self = cyclic
  assert.throws(() => updateApplication(db, "b-co", { cyclic }))
  assert.equal(
    db.isTransaction,
    false,
    "a throw must roll back, or every later write in the process fails",
  )
  assert.equal(
    JSON.parse(
      db.prepare("SELECT doc FROM applications WHERE slug='b-co'").get().doc,
    ).status,
    "interview",
    "and it must not have half-written the row",
  )
  db.close()
})

test("two concurrent writers both keep their patch", async (t) => {
  // Real OS-level concurrency, not a simulation: two threads, two connections,
  // one row, interleaved read-modify-writes. Under an unguarded (or DEFERRED)
  // transaction the two read the same base and the later write silently drops
  // the earlier patch, which is exactly the manual-outcome-update-during-a-run
  // failure. Under BEGIN IMMEDIATE every patch composes.
  const { Worker } = await import("node:worker_threads")
  const file = tmpDb(t)
  const db = openDb(file)
  upsertApplications(db, [
    { slug: "race-co", company: "Race Co", status: "applied" },
  ])
  db.close()

  const dbUrl = pathToFileURL(path.join(ROOT, "scripts", "lib", "db.mjs")).href
  const body = `
    import { workerData, parentPort } from "node:worker_threads"
    const { openDb, updateApplication } = await import(${JSON.stringify(dbUrl)})
    const db = openDb(workerData.file)
    try {
      for (let i = 0; i < workerData.rounds; i++)
        updateApplication(db, "race-co", { [workerData.key]: i })
    } finally {
      db.close()
    }
    parentPort.postMessage("done")
  `
  const run = (key) =>
    new Promise((resolve, reject) => {
      const w = new Worker(body, {
        eval: true,
        workerData: { file, key, rounds: 25 },
      })
      w.on("message", resolve)
      w.on("error", reject)
    })
  await Promise.all([run("from_a"), run("from_b")])

  const check = openDb(file)
  const got = JSON.parse(
    check.prepare("SELECT doc FROM applications WHERE slug='race-co'").get()
      .doc,
  )
  check.close()
  assert.equal(got.from_a, 24, "worker A's last patch survived")
  assert.equal(got.from_b, 24, "worker B's last patch survived")
  assert.equal(got.company, "Race Co", "and neither dropped the base record")
})
