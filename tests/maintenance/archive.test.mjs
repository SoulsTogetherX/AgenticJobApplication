// Archiving removes the only copy of a workspace, so the properties that
// matter here are all about not losing anything: it must refuse anything still
// live, it must round-trip byte-for-byte, and a failed verification must leave
// the directory exactly where it was.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { planArchive, classify } from "../../scripts/maintenance/archive.mjs"
import { openDb, upsertApplications } from "../../scripts/lib/db.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const CLI = path.join(ROOT, "scripts", "maintenance", "archive.mjs")

// A workspace with one of everything: text, JSON, a binary PDF, an
// intermediate, and a file with CRLF and non-ASCII bytes to catch any
// accidental text decoding on the way through the database.
const CONTENT = {
  "resume.md": Buffer.from(
    "# Résumé\r\n\r\n- Built things <!-- fact:e1 -->\r\n",
    "utf8",
  ),
  "cover-letter.md": Buffer.from("Dear hiring team,\n\nHello — 👋\n", "utf8"),
  "job.json": Buffer.from('{\n  "slug": "acme-swe"\n}\n', "utf8"),
  "context.json": Buffer.from('{\n  "slug": "acme-swe"\n}\n', "utf8"),
  "resume.pdf": Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x00, 0xff]),
  "resume.render.html": Buffer.from("<html>intermediate</html>", "utf8"),
}

function fixture(t, { applications = [], slugs = ["acme-swe"] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const jobsDir = path.join(dir, "jobs")
  for (const slug of slugs) {
    fs.mkdirSync(path.join(jobsDir, slug), { recursive: true })
    for (const [name, buf] of Object.entries(CONTENT)) {
      fs.writeFileSync(path.join(jobsDir, slug, name), buf)
    }
  }
  const dbFile = path.join(dir, "test.db")
  const db = openDb(dbFile)
  try {
    if (applications.length) upsertApplications(db, applications)
  } finally {
    db.close()
  }
  return { dir, jobsDir, dbFile }
}

function run(argsArr, { jobsDir, dbFile }) {
  return spawnSync(
    process.execPath,
    [CLI, ...argsArr, "--jobs-dir", jobsDir, "--db", dbFile],
    { cwd: ROOT, encoding: "utf8" },
  )
}

// --- classification ---------------------------------------------------------

test("files are classified by what can be rebuilt", () => {
  assert.equal(classify("resume.md"), "store")
  assert.equal(classify("job.json"), "store")
  assert.equal(classify("scan-p1.json"), "store")
  // Deterministic output of render-pdf.mjs — the markdown is the artifact.
  assert.equal(classify("resume.pdf"), "regenerable")
  assert.equal(classify("RESUME.PDF"), "regenerable")
  // Never worth keeping, at any point in a workspace's life.
  assert.equal(classify("resume.render.html"), "drop")
})

// --- policy -----------------------------------------------------------------

test("--closed archives only recorded closed outcomes", () => {
  const workspaces = [
    { slug: "a-rejected" },
    { slug: "b-applied" },
    { slug: "c-interviewing" },
    { slug: "d-no-record" },
    { slug: "e-withdrawn" },
  ]
  const applications = [
    { slug: "a-rejected", status: "rejected" },
    { slug: "b-applied", status: "applied" },
    { slug: "c-interviewing", status: "interviewing" },
    { slug: "e-withdrawn", status: "withdrawn" },
  ]
  const { archive, refuse } = planArchive(workspaces, applications, {
    closedOnly: true,
  })
  assert.deepEqual(archive.map((a) => a.slug).sort(), [
    "a-rejected",
    "e-withdrawn",
  ])
  // "applied" is awaiting a reply, and no record at all is not evidence of
  // anything — neither may be inferred to be closed.
  const reasons = new Map(refuse.map((r) => [r.slug, r.reason]))
  assert.match(reasons.get("b-applied"), /not a closed outcome/)
  assert.match(reasons.get("c-interviewing"), /not a closed outcome/)
  assert.match(reasons.get("d-no-record"), /no recorded outcome/)
})

test("manual archive refuses a live application unless forced", () => {
  const workspaces = [{ slug: "b-applied" }]
  const applications = [{ slug: "b-applied", status: "applied" }]
  const opts = { slugs: ["b-applied"] }

  const blocked = planArchive(workspaces, applications, opts)
  assert.equal(blocked.archive.length, 0)
  assert.match(blocked.refuse[0].reason, /still live/)

  const forced = planArchive(workspaces, applications, { ...opts, force: true })
  assert.deepEqual(
    forced.archive.map((a) => a.slug),
    ["b-applied"],
  )
})

test("manual archive allows a workspace that was never applied to", () => {
  // A prepped-but-unsent workspace has no application record. That is not a
  // live application, so folding it away is the user's call, not a refusal.
  const { archive, refuse } = planArchive([{ slug: "prepped" }], [], {
    slugs: ["prepped"],
  })
  assert.deepEqual(
    archive.map((a) => a.slug),
    ["prepped"],
  )
  assert.deepEqual(refuse, [])
})

test("an unknown slug is refused, not silently ignored", () => {
  const { archive, refuse } = planArchive([{ slug: "real" }], [], {
    slugs: ["real", "typo"],
  })
  assert.deepEqual(
    archive.map((a) => a.slug),
    ["real"],
  )
  assert.deepEqual(refuse, [{ slug: "typo", reason: "no such workspace" }])
})

// --- the round trip ---------------------------------------------------------

test("archive then restore is byte-identical", (t) => {
  const fx = fixture(t)
  const before = Object.fromEntries(
    Object.keys(CONTENT).map((n) => [
      n,
      fs.readFileSync(path.join(fx.jobsDir, "acme-swe", n)),
    ]),
  )

  const arch = run(["archive", "acme-swe"], fx)
  assert.equal(arch.status, 0, arch.stderr)
  assert.match(arch.stdout, /archived\tacme-swe\tfiles=5\t/)
  assert.match(arch.stdout, /regenerable=1/)
  // The directory is gone, which is the whole point: `ls jobs/` shows live work.
  assert.equal(fs.existsSync(path.join(fx.jobsDir, "acme-swe")), false)

  const res = run(["restore", "acme-swe"], fx)
  assert.equal(res.status, 0, res.stderr)

  const dir = path.join(fx.jobsDir, "acme-swe")
  for (const name of [
    "resume.md",
    "cover-letter.md",
    "job.json",
    "context.json",
  ]) {
    assert.deepEqual(
      fs.readFileSync(path.join(dir, name)),
      before[name],
      `${name} did not round-trip byte-for-byte`,
    )
  }
  // The PDF is deliberately not stored, and the restore says so instead of
  // pretending it is there.
  assert.equal(fs.existsSync(path.join(dir, "resume.pdf")), false)
  assert.match(res.stdout, /regenerable\tresume\.pdf/)
  assert.match(res.stdout, /render-pdf\.mjs/)
  // The intermediate was never archived at all.
  assert.equal(fs.existsSync(path.join(dir, "resume.render.html")), false)
})

test("restore refuses to clobber an existing workspace unless forced", (t) => {
  const fx = fixture(t)
  assert.equal(run(["archive", "acme-swe"], fx).status, 0)
  assert.equal(run(["restore", "acme-swe"], fx).status, 0)

  // The restored copy may have been edited since; overwriting it silently
  // would lose that work.
  fs.writeFileSync(path.join(fx.jobsDir, "acme-swe", "resume.md"), "edited")
  const blocked = run(["restore", "acme-swe"], fx)
  assert.equal(blocked.status, 1)
  assert.match(blocked.stderr, /already exists/)
  assert.equal(
    fs.readFileSync(path.join(fx.jobsDir, "acme-swe", "resume.md"), "utf8"),
    "edited",
  )

  assert.equal(run(["restore", "acme-swe", "--force"], fx).status, 0)
  assert.match(
    fs.readFileSync(path.join(fx.jobsDir, "acme-swe", "resume.md"), "utf8"),
    /Résumé/,
  )
})

test("restore --to writes elsewhere, which is how verify-claims reads an archive", (t) => {
  const fx = fixture(t)
  assert.equal(run(["archive", "acme-swe"], fx).status, 0)
  const dest = path.join(fx.dir, "inspect")
  const res = run(["restore", "acme-swe", "--to", dest], fx)
  assert.equal(res.status, 0, res.stderr)
  assert.ok(fs.existsSync(path.join(dest, "resume.md")))
  // jobs/ stays clean — inspecting an archive does not resurrect a workspace.
  assert.equal(fs.existsSync(path.join(fx.jobsDir, "acme-swe")), false)
})

test("restoring an unknown slug fails without creating anything", (t) => {
  const fx = fixture(t)
  const res = run(["restore", "nope"], fx)
  assert.equal(res.status, 1)
  assert.match(res.stderr, /nothing archived/)
  assert.equal(fs.existsSync(path.join(fx.jobsDir, "nope")), false)
})

// --- reversibility and repeat runs -----------------------------------------

test("re-archiving after an edit replaces the rows rather than merging", (t) => {
  const fx = fixture(t)
  run(["archive", "acme-swe"], fx)
  run(["restore", "acme-swe"], fx)

  const dir = path.join(fx.jobsDir, "acme-swe")
  fs.writeFileSync(path.join(dir, "resume.md"), "second draft")
  fs.rmSync(path.join(dir, "cover-letter.md"))
  run(["archive", "acme-swe"], fx)

  const shown = run(["show", "acme-swe", "--json"], fx)
  const rows = JSON.parse(shown.stdout)
  const names = rows.map((r) => r.name)
  // A stale row for a file the user deleted would resurrect it on restore.
  assert.ok(!names.includes("cover-letter.md"), names.join(","))
  assert.ok(names.includes("resume.md"))

  run(["restore", "acme-swe"], fx)
  assert.equal(
    fs.readFileSync(path.join(dir, "resume.md"), "utf8"),
    "second draft",
  )
  assert.equal(fs.existsSync(path.join(dir, "cover-letter.md")), false)
})

test("list summarises archives without reading their contents back", (t) => {
  const fx = fixture(t, { slugs: ["acme-swe", "widgetco-swe"] })
  run(["archive", "acme-swe", "widgetco-swe"], fx)
  const res = run(["list", "--json"], fx)
  assert.equal(res.status, 0, res.stderr)
  const rows = JSON.parse(res.stdout)
  assert.equal(rows.length, 2)
  for (const r of rows) {
    assert.equal(r.files, 5)
    assert.equal(r.regenerable, 1)
    assert.ok(r.bytes > 0)
  }
})

test("an empty workspace is removed but not reported as archived", (t) => {
  const fx = fixture(t)
  const empty = path.join(fx.jobsDir, "hollow")
  fs.mkdirSync(empty)
  fs.writeFileSync(path.join(empty, "resume.render.html"), "junk")
  const res = run(["archive", "hollow"], fx)
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /emptied\thollow/)
  assert.equal(fs.existsSync(empty), false)
})

test("--dry-run touches nothing", (t) => {
  const fx = fixture(t, {
    applications: [{ slug: "acme-swe", status: "rejected" }],
  })
  const res = run(["archive", "--closed", "--dry-run"], fx)
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /would-archive\tacme-swe/)
  assert.ok(fs.existsSync(path.join(fx.jobsDir, "acme-swe", "resume.md")))
  const list = run(["list", "--json"], fx)
  assert.deepEqual(JSON.parse(list.stdout), [])
})

test("the end-to-end closed path archives exactly the closed application", (t) => {
  const fx = fixture(t, {
    slugs: ["acme-swe", "widgetco-swe"],
    applications: [
      { slug: "acme-swe", status: "rejected" },
      { slug: "widgetco-swe", status: "applied" },
    ],
  })
  const res = run(["archive", "--closed"], fx)
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /archived\tacme-swe/)
  assert.match(res.stdout, /refused\twidgetco-swe/)
  assert.equal(fs.existsSync(path.join(fx.jobsDir, "acme-swe")), false)
  assert.ok(fs.existsSync(path.join(fx.jobsDir, "widgetco-swe", "resume.md")))
})
