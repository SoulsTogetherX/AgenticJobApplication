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
  readSubmitLatencies,
  countAutoSubmissions,
  latestAutoRun,
} from "../lib/db.mjs"
import { stopActive, readStop } from "./guard.mjs"
import { reasonClass, newlyChallengedBoards } from "./taxonomy.mjs"

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
  }

  // --- the gap the product exists to close ----------------------------------
  const latencies = readSubmitLatencies(db, { run_id: null }).map((l) => l.ms)
  const latency = {
    n: latencies.length,
    p50_ms: percentile(latencies, 50),
    p95_ms: percentile(latencies, 95),
    p50_hours: hours(percentile(latencies, 50)),
    p95_hours: hours(percentile(latencies, 95)),
  }

  // --- boards the machine backed away from ----------------------------------
  const paused = readActiveBoardPauses(db, { run_id }).map((p) => ({
    board_key: p.board_key,
    held: Number(p.held),
    since: p.paused_at,
    until: p.until,
    reason_kind: p.reason_kind,
  }))

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
      `age_unknown=${a.queue.age_unknown}`,
    `auto deferrals total=${a.deferrals.total} failures=${a.deferrals.failures} ${kv(a.deferrals.by_kind)}`,
    `auto class ${kv(a.deferrals.by_class)}`,
    `auto latency n=${a.latency.n} p50h=${a.latency.p50_hours ?? "-"} p95h=${a.latency.p95_hours ?? "-"}`,
    `auto paused ${a.paused_boards.map((p) => `${p.board_key}(${p.held})`).join(" ") || "none"}`,
  ]
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
  for (const w of a.warnings) lines.push(`  WARN ${w.detail}`)
  return lines
}
