// The re-verification sweep. A fact-base edit invalidates every outstanding
// verification at once (that is lib/verification.mjs working as designed);
// the sweep is what re-RUNS verify-claims for those documents instead of
// leaving them stale forever. A still-true document becomes eligible again; a
// document the new facts no longer support is recorded as FAILING, surfaced,
// and never retried against the same fact base.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  reverifySweep,
  newestVerifications,
} from "../../src/documents/reverify.mjs"
import {
  factBaseSha256,
  verificationIdentity,
  hasVerifiedResume,
  verifiedResumeUrls,
} from "../../src/lib/verification.mjs"
import {
  openDb,
  recordVerification,
  hasPassingVerification,
  readVerifications,
} from "../../src/lib/db.mjs"
import { classify } from "../../src/apply/automatability.mjs"

// A fact base one real claim can pass against, and one edit can break.
const PROFILE_GO =
  "meta:\n  approved_by_user: true\nsummary:\n  - id: s1\n    text: Writes Go.\n"
const PROFILE_RUST =
  "meta:\n  approved_by_user: true\nsummary:\n  - id: s1\n    text: Writes Rust.\n"
const RESUME_GO = "- Writes Go. <!-- fact:s1 -->\n"
const COVER_GO = "I build services in Go.\n"

function ws(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aj-reverify-"))
  const jobsDir = path.join(root, "jobs")
  const profileDir = path.join(root, "profile")
  fs.mkdirSync(jobsDir, { recursive: true })
  fs.mkdirSync(profileDir, { recursive: true })
  const profilePath = path.join(profileDir, "profile.yaml")
  const answersPath = path.join(profileDir, "answers.yaml")
  fs.writeFileSync(profilePath, PROFILE_GO)
  fs.writeFileSync(answersPath, "answers: []\n")

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
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      /* a leaked Windows lock must not fail a passing test */
    }
  })

  return {
    root,
    jobsDir,
    profilePath,
    answersPath,
    opts: { jobsDir, profilePath, answersPath },
    db() {
      const d = openDb(path.join(root, "leads.db"))
      handles.push(d)
      return d
    },
    job(
      slug,
      {
        resume = RESUME_GO,
        cover = null,
        url = `https://boards.test/${slug}`,
        company = "Acme",
        title = "Dev",
      } = {},
    ) {
      const dir = path.join(jobsDir, slug)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, "resume.md"), resume)
      if (cover) fs.writeFileSync(path.join(dir, "cover-letter.md"), cover)
      fs.writeFileSync(
        path.join(dir, "job.json"),
        JSON.stringify({ slug, company, title, apply_url: url }),
      )
      return {
        dir,
        resume: path.join(dir, "resume.md"),
        cover: path.join(dir, "cover-letter.md"),
        url,
      }
    },
    // The initial row, recorded the way the verify-claims CLI records it. The
    // fixtures genuinely pass at record time, so 'pass' is what it wrote.
    recordPass(db, file, mode = "resume") {
      recordVerification(db, {
        ...verificationIdentity(file, this.opts),
        mode,
        verdict: "pass",
      })
    },
  }
}

const sweep = (db, w) => reverifySweep({ db, ...w.opts })
const verified = (db, w, slug) =>
  hasVerifiedResume(db, slug, { ...w.opts, hasPassing: hasPassingVerification })

// --- the guardrails around the sweep itself -----------------------------------

test("reverifySweep refuses to run without a db rather than reporting nothing stale", () => {
  assert.throws(() => reverifySweep({}), /requires an open db handle/)
})

test("newestVerifications keeps the newest row per (slug, mode)", () => {
  const newest = newestVerifications([
    {
      slug: "a",
      mode: "resume",
      profile_sha256: "old",
      verified_at: "2026-01-01T00:00:00Z",
    },
    {
      slug: "a",
      mode: "resume",
      profile_sha256: "new",
      verified_at: "2026-02-01T00:00:00Z",
    },
    {
      slug: "a",
      mode: "cover-letter",
      profile_sha256: "cl",
      verified_at: "2026-01-15T00:00:00Z",
    },
  ])
  assert.equal(newest.get("a resume").profile_sha256, "new")
  assert.equal(newest.get("a cover-letter").profile_sha256, "cl")
})

test("a fresh verification is left exactly alone", (t) => {
  const w = ws(t)
  const db = w.db()
  const doc = w.job("acme-dev")
  w.recordPass(db, doc.resume)
  const before = readVerifications(db, "acme-dev")

  const r = sweep(db, w)
  assert.deepEqual(r.stale, [])
  assert.deepEqual(r.checked, [])
  assert.equal(r.repassed + r.refailed, 0)
  assert.deepEqual(
    readVerifications(db, "acme-dev"),
    before,
    "an up-to-date row must not be rewritten — not even its timestamp",
  )
})

test("a never-verified workspace is not the sweep's business", (t) => {
  const w = ws(t)
  const db = w.db()
  w.job("acme-dev")
  fs.appendFileSync(w.profilePath, "\n# note\n")
  const r = sweep(db, w)
  assert.deepEqual(r.stale, [])
  assert.equal(
    readVerifications(db).length,
    0,
    "first-time verification belongs to prepareDocuments, not the sweep",
  )
})

// --- success path: still-true document, benign fact-base edit ------------------

test("a fact-base edit re-runs verify-claims and a still-true document becomes eligible again", (t) => {
  const w = ws(t)
  const db = w.db()
  const doc = w.job("acme-dev")
  w.recordPass(db, doc.resume)
  assert.equal(verified(db, w, "acme-dev"), true)

  fs.appendFileSync(w.profilePath, "\n# the user added a note\n")
  assert.equal(
    verified(db, w, "acme-dev"),
    false,
    "the stale state this sweep exists to clear",
  )

  const r = sweep(db, w)
  assert.deepEqual(r.stale, ["acme-dev"])
  assert.equal(r.repassed, 1)
  assert.equal(r.refailed, 0)
  assert.equal(r.checked[0].ok, true)

  assert.equal(verified(db, w, "acme-dev"), true, "eligible again")
  const urls = verifiedResumeUrls(db, {
    ...w.opts,
    hasPassing: hasPassingVerification,
  })
  assert.equal(urls.get(doc.url), "acme-dev")

  const rows = readVerifications(db, "acme-dev")
  assert.equal(rows.length, 1, "same bytes upsert in place — no row pile-up")
  assert.equal(rows[0].profile_sha256, factBaseSha256(w.opts))
  assert.equal(rows[0].verdict, "pass")
})

test("addressing from job.json still applies on re-verify", (t) => {
  const w = ws(t)
  const db = w.db()
  // The number 7 is supported ONLY by the posting's title — exactly what the
  // CLI's --job addressing excuses. A sweep that forgot the addressing would
  // be stricter than the verifier and would kill a truthful document.
  const doc = w.job("acme-eng7", {
    resume: `Target: Engineer 7 at Acme.\n\n${RESUME_GO}`,
    title: "Engineer 7",
  })
  w.recordPass(db, doc.resume)

  fs.appendFileSync(w.profilePath, "\n# note\n")
  const r = sweep(db, w)
  assert.equal(r.refailed, 0, JSON.stringify(r.checked))
  assert.equal(r.repassed, 1)
  assert.equal(verified(db, w, "acme-eng7"), true)
})

test("both documents of a stale job are re-verified, cover letter included", (t) => {
  const w = ws(t)
  const db = w.db()
  const doc = w.job("acme-dev", { cover: COVER_GO })
  w.recordPass(db, doc.resume, "resume")
  w.recordPass(db, doc.cover, "cover-letter")

  fs.appendFileSync(w.profilePath, "\n# note\n")
  const r = sweep(db, w)
  assert.deepEqual(r.checked.map((c) => c.mode).sort(), [
    "cover-letter",
    "resume",
  ])
  assert.equal(r.repassed, 2)
  const current = factBaseSha256(w.opts)
  for (const row of readVerifications(db, "acme-dev"))
    assert.equal(row.profile_sha256, current)
})

test("a cover letter with no row yet gets its first one when its job is swept", (t) => {
  const w = ws(t)
  const db = w.db()
  const doc = w.job("acme-dev", { cover: COVER_GO })
  w.recordPass(db, doc.resume, "resume") // only the resume was ever recorded

  fs.appendFileSync(w.profilePath, "\n# note\n")
  const r = sweep(db, w)
  assert.ok(r.checked.some((c) => c.mode === "cover-letter" && c.ok))
  const rows = readVerifications(db, "acme-dev")
  assert.equal(rows.filter((x) => x.mode === "cover-letter").length, 1)
})

// --- failure path: the new fact base no longer supports the document -----------

test("a document the new fact base no longer supports records a FAIL, is surfaced, and stays blocked", (t) => {
  const w = ws(t)
  const db = w.db()
  const doc = w.job("acme-dev", {
    url: "https://boards.greenhouse.io/acme/jobs/1",
  })
  w.recordPass(db, doc.resume)
  assert.equal(verified(db, w, "acme-dev"), true)

  // The user's edit removes the fact the resume cites: Go is gone.
  fs.writeFileSync(w.profilePath, PROFILE_RUST)

  const r = sweep(db, w)
  assert.equal(r.refailed, 1)
  assert.equal(r.repassed, 0)
  const failed = r.checked[0]
  assert.equal(failed.ok, false)
  assert.equal(failed.slug, "acme-dev")
  assert.ok(
    failed.violations.some((v) => v.rule === "R6" && v.detail.includes("Go")),
    `the why must be surfaced: ${JSON.stringify(failed.violations)}`,
  )

  // The verdict is durable and honest: a fail row against the CURRENT fact
  // base, never a fallback to the old pass.
  const rows = readVerifications(db, "acme-dev")
  assert.equal(rows.length, 1)
  assert.equal(rows[0].verdict, "fail")
  assert.equal(rows[0].profile_sha256, factBaseSha256(w.opts))

  // And the job is out of eligibility, visibly.
  assert.equal(verified(db, w, "acme-dev"), false)
  const tier = classify(
    {
      id: "l1",
      company: "Acme",
      title: "Dev",
      apply_url: "https://boards.greenhouse.io/acme/jobs/1",
    },
    {
      profileApproved: true,
      hasVerifiedResume: verified(db, w, "acme-dev"),
      stages: { ok: true },
    },
  )
  assert.equal(tier.tier, "blocked")
  assert.match(tier.reason, /no passing verify-claims row/)
})

test("a recorded failure is not retried against the same fact base", (t) => {
  const w = ws(t)
  const db = w.db()
  const doc = w.job("acme-dev")
  w.recordPass(db, doc.resume)
  fs.writeFileSync(w.profilePath, PROFILE_RUST)

  assert.equal(sweep(db, w).refailed, 1)
  const after = readVerifications(db, "acme-dev")

  const second = sweep(db, w)
  assert.deepEqual(second.stale, [], "the fail row carries the current hash")
  assert.deepEqual(second.checked, [])
  assert.deepEqual(
    readVerifications(db, "acme-dev"),
    after,
    "one fact-base version, one verdict — no retry-until-pass",
  )

  // The facts moving AGAIN is what re-opens the question.
  fs.writeFileSync(w.profilePath, PROFILE_GO)
  const third = sweep(db, w)
  assert.equal(third.repassed, 1)
  assert.equal(verified(db, w, "acme-dev"), true)
})

// --- rows whose document is gone ------------------------------------------------

test("a stale row whose document is gone is reported, not resurrected", (t) => {
  const w = ws(t)
  const db = w.db()
  const doc = w.job("acme-dev")
  w.recordPass(db, doc.resume)
  fs.rmSync(doc.resume)
  fs.appendFileSync(w.profilePath, "\n# note\n")

  const r = sweep(db, w)
  assert.deepEqual(
    r.missing.map((m) => [m.slug, m.mode]),
    [["acme-dev", "resume"]],
  )
  assert.deepEqual(r.checked, [])
  const rows = readVerifications(db, "acme-dev")
  assert.equal(rows.length, 1, "no bytes to vouch for, so nothing was recorded")
  assert.notEqual(
    rows[0].profile_sha256,
    factBaseSha256(w.opts),
    "the old row stays stale, which keeps the job ineligible",
  )
})

// --- orphaned verification rows (workspace hand-deleted) -------------------
//
// The sweep is row-driven by design, so rows whose workspace no longer exists
// re-reported as `missing` forever, and nothing in the repo could delete a
// verifications row (measured: essex-street-cheese-frontend-dev, three rows
// re-reported since 2026-08-10). --prune-orphans is the sanctioned cleanup,
// guarded three ways: no directory, no documents row, no applications row.

test("an orphaned slug is reported but NOT pruned without the flag", (t) => {
  const w = ws(t)
  const db = w.db()
  const doc = w.job("ghost-dev")
  w.recordPass(db, doc.resume)
  fs.rmSync(doc.dir, { recursive: true, force: true })
  fs.appendFileSync(w.profilePath, "\n# note\n") // make the row stale

  const r = sweep(db, w)
  assert.deepEqual(r.orphaned, ["ghost-dev"])
  assert.equal(r.pruned, 0)
  assert.equal(
    readVerifications(db, "ghost-dev").length,
    1,
    "the default sweep must not delete anything",
  )
  assert.equal(
    r.missing.length,
    1,
    "without pruning the row still re-reports as missing",
  )
})

test("--prune-orphans deletes the rows, and the slug leaves stale/missing in the SAME run", (t) => {
  const w = ws(t)
  const db = w.db()
  const doc = w.job("ghost-dev")
  w.recordPass(db, doc.resume)
  fs.rmSync(doc.dir, { recursive: true, force: true })
  fs.appendFileSync(w.profilePath, "\n# note\n")

  const r = reverifySweep({ db, ...w.opts, pruneOrphans: true })
  assert.deepEqual(r.orphaned, ["ghost-dev"])
  assert.equal(r.pruned, 1)
  assert.deepEqual(readVerifications(db, "ghost-dev"), [])
  assert.deepEqual(r.stale, [], "pruned before the sweep reads the rows")
  assert.deepEqual(r.missing, [])
})

test("a slug with an APPLICATIONS row is never pruned, even with the directory gone", (t) => {
  const w = ws(t)
  const db = w.db()
  const doc = w.job("applied-dev")
  w.recordPass(db, doc.resume)
  db.prepare(
    "INSERT INTO applications (slug, company, title, applied_at, status, doc) VALUES (?,?,?,?,?,?)",
  ).run("applied-dev", "Acme", "Dev", "2026-08-10", "applied", "{}")
  fs.rmSync(doc.dir, { recursive: true, force: true })
  fs.appendFileSync(w.profilePath, "\n# note\n")

  const r = reverifySweep({ db, ...w.opts, pruneOrphans: true })
  assert.deepEqual(
    r.orphaned,
    [],
    "an applications row is evidence of a real application — never prunable",
  )
  assert.equal(r.pruned, 0)
  assert.equal(readVerifications(db, "applied-dev").length, 1)
})

test("a slug with a DOCUMENTS row is never pruned", (t) => {
  const w = ws(t)
  const db = w.db()
  const doc = w.job("archived-dev")
  w.recordPass(db, doc.resume)
  db.prepare(
    "INSERT INTO documents (slug, name, content, bytes, sha256, archived_at) VALUES (?,?,?,?,?,?)",
  ).run(
    "archived-dev",
    "resume.md",
    "# archived",
    10,
    "d".repeat(64),
    "2026-08-10",
  )
  fs.rmSync(doc.dir, { recursive: true, force: true })
  fs.appendFileSync(w.profilePath, "\n# note\n")

  const r = reverifySweep({ db, ...w.opts, pruneOrphans: true })
  assert.deepEqual(r.orphaned, [])
  assert.equal(readVerifications(db, "archived-dev").length, 1)
})
