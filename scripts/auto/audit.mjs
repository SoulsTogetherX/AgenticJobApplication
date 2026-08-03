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
//   * Every string written to either copy is scrubbed of instruction-shaped
//     text first (untrusted-text.mjs), because the record is the one artefact
//     of an unattended run that a human later hands to a model. Hard rule 0
//     does not stop applying because the page text has been through a database.
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
  raiseSecurityAlert,
  stopKey,
} from "./guard.mjs"
import {
  openDb,
  upsertAutoRun,
  recordAutoSubmission,
  acknowledgeAutoSubmission,
  readAutoSubmission,
  readOrphanAttempts,
  readAttemptsForRun,
  DB_PATH,
} from "../lib/db.mjs"
// The gate. audit.mjs may import it because capCheck moved to caps.mjs, so
// authorize.mjs no longer imports this file and there is no cycle to dodge.
// That is what lets beginSubmit demand the token UNCONDITIONALLY.
import { assertTokenMatches } from "./authorize.mjs"
import { safeText, scrubRecord } from "./untrusted-text.mjs"

// The two files the fact base lives in. Hashed, never written.
export const PROFILE_FILES = ["profile.yaml", "answers.yaml"]

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex")

/**
 * raiseStop options braking ONE COMPANY, or the global brake when nothing names
 * one (§4.9).
 *
 * The fallback is the whole point of the helper and it is deliberately the
 * pessimistic direction: a company-scoped brake filed under a guessed or empty
 * key would read as "handled" while braking nothing, which is strictly worse
 * than the halt it replaced. If we cannot say which employer may be holding an
 * application, the honest answer is that we do not know, and not knowing stops
 * everything.
 */
function companyScope(company) {
  const name = typeof company === "string" ? company.trim() : ""
  return name ? { scope: "company", key: name } : {}
}

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
  //
  // This no longer halts the run — it brakes the affected COMPANIES (§4.9) and
  // returns their keys. The brake FILES are the enforcement, read per job by
  // assertNotStopped({ company }); this list is carried on the run state so the
  // report can say "3 companies held back" as a number rather than as a
  // silence. An orphan with no company attached still throws.
  const orphanScope = assertNoOrphanAttempts({
    dbFile,
    stopPath: stop,
    jobsDir,
  })

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
    // Companies this run may not touch because a previous run left an
    // unaccounted-for click there. A NUMBER in the report, never an absence.
    blocked_companies: orphanScope.blocked,
    jsonl,
    ...(meta ? { meta } : {}),
  }

  const ctx = {
    dir,
    stop,
    jobsDir,
    dbFile,
    profileDir,
    jsonl,
    inbox: path.join(autoDir, "INBOX.md"),
  }
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
 * Refuse to run the COMPANIES that have an unaccounted-for click.
 *
 * THE SCENARIO, so this is testable rather than decorative: Task Scheduler's
 * ExecutionTimeLimit (01:00) kills the process one second after a submit click.
 * The application is sitting in the employer's ATS. Nothing acknowledged it,
 * nothing closed the run — and without this, `alreadyApplied` is false and the
 * next run applies to the same company again. Carpet-bombing one employer is
 * the reputational damage that actually costs the user something, and it would
 * have arrived through a crash rather than through a bug in the caps.
 *
 * SCOPED TO THE COMPANY (§4.9), AND THIS IS A DELIBERATE NARROWING OF WHAT USED
 * TO HAPPEN HERE. It used to raise a global STOP and throw, so one undecidable
 * orphan on one employer halted every future invocation until a human deleted a
 * file — right at N=3 and wrong at N=999, because the blast radius of the halt
 * scaled with the run and the trigger did not.
 *
 * NOTHING ABOUT THE ACTUAL PROTECTION IS WEAKER. The damage this exists to
 * prevent is a second application to THE SAME employer, and a company-scoped
 * brake blocks exactly that, for as long as the global one did — it is durable
 * and there is no code path that clears it. What it stops doing is taking the
 * other 998 companies down with it.
 *
 * AN ORPHAN WITH NO COMPANY STILL GOES GLOBAL, because a brake has to be filed
 * against something and "we do not know which employer may hold an application"
 * is not a case to be optimistic about.
 *
 * @returns {{ok: boolean, blocked: string[]}} — `blocked` is the company keys
 *   now braked, so a caller can exclude them and run everything else.
 * @throws {StopError} only when an orphan could not be attributed to a company.
 */
export function assertNoOrphanAttempts({
  dbFile = DB_PATH,
  stopPath = null,
  jobsDir = JOBS_DIR,
  inboxPath = null,
  stopsDir = null,
} = {}) {
  const stop = stopPath ?? STOP_PATH
  const inbox = inboxPath ?? path.join(jobsDir, ".auto", "INBOX.md")
  const db = openDb(dbFile)
  let orphans
  try {
    orphans = readOrphanAttempts(db)
  } finally {
    db.close()
  }
  if (!orphans.length) return { ok: true, blocked: [] }

  const describe = (o) =>
    `${o.slug} (${o.company ?? "company unknown"}, ${o.mode ?? "mode unknown"}) ` +
    `attempted ${o.submitted_at} at ${o.apply_url ?? "url not recorded"}`

  const blocked = []
  const unattributed = []
  for (const o of orphans) {
    const company = typeof o.company === "string" ? o.company.trim() : ""
    if (!company) {
      unattributed.push(o)
      continue
    }
    raiseStop(
      `a submit attempt from a run that never finished may already be an ` +
        `application at ${company}:\n  - ${describe(o)}\n` +
        `Check that page, log or withdraw as appropriate, then delete this file. ` +
        `Other companies are unaffected and will keep running.`,
      {
        scope: "company",
        key: company,
        stopPath: stop,
        stopsDir,
        jobsDir,
        inboxPath: inbox,
        meta: { orphan: o },
      },
    )
    blocked.push(stopKey(company))
  }

  if (unattributed.length) {
    const reason =
      `${unattributed.length} submit attempt(s) from a run that never finished, ` +
      `and NOTHING RECORDS WHICH EMPLOYER they were aimed at — so there is no ` +
      `company to brake and this has to stop everything:\n` +
      unattributed.map((o) => `  - ${describe(o)}`).join("\n") +
      `\nCheck each page, log or withdraw as appropriate, then delete STOP.`
    raiseStop(reason, {
      stopPath: stop,
      stopsDir,
      jobsDir,
      inboxPath: inbox,
      meta: { orphans: unattributed },
    })
    throw new StopError(CHECKPOINTS.RUN_START, reason)
  }

  return { ok: false, blocked }
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

// PHASE 0.3 — the scrub happens HERE, on the way into the record, because this
// is the funnel every event passes through and a per-call-site scrub is a list
// of places to forget. The escaping above deals with a record that is PASTED;
// this deals with a record that is READ BY A MODEL, which is the likelier of
// the two the moment anyone writes "summarise last night's run".
//
// Deny by default: every string is scrubbed unless its key is machine-shaped
// (untrusted-text.mjs's VERBATIM_KEYS — ids, hashes, timestamps, and the
// confirmation URL the user clicks to withdraw). A field added to an event next
// month is scrubbed without anybody remembering this line exists.
//
// A record that CONTAINED something carries `untrusted_findings` — kinds and
// counts, never the payload. Redacting silently would leave the report saying
// "3 fields deferred" when the truth is "3 fields deferred and one of them was
// talking to your agent", and that second sentence is the one worth reading.
function appendEvent(ctx, event) {
  const scrubbed = scrubRecord({ at: new Date().toISOString(), ...event })
  const line =
    JSON.stringify({
      ...scrubbed.value,
      ...(scrubbed.findings.length
        ? { untrusted_findings: scrubbed.findings }
        : {}),
    }).replace(JS_LINE_SEPARATORS, (c) =>
      c.charCodeAt(0) === 0x2028 ? "\\u2028" : "\\u2029",
    ) + "\n"
  fs.appendFileSync(
    assertInsideJobs(ctx.jsonl, { jobsDir: ctx.jobsDir }),
    line,
    "utf8",
  )

  // Phase 4.3: the same finding also goes to the channel a human reads. It
  // does NOT stop anything — rule 0's answer to hostile page text is
  // sanitisation and deferral, not halting — but "a board tried to instruct
  // the agent" is not a fact that should only exist inside a JSONL nobody
  // opens. Kinds and counts travel; the payload never does.
  if (scrubbed.findings.length)
    raiseSecurityAlert(
      {
        summary:
          `${scrubbed.findings.reduce((n, f) => n + f.count, 0)} instruction-shaped ` +
          `finding(s) in a ${event?.t ?? "run"} event` +
          (event?.slug ? ` on ${event.slug}` : ""),
        slug: event?.slug ?? null,
        event: event?.t ?? null,
        findings: scrubbed.findings,
      },
      { inboxPath: ctx.inbox, jobsDir: ctx.jobsDir },
    )
}

/**
 * The row form of the same boundary: scrub a record and carry the finding kinds
 * on it, so the DB copy and the JSONL copy say the same thing.
 *
 * `untrusted_findings` is OMITTED when clean, so hundreds of honest rows do not
 * each grow an empty array — the same shape untrustedSnippet uses on leads.
 */
function scrubbed(row) {
  const r = scrubRecord(row)
  return r.findings.length
    ? { ...r.value, untrusted_findings: r.findings }
    : r.value
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

    /** CHECKPOINT 2 of 3: between every job.
     *
     *  SCOPED (§4.9), and this is where a company or board brake is actually
     *  ENFORCED. The brake FILES are the source of truth — not a list carried
     *  in run state — so a brake raised by a worker mid-run is seen by the next
     *  job without anything having to pass it along. */
    beginJob(job) {
      assertNotStopped(CHECKPOINTS.BETWEEN_JOBS, {
        stopPath: ctx.stop,
        company: job?.company ?? null,
        board: job?.board_key ?? job?.board ?? null,
        runId: state.run_id,
      })
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
        // TWO SEPARATE HALTS, and they are separate because they have
        // different evidence behind them.
        //
        // The DURABLE brake is company-scoped, on the STALE attempt's company:
        // the thing that may already be an application is at that employer, and
        // that is the whole of what this proves about future runs.
        //
        // The thrown StopError halts THIS run in-process, which it must —
        // pendingAttempt is a single slot and the bookkeeping that was supposed
        // to protect it just failed, so continuing would mean trusting the same
        // slot again. It writes no file, so the next invocation starts clean
        // and only the braked company is held back.
        raiseStop(reason, {
          ...companyScope(stale.company),
          stopPath: ctx.stop,
          jobsDir: ctx.jobsDir,
          meta: { run_id: state.run_id, attempt: stale },
        })
        throw new StopError(CHECKPOINTS.PRE_SUBMIT, reason)
      }

      // Scrubbed ONCE, here, and the same object goes to both copies. The JSONL
      // gets its own pass in appendEvent, but the auto_submissions row does
      // not — db.mjs stores `doc: JSON.stringify(sub)` — and two copies that
      // disagree about what a page said are worse than either copy alone.
      pendingAttempt = scrubbed({
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
      })
      event("submit.attempt", pendingAttempt)

      // THE LEDGER CLAIM. recordAutoSubmission is an INSERT ... ON CONFLICT DO
      // NOTHING on (slug, mode), so it returns 0 when this slug already has a
      // row in this mode — an earlier run of this slug that was attempted or
      // submitted and never withdrawn.
      //
      // After a successful auto_queue claim that must not be possible, so it is
      // an anomaly, not a race: the queue claim is what stops two workers from
      // reaching here for one slug, and a collision HERE means the application
      // may already be in the employer's ATS. It stops the runner rather than
      // clicking again, because carpet-bombing one employer is the damage that
      // actually costs the user something.
      //
      // (A `dry_run` row never collides with a `live` one. The rehearsal is a
      // different row, deliberately, so it cannot pre-consume the live claim.)
      let claimed = 0
      let existing = null
      const db = openDb(ctx.dbFile)
      try {
        claimed = recordAutoSubmission(db, pendingAttempt)
        if (claimed === 0)
          existing = readAutoSubmission(db, slug, pendingAttempt.mode)
      } finally {
        db.close()
      }
      if (claimed === 0) {
        pendingAttempt = null
        const reason =
          `the ledger already holds a ${existing?.mode ?? state.mode} row for "${slug}" ` +
          `(${existing?.outcome ?? "outcome unknown"}, run ${existing?.run_id ?? "unknown"}, ` +
          `${existing?.submitted_at ?? "time unknown"} at ${existing?.apply_url ?? "url not recorded"}) — ` +
          `this submit was refused because that application may already exist`
        event("submit.refused", { slug, existing })
        // COMPANY-SCOPED: the evidence is "this slug may already be an
        // application", and a slug belongs to one employer. The collision says
        // nothing about the other 998 leads, and the damage it exists to
        // prevent — a second application to this employer — is prevented in
        // full by braking this employer.
        raiseStop(reason, {
          ...companyScope(job?.company ?? existing?.company),
          stopPath: ctx.stop,
          jobsDir: ctx.jobsDir,
          meta: { run_id: state.run_id, slug, existing },
        })
        throw new StopError(CHECKPOINTS.PRE_SUBMIT, reason)
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

      const row = scrubbed({
        ...pendingAttempt,
        outcome: "abandoned",
        abandoned_at: new Date().toISOString(),
        // Page-derived: an abandon reason is usually a locator or a browser
        // error message with the form's own text quoted inside it.
        abandon_reason: reason,
      })
      pendingAttempt = null
      event("submit.abandoned", { slug, reason })

      // acknowledge, not record: this RESOLVES the claim beginSubmit already
      // holds. Going through the claim would report 0 changes and silently drop
      // the abandonment, leaving an 'attempted' row that halts the next run.
      const db = openDb(ctx.dbFile)
      try {
        acknowledgeAutoSubmission(db, row)
      } finally {
        db.close()
      }
      return row
    },

    /**
     * Resolve a DRY-RUN attempt that passed every precondition and stopped.
     *
     * WHY THIS IS ITS OWN VERB AND NOT recordSubmission. recordSubmission
     * requires a confirmation_url — and raises STOP without one, correctly,
     * because a live submission with nothing to point at is a record that
     * cannot support a manual withdrawal. A rehearsal has no confirmation to
     * record and never will, so routing it through that verb leaves exactly two
     * options: STOP on every dry run, or invent a URL. Both are worse than a
     * second verb.
     *
     * WHY NOT abandonAttempt EITHER, which is the other obvious reading. An
     * abandoned row does not count toward any cap (db.mjs's `outcome IS NOT
     * 'abandoned'`), and the schema is explicit that dry-run rows count on
     * purpose: the rehearsal has to exercise the same cap arithmetic the live
     * run will, or the first live night meets caps it has never once tested.
     * So the row is resolved as 'submitted' — meaning "this rehearsal reached
     * the submit", which is exactly what it did.
     *
     * It refuses in a live run. A live run that rehearsed a slug would consume
     * that slug's live claim without sending anything.
     */
    recordRehearsal(sub) {
      if (state.mode === "live")
        throw new TypeError(
          "recordRehearsal is for dry runs only — a live run that rehearsed a " +
            "slug would consume its (slug, 'live') claim without submitting anything",
        )
      const attempt = pendingAttempt
      if (!attempt || attempt.slug !== (sub?.slug ?? null))
        throw new TypeError(
          `recordRehearsal: no open attempt for "${sub?.slug ?? "(no slug)"}"` +
            (attempt ? ` (the open one is "${attempt.slug}")` : ""),
        )
      pendingAttempt = null

      const row = scrubbed({
        run_id: state.run_id,
        mode: state.mode,
        submitted_at: new Date().toISOString(),
        apply_url: attempt.apply_url ?? null,
        attempted_at: attempt.submitted_at ?? null,
        ...sub,
        // A rehearsal, stated in the row itself. `outcome: 'submitted'` is what
        // the caps read; `rehearsal: true` is what a human reads.
        rehearsal: true,
        confirmation_url: null,
        outcome: "submitted",
      })
      state.submitted += 1
      event("submit.rehearsed", row)

      const db = openDb(ctx.dbFile)
      try {
        acknowledgeAutoSubmission(db, row)
        upsertAutoRun(db, state)
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
        // GLOBAL, and it is one of the few things that should be. §4.6 reserves
        // global for a broken invariant, and this is the durable-attempt
        // invariant broken from the other end: a click reached an employer
        // without the row that was supposed to exist BEFORE it. That says the
        // submit path itself is not the shape this directory believes it is,
        // which is not a fact about one company or one board.
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

      // THE CONSENT LABELS AND THE VERIFY BLOCK ARE PAGE TEXT, and this row is
      // the single richest source of it in the whole record — which makes it
      // the one a "summarise last night's run" feature reads first.
      const row = scrubbed({
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
      })
      state.submitted += 1
      event("submit.done", row)

      // acknowledge, not record. The claim refuses an existing row by design;
      // this is the second of the two writes per application, and it must never
      // be the one that gets dropped — an application cannot be unsent, so
      // losing its outcome is strictly worse than recording it late.
      const db = openDb(ctx.dbFile)
      try {
        acknowledgeAutoSubmission(db, row)
        upsertAutoRun(db, state)
      } finally {
        db.close()
      }

      if (missing.length) {
        // COMPANY-SCOPED. The application went out and the record cannot
        // support a withdrawal — a fact about THIS employer, and the user's
        // action is to go and look at this employer's page. If the omission is
        // systemic it fires again on the next company, and N inbox entries
        // naming N employers is a clearer signal than one global brake that
        // names the first.
        raiseStop(
          `submission "${sub?.slug}" was recorded without: ${missing.join(", ")}` +
            ` — the record cannot support a manual withdrawal`,
          {
            ...companyScope(row.company ?? attempt?.company),
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
     *
     * @param scope §4.9's blast radius. Defaults to `global`, which is right
     *   for the four §4.6 invariant breaches this verb was written for and
     *   wrong for anything else — a caller with evidence about one board or one
     *   company should say so and pass a `key`, because global is the scope
     *   that costs a night.
     */
    stop(reason, meta = null, { scope = "global", key = null } = {}) {
      // The STOP file's own text is scrubbed too. It is the shortest path from
      // a hostile page to a human's screen — the user opens it to find out why
      // the runner disabled itself — and the reason usually quotes the page.
      const safe = safeText(reason, 400)
      // Only a run-wide halt is the RUN's outcome. A board or company brake
      // leaves the run running and reporting `ok`, which is the entire point of
      // scoping — writing stop_reason here would make a 998-application success
      // read as a stopped run.
      if (scope === "global" || scope === "run") state.stop_reason = safe
      event("run.stop", { reason: safe, scope, key, meta })
      persist(ctx, state)
      return raiseStop(safe, {
        scope,
        key,
        stopPath: ctx.stop,
        jobsDir: ctx.jobsDir,
        inboxPath: ctx.inbox,
        meta: scrubRecord(meta).value,
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
      // ONE BRAKE PER UNRESOLVED ATTEMPT, on its own company — the same
      // narrowing as assertNoOrphanAttempts and for the same reason. An attempt
      // with no company recorded falls back to global (companyScope), because
      // "an application may exist somewhere and we cannot say where" is not a
      // case to be optimistic about.
      for (const a of unresolved) {
        raiseStop(
          `this run finished without resolving a submit attempt for "${a.slug}" ` +
            `at ${a.apply_url ?? "url not recorded"} (attempted ${a.submitted_at}) — ` +
            `it may already be an application`,
          {
            ...companyScope(a.company),
            stopPath: ctx.stop,
            jobsDir: ctx.jobsDir,
            meta: { run_id: state.run_id, attempt: a },
          },
        )
      }
      if (mutated) {
        // RUN-SCOPED, not global, and that is a correction rather than a
        // loosening. §4.6 classes `fact-base-changed` as a DEFERRAL — the user
        // answered a save-answer.mjs prompt at 21:40, which is them using the
        // system correctly — and specifies the behaviour as "finish the run
        // against the snapshot in profile_sha_start, report the drift once".
        // A global brake here would have the machine halt every future night
        // because the user edited their own file, which is the opposite of what
        // that says. The NEXT invocation reads the current fact base and is by
        // construction consistent with it.
        raiseStop(
          "profile/ changed during an unattended run — the fact base this run reasoned from is not the one on disk now",
          {
            scope: "run",
            key: state.run_id,
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
