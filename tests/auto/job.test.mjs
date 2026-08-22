// The per-job state machine (§4.4).
//
// The property every test here is really about: EVERY EXIT IS TYPED. There is
// no path out of runJob that leaves a job without a reason_kind from the closed
// taxonomy — except `submitted`, which has nothing to explain. Hard rule 6: a
// silent skip is not a deferral, and a job that vanished from the queue with no
// kind is the shape of loss the defer taxonomy exists to make impossible.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { runJob, NOT_CLAIMED } from "../../scripts/auto/job.mjs"
import { startRun } from "../../scripts/auto/audit.mjs"
import {
  openDb,
  recordVerification,
  enqueueAutoJobs,
  claimAutoJob,
  AUTO_DEFER_KINDS,
  AUTO_FAILURE_KINDS,
} from "../../scripts/lib/db.mjs"

const SLUG = "acme-fullstack"
const APPLY_URL = "http://127.0.0.1:4599/boards.greenhouse.io/e/jobs/1"
const ORIGIN = "http://127.0.0.1:4599"
const DOC_SHA = "a".repeat(64)
const PROFILE_SHA = "b".repeat(64)

const LIMITS = {
  auto_apply: {
    enabled: true,
    dry_run: true,
    per_run_max: 10,
    per_day_max: 10,
    per_company_max_per_week: 5,
    board_allowlist: { "127.0.0.1": "greenhouse" },
  },
}

const KNOWN_KINDS = new Set([...AUTO_DEFER_KINDS, ...AUTO_FAILURE_KINDS])

function rig(t, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aj-job-"))
  const dbFile = path.join(dir, "leads.db")
  const jobsDir = path.join(dir, "jobs")
  const autoDir = path.join(jobsDir, ".auto")
  fs.mkdirSync(autoDir, { recursive: true })

  const db = openDb(dbFile)
  recordVerification(db, {
    slug: SLUG,
    mode: "resume",
    verdict: "pass",
    doc_sha256: DOC_SHA,
    profile_sha256: PROFILE_SHA,
  })
  // The run's mode follows the job's: a live job under a dry-run run is a
  // token-mode mismatch by design (audit.mjs beginSubmit), not a test setup.
  const run = startRun({
    mode: over.mode === "live" ? "live" : "dry_run",
    dbFile,
    autoDir,
  })

  t.after(() => {
    try {
      run.finish({ outcome: "ok" })
    } catch {
      /* a run left open by a failing assertion must not mask it */
    }
    try {
      db.close()
    } catch {
      /* already closed */
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* a leaked handle must not fail a passing assertion */
    }
  })

  const opened = []
  const base = {
    db,
    run,
    job: { slug: SLUG, board_key: "greenhouse:e", origin: ORIGIN },
    lead: { slug: SLUG, apply_url: APPLY_URL, company: "Acme" },
    limits: LIMITS,
    screening: { verdict: "pass", findings: [] },
    mode: "dry_run",
    allowLoopbackHttp: true,
    profileApproved: true,
    dbFile,
    documents: {
      verification: {
        doc_sha256: DOC_SHA,
        profile_sha256: PROFILE_SHA,
        mode: "resume",
      },
    },
    openPage: async (url) => {
      opened.push(url)
      return {
        page: {
          url: () => url,
          locator: () => ({
            async click() {
              assert.fail("a dry run must never reach a click")
            },
          }),
        },
        url,
        status: 200,
        close: async () => {},
      }
    },
    scan: async () => ({
      url: APPLY_URL,
      kind: "form",
      buttons: [{ k: "b1", l: "Submit application", r: "submit" }],
    }),
    plan: async () => ({
      items: [{ k: "f1", how: "fill", value: "Xavier" }],
      defer: [],
    }),
    fill: async () => ({ ok: true, uploads: [], revealed: [] }),
    sleep: async () => {},
    ...over,
  }
  return { dir, dbFile, db, run, base, opened }
}

const queue = (db) =>
  db.prepare("SELECT * FROM auto_queue WHERE slug = ?").get(SLUG)

test("the happy dry-run path reaches submitted with no reason to explain", async (t) => {
  const r = rig(t)
  const out = await runJob(r.base)
  assert.equal(out.state, "submitted")
  assert.equal(out.kind, null)
  const row = queue(r.db)
  assert.equal(row.state, "submitted")
  assert.equal(row.reason_kind, null)
})

// --- the duration reaches the row, on every exit ---------------------------
//
// runJob has returned `wall_ms` since it existed and persisted it nowhere, so
// the digest had no per-job sample and reported n=0. The return value and the
// column must be the SAME number: a caller that trusts one and a digest that
// reads the other would disagree about the same job.

test("a submitted job records how long it took, in the row", async (t) => {
  const r = rig(t)
  const out = await runJob(r.base)
  assert.equal(out.state, "submitted")
  const row = queue(r.db)
  assert.ok(
    Number.isInteger(row.wall_ms) && row.wall_ms >= 0,
    `the queue row must carry a duration, got ${JSON.stringify(row.wall_ms)}`,
  )
  assert.ok(
    Math.abs(row.wall_ms - out.wall_ms) <= 10,
    `the row (${row.wall_ms}ms) and the return value (${out.wall_ms}ms) must ` +
      "be the same measurement",
  )
})

test("a job that ended at a deferral records its duration too, with the stage", async (t) => {
  // THE FAILURE ARM, and the one that matters more: a defer is the common
  // outcome, so timing only the successes would measure the fast half of the
  // distribution and call it the distribution.
  const r = rig(t, {
    limits: { auto_apply: { ...LIMITS.auto_apply, board_allowlist: {} } },
  })
  const out = await runJob(r.base)
  assert.equal(out.state, "deferred")
  const row = queue(r.db)
  assert.ok(
    Number.isInteger(row.wall_ms) && row.wall_ms >= 0,
    "a deferred job is still a job that took time",
  )
  assert.equal(
    row.reason_stage,
    "claim",
    "and the stage it stopped at is what makes the duration attributable",
  )
})

test("the loser of a claim race writes no duration onto the winner's row", async (t) => {
  const r = rig(t)
  enqueueAutoJobs(r.db, [{ slug: SLUG, origin: ORIGIN }])
  claimAutoJob(r.db, SLUG, { run_id: "someone-else", origin: ORIGIN })
  const out = await runJob(r.base)
  assert.equal(out.state, NOT_CLAIMED)
  assert.equal(
    queue(r.db).wall_ms,
    null,
    "not-claimed does no work; a duration here would be this worker timing " +
      "somebody else's job",
  )
})

test("the trust gate runs BEFORE the browser opens", async (t) => {
  // Deliberately first: a board the user has not allowlisted costs one row and
  // no page load, which is what makes the gate cheap enough to be strict.
  // Running it after the scan would spend a navigation on every untrusted
  // board in the queue.
  const r = rig(t, {
    limits: { auto_apply: { ...LIMITS.auto_apply, board_allowlist: {} } },
  })
  const out = await runJob(r.base)
  assert.equal(out.state, "deferred")
  assert.equal(out.kind, "board-untrusted")
  assert.equal(out.stage, "claim")
  assert.deepEqual(r.opened, [], "no page was opened for an untrusted board")
})

test("0 changes from the claim is the ordinary fan-out result, not an error", async (t) => {
  const r = rig(t)
  // Another worker got there first.
  enqueueAutoJobs(r.db, [{ slug: SLUG, origin: ORIGIN }])
  claimAutoJob(r.db, SLUG, { run_id: "someone-else", origin: ORIGIN })

  const out = await runJob(r.base)
  assert.equal(out.state, NOT_CLAIMED)
  const row = queue(r.db)
  assert.equal(
    row.run_id,
    "someone-else",
    "the loser must not overwrite the owner's row — including its reason",
  )
  assert.equal(row.state, "claimed")
})

test("a navigation failure retries with backoff, then types the loss", async (t) => {
  let attempts = 0
  const waits = []
  const r = rig(t, {
    openPage: async () => {
      attempts += 1
      throw new Error("net::ERR_CONNECTION_REFUSED")
    },
    sleep: async (ms) => waits.push(ms),
    navRetries: 2,
    navBackoffMs: 100,
  })
  const out = await runJob(r.base)
  assert.equal(attempts, 3, "the initial attempt plus two retries")
  assert.deepEqual(waits, [100, 200], "backoff grows; it is not a busy retry")
  assert.equal(out.state, "failed")
  assert.equal(out.kind, "nav-timeout")
  assert.equal(queue(r.db).reason_kind, "nav-timeout")
})

test("a retried navigation that succeeds is not a failure", async (t) => {
  let attempts = 0
  const r = rig(t)
  const flaky = {
    ...r.base,
    openPage: async (url) => {
      attempts += 1
      if (attempts === 1) throw new Error("net::ERR_CONNECTION_RESET")
      return {
        page: { url: () => url, locator: () => ({ click: async () => {} }) },
        url,
        status: 200,
        close: async () => {},
      }
    },
    sleep: async () => {},
  }
  const out = await runJob(flaky)
  assert.equal(out.state, "submitted")
  assert.equal(attempts, 2)
})

test("a taken-down posting is the board's event, not our malfunction", async (t) => {
  const r = rig(t)
  const gone = {
    ...r.base,
    openPage: async (url) => ({
      page: { url: () => url, locator: () => ({ click: async () => {} }) },
      url,
      status: 404,
      close: async () => {},
    }),
  }
  const out = await runJob(gone)
  assert.equal(out.state, "deferred", "a 404 is a defer, never a run-stopper")
  assert.equal(out.kind, "posting-gone")
})

test("a deferred field is typed by the shipped taxonomy, not by this file", async (t) => {
  const r = rig(t, {
    plan: async () => ({
      items: [],
      defer: [{ k: "f2", l: "I agree to the terms", why: "consent" }],
    }),
  })
  const out = await runJob(r.base)
  assert.equal(out.state, "deferred")
  assert.equal(out.kind, "consent-tickbox")
  assert.equal(out.stage, "plan")
})

test("the page is closed even when the job defers", async (t) => {
  // The per-job disposal unit is created and UNCONDITIONALLY closed per job. A
  // leaked context is a leaked cookie jar.
  let closed = 0
  const r = rig(t, {
    openPage: async (url) => ({
      page: { url: () => url, locator: () => ({ click: async () => {} }) },
      url,
      status: 200,
      close: async () => {
        closed += 1
      },
    }),
    plan: async () => ({ items: [], defer: [{ k: "f2", why: "consent" }] }),
  })
  await runJob(r.base)
  assert.equal(closed, 1)
})

test("an empty page 1 that offers 'next' is a DEFER (unknown-field), not a plan-error — the Coinbase shape", async (t) => {
  // Measured 2026-08-17: a closed posting rendered no fields and a next-shaped
  // control. The walk minted a token, the gate said "nothing to fill", and the
  // row was written as plan-error — a malfunction that fed the breaker. Nothing
  // malfunctioned; the runner was on the wrong page.
  const r = rig(t, {
    scan: async () => ({
      url: APPLY_URL,
      kind: "form",
      fields: [],
      buttons: [{ k: "b1", l: "Apply", r: "next" }],
    }),
    plan: async () => ({ items: [], defer: [] }),
  })
  const out = await runJob(r.base)
  assert.equal(out.state, "deferred")
  assert.equal(out.kind, "unknown-field")
  assert.match(out.detail, /wrong page/)
  assert.equal(queue(r.db).reason_kind, "unknown-field")
})

test("a mid-walk authorisation refusal is typed through CHECK_TO_KIND, exactly like the final gate", async (t) => {
  // Three pages; page 2's plan is empty and page 2 still offers Next, so the
  // per-page authorisation refuses `submit_readiness` before that Next click.
  // That check maps to unknown-field at the final gate, and must map to the
  // same thing here — it used to reach the row as a blanket plan-error.
  let scans = 0
  const r = rig(t, {
    mode: "live",
    limits: { auto_apply: { ...LIMITS.auto_apply, dry_run: false } },
    scan: async () => {
      scans += 1
      return {
        url: APPLY_URL,
        kind: "form",
        buttons:
          scans < 3
            ? [{ k: `n${scans}`, l: "Save and Continue", r: "next" }]
            : [{ k: "b1", l: "Submit application", r: "submit" }],
      }
    },
    plan: async ({ page }) => ({
      items: page === 1 ? [{ k: "f1", how: "fill", value: "X" }] : [],
      defer: [],
    }),
    openPage: async (url) => ({
      page: {
        url: () => url,
        locator: () => ({
          async click() {
            /* the Next click on page 1 */
          },
          async waitFor() {},
        }),
        async waitForLoadState() {},
      },
      url,
      status: 200,
      close: async () => {},
    }),
  })
  const out = await runJob(r.base)
  assert.equal(out.state, "deferred", out.detail)
  assert.equal(out.kind, "unknown-field")
  assert.match(out.detail, /page 2 could not be authorised/)
})

// --- the sightedness gate (2026-08-18) -------------------------------------------

test("LIVE on a host with no captured confirmation page defers board-unsighted BEFORE any scan — nothing is typed into the form", async (t) => {
  // The allowlist and the evidence list are different lists. This host clears
  // the trust gate (127.0.0.1 is allowlisted in LIMITS) and is then declared
  // blind by the injected predicate — the shape of jobs.lever.co on 2026-08-17.
  let scanned = 0
  const r = rig(t, {
    mode: "live",
    limits: { auto_apply: { ...LIMITS.auto_apply, dry_run: false } },
    hostSighted: () => false,
    scan: async () => {
      scanned += 1
      return { url: APPLY_URL, kind: "form", buttons: [] }
    },
  })
  const out = await runJob(r.base)
  assert.equal(out.state, "deferred")
  assert.equal(out.kind, "board-unsighted")
  assert.equal(out.stage, "plan")
  assert.match(out.detail, /no captured post-submit page/)
  assert.match(out.detail, /capture-post-submit/)
  assert.equal(
    scanned,
    0,
    "the page was opened (redirects followed) but never scanned or filled",
  )
  assert.equal(r.opened.length, 1, "one navigation, to learn the live host")
})

test("a DRY RUN on the same blind host proceeds — nothing is clicked, so nothing needs reading", async (t) => {
  const r = rig(t, { hostSighted: () => false }) // mode: dry_run
  const out = await runJob(r.base)
  assert.equal(out.state, "submitted", out.detail)
})

test("LIVE on a SIGHTED host proceeds past the gate", async (t) => {
  let scanned = 0
  const r = rig(t, {
    mode: "live",
    limits: { auto_apply: { ...LIMITS.auto_apply, dry_run: false } },
    hostSighted: () => true,
    classify: () => ({ kind: "confirmation", rule: "test" }),
    scan: async () => {
      scanned += 1
      return {
        url: APPLY_URL,
        kind: "form",
        buttons: [{ k: "b1", l: "Submit application", r: "submit" }],
      }
    },
    openPage: async (url) => ({
      page: {
        url: () => url,
        locator: () => ({ async click() {}, async waitFor() {} }),
        async waitForLoadState() {},
        async content() {
          return "<html><body>Thanks</body></html>"
        },
      },
      url,
      status: 200,
      close: async () => {},
    }),
  })
  const out = await runJob(r.base)
  assert.equal(scanned, 1, "the gate let it through to the scan")
  assert.equal(out.state, "submitted", out.detail)
})

test("the default predicate is the shipped classifier's own evidence — a loopback host is sighted for the fixture harness", async (t) => {
  // No hostSighted injected: isHostSighted from classify.mjs decides. The
  // fixture rules ship a loopback confirmation, so a 127.0.0.1 live run reaches
  // the scan; that is what keeps browser-leg.test.mjs and the bench honest.
  let scanned = 0
  const r = rig(t, {
    mode: "live",
    limits: { auto_apply: { ...LIMITS.auto_apply, dry_run: false } },
    classify: () => ({
      kind: "confirmation",
      rule: "fixture-application-received",
    }),
    scan: async () => {
      scanned += 1
      return {
        url: APPLY_URL,
        kind: "form",
        buttons: [{ k: "b1", l: "Submit application", r: "submit" }],
      }
    },
    openPage: async (url) => ({
      page: {
        url: () => url,
        locator: () => ({ async click() {}, async waitFor() {} }),
        async waitForLoadState() {},
        async content() {
          return "<html><body>Thanks</body></html>"
        },
      },
      url,
      status: 200,
      close: async () => {},
    }),
  })
  const out = await runJob(r.base)
  assert.equal(scanned, 1)
  assert.equal(out.state, "submitted", out.detail)
})

test("a stage that throws is caught and typed — it never takes the worker down", async (t) => {
  // The pool has N-1 other jobs behind this one, and an uncaught throw strands
  // every one of them.
  const r = rig(t, {
    scan: async () => {
      throw new Error("the scanner exploded")
    },
  })
  const out = await runJob(r.base)
  assert.equal(out.state, "failed")
  assert.equal(out.kind, "plan-error")
  assert.match(out.detail, /exploded/)
})

test("every typed exit uses a kind from the closed taxonomy", async (t) => {
  // The generic guard: whatever route a job takes out, the kind it carries has
  // to be one the digest can count. An unknown kind is rejected at write time
  // rather than stored under a name nobody chose.
  const cases = [
    rig(t, {
      limits: { auto_apply: { ...LIMITS.auto_apply, board_allowlist: {} } },
    }),
    rig(t, { plan: async () => ({ items: [], defer: [{ why: "captcha" }] }) }),
    rig(t, {
      scan: async () => {
        throw new Error("boom")
      },
    }),
    rig(t, {
      openPage: async () => {
        throw new Error("nope")
      },
      navRetries: 0,
    }),
  ]
  for (const c of cases) {
    const out = await runJob(c.base)
    assert.ok(
      KNOWN_KINDS.has(out.kind),
      `"${out.kind}" is not in the closed taxonomy`,
    )
    assert.ok(out.detail, "and it carries a stated, actionable reason")
  }
})

// --- every submit check must map to a truthful kind --------------------------

test("CHECK_TO_KIND covers every SUBMIT_CHECKS entry", async () => {
  // `CHECK_TO_KIND.get(first) ?? "plan-error"` means an unmapped check name is
  // reported as a MALFUNCTION. That is not a hypothetical: `not_already_applied`
  // was added to SUBMIT_CHECKS and, until this gate existed, would have made
  // every duplicate-application refusal read as `plan-error` — sending someone
  // to debug the runner over a stale queue row.
  //
  // The fallback stays, because a crash is worse than a wrong label. This test
  // is what keeps the fallback from being how new checks are reported.
  const { CHECK_TO_KIND } = await import("../../scripts/auto/job.mjs")
  const { SUBMIT_CHECKS } = await import("../../scripts/auto/authorize.mjs")
  const { AUTO_DEFER_KINDS, AUTO_FAILURE_KINDS } =
    await import("../../scripts/lib/db.mjs")

  const unmapped = SUBMIT_CHECKS.filter((c) => !CHECK_TO_KIND.has(c))
  assert.deepEqual(
    unmapped,
    [],
    `these submit checks would be reported as plan-error: ${unmapped.join(", ")}`,
  )

  // And each mapped kind must be a real one, or reasonRecord throws at the
  // moment the check finally fires — which is the worst possible time.
  const known = new Set([...AUTO_DEFER_KINDS, ...AUTO_FAILURE_KINDS])
  for (const [check, kind] of CHECK_TO_KIND) {
    assert.ok(
      known.has(kind),
      `${check} maps to "${kind}", which is not in the closed taxonomy`,
    )
  }
})

test("a duplicate refusal is reported as already-applied, not a malfunction", async () => {
  const { CHECK_TO_KIND } = await import("../../scripts/auto/job.mjs")
  const { reasonClass } = await import("../../scripts/auto/taxonomy.mjs")
  const kind = CHECK_TO_KIND.get("not_already_applied")
  assert.equal(kind, "already-applied")
  assert.equal(
    reasonClass(kind),
    "policy",
    "a posting the user already applied to is our rule deciding, not a fault",
  )
})

// --- scoped STOPs defer one scope; only a global STOP stops the run --------
//
// The brake's own message promises "Only this company is held back; everything
// else keeps running", and until 2026-08-22 runJob's unconditional re-throw
// broke it: one company STOP rejected the pool's Promise.all and stranded
// every queued job behind it, twice in one day. These three tests are the
// contract: company/board scope converts to a typed deferral at the runJob
// boundary; global scope still throws, because that STOP means stop.

test("a company-scoped STOP defers the job as company-stopped, throwing nothing", async (t) => {
  const { StopError, scopedStopPath } = await import(
    "../../scripts/auto/guard.mjs"
  )
  const r = rig(t)
  const stopPath = path.join(r.dir, "jobs", ".auto", "STOP")
  const brake = scopedStopPath("company", "Acme", { stopPath })
  fs.mkdirSync(path.dirname(brake), { recursive: true })
  fs.writeFileSync(brake, "orphaned attempt under adjudication")

  const out = await runJob({
    ...r.base,
    job: { ...r.base.job, company: "Acme" },
  })
  assert.equal(out.state, "deferred")
  assert.equal(out.kind, "company-stopped")
  assert.match(
    out.detail,
    /company-scoped STOP/,
    "the detail must name the scope",
  )
  assert.ok(
    out.detail.includes("stops"),
    `the detail must point at the brake file to delete, got: ${out.detail}`,
  )
  const row = queue(r.db)
  assert.equal(row.state, "deferred")
  assert.equal(row.reason_kind, "company-stopped")
})

test("a board-scoped STOP defers the job as board-stopped", async (t) => {
  const { scopedStopPath } = await import("../../scripts/auto/guard.mjs")
  const r = rig(t)
  const stopPath = path.join(r.dir, "jobs", ".auto", "STOP")
  const brake = scopedStopPath("board", "greenhouse:e", { stopPath })
  fs.mkdirSync(path.dirname(brake), { recursive: true })
  fs.writeFileSync(brake, "board held for review")

  const out = await runJob({
    ...r.base,
    job: { ...r.base.job, company: "Acme" },
  })
  assert.equal(out.state, "deferred")
  assert.equal(out.kind, "board-stopped")
  const row = queue(r.db)
  assert.equal(row.reason_kind, "board-stopped")
})

test("a global STOP still throws StopError out of runJob — it means stop", async (t) => {
  const { StopError } = await import("../../scripts/auto/guard.mjs")
  const r = rig(t)
  // Written AFTER startRun (the rig already passed the run-start checkpoint),
  // so the between-jobs checkpoint inside runJob is what reads it.
  const stopPath = path.join(r.dir, "jobs", ".auto", "STOP")
  fs.writeFileSync(stopPath, "user pulled the brake")

  await assert.rejects(
    runJob({ ...r.base, job: { ...r.base.job, company: "Acme" } }),
    (e) => e instanceof StopError && e.scope === "global",
    "a global STOP is not a per-job condition and must abort the run",
  )
})

// --- the stamp-lost re-scan seam -------------------------------------------
//
// Greenhouse's embed remounts after an upload and kills every stamp, so the
// scan handed to submitOnce can describe a document that no longer exists.
// submitOnce's liveness check throws SubmitStampLost BEFORE anything durable;
// runJob re-scans ONCE (scan only — no plan, no fill) and retries. Torc failed
// this exact way three times before the seam existed.

test("a dead submit stamp triggers ONE re-scan, and the retry submits", async (t) => {
  let scans = 0
  const r = rig(t, {
    mode: "live",
    limits: { auto_apply: { ...LIMITS.auto_apply, dry_run: false } },
    hostSighted: () => true,
    classify: () => ({ kind: "confirmation", rule: "test" }),
    scan: async () => {
      scans += 1
      return {
        url: APPLY_URL,
        kind: "form",
        // The remount gave the fresh scan a different stamp key.
        buttons: [
          { k: scans === 1 ? "b1" : "b2", l: "Submit application", r: "submit" },
        ],
      }
    },
    openPage: async (url) => ({
      page: {
        url: () => url,
        locator: (sel) => ({
          async click() {},
          async waitFor() {
            // b1 died with the remount; b2 is the re-scan's live stamp.
            if (sel.includes("b1")) throw new Error("Timeout waiting for " + sel)
          },
        }),
        async waitForLoadState() {},
        async content() {
          return "<html><body>Thanks</body></html>"
        },
      },
      url,
      status: 200,
      close: async () => {},
    }),
  })
  const out = await runJob(r.base)
  assert.equal(out.state, "submitted", out.detail)
  assert.equal(scans, 2, "exactly one re-scan")
  const subs = r.db
    .prepare("SELECT COUNT(*) AS n FROM auto_submissions WHERE slug = ?")
    .get(SLUG)
  assert.equal(subs.n, 1, "one attempt row, from the successful retry only")
})

test("a stamp still dead after the re-scan defers as submit-control-lost with a clean ledger", async (t) => {
  let scans = 0
  const r = rig(t, {
    mode: "live",
    limits: { auto_apply: { ...LIMITS.auto_apply, dry_run: false } },
    hostSighted: () => true,
    classify: () => ({ kind: "confirmation", rule: "test" }),
    scan: async () => {
      scans += 1
      return {
        url: APPLY_URL,
        kind: "form",
        buttons: [{ k: "b1", l: "Submit application", r: "submit" }],
      }
    },
    openPage: async (url) => ({
      page: {
        url: () => url,
        locator: () => ({
          async click() {
            assert.fail("a job whose stamp never resolves must not click")
          },
          async waitFor() {
            throw new Error("Timeout — the stamp never came back")
          },
        }),
        async waitForLoadState() {},
        async content() {
          return "<html><body></body></html>"
        },
      },
      url,
      status: 200,
      close: async () => {},
    }),
  })
  const out = await runJob(r.base)
  assert.equal(out.state, "deferred", out.detail)
  assert.equal(out.kind, "submit-control-lost")
  assert.equal(scans, 2, "the retry is bounded at one re-scan")
  const subs = r.db
    .prepare("SELECT COUNT(*) AS n FROM auto_submissions WHERE slug = ?")
    .get(SLUG)
  assert.equal(subs.n, 0, "no attempt row — nothing durable before the check")
})
