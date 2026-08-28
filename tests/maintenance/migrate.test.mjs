// migrate.mjs's handling of the two tables that have NO on-disk source.
//
// `documents` is never touched: once archive.mjs has folded jobs/<slug>/ into
// it and removed the directory, the row is the only copy of those bytes.
// `auto_queue` is run state — nothing outside the database ever held it, so
// "rebuild" can only honestly mean "ensure it exists" and, on request, "clear
// what a dead process left behind".
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  openDb,
  enqueueAutoJobs,
  claimAutoJob,
  setAutoJobState,
  readAutoQueue,
  writeDocuments,
  listDocuments,
} from "#lib/db.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aj-migrate-"))
  const handles = []
  t.after(() => {
    for (const d of handles) {
      try {
        d.close()
      } catch {
        /* already closed */
      }
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* a leaked Windows lock must not fail a passing test */
    }
  })
  const dbFile = path.join(dir, "leads.db")
  // A path that does not exist: migrate must not read the real
  // profile/applications.yaml, which is the user's file.
  const appsYaml = path.join(dir, "applications.yaml")
  return {
    dir,
    dbFile,
    open() {
      const d = openDb(dbFile)
      handles.push(d)
      return d
    },
    run(extra = []) {
      return spawnSync(
        process.execPath,
        [
          path.join(ROOT, "src", "maintenance", "migrate.mjs"),
          "--db",
          dbFile,
          "--applications",
          appsYaml,
          ...extra,
        ],
        { cwd: ROOT, encoding: "utf8" },
      )
    },
  }
}

test("migrate creates auto_queue on a database that predates it, and reports it", (t) => {
  const s = sandbox(t)
  const res = s.run()
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /auto_queue:\s+0 row\(s\) of run state \(empty\)/)

  const db = s.open()
  assert.deepEqual(readAutoQueue(db), [], "the table exists and is queryable")
})

test("migrate reports the queue's state breakdown without changing it", (t) => {
  const s = sandbox(t)
  const db = s.open()
  enqueueAutoJobs(db, [{ slug: "a" }, { slug: "b" }, { slug: "c" }])
  claimAutoJob(db, "a", { run_id: "r" })
  setAutoJobState(db, "a", "submitted", { run_id: "r" })
  db.close()

  const res = s.run()
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /auto_queue:\s+3 row\(s\)/)
  assert.match(res.stdout, /queued=2/)
  assert.match(res.stdout, /submitted=1/)

  const after = s.open()
  assert.equal(readAutoQueue(after).length, 3, "reporting is not clearing")
})

test("--reset-queue clears run state a dead process left holding the queue", (t) => {
  const s = sandbox(t)
  const db = s.open()
  enqueueAutoJobs(db, [{ slug: "a" }, { slug: "b" }])
  claimAutoJob(db, "a", { run_id: "dead" })
  db.close()

  const res = s.run(["--reset-queue"])
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /2 cleared by --reset-queue/)
  assert.deepEqual(readAutoQueue(s.open()), [])
})

test("--reset-queue REFUSES while a click is unaccounted for", (t) => {
  const s = sandbox(t)
  const db = s.open()
  enqueueAutoJobs(db, [{ slug: "clicked" }, { slug: "waiting" }])
  claimAutoJob(db, "clicked", { run_id: "dead" })
  setAutoJobState(db, "clicked", "attempted", { run_id: "dead" })
  db.close()

  const res = s.run(["--reset-queue"])
  assert.equal(res.status, 1)
  assert.match(res.stderr, /reset-queue refused/)
  assert.match(res.stderr, /clicked/)
  assert.match(res.stderr, /may already have reached the employer/)

  assert.equal(
    readAutoQueue(s.open()).length,
    2,
    "and it cleared nothing on the way out — erasing the attempted row would " +
      "disarm the orphan brake",
  )
})

test("migrate never touches the documents table — it has no other copy", (t) => {
  const s = sandbox(t)
  const db = s.open()
  writeDocuments(db, "archived-co", [
    {
      name: "resume.md",
      content: Buffer.from("# archived\n"),
      bytes: 11,
      sha256: "f".repeat(64),
    },
  ])
  db.close()

  assert.equal(s.run().status, 0)
  assert.equal(s.run(["--reset-queue"]).status, 0)

  const after = s.open()
  const listed = listDocuments(after)
  assert.equal(listed.length, 1)
  assert.equal(listed[0].slug, "archived-co")
  assert.equal(listed[0].files, 1)
})

test("--dry-run writes nothing at all", (t) => {
  const s = sandbox(t)
  const res = s.run(["--dry-run", "--reset-queue"])
  assert.equal(res.status, 0)
  assert.match(res.stdout, /dry run — nothing written/)
  assert.equal(
    fs.existsSync(s.dbFile),
    false,
    "a dry run must not even create the store",
  )
})
