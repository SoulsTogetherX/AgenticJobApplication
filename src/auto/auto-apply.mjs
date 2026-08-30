#!/usr/bin/env node
// auto-apply.mjs — the runner's entry point (§4.1). Phase 5 W1.
//
// Usage:
//   node src/auto/auto-apply.mjs --limit 10 --concurrency 1
//   node src/auto/auto-apply.mjs --fixture --db <tmp>/leads.db --limits <tmp>/limits.yaml
//   node src/auto/auto-apply.mjs --enqueue --limit 25      # fill the queue and stop
//   node src/auto/auto-apply.mjs --json
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
  findPriorApplication,
  AUTO_QUEUE_TERMINAL,
} from "#lib/db.mjs"
import { loadYamlFile } from "#lib/lib.mjs"
import { assertKnownFlags } from "#lib/args.mjs"
import {
  verifiedResumeUrls,
  verificationIdentity,
  factBaseSha256,
  JOBS_DIR as VERIFY_JOBS_DIR,
} from "#lib/verification.mjs"
import { boardKey } from "../apply/automatability.mjs"
import { resolveLeadForTrust, allowlistProblems, readLimits } from "./trust.mjs"
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

// Every flag the runner understands, and the subset taking a value.
//
// TWO OF THESE FAIL OPEN WHEN MISSPELLED, which is why they are validated
// rather than merely read. `--enqeue` does not enable enqueue-only mode, so the
// invocation the user meant as "select jobs and stop" SUBMITS. And `--fixtur`
// leaves `fixture` false, so `assertFixtureIsolation` below — which exists to
// stop a fixture run writing ledger rows that count toward real caps — never
// fires, and the run proceeds against the real store. Neither typo produced any
// output saying so before 2026-08-24.
export const RUNNER_FLAGS = [
  "--limit",
  "--concurrency",
  "--db",
  "--limits",
  "--jobs-dir",
  "--fixture",
  "--enqueue",
  "--json",
  "--help",
]
export const RUNNER_VALUE_FLAGS = [
  "--limit",
  "--concurrency",
  "--db",
  "--limits",
  "--jobs-dir",
]

export function parseArgs(argv) {
  // Before anything is read, so a typo cannot reach a decision. `-h` is checked
  // first because it is the one short flag and would otherwise be refused.
  if (!argv.includes("-h"))
    assertKnownFlags(argv, {
      known: RUNNER_FLAGS,
      valueFlags: RUNNER_VALUE_FLAGS,
      script: "auto-apply.mjs",
      note:
        "a misspelled --enqueue submits instead of enqueuing, and a " +
        "misspelled --fixture runs against the real lead store",
    })
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
// Saying why, which is the whole point of computing a reason
// ---------------------------------------------------------------------------
//
// `selectEligible` builds a `{slug, reason}` for every candidate it turns away,
// across eight distinct kinds, and the CLI printed `rejected: 54`. Measured
// 2026-08-24: a run that enqueued 3 of 57 and applied to none gave the user no
// way to tell "everything worth applying to is already applied" (18 of them)
// from "two workspaces are structurally unreachable" (2 of them) — and the
// second is a bug while the first is the system working.
//
// `tests/auto/queue.test.mjs:249` already states the principle for the queue:
// "a deferral without a reason is refused — a silent skip is not a deferral".
// This applies the same rule one stage earlier, at selection.

/** The stable kind of a rejection reason, for grouping. */
export function rejectionKind(reason) {
  const s = String(reason ?? "")
  // The trust gate returns `${check}: ${detail}` over its five named checks,
  // so the prefix before the colon is already the kind. Everything else is a
  // fixed sentence from one of the four `rejected.push` sites.
  if (/^(allowlist|adapter|screening|https|origin_stable):/.test(s))
    return s.slice(0, s.indexOf(":"))
  if (/^lead status is dismissed/.test(s)) return "dismissed"
  if (/^already applied/.test(s)) return "already-applied"
  if (/^resume\.pdf is not rendered/.test(s)) return "no-resume-pdf"
  if (/^workspace has no lead row/.test(s)) return "no-lead-row"
  return "other"
}

/** Counts by kind, plus one example slug per kind so the reason is actionable. */
export function rejectionBreakdown(rejected = []) {
  const by = new Map()
  for (const r of rejected) {
    const kind = rejectionKind(r?.reason)
    const cur = by.get(kind) ?? { kind, count: 0, example: null, reason: null }
    cur.count += 1
    if (!cur.example) {
      cur.example = r?.slug ?? null
      cur.reason = String(r?.reason ?? "")
    }
    by.set(kind, cur)
  }
  return [...by.values()].sort((a, b) => b.count - a.count)
}

/** The human rendering: one line per kind, commonest first. */
export function formatRejections(breakdown = []) {
  if (!breakdown.length) return ""
  return breakdown
    .map((b) => `  ${String(b.count).padStart(3)}  ${b.kind}  (${b.example})\n`)
    .join("")
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
    // A WORKSPACE WITH NO LEAD ROW IS NOT A DEGRADED CANDIDATE, IT IS AN
    // IMPOSSIBLE ONE, and saying so here is the difference between a five
    // minute fix and an afternoon.
    //
    // The candidate set comes from `verifications` (verifiedResumeUrls), which
    // never touches `leads`. The ATTENDED path — apply-job / tailor-resume —
    // builds jobs/<slug>/job.json from a pasted URL and runs verify-claims,
    // writing exactly the row this walk selects on, while never creating a
    // lead. Measured 2026-08-24: 11 of 69 workspaces are in that state, and
    // nothing deletes leads (there is no `DELETE FROM leads` in the tree), so
    // these were never pruned — they were never enrolled.
    //
    // The fabricated object below cannot pass: no `id` means every `screens`
    // lookup misses and the trust gate refuses "no stored screening verdict";
    // no `status` means the dismissed guard can never fire; no `company` means
    // authorize's `company_known` check fails; no `posted_at` means it is
    // excluded from latency even if it somehow submitted. There is no
    // configuration in which it reaches a submit.
    //
    // It used to be refused for the missing VERDICT, which sends the reader to
    // screen.mjs — where the answer is not, because screening is keyed by
    // lead_id and there is no lead to key. Two reachable, allowlisted,
    // fully-verified jobs (ethos-software-engineer,
    // runpod-software-engineer-full-stack) sat behind that wrong signpost.
    const known = bySlugUrl.get(url)
    const lead = known ?? { slug, apply_url: url, url }
    // A DISMISSED LEAD IS NOT A CANDIDATE, whatever its workspace holds. This
    // walk starts from verification rows, so a lead the user (or a prune)
    // marked `dismissed` AFTER its résumé was verified was still queued and
    // still spent a browser lane — measured 2026-08-17: a Coinbase posting
    // dismissed as closed reached the plan stage, scanned an empty page and
    // was written up as a `plan-error`. The status is the user's own verdict
    // on the lead and it is read here for the same reason already-applied is:
    // the queue must not re-open a decision the ledgers already record.
    if (lead.status === "dismissed") {
      rejected.push({
        slug,
        reason: "lead status is dismissed — not queued while it stays so",
      })
      continue
    }
    // NO RENDERED RÉSUMÉ, NO QUEUE ROW. The verification row vouches for the
    // markdown; the ATS file input wants the PDF, and buildPlan defers the whole
    // application when it is missing ("no rendered resume"). Two jobs on
    // 2026-08-17 were queued on a passing verification, opened a browser, and
    // deferred on exactly that. Refusing here costs a row and no page load, and
    // the reason names the one command that clears it.
    if (!fs.existsSync(path.join(jobsDir, slug, "resume.pdf"))) {
      rejected.push({
        slug,
        reason:
          "resume.pdf is not rendered for this workspace — run " +
          "src/documents/render-pdf.mjs on its resume.md first",
      })
      continue
    }
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
      // A MISSING LEAD ROW IS A DIFFERENT PROBLEM FROM A MISSING VERDICT, and
      // only the screening check can confuse the two.
      //
      // The candidate set comes from `verifications` (verifiedResumeUrls),
      // which never touches `leads`. The ATTENDED path — apply-job /
      // tailor-resume — builds jobs/<slug>/job.json from a pasted URL and runs
      // verify-claims, writing exactly the row this walk selects on, while
      // never creating a lead. Measured 2026-08-24: 11 of 69 workspaces are in
      // that state, and nothing deletes leads (there is no `DELETE FROM leads`
      // anywhere in the tree), so these were never pruned — never enrolled.
      //
      // Such a lead is refused for having no screening verdict, which sends
      // the reader to screen.mjs — where the answer is not, because screening
      // is keyed by lead_id and there is no lead to key. Two reachable,
      // allowlisted, fully-verified jobs sat behind that wrong signpost.
      //
      // REPORTED ONLY WHEN IT IS THE ONLY THING WRONG. The trust gate runs
      // first and its other refusals outrank this one: telling someone to
      // import a lead for a board that is not on their allowlist sends them to
      // do work that changes nothing.
      const missingLead =
        !known && /^screening:/.test(String(verdict.reason ?? ""))
      rejected.push({
        slug,
        reason: missingLead
          ? `workspace has no lead row — its job.json was created by the ` +
            `attended path (apply-job/tailor-resume), so it was never ` +
            `screened and cannot be: screening is keyed by lead_id. Import ` +
            `it as a lead, or apply to it attended.`
          : verdict.reason,
      })
      continue
    }
    // ALREADY APPLIED, CHECKED HERE TOO. The submit gate has the load-bearing
    // copy of this check (`not_already_applied`), because a job already sitting
    // in auto_queue is resumed without passing through selection at all. This
    // one is the cheap half: it keeps a posting the user has already pursued
    // from being enqueued and then spending a browser lane and ~26 s of real
    // form-filling only to be refused at the end.
    //
    // Rejected rather than silently dropped, for the same reason the trust gate
    // reports its refusals: "we found you a job and it is one you already
    // applied to" is information about a stale queue, not noise.
    const prior = findPriorApplication(db, {
      slug,
      urls: [applyUrl, lead.apply_url, lead.url].filter(Boolean),
    })
    if (prior) {
      rejected.push({
        slug,
        reason:
          `already applied on ${prior.applied_at ?? "an unrecorded date"} ` +
          `(matched by ${prior.matched})`,
      })
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
      // The store's own key for this lead. Persisted on the queue row so a
      // resumed job can re-read its screening verdict from the `screens`
      // table, which is keyed by (lead_id, source) — see runCampaign.
      lead_id: lead.id ?? null,
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
  autoDir = null,
  stopPath = null,
  onResult = null,
  staleClaimMs = 30 * 60 * 1000,
  now = () => new Date(),
} = {}) {
  // ONE TREE, NOT TWO. `jobsDir` is the workspace root; `autoDir` is that
  // root's control directory and `stopPath` the brake inside it — `AUTO_DIR`
  // is literally `JOBS_DIR/.auto`, and `STOP_PATH` is `AUTO_DIR/STOP`. Letting
  // them DEFAULT independently means a caller who redirects the tree keeps
  // writing the audit trail to the real one, and nothing says so.
  //
  // Measured 2026-08-30: 165 of the 234 files in the user's own
  // jobs/.auto/runs were tests/auto/browser-leg.test.mjs's, which passes a
  // sandbox `jobsDir` and no `autoDir`. Its run JSONL went to the real tree
  // while its database rows went to the sandbox — splitting in half the two
  // copies audit.mjs's header requires to agree. On a clone with no jobs/ at
  // all the same split surfaced instead as a BoundaryError from
  // assertInsideJobs, which was right: a write it cannot prove lands inside
  // the tree is a write it must refuse.
  //
  // So the defaults are DERIVED, not a second set of constants: redirect the
  // tree and everything downstream follows, including startRun's own view
  // (it reads `path.resolve(autoDir, "..")` back, which is now this jobsDir
  // exactly). Absence is unchanged — `path.join(VERIFY_JOBS_DIR, ".auto")` IS
  // `AUTO_DIR` and `join(that, "STOP")` IS `STOP_PATH` — so a caller passing
  // neither behaves as it always did, and `--jobs-dir` (documented as
  // "workspace root") now moves the whole tree rather than half of it.
  //
  // An explicit `autoDir` belonging to some OTHER tree is a caller bug and
  // throws, rather than writing the record to two places. Same class as
  // ec5ebc2 / 30a6697 / bacaeb5: the harness owns every path it writes.
  const jobsRoot = path.resolve(jobsDir)
  const auto = autoDir ? path.resolve(autoDir) : path.join(jobsRoot, ".auto")
  if (path.dirname(auto) !== jobsRoot) {
    throw new Error(
      `runCampaign: autoDir must be the .auto directory of jobsDir, and is not.\n` +
        `  jobsDir: ${jobsRoot}\n  autoDir: ${auto}\n` +
        `A run whose audit trail lives outside its own workspace writes the ` +
        `JSONL and the database rows into two different trees.`,
    )
  }
  const stop = stopPath ? path.resolve(stopPath) : path.join(auto, "STOP")

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
      autoDir: auto,
      stopPath: stop,
      meta: { concurrency, queued: resumable.length },
    })

    const byUrl = new Map(queued.map((j) => [j.slug, j]))
    let sentThisRun = 0

    // THE SCREENING VERDICT FOR A ROW THIS RUN DID NOT SELECT. `byUrl` only
    // knows the jobs selectEligible produced in THIS invocation; every other
    // resumable row — enqueued earlier, beyond this run's --limit in a
    // differently ordered list, or left by a crash — used to reach runJob with
    // `screening: null` and be refused as unscreened (and, with no apply_url,
    // as untrusted). The row now carries `lead_id`, so its verdict is one map
    // lookup away, in the same order of preference selectEligible uses: model
    // first, mechanical as the fallback. Read once per run, lazily, so an
    // invocation whose every row was seeded pays nothing.
    let screensByLead = null
    const screeningFor = (leadId) => {
      if (!leadId) return null
      if (!screensByLead) {
        screensByLead = {
          model: screenIndex(db, "model"),
          mechanical: screenIndex(db, "mechanical"),
        }
      }
      return (
        screensByLead.model.get(leadId) ??
        screensByLead.mechanical.get(leadId) ??
        null
      )
    }

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
        // THE ROW IS THE FALLBACK FOR EVERYTHING THE SEED WOULD SUPPLY. Before
        // the queue row carried apply_url/lead_id/company/title, a row this
        // invocation had not itself selected resumed as an anonymous slug and
        // fell at the trust gate — measured 2026-08-17 (Torc Robotics,
        // "the lead carries no apply_url" on a lead whose store row had one).
        // Seed first, because it is fresher; row second, because it is what
        // makes resume-after-crash a SELECT rather than a re-selection.
        const seed = byUrl.get(row.slug) ?? {}
        const applyUrl = seed.apply_url ?? row.apply_url ?? null
        const lead = {
          slug: row.slug,
          id: seed.lead_id ?? row.lead_id ?? null,
          apply_url: applyUrl,
          url: applyUrl,
          company: seed.company ?? row.company ?? null,
          title: seed.title ?? row.title ?? null,
        }
        const screening =
          seed.screening ?? screeningFor(seed.lead_id ?? row.lead_id) ?? null
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
          screening,
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
          stopPath: stop,
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
      // THE TALLIES, and they have to be here rather than left for the caller
      // to derive. `run.finish()` already computed them and wrote them to the
      // run JSONL; omitting them from this object made the one line a human
      // reads after an unattended run print `submitted=0 deferred=0 failed=0`
      // unconditionally, because the caller's `result.deferred ?? 0` had no
      // `deferred` to find. Caught 2026-08-17 by the first dry-run rehearsal:
      // the audit log said deferred=1, stdout said deferred=0.
      //
      // Under-reporting in this direction is the dangerous one. `submitted=0`
      // after a run that really did submit reads as "nothing went out", which
      // is the one thing an operator must never be told wrongly — and it would
      // have said exactly that on the first live submit.
      planned: state.planned ?? 0,
      submitted: state.submitted ?? 0,
      deferred: state.deferred ?? 0,
      failed: state.failed ?? 0,
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
  let added = 0
  let stuck = []
  try {
    selection = selectEligible({
      db,
      limits,
      jobsDir,
      allowLoopbackHttp: args.fixture,
      limit: args.limit,
    })
    // The RETURN VALUE, not the input length. `enqueueAutoJobs` reports how
    // many rows it actually changed, and both call sites used to throw that
    // away and print the SELECTED count instead. Measured 2026-08-24:
    // `enqueued=3` while only 2 rows moved — the third was a slug whose queue
    // row sat in a terminal state, so it re-selected on every run and was
    // silently dropped at the resumable SELECT. That one number is what the
    // whole eliza investigation needed and could not get.
    if (args.enqueueOnly) {
      added = enqueueAutoJobs(db, selection.jobs)
      // WHICH selected slugs are in a state nothing can move them out of.
      // Computed here, while the connection is open, because this is the one
      // moment both halves are known: what selection chose, and what the queue
      // actually holds.
      const slugs = selection.jobs.map((j) => j.slug)
      if (slugs.length) {
        const rows = db
          .prepare(
            `SELECT slug, state FROM auto_queue
              WHERE slug IN (${slugs.map(() => "?").join(",")})`,
          )
          .all(...slugs)
        stuck = rows.filter((r) => AUTO_QUEUE_TERMINAL.has(r.state))
      }
    }
  } finally {
    db.close()
  }

  if (args.enqueueOnly) {
    const out = {
      // `selected` and `added` disagree exactly when a slug cannot enter the
      // queue — a terminal row, or a conflict clause that did not fire. Naming
      // both is what makes that visible instead of inferable.
      selected: selection.jobs.length,
      added,
      enqueued: added,
      considered: selection.considered,
      rejected: selection.rejected.length,
      rejectedBy: rejectionBreakdown(selection.rejected),
      stuck,
    }
    process.stdout.write(
      args.json
        ? `${JSON.stringify(out)}\n`
        : `enqueued=${out.added} selected=${out.selected} ` +
            `considered=${out.considered} rejected=${out.rejected}\n` +
            formatRejections(out.rejectedBy),
    )
    // ONLY WARN ABOUT THE ONES THAT ARE ACTUALLY STUCK. `selected` and `added`
    // also differ for the ordinary case of a row that is already resumable —
    // enqueueAutoJobs leaves those alone by design — so warning on the
    // difference would fire on almost every run and be ignored by the time it
    // mattered. A TERMINAL row is the real signal: selection keeps choosing it
    // and the queue keeps refusing it, silently, forever.
    if (out.stuck.length)
      process.stderr.write(
        `auto-apply: ${out.stuck.length} selected job(s) sit in a terminal ` +
          `state and cannot re-enter the queue: ` +
          `${out.stuck.map((r) => `${r.slug}(${r.state})`).join(" ")}\n` +
          `  Inspect with: node src/auto/requeue.mjs --list\n`,
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
  // THE SAME LIMITS FILE FOR THE STAGES AS FOR THE GATE. `--limits <file>` used
  // to reach the trust gate, preflight and the submit gate while makeStages()
  // silently read docs/application-limits.yaml for the disclosure limits and
  // the assent policy — so a rehearsal against a copy of the user's file was
  // planning under one policy and gating under another. One file, every reader.
  const stages = makeStages({ jobsDir, limitsFile })

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
      // `r.kind`, not `r.reason_kind` — the per-job result from job.mjs's
      // `done()` names it `kind`, so the old key was never present and this
      // line printed a bare state for every job in every run. The detail is
      // what makes it actionable ("confirm-field: 3 field(s) need a human;
      // first: <label>"), so it is included and bounded rather than dropped.
      onResult: args.json
        ? null
        : (r) =>
            process.stderr.write(
              `  ${r.slug}: ${r.state}${r.kind ? ` (${r.kind})` : ""}` +
                `${r.detail ? ` — ${String(r.detail).replace(/\s+/g, " ").slice(0, 160)}` : ""}\n`,
            ),
    })
    // A WHOLE-CACHE DISCARD RIDES OUT ON THE RESULT, not on stderr. Every
    // remembered form shape was thrown away, so every combo on every board
    // gets re-probed this run and the pipeline reads amber for a reason that
    // has nothing to do with the boards. cycle.mjs deletes a successful step's
    // stderr, so the warning field-cache.mjs prints never reaches the log on
    // the one path that runs unattended — see CLAUDE.md's field-cache entry.
    const discarded = stages.cacheDiscard?.()
    if (discarded) result.cache_discarded = discarded
    process.stdout.write(
      args.json
        ? `${JSON.stringify(result)}\n`
        : `run=${result.run_id} mode=${result.mode} outcome=${result.outcome} ` +
            `submitted=${result.submitted ?? 0} deferred=${result.deferred ?? 0} ` +
            `failed=${result.failed ?? 0}\n` +
            (discarded
              ? `  WARN: the field cache was discarded (v${discarded.fromVersion ?? "?"} -> ` +
                `v${discarded.toVersion}, ${discarded.forms ?? 0} form(s)) — every combo ` +
                `was re-probed this run\n`
              : ""),
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
