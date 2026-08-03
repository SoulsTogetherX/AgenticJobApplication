// The runner's entry point: the refusal W1 is checked on, and the selection
// that decides which jobs enter the queue at all.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"

import {
  parseArgs,
  assertFixtureIsolation,
  selectEligible,
  defaultDocuments,
} from "../../scripts/auto/auto-apply.mjs"
import {
  openDb,
  recordVerification,
  upsertLeads,
  DB_PATH,
} from "../../scripts/lib/db.mjs"

// --- the refusal ------------------------------------------------------------

test("--fixture REFUSES to run against the real lead store", () => {
  // W1's own check. A fixture run writes auto_submissions rows and those count
  // toward the user's per-day and per-company caps — so pointing it at the real
  // store can silently consume a real employer's weekly budget. The damage is
  // not cosmetic and the refusal is not advisory.
  assert.throws(
    () => assertFixtureIsolation({ fixture: true, dbFile: null }),
    /refuses to run against the real lead store/,
  )
  assert.throws(
    () => assertFixtureIsolation({ fixture: true, dbFile: DB_PATH }),
    /refuses to run against the real lead store/,
  )
})

test("the refusal is on the RESOLVED path, not on whether --db was passed", () => {
  // `--db ./jobs/leads.db` is the real store however it was spelled, and a
  // check on "did they pass --db" would wave it straight through.
  const spelled = path.join(path.dirname(DB_PATH), ".", "leads.db")
  assert.throws(
    () => assertFixtureIsolation({ fixture: true, dbFile: spelled }),
    /refuses to run against the real lead store/,
  )
})

test("--fixture against a temp store is fine, and no --fixture is never checked", () => {
  const tmp = path.join(os.tmpdir(), "aj-fixture-store.db")
  assert.equal(assertFixtureIsolation({ fixture: true, dbFile: tmp }), true)
  assert.equal(
    assertFixtureIsolation({ fixture: false, dbFile: DB_PATH }),
    true,
  )
})

// --- args -------------------------------------------------------------------

test("a non-numeric or zero count is a usage error, not a silent default", () => {
  assert.throws(() => parseArgs(["--limit", "0"]), /positive integer/)
  assert.throws(() => parseArgs(["--concurrency", "many"]), /positive integer/)
  assert.equal(parseArgs([]).limit, 25)
  assert.equal(parseArgs([]).concurrency, 1)
})

// --- selection --------------------------------------------------------------

function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aj-select-"))
  const dbFile = path.join(dir, "leads.db")
  const jobsDir = path.join(dir, "jobs")
  fs.mkdirSync(jobsDir, { recursive: true })
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* a leaked handle must not fail a passing assertion */
    }
  })
  return { dir, dbFile, jobsDir }
}

/** A workspace with a resume, a job.json, and (optionally) a passing row. */
function workspace(w, slug, applyUrl, { verified = true, profileSha } = {}) {
  const dir = path.join(w.jobsDir, slug)
  fs.mkdirSync(dir, { recursive: true })
  const resume = path.join(dir, "resume.md")
  fs.writeFileSync(resume, `# ${slug}\n`)
  fs.writeFileSync(
    path.join(dir, "job.json"),
    JSON.stringify({ slug, apply_url: applyUrl }),
  )
  if (!verified) return
  const db = openDb(w.dbFile)
  recordVerification(db, {
    slug,
    mode: "resume",
    verdict: "pass",
    doc_sha256: crypto
      .createHash("sha256")
      .update(fs.readFileSync(resume))
      .digest("hex"),
    profile_sha256:
      profileSha ??
      defaultDocuments(slug, { jobsDir: w.jobsDir }).verification
        .profile_sha256,
  })
  db.close()
}

/** A SCREENED lead behind the workspace. Both halves are required to be
 *  eligible, and the test below asserts that a workspace without one is not. */
function lead(w, slug, applyUrl) {
  const db = openDb(w.dbFile)
  upsertLeads(db, [
    {
      id: slug,
      slug,
      url: applyUrl,
      apply_url: applyUrl,
      company: "Acme",
      title: "Full-Stack Engineer",
      screening: { verdict: "pass", findings: [] },
    },
  ])
  db.close()
}

const LIMITS = {
  auto_apply: {
    board_allowlist: { "boards.greenhouse.io": "greenhouse" },
  },
}

test("a verified workspace with no screened lead behind it is NOT eligible", (t) => {
  // Both halves are required, and this is the half that is easy to forget: the
  // document being verified says nothing about whether any screening stage
  // ever looked at the posting. An unattended submit to a posting nothing
  // screened is precisely what rule 0 is about.
  const w = world(t)
  workspace(w, "orphan-workspace", "https://boards.greenhouse.io/a/jobs/1")
  const db = openDb(w.dbFile)
  const out = selectEligible({ db, limits: LIMITS, jobsDir: w.jobsDir })
  db.close()
  assert.deepEqual(out.jobs, [])
  assert.match(out.rejected[0].reason, /no stored screening verdict/)
})

test("selection walks the VERIFICATIONS, never the jobs/ directory", (t) => {
  // The direction is the fix. Walking jobs/ and asking "is there a resume
  // here?" is what used to let an unverified document through; walking the
  // rows and asking "do these exact bytes still exist?" never reaches a
  // workspace with no row.
  const w = world(t)
  workspace(w, "verified-job", "https://boards.greenhouse.io/a/jobs/1")
  lead(w, "verified-job", "https://boards.greenhouse.io/a/jobs/1")
  workspace(w, "unverified-job", "https://boards.greenhouse.io/b/jobs/2", {
    verified: false,
  })
  lead(w, "unverified-job", "https://boards.greenhouse.io/b/jobs/2")

  const db = openDb(w.dbFile)
  const out = selectEligible({ db, limits: LIMITS, jobsDir: w.jobsDir })
  db.close()

  assert.deepEqual(
    out.jobs.map((j) => j.slug),
    ["verified-job"],
    "a workspace with a resume and no passing verification is never reached",
  )
})

test("an edited document loses its eligibility immediately", (t) => {
  const w = world(t)
  workspace(w, "edited-job", "https://boards.greenhouse.io/a/jobs/1")
  // The bytes change; the row still names the old digest.
  fs.writeFileSync(
    path.join(w.jobsDir, "edited-job", "resume.md"),
    "# edited after verification\n",
  )
  const db = openDb(w.dbFile)
  const out = selectEligible({ db, limits: LIMITS, jobsDir: w.jobsDir })
  db.close()
  assert.deepEqual(out.jobs, [])
})

test("an untrusted board never enters the queue, and says why", (t) => {
  const w = world(t)
  workspace(w, "offlist-job", "https://jobs.ashbyhq.com/a/1")
  const db = openDb(w.dbFile)
  const out = selectEligible({ db, limits: LIMITS, jobsDir: w.jobsDir })
  db.close()
  assert.deepEqual(out.jobs, [])
  assert.equal(out.rejected.length, 1)
  assert.match(out.rejected[0].reason, /not on auto_apply.board_allowlist/)
})

test("a queued row carries the origin the trust gate will be checked against", (t) => {
  const w = world(t)
  workspace(w, "ok-job", "https://boards.greenhouse.io/a/jobs/1")
  lead(w, "ok-job", "https://boards.greenhouse.io/a/jobs/1")
  const db = openDb(w.dbFile)
  const out = selectEligible({ db, limits: LIMITS, jobsDir: w.jobsDir })
  db.close()
  assert.equal(out.jobs[0].origin, "https://boards.greenhouse.io")
  assert.ok(
    out.jobs[0].board_key,
    "and the tenant key, which is a DIFFERENT thing",
  )
  assert.notEqual(
    out.jobs[0].board_key,
    out.jobs[0].origin,
    "conflating the exclusion key with the cap key is C9 all over again",
  )
})

test("the limit is respected", (t) => {
  const w = world(t)
  for (let i = 0; i < 5; i++) {
    workspace(w, `job-${i}`, `https://boards.greenhouse.io/a/jobs/${i}`)
    lead(w, `job-${i}`, `https://boards.greenhouse.io/a/jobs/${i}`)
  }
  const db = openDb(w.dbFile)
  const out = selectEligible({
    db,
    limits: LIMITS,
    jobsDir: w.jobsDir,
    limit: 2,
  })
  db.close()
  assert.equal(out.jobs.length, 2)
  assert.equal(out.considered, 5)
})

test("selection uses the lead's apply_url, never the aggregator link", (t) => {
  // Phase 0.13: `url` for an adzuna lead is adzuna, and submitting there is
  // submitting to the wrong party.
  const w = world(t)
  workspace(w, "agg-job", "https://boards.greenhouse.io/a/jobs/9")
  const db = openDb(w.dbFile)
  upsertLeads(db, [
    {
      id: "agg-1",
      slug: "agg-job",
      url: "https://adzuna.test/ad/123",
      apply_url: "https://boards.greenhouse.io/a/jobs/9",
      company: "Acme",
      title: "Full-Stack Engineer",
      screening: { verdict: "pass", findings: [] },
    },
  ])
  const out = selectEligible({ db, limits: LIMITS, jobsDir: w.jobsDir })
  db.close()
  assert.equal(out.jobs.length, 1)
  assert.equal(out.jobs[0].apply_url, "https://boards.greenhouse.io/a/jobs/9")
  assert.equal(out.jobs[0].origin, "https://boards.greenhouse.io")
})
