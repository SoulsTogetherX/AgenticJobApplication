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
  recordScreens,
  upsertApplications,
  DB_PATH,
} from "../../scripts/lib/db.mjs"
import { detectAts } from "../../scripts/apply/ats/index.mjs"

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

/** A workspace with a resume (markdown AND rendered PDF, unless `pdf: false`),
 *  a job.json, and (optionally) a passing row. The PDF is what the ATS file
 *  input wants; since 2026-08-18 selection refuses a workspace without one
 *  rather than spending a browser lane to defer on it. */
function workspace(
  w,
  slug,
  applyUrl,
  { verified = true, profileSha, pdf = true } = {},
) {
  const dir = path.join(w.jobsDir, slug)
  fs.mkdirSync(dir, { recursive: true })
  const resume = path.join(dir, "resume.md")
  fs.writeFileSync(resume, `# ${slug}\n`)
  if (pdf) fs.writeFileSync(path.join(dir, "resume.pdf"), "%PDF-1.4 stub\n")
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
  // UPDATED 2026-08-03, and the ORIGINAL PROPERTY IS UNCHANGED: the queued URL
  // is still derived from `apply_url` and never from the adzuna `url`, which is
  // what Phase 0.13 is about. What is new is that the adapter now resolves the
  // POSTING to the FORM — the runner used to be handed the ad, scan it, find no
  // fields and defer "nothing to fill" on every board.
  //
  // THE ORIGIN ASSERTION IS THE ONE THAT MATTERS and it is deliberately kept
  // byte-identical: the submit token is bound to this origin and the page must
  // load on it. An earlier version of the mapping hardcoded a different
  // Greenhouse host and moved the job off the allowlisted origin — this line is
  // what caught it.
  assert.equal(
    out.jobs[0].apply_url,
    "https://boards.greenhouse.io/embed/job_app?for=a&token=9",
  )
  assert.equal(out.jobs[0].origin, "https://boards.greenhouse.io")
})

test("resolving the posting to the form NEVER changes the origin", () => {
  // The invariant behind the assertion above, checked directly across every
  // adapter rather than incidentally through one fixture. The submit token is
  // bound to the posting's origin; a mapping that moves the page to another
  // host produces a token that can never be spent, and a board the user
  // allowlisted that the trust gate then refuses.
  for (const posting of [
    "https://boards.greenhouse.io/acme/jobs/9",
    "https://job-boards.greenhouse.io/coinbase/jobs/8022068",
    "https://jobs.ashbyhq.com/render/88cb74a4-bc28-40b1-b792-d3041e3e17d3",
    "https://jobs.lever.co/acme/abc-123",
  ]) {
    const adapter = detectAts(posting)
    const form = adapter.applicationUrl(posting)
    assert.notEqual(form, posting, `${posting} must resolve to a form URL`)
    assert.equal(
      new URL(form).origin,
      new URL(posting).origin,
      `${adapter.id} moved the application off the posting's origin`,
    )
  }
})

test("an unrecognised URL shape is returned untouched, never guessed at", () => {
  // Knowledge, not behaviour: an adapter that cannot recognise a path must hand
  // it back rather than invent one. A rewritten URL that 404s is worse than the
  // original, because the runner reports "no fields" instead of "wrong page".
  for (const url of [
    "https://boards.greenhouse.io/acme/jobs/9/extra/segments",
    "https://jobs.ashbyhq.com/render",
    "https://example.com/careers/apply",
  ]) {
    const adapter = detectAts(url)
    const mapped = adapter.applicationUrl ? adapter.applicationUrl(url) : url
    assert.equal(mapped, url)
  }
})

// ---------------------------------------------------------------------------
// WHERE A SCREENING VERDICT ACTUALLY LIVES
//
// THE DEFECT, MEASURED ON THE REAL STORE 2026-08-03. `selectEligible` read the
// verdict as `lead.screening ?? lead.screen` — off the lead's own JSON doc.
// `screen.mjs` does not write it there. It writes to the `screens` TABLE, keyed
// by (lead_id, source). So on the user's real store every lead looked
// unscreened, the trust gate refused all of them, and `auto-apply` reported
// "nothing eligible (10 considered, 10 rejected)" minutes after screening had
// written 27 verdicts. Eligible went 0 -> 3 when the lookup was corrected.
//
// WHY THE SUITE WAS GREEN THROUGH ALL OF IT, and this is the part worth
// remembering: the `lead()` helper above puts `screening` INSIDE the lead doc.
// That is a shape the production writer never produces, so every test here was
// asserting against a fiction — a fixture is an assertion about the code,
// written in data, and this one had been wrong since the check was added.
//
// These tests therefore use the REAL writer, `recordScreens`, and never the
// helper. If someone "simplifies" them back onto the helper, the bug returns
// and the suite goes green again.
// ---------------------------------------------------------------------------

function screenedLead(w, slug, applyUrl, verdict = "pass", extra = {}) {
  const db = openDb(w.dbFile)
  upsertLeads(db, [
    {
      id: slug,
      slug,
      url: applyUrl,
      apply_url: applyUrl,
      company: "Acme",
      title: "Full-Stack Engineer",
      // DELIBERATELY ABSENT: no `screening` key on the doc. That is the whole
      // point — this is what a lead written by the real ingest looks like.
    },
  ])
  recordScreens(db, [
    { lead_id: slug, source: "mechanical", verdict, ...extra },
  ])
  db.close()
}

test("a verdict in the screens TABLE makes a lead eligible — the doc key is not where it lives", (t) => {
  const w = world(t)
  workspace(w, "screened-job", "https://boards.greenhouse.io/a/jobs/1")
  screenedLead(w, "screened-job", "https://boards.greenhouse.io/a/jobs/1")

  const db = openDb(w.dbFile)
  const out = selectEligible({ db, limits: LIMITS, jobsDir: w.jobsDir })
  db.close()

  assert.deepEqual(
    out.jobs.map((j) => j.slug),
    ["screened-job"],
    `the verdict is in the screens table and must be found there. ` +
      `Rejections: ${JSON.stringify(out.rejected)}`,
  )
})

test("the verdict RIDES ONTO the job, because authorizeSubmit refuses an unscreened lead", (t) => {
  // Finding the verdict is only half of it. runCampaign seeds its per-job
  // context from exactly these objects and hands `screening` to
  // authorizeSubmit, which refuses outright when it is null — so a job that
  // cleared the trust gate here would have been refused one stage later, for
  // the same wrong reason, with a different message.
  const w = world(t)
  workspace(w, "screened-job", "https://boards.greenhouse.io/a/jobs/1")
  screenedLead(w, "screened-job", "https://boards.greenhouse.io/a/jobs/1")

  const db = openDb(w.dbFile)
  const out = selectEligible({ db, limits: LIMITS, jobsDir: w.jobsDir })
  db.close()
  assert.equal(out.jobs[0]?.screening?.verdict, "pass")
})

test("a REJECT verdict in the table still rejects — the lookup did not become a rubber stamp", (t) => {
  // The failure mode of "find the verdict" is finding one and not reading it.
  const w = world(t)
  workspace(w, "bad-job", "https://boards.greenhouse.io/a/jobs/1")
  screenedLead(w, "bad-job", "https://boards.greenhouse.io/a/jobs/1", "reject")

  const db = openDb(w.dbFile)
  const out = selectEligible({ db, limits: LIMITS, jobsDir: w.jobsDir })
  db.close()
  assert.deepEqual(out.jobs, [])
  assert.match(out.rejected[0].reason, /screening rejected/i)
})

test("a lead with NO row in the screens table is still refused", (t) => {
  // The safe direction, and the one the fix must not have widened: an
  // unscreened posting is exactly what hard rule 0 is about, and "we could not
  // find a verdict" must never read as "there was nothing to find".
  const w = world(t)
  workspace(w, "unscreened", "https://boards.greenhouse.io/a/jobs/1")
  const db = openDb(w.dbFile)
  upsertLeads(db, [
    {
      id: "unscreened",
      slug: "unscreened",
      url: "https://boards.greenhouse.io/a/jobs/1",
      apply_url: "https://boards.greenhouse.io/a/jobs/1",
      company: "Acme",
      title: "Full-Stack Engineer",
    },
  ])
  const out = selectEligible({ db, limits: LIMITS, jobsDir: w.jobsDir })
  db.close()
  assert.deepEqual(out.jobs, [])
  assert.match(out.rejected[0].reason, /no stored screening verdict/)
})

test("a MODEL verdict wins over the mechanical one", (t) => {
  // Both are legitimate inputs — risk.mjs records a disqualifying finding as an
  // `injection_attempt:<kind>` reason in either — but the model screen fetched
  // the live posting and judged ghost/scam signals the regex pass cannot see.
  // When both exist, the expensive one is the answer.
  const w = world(t)
  workspace(w, "both", "https://boards.greenhouse.io/a/jobs/1")
  screenedLead(w, "both", "https://boards.greenhouse.io/a/jobs/1", "pass")
  const db = openDb(w.dbFile)
  recordScreens(db, [{ lead_id: "both", source: "model", verdict: "reject" }])
  const out = selectEligible({ db, limits: LIMITS, jobsDir: w.jobsDir })
  db.close()
  assert.deepEqual(out.jobs, [], "the model verdict must decide")
})

// --- already-applied postings never enter the queue --------------------------
//
// The cheap half of the duplicate guard; the load-bearing copy is the submit
// gate's `not_already_applied`, because a row already in auto_queue is resumed
// without passing through selection at all. This half stops a posting the user
// already pursued from costing a browser lane and ~26 s of real form-filling
// before being refused at the end.

test("a posting already applied to is not selected, and says why", (t) => {
  const w = world(t)
  workspace(w, "ok-job", "https://boards.greenhouse.io/a/jobs/1")
  lead(w, "ok-job", "https://boards.greenhouse.io/a/jobs/1")
  const db = openDb(w.dbFile)
  upsertApplications(db, [
    {
      slug: "ok-job",
      company: "Acme",
      title: "Developer",
      applied_at: "2026-08-05",
      status: "applied",
    },
  ])
  const out = selectEligible({ db, limits: LIMITS, jobsDir: w.jobsDir })
  db.close()

  assert.deepEqual(out.jobs, [], "a duplicate must not be enqueued")
  assert.equal(out.rejected.length, 1, "and it must be REPORTED, not dropped")
  assert.match(out.rejected[0].reason, /already applied on 2026-08-05/)
})

test("selection is unchanged for a posting with no prior application", (t) => {
  const w = world(t)
  workspace(w, "ok-job", "https://boards.greenhouse.io/a/jobs/1")
  lead(w, "ok-job", "https://boards.greenhouse.io/a/jobs/1")
  const db = openDb(w.dbFile)
  // A recorded application for a DIFFERENT posting must not suppress this one —
  // the guard keys on the posting, never on the employer.
  upsertApplications(db, [
    {
      slug: "some-other-job",
      company: "Acme",
      title: "Developer",
      applied_at: "2026-08-05",
      status: "applied",
    },
  ])
  const out = selectEligible({ db, limits: LIMITS, jobsDir: w.jobsDir })
  db.close()

  assert.equal(out.jobs.length, 1, "an unapplied posting is still eligible")
  assert.equal(out.jobs[0].slug, "ok-job")
})

// ---------------------------------------------------------------------------
// TWO MORE THINGS SELECTION REFUSES BEFORE SPENDING A BROWSER (2026-08-18).
// Both were measured on the 2026-08-17 live run: a Coinbase posting the store
// already marked `dismissed` was queued off its verification row and scanned an
// empty page; two workspaces with a passing verification and no resume.pdf were
// queued and deferred "no rendered resume" after a full page load each.
// ---------------------------------------------------------------------------

test("a lead whose status is dismissed is not selected, and says why", (t) => {
  const w = world(t)
  workspace(w, "closed-job", "https://boards.greenhouse.io/a/jobs/1")
  const db = openDb(w.dbFile)
  upsertLeads(db, [
    {
      id: "closed-job",
      slug: "closed-job",
      url: "https://boards.greenhouse.io/a/jobs/1",
      apply_url: "https://boards.greenhouse.io/a/jobs/1",
      company: "Acme",
      title: "Full-Stack Engineer",
      status: "dismissed",
      screening: { verdict: "pass", findings: [] },
    },
  ])
  const out = selectEligible({ db, limits: LIMITS, jobsDir: w.jobsDir })
  db.close()
  assert.deepEqual(out.jobs, [])
  assert.equal(out.rejected.length, 1, "reported, not silently dropped")
  assert.match(out.rejected[0].reason, /dismissed/)
})

test("a workspace whose resume.pdf is not rendered is not selected, and names the fix", (t) => {
  const w = world(t)
  workspace(w, "unrendered-job", "https://boards.greenhouse.io/a/jobs/1", {
    pdf: false,
  })
  lead(w, "unrendered-job", "https://boards.greenhouse.io/a/jobs/1")
  const db = openDb(w.dbFile)
  const out = selectEligible({ db, limits: LIMITS, jobsDir: w.jobsDir })
  db.close()
  assert.deepEqual(out.jobs, [])
  assert.match(out.rejected[0].reason, /resume\.pdf is not rendered/)
  assert.match(out.rejected[0].reason, /render-pdf/)
})

test("a selected job carries the lead id, so a resumed row can re-read its screening verdict", (t) => {
  const w = world(t)
  workspace(w, "ok-job", "https://boards.greenhouse.io/a/jobs/1")
  lead(w, "ok-job", "https://boards.greenhouse.io/a/jobs/1")
  const db = openDb(w.dbFile)
  const out = selectEligible({ db, limits: LIMITS, jobsDir: w.jobsDir })
  db.close()
  assert.equal(out.jobs[0].lead_id, "ok-job")
  assert.equal(out.jobs[0].company, "Acme")
  assert.equal(out.jobs[0].title, "Full-Stack Engineer")
})
