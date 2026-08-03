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
  const run = startRun({ mode: "dry_run", dbFile, autoDir })

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
