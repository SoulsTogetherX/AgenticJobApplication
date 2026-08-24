#!/usr/bin/env node
// Re-run verify-claims for documents whose recorded verification predates the
// fact base on disk — the sweep that keeps a fact-base edit from stranding
// every tailored document forever.
//
// THE GAP THIS CLOSES, measured 2026-08-09. factBaseSha256 covers the whole
// fact base, so ONE scripts/profile/save-answer.mjs write invalidates every
// outstanding verification at once. That is the freshness key WORKING — the
// corpus those documents were checked against no longer exists — but nothing
// ever re-checked them: prep-queue skips their workspaces (context.json still
// says verified), prepareDocuments only runs for queued leads, and so
// selectEligible refused all 33 tailored jobs (0 green, runner idle) while
// every one of them re-passed verify-claims in seconds when run by hand.
//
// WHAT THIS IS NOT, deliberately:
//   * not a wider key — staleness is still profile_sha256 != factBaseSha256(),
//     the same comparison hasPassingVerification makes, and nothing here
//     relaxes it;
//   * not a cache — every stale document is RE-VERIFIED against the corpus on
//     disk now, through the same identity + row + upsert the verify-claims CLI
//     writes. No verdict survives a fact-base change unchecked;
//   * not a retry loop — a document that re-FAILS is recorded as failing, its
//     newest row then carries the CURRENT fact-base hash, so the next sweep
//     has nothing stale to re-run until the facts move again. One fact-base
//     version, one verdict.
//
// A re-fail is the sweep succeeding: the new fact base no longer supports the
// document, the job drops out of eligibility, and the caller reports which
// document died and why. There is no branch that falls back to the old
// verdict, and no flag that skips the check.
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  loadFactContext,
  verifyDocument,
  addressingFor,
} from "./verify-claims.mjs"
import {
  factBaseSha256,
  verificationIdentity,
  sha256File,
  JOBS_DIR,
  PROFILE_PATH,
  ANSWERS_PATH,
} from "../lib/verification.mjs"
import {
  recordVerification,
  readVerifications,
  orphanVerificationCandidates,
  deleteVerifications,
} from "../lib/db.mjs"

// The documents a workspace can hold a verification for, in report order.
const MODE_FILES = [
  ["resume", "resume.md"],
  ["cover-letter", "cover-letter.md"],
]

/**
 * The newest recorded row per (slug, mode), by verified_at (ISO text, so
 * string comparison is date comparison). The NEWEST row is the one whose
 * staleness matters: an older row with a different hash is history, not a
 * verdict.
 */
export function newestVerifications(rows) {
  const newest = new Map()
  for (const r of rows ?? []) {
    const k = `${r.slug} ${r.mode}`
    const prev = newest.get(k)
    if (!prev || String(r.verified_at) > String(prev.verified_at))
      newest.set(k, r)
  }
  return newest
}

/**
 * Re-verify every document whose job has a stale newest verification.
 *
 * ROW-DRIVEN, like verifiedResumeUrls and for the same reason: the sweep walks
 * what was VERIFIED, never what exists on disk. A workspace that was never
 * verified is prepareDocuments' business (first-time verification), not this
 * sweep's — re-checking is only meaningful for something that was checked.
 *
 * Per stale job, BOTH documents present on disk are re-verified, not only the
 * mode whose row went stale: one fact-base edit invalidated both, and a sweep
 * that fixed the resume while the cover letter's row stayed stale would leave
 * the job half-checked forever.
 *
 * Returns { profile_sha256, stale, checked, missing, repassed, refailed }.
 * `checked` entries carry ok plus the first violations on failure — the
 * caller's evidence for WHY a job dropped out of eligibility. `missing` names
 * rows whose document is gone from disk; nothing is recorded for those (there
 * are no bytes to vouch for) and the old stale row keeps them ineligible,
 * which is the correct direction.
 */
export function reverifySweep({
  db,
  jobsDir = JOBS_DIR,
  profilePath = PROFILE_PATH,
  answersPath = ANSWERS_PATH,
  pruneOrphans = false,
} = {}) {
  if (!db)
    throw new TypeError(
      "reverifySweep requires an open db handle — without the verification " +
        "store there is nothing to re-check",
    )
  const current = factBaseSha256({ profilePath, answersPath })

  // --- orphans: rows for a workspace that no longer exists ------------------
  //
  // The sweep is row-driven by design, so a verification row whose workspace
  // was hand-deleted re-reports as `missing` on every run, forever — nothing
  // else in the repo can delete a verifications row (measured on
  // essex-street-cheese-frontend-dev, three rows re-reported since
  // 2026-08-10). Three conditions, all required: no jobs/<slug>/ directory
  // (checked HERE — db.mjs does not touch the disk), no documents row, no
  // applications row. An applications row means the verification history is
  // evidence of a real application and is never prunable. Reported always;
  // deleted only under the flag, BEFORE the sweep reads verifications, so a
  // pruned slug vanishes from stale/missing in the same run.
  const orphaned = orphanVerificationCandidates(db).filter(
    (slug) => !fs.existsSync(path.join(jobsDir, slug)),
  )
  let pruned = 0
  if (pruneOrphans)
    for (const slug of orphaned) pruned += deleteVerifications(db, slug)

  const newest = newestVerifications(readVerifications(db))

  const staleSlugs = new Set()
  for (const row of newest.values())
    if (row.profile_sha256 !== current) staleSlugs.add(row.slug)

  const out = {
    profile_sha256: current,
    stale: [...staleSlugs].sort(),
    checked: [],
    missing: [],
    repassed: 0,
    refailed: 0,
    orphaned,
    pruned,
  }
  if (!staleSlugs.size) return out

  // ONE fact context for the whole sweep — the same reason classifyAll batches
  // resolveFields: loading and indexing the fact base per document is the
  // difference between a sweep and a latency problem.
  const ctx = loadFactContext({ profilePath, answersPath })

  for (const slug of out.stale) {
    const dir = path.join(jobsDir, slug)
    // Addressing and plan exactly as the CLI loads them with --job: company
    // and title may legitimately carry a number or a date the document
    // repeats, so re-verifying WITHOUT them would fail truthful documents the
    // original run passed — a sweep stricter than the verifier is a different
    // bug, not a safer one.
    let job = null
    try {
      job = JSON.parse(fs.readFileSync(path.join(dir, "job.json"), "utf8"))
    } catch {
      /* no addressing — numbers from the posting's title just aren't excused */
    }
    const addressing = addressingFor(job)
    let plan = null
    const planPath = path.join(dir, "keywords.json")
    if (fs.existsSync(planPath)) {
      try {
        plan = JSON.parse(fs.readFileSync(planPath, "utf8"))
      } catch {
        plan = { __unreadable: true }
      }
    }

    for (const [mode, name] of MODE_FILES) {
      const file = path.join(dir, name)
      const had = newest.get(`${slug} ${mode}`)
      if (!fs.existsSync(file)) {
        if (had) out.missing.push({ slug, mode, file })
        continue
      }
      // Bytes already checked against THIS fact base keep their verdict,
      // pass or fail — re-running a deterministic check on identical inputs
      // is how "no retry-until-pass" would erode into noise.
      if (
        had &&
        had.profile_sha256 === current &&
        had.doc_sha256 === sha256File(file)
      )
        continue

      const doc = fs.readFileSync(file, "utf8")
      const core =
        plan?.__unreadable === true
          ? {
              ...verifyDocument({ doc, mode, ctx, addressing }),
              coverage: {
                error: "keywords.json unreadable — coverage not checked",
              },
            }
          : verifyDocument({ doc, mode, ctx, addressing, plan })
      const report = { mode: core.mode, file, ...core }

      // The normal recording path, verbatim from the verify-claims CLI: the
      // identity re-reads the bytes and re-hashes the fact base at record
      // time, and the row upserts on (slug, mode, doc_sha256).
      const identity = verificationIdentity(file, {
        jobsDir,
        profilePath,
        answersPath,
      })
      if (!identity) {
        out.missing.push({ slug, mode, file })
        continue
      }
      recordVerification(db, {
        ...identity,
        mode,
        verdict: report.ok ? "pass" : "fail",
        doc: report,
      })
      out.checked.push({
        slug,
        mode,
        file,
        ok: report.ok,
        // The first violations are the caller's "why" — the full report is on
        // the row itself.
        violations: report.ok ? [] : report.violations.slice(0, 3),
      })
      if (report.ok) out.repassed++
      else out.refailed++
    }
  }
  return out
}

// --- CLI ---------------------------------------------------------------------

const REVERIFY_FLAGS = [
  "--db",
  "--jobs-dir",
  "--profile",
  "--answers",
  "--prune-orphans",
  "--json",
  "--help",
]
const REVERIFY_VALUE_FLAGS = ["--db", "--jobs-dir", "--profile", "--answers"]

const USAGE = `reverify.mjs — re-check documents whose verification predates the fact base

  --db <file>        the store. Defaults to jobs/leads.db
  --jobs-dir <dir>   workspace root. Defaults to jobs/
  --profile <file>   the fact base
  --answers <file>   the answer bank
  --prune-orphans    DELETE verification rows for slugs with no workspace
  --json             machine-readable output

THIS COMMAND WRITES. It records a verification row for every stale document it
re-checks, and --prune-orphans deletes rows. It is not a read-only report.
`

async function main(args = process.argv.slice(2)) {
  // STRICT, because this command WRITES and used to ignore what it was given.
  // Measured 2026-08-24: `reverify.mjs --help` ignored the flag and ran a full
  // 61-job sweep, recording a verification row for every stale document — a
  // flag passed to ask a question performed a write. It had no --help, no
  // usage, and no way to tell "no arguments" from "help wanted".
  const { assertKnownFlags } = await import("../lib/args.mjs")
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }
  try {
    assertKnownFlags(args, {
      known: REVERIFY_FLAGS,
      valueFlags: REVERIFY_VALUE_FLAGS,
      script: "reverify.mjs",
      note: "this command records verification rows, and --prune-orphans deletes them",
    })
  } catch (e) {
    process.stderr.write(`${e.message}\n`)
    return e.exitCode ?? 2
  }
  const flag = (name, dflt) => {
    const i = args.indexOf(name)
    return i !== -1 && args[i + 1] ? args[i + 1] : dflt
  }
  const { openDb } = await import("../lib/db.mjs")
  const db = openDb(flag("--db", undefined))
  let sweep
  try {
    sweep = reverifySweep({
      db,
      jobsDir: flag("--jobs-dir", JOBS_DIR),
      profilePath: flag("--profile", PROFILE_PATH),
      answersPath: flag("--answers", ANSWERS_PATH),
      pruneOrphans: args.includes("--prune-orphans"),
    })
  } finally {
    db.close()
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(sweep, null, 2))
    return 0
  }
  console.log(
    `${sweep.stale.length} stale job(s): ${sweep.repassed} re-passed, ` +
      `${sweep.refailed} failed, ${sweep.missing.length} document(s) missing`,
  )
  for (const c of sweep.checked.filter((c) => !c.ok))
    console.log(
      `  FAILED ${c.slug} (${c.mode}): ${c.violations[0]?.rule ?? "?"} ${c.violations[0]?.detail ?? ""}`,
    )
  for (const m of sweep.missing)
    console.log(`  missing ${m.slug} (${m.mode}): ${m.file}`)
  if (sweep.pruned)
    console.log(
      `pruned ${sweep.pruned} verification row(s) for ${sweep.orphaned.length} orphaned slug(s)`,
    )
  else
    for (const slug of sweep.orphaned)
      console.log(
        `  orphaned (no workspace): ${slug} — rerun with --prune-orphans to delete its verification rows`,
      )
  // Exit 0 either way: a re-fail is the sweep doing its job (the document is
  // correctly dead and named above), not a sweep failure.
  return 0
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) process.exit(await main())
