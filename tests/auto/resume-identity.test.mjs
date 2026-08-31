// A queued row this invocation did NOT select is resumed from the database
// alone (2026-08-18).
//
// THE DEFECT, measured on the 2026-08-17 live run: runCampaign learned a job's
// apply_url and screening verdict only from the selection made in the same
// invocation. A row that was already in auto_queue — enqueued by an earlier
// --enqueue, or beyond this run's --limit in a differently ordered list, or left
// behind by a crash — reached runJob as an anonymous slug: `apply_url: null`,
// `screening: null`. The trust gate refused it as "the lead carries no
// apply_url" (Torc Robotics, whose store row carried a perfectly good one) and,
// had it not, as unscreened. The row now carries apply_url/lead_id/company/title
// and the runner re-reads the verdict from the screens table by lead_id.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { runCampaign } from "../../src/auto/auto-apply.mjs"
import {
  openDb,
  enqueueAutoJobs,
  recordVerification,
  recordScreens,
  upsertLeads,
  readAutoQueue,
} from "#lib/db.mjs"

const DOC_SHA = "a".repeat(64)
const PROFILE_SHA = "b".repeat(64)
const APPLY_URL = "http://127.0.0.1:9000/fixture-submit/confirmation"

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

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aj-resume-id-"))
  const jobsDir = path.join(dir, "jobs")
  const autoDir = path.join(jobsDir, ".auto")
  fs.mkdirSync(autoDir, { recursive: true })
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* a leaked handle must not fail an assertion that already passed */
    }
  })
  return { dir, jobsDir, autoDir, dbFile: path.join(dir, "leads.db") }
}

const stages = () => ({
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
  scan: async () => ({
    kind: "form",
    fields: [{ k: "f1", t: "text", l: "First name" }],
    buttons: [{ k: "b1", l: "Submit application", r: "submit" }],
  }),
  plan: async () => ({
    items: [{ k: "f1", how: "fill", value: "X" }],
    defer: [],
  }),
  fill: async () => ({ ok: true, uploads: [], revealed: [] }),
  documentsFor: () => ({
    verification: {
      doc_sha256: DOC_SHA,
      profile_sha256: PROFILE_SHA,
      mode: "resume",
    },
  }),
})

/** The store as an earlier --enqueue left it: a screened lead, a passing
 *  verification, and a self-describing queue row. Nothing else. */
function seedEarlierEnqueue(dbFile, { identity = true } = {}) {
  const db = openDb(dbFile)
  upsertLeads(db, [
    {
      id: "greenhouse:torc:1",
      slug: "torc-build-tools",
      url: APPLY_URL,
      apply_url: APPLY_URL,
      company: "Torc Robotics",
      title: "Software Engineer II - Build Tools",
    },
  ])
  recordScreens(db, [
    { lead_id: "greenhouse:torc:1", source: "mechanical", verdict: "pass" },
  ])
  recordVerification(db, {
    slug: "torc-build-tools",
    mode: "resume",
    verdict: "pass",
    doc_sha256: DOC_SHA,
    profile_sha256: PROFILE_SHA,
  })
  enqueueAutoJobs(db, [
    {
      slug: "torc-build-tools",
      board_key: "greenhouse",
      origin: "http://127.0.0.1:9000",
      ...(identity
        ? {
            apply_url: APPLY_URL,
            lead_id: "greenhouse:torc:1",
            company: "Torc Robotics",
            title: "Software Engineer II - Build Tools",
          }
        : {}),
    },
  ])
  db.close()
}

test("a row enqueued by an EARLIER invocation resumes with its apply_url and screening — no seed needed", async (t) => {
  const s = sandbox(t)
  seedEarlierEnqueue(s.dbFile)
  const seen = []
  await runCampaign({
    dbFile: s.dbFile,
    limits: LIMITS,
    mode: "dry_run",
    concurrency: 1,
    limit: 5,
    // THIS is the shape of the defect: nothing selected this run, the queue
    // holds one row from before.
    jobs: [],
    jobsDir: s.jobsDir,
    autoDir: s.autoDir,
    allowLoopbackHttp: true,
    profileApproved: true,
    onResult: (r) => seen.push(r),
    ...stages(),
  })
  assert.equal(seen.length, 1, "the row was worked")
  const [r] = seen
  assert.notEqual(
    r.kind,
    "board-untrusted",
    `the trust gate must not refuse a self-describing row: ${r.detail}`,
  )
  assert.doesNotMatch(String(r.detail ?? ""), /carries no apply_url/)
  assert.doesNotMatch(String(r.detail ?? ""), /no stored screening verdict/)
  const db = openDb(s.dbFile)
  const [row] = readAutoQueue(db)
  db.close()
  assert.ok(row.plan_sha256, "it reached the plan stage — a sha was recorded")
})

test("a row with NO identity (queued before the columns existed) still fails closed at the gate, and says so", async (t) => {
  // The fallback keeps the old behaviour for an old row: it is refused, never
  // guessed at. This pins the direction — a blank row is not filled in from
  // anywhere except the seed or the row itself.
  const s = sandbox(t)
  seedEarlierEnqueue(s.dbFile, { identity: false })
  const seen = []
  await runCampaign({
    dbFile: s.dbFile,
    limits: LIMITS,
    mode: "dry_run",
    concurrency: 1,
    limit: 5,
    jobs: [],
    jobsDir: s.jobsDir,
    autoDir: s.autoDir,
    allowLoopbackHttp: true,
    profileApproved: true,
    onResult: (r) => seen.push(r),
    ...stages(),
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].kind, "board-untrusted")
  assert.match(String(seen[0].detail), /carries no apply_url/)
})
