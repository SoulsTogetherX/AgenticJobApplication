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
import {
  planArchive,
  classify,
  sha256,
  resolvePostedAt,
  resolveDays,
  planPurge,
  CLOSED,
} from "../../src/maintenance/archive.mjs"
import {
  openDb,
  upsertApplications,
  writeDocuments,
} from "../../src/lib/db.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const CLI = path.join(ROOT, "src", "maintenance", "archive.mjs")

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

// Writes a `documents` row for `slug` directly — an archived workspace whose
// only file is job.json, which is all purge's resolution logic ever reads.
// Bypasses the live-workspace + `archive` round trip on purpose: these tests
// are about purge, not about archiving, and this is faster and keeps each
// fixture's job.json content (company/title/posted_at/source_url) explicit.
function seedDocument(dbFile, slug, job, archivedAt) {
  const db = openDb(dbFile)
  try {
    const content = Buffer.from(JSON.stringify(job, null, 2) + "\n", "utf8")
    writeDocuments(
      db,
      slug,
      [
        {
          name: "job.json",
          content,
          bytes: content.length,
          sha256: sha256(content),
        },
      ],
      archivedAt,
    )
  } finally {
    db.close()
  }
}

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString()

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

// --- purge: pure resolution logic -------------------------------------------
// (no db, no CLI — just the functions the command is built from)

test("resolvePostedAt prefers job.json's own posted_at over any lead", () => {
  const job = {
    company: "Acme",
    title: "Full-Stack Engineer",
    posted_at: "2026-01-01",
  }
  const files = [
    { name: "job.json", content: Buffer.from(JSON.stringify(job)) },
  ]
  const leads = [
    {
      company: "Acme",
      title: "Full-Stack Engineer",
      url: "https://x",
      posted_at: "2020-01-01",
    },
  ]
  const r = resolvePostedAt(files, leads)
  assert.equal(r.posted_at, "2026-01-01")
  assert.equal(r.source, "job.json")
})

test("resolvePostedAt falls back to the lead matched by normalized URL", () => {
  // Real job.json workspaces never carry posted_at themselves (only the lead
  // does), so this is the path real archives resolve through. Query string
  // and trailing slash must not defeat the match, same as new-job.mjs's own
  // --from-lead lookup.
  const job = {
    company: "Acme",
    title: "Full-Stack Engineer",
    source_url: "https://boards.example.com/acme/123?utm=abc",
  }
  const files = [
    { name: "job.json", content: Buffer.from(JSON.stringify(job)) },
  ]
  const leads = [
    {
      company: "Acme",
      title: "Full-Stack Engineer",
      url: "https://boards.example.com/acme/123/",
      posted_at: "2026-06-01",
    },
  ]
  const r = resolvePostedAt(files, leads)
  assert.equal(r.posted_at, "2026-06-01")
  assert.equal(r.source, "lead:url")
})

test("resolvePostedAt falls back to company+title only when exactly one lead matches", () => {
  const job = { company: "Acme", title: "Full-Stack Engineer" }
  const files = [
    { name: "job.json", content: Buffer.from(JSON.stringify(job)) },
  ]

  const oneMatch = [
    { company: "Acme", title: "Full-Stack Engineer", posted_at: "2026-05-01" },
  ]
  const resolved = resolvePostedAt(files, oneMatch)
  assert.equal(resolved.posted_at, "2026-05-01")
  assert.equal(resolved.source, "lead:company+title")

  // A repost (or any duplicate) makes the match ambiguous. Guessing which
  // one the archive actually was is exactly the kind of guess that deletes
  // the wrong record, so this must resolve to nothing instead.
  const ambiguous = [
    { company: "Acme", title: "Full-Stack Engineer", posted_at: "2026-05-01" },
    { company: "Acme", title: "Full-Stack Engineer", posted_at: "2026-06-01" },
  ]
  assert.equal(resolvePostedAt(files, ambiguous).posted_at, null)
})

test("resolvePostedAt resolves nothing when job.json is missing or unparseable", () => {
  assert.equal(resolvePostedAt([], []).posted_at, null)
  const bad = [{ name: "job.json", content: Buffer.from("{ not json") }]
  assert.equal(resolvePostedAt(bad, []).posted_at, null)
})

test("resolveDays: --days wins outright, else the limits file, else 30", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "purge-limits-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const limitsFile = path.join(dir, "limits.yaml")
  fs.writeFileSync(limitsFile, "freshness:\n  max_age_days: 10\n")

  assert.equal(resolveDays("45", limitsFile), 45)
  assert.equal(resolveDays(null, limitsFile), 10)
  assert.equal(resolveDays(null, path.join(dir, "missing.yaml")), 30)
})

test("resolveDays rejects a non-numeric --days rather than silently using it", () => {
  assert.throws(
    () =>
      resolveDays("soon", path.join(ROOT, "docs", "application-limits.yaml")),
    /non-negative number/,
  )
})

test("planPurge keeps a record exactly at the threshold, purges the day after", () => {
  const now = new Date("2026-07-30T00:00:00Z")
  const at30 = {
    slug: "a",
    posted_at: new Date(now.getTime() - 30 * 86400000).toISOString(),
  }
  const at31 = {
    slug: "b",
    posted_at: new Date(now.getTime() - 31 * 86400000).toISOString(),
  }
  const { purge, keep } = planPurge([at30, at31], { days: 30, now })
  assert.deepEqual(
    keep.map((r) => r.slug),
    ["a"],
  )
  assert.deepEqual(
    purge.map((r) => r.slug),
    ["b"],
  )
})

test("planPurge skips missing and unparseable posted_at instead of purging them", () => {
  const now = new Date("2026-07-30T00:00:00Z")
  const records = [
    { slug: "no-date", posted_at: null },
    { slug: "bad-date", posted_at: "not-a-real-date" },
    {
      slug: "old-enough",
      posted_at: new Date(now.getTime() - 90 * 86400000).toISOString(),
    },
  ]
  const { purge, skip } = planPurge(records, { days: 30, now })
  assert.deepEqual(
    purge.map((r) => r.slug),
    ["old-enough"],
  )
  const reasons = new Map(skip.map((s) => [s.slug, s.reason]))
  assert.match(reasons.get("no-date"), /no posted_at/)
  assert.match(reasons.get("bad-date"), /unparseable/)
})

// --- purge: the live-application guard ---------------------------------------
//
// The threshold reads the JOB POSTING'S date; what gets deleted is the
// tailored documents for an application the user actually submitted. These
// pin the rule down at the planPurge level, independent of the CLI and the
// database, since it is the part most likely to regress silently (see the
// null-status case below, which is the regression that motivated the guard).

test("planPurge purges an old record with no application at all", () => {
  const now = new Date("2026-07-30T00:00:00Z")
  const records = [
    {
      slug: "old-no-app",
      posted_at: new Date(now.getTime() - 45 * 86400000).toISOString(),
      has_application: false,
      application_status: null,
    },
  ]
  const { purge, keep, skip } = planPurge(records, { days: 30, now })
  assert.deepEqual(
    purge.map((r) => r.slug),
    ["old-no-app"],
  )
  assert.deepEqual(keep, [])
  assert.deepEqual(skip, [])
})

test("planPurge skips a live application with no outcome recorded yet (status absent, not just falsy)", () => {
  // Real application records carry no `status` key at all until an outcome
  // is reported — main() turns that into application_status: null via
  // `?.status ?? null`. This is the exact shape that motivated the guard: a
  // check for a falsy-but-present status would have missed it.
  const now = new Date("2026-07-30T00:00:00Z")
  const records = [
    {
      slug: "old-applied",
      posted_at: new Date(now.getTime() - 45 * 86400000).toISOString(),
      has_application: true,
      application_status: null,
    },
  ]
  const { purge, skip } = planPurge(records, { days: 30, now })
  assert.deepEqual(purge, [])
  assert.equal(skip.length, 1)
  assert.equal(skip[0].slug, "old-applied")
  assert.match(skip[0].reason, /no outcome recorded/)
})

test("planPurge purges a live application whose outcome is a CLOSED status", () => {
  const now = new Date("2026-07-30T00:00:00Z")
  const records = [
    {
      slug: "old-rejected",
      posted_at: new Date(now.getTime() - 45 * 86400000).toISOString(),
      has_application: true,
      application_status: "rejected",
    },
  ]
  const { purge, skip } = planPurge(records, { days: 30, now })
  assert.deepEqual(
    purge.map((r) => r.slug),
    ["old-rejected"],
  )
  assert.deepEqual(skip, [])
})

test("planPurge purges a live application for every status in the exported CLOSED set", () => {
  // Boundary check on the set itself, not just the "rejected" example above —
  // closed, withdrawn and no_response must all clear the guard too.
  const now = new Date("2026-07-30T00:00:00Z")
  const posted_at = new Date(now.getTime() - 45 * 86400000).toISOString()
  const records = [...CLOSED].map((application_status) => ({
    slug: `old-${application_status}`,
    posted_at,
    has_application: true,
    application_status,
  }))
  const { purge, skip } = planPurge(records, { days: 30, now })
  assert.deepEqual(
    purge.map((r) => r.slug).sort(),
    records.map((r) => r.slug).sort(),
  )
  assert.deepEqual(skip, [])
})

test("planPurge skips a live application with a non-closed status", () => {
  const now = new Date("2026-07-30T00:00:00Z")
  const records = [
    {
      slug: "old-interviewing",
      posted_at: new Date(now.getTime() - 45 * 86400000).toISOString(),
      has_application: true,
      application_status: "interviewing",
    },
  ]
  const { purge, skip } = planPurge(records, { days: 30, now })
  assert.deepEqual(purge, [])
  assert.equal(skip.length, 1)
  assert.match(skip[0].reason, /application still live \("interviewing"\)/)
})

test("planPurge: force overrides the live-application guard", () => {
  const now = new Date("2026-07-30T00:00:00Z")
  const records = [
    {
      slug: "old-applied",
      posted_at: new Date(now.getTime() - 45 * 86400000).toISOString(),
      has_application: true,
      application_status: null,
    },
  ]
  const { purge, skip } = planPurge(records, { days: 30, now, force: true })
  assert.deepEqual(
    purge.map((r) => r.slug),
    ["old-applied"],
  )
  assert.deepEqual(skip, [])
})

test("planPurge: force does not override the missing/unparseable posted_at skip", () => {
  // The two guards are independent and checked in a fixed order — force must
  // not accidentally short-circuit the date check just because it happens to
  // also be a live application.
  const now = new Date("2026-07-30T00:00:00Z")
  const records = [
    {
      slug: "no-date",
      posted_at: null,
      has_application: true,
      application_status: null,
    },
    {
      slug: "bad-date",
      posted_at: "not-a-real-date",
      has_application: true,
      application_status: null,
    },
  ]
  const { purge, skip } = planPurge(records, { days: 30, now, force: true })
  assert.deepEqual(purge, [])
  assert.equal(skip.length, 2)
  const reasons = new Map(skip.map((s) => [s.slug, s.reason]))
  assert.match(reasons.get("no-date"), /no posted_at/)
  assert.match(reasons.get("bad-date"), /unparseable/)
})

// --- purge: the CLI end to end ----------------------------------------------

test("purge dry-run reports candidates but deletes nothing", (t) => {
  const fx = fixture(t, { slugs: [] })
  seedDocument(fx.dbFile, "old-swe", {
    company: "Acme",
    title: "Full-Stack Engineer",
    posted_at: daysAgo(45),
  })
  seedDocument(fx.dbFile, "fresh-swe", {
    company: "Beta",
    title: "Full-Stack Engineer",
    posted_at: daysAgo(5),
  })

  const res = run(["purge", "--days", "30", "--json"], fx)
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout)
  assert.equal(out.apply, false)
  assert.deepEqual(
    out.purge.map((r) => r.slug),
    ["old-swe"],
  )
  assert.equal(out.kept, 1)
  assert.equal(out.deleted, undefined)

  // Dry run means dry run — both archived workspaces are still there.
  const after = JSON.parse(run(["list", "--json"], fx).stdout)
  assert.deepEqual(after.map((r) => r.slug).sort(), ["fresh-swe", "old-swe"])
})

test("dry-run prose tells the human nothing was deleted and --apply is required", (t) => {
  const fx = fixture(t, { slugs: [] })
  seedDocument(fx.dbFile, "old-swe", {
    company: "Acme",
    title: "Full-Stack Engineer",
    posted_at: daysAgo(45),
  })
  const res = run(["purge", "--days", "30", "--verbose"], fx)
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /Dry run — nothing was deleted/)
  assert.match(res.stdout, /--apply/)
  assert.match(res.stdout, /IRREVERSIBLE/)
})

test("purge --apply deletes only records past the threshold; fresher ones survive", (t) => {
  const fx = fixture(t, { slugs: [] })
  seedDocument(fx.dbFile, "old-swe", {
    company: "Acme",
    title: "Full-Stack Engineer",
    posted_at: daysAgo(45),
  })
  seedDocument(fx.dbFile, "fresh-swe", {
    company: "Beta",
    title: "Full-Stack Engineer",
    posted_at: daysAgo(5),
  })

  const res = run(["purge", "--days", "30", "--apply", "--json"], fx)
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout)
  assert.equal(out.deleted, 1)
  assert.deepEqual(
    out.purge.map((r) => r.slug),
    ["old-swe"],
  )

  const after = JSON.parse(run(["list", "--json"], fx).stdout)
  assert.deepEqual(
    after.map((r) => r.slug),
    ["fresh-swe"],
  )
})

test("a record with no resolvable posted_at is skipped, never deleted", (t) => {
  const fx = fixture(t, { slugs: [] })
  seedDocument(fx.dbFile, "no-date", {
    company: "Acme",
    title: "Full-Stack Engineer",
  })

  const res = run(["purge", "--days", "30", "--apply", "--json"], fx)
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout)
  assert.equal(out.purge.length, 0)
  assert.equal(out.deleted, 0)
  assert.equal(out.skip.length, 1)
  assert.match(out.skip[0].reason, /no posted_at/)

  const after = JSON.parse(run(["list", "--json"], fx).stdout)
  assert.deepEqual(
    after.map((r) => r.slug),
    ["no-date"],
  )
})

test("an unparseable posted_at is skipped, never deleted", (t) => {
  const fx = fixture(t, { slugs: [] })
  seedDocument(fx.dbFile, "bad-date", {
    company: "Acme",
    title: "Full-Stack Engineer",
    posted_at: "not-a-real-date",
  })

  const res = run(["purge", "--days", "30", "--apply", "--json"], fx)
  const out = JSON.parse(res.stdout)
  assert.equal(out.purge.length, 0)
  assert.match(out.skip[0].reason, /unparseable/)

  const after = JSON.parse(run(["list", "--json"], fx).stdout)
  assert.deepEqual(
    after.map((r) => r.slug),
    ["bad-date"],
  )
})

test("purge never touches the applications table", (t) => {
  const fx = fixture(t, {
    slugs: [],
    applications: [
      {
        slug: "old-swe",
        company: "Acme",
        title: "Full-Stack Engineer",
        applied_at: "2026-01-01",
        status: "rejected",
      },
    ],
  })
  seedDocument(fx.dbFile, "old-swe", {
    company: "Acme",
    title: "Full-Stack Engineer",
    posted_at: daysAgo(45),
  })

  const res = run(["purge", "--days", "30", "--apply", "--json"], fx)
  assert.equal(JSON.parse(res.stdout).deleted, 1)

  // The archived workspace is gone...
  assert.deepEqual(JSON.parse(run(["list", "--json"], fx).stdout), [])

  // ...but the fact that the user applied is untouched. A purged workspace
  // must never erase application history.
  const db = openDb(fx.dbFile)
  try {
    const row = db
      .prepare("SELECT * FROM applications WHERE slug = ?")
      .get("old-swe")
    assert.ok(row, "the application record must survive purging its archive")
    assert.equal(row.status, "rejected")
  } finally {
    db.close()
  }
})

test("a live application's documents survive a default purge --apply even though the posting is old", (t) => {
  const fx = fixture(t, {
    slugs: [],
    applications: [
      {
        slug: "acme-swe",
        company: "Acme",
        title: "Full-Stack Engineer",
        applied_at: daysAgo(2),
        source_url: "https://example.com/acme/123",
        notes: "",
        // status intentionally absent — a real submitted application has no
        // `status` key until an outcome is reported. This is the regression
        // this guard exists for.
      },
    ],
  })
  seedDocument(fx.dbFile, "acme-swe", {
    company: "Acme",
    title: "Full-Stack Engineer",
    posted_at: daysAgo(45),
  })

  const res = run(["purge", "--days", "30", "--apply", "--json"], fx)
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout)
  assert.equal(out.deleted, 0)
  assert.deepEqual(out.purge, [])
  assert.equal(out.skip.length, 1)
  assert.equal(out.skip[0].slug, "acme-swe")
  assert.match(out.skip[0].reason, /no outcome recorded/)

  // The archived documents are still there...
  const after = JSON.parse(run(["list", "--json"], fx).stdout)
  assert.deepEqual(
    after.map((r) => r.slug),
    ["acme-swe"],
  )

  // ...and the application record itself was never touched.
  const db = openDb(fx.dbFile)
  try {
    const row = db
      .prepare("SELECT * FROM applications WHERE slug = ?")
      .get("acme-swe")
    assert.ok(row, "the application record must still exist")
    assert.equal(row.status, null)
    assert.equal(row.company, "Acme")
  } finally {
    db.close()
  }
})

test("purge never touches a live workspace directory, even one sharing a slug with an archived record", (t) => {
  const fx = fixture(t, { slugs: ["old-swe"] })
  seedDocument(fx.dbFile, "old-swe", {
    company: "Acme",
    title: "Full-Stack Engineer",
    posted_at: daysAgo(45),
  })

  const res = run(["purge", "--days", "30", "--apply", "--json"], fx)
  assert.equal(JSON.parse(res.stdout).deleted, 1)

  // The archived `documents` row is gone...
  assert.deepEqual(JSON.parse(run(["list", "--json"], fx).stdout), [])
  // ...but purge only ever reads/deletes from `documents`, so a LIVE
  // jobs/<slug>/ directory that happens to share the name is never touched.
  assert.ok(fs.existsSync(path.join(fx.jobsDir, "old-swe", "resume.md")))
})

test("--days overrides the default threshold", (t) => {
  const fx = fixture(t, { slugs: [] })
  seedDocument(fx.dbFile, "mid-age", {
    company: "Acme",
    title: "Full-Stack Engineer",
    posted_at: daysAgo(15),
  })

  const strict = JSON.parse(run(["purge", "--days", "10", "--json"], fx).stdout)
  assert.deepEqual(
    strict.purge.map((r) => r.slug),
    ["mid-age"],
  )

  const lenient = JSON.parse(
    run(["purge", "--days", "30", "--json"], fx).stdout,
  )
  assert.deepEqual(lenient.purge, [])
  assert.equal(lenient.kept, 1)
})

test("with no --days, the threshold comes from --limits' freshness.max_age_days", (t) => {
  const fx = fixture(t, { slugs: [] })
  seedDocument(fx.dbFile, "mid-age", {
    company: "Acme",
    title: "Full-Stack Engineer",
    posted_at: daysAgo(15),
  })
  const limitsFile = path.join(fx.dir, "limits.yaml")
  fs.writeFileSync(limitsFile, "freshness:\n  max_age_days: 10\n")

  const res = run(["purge", "--limits", limitsFile, "--json"], fx)
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout)
  assert.equal(out.days, 10)
  assert.deepEqual(
    out.purge.map((r) => r.slug),
    ["mid-age"],
  )
})

test("purge usage lists the subcommand and its flags", (t) => {
  // Routed through the same isolated fixture as every other test here (never
  // the real jobs/leads.db) even though an unrecognized subcommand never
  // reaches purge's own logic — main() still reads --applications/--db up
  // front for every command, this one included.
  const fx = fixture(t, { slugs: [] })
  const res = run(["bogus-command"], fx)
  assert.equal(res.status, 2)
  assert.match(res.stderr, /purge \[--days N\] \[--apply\] \[--json\]/)
})
