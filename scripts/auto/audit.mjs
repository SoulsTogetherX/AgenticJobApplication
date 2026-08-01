// The audit record for an unattended run — written TWICE, on purpose.
//
// jobs/.auto/runs/<runid>.jsonl is append-only text and it is the copy that
// SURVIVES: jobs/leads.db is gitignored, has no on-disk source for anything it
// alone holds, and a database file is exactly the thing that is unreadable at
// the moment you need it most. The auto_runs / auto_submissions tables exist
// because the JSONL cannot be QUERIED, and "how many applications have gone to
// this company in the last seven days?" has to be answered cheaply, before the
// next submit, or per_company_max_per_week is decoration.
//
// Neither copy is derived from the other. A record present in one and absent
// from the other is itself a finding.
//
// WHAT THIS MODULE ENFORCES, rather than merely records:
//
//   * The kill switch is checked at all three checkpoints hard rule 6 requires,
//     and the checks are on the path to RECORDING, not beside it. startRun
//     cannot open a run while STOP is set; beginJob cannot start a job; and
//     recordSubmission refuses to acknowledge a submit that was not preceded by
//     a passing pre-submit check. A runner cannot forget a checkpoint, because
//     skipping one means skipping the audit write, and a submit with no audit
//     row is louder than a missing check.
//   * profile/ is hashed at both ends of the run. It is never written by this
//     path; the hashes exist so "it was never written" is a checkable claim
//     rather than an assurance.
//   * Every write goes through assertInsideJobs().
//
// WHAT IT DOES NOT DO. It does not submit anything, open a browser, or decide
// whether a submit is allowed. There is no runner yet (hard rule 6 ships
// auto-submit disabled), and nothing in this file should be read as evidence
// that an unattended application path is currently guarded — there is no
// unattended application path.
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import {
  AUTO_DIR,
  RUNS_DIR,
  PROFILE_DIR,
  CHECKPOINTS,
  assertInsideJobs,
  assertNotStopped,
  raiseStop,
} from "./guard.mjs"
import {
  openDb,
  upsertAutoRun,
  recordAutoSubmission,
  countAutoSubmissions,
  countCompanySubmissions,
  DB_PATH,
} from "../lib/db.mjs"

// The two files the fact base lives in. Hashed, never written.
export const PROFILE_FILES = ["profile.yaml", "answers.yaml"]

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex")

/**
 * Hash both fact-base files. A missing file hashes to null rather than
 * throwing — an absent answers.yaml is a legitimate state, and a run that
 * cannot start because of a hash is a run that stops applying for the wrong
 * reason.
 */
export function hashProfile({ profileDir = PROFILE_DIR } = {}) {
  const out = {}
  for (const name of PROFILE_FILES) {
    try {
      out[name] = sha256(fs.readFileSync(path.join(profileDir, name)))
    } catch {
      out[name] = null
    }
  }
  return out
}

const sameHashes = (a, b) =>
  PROFILE_FILES.every((n) => (a?.[n] ?? null) === (b?.[n] ?? null))

export function newRunId(now = new Date()) {
  return (
    now.toISOString().replace(/[:.]/g, "-") +
    "-" +
    crypto.randomBytes(3).toString("hex")
  )
}

/**
 * Open a run.
 *
 * @param mode 'dry_run' | 'live'. There is no default: an unattended process
 *   that has to guess whether it is allowed to send real applications is
 *   already wrong, whichever way it guesses.
 */
export function startRun({
  mode,
  dbFile = DB_PATH,
  autoDir = AUTO_DIR,
  runsDir = null,
  profileDir = PROFILE_DIR,
  stopPath = null,
  now = new Date(),
  meta = null,
} = {}) {
  if (mode !== "dry_run" && mode !== "live") {
    throw new TypeError(
      `startRun requires mode 'dry_run' or 'live', got ${JSON.stringify(mode)}`,
    )
  }

  const dir = runsDir ?? path.join(autoDir, "runs")
  const stop = stopPath ?? path.join(autoDir, "STOP")
  const jobsDir = path.resolve(autoDir, "..")

  // CHECKPOINT 1 of 3. Before anything is created, before the browser exists.
  assertNotStopped(CHECKPOINTS.RUN_START, { stopPath: stop })

  const run_id = newRunId(now)
  fs.mkdirSync(assertInsideJobs(dir, { jobsDir }), { recursive: true })
  const jsonl = assertInsideJobs(path.join(dir, `${run_id}.jsonl`), { jobsDir })

  const profile_start = hashProfile({ profileDir })
  const state = {
    run_id,
    started_at: now.toISOString(),
    finished_at: null,
    mode,
    outcome: "running",
    planned: 0,
    submitted: 0,
    deferred: 0,
    failed: 0,
    stop_reason: null,
    profile_sha_start: profile_start,
    profile_sha_end: null,
    jsonl,
    ...(meta ? { meta } : {}),
  }

  const ctx = { dir, stop, jobsDir, dbFile, profileDir, jsonl }
  appendEvent(ctx, { t: "run.start", run_id, mode, profile: profile_start, meta })
  persist(ctx, state)

  return makeRun(ctx, state)
}

// Append-only, one JSON object per line, flushed per event. Not batched: a run
// that dies is precisely the run whose last event matters most, and a buffer
// loses exactly that one.
// U+2028/U+2029 are legal inside a JSON string and are LINE TERMINATORS in JS
// source. Nothing evals this record, but it carries labels copied verbatim off
// third-party pages and is meant to be pasted, grepped and re-embedded - the
// same hazard fill-plan.mjs uses embedLiteral rather than JSON.stringify for.
// Written as escapes rather than literals so THIS file's own source stays ASCII.
const JS_LINE_SEPARATORS = new RegExp("[\\u2028\\u2029]", "g")

function appendEvent(ctx, event) {
  const line =
    JSON.stringify({ at: new Date().toISOString(), ...event }).replace(
      JS_LINE_SEPARATORS,
      (c) => (c.charCodeAt(0) === 0x2028 ? "\\u2028" : "\\u2029"),
    ) + "\n"
  fs.appendFileSync(
    assertInsideJobs(ctx.jsonl, { jobsDir: ctx.jobsDir }),
    line,
    "utf8",
  )
}

function persist(ctx, state) {
  const db = openDb(ctx.dbFile)
  try {
    upsertAutoRun(db, state)
  } finally {
    db.close()
  }
}

function makeRun(ctx, state) {
  let finished = false
  // Set by a passing pre-submit checkpoint and cleared by the record that
  // consumes it, so one check can never authorise two submits.
  let submitTicket = null

  const event = (type, data = {}) => {
    appendEvent(ctx, { t: type, run_id: state.run_id, ...data })
  }

  return {
    get id() {
      return state.run_id
    },
    get mode() {
      return state.mode
    },
    get state() {
      return { ...state }
    },
    jsonl: ctx.jsonl,
    event,

    /** CHECKPOINT 2 of 3: between every job. */
    beginJob(job) {
      assertNotStopped(CHECKPOINTS.BETWEEN_JOBS, { stopPath: ctx.stop })
      state.planned += 1
      event("job.begin", { slug: job?.slug ?? null, company: job?.company ?? null, tier: job?.tier ?? null })
      persist(ctx, state)
      return true
    },

    deferJob(job, reason) {
      state.deferred += 1
      // A silent skip is not a deferral. Hard rule 6 requires a stated reason
      // the user can act on, so an empty one is recorded as the defect it is
      // rather than as an empty string nobody notices.
      event("job.defer", {
        slug: job?.slug ?? null,
        reason: reason || "NO REASON GIVEN — this is a defect in the caller",
      })
      persist(ctx, state)
    },

    failJob(job, error) {
      state.failed += 1
      event("job.fail", {
        slug: job?.slug ?? null,
        error: String(error?.message ?? error ?? "unknown"),
      })
      persist(ctx, state)
      return state.failed
    },

    /**
     * CHECKPOINT 3 of 3: immediately before the submit click.
     *
     * Returns a single-use ticket. recordSubmission refuses without one, so
     * "the switch was checked right before the click" is enforced by the audit
     * write rather than trusted to a call site.
     */
    preSubmitCheck(job) {
      assertNotStopped(CHECKPOINTS.PRE_SUBMIT, { stopPath: ctx.stop })
      submitTicket = {
        slug: job?.slug ?? null,
        at: new Date().toISOString(),
      }
      event("submit.check", { slug: submitTicket.slug, result: "clear" })
      return submitTicket
    },

    /**
     * Record a submission that has ALREADY happened.
     *
     * This never refuses to record. An application cannot be unsent, so losing
     * its record is strictly worse than recording an incomplete one — an
     * incomplete record is flagged and the runner is stopped, but the row
     * exists and the user can still find and withdraw the application.
     */
    recordSubmission(sub) {
      if (!submitTicket || submitTicket.slug !== (sub?.slug ?? null)) {
        // Recorded and then stopped: a submit with no matching pre-submit
        // check means the kill switch was not read immediately before the
        // click, which is the one checkpoint that cannot be made up afterwards.
        event("submit.unchecked", { slug: sub?.slug ?? null })
        raiseStop(
          `a submission for "${sub?.slug}" was recorded without a matching pre-submit kill-switch check`,
          { stopPath: ctx.stop, jobsDir: ctx.jobsDir, meta: { run_id: state.run_id } },
        )
      }
      submitTicket = null

      const required = [
        "slug",
        "plan_sha256",
        "verify",
        "consent_labels",
        "screenshots",
        "confirmation_url",
      ]
      const missing = required.filter((k) => sub?.[k] == null)

      const row = {
        run_id: state.run_id,
        mode: state.mode,
        submitted_at: new Date().toISOString(),
        ...sub,
        ...(missing.length ? { audit_incomplete: missing } : {}),
      }
      state.submitted += 1
      event("submit.done", row)

      const db = openDb(ctx.dbFile)
      try {
        recordAutoSubmission(db, row)
        upsertAutoRun(db, state)
      } finally {
        db.close()
      }

      if (missing.length) {
        raiseStop(
          `submission "${sub?.slug}" was recorded without: ${missing.join(", ")}` +
            ` — the record cannot support a manual withdrawal`,
          { stopPath: ctx.stop, jobsDir: ctx.jobsDir, meta: { run_id: state.run_id } },
        )
      }
      return row
    },

    /**
     * The runner disabling itself on an anomaly. Records first, stops second,
     * so the reason is in the durable copy even if the STOP write fails.
     */
    stop(reason, meta = null) {
      state.stop_reason = reason
      event("run.stop", { reason, meta })
      persist(ctx, state)
      return raiseStop(reason, { stopPath: ctx.stop, jobsDir: ctx.jobsDir, meta })
    },

    /**
     * Close the run and re-hash the fact base.
     *
     * A changed hash is an ALARM, not a note. The auto path is forbidden to
     * write profile/, so either something did, or the user edited it mid-run —
     * in which case every application this run sent was reasoned from a
     * snapshot that no longer holds, and the next run should not start until a
     * human has looked. Fail-closed, and cheap to clear.
     */
    finish({ outcome = "ok", now = new Date() } = {}) {
      if (finished) return { ...state }
      finished = true
      const profile_end = hashProfile({ profileDir: ctx.profileDir })
      const mutated = !sameHashes(state.profile_sha_start, profile_end)
      state.profile_sha_end = profile_end
      state.finished_at = now.toISOString()
      state.outcome = state.stop_reason ? "stopped" : outcome
      event("run.finish", {
        outcome: state.outcome,
        planned: state.planned,
        submitted: state.submitted,
        deferred: state.deferred,
        failed: state.failed,
        profile: profile_end,
        profile_mutated: mutated,
      })
      persist(ctx, state)
      if (mutated) {
        raiseStop(
          "profile/ changed during an unattended run — the fact base this run reasoned from is not the one on disk now",
          {
            stopPath: ctx.stop,
            jobsDir: ctx.jobsDir,
            meta: {
              run_id: state.run_id,
              start: state.profile_sha_start,
              end: profile_end,
            },
          },
        )
      }
      return { ...state }
    },
  }
}

/**
 * The cap arithmetic, answered from the ledgers rather than from a counter the
 * runner keeps in memory (which resets when the runner dies and forgets what it
 * sent this morning).
 *
 * `caps` comes from docs/application-limits.yaml's auto_apply block — the
 * USER'S file. Nothing here supplies defaults for it: a missing cap reads as
 * "not configured" and this returns a refusal, because an unattended process
 * inventing its own blast radius is precisely the failure the block exists to
 * prevent.
 */
export function capCheck(
  { company, caps, sentThisRun = 0, dbFile = DB_PATH, now = new Date() } = {},
) {
  const per_run = caps?.per_run_max
  const per_day = caps?.per_day_max
  const per_company_week = caps?.per_company_max_per_week
  const missing = []
  if (!Number.isFinite(per_run)) missing.push("per_run_max")
  if (!Number.isFinite(per_day)) missing.push("per_day_max")
  if (!Number.isFinite(per_company_week)) missing.push("per_company_max_per_week")
  if (missing.length) {
    return {
      ok: false,
      reason: `auto_apply caps not configured: ${missing.join(", ")}`,
      counts: null,
    }
  }

  if (sentThisRun >= per_run) {
    return {
      ok: false,
      reason: `per_run_max reached (${sentThisRun}/${per_run})`,
      counts: { run: sentThisRun },
    }
  }

  const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000).toISOString()
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString()
  const db = openDb(dbFile)
  try {
    const day = countAutoSubmissions(db, dayAgo)
    const week = countCompanySubmissions(db, company, weekAgo)
    if (day >= per_day) {
      return {
        ok: false,
        reason: `per_day_max reached (${day}/${per_day})`,
        counts: { run: sentThisRun, day, company: week },
      }
    }
    if (week >= per_company_week) {
      return {
        ok: false,
        reason: `per_company_max_per_week reached for ${company} (${week}/${per_company_week}) — counting manual applications too`,
        counts: { run: sentThisRun, day, company: week },
      }
    }
    return { ok: true, reason: null, counts: { run: sentThisRun, day, company: week } }
  } finally {
    db.close()
  }
}
