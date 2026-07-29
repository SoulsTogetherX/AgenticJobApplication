import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  openDb,
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
