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
//   * The kill switch is checked at startRun and at beginJob, and those checks
//     are on the path to RECORDING, not beside it: a run cannot open and a job
//     cannot start while STOP is set.
//
//     The THIRD checkpoint — immediately before the click — is no longer here.
//     It moved to authorize.mjs, because a check that lives on the path to the
//     RECORD is a check that runs after the click, and an application cannot be
//     unsent. What remains here is beginSubmit(), which writes the durable
//     intent BEFORE the click, and recordSubmission(), which resolves it
//     afterwards. recordSubmission still refuses to acknowledge a submit with
//     no preceding intent — that is a DETECTOR (it records anyway and stops the
//     runner), and it is honest about being one. Prevention is authorize.mjs's
//     token, which the clicking function must present and spend.
//
//   * An attempt is a submission until proven otherwise. The row is written
//     before the click with outcome 'attempted', so a process killed one second
//     after the click still leaves a ledger entry, still counts against
//     per_company_max_per_week, and still names the URL the user needs to check.
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
  JOBS_DIR,
  STOP_PATH,
  CHECKPOINTS,
  StopError,
  assertInsideJobs,
  assertNotStopped,
  raiseStop,
} from "./guard.mjs"
import {
  openDb,
  upsertAutoRun,
  recordAutoSubmission,
  readOrphanAttempts,
  readAttemptsForRun,
  DB_PATH,
} from "../lib/db.mjs"
// The gate. audit.mjs may import it because capCheck moved to caps.mjs, so
// authorize.mjs no longer imports this file and there is no cycle to dodge.
// That is what lets beginSubmit demand the token UNCONDITIONALLY.
import { assertTokenMatches } from "./authorize.mjs"

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

  // Then: did the LAST run leave a click unaccounted for? Second, not first,
  // because an already-set STOP is the more specific answer and raiseStop keeps
  // the first reason.
  assertNoOrphanAttempts({ dbFile, stopPath: stop, jobsDir })

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
  appendEvent(ctx, {
    t: "run.start",
    run_id,
    mode,
    profile: profile_start,
    meta,
  })
  persist(ctx, state)

  return makeRun(ctx, state)
}

/**
 * Refuse to open a run while a previous one has an unaccounted-for click.
 *
 * THE SCENARIO, so this is testable rather than decorative: Task Scheduler's
 * ExecutionTimeLimit (01:00) kills the process one second after a submit click.
 * The application is sitting in the employer's ATS. Nothing acknowledged it,
 * nothing closed the run — and without this, `alreadyApplied` is false and the
 * next run applies to the same company again. Carpet-bombing one employer is
 * the reputational damage that actually costs the user something, and it would
 * have arrived through a crash rather than through a bug in the caps.
 *
 * STOP names the slug and the URL because the only person who can resolve this
 * is the user, by opening the page and looking.
 *
 * @throws {StopError}
 */
export function assertNoOrphanAttempts({
  dbFile = DB_PATH,
  stopPath = null,
  jobsDir = JOBS_DIR,
} = {}) {
  const stop = stopPath ?? STOP_PATH
  const db = openDb(dbFile)
  let orphans
  try {
    orphans = readOrphanAttempts(db)
  } finally {
    db.close()
  }
  if (!orphans.length) return true

  const reason =
    `${orphans.length} submit attempt(s) from a run that never finished — ` +
    `each one may already be an application in the employer's ATS:\n` +
    orphans
      .map(
        (o) =>
          `  - ${o.slug} (${o.company ?? "company unknown"}, ${o.mode ?? "mode unknown"}) ` +
          `attempted ${o.submitted_at} at ${o.apply_url ?? "url not recorded"}`,
      )
      .join("\n") +
    `\nCheck each page, log or withdraw as appropriate, then delete STOP.`
  raiseStop(reason, { stopPath: stop, jobsDir, meta: { orphans } })
  throw new StopError(CHECKPOINTS.RUN_START, reason)
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
  // The durable intent beginSubmit() wrote, cleared by the record that resolves
  // it. One intent resolves one submit; a second record with no second intent
  // is an anomaly and stops the runner.
  let pendingAttempt = null

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
      event("job.begin", {
        slug: job?.slug ?? null,
        company: job?.company ?? null,
        tier: job?.tier ?? null,
      })
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
     * The DURABLE INTENT, written before the click.
     *
     * Both copies get it: `submit.attempt` in the JSONL and an auto_submissions
     * row with outcome 'attempted' and no confirmation URL. From this moment
     * the attempt counts against every cap, because an attempt is a submission
     * until proven otherwise — the alternative reading (a click only counts
     * once something acknowledges it) is the one that re-applies to the same
     * employer after a crash.
     *
     * THE TOKEN IS REQUIRED, and the reason is narrower than "one more check".
     *
     * assertTokenMatches is given THIS RUN'S mode — the mode startRun was
     * opened with — and compares it against the mode the token carries, which
     * authorizeSubmit derived from docs/application-limits.yaml. THIS IS THE
     * ONLY PLACE IN THE TREE WHERE THOSE TWO ARE COMPARED. consumeSubmitToken
     * makes the same call at the click, but with the mode the CALLER states it
     * is performing, which is the caller vouching for itself. So a runner that
     * opened `live` while the user's file says `dry_run: true` is caught here
     * and nowhere else. When this argument was optional, that binding was
     * optional — which is why it is not any more.
     *
     * @param job      {slug, company, title}
     * @param planSha  sha256 of the plan about to be submitted (required)
     * @param url      where the click is aimed — the one thing the user needs
     *                 if this attempt is later found orphaned
     * @param token    the authorizeSubmit() token for this exact submit
     */
    beginSubmit(job, planSha, url, token) {
      const slug = job?.slug ?? null
      if (!slug) throw new TypeError("beginSubmit requires a job with a slug")
      if (typeof planSha !== "string" || !planSha)
        throw new TypeError(
          "beginSubmit requires the plan sha256 — the intent row is what the " +
            "user reads if this attempt is later found orphaned",
        )
      // Throws TokenError on a missing, spent, copied, mismatched or
      // wrong-mode token. Not spent here: the click spends it.
      assertTokenMatches(token, { slug, planSha, mode: state.mode })

      // THE SLOT WAS ALREADY OCCUPIED. Job 3 wrote an intent, something went
      // wrong, nobody resolved or abandoned it, and job 4 is now about to
      // overwrite the only in-memory record of it. Before this check, that
      // attempt became invisible to BOTH safety nets: finish() only ever saw
      // the last slot, and readOrphanAttempts only sees attempts whose RUN
      // never finished. An unresolved previous attempt is exactly the anomaly
      // this machinery exists to surface, so it stops the runner.
      if (pendingAttempt && pendingAttempt.slug !== slug) {
        const stale = pendingAttempt
        pendingAttempt = null
        const reason =
          `a submit attempt for "${stale.slug}" at ${stale.apply_url ?? "url not recorded"} ` +
          `was never resolved or abandoned, and "${slug}" is about to overwrite it — ` +
          `the first one may already be an application`
        event("submit.unresolved", { slug: stale.slug, next: slug })
        raiseStop(reason, {
          stopPath: ctx.stop,
          jobsDir: ctx.jobsDir,
          meta: { run_id: state.run_id, attempt: stale },
        })
        throw new StopError(CHECKPOINTS.PRE_SUBMIT, reason)
      }

      pendingAttempt = {
        run_id: state.run_id,
        slug,
        company: job?.company ?? null,
        title: job?.title ?? null,
        mode: state.mode,
        plan_sha256: planSha,
        apply_url: url,
        outcome: "attempted",
        submitted_at: new Date().toISOString(),
        // The nonce is written here on purpose: it ties this row to the
        // authorisation that produced it, and it is NOT a secret (see
        // authorize.mjs — liveNonces is a spend-once ledger, not a capability
        // key, and this line is one of the reasons why).
        authorized: { nonce: token.nonce, issued_at: token.issued_at },
      }
      event("submit.attempt", pendingAttempt)

      const db = openDb(ctx.dbFile)
      try {
        recordAutoSubmission(db, pendingAttempt)
      } finally {
        db.close()
      }
      return pendingAttempt
    },

    /**
     * The intent was written and THE CLICK NEVER HAPPENED.
     *
     * WHY THIS VERB HAS TO EXIST. Without it, every failure between
     * beginSubmit() and a confirmed click leaves an 'attempted' row: a timeout
     * locating the submit button, a navigation error, a refused token. Each one
     * fires the "this may already be an application" brake and halts the run.
     * The user has decided the runner applies to an unlimited number of jobs,
     * so at hundreds of jobs per run transient click-site failures are certain,
     * not possible — and a brake that fires on healthy runs is a brake the user
     * deletes, which means it is not there for the one crash that mattered.
     *
     * THE DISCIPLINE, and it is the caller's to keep: only a failure PROVABLY
     * BEFORE the click may use this. A timeout DURING a click is ambiguous —
     * the request may have reached the ATS — and ambiguity must stay an orphan
     * and stop the runner. `beforeClick: true` is required rather than
     * defaulted so that asserting it is a deliberate act at the call site,
     * visible in review, and never something a caller slid past by omission.
     *
     * An abandoned row is kept, not deleted: it is the evidence that the
     * attempt existed. It does not count against any cap, because no
     * application exists to count.
     */
    abandonAttempt(slug, reason, { beforeClick } = {}) {
      if (beforeClick !== true)
        throw new TypeError(
          "abandonAttempt requires { beforeClick: true } — the caller must " +
            "assert the click was never issued. A failure DURING a click is " +
            "ambiguous and must stay an orphan.",
        )
      if (!reason || typeof reason !== "string")
        throw new TypeError(
          "abandonAttempt requires a stated reason — a silent skip is not a deferral",
        )
      if (!pendingAttempt || pendingAttempt.slug !== slug)
        throw new TypeError(
          `abandonAttempt: no open attempt for "${slug}"` +
            (pendingAttempt
              ? ` (the open one is "${pendingAttempt.slug}")`
              : ""),
        )

      const row = {
        ...pendingAttempt,
        outcome: "abandoned",
        abandoned_at: new Date().toISOString(),
        abandon_reason: reason,
      }
      pendingAttempt = null
      event("submit.abandoned", { slug, reason })

      const db = openDb(ctx.dbFile)
      try {
        recordAutoSubmission(db, row)
      } finally {
        db.close()
      }
      return row
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
      const attempt = pendingAttempt
      if (!attempt || attempt.slug !== (sub?.slug ?? null)) {
        // A DETECTOR, and it says so. A submit with no preceding intent means
        // the click happened outside the path that writes one, so the durable
        // row that survives a crash was never written — but the click has
        // already happened, and nothing recorded afterwards can prevent it.
        // Prevention is authorize.mjs's token; this stops the NEXT one.
        event("submit.unchecked", { slug: sub?.slug ?? null })
        raiseStop(
          `a submission for "${sub?.slug}" was recorded without a matching pre-submit intent row`,
          {
            stopPath: ctx.stop,
            jobsDir: ctx.jobsDir,
            meta: { run_id: state.run_id },
          },
        )
      }
      pendingAttempt = null

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
        // Carried forward from the intent, and BEFORE the spread so an
        // explicit value in `sub` still wins: the attempt knows where the click
        // was aimed, and the acknowledgement must not blank it.
        apply_url: attempt?.apply_url ?? null,
        attempted_at: attempt?.submitted_at ?? null,
        ...sub,
        outcome: "submitted",
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
          {
            stopPath: ctx.stop,
            jobsDir: ctx.jobsDir,
            meta: { run_id: state.run_id },
          },
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
      return raiseStop(reason, {
        stopPath: ctx.stop,
        jobsDir: ctx.jobsDir,
        meta,
      })
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

      // Every intent this run wrote and never resolved — READ BACK FROM THE
      // LEDGER, not from the in-memory slot.
      //
      // The slot holds one attempt. An attempt abandoned at job 3 of 200 that
      // nobody resolved is gone from the slot the moment job 4 calls
      // beginSubmit, and readOrphanAttempts cannot see it either, because that
      // query only returns attempts whose RUN never finished and this run is
      // about to finish. Querying the ledger is the only reading that catches
      // all of them; the slot would catch at most the last one. (beginSubmit
      // now also stops the runner rather than overwriting an occupied slot, so
      // this is the second net under a hole that should no longer open.)
      pendingAttempt = null
      let unresolved = []
      {
        const db = openDb(ctx.dbFile)
        try {
          unresolved = readAttemptsForRun(db, state.run_id)
        } finally {
          db.close()
        }
      }
      if (unresolved.length && !state.stop_reason) {
        state.stop_reason =
          `run finished with ${unresolved.length} unresolved submit attempt(s), ` +
          `each of which may already be an application:\n` +
          unresolved
            .map(
              (a) =>
                `  - ${a.slug} at ${a.apply_url ?? "url not recorded"} (attempted ${a.submitted_at})`,
            )
            .join("\n")
      }

      state.profile_sha_end = profile_end
      state.finished_at = now.toISOString()
      state.outcome = state.stop_reason ? "stopped" : outcome
      event("run.finish", {
        outcome: state.outcome,
        planned: state.planned,
        submitted: state.submitted,
        deferred: state.deferred,
        failed: state.failed,
        unresolved_attempts: unresolved.map((a) => a.slug),
        profile: profile_end,
        profile_mutated: mutated,
      })
      persist(ctx, state)
      if (unresolved.length) {
        raiseStop(state.stop_reason, {
          stopPath: ctx.stop,
          jobsDir: ctx.jobsDir,
          meta: { run_id: state.run_id, attempts: unresolved },
        })
      }
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
