// A runner that HARD-KILLS ITSELF at a named queue state.
//
// Spawned by tests/auto/runner-resume.test.mjs, once per state. It is a
// separate process because that is the only way to get a real SIGKILL: the
// point of the test is that nothing runs on the way out — no finally block, no
// flush, no `run.finish()`, no chance to tidy up. An in-process simulation of a
// crash tests the tidying code, which is exactly the code a crash skips.
//
// Usage:
//   node tests/fixtures/auto/kill-at.mjs --db <file> --jobs-dir <dir> --state <state>
//
// It exits by `process.kill(process.pid, 'SIGKILL')` and therefore never
// returns 0. The parent asserts on the DATABASE it left behind, never on the
// exit code.
import fs from "node:fs"
import path from "node:path"

import {
  openDb,
  enqueueAutoJobs,
  claimAutoJob,
  setAutoJobState,
  recordAutoSubmission,
} from "#lib/db.mjs"
import { startRun } from "../../../src/auto/audit.mjs"
import { runCampaign } from "../../../src/auto/auto-apply.mjs"

const arg = (f, d = null) => {
  const i = process.argv.indexOf(f)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d
}

const dbFile = arg("--db")
const jobsDir = arg("--jobs-dir")
const target = arg("--state")
const slug = arg("--slug", "kill-me")
const applyUrl = arg(
  "--url",
  "http://127.0.0.1:4599/boards.greenhouse.io/e/jobs/1",
)

// A hard kill. Not process.exit, which runs exit handlers and flushes streams —
// the whole question is what survives when nothing gets to run.
const die = () => {
  process.kill(process.pid, "SIGKILL")
  // Unreachable on every platform that honours SIGKILL. Kept so a platform
  // that does not cannot silently turn this into a clean exit that the parent
  // would read as a passing crash test.
  process.exit(97)
}

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

const job = {
  slug,
  board_key: "greenhouse:e",
  origin: new URL(applyUrl).origin,
  apply_url: applyUrl,
  company: "Acme",
  title: "Full-Stack Engineer",
  screening: { verdict: "pass", findings: [] },
}

// The three states BEFORE any stage boundary are reached by writing them and
// dying — there is no hook inside the machine at those points, and inventing
// one would be adding a seam to the product purely so a test can use it.
if (target === "queued") {
  const db = openDb(dbFile)
  enqueueAutoJobs(db, [job])
  db.close()
  die()
}

if (target === "claimed") {
  const db = openDb(dbFile)
  enqueueAutoJobs(db, [job])
  claimAutoJob(db, slug, {
    run_id: "kill-run",
    board_key: job.board_key,
    origin: job.origin,
  })
  db.close()
  die()
}

if (target === "authorized" || target === "attempted") {
  const db = openDb(dbFile)
  enqueueAutoJobs(db, [job])
  claimAutoJob(db, slug, {
    run_id: "kill-run",
    board_key: job.board_key,
    origin: job.origin,
  })
  setAutoJobState(db, slug, "planned", {
    run_id: "kill-run",
    plan_sha256: "d".repeat(64),
  })
  setAutoJobState(db, slug, "authorized", { run_id: "kill-run" })
  if (target === "attempted") {
    // THE CRASH WINDOW THE WHOLE LEDGER IS BUILT AROUND: the durable row is
    // written, and the process dies before anything acknowledges it. The row
    // is an ORPHAN and the next run must refuse to start.
    setAutoJobState(db, slug, "attempted", { run_id: "kill-run" })
    const run = startRun({
      mode: "dry_run",
      dbFile,
      autoDir: path.join(jobsDir, ".auto"),
    })
    recordAutoSubmission(db, {
      run_id: run.id,
      slug,
      company: "Acme",
      mode: "dry_run",
      submitted_at: new Date().toISOString(),
      outcome: "attempted",
      apply_url: applyUrl,
      doc: JSON.stringify({ killed: true }),
    })
  }
  db.close()
  die()
}

// The terminal states, and `planned`, are reached by running the REAL campaign
// with stages that die at the right moment.
const scan = async () => ({
  url: applyUrl,
  kind: "form",
  fields: [],
  buttons: [{ k: "b1", l: "Submit application", r: "submit" }],
})
const plan = async () => ({
  items: [{ k: "f1", how: "fill", value: "Xavier" }],
  defer: target === "deferred" ? [{ k: "f2", why: "consent" }] : [],
})
const fill = async () => {
  // `planned` is written between plan and fill, so dying here leaves exactly
  // that state on disk.
  if (target === "planned") die()
  return { ok: true, uploads: [], revealed: [] }
}

const openPage = async (url) => {
  // `failed` is produced by the navigation failing every bounded retry, which
  // is the real path to a `nav-timeout` — not by throwing somewhere arbitrary.
  if (target === "failed") throw new Error("net::ERR_CONNECTION_REFUSED")
  return {
    page: {
      url: () => url,
      locator: () => ({
        async click() {
          // Reached only in the `challenged` run, which is live-mode.
          return true
        },
        // The live path's pre-click stamp liveness check (submit.mjs); the
        // stamp is "alive" here so the run reaches the click and the
        // challenge.
        async waitFor() {},
      }),
      async content() {
        return "<html><body>Please verify you are human</body></html>"
      },
      async waitForLoadState() {},
    },
    url,
    status: 200,
    close: async () => {},
  }
}

const docs = {
  resume: path.join(jobsDir, slug, "resume.md"),
  verification: {
    doc_sha256: arg("--doc-sha", "a".repeat(64)),
    profile_sha256: arg("--profile-sha", "b".repeat(64)),
    mode: "resume",
  },
}

// `challenged` is the ONE state a dry run structurally cannot reach: it means a
// click went out and the board answered with something other than a
// confirmation. So this leg runs live-against-nothing — a fake page, a fake
// classifier, no employer anywhere near it — because the alternative is leaving
// the state untested and saying it was covered.
// `submitted` joined it on 2026-08-24: a dry run now ends at
// `deferred/rehearsed`, because writing the queue row terminal `submitted`
// after a rehearsal let a dry run permanently consume the live slot for a slug
// (job.mjs has the measured case). So a rehearsal can no longer produce this
// state either, and the same fake-page/fake-classifier treatment applies.
const live = target === "challenged" || target === "submitted"
const limits = live
  ? { auto_apply: { ...LIMITS.auto_apply, dry_run: false } }
  : LIMITS

const out = await runCampaign({
  dbFile,
  limits,
  mode: live ? "live" : "dry_run",
  concurrency: 1,
  limit: 5,
  jobsDir,
  allowLoopbackHttp: true,
  autoDir: path.join(jobsDir, ".auto"),
  openPage,
  scan,
  plan,
  fill,
  // The two live legs want opposite answers from the classifier: `submitted`
  // needs the page to read as a confirmation, `challenged` needs it not to.
  classify: live
    ? () => (target === "submitted" ? "confirmation" : "bot-challenge")
    : null,
  profileApproved: true,
  documentsFor: () => docs,
  jobs: [job],
  // Zero lease: this fixture is the ONLY process touching this database, so
  // "somebody else is working that slug" is impossible by construction. The
  // production default is 30 minutes and is deliberately not what a crash test
  // waits for.
  staleClaimMs: 0,
})

// The terminal-state runs are allowed to finish cleanly; the parent then
// asserts the row is terminal and NOT resumable. `failed` is produced by the
// 500 above being classified, not by throwing.
fs.writeFileSync(
  path.join(jobsDir, "kill-at.result.json"),
  JSON.stringify(out.results ?? [], null, 1),
)
process.exit(0)
