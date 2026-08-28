import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  matchApplications,
  summarize,
} from "../../scripts/applications/applications.mjs"
import {
  openDb,
  upsertApplications,
  deleteApplication,
  exportApplicationsYaml,
} from "../../scripts/lib/db.mjs"
import { dumpYaml, loadYamlFile } from "../../scripts/lib/lib.mjs"

const APPS = [
  {
    slug: "igt-swe-dev-ii",
    company: "IGT",
    title: "Software Eng (Dev) II",
    applied_at: "2026-07-28",
    status: "applied",
  },
  {
    slug: "affirm-swe2-udp",
    company: "Affirm",
    title: "Software Engineer II, Backend",
    applied_at: "2026-07-28",
    status: "rejected",
  },
  {
    slug: "jt4-swe",
    company: "JT4 LLC",
    title: "Software Engineer",
    applied_at: "2026-07-27",
  },
]

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "appcli-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test("matchApplications searches slug, company and title", () => {
  assert.deepEqual(
    matchApplications(APPS, "igt").map((a) => a.slug),
    ["igt-swe-dev-ii"],
  )
  assert.deepEqual(
    matchApplications(APPS, "JT4 LLC").map((a) => a.slug),
    ["jt4-swe"],
  )
  // Title substring, case-insensitive, matches more than one.
  assert.equal(matchApplications(APPS, "software engineer").length, 2)
  assert.deepEqual(matchApplications(APPS, "nothing-here"), [])
  // An empty query is "everything", not "nothing".
  assert.equal(matchApplications(APPS, "").length, 3)
})

test("summarize counts statuses and defaults a missing one to applied", () => {
  const s = summarize(APPS)
  assert.equal(s.total, 3)
  assert.equal(s.companies, 3)
  assert.equal(s.first, "2026-07-27")
  assert.equal(s.latest, "2026-07-28")
  assert.deepEqual(s.by_status, { applied: 2, rejected: 1 })
})

test("summarize on an empty store does not invent dates", () => {
  assert.deepEqual(summarize([]), {
    total: 0,
    by_status: {},
    first: null,
    latest: null,
    companies: 0,
  })
})

test("the YAML export round-trips back through the loader", (t) => {
  // The export is the recovery path if jobs/leads.db is ever lost, so it has
  // to be re-loadable, not just readable.
  const dir = tmp(t)
  const db = openDb(path.join(dir, "leads.db"))
  upsertApplications(db, APPS)
  const out = path.join(dir, "applications.yaml")

  const n = exportApplicationsYaml(db, out, dumpYaml)
  assert.equal(n, 3)
  db.close()

  const text = fs.readFileSync(out, "utf8")
  assert.match(text, /GENERATED, do not edit/, "must warn against hand edits")

  const reloaded = loadYamlFile(out).applications
  const bySlug = (xs) => [...xs].sort((a, b) => (a.slug < b.slug ? -1 : 1))
  assert.deepEqual(bySlug(reloaded), bySlug(APPS))
})

test("deleting an application removes exactly one row", (t) => {
  const db = openDb(path.join(tmp(t), "leads.db"))
  upsertApplications(db, APPS)

  assert.equal(deleteApplication(db, "jt4-swe"), 1)
  assert.equal(db.prepare("SELECT COUNT(*) c FROM applications").get().c, 2)
  assert.equal(deleteApplication(db, "jt4-swe"), 0, "already gone")
  assert.equal(deleteApplication(db, "never-existed"), 0)
  db.close()
})

test("the export reflects a deletion", (t) => {
  const dir = tmp(t)
  const db = openDb(path.join(dir, "leads.db"))
  upsertApplications(db, APPS)
  deleteApplication(db, "affirm-swe2-udp")
  const out = path.join(dir, "applications.yaml")
  exportApplicationsYaml(db, out, dumpYaml)
  db.close()

  const slugs = loadYamlFile(out).applications.map((a) => a.slug)
  assert.ok(!slugs.includes("affirm-swe2-udp"))
  assert.equal(slugs.length, 2)
})
