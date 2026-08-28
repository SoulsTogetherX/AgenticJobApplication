// The lead store's read-modify-write is serialized by LEADS_LOCK — see
// src/lib/lock.mjs's header, which names find-jobs.mjs's cmdSearch (via
// ingest()) as the one caller it was built for, and this file as the reason:
// `writeLeadStore` upserts every lead object it is given, doc column and
// all, so committing a copy read before a concurrent writer's commit
// clobbers whatever that writer changed in the interim — a repost counter,
// a screening verdict, another writer's brand-new lead.
//
// This test demonstrates the loss is actually prevented, not just that the
// lock exists: many concurrent `import` runs each report a repost sighting
// against the SAME pre-existing lead (dedupeLeads' repost path, which does
// not depend on screening) and each insert one lead unique to that writer.
// Every sighting and every insert must survive.
//
// CANARIED 2026-08-01: with the `withLock(...)` wrapper in
// src/leads/find-jobs.mjs's ingest() temporarily replaced by a direct,
// unlocked call to the same callback, this test failed — base.repost_count
// landed well under WRITERS (lost increments) on every trial. Restored
// before commit; see this agent's report for the exact numbers.
//
// Sized by the same reasoning tests/lib/lock.test.mjs documents: a handful
// of writers does not reliably collide. 6 writers here was invisible in a
// throwaway run against the unlocked build (0 lost); 24 was not (see the
// canary numbers in the report). This uses 24 for margin.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { openDb, upsertLeads, readLeadStore } from "../../src/lib/db.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const CLI = path.join(ROOT, "src", "leads", "find-jobs.mjs")

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aj-leadslock-"))
}

const BASE_ID = "base-target-1"

function fixture() {
  const dir = tmpdir()
  const dbFile = path.join(dir, "leads.db")
  const db = openDb(dbFile)
  try {
    upsertLeads(db, [
      {
        id: BASE_ID,
        status: "new",
        company: "TargetCo",
        title: "Software Engineer",
        location: "Remote",
        url: "https://x.example/target",
        posted_at: new Date().toISOString(),
        found_at: new Date().toISOString(),
        repost_count: 0,
        flags: [],
        notes: "",
      },
    ])
  } finally {
    db.close()
  }
  return { dir, dbFile }
}

// One writer's payload: a repost sighting of the pre-existing lead (same
// company+title, a fresh id — dedupeLeads treats this purely as evidence,
// never as a new row) plus one brand-new lead unique to this writer. Both
// pass screening trivially: no description means bodyDisqualifiers short
// circuits `ok:true`, "Software Engineer"/"Remote" clear passesLimits.
function writerFile(dir, i) {
  const now = new Date().toISOString()
  const file = path.join(dir, `writer-${i}.json`)
  fs.writeFileSync(
    file,
    JSON.stringify([
      {
        id: `target-repost-${i}`,
        company: "TargetCo",
        title: "Software Engineer",
        location: "Remote",
        url: `https://x.example/target-repost-${i}`,
        posted_at: now,
      },
      {
        id: `unique-${i}`,
        company: `UniqueCo${i}`,
        title: "Software Engineer",
        location: "Remote",
        url: `https://x.example/unique-${i}`,
        posted_at: now,
      },
    ]),
  )
  return file
}

function runImport(dbFile, file) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CLI, "import", file, "--no-enrich", "--leads", dbFile],
      { cwd: ROOT },
      (err, stdout, stderr) =>
        err ? reject(new Error(stderr || err.message)) : resolve(stdout),
    )
  })
}

const WRITERS = 24

test(`${WRITERS} concurrent 'import' runs lose no repost counters and no new leads`, async () => {
  const { dir, dbFile } = fixture()
  const files = Array.from({ length: WRITERS }, (_, i) => writerFile(dir, i))

  await Promise.all(files.map((f) => runImport(dbFile, f)))

  const { leads } = readLeadStore(dbFile)
  const base = leads.find((l) => l.id === BASE_ID)
  assert.ok(base, "the pre-existing lead itself must survive")
  assert.equal(
    base.repost_count,
    WRITERS,
    `expected ${WRITERS} repost sightings recorded, got ${base.repost_count} — ` +
      `some writer's increment was clobbered by another writer's stale commit`,
  )

  const missing = []
  for (let i = 0; i < WRITERS; i++) {
    if (!leads.some((l) => l.id === `unique-${i}`)) missing.push(i)
  }
  assert.deepEqual(
    missing,
    [],
    `writer(s) ${missing.join(", ")} inserted a new lead that is missing from the final store`,
  )

  assert.equal(
    leads.length,
    1 + WRITERS,
    `expected 1 base lead + ${WRITERS} unique leads, got ${leads.length} total ` +
      `(reposts must never be inserted as their own row)`,
  )
})

test("a single 'import' run still writes normally (no lock left behind)", async () => {
  const { dir, dbFile } = fixture()
  const file = writerFile(dir, "solo")
  await runImport(dbFile, file)
  const { leads } = readLeadStore(dbFile)
  assert.ok(leads.some((l) => l.id === "unique-solo"))
  assert.equal(leads.find((l) => l.id === BASE_ID).repost_count, 1)
  assert.equal(
    fs.existsSync(`${path.resolve(dbFile)}.lock`),
    false,
    "the lock must not survive a normal run",
  )
})
