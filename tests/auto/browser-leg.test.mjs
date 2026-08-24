// THE BROWSER LEG, END TO END: a real Chromium, the real runner, a real form.
//
// WHY THIS TEST IS THE ONLY EVIDENCE THAT MATTERS FOR THIS CHANGE. W1-W3 built
// the state machine, the trust gate, the caps, the breaker, the pool and the
// classifier, and every one of them was tested against INJECTED fakes — a
// `scan` that returns a literal, a `page` whose locator does nothing. Those
// tests are right and they say nothing whatsoever about whether the runner can
// drive a browser, because the thing they stub out IS the browser. Meanwhile
// `auto-apply.mjs`'s `main()` printed "the browser leg is Phase 5 W2, so this
// invocation wrote nothing" and returned REFUSED, so the complete machine was
// unreachable and the suite was green.
//
// A GREEN GATE WAS NEVER GOING TO CATCH THAT. This test exists so that
// "the runner works" is a thing that can be FALSIFIED: real stages
// (scan-engine, fill-plan, fill-engine), a real Chromium, a real HTTP server
// serving a real ATS replica, and the real `runCampaign`. The only fake left
// is the employer.
//
// NEVER A REAL EMPLOYER. The board is tests/fixtures/boards/server.mjs on
// loopback, and `mode` is dry_run — submitOnce's dry-run branch locates the
// submit control and asserts it is there WITHOUT clicking it. browser.mjs's own
// loopback guard is the backstop.
//
// Skipped with a STATED reason when no Chromium is usable, because a leg that
// skips silently is indistinguishable from one that passes.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { start } from "../fixtures/boards/server.mjs"
import { launchBrowser } from "../../scripts/apply/browser.mjs"
import { runCampaign, makeOpenPage } from "../../scripts/auto/auto-apply.mjs"
import { makeStages } from "../../scripts/auto/stages.mjs"
import {
  openDb,
  recordVerification,
  readAutoQueue,
} from "../../scripts/lib/db.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const PROFILE = path.join(ROOT, "tests/fixtures/profile.yaml")
const ANSWERS = path.join(ROOT, "tests/fixtures/answers-bank.yaml")

const DOC_SHA = "a".repeat(64)
const PROFILE_SHA = "b".repeat(64)
const SLUG = "fixture-analytics-fullstack"

const NO_BROWSER = await (async () => {
  try {
    const s = await launchBrowser({ headless: true })
    await s.close()
    return null
  } catch (e) {
    return "no usable Chromium: " + String(e.message).slice(0, 90)
  }
})()

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aj-browserleg-"))
  const jobsDir = path.join(dir, "jobs")
  fs.mkdirSync(path.join(jobsDir, ".auto"), { recursive: true })
  fs.mkdirSync(path.join(jobsDir, SLUG), { recursive: true })
  // The attachments have to EXIST or buildPlan defers the slot with "no
  // rendered resume", and a defer is an authorization failure. Contents are
  // irrelevant — setInputFiles takes a path, and what this test is proving is
  // that the runner reaches the input at all.
  for (const name of ["resume.pdf", "cover-letter.pdf"])
    fs.writeFileSync(path.join(jobsDir, SLUG, name), "%PDF-1.4 fixture\n")

  const dbFile = path.join(dir, "leads.db")
  const db = openDb(dbFile)
  recordVerification(db, {
    slug: SLUG,
    mode: "resume",
    verdict: "pass",
    doc_sha256: DOC_SHA,
    profile_sha256: PROFILE_SHA,
  })
  db.close()

  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* a leaked handle must not fail an assertion that already passed */
    }
  })
  return { dir, jobsDir, dbFile }
}

const limitsFor = () => ({
  auto_apply: {
    enabled: true,
    dry_run: true,
    per_run_max: 5,
    per_day_max: 5,
    per_company_max_per_week: 5,
    board_allowlist: { "127.0.0.1": "greenhouse" },
  },
})

test("the runner drives a real browser through a real form and reaches the submit control", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const s = sandbox(t)
  const board = await start()
  t.after(async () => {
    await board.stop()
  })

  const applyUrl = board.pageUrl("honest-greenhouse")
  const origin = new URL(applyUrl).origin

  const session = await launchBrowser({ headless: true, localOnly: true })
  let out
  try {
    out = await runCampaign({
      dbFile: s.dbFile,
      limits: limitsFor(),
      mode: "dry_run",
      concurrency: 1,
      limit: 5,
      jobsDir: s.jobsDir,
      allowLoopbackHttp: true,
      jobs: [
        {
          slug: SLUG,
          board_key: "greenhouse",
          origin,
          apply_url: applyUrl,
          company: "Fixture Analytics",
          title: "Full-Stack Engineer",
          // The runner refuses an UNSCREENED lead outright, and rightly:
          // screening is where hard rule 0 is enforced. Supplied here as a
          // passing verdict with no findings, which is what l0/l1/l3 write for
          // an honest posting.
          screening: { ok: true, stage: "l3", findings: [] },
        },
      ],
      openPage: makeOpenPage(session, { localOnly: true }),
      ...makeStages({
        jobsDir: s.jobsDir,
        profilePath: PROFILE,
        answersPath: ANSWERS,
      }),
      documentsFor: () => ({
        resume: path.join(s.jobsDir, SLUG, "resume.pdf"),
        cover: path.join(s.jobsDir, SLUG, "cover-letter.pdf"),
        verification: {
          slug: SLUG,
          doc_sha256: DOC_SHA,
          profile_sha256: PROFILE_SHA,
          mode: "resume",
        },
      }),
      profileApproved: true,
    })
  } finally {
    await session.close()
  }

  const rows = (() => {
    const db = openDb(s.dbFile)
    try {
      return readAutoQueue(db)
    } finally {
      db.close()
    }
  })()
  const row = rows.find((r) => r.slug === SLUG)

  // THE ASSERTION, and it is deliberately about STATE rather than about a
  // count. `rehearsed` in dry_run means every stage ran for real: the page
  // opened, scan-page.js installed and returned fields, fill-plan resolved them
  // from the fact base with ZERO defers, the fill engine typed them into a live
  // DOM, the trust gate and every authorization check passed, the durable
  // (slug, mode) row was written, and submitOnce located the submit control —
  // without clicking it, which is what dry_run means.
  //
  // THE EXPECTED STATE CHANGED ON 2026-08-24 AND THE MEANING DID NOT. A dry run
  // used to end at terminal `submitted`, which is what let a rehearsal
  // permanently consume the live slot for a slug (job.mjs has the measured
  // case). It now ends at `deferred/rehearsed`. That is still "every stage ran
  // and the submit control was found"; `rehearsed` is reached ONLY from
  // submitOnce's dry-run return, so it certifies the same walk this test was
  // written to certify — a defer at any earlier stage carries a different kind
  // and fails this assertion exactly as it did before.
  assert.deepEqual(
    { state: row?.state, kind: row?.reason_kind ?? null, outcome: out.outcome },
    { state: "deferred", kind: "rehearsed", outcome: "ok" },
    `the browser leg did not complete. Row: ${JSON.stringify(row)}\n` +
      `Run: ${JSON.stringify(out)}\n` +
      "This is the test that tells 'the runner is wired' from 'the runner works'.",
  )
  // And nothing was clicked: no submission row may exist for a rehearsal that
  // reached the control.
  assert.equal(row.reason_stage, "attempt")
})

test("the stages are the SAME code the attended path uses, not a second implementation", () => {
  // A runner with its own scanner or its own planner is two implementations of
  // rule 1, and the second one is always the one that quietly disagrees. Read
  // off the source rather than asserted in prose: stages.mjs must IMPORT the
  // attended modules, and must not spawn anything (§4.1 — `spawns_per_app` is a
  // gate column asserted to be 0).
  const src = fs.readFileSync(
    path.join(ROOT, "scripts/auto/stages.mjs"),
    "utf8",
  )
  for (const mod of [
    "../apply/scan-engine.mjs",
    "../apply/fill-engine.mjs",
    "../apply/fill-plan.mjs",
  ]) {
    assert.ok(src.includes(mod), `stages.mjs must import ${mod}`)
  }
  // Comments are stripped first. stages.mjs's own header EXPLAINS why it does
  // not spawn — naming `execFileSync` to do so — and a check that reads prose
  // fails on the file that documents the rule it is enforcing.
  const code = src
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n")
  assert.ok(
    !/child_process|execFile|\bspawn\(/.test(code),
    "stages.mjs must not spawn a process per stage",
  )
})
