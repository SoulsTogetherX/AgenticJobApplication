#!/usr/bin/env node
// auto-apply.mjs — the runner's entry point (§4.1). Phase 5 W1.
//
// Usage:
//   node scripts/auto/auto-apply.mjs --limit 10 --concurrency 1
//   node scripts/auto/auto-apply.mjs --fixture --db <tmp>/leads.db --limits <tmp>/limits.yaml
//   node scripts/auto/auto-apply.mjs --enqueue --limit 25      # fill the queue and stop
//   node scripts/auto/auto-apply.mjs --json
//
// ===========================================================================
// WHAT THIS FILE IS, AND WHAT IT IS NOT ALLOWED TO BE
// ===========================================================================
//
// It parses args, opens the database, launches the browser, drives the pool,
// closes down and writes the run record. IT CONTAINS NO CLICK, no trust
// decision, no cap arithmetic and no retry policy. Every one of those lives in
// a module with a test against it, and the reason to keep them out of the entry
// point is that this is the file people edit when they want the runner to "just
// also do X".
//
// ===========================================================================
// THE STATE THIS SHIPS IN
// ===========================================================================
//
// OFF. `auto_apply.enabled` is `false` and `dry_run` is `true` in
// docs/application-limits.yaml, which is the USER'S file — this script reads
// it and never writes it. With `enabled: false` every job defers at the
// authorization gate, which is the correct behaviour and not a bug to work
// around: the runner ships fully built and fully off, and the user turns it on
// after reading a dry-run report they trust.
//
// A dry run still requires `enabled: true`. `enabled` answers "may this machine
// run at all"; `dry_run` answers "does it click". Reading `enabled: false` as
// "dry runs are fine" would make the off switch mean nothing.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  openDb,
  DB_PATH,
  enqueueAutoJobs,
  readResumableAutoJobs,
  setAutoJobState,
  autoQueueCounts,
  hasPassingVerification,
  releaseStaleAutoClaims,
  rowToLead,
  screenIndex,
} from "../lib/db.mjs"
import { loadYamlFile } from "../lib/lib.mjs"
import {
  verifiedResumeUrls,
  verificationIdentity,
  factBaseSha256,
  JOBS_DIR as VERIFY_JOBS_DIR,
} from "../lib/verification.mjs"
import { boardKey } from "../apply/automatability.mjs"
import {
  resolveLeadForTrust,
  allowlistProblems,
  readLimits,
} from "./trust.mjs"
import { preflight, EXIT, DEFAULT_LIMITS } from "./preflight.mjs"
import { startRun } from "./audit.mjs"
import { runPool, originCount } from "./pool.mjs"
import { runJob } from "./job.mjs"
import { makeBreaker } from "./breaker.mjs"
import { StopError, ROOT } from "./guard.mjs"
import { safeText } from "./untrusted-text.mjs"
// The browser leg. `launchBrowser` loads playwright-core lazily (see
// loadChromium), so importing it here costs nothing on the --enqueue path or
// on any invocation that refuses before a run starts.
import { launchBrowser } from "../apply/browser.mjs"
import { makeStages } from "./stages.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const has = (f) => argv.includes(f)
  const get = (f, d = null) => {
    const i = argv.indexOf(f)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d
  }
  const num = (f, d) => {
    const v = get(f, null)
    if (v === null) return d
    const n = Number(v)
    if (!Number.isInteger(n) || n < 1)
      throw new Error(
        `${f} must be a positive integer, got ${JSON.stringify(v)}`,
      )
    return n
  }
  return {
    limit: num("--limit", 25),
    concurrency: num("--concurrency", 1),
    db: get("--db", null),
    limits: get("--limits", null),
    jobsDir: get("--jobs-dir", null),
    fixture: has("--fixture"),
    enqueueOnly: has("--enqueue"),
    json: has("--json"),
    help: has("--help") || has("-h"),
  }
}

// ---------------------------------------------------------------------------
// The refusal W1 is checked on
// ---------------------------------------------------------------------------

/**
 * `--fixture` widens the trust gate to loopback http and points the runner at a
 * throwaway store. Pointed at the REAL store it would write fixture rows into
 * the ledger that decides what the user has already applied to — and those rows
 * count toward caps, so the damage is not cosmetic: a fixture run against
 * jobs/leads.db can silently consume a real employer's weekly budget.
 *
 * So the two are mutually exclusive, checked BEFORE anything opens, and the
 * check is on the RESOLVED path rather than on whether `--db` was passed: a
 * `--db ./jobs/leads.db` is the real store however it was spelled.
 *
 * @throws {Error} with a message the user can act on.
 */
export function assertFixtureIsolation({
  fixture,
  dbFile,
  realDbPath = DB_PATH,
}) {
  if (!fixture) return true
  const resolved = path.resolve(dbFile ?? realDbPath)
  if (resolved === path.resolve(realDbPath))
    throw new Error(
      `--fixture refuses to run against the real lead store (${resolved}). ` +
        `A fixture run writes auto_submissions rows, and those count toward the ` +
        `user's per-day and per-company caps. Pass --db <a temp file>.`,
    )
  return true
}

// ---------------------------------------------------------------------------
// Selection: which jobs go in the queue
// ---------------------------------------------------------------------------

/**
 * Every slug eligible to be applied to, as queue rows.
 *
 * THE WALK IS OVER VERIFICATIONS, NEVER OVER jobs/. `verifiedResumeUrls` starts
 * from the verification rows and asks "do these exact bytes still exist, and
 * does their workspace name a URL?" — so a workspace with a resume and no
 * passing row is never reached. Walking jobs/ and asking "is there a resume
 * here?" is the direction that used to pass unverified documents, and it is
 * recorded in verification.mjs as the fix.
 *
 * The trust gate runs here too, so an untrusted board never enters the queue at
 * all. It runs AGAIN per job in job.mjs, against the origin recorded on the
 * row — the two are not redundant: this one keeps the queue clean, that one
 * catches the lead store changing under a job that is already queued.
 */
export function selectEligible({
  db,
  limits,
  jobsDir = VERIFY_JOBS_DIR,
  allowLoopbackHttp = false,
  limit = 25,
  now = new Date(),
}) {
  const urls = verifiedResumeUrls(db, {
    jobsDir,
    hasPassing: hasPassingVerification,
  })
  const leadRows = db.prepare("SELECT * FROM leads").all()
  const bySlugUrl = new Map()
  for (const row of leadRows) {
    let lead
    try {
      lead = rowToLead(row)
    } catch {
      continue
    }
    for (const key of [lead?.apply_url, lead?.url]) {
      if (key && !bySlugUrl.has(key)) bySlugUrl.set(key, lead)
    }
  }

  // WHERE A SCREENING VERDICT ACTUALLY LIVES, and this was a real defect: the
  // `screens` TABLE, keyed by (lead_id, source) — never on the lead's own JSON
  // doc. This function read `lead.screening ?? lead.screen`, which is a key
  // `rowToLead` essentially never produces, so EVERY lead looked unscreened,
  // the trust gate refused all of them, and the runner reported "nothing
  // eligible" on a store whose leads had all been screened. Measured
  // 2026-08-03: 12 of 14 leads carrying a usable apply_url were rejected for
  // "no stored screening verdict" minutes after screen.mjs had written 27 of
  // them.
  //
  // MODEL FIRST, MECHANICAL AS THE FALLBACK. The model screen (pipeline-jobs
  // Stage A) fetches the live posting and judges ghost/scam/culture signals;
  // the mechanical one is regex over stored text. Both carry the half that
  // matters for hard rule 0 — risk.mjs records a disqualifying finding as an
  // `injection_attempt:<kind>` REASON, which is one of the carriers
  // screeningFindingKinds reads — so a mechanical verdict is a legitimate
  // input here and not a vacuous pass. A lead with neither is still refused.
  const modelScreens = screenIndex(db, "model")
  const mechScreens = screenIndex(db, "mechanical")
  const screeningFor = (lead) =>
    modelScreens.get(lead?.id) ??
    mechScreens.get(lead?.id) ??
    lead?.screening ??
    lead?.screen ??
    null

  const out = []
  const rejected = []
  for (const [url, slug] of urls) {
    if (out.length >= limit) break
    const lead = bySlugUrl.get(url) ?? { slug, apply_url: url, url }
    // THE POSTING AND THE FORM ARE DIFFERENT PAGES on every board this repo
    // adapts, and the runner was being handed the posting. It scanned a job ad,
    // found no fields, and deferred "nothing to fill" — measured on a real lead
    // 2026-08-03. The adapter knows the mapping; it is knowledge, not
    // behaviour, and an unrecognised URL comes back unchanged.
    //
    // RESOLVED ONCE, in `resolveLeadForTrust`, so the trust gate, the board
    // key, the submit token's origin binding and the navigation all agree on
    // ONE url. Resolving it later would leave the token bound to the posting's
    // origin while the page sat on the form's, which on Greenhouse is exactly
    // the mismatch that silently made a filled form unsubmittable. The cycle's
    // prep loop calls the SAME helper — it used to call trustBoard bare, and
    // failed origin_stable on every board lead (2026-08-17).
    const screening = screeningFor(lead)
    const { applyUrl, origin, verdict } = resolveLeadForTrust(
      { ...lead, apply_url: lead.apply_url ?? url },
      { limits, screening, allowLoopbackHttp },
    )
    if (!verdict.ok) {
      rejected.push({ slug, reason: verdict.reason })
      continue
    }
    out.push({
      slug,
      board_key: boardKey(applyUrl),
      origin,
      apply_url: applyUrl,
      posted_at: lead.posted_at ?? null,
      company: lead.company ?? null,
      title: lead.title ?? null,
      // Carried onto the job, because runCampaign seeds `byUrl` from these and
      // runJob hands it to authorizeSubmit — which refuses an UNSCREENED lead
      // outright. Omitting it here meant a lead that had just cleared the trust
      // gate was then refused one stage later for having no verdict.
      screening,
    })
  }
  return { jobs: out, rejected, considered: urls.size, at: now.toISOString() }
}

// ---------------------------------------------------------------------------
// The browser lanes (§4.2)
// ---------------------------------------------------------------------------

/**
 * A per-job page factory.
 *
 * NON-PERSISTENT LANE (the default, and the one the §6.4 allowlist was chosen
 * for): one `browser.newContext()` per job. Genuine per-job cookie and
 * localStorage isolation, no profile copy, nothing on disk — and it is the
 * branch browser.mjs already had. This is what makes "at most one job per
 * origin" a courtesy rather than a load-bearing security control.
 *
 * PERSISTENT LANE (`AUTO_PROFILE`, for boards that genuinely need a session):
 * one page on the shared context, and the origin exclusion in pool.mjs is then
 * doing real work. Chromium's own exclusive on-disk profile lock is what stops
 * two processes sharing it.
 */
export function makeOpenPage(session, { localOnly = true } = {}) {
  return async function openPage(url) {
    if (session.browser) {
      const context = await session.browser.newContext()
      const page = await context.newPage()
      const res = await page.goto(url, { waitUntil: "domcontentloaded" })
      return {
        page,
        url: page.url(),
        status: res?.status() ?? null,
        close: async () => {
          await context.close()
        },
      }
    }
    const page = await session.context.newPage()
    const res = await page.goto(url, { waitUntil: "domcontentloaded" })
    return {
      page,
      url: page.url(),
      status: res?.status() ?? null,
      close: async () => {
        await page.close()
      },
    }
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Drive a queue to completion.
 *
 * Every collaborator is injectable, for the reason job.mjs's header gives: the
 * stages must be IMPORTED rather than spawned (`spawns_per_app` is a gate
 * column asserted to be 0), and a test must be able to supply fakes without
 * this file growing a test branch.
 */
export async function runCampaign({
  dbFile,
  limits,
  mode,
  concurrency = 1,
  limit = 25,
  jobs = null,
  jobsDir = VERIFY_JOBS_DIR,
  allowLoopbackHttp = false,
  openPage,
  scan,
  plan,
  fill,
  classify = null,
  documentsFor = null,
  profileApproved = false,
  autoDir = undefined,
  stopPath = undefined,
  onResult = null,
  staleClaimMs = 30 * 60 * 1000,
  now = () => new Date(),
} = {}) {
  const db = openDb(dbFile)
  let run = null
  try {
    // Anything a previous invocation claimed and never finished. Age-only, and
    // safe ONLY because the (slug, mode) attempted-row insert refuses the loser
    // of any race — §4.3 says so explicitly rather than leaving it implicit.
    //
    // THIS LEASE IS THE ONLY THING CONTROLLING RESUME LATENCY, which is not
    // obvious and cost a test to discover. `readResumableAutoJobs` returns
    // every non-terminal row, including one a LIVE worker is holding, while
    // `claimAutoJob`'s conflict clause only fires on a row still in 'queued'.
    // So a job crashed at 'planned' is handed back by the reader and then
    // refused by the claim — 0 changes, `not-claimed`, no work done — until
    // this call has moved it back to 'queued'. At the 30-minute default, a
    // runner that crashes at 21:00 and restarts at 21:05 does nothing until
    // 21:30.
    //
    // Shortening it is SAFE and merely wasteful: two runners racing one slug
    // both reach beginSubmit and the (slug, mode) insert refuses the loser, so
    // the cost of a lease that is too short is duplicated planning, never a
    // duplicated application. Lengthening it is the conservative direction. It
    // is a parameter rather than a constant because the right value depends on
    // how the user schedules this, which is theirs to decide.
    releaseStaleAutoClaims(db, { leaseMs: staleClaimMs })

    const queued = jobs ?? []
    if (queued.length) enqueueAutoJobs(db, queued)

    // A run is a CURSOR over auto_queue. Resume-after-crash is a SELECT, not a
    // log replay: nothing in the tree reads the JSONL for state, and nothing
    // shall.
    const resumable = readResumableAutoJobs(db).slice(0, limit)

    run = startRun({
      mode,
      dbFile,
      ...(autoDir === undefined ? {} : { autoDir }),
      ...(stopPath === undefined ? {} : { stopPath }),
      meta: { concurrency, queued: resumable.length },
    })

    const byUrl = new Map(queued.map((j) => [j.slug, j]))
    let sentThisRun = 0

    // §4.6. Run state, deliberately not persisted: a pause is a timed backoff
    // with probe re-admission, and carrying one into the next invocation
    // without re-probing is the thing the spec forbids in as many words.
    const breaker = makeBreaker({
      db,
      runId: run.id,
      now: () => now(),
    })

    const pool = await runPool({
      jobs: resumable,
      concurrency,
      // The RUN-level stop only — a board pause never reaches here, which is
      // the whole distinction. `shouldStop` halts NEW work and lets in-flight
      // jobs finish, because killing them mid-fill would leave exactly the
      // ambiguous half-states the ledger exists to avoid.
      shouldStop: () => breaker.runStopReason,
      onResult: (r) => {
        if (r?.submitted) sentThisRun += 1
        if (onResult) onResult(r)
      },
      onSkip: (j, reason) => {
        // A job the run never reached is written with a kind rather than left
        // sitting in 'queued' carrying none. The largest single loss bucket in
        // a degraded run must not be invisible to the digest.
        try {
          setAutoJobState(db, j.slug, "deferred", {
            run_id: run.id,
            reason_kind: "board-paused",
            reason_stage: "queue",
            reason_detail: safeText(reason ?? "the run ended first", 200),
          })
        } catch {
          /* a stranded-job note must never be the thing that throws */
        }
      },
      runOne: async (row) => {
        // THE BREAKER'S ADMISSION GATE (§4.6). A board that just failed
        // repeatedly is backed off; every other board is untouched, and a
        // healthy board is never slowed by this branch. A held job is written
        // with `board-paused` rather than left in 'queued' carrying no kind —
        // the largest loss bucket in a degraded run must not be invisible.
        const gate = breaker.admit(row)
        if (!gate.ok) {
          try {
            setAutoJobState(db, row.slug, "deferred", {
              run_id: run.id,
              reason_kind: "board-paused",
              reason_stage: "queue",
              reason_detail: safeText(
                `${gate.reason}${gate.until ? ` (backing off until ${gate.until})` : ""}`,
                200,
              ),
            })
          } catch {
            /* a stranded-job note must never be the thing that throws */
          }
          return {
            slug: row.slug,
            state: "deferred",
            kind: "board-paused",
            stage: "queue",
            detail: gate.reason,
            submitted: false,
          }
        }
        const seed = byUrl.get(row.slug) ?? {}
        const applyUrl = seed.apply_url ?? row.apply_url ?? null
        const lead = {
          slug: row.slug,
          apply_url: applyUrl,
          url: applyUrl,
          company: seed.company ?? null,
          title: seed.title ?? null,
        }
        const documents = documentsFor
          ? documentsFor(row.slug)
          : defaultDocuments(row.slug, { jobsDir })
        return runJob({
          db,
          run,
          job: {
            slug: row.slug,
            board_key: row.board_key,
            origin: row.origin,
            company: lead.company,
            title: lead.title,
          },
          lead,
          limits,
          screening: seed.screening ?? null,
          mode,
          openPage,
          scan,
          plan,
          fill,
          documents,
          profileApproved,
          sentThisRun,
          allowLoopbackHttp,
          classify,
          dbFile,
          ...(stopPath === undefined ? {} : { stopPath }),
          now,
        }).then((result) => {
          // The breaker sees every outcome, including the good ones — a success
          // is what CLEARS a pause, so a breaker fed only failures could pause
          // a board and never let it back.
          breaker.record({ ...result, board_key: row.board_key })
          return result
        })
      },
    })

    const state = run.finish({
      outcome: pool.stopped_reason ? "stopped" : "ok",
    })
    return {
      run_id: run.id,
      mode,
      outcome: state.outcome,
      concurrency,
      origins: originCount(resumable),
      max_in_flight: pool.max_in_flight,
      started: pool.started,
      skipped: pool.skipped.length,
      results: pool.results,
      counts: autoQueueCounts(db),
      stop_reason: state.stop_reason ?? null,
      // §4.6: paused boards are a FIRST-CLASS RUN OUTCOME, reported as a
      // number rather than as an absence. A run that quietly held back a third
      // of its queue while reporting `ok` is the failure mode this prevents.
      paused_boards: breaker.pausedBoards(),
    }
  } catch (e) {
    if (run) {
      try {
        run.finish({ outcome: e instanceof StopError ? "stopped" : "error" })
      } catch {
        /* the original error is the one worth reporting */
      }
    }
    throw e
  } finally {
    db.close()
  }
}

/** The verification descriptor for a slug's resume, read off disk. */
export function defaultDocuments(slug, { jobsDir = VERIFY_JOBS_DIR } = {}) {
  const resume = path.join(jobsDir, slug, "resume.md")
  const identity = fs.existsSync(resume)
    ? verificationIdentity(resume, { jobsDir })
    : null
  return {
    resume,
    cover: path.join(jobsDir, slug, "cover-letter.md"),
    verification: identity
      ? { ...identity, mode: "resume" }
      : { doc_sha256: null, profile_sha256: factBaseSha256(), mode: "resume" },
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `auto-apply.mjs — the unattended application runner

  --limit N          how many queued jobs this invocation may work (default 25)
  --concurrency N    workers; at most one job per origin regardless (default 1)
  --db <file>        the store. Defaults to jobs/leads.db
  --limits <file>    the limits document. Defaults to docs/application-limits.yaml
  --jobs-dir <dir>   workspace root. Defaults to jobs/
  --enqueue          select eligible jobs into auto_queue and stop
  --fixture          loopback fixture mode: widens the trust gate to loopback
                     http and REFUSES to run against the real lead store
  --json             machine-readable output
`

async function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (e) {
    process.stderr.write(`${e.message}\n`)
    return EXIT.USAGE
  }
  if (args.help) {
    process.stdout.write(USAGE)
    return EXIT.OK
  }

  const dbFile = args.db ?? DB_PATH
  const limitsFile = args.limits ?? DEFAULT_LIMITS
  const jobsDir = args.jobsDir ?? VERIFY_JOBS_DIR

  try {
    assertFixtureIsolation({ fixture: args.fixture, dbFile })
  } catch (e) {
    process.stderr.write(`${e.message}\n`)
    return EXIT.REFUSED
  }

  const limits = readLimits(limitsFile)
  const auto = limits?.auto_apply ?? null
  const mode = auto?.dry_run === false ? "live" : "dry_run"

  // The preflight is what says "would a run start right now?", and it reads the
  // fact base as well as the caps. Its exit codes are save-answer's vocabulary
  // on purpose, so a wrapper can tell refusals apart by number.
  const pf = preflight({
    mode,
    limitsDoc: limits,
    profileDoc: readYamlIfPresent(path.join(ROOT, "profile", "profile.yaml")),
    answersDoc: readYamlIfPresent(path.join(ROOT, "profile", "answers.yaml")),
  })
  if (pf.exit !== EXIT.OK && !args.enqueueOnly) {
    process.stderr.write(
      `preflight refused (exit ${pf.exit}):\n` +
        (pf.checks ?? [])
          .filter((c) => c.verdict !== "pass")
          .map((c) => `  - ${c.id}: ${c.detail}`)
          .join("\n") +
        "\n",
    )
    return pf.exit
  }

  // A misconfigured allowlist reads as "every board is untrusted", which sends
  // the user looking at their boards instead of at their typo. Said once, here.
  for (const p of allowlistProblems(auto?.board_allowlist))
    process.stderr.write(`allowlist: ${p}\n`)

  // WITHOUT --enqueue THIS COMMAND WRITES NOTHING, and that is deliberate. The
  // first version selected and enqueued unconditionally and then refused to run
  // — leaving auto_queue rows in the user's real store as a side effect of a
  // command that had just said no. Selection is a read; putting a job in the
  // queue is a decision, and a decision the caller did not ask for should not
  // survive a refusal.
  const db = openDb(dbFile)
  let selection
  try {
    selection = selectEligible({
      db,
      limits,
      jobsDir,
      allowLoopbackHttp: args.fixture,
      limit: args.limit,
    })
    if (args.enqueueOnly) enqueueAutoJobs(db, selection.jobs)
  } finally {
    db.close()
  }

  if (args.enqueueOnly) {
    const out = {
      enqueued: selection.jobs.length,
      considered: selection.considered,
      rejected: selection.rejected.length,
    }
    process.stdout.write(
      args.json
        ? `${JSON.stringify(out)}\n`
        : `enqueued=${out.enqueued} considered=${out.considered} rejected=${out.rejected}\n`,
    )
    return EXIT.OK
  }

  // THE BROWSER LEG. W1-W3 built the runner and left this unwired, so every
  // invocation returned REFUSED and the whole machine — state machine, trust
  // gate, caps, breaker, pool, classifier — was complete and unreachable. The
  // stages are the SAME in-process code the attended path uses (see
  // stages.mjs); nothing here is a second implementation of the rules.
  //
  // The gates that decide whether anything is actually sent are unchanged and
  // upstream of this line: `mode` is "dry_run" unless the user's own
  // `auto_apply.dry_run` is false, preflight has already refused a run the fact
  // base cannot support, and the trust gate has already emptied the queue of
  // any board that is not on the user's allowlist.
  if (!selection.jobs.length) {
    process.stderr.write(
      `auto-apply: nothing eligible (${selection.considered} considered, ` +
        `${selection.rejected.length} rejected). Nothing to do.\n`,
    )
    return EXIT.OK
  }

  const profileDoc = readYamlIfPresent(
    path.join(ROOT, "profile", "profile.yaml"),
  )
  const stages = makeStages({ jobsDir })

  // AUTO_PROFILE selects the persistent lane — one shared context, for boards
  // that need a logged-in session. Unset (the default) is the per-job
  // non-persistent lane: a fresh context per job, no cookies, nothing on disk.
  // See makeOpenPage for why that choice is the pool's and not job.mjs's.
  const userDataDir = process.env.AUTO_PROFILE || null
  let session
  try {
    session = await launchBrowser({
      userDataDir,
      headless: process.env.AUTO_HEADED ? false : true,
      localOnly: !!args.fixture,
    })
  } catch (e) {
    process.stderr.write(
      `auto-apply: could not start a browser — ${e.message}\n`,
    )
    return EXIT.REFUSED
  }

  try {
    const result = await runCampaign({
      dbFile,
      limits,
      mode,
      concurrency: args.concurrency ?? 1,
      limit: args.limit,
      jobs: selection.jobs,
      jobsDir,
      allowLoopbackHttp: args.fixture,
      openPage: makeOpenPage(session, { localOnly: !!args.fixture }),
      ...stages,
      profileApproved: profileDoc?.meta?.approved_by_user === true,
      onResult: args.json
        ? null
        : (r) =>
            process.stderr.write(
              `  ${r.slug}: ${r.state}${r.reason_kind ? ` (${r.reason_kind})` : ""}\n`,
            ),
    })
    process.stdout.write(
      args.json
        ? `${JSON.stringify(result)}\n`
        : `run=${result.run_id} mode=${result.mode} outcome=${result.outcome} ` +
            `submitted=${result.submitted ?? 0} deferred=${result.deferred ?? 0} ` +
            `failed=${result.failed ?? 0}\n`,
    )
    return EXIT.OK
  } finally {
    await session.close()
  }
}

function readYamlIfPresent(file) {
  try {
    return fs.existsSync(file) ? loadYamlFile(file) : null
  } catch {
    return null
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`${e?.stack ?? e}\n`)
      process.exit(1)
    })
}

export { main, HERE }
