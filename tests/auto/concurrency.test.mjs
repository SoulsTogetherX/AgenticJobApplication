// W3's falsifiable check: 50 jobs at concurrency 8 (§4.2, §4.11). Phase 5 W3.
//
// The check, in the plan's words: "50 jobs at concurrency 8 with **observed
// max-in-flight === 8**; `durable_attempted_rows === apps_that_reached
// _authorized`; zero orphans."
//
// WHY "OBSERVED", AND WHY THAT WORD IS THE WHOLE TEST. A pool CAPABLE of eight
// that serialises on its exclusion key reports N=1 throughput under an N=8
// label — and that number then becomes the baseline a gate enforces forever.
// §4.2 says the exclusion key is the registrable ORIGIN, so 8 tenants on one
// port are ONE origin and would serialise; the fixture binds eight listeners
// for exactly this reason. The sampled maximum is the only honest measurement.
//
// THE LEDGER EQUALITY IS THE SAFETY HALF. Every job that reached `authorized`
// must have exactly one durable `(slug, mode)` row and no more: one row missing
// is an application nobody can find, one row extra is a slug that can never be
// applied to again. At concurrency 1 the arithmetic is trivially right; the
// only reason to run this at 8 is that it is where it stops being trivial.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { runCampaign } from "../../scripts/auto/auto-apply.mjs"
import { runPool, originCount } from "../../scripts/auto/pool.mjs"
import {
  openDb,
  enqueueAutoJobs,
  recordVerification,
  readAutoQueue,
  readOrphanAttempts,
} from "../../scripts/lib/db.mjs"

const DOC_SHA = "a".repeat(64)
const PROFILE_SHA = "b".repeat(64)
const APPS = 50
const N = 8
const ORIGINS = 8

const LIMITS = {
  auto_apply: {
    enabled: true,
    dry_run: true,
    per_run_max: 999,
    per_day_max: 999,
    per_company_max_per_week: 999,
    board_allowlist: { "127.0.0.1": "greenhouse" },
  },
}

/** 50 jobs spread across 8 distinct origins, as §4.2 requires: the exclusion
 *  key is the ORIGIN, so a queue on one origin can never exceed in-flight 1
 *  however high N is. */
function seed(dir) {
  const dbFile = path.join(dir, "leads.db")
  const db = openDb(dbFile)
  const jobs = []
  for (let i = 0; i < APPS; i++) {
    const port = 9000 + (i % ORIGINS)
    jobs.push({
      slug: `job-${i}`,
      board_key: "greenhouse",
      origin: `http://127.0.0.1:${port}`,
      apply_url: `http://127.0.0.1:${port}/fixture-submit/confirmation`,
    })
  }
  enqueueAutoJobs(db, jobs)
  for (const j of jobs)
    recordVerification(db, {
      slug: j.slug,
      mode: "resume",
      verdict: "pass",
      doc_sha256: DOC_SHA,
      profile_sha256: PROFILE_SHA,
    })
  db.close()
  return { dbFile, jobs }
}

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aj-conc-"))
  const jobsDir = path.join(dir, "jobs")
  const autoDir = path.join(jobsDir, ".auto")
  const profileDir = path.join(dir, "profile")
  fs.mkdirSync(autoDir, { recursive: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, "profile.yaml"), "meta: {}\n")
  fs.writeFileSync(path.join(profileDir, "answers.yaml"), "answers: []\n")
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* a leaked handle must not fail an assertion that already passed */
    }
  })
  return { dir, jobsDir, autoDir, profileDir, ...seed(dir) }
}

/** Stages that take real time, so overlap is possible and measurable. A stage
 *  that returns synchronously would let a serial pool look concurrent. */
const stages = (byUrl) => ({
  openPage: async (url) => ({
    page: {
      url: () => url,
      locator: () => ({ async click() {} }),
      async content() {
        return "<html><body>ok</body></html>"
      },
      async waitForLoadState() {},
    },
    url,
    status: 200,
    close: async () => {},
  }),
  scan: async () => {
    await new Promise((r) => setTimeout(r, 4))
    return {
      kind: "form",
      buttons: [{ k: "b1", l: "Submit application", r: "submit" }],
    }
  },
  plan: async () => {
    await new Promise((r) => setTimeout(r, 4))
    return { items: [{ k: "f1", how: "fill", value: "Xavier" }], defer: [] }
  },
  fill: async () => ({ ok: true, uploads: [], revealed: [] }),
  documentsFor: () => ({
    verification: {
      doc_sha256: DOC_SHA,
      profile_sha256: PROFILE_SHA,
      mode: "resume",
    },
  }),
})

// --- the check ---------------------------------------------------------------

test("50 jobs at concurrency 8: observed max-in-flight IS 8", async (t) => {
  const s = sandbox(t)
  const out = await runCampaign({
    dbFile: s.dbFile,
    limits: LIMITS,
    mode: "dry_run",
    concurrency: N,
    limit: APPS,
    jobs: s.jobs,
    jobsDir: s.jobsDir,
    autoDir: s.autoDir,
    allowLoopbackHttp: true,
    profileApproved: true,
    ...stages(),
  })

  assert.equal(out.origins, ORIGINS, "the queue really does span 8 origins")
  assert.equal(
    out.max_in_flight,
    N,
    `observed max-in-flight was ${out.max_in_flight}, not ${N} — a pool that ` +
      `serialises on its exclusion key reports N=1 under an N=8 label`,
  )
  assert.equal(out.started, APPS, "and every job started")
})

test("durable attempted rows === the jobs that reached authorized", async (t) => {
  const s = sandbox(t)
  const out = await runCampaign({
    dbFile: s.dbFile,
    limits: LIMITS,
    mode: "dry_run",
    concurrency: N,
    limit: APPS,
    jobs: s.jobs,
    jobsDir: s.jobsDir,
    autoDir: s.autoDir,
    allowLoopbackHttp: true,
    profileApproved: true,
    ...stages(),
  })

  const db = openDb(s.dbFile)
  try {
    const rows = db
      .prepare("SELECT slug, mode, outcome FROM auto_submissions")
      .all()
    const submitted = out.results.filter((r) => r.submitted).length

    assert.equal(
      rows.length,
      submitted,
      "one durable row per application, no more and no fewer: a missing row is " +
        "an application nobody can find, an extra one is a slug that can never " +
        "be applied to again",
    )
    assert.equal(
      new Set(rows.map((r) => `${r.slug}|${r.mode}`)).size,
      rows.length,
      "and the (slug, mode) key held under the fan-out",
    )
    assert.equal(
      readOrphanAttempts(db).length,
      0,
      "ZERO ORPHANS — every attempt this run opened was resolved",
    )
  } finally {
    db.close()
  }
})

test("every queued job reaches a TERMINAL state — none is silently dropped", async (t) => {
  // The unlimited-volume property at the pool layer: N bounds the rate, never
  // the total. A job left in `queued` or `claimed` is one the user was never
  // told about.
  const s = sandbox(t)
  await runCampaign({
    dbFile: s.dbFile,
    limits: LIMITS,
    mode: "dry_run",
    concurrency: N,
    limit: APPS,
    jobs: s.jobs,
    jobsDir: s.jobsDir,
    autoDir: s.autoDir,
    allowLoopbackHttp: true,
    profileApproved: true,
    ...stages(),
  })

  const db = openDb(s.dbFile)
  try {
    const rows = readAutoQueue(db)
    assert.equal(rows.length, APPS)
    const stuck = rows.filter((r) => ["queued", "claimed"].includes(r.state))
    assert.deepEqual(
      stuck.map((r) => r.slug),
      [],
      "no job may be left mid-ladder",
    )
    const untyped = rows.filter(
      (r) => r.state !== "submitted" && !r.reason_kind,
    )
    assert.deepEqual(
      untyped.map((r) => r.slug),
      [],
      "and every non-submitted job carries a typed reason (rule 6)",
    )
  } finally {
    db.close()
  }
})

// --- the exclusion key itself --------------------------------------------------

test("50 jobs on ONE origin still all run — serialised, never dropped", async () => {
  // The other half of the same property. `origin` is the exclusion key, so a
  // single-origin queue can never exceed 1 in flight — and must still finish
  // all 50. N is a resource limit the user owns, never a volume limit.
  const jobs = Array.from({ length: APPS }, (_, i) => ({
    slug: `s${i}`,
    origin: "https://one.test",
  }))
  const seen = []
  const out = await runPool({
    jobs,
    concurrency: N,
    runOne: async (j) => {
      await new Promise((r) => setTimeout(r, 1))
      seen.push(j.slug)
      return { slug: j.slug }
    },
  })
  assert.equal(out.max_in_flight, 1, "one origin means one at a time")
  assert.equal(seen.length, APPS, "and all fifty still ran")
  assert.equal(originCount(jobs), 1)
})

test("max-in-flight can never exceed the origin count", async () => {
  // The bound §4.2 states, driven rather than argued: a run of 50 at
  // concurrency 8 across 3 origins can never exceed 3, and without this number
  // that reads as the pool underperforming rather than as the queue being the
  // constraint.
  for (const origins of [1, 2, 3, 5]) {
    const jobs = Array.from({ length: 30 }, (_, i) => ({
      slug: `s${i}`,
      origin: `https://o${i % origins}.test`,
    }))
    const out = await runPool({
      jobs,
      concurrency: N,
      runOne: async () => {
        await new Promise((r) => setTimeout(r, 1))
        return {}
      },
    })
    assert.ok(
      out.max_in_flight <= origins,
      `${origins} origins allowed ${out.max_in_flight} in flight`,
    )
    assert.equal(originCount(jobs), origins)
  }
})

test("two jobs on the same origin are NEVER in flight together", async () => {
  // The C9 hazard at the scheduling layer: Greenhouse's embed flow holds upload
  // and draft state per ORIGIN, so two same-origin jobs overlapping means one
  // tab's resume upload token is overwritable by another's — and the wrong
  // resume goes out, irreversibly, with nothing in any log saying so.
  const inFlight = new Map()
  let overlap = 0
  const jobs = Array.from({ length: 40 }, (_, i) => ({
    slug: `s${i}`,
    origin: `https://o${i % 4}.test`,
  }))
  await runPool({
    jobs,
    concurrency: N,
    runOne: async (j) => {
      if (inFlight.get(j.origin)) overlap += 1
      inFlight.set(j.origin, true)
      await new Promise((r) => setTimeout(r, 2))
      inFlight.set(j.origin, false)
      return {}
    },
  })
  assert.equal(overlap, 0, "same-origin overlap is the C9 hazard, not a nuance")
})

// --- the operator's one line must agree with the durable record --------------
//
// Found by the first dry-run rehearsal against a real board (2026-08-17): the
// run JSONL said `deferred: 1` and stdout said `deferred=0`. Not a formatting
// slip — `runCampaign` returned no tallies AT ALL, so auto-apply.mjs's
// `result.deferred ?? 0` had nothing to read and printed 0 for every run ever
// made. The same line prints `submitted=`, which means a real live submit would
// have reported `submitted=0`: an operator told nothing went out when an
// application just did. That is the one direction this must never fail in.
test("runCampaign's tallies agree with the run's own JSONL", async (t) => {
  const s = sandbox(t)
  const out = await runCampaign({
    dbFile: s.dbFile,
    limits: LIMITS,
    mode: "dry_run",
    concurrency: N,
    limit: APPS,
    jobs: s.jobs,
    jobsDir: s.jobsDir,
    autoDir: s.autoDir,
    allowLoopbackHttp: true,
    profileApproved: true,
    ...stages(),
  })

  const KEYS = ["planned", "submitted", "deferred", "failed"]
  for (const k of KEYS) {
    assert.equal(
      typeof out[k],
      "number",
      `runCampaign must return ${k} — the caller prints it and cannot derive it`,
    )
  }

  const file = path.join(s.autoDir, "runs", `${out.run_id}.jsonl`)
  const events = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
  const finish = events.find((e) => e.t === "run.finish")
  assert.ok(finish, "the run must have written a run.finish event")

  for (const k of KEYS) {
    assert.equal(
      out[k],
      finish[k] ?? 0,
      `${k} disagrees: stdout would print ${out[k]}, the audit log recorded ${finish[k]}`,
    )
  }

  // Without this the agreement could be a vacuous 0 === 0 on every key, which
  // is exactly what the broken version would have passed.
  assert.ok(
    KEYS.some((k) => out[k] > 0),
    `every tally was 0, so the agreement proves nothing: ${JSON.stringify(
      Object.fromEntries(KEYS.map((k) => [k, out[k]])),
    )}`,
  )
})
