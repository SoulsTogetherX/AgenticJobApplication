// The one-command answer to "is the machine working?" — Phase 4.2.
//
// IT REPORTS PROGRESS, NOT RECENCY. The distinction is the whole item. A digest
// that says "3 applications submitted in the last 24 hours" is compatible with
// a queue of 900 that has not moved since Tuesday, a board that has been paused
// since 02:14, and a STOP nobody noticed. Every number here exists to close one
// of those blind spots, and the most informative of them is QUEUE DEPTH: a
// depth that is not falling is the single clearest statement the auto path can
// make about itself, and revision 1 of the plan had no way to show it.
//
// Nothing in this file decides anything. It reads rows and computes statistics;
// the brake, the caps and the trust gate live elsewhere and are not consulted.
import {
  autoQueueCounts,
  readOrphanAttempts,
  readReasonCounts,
  readChallengeIncidence,
  readActiveBoardPauses,
  readQueueAges,
  readStaleDeferred,
  readSubmitLatencies,
  readJobWallTimes,
  countAutoSubmissions,
  readAutoAssents,
  latestAutoRun,
} from "../lib/db.mjs"
import { stopActive, readStop } from "./guard.mjs"
import { reasonClass, newlyChallengedBoards } from "./taxonomy.mjs"
import { sightedHosts, isHostSighted } from "./classify.mjs"
import { readLimits, normalizeAllowlist } from "./trust.mjs"
import { listStaged } from "../apply/capture-post-submit.mjs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const DIGEST_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const DEFAULT_LIMITS_FILE = path.join(
  DIGEST_ROOT,
  "docs",
  "application-limits.yaml",
)

/**
 * Allowlisted boards this repository cannot READ the post-submit page of, the
 * jobs stuck behind them, and how many staged captures would actually help.
 *
 * Computed from three pure functions that already existed and were never
 * joined: the user's allowlist, classify.mjs's capture-sourced evidence, and
 * the staging directory. Everything here fails SOFT — a digest that throws
 * because a limits file moved is worse than one missing a warning.
 */
export function blindBoards(db, { limitsFile, stagingDir } = {}) {
  let allow = []
  try {
    // readLimits takes NO default — `readLimits(undefined)` returns null, which
    // would have made this warning silently never fire. Resolved here rather
    // than left to the caller so a digest built with no options still reports.
    allow = normalizeAllowlist(
      readLimits(limitsFile ?? DEFAULT_LIMITS_FILE)?.auto_apply
        ?.board_allowlist,
    )
  } catch {
    return { hosts: [], deferred: 0, staged_useful: 0 }
  }
  const sighted = new Set(sightedHosts())
  const hosts = allow
    .map((e) => e.domain)
    .filter(Boolean)
    .filter((h) => !sighted.has(h) && !isHostSighted(`https://${h}`))
    .sort()
  if (!hosts.length) return { hosts: [], deferred: 0, staged_useful: 0 }

  let deferred = 0
  try {
    deferred = Number(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM auto_queue
            WHERE state = 'deferred' AND reason_kind = 'board-unsighted'`,
        )
        .get()?.n ?? 0,
    )
  } catch {
    deferred = 0
  }

  // Only captures on a host that is STILL BLIND count as useful. Measured
  // 2026-08-24: all seven unpromoted captures were on already-sighted hosts,
  // so a naive "N staged" line would have sent the reader to promote things
  // that unblock nothing.
  let staged_useful = 0
  try {
    staged_useful = listStaged(stagingDir ? { stagingDir } : undefined).filter(
      (c) => !c.promoted && c.host && hosts.includes(c.host),
    ).length
  } catch {
    staged_useful = 0
  }
  return { hosts, deferred, staged_useful }
}

// The scheduled-task cadence the WARN is measured against. The user's
// `auto_apply` block does not carry one today; `docs/application-limits.yaml`
// is the user's file, so this is a DEFAULT the caller may override rather than
// a value written into their config. Twice a day is what guard.mjs's header
// assumes a scheduled run looks like.
export const DEFAULT_CADENCE_MS = 12 * 60 * 60 * 1000

/**
 * Nearest-rank percentile over a numeric sample. Returns null for an empty
 * sample — NOT zero, because "nothing has happened yet" and "everything is
 * instant" are opposite pieces of news and a digest that renders them the same
 * is worse than one that omits the row.
 */
export function percentile(values, p) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (!xs.length) return null
  const rank = Math.ceil((p / 100) * xs.length)
  return xs[Math.min(xs.length - 1, Math.max(0, rank - 1))]
}

const hours = (ms) =>
  ms === null ? null : Math.round((ms / 3_600_000) * 10) / 10

/**
 * Build the `auto` object.
 *
 * @param db        an open leads.db
 * @param now       the instant everything is measured against
 * @param runId     which run to scope run-relative numbers to; defaults to the
 *                  latest recorded run. Pass null explicitly for all-time.
 * @param cadenceMs how long a job may sit in the queue before it is a WARN
 * @param stopPath  the kill switch (a seam for tests)
 */
export function buildAutoStatus(
  db,
  {
    now = new Date(),
    runId = undefined,
    cadenceMs = DEFAULT_CADENCE_MS,
    stopPath,
    limitsFile,
    stagingDir,
  } = {},
) {
  const at = now instanceof Date ? now : new Date(now)
  const latest = latestAutoRun(db)
  const run_id = runId === undefined ? (latest?.run_id ?? null) : runId

  const counts = autoQueueCounts(db)
  const since24h = new Date(at.getTime() - 24 * 60 * 60 * 1000).toISOString()

  // --- deferrals, grouped by the thing that makes them a backlog -------------
  const reasons = readReasonCounts(db, { run_id: null })
  const by_kind = {}
  const by_class = {}
  const by_board = {}
  let deferred_total = 0
  let failed_total = 0
  for (const r of reasons) {
    const n = Number(r.n)
    if (r.state === "failed") failed_total += n
    else deferred_total += n
    by_kind[r.reason_kind] = (by_kind[r.reason_kind] ?? 0) + n
    const cls = reasonClass(r.reason_kind) ?? "unclassified"
    by_class[cls] = (by_class[cls] ?? 0) + n
    const key = r.board_key ?? "(unknown board)"
    by_board[key] = by_board[key] ?? {}
    by_board[key][r.reason_kind] = (by_board[key][r.reason_kind] ?? 0) + n
  }

  // --- the queue, by depth and by age ---------------------------------------
  const ages = readQueueAges(db, { now: at })
  const staleDeferred = readStaleDeferred(db, { now: at })
  const ageOf = (state) =>
    ages.filter((a) => a.state === state).map((a) => a.age_ms)
  const queue = {
    depth: {
      queued: counts.queued,
      claimed: counts.claimed,
      planned: counts.planned,
      authorized: counts.authorized,
    },
    outstanding:
      counts.queued + counts.claimed + counts.planned + counts.authorized,
    age_p95_ms: {
      queued: percentile(ageOf("queued"), 95),
      claimed: percentile(ageOf("claimed"), 95),
    },
    // A row whose age nobody can compute is reported, not dropped. It is the
    // one row most likely to be the stuck one.
    age_unknown: ages.filter((a) => a.age_ms === null).length,
    // Deferred rows older than three days. `outstanding` above counts only the
    // resumable states, so this is where a job that deferred once and was
    // never looked at again shows up — 2026-08-17: outstanding=0, three rows
    // deferred for 13 days, two of them on a since-fixed reason.
    stale_deferred: staleDeferred.length,
    stale_deferred_oldest_ms: staleDeferred.length
      ? (staleDeferred[0].age_ms ?? null)
      : null,
    stale_deferred_requeueable: staleDeferred.filter((s) => s.requeueable)
      .length,
  }

  // --- the gap the product exists to close ----------------------------------
  // LIVE ONLY. This is the posted -> submitted statistic db.mjs calls "THE
  // NUMBER THE PRODUCT IS ACTUALLY FOR", and it was computed over every
  // auto_submissions row regardless of mode — so a rehearsal, which sends
  // nothing, sat in the sample. Measured 2026-08-24: 10 joined rows, one of
  // them mode=dry_run. The helper has always taken this filter; the call
  // simply never passed it. Unfiltered, the join also fans out one queue row
  // across both rows of any slug that was rehearsed AND submitted, counting it
  // twice.
  const latencies = readSubmitLatencies(db, {
    run_id: null,
    mode: "live",
  }).map((l) => l.ms)
  const latency = {
    n: latencies.length,
    p50_ms: percentile(latencies, 50),
    p95_ms: percentile(latencies, 95),
    p50_hours: hours(percentile(latencies, 50)),
    p95_hours: hours(percentile(latencies, 95)),
  }

  // --- how long the MACHINE takes, which is a different question ------------
  //
  // `latency` above is the market number: hours between a posting going up and
  // our click. This is the engineering one: milliseconds per job inside our own
  // worker. They are reported as separate blocks and must stay that way — one
  // improves by finding postings sooner, the other by making the pipeline
  // faster, and an average of the two would mean nothing.
  //
  // BY STAGE, because a total cannot be acted on. A p95 sitting in `plan` and
  // a p95 sitting in `post-submit` are different defects with different owners.
  // p50 AND p95, because the tail is where a slow board hides: a single job
  // taking 40s among 200 quick ones moves the p95 and leaves the median flat.
  const walls = readJobWallTimes(db, { run_id: null })
  const byStage = {}
  for (const w of walls) (byStage[w.stage] ??= []).push(w.ms)
  const wall = {
    n: walls.length,
    p50_ms: percentile(
      walls.map((w) => w.ms),
      50,
    ),
    p95_ms: percentile(
      walls.map((w) => w.ms),
      95,
    ),
    by_stage: Object.fromEntries(
      Object.entries(byStage)
        .map(([stage, xs]) => [
          stage,
          {
            n: xs.length,
            p50_ms: percentile(xs, 50),
            p95_ms: percentile(xs, 95),
          },
        ])
        // Slowest stage first: the ordering is the recommendation.
        .sort((a, b) => (b[1].p95_ms ?? 0) - (a[1].p95_ms ?? 0)),
    ),
    // The single slowest job, by name. A distribution says a tail exists; this
    // says which slug to open.
    slowest: walls.length
      ? { slug: walls[0].slug, ms: walls[0].ms, stage: walls[0].stage }
      : null,
  }

  // --- boards the machine backed away from ----------------------------------
  const paused = readActiveBoardPauses(db, { run_id }).map((p) => ({
    board_key: p.board_key,
    held: Number(p.held),
    since: p.paused_at,
    until: p.until,
    reason_kind: p.reason_kind,
  }))

  // --- boards the machine is allowed to use but cannot READ ----------------
  //
  // THE ALLOWLIST AND THE EVIDENCE LIST ARE DIFFERENT LISTS, and nothing joined
  // them for the user. A board on `board_allowlist` says the user trusts the
  // vendor; a host with a capture-sourced classifier rule says this repo can
  // read that vendor's post-submit page. Neither implies the other, so a job
  // can clear the trust gate and still defer `board-unsighted` — and the only
  // place that surfaced was one reason_detail string on one queue row.
  //
  // THE OBVIOUS DIGEST LINE WOULD HAVE BEEN THE WRONG ONE. "N captures staged"
  // reads as work waiting to be done; measured 2026-08-24 it would have said
  // "7 staged" while every one of them sat on a host that is ALREADY sighted,
  // so promoting all seven unblocks nothing. The actionable fact is the
  // opposite direction: which trusted boards are blind, and how many jobs are
  // stuck behind them. `staged_useful` counts only captures on a host that is
  // still blind — the ones that would actually change something.
  const blind = blindBoards(db, { limitsFile, stagingDir })

  const challenges = readChallengeIncidence(db, { run_id })
  const newly_challenged = newlyChallengedBoards(challenges)

  const orphans = readOrphanAttempts(db)
  const stop = {
    active: stopActive(stopPath ? { stopPath } : undefined),
    reason: stopActive(stopPath ? { stopPath } : undefined)
      ? readStop(stopPath ? { stopPath } : undefined)
      : null,
  }

  // --- warnings: the things a human should look at now ----------------------
  //
  // These are WARN and not FAIL on purpose. This command reports; it does not
  // stop anything. The brake is jobs/.auto/STOP and it is set by the runner or
  // by the user, never by a digest.
  const warnings = []
  const stale = ages.filter((a) => a.age_ms !== null && a.age_ms > cadenceMs)
  if (stale.length)
    warnings.push({
      kind: "queue-stalled",
      n: stale.length,
      detail:
        `${stale.length} job(s) have been waiting longer than one scheduler cadence ` +
        `(${Math.round(cadenceMs / 3_600_000)}h) — the queue is not draining`,
    })
  if (queue.age_unknown)
    warnings.push({
      kind: "age-unknown",
      n: queue.age_unknown,
      detail: `${queue.age_unknown} queued job(s) carry no timestamp, so their age cannot be checked`,
    })
  if (orphans.length)
    warnings.push({
      kind: "orphan-attempt",
      n: orphans.length,
      detail:
        `${orphans.length} attempt(s) were issued and never resolved — each may already ` +
        `be an application sitting in an employer's ATS`,
    })
  if (counts.challenged)
    warnings.push({
      kind: "unconfirmed",
      n: counts.challenged,
      detail:
        `${counts.challenged} submission(s) answered with a challenge — reported as ` +
        `UNCONFIRMED, not sent`,
    })
  if (paused.length)
    warnings.push({
      kind: "board-paused",
      n: paused.reduce((a, p) => a + p.held, 0),
      detail:
        `${paused.length} board(s) paused, holding ${paused.reduce((a, p) => a + p.held, 0)} job(s): ` +
        paused.map((p) => `${p.board_key}(${p.held})`).join(" "),
    })
  if (blind.hosts.length && blind.deferred > 0)
    warnings.push({
      kind: "board-unsighted",
      n: blind.deferred,
      detail:
        `${blind.deferred} job(s) deferred on ${blind.hosts.length} allowlisted ` +
        `but UNSIGHTED host(s): ${blind.hosts.join(" ")}. ` +
        (blind.staged_useful
          ? `${blind.staged_useful} staged capture(s) would help — review and promote them.`
          : `No staged capture is on any of those hosts, so only an ATTENDED ` +
            `apply there can fix this.`),
    })
  if (newly_challenged.length)
    warnings.push({
      kind: "new-challenge",
      n: newly_challenged.length,
      detail:
        `first challenge recorded on ${newly_challenged.map((b) => b.board_key).join(", ")} — ` +
        `employer-side flagging is silent, so this is the only proxy for it`,
    })
  if (stop.active)
    warnings.push({
      kind: "stopped",
      n: 1,
      detail: `STOP is set: ${stop.reason ?? "no reason recorded"}`,
    })

  return {
    run_id,
    run_outcome: latest?.outcome ?? null,
    run_started_at: latest?.started_at ?? null,
    submitted_24h: countAutoSubmissions(db, since24h),
    submitted_total: counts.submitted,
    // What the machine ASSERTED on the user's behalf in the last day, per
    // submission — rule 6's record, surfaced where the user reads. Empty when
    // no confirmed submission actuated anything.
    assents_24h: readAutoAssents(db, since24h),
    challenged: counts.challenged,
    orphans: orphans.length,
    deferrals: {
      total: deferred_total,
      failures: failed_total,
      by_kind,
      by_class,
      by_board,
    },
    queue,
    latency,
    wall,
    paused_boards: paused,
    newly_challenged,
    stop,
    warnings,
  }
}

/** The terse agent-facing rendering: one fact per line, no prose. */
export function formatAutoTerse(a) {
  const kv = (o) =>
    Object.entries(o)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ") || "none"
  const lines = [
    `auto run=${a.run_id ?? "-"} outcome=${a.run_outcome ?? "-"} stop=${a.stop.active ? "SET" : "clear"}`,
    `auto submitted 24h=${a.submitted_24h} total=${a.submitted_total} challenged=${a.challenged} orphans=${a.orphans}`,
    `auto queue outstanding=${a.queue.outstanding} ${kv(a.queue.depth)} ` +
      `age_p95_queued=${a.queue.age_p95_ms.queued ?? "-"} age_p95_claimed=${a.queue.age_p95_ms.claimed ?? "-"} ` +
      `age_unknown=${a.queue.age_unknown} ` +
      `stale_deferred=${a.queue.stale_deferred} ` +
      `(requeueable=${a.queue.stale_deferred_requeueable} oldest=${a.queue.stale_deferred_oldest_ms === null ? "-" : hours(a.queue.stale_deferred_oldest_ms) + "h"})`,
    `auto deferrals total=${a.deferrals.total} failures=${a.deferrals.failures} ${kv(a.deferrals.by_kind)}`,
    `auto class ${kv(a.deferrals.by_class)}`,
    `auto latency n=${a.latency.n} p50h=${a.latency.p50_hours ?? "-"} p95h=${a.latency.p95_hours ?? "-"}`,
    // MILLISECONDS AND A DIFFERENT NAME, one line below the hours. `latency`
    // is posting-to-click; `wall` is how long our own worker held the job.
    `auto wall n=${a.wall.n} p50ms=${a.wall.p50_ms ?? "-"} p95ms=${a.wall.p95_ms ?? "-"}` +
      (a.wall.slowest
        ? ` slowest=${a.wall.slowest.slug}(${a.wall.slowest.ms}ms@${a.wall.slowest.stage})`
        : ""),
    ...(a.wall.n
      ? [
          `auto wall by_stage ${
            Object.entries(a.wall.by_stage)
              .map(([s, v]) => `${s}=${v.p50_ms}/${v.p95_ms}(n=${v.n})`)
              .join(" ") || "-"
          }`,
        ]
      : []),
    `auto paused ${a.paused_boards.map((p) => `${p.board_key}(${p.held})`).join(" ") || "none"}`,
  ]
  // One line per submission that actuated an assent, and one per assent under
  // it: label, value, grant. Terse but COMPLETE — the record is the point.
  for (const s of a.assents_24h ?? []) {
    lines.push(`auto assent ${s.slug} n=${s.assents.length}`)
    for (const x of s.assents)
      lines.push(
        `auto assent ${s.slug} ${JSON.stringify(x.label ?? "?")}=${JSON.stringify(x.value ?? null)} grant=${x.grant ?? "-"}${x.legalWeight ? " LEGAL-WEIGHT" : ""}`,
      )
  }
  for (const w of a.warnings) lines.push(`auto WARN ${w.kind} n=${w.n}`)
  return lines
}

/** The human rendering. Same numbers, said once. */
export function formatAutoProse(a) {
  const lines = []
  lines.push(
    `Auto path — run ${a.run_id ?? "(none yet)"}${a.run_outcome ? ` (${a.run_outcome})` : ""}` +
      (a.stop.active ? "  ** STOP IS SET **" : ""),
  )
  if (a.stop.active) lines.push(`  Reason: ${a.stop.reason ?? "none recorded"}`)
  lines.push(
    `  Submitted: ${a.submitted_24h} in 24h, ${a.submitted_total} total` +
      (a.challenged ? `; ${a.challenged} unconfirmed` : ""),
  )
  lines.push(
    `  Queue: ${a.queue.outstanding} outstanding ` +
      `(queued ${a.queue.depth.queued}, claimed ${a.queue.depth.claimed}, ` +
      `planned ${a.queue.depth.planned}, authorized ${a.queue.depth.authorized})` +
      (a.queue.age_p95_ms.queued !== null
        ? `, oldest 5% waiting ${hours(a.queue.age_p95_ms.queued)}h+`
        : ""),
  )
  if (a.latency.n)
    lines.push(
      `  Posted → submitted: p50 ${a.latency.p50_hours}h, p95 ${a.latency.p95_hours}h (n=${a.latency.n})`,
    )
  if (a.wall.n) {
    lines.push(
      `  Time per job: p50 ${a.wall.p50_ms}ms, p95 ${a.wall.p95_ms}ms (n=${a.wall.n})`,
    )
    // Only the worst stage, and only when it is worth naming: the terse
    // rendering above carries the whole breakdown for anyone who wants it.
    const worst = Object.entries(a.wall.by_stage)[0]
    if (worst && Object.keys(a.wall.by_stage).length > 1)
      lines.push(
        `    slowest stage: ${worst[0]} p95 ${worst[1].p95_ms}ms (n=${worst[1].n})`,
      )
  }
  const kinds = Object.entries(a.deferrals.by_kind).sort((x, y) => y[1] - x[1])
  if (kinds.length) {
    lines.push(
      `  Deferred ${a.deferrals.total}, failed ${a.deferrals.failures}:`,
    )
    for (const [k, n] of kinds.slice(0, 6))
      lines.push(`    ${n}× ${k} (${reasonClass(k) ?? "unclassified"})`)
  }
  for (const p of a.paused_boards)
    lines.push(
      `  PAUSED ${p.board_key} since ${p.since} — holding ${p.held} job(s)`,
    )
  // Every assent the runner made for the user in the last day, in full. Not
  // truncated to a count: "the user is delegating assent, not waiving the
  // record of it" (rule 6), and a record that only says "3 assents" is not one.
  if (a.assents_24h?.length) {
    lines.push(`  Asserted on your behalf (last 24h):`)
    for (const s of a.assents_24h) {
      lines.push(
        `    ${s.company ?? "?"} — ${s.title ?? s.slug} (${s.assents.length}):`,
      )
      for (const x of s.assents)
        lines.push(
          `      • ${x.label ?? "?"} → ${x.value === true ? "ticked" : (x.value ?? "?")}` +
            ` [${x.grant ?? "no grant"}${x.legalWeight ? ", LEGAL-WEIGHT" : ""}]`,
        )
    }
  }
  for (const w of a.warnings) lines.push(`  WARN ${w.detail}`)
  return lines
}
