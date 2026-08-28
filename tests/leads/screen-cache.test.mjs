// The mechanical screen is cheap; the model's judgment pass is not. These
// tests are about the second one never being paid for twice, and about the
// first one never being mistaken for it.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { openDb, upsertLeads, readScreens } from "../../src/lib/db.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const CLI = path.join(ROOT, "src", "leads", "screen.mjs")

const LEADS = [
  {
    id: "gh-acme-1",
    company: "Acme",
    title: "Full-Stack Developer",
    url: "https://x.example/1",
    status: "new",
    description:
      "Build and ship product features with Node, React and Postgres. " +
      "You will own services end to end and work with a small platform team. " +
      "We are looking for 2+ years of experience.",
    flags: [],
  },
  {
    id: "gh-widget-2",
    company: "WidgetCo",
    title: "Back-End Engineer",
    url: "https://x.example/2",
    status: "new",
    description:
      "Design and operate our billing services in Go and Postgres, working " +
      "closely with the payments team on reliability and correctness work. " +
      "Requires 8+ years of experience.",
    flags: [],
  },
]

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "screencache-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbFile = path.join(dir, "leads.db")
  const db = openDb(dbFile)
  try {
    upsertLeads(db, LEADS)
  } finally {
    db.close()
  }
  return { dir, dbFile, jobsDir: path.join(dir, "jobs") }
}

function run(argsArr, fx) {
  return spawnSync(
    process.execPath,
    [
      CLI,
      ...argsArr,
      "--leads",
      fx.dbFile,
      "--jobs-dir",
      fx.jobsDir,
      "--profile",
      path.join(ROOT, "tests", "fixtures", "profile.yaml"),
    ],
    { cwd: ROOT, encoding: "utf8" },
  )
}

test("screening records its own verdicts, keyed as mechanical", (t) => {
  const fx = fixture(t)
  const res = run(["--status", "new", "--json"], fx)
  assert.equal(res.status, 0, res.stderr)
  assert.equal(JSON.parse(res.stdout).results.length, 2)

  const db = openDb(fx.dbFile)
  try {
    const rows = readScreens(db, { source: "mechanical" })
    assert.equal(rows.length, 2)
    // The parsed bar rides along, so tailoring does not re-read the
    // description to learn what the posting asked for.
    const widget = rows.find((r) => r.lead_id === "gh-widget-2")
    assert.equal(widget.years_required, 8)
    assert.ok(widget.signals.includes("over_bar_8y"))
    assert.equal(readScreens(db, { source: "model" }).length, 0)
  } finally {
    db.close()
  }
})

test("re-screening replaces rather than piling up rows", (t) => {
  const fx = fixture(t)
  run(["--status", "new"], fx)
  run(["--status", "new"], fx)
  run(["--status", "new"], fx)
  const db = openDb(fx.dbFile)
  try {
    assert.equal(readScreens(db).length, 2)
  } finally {
    db.close()
  }
})

test("--no-record leaves the table alone", (t) => {
  const fx = fixture(t)
  const res = run(["--status", "new", "--no-record"], fx)
  assert.equal(res.status, 0, res.stderr)
  const db = openDb(fx.dbFile)
  try {
    assert.equal(readScreens(db).length, 0)
  } finally {
    db.close()
  }
})

test("a JSON lead store is never written to", (t) => {
  // This is what the rest of the suite points at. A screen that wrote to the
  // real database from a fixture run is exactly the bug that put test rows in
  // the live store once already.
  const fx = fixture(t)
  const jsonPath = path.join(fx.dir, "leads.json")
  fs.writeFileSync(jsonPath, JSON.stringify({ leads: LEADS }))
  const res = spawnSync(
    process.execPath,
    [CLI, "--status", "new", "--leads", jsonPath, "--jobs-dir", fx.jobsDir],
    { cwd: ROOT, encoding: "utf8" },
  )
  assert.equal(res.status, 0, res.stderr)
  const db = openDb(fx.dbFile)
  try {
    assert.equal(readScreens(db).length, 0)
  } finally {
    db.close()
  }
})

test("record stores a model verdict and screening reports it", (t) => {
  const fx = fixture(t)
  const rec = run(
    [
      "record",
      "gh-acme-1",
      "--verdict",
      "caution",
      "--reason",
      "reposted three times since May",
      "--signals",
      "evergreen,no_salary",
    ],
    fx,
  )
  assert.equal(rec.status, 0, rec.stderr)

  const db = openDb(fx.dbFile)
  try {
    const [row] = readScreens(db, { source: "model" })
    assert.equal(row.lead_id, "gh-acme-1")
    assert.equal(row.verdict, "caution")
    assert.equal(row.reason, "reposted three times since May")
    assert.deepEqual(row.signals, ["evergreen", "no_salary"])
    assert.match(row.screened_at, /^\d{4}-\d{2}-\d{2}T/)
  } finally {
    db.close()
  }

  const res = run(["--status", "new", "--json"], fx)
  const out = JSON.parse(res.stdout)
  assert.equal(out.model_screened, 1)
  assert.equal(out.results.length, 2, "reported, but not skipped by default")
})

test("--skip-screened leaves out what the model already judged", (t) => {
  const fx = fixture(t)
  run(["record", "gh-acme-1", "--verdict", "reject"], fx)

  const res = run(["--status", "new", "--skip-screened", "--json"], fx)
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout)
  assert.equal(out.model_screened, 1)
  assert.deepEqual(
    out.results.map((r) => r.id),
    ["gh-widget-2"],
  )

  // Skipping must not quietly drop the mechanical verdict that was already
  // recorded for the skipped lead.
  const db = openDb(fx.dbFile)
  try {
    assert.equal(readScreens(db, { source: "model" }).length, 1)
  } finally {
    db.close()
  }
})

test("record refuses a bad verdict, a missing id, and a JSON store", (t) => {
  const fx = fixture(t)
  assert.equal(run(["record", "gh-acme-1", "--verdict", "maybe"], fx).status, 2)
  assert.equal(run(["record", "--verdict", "pass"], fx).status, 2)

  const jsonPath = path.join(fx.dir, "leads.json")
  fs.writeFileSync(jsonPath, JSON.stringify({ leads: LEADS }))
  const res = spawnSync(
    process.execPath,
    [CLI, "record", "gh-acme-1", "--verdict", "pass", "--leads", jsonPath],
    { cwd: ROOT, encoding: "utf8" },
  )
  assert.equal(res.status, 2)
  assert.match(res.stderr, /needs the database/)
})

test("a pre-source screens table is rebuilt when empty and refused when not", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "screenheal-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  // Every database built before this change has the old four-column table,
  // which CREATE TABLE IF NOT EXISTS will happily leave in place forever.
  const file = path.join(dir, "old.db")
  {
    const db = openDb(file)
    db.exec("DROP TABLE screens")
    db.exec(
      `CREATE TABLE screens (lead_id TEXT NOT NULL, verdict TEXT NOT NULL,
         reason TEXT, screened_at TEXT NOT NULL, PRIMARY KEY (lead_id, screened_at))`,
    )
    db.close()
  }
  // Empty: rebuilding it is not a migration, there is nothing to migrate.
  const healed = openDb(file)
  try {
    const cols = healed
      .prepare("PRAGMA table_info(screens)")
      .all()
      .map((c) => c.name)
    assert.ok(cols.includes("source"), cols.join(","))
    assert.ok(cols.includes("doc"))
  } finally {
    healed.close()
  }

  const file2 = path.join(dir, "populated.db")
  {
    const db = openDb(file2)
    db.exec("DROP TABLE screens")
    db.exec(
      `CREATE TABLE screens (lead_id TEXT NOT NULL, verdict TEXT NOT NULL,
         reason TEXT, screened_at TEXT NOT NULL, PRIMARY KEY (lead_id, screened_at))`,
    )
    db.exec(
      "INSERT INTO screens VALUES ('a','reject','over_bar','2026-07-28T00:00:00Z')",
    )
    db.close()
  }
  // Rows present: refuse loudly rather than dropping recorded verdicts.
  assert.throws(() => openDb(file2), /pre-source schema/)
})
