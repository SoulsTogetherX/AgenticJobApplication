#!/usr/bin/env node
// bench-runner.mjs — the CAMPAIGN harness. Phase 4.7.
//
// bench-apply measures one application. This measures a run of them: N jobs at
// concurrency C against the loopback fixture, through the real queue, with the
// real plan and fill engines, and reports the nine numbers the CI gate is
// written against.
//
// Usage:
//   node scripts/dev/bench-runner.mjs --apps 50 --concurrency 8 --board greenhouse --runs 3 --json
//   node scripts/dev/bench-runner.mjs --apps 8 --concurrency 4          # a quick look
//   node scripts/dev/bench-runner.mjs --apps 50 --concurrency 8 --ledger
//
// ===========================================================================
// WHAT THIS HARNESS IS, AND THE ONE THING IT IS NOT
// ===========================================================================
//
// THERE IS NO RUNNER YET. Phase 5 owns it, and Phase 4 is a precondition of
// Phase 5, so this file necessarily predates the thing whose name it carries.
// That is a real tension and pretending otherwise would produce the worst
// possible outcome — a second runner, with its own retry policy and its own
// idea of when a job is done, that the real one later has to be reconciled
// with.
//
// So the rule this file holds to: IT DRIVES PRODUCT CODE AND DECIDES NOTHING.
// The scan engine, fill-plan, the fill engine, the queue state machine, the
// taxonomy and the classifier are all the shipped modules. What this file
// supplies is only the parts a benchmark must supply anyway — a worker pool, a
// clock, and a fixture. It contains no policy: no retry rule, no backoff, no
// trust decision, and NO CLICK. In dry-run it records a `dry_run` submission
// row exactly as the real path would and stops there.
//
// DONE 2026-08-03 (Phase 5 W3): the pool is no longer this file's. It calls the
// shipped `runPool` from scripts/auto/pool.mjs, which carries the ORIGIN
// exclusion key the old local loop did not — so `max_in_flight` is now a number
// a production run can actually reach rather than an upper bound on a
// scheduler that never shipped. The per-job driver is still `oneJob` below, and
// the reason is stated at the call site.
//
// ===========================================================================
// MEASURED vs DERIVED — and why one column changed definition
// ===========================================================================
//
// bench-apply labels every column `measured` or `derived` and this one keeps
// that contract. But 4.7 required something bench-apply does not do: that
// `model_turns` and `round_trips` be CLOCKED rather than derived from a
// documented protocol. The reason is sharp — the CI gate makes
// `model_turns > 0` a hard, no-override failure, and a DERIVED column can
// never fire it. A number computed from a static model of the prescribed MCP
// flow will report whatever the model says regardless of what the code did.
//
// So both are observed here:
//
//   round_trips  — clockedPage's `cdp_calls` for a browser leg, and for the
//                  accounted leg the instrumented page's own call counter.
//                  Counted, not assumed.
//   model_turns  — every child process spawned and every outbound HTTP request
//                  to a non-loopback host, counted by a `--require` preload
//                  (spawn-counter.cjs). NOT by an in-process monkeypatch: that
//                  was tried, and it counts zero. Read that file's header
//                  before touching this — the CLI re-execs itself to install
//                  the preload precisely because the obvious approach silently
//                  measures nothing.
//
// THE PLAN'S WORDING FOR model_turns IS TOO BROAD AND THIS FILE NARROWS IT.
// 4.7 says "process spawns plus outbound HTTP to any non-loopback host". Taken
// literally that is red on every run by construction, because benchPlan shells
// out to `node scripts/apply/fill-plan.mjs` once per application — a
// deterministic local script, and the very thing the plan wants us to use MORE
// of. A gate that fires on the sanctioned behaviour gets an override line
// within a week, which is the exact failure mode the plan reasons about
// correctly for wall_ms and then walks into here.
//
// The narrowing, which preserves what the gate is FOR:
//
//   spawns_per_application  counts EVERY spawn. Unfiltered. It is one of the
//                           nine columns in its own right and it is where a
//                           regression in process count shows up.
//   model_turns             counts a spawn only when it is NOT this repo's own
//                           node running a file under scripts/ — plus every
//                           non-loopback request.
//
// A real model call cannot hide from that. Either it is an HTTPS request to a
// provider (counted), or it shells out to a CLI such as `claude` (counted —
// not node, or not a repo script). What it does exclude is the one case that
// is provably not a model: this project's own deterministic scripts.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import child_process from "node:child_process"
import { performance } from "node:perf_hooks"
import { fileURLToPath, pathToFileURL } from "node:url"
import { assertKnownFlags } from "../lib/args.mjs"

import {
  ROOT,
  PROFILES,
  benchScan,
  benchPlan,
  benchFill,
  fixtureScanPath,
  writeBenchAnswers,
  stats,
  provenance,
  MEASURED_FILES,
} from "./bench-apply.mjs"
import { start as startFixture } from "../../tests/fixtures/boards/server.mjs"
// The SHIPPED pool (§4.2). This harness used to carry its own, which had no
// origin exclusion and could therefore report a concurrency this runner cannot
// reach — see the note at the pool call below.
import { runPool } from "../auto/pool.mjs"
import {
  openDb,
  enqueueAutoJobs,
  claimAutoJob,
  setAutoJobState,
  recordAutoSubmission,
  readReasonCounts,
} from "../lib/db.mjs"
import {
  classifyPlanDefers,
  toStateOpts,
  reasonClass,
} from "../auto/taxonomy.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// The instruments.
// ---------------------------------------------------------------------------

export const COUNTER_PRELOAD = path.join(HERE, "spawn-counter.cjs")

const ZERO_COUNTS = {
  spawns: 0,
  foreign_spawns: 0,
  outbound_requests: 0,
  loopback_requests: 0,
  spawn_argv: [],
  outbound_hosts: [],
  installed: false,
}

/**
 * Read the preload's counters, or say plainly that they are not there.
 *
 * THE COUNTERS CANNOT BE INSTALLED FROM INSIDE THIS MODULE. See the note at
 * the top of spawn-counter.cjs, which records the two obvious workarounds and
 * the zero each of them measured: a module that did
 * `import { execFileSync } from "node:child_process"` is bound to the export
 * the builtin published at bootstrap, and reassigning the property afterwards
 * -- before a dynamic import, or on the default-imported namespace -- counts
 * nothing at all.
 *
 * So the columns that depend on this are `unmeasured` with a stated reason
 * when the preload is absent, exactly as bench-apply reports a column that
 * genuinely needs a browser. An estimate printed in a measurement column is
 * the one thing neither harness does.
 */
export function readCounters() {
  const c = globalThis.__ajCounters
  if (!c || !c.installed) return { ...ZERO_COUNTS }
  return {
    ...c,
    spawn_argv: [...c.spawn_argv],
    outbound_hosts: [...c.outbound_hosts],
  }
}

/**
 * Read the rows every CHILD process wrote on its way out.
 *
 * THE PARENT'S OWN COUNTERS ARE NOT ENOUGH, and this was measured rather than
 * assumed. The plan leg shells out to `scripts/apply/fill-plan.mjs` once per
 * application, so a model call added THERE — the fill path, precisely what the
 * plan's falsifiable check names — happens in a process the parent cannot see.
 * With parent-only counting that mutation was scored 0 and the hard gate stayed
 * green. So NODE_OPTIONS carries the preload down, each descendant appends one
 * line on exit, and this sums them.
 */
export function readChildCounters(file, ownPid = process.pid) {
  const out = { ...ZERO_COUNTS, installed: true, processes: 0 }
  let text = ""
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return { ...ZERO_COUNTS }
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue // a torn line is one process's row, not a reason to report nothing
    }
    if (row.pid === ownPid) continue // the parent is counted live, not from here
    out.processes += 1
    out.spawns += row.spawns ?? 0
    out.foreign_spawns += row.foreign_spawns ?? 0
    out.outbound_requests += row.outbound_requests ?? 0
    out.loopback_requests += row.loopback_requests ?? 0
    out.spawn_argv.push(...(row.spawn_argv ?? []))
    out.outbound_hosts.push(...(row.outbound_hosts ?? []))
  }
  return out
}

/** Nearest-rank percentile. Null on an empty sample, never zero. */
export function pct(values, p) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!xs.length) return null
  return xs[
    Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1))
  ]
}

const round = (x, d = 2) =>
  x === null || x === undefined ? null : Math.round(x * 10 ** d) / 10 ** d

// ---------------------------------------------------------------------------
// One application. Product code end to end; this function supplies no policy.
// ---------------------------------------------------------------------------

async function oneJob({
  db,
  job,
  boardName,
  jobsDir,
  behaviour,
  realSleep,
  mode,
  runId,
  edgeSpacingMs,
}) {
  const t0 = performance.now()
  const out = {
    slug: job.slug,
    board_key: job.board_key,
    origin: job.origin,
    wall_ms: 0,
    sleep_ms: 0,
    spacing_ms: 0,
    cdp_calls: 0,
    state: null,
    reason_kind: null,
    failed: false,
  }

  // Edge spacing: the courtesy wait §4.2b asks for, applied per origin. It is
  // ZERO by default and the column says so — this harness measures the wait it
  // actually performed, and inventing one the runner does not yet make would
  // be reporting a policy that does not exist.
  if (edgeSpacingMs > 0) {
    const s0 = performance.now()
    await new Promise((r) => setTimeout(r, edgeSpacingMs))
    out.spacing_ms = performance.now() - s0
  }

  if (
    claimAutoJob(db, job.slug, {
      run_id: runId,
      board_key: job.board_key,
      origin: job.origin,
    }) !== 1
  ) {
    // 0 changes means another worker owns it. The normal fan-out result, not
    // an error — and the loser returns without touching the job.
    out.state = "not-claimed"
    out.wall_ms = performance.now() - t0
    return out
  }

  try {
    const scan = JSON.parse(
      fs.readFileSync(fixtureScanPath(job.fixture ?? boardName, 1), "utf8"),
    )
    scan.url = job.url
    const answersFile = writeBenchAnswers(jobsDir)

    const scanLeg = await benchScan({
      scan,
      url: job.url,
      behaviour,
      realSleep,
    })

    const filesDir = path.join(jobsDir, "_files")
    fs.mkdirSync(filesDir, { recursive: true })
    const resume = path.join(filesDir, "resume.pdf")
    const cover = path.join(filesDir, "cover-letter.pdf")
    if (!fs.existsSync(resume))
      fs.writeFileSync(resume, "%PDF-1.4 bench placeholder\n")
    if (!fs.existsSync(cover))
      fs.writeFileSync(cover, "%PDF-1.4 bench placeholder\n")

    const planLeg = benchPlan({
      scan,
      url: job.url,
      jobsDir,
      slug: job.slug,
      files: { resume, cover },
      answersFile,
    })
    setAutoJobState(db, job.slug, "planned", {
      run_id: runId,
      plan_sha256: null,
    })

    const fillLeg = await benchFill({
      planFile: planLeg.planFile,
      plan: planLeg.plan,
      url: job.url,
      behaviour,
      realSleep,
    })

    const scanCost = scanLeg.driver.cost
    out.sleep_ms =
      scanCost.sleep_unconditional_ms +
      scanCost.sleep_typing_ms +
      fillLeg.cost.sleep_unconditional_ms +
      fillLeg.cost.sleep_typing_ms
    out.cdp_calls = (scanCost.cdp_calls ?? 0) + (fillLeg.cost.cdp_calls ?? 0)

    // THE OUTCOME, decided by the shipped classifier and nothing else.
    const record = classifyPlanDefers(planLeg.plan.defer, {
      stage: "plan",
      board_key: job.board_key,
      origin: job.origin,
    })
    if (record) {
      setAutoJobState(db, job.slug, record.state, {
        run_id: runId,
        ...toStateOpts(record),
      })
      out.state = record.state
      out.reason_kind = record.kind
      out.failed = record.state === "failed"
    } else {
      // Nothing deferred. In dry-run this is where the real path would click;
      // here it writes the same durable row and stops. NO CLICK EXISTS IN THIS
      // FILE.
      recordAutoSubmission(db, {
        run_id: runId,
        slug: job.slug,
        company: job.board_key,
        mode,
        submitted_at: new Date().toISOString(),
        outcome: "submitted",
        apply_url: job.url,
        doc: JSON.stringify({ bench: true }),
      })
      setAutoJobState(db, job.slug, "submitted", { run_id: runId })
      out.state = "submitted"
    }
  } catch (e) {
    out.failed = true
    out.state = "failed"
    out.reason_kind = "plan-error"
    out.error = String(e?.message ?? e).slice(0, 200)
    try {
      setAutoJobState(db, job.slug, "failed", {
        run_id: runId,
        reason_kind: "plan-error",
        reason_stage: "plan",
        reason_detail: out.error,
      })
    } catch {
      /* the harness must report the failure even if the row will not take it */
    }
  }
  out.wall_ms = performance.now() - t0
  return out
}

// ---------------------------------------------------------------------------
// One campaign.
// ---------------------------------------------------------------------------

export async function runCampaign({
  apps = 8,
  concurrency = 4,
  boardName = "greenhouse",
  origins = null,
  profileName = "typical",
  realSleep = false,
  mode = "dry_run",
  edgeSpacingMs = 0,
  latency = null,
} = {}) {
  const behaviour = PROFILES[profileName]
  if (!behaviour) throw new Error(`unknown profile ${profileName}`)
  if (!Number.isInteger(apps) || apps < 1)
    throw new Error("--apps must be >= 1")
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error("--concurrency must be >= 1")

  const originCount = origins ?? Math.min(concurrency, apps)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aj-bench-runner-"))
  const jobsDir = path.join(dir, "jobs")
  fs.mkdirSync(jobsDir, { recursive: true })

  const board = await startFixture({ origins: originCount, latency })
  const db = openDb(path.join(dir, "leads.db"))
  const runId = `bench-${Date.now().toString(36)}`

  // `--board` takes a comma list and the jobs round-robin across it.
  //
  // WHY THAT MATTERS FOR THE GATE. `--board greenhouse` alone produces
  // defer_rate = 1.0 BY CONSTRUCTION: that fixture carries a consent tickbox,
  // every application defers on it, and `submitted_per_hour` is then
  // structurally zero. That is a true fact about the fixture, not a harness
  // defect — but a gate whose defer-rate column can only ever read 1.0 is
  // asserting nothing. `--board greenhouse,honest-greenhouse` gives both
  // columns something to move.
  const boardNames = String(boardName)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  const urls = board.applyUrls(apps)
  const jobs = urls.map((url, i) => {
    const u = new URL(url)
    return {
      slug: `bench-${String(i).padStart(4, "0")}`,
      fixture: boardNames[i % boardNames.length],
      // The TENANT is the board_key — that is what the per-board cap and the
      // paused-board list key on. The ORIGIN is the exclusion key. They differ
      // on purpose and a harness that conflated them would report N=1
      // behaviour under an N=8 label.
      board_key: `${boardNames[i % boardNames.length]}:${u.pathname.split("/")[2] ?? "emp"}`,
      origin: u.origin,
      url,
      posted_at: new Date(Date.now() - 36 * 3_600_000).toISOString(),
      run_id: runId,
    }
  })
  enqueueAutoJobs(db, jobs)

  // --- the pool. Forty lines, and the runner replaces exactly these. --------
  //
  // MAX-IN-FLIGHT IS OBSERVED, not assumed. The fixture being CAPABLE of eight
  // origins is not the run USING them: if the exclusion key serialises the
  // work, this reports N=1 throughput under an N=8 label, which is precisely
  // the number the CI gate would then be enforcing.
  // Carry the instrument into every descendant for the duration of the
  // campaign, and restore the environment afterwards — a benchmark that leaves
  // NODE_OPTIONS set has changed the machine it was measuring.
  const counterFile = path.join(dir, "counters.jsonl")
  const savedNodeOptions = process.env.NODE_OPTIONS
  const savedCounterFile = process.env.AJ_COUNTER_FILE
  const instrumented = readCounters().installed
  if (instrumented) {
    process.env.AJ_COUNTER_FILE = counterFile
    process.env.NODE_OPTIONS = `${savedNodeOptions ? savedNodeOptions + " " : ""}--require ${JSON.stringify(COUNTER_PRELOAD)}`
  }

  const before = readCounters()
  const t0 = performance.now()

  // THE SHIPPED POOL, not a second one. Until Phase 5 W3 this file ran its own
  // cursor-and-workers loop, and that loop had NO ORIGIN EXCLUSION — so it
  // could report max_in_flight 8 on a queue the real runner would serialise to
  // 1, and the CI gate would then have been enforcing a throughput number that
  // no production run could reach. The header always named this as the move to
  // make once the runner landed; it has landed.
  //
  // The per-job driver below is still this harness's own `oneJob`, not
  // job.mjs's `runJob`: runJob needs a trust verdict, a verification row and a
  // document descriptor per slug, which a benchmark would have to fabricate.
  // What matters for the numbers this file reports is the SCHEDULING, and that
  // is now the shipped module rather than a copy of it.
  const pool = await runPool({
    jobs,
    concurrency,
    runOne: (job) =>
      oneJob({
        db,
        job,
        boardName,
        jobsDir,
        behaviour,
        realSleep,
        mode,
        runId,
        edgeSpacingMs,
      }),
  })
  const results = pool.results
  const maxInFlight = pool.max_in_flight
  const wallMs = performance.now() - t0
  // Deltas, not totals: the fixture startup and the module graph made requests
  // and spawns of their own before the first job, and attributing those to the
  // applications would inflate every per-app column.
  const after = readCounters()
  if (instrumented) {
    if (savedNodeOptions === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = savedNodeOptions
    if (savedCounterFile === undefined) delete process.env.AJ_COUNTER_FILE
    else process.env.AJ_COUNTER_FILE = savedCounterFile
  }
  const kids = instrumented
    ? readChildCounters(counterFile)
    : { ...ZERO_COUNTS }
  const counts = {
    installed: after.installed,
    child_processes: kids.processes ?? 0,
    spawns: after.spawns - before.spawns + kids.spawns,
    foreign_spawns:
      after.foreign_spawns - before.foreign_spawns + kids.foreign_spawns,
    outbound_requests:
      after.outbound_requests -
      before.outbound_requests +
      kids.outbound_requests,
    loopback_requests:
      after.loopback_requests -
      before.loopback_requests +
      kids.loopback_requests,
    spawn_argv: [
      ...after.spawn_argv.slice(before.spawn_argv.length),
      ...kids.spawn_argv,
    ],
    outbound_hosts: [
      ...after.outbound_hosts.slice(before.outbound_hosts.length),
      ...kids.outbound_hosts,
    ],
  }

  const reasons = readReasonCounts(db, { run_id: null })

  // THE LEDGER INVARIANT, read off the store rather than counted in memory.
  //
  // Two facts the gate asserts, and they are asserted here because this is the
  // only place both are true at once — after the last job and before the
  // fixture store is thrown away:
  //
  //   durable rows === applications that reached the point of clicking, and
  //   nothing is still sitting in 'attempted' at run end.
  //
  // An 'attempted' row at run end is an ORPHAN: a click was issued and nothing
  // ever said what happened next. In a benchmark that means the harness lost
  // track of a job; on the real path it means an application may already be in
  // an employer's ATS with nobody knowing.
  const ledger = {
    durable_rows: db.prepare("SELECT COUNT(*) c FROM auto_submissions").get().c,
    rows_in_state_attempted: db
      .prepare("SELECT COUNT(*) c FROM auto_queue WHERE state = 'attempted'")
      .get().c,
  }
  db.close()
  await board.stop()
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* a leaked handle must not fail a completed measurement */
  }

  return summarise({
    results,
    reasons,
    ledger,
    counts,
    wallMs,
    apps,
    concurrency,
    maxInFlight,
    originCount,
    boardName,
    profileName,
    mode,
    edgeSpacingMs,
    latency: board.latency,
  })
}

// ---------------------------------------------------------------------------
// The nine numbers.
// ---------------------------------------------------------------------------

const M = (value, statistic, note = null) => ({
  value,
  method: "measured",
  statistic,
  ...(note ? { note } : {}),
})
// Reported as null with a reason, NEVER as an estimate. The whole point of the
// column labels is that a reader can tell the difference between a number and
// a guess without asking anybody.
const U = (note) => ({
  value: null,
  method: "unmeasured",
  statistic: null,
  note,
})

function summarise(x) {
  const done = x.results.filter((r) => r.state !== "not-claimed")
  const submitted = done.filter((r) => r.state === "submitted")
  const deferred = done.filter((r) => r.state === "deferred")
  const failed = done.filter((r) => r.failed)
  const hours = x.wallMs / 3_600_000
  const per = (n) => (done.length ? n / done.length : null)

  // Per-board failure rate p — the number the whole breaker calibration rests
  // on, and one nobody has ever measured.
  const byBoard = new Map()
  for (const r of done) {
    const b = byBoard.get(r.board_key) ?? { n: 0, failed: 0 }
    b.n += 1
    if (r.failed) b.failed += 1
    byBoard.set(r.board_key, b)
  }
  const failure_rate_p = Object.fromEntries(
    [...byBoard].map(([k, v]) => [k, round(v.failed / v.n, 4)]),
  )

  // Defer rate by CLASS, not by kind: an engineer reading this needs to know
  // whether the number is theirs to move. `understanding` is; `assent` is not,
  // and must not be.
  const byClass = {}
  for (const r of deferred) {
    const c = reasonClass(r.reason_kind) ?? "unclassified"
    byClass[c] = (byClass[c] ?? 0) + 1
  }
  const defer_rate_by_class = Object.fromEntries(
    Object.entries(byClass).map(([c, n]) => [c, round(n / done.length, 4)]),
  )

  const walls = done.map((r) => r.wall_ms)

  return {
    harness: "bench-runner",
    board: x.boardName,
    profile: x.profileName,
    mode: x.mode,
    apps_requested: x.apps,
    apps_completed: done.length,
    concurrency_requested: x.concurrency,
    concurrency_observed: x.maxInFlight,
    origins: x.originCount,
    latency: x.latency,
    wall_ms: round(x.wallMs),

    // THE CONCURRENCY ASSERTION. Reported as a value rather than thrown here,
    // so a --json consumer sees it; main() and the CI gate fail on it.
    concurrency_ok: x.maxInFlight === Math.min(x.concurrency, x.apps),

    columns: {
      // 1 & 2 — reported SEPARATELY. Applications-per-hour alone is gameable:
      // deferring more raises it, because a deferral is fast. Nobody had ever
      // measured how fast until this column existed.
      submitted_per_hour: M(
        round(submitted.length / hours),
        "mean over the run",
      ),
      deferred_per_hour: M(round(deferred.length / hours), "mean over the run"),

      // 3
      defer_rate: M(round(deferred.length / (done.length || 1), 4), "mean"),
      defer_rate_by_class: M(defer_rate_by_class, "mean"),

      // 4 — CLOCKED, not derived. See the header for why the plan's wording is
      // narrowed and what is still caught.
      model_turns_per_app: x.counts.installed
        ? M(
            round(per(x.counts.foreign_spawns + x.counts.outbound_requests), 4),
            "mean",
            "clocked: non-repo spawns + non-loopback requests",
          )
        : U(
            "the spawn-counter preload was not installed; run this file as a CLI " +
              "(it re-execs itself with --require scripts/dev/spawn-counter.cjs) " +
              "or pass that flag yourself",
          ),

      // 5
      sleep_ms_per_app: M(
        round(per(done.reduce((a, r) => a + r.sleep_ms, 0))),
        "mean",
      ),

      // 6 — the courtesy wait. Zero unless asked for; the note says so rather
      // than the number implying a policy that does not exist yet.
      edge_spacing_ms_per_app: M(
        round(per(done.reduce((a, r) => a + r.spacing_ms, 0))),
        "mean",
        x.edgeSpacingMs
          ? `--edge-spacing-ms ${x.edgeSpacingMs}`
          : "no spacing configured; the runner's policy is Phase 5's",
      ),

      // 7
      wall_ms_p95: M(round(pct(walls, 95)), "p95"),
      wall_ms_p50: M(round(pct(walls, 50)), "p50"),

      // 8 — every spawn, unfiltered.
      spawns_per_app: x.counts.installed
        ? M(round(per(x.counts.spawns), 4), "mean")
        : U("the spawn-counter preload was not installed"),

      // 9 — the instrumented page's own counter, not a protocol model.
      round_trips_per_app: M(
        round(per(done.reduce((a, r) => a + r.cdp_calls, 0)), 2),
        "mean",
        "cdp_calls off the instrumented page",
      ),

      failure_rate_p: M(failure_rate_p, "mean per board_key"),
    },

    // The gate's hard equality, stated as its two halves plus the verdict, so
    // a red run says WHICH half broke rather than "invariant failed".
    ledger: {
      ...x.ledger,
      reached_authorized: submitted.length,
      ok:
        x.ledger.durable_rows === submitted.length &&
        x.ledger.rows_in_state_attempted === 0,
    },

    // Everything the columns are computed from, so a reader can recheck them.
    detail: {
      submitted: submitted.length,
      deferred: deferred.length,
      failed: failed.length,
      not_claimed: x.results.length - done.length,
      wall_ms: stats(walls.length ? walls : [0]),
      spawns_total: x.counts.spawns,
      foreign_spawns: x.counts.foreign_spawns,
      foreign_spawn_argv: x.counts.spawn_argv,
      outbound_requests: x.counts.outbound_requests,
      outbound_hosts: x.counts.outbound_hosts,
      loopback_requests: x.counts.loopback_requests,
      reason_rows: x.reasons,
      errors: done.filter((r) => r.error).map((r) => `${r.slug}: ${r.error}`),
    },
  }
}

/** Aggregate several campaigns. Only wall varies; the rest is stated per run. */
export function aggregate(runs) {
  const walls = runs
    .map((r) => r.columns.wall_ms_p95.value)
    .filter(Number.isFinite)
  return {
    runs: runs.length,
    wall_ms_p95: {
      min: pct(walls, 0),
      median: pct(walls, 50),
      max: pct(walls, 100),
    },
    concurrency_ok: runs.every((r) => r.concurrency_ok),
    per_run: runs,
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const get = (name, fallback = null) => {
    const i = argv.indexOf(name)
    if (i === -1) return fallback
    const next = argv[i + 1]
    return next == null || next.startsWith("--") ? true : next
  }
  return {
    apps: Number(get("--apps", 8)),
    concurrency: Number(get("--concurrency", 4)),
    boardName: String(get("--board", "greenhouse")),
    origins: get("--origins", null) ? Number(get("--origins")) : null,
    runs: Number(get("--runs", 1)),
    profileName: String(get("--profile", "typical")),
    realSleep: argv.includes("--real-sleep"),
    edgeSpacingMs: Number(get("--edge-spacing-ms", 0)) || 0,
    latency: get("--latency", null),
    json: argv.includes("--json"),
    ledger: argv.includes("--ledger"),
    allowDirty: argv.includes("--allow-dirty"),
  }
}

function printHuman(agg, prov) {
  const r = agg.per_run[0]
  console.log(
    `bench-runner ${r.board} apps=${r.apps_completed}/${r.apps_requested} ` +
      `concurrency=${r.concurrency_observed}/${r.concurrency_requested} ` +
      `origins=${r.origins} mode=${r.mode} runs=${agg.runs}`,
  )
  if (!agg.concurrency_ok)
    console.log(
      `  ** CONCURRENCY NOT ACHIEVED ** observed max-in-flight ${r.concurrency_observed}, ` +
        `requested ${r.concurrency_requested} — every throughput number below is ` +
        `reported under a label the run did not run at`,
    )
  for (const [name, col] of Object.entries(r.columns)) {
    const v =
      col.value && typeof col.value === "object"
        ? Object.entries(col.value)
            .map(([k, n]) => `${k}=${n}`)
            .join(" ") || "none"
        : col.value
    console.log(
      `  ${name.padEnd(26)} ${String(v).padEnd(22)} ${col.method} (${col.statistic})${col.note ? " — " + col.note : ""}`,
    )
  }
  console.log(
    `  detail submitted=${r.detail.submitted} deferred=${r.detail.deferred} ` +
      `failed=${r.detail.failed} spawns=${r.detail.spawns_total} ` +
      `foreign=${r.detail.foreign_spawns} outbound=${r.detail.outbound_requests}`,
  )
  if (r.detail.errors.length)
    for (const e of r.detail.errors.slice(0, 5)) console.log(`  ERROR ${e}`)
  console.log(
    `  sha=${prov.sha} dirty=${(prov.dirty_measured_files ?? []).length}`,
  )
}

const BENCH_FLAGS = [
  "--allow-dirty",
  "--apps",
  "--board",
  "--concurrency",
  "--edge-spacing-ms",
  "--json",
  "--latency",
  "--ledger",
  "--origins",
  "--profile",
  "--real-sleep",
  "--require",
  "--runs",
  "--help",
]
const BENCH_VALUE_FLAGS = [
  "--apps",
  "--board",
  "--concurrency",
  "--edge-spacing-ms",
  "--ledger",
  "--origins",
  "--profile",
  "--require",
  "--runs",
]

async function main() {
  const argv = process.argv.slice(2)
  // STRICT, and this one had no --help at all: `bench-runner.mjs --help`
  // started a full 8-application campaign writing fixture rows. `--allow-dirty`
  // is worse — misspelled, it silently RE-ARMS the dirty-tree refusal that
  // stops a measurement being banked against a baseline it does not match.
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      `bench-runner.mjs — measure the unattended runner against the loopback fixture\n\n` +
        `  ${BENCH_FLAGS.filter((f) => f !== "--help").join("\n  ")}\n\n` +
        `THIS RUNS A FULL CAMPAIGN and writes fixture rows.\n`,
    )
    return 0
  }
  try {
    assertKnownFlags(argv, {
      known: BENCH_FLAGS,
      valueFlags: BENCH_VALUE_FLAGS,
      script: "bench-runner.mjs",
      note: "a bare run performs a full application campaign writing fixture rows",
    })
  } catch (e) {
    console.error(e.message)
    process.exit(e.exitCode ?? 2)
  }
  const a = parseArgs(argv)
  const prov = await provenance()
  // REFUSING A DIRTY TREE, on the paths where it matters.
  //
  // The distinction is between LOOKING at a number and BANKING one. Looking is
  // what you do while working, and a harness you cannot run mid-change is a
  // harness nobody runs. Banking — `--json` for the gate, `--ledger` for
  // docs/measurements.md — compares against a baseline, and a comparison
  // across a tree with uncommitted edits in the measured files compares a
  // number against itself plus an unknown. That is how a regression becomes a
  // baseline, and this project has the receipts: three readings this build
  // were correctly discarded for exactly this.
  const dirty = prov.dirty_measured_files ?? []
  if ((a.json || a.ledger) && dirty.length && !a.allowDirty) {
    console.error(
      `refusing to bank a number from a dirty tree — uncommitted changes in:\n` +
        dirty.map((l) => `  ${l}`).join("\n") +
        `\nCommit them, or pass --allow-dirty and say so wherever the number lands.`,
    )
    process.exitCode = 2
    return
  }
  const runs = []
  for (let i = 0; i < Math.max(1, a.runs); i++) runs.push(await runCampaign(a))
  const agg = aggregate(runs)

  if (a.json) {
    console.log(JSON.stringify({ ...agg, provenance: prov }, null, 2))
  } else if (a.ledger) {
    console.log(ledgerEntry(agg, prov, a))
  } else {
    printHuman(agg, prov)
  }
  // A run that did not reach the requested concurrency is not a slow run, it
  // is a run of a different shape, and its numbers must not be banked.
  if (!agg.concurrency_ok) process.exitCode = 1
}

/**
 * Re-exec with the counter preload.
 *
 * The CI gate's command is fixed by the plan — `node scripts/dev/bench-runner.mjs
 * --apps 50 ...` with no extra flags — and the counters only work as a
 * `--require` preload. So the command installs it for itself rather than
 * relying on anybody remembering. stdio is inherited, so output and exit code
 * pass straight through and the indirection is invisible.
 */
function reexecWithCounters() {
  const r = child_process.spawnSync(
    process.execPath,
    [
      "--require",
      COUNTER_PRELOAD,
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: "inherit", env: { ...process.env, AJ_BENCH_CHILD: "1" } },
  )
  process.exit(r.status ?? 1)
}

/** A paste-ready docs/measurements.md entry, so 4.8 is one command. */
export function ledgerEntry(agg, prov, args) {
  const r = agg.per_run[0]
  const cmd =
    `node scripts/dev/bench-runner.mjs --apps ${args.apps} --concurrency ${args.concurrency} ` +
    `--board ${args.boardName} --runs ${args.runs} --json`
  const rows = Object.entries(r.columns).map(([k, c]) => {
    const v =
      c.value && typeof c.value === "object"
        ? Object.entries(c.value)
            .map(([kk, vv]) => `${kk}=${vv}`)
            .join(", ") || "none"
        : c.value
    return `| \`${k}\` | ${v} | ${c.method} | ${c.statistic} | ${c.note ?? ""} |`
  })
  return [
    `## M? — bench-runner: ${r.apps_completed} applications at concurrency ${r.concurrency_observed}`,
    ``,
    `**Command.** \`${cmd}\``,
    ``,
    `**Legs.** loopback fixture, ${r.origins} origins, mode \`${r.mode}\`, profile \`${r.profile}\`, ` +
      `${agg.runs} run(s). Latency model: ${r.latency?.mode ?? "loopback"}.`,
    ``,
    `| column | value | method | statistic | note |`,
    `| ------ | ----- | ------ | --------- | ---- |`,
    ...rows,
    ``,
    `**Provenance.** \`${prov.sha}\`, ${(prov.dirty_measured_files ?? []).length} dirty measured file(s).`,
    ...MEASURED_FILES.map((f) => `- \`${f}\` \`${prov.file_sha1[f]}\``),
    ``,
    `**Concurrency assertion:** observed max-in-flight ${r.concurrency_observed} vs requested ` +
      `${r.concurrency_requested} — ${agg.concurrency_ok ? "PASS" : "FAIL"}.`,
  ].join("\n")
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  if (!readCounters().installed && !process.env.AJ_BENCH_CHILD)
    reexecWithCounters()
  else await main()
}
