// The worker pool, partitioned by ORIGIN (§4.2). Phase 5 W1.
//
// ===========================================================================
// WHY THE EXCLUSION KEY IS THE ORIGIN AND NOT THE BOARD
// ===========================================================================
//
// Revision 1 of the plan keyed in-flight exclusion on `board_key`. That is
// TENANT-scoped (hostname + first path segment + `for=` employer param), while
// cookies and localStorage are ORIGIN-scoped — so "one job per board_key"
// permitted eight concurrent Greenhouse tenants sharing one cookie jar and one
// storage area. The consequence is not theoretical: Greenhouse's embed flow
// holds upload and draft state per origin, so one tab's resume upload token is
// overwritable by another's, and the Coinbase application goes out carrying the
// Tebra-tailored resume — irreversibly, and with nothing in any log saying so.
//
// So: AT MOST ONE JOB IN FLIGHT PER REGISTRABLE ORIGIN, always. Concurrency is
// recovered structurally instead — cookie-free boards get their own
// `browser.newContext()` per job, which is genuine per-job storage isolation
// using a branch that already exists in browser.mjs.
//
// N IS A RESOURCE LIMIT THE USER OWNS, NEVER A VOLUME LIMIT. Every queued job
// is still applied to; N bounds only the rate at which work is driven. If a
// queue holds 200 jobs on one origin, this pool runs them one at a time and
// finishes all 200 — it does not drop 199 of them.
//
// ===========================================================================
// WHAT THIS FILE DOES NOT DO
// ===========================================================================
//
// It contains no policy. No retry rule (job.mjs owns the bounded nav retry), no
// trust decision, no cap arithmetic, and NO CLICK. It hands jobs to runJob and
// counts what comes back. The one thing it decides is WHICH job may start next,
// and that decision is exactly the origin rule above.
import { safeText } from "./untrusted-text.mjs"

// The shared exclusion key for jobs with no origin, and the counterpart key in
// originCount — ONE constant, because two copies of a sentinel that must match
// exactly is a silent partition bug waiting to happen.
//
// WRITTEN AS AN ESCAPE, NEVER AS A LITERAL NUL BYTE IN THE SOURCE. A raw one
// passes prettier and `node --check` untouched, is invisible in every editor,
// and makes ripgrep classify this file as BINARY — so a codebase-wide search
// silently skips it and reports nothing rather than reporting a miss. That is
// gotcha B's "a parse is not a run", and it cost a search of this file before
// it was found. The VALUE is unchanged; only its spelling is.
const NO_ORIGIN = "\u0000no-origin"

/**
 * Run `jobs` through `runOne`, at most `concurrency` at a time and at most one
 * per origin.
 *
 * THE OBSERVED MAXIMUM IS RETURNED, NOT THE CONFIGURED ONE. §4.11's check is
 * `observed max-in-flight === 8`, and the reason it is written that way is that
 * a pool CAPABLE of eight that serialises on its exclusion key reports N=1
 * throughput under an N=8 label — which is then the number a gate enforces
 * forever. `max_in_flight` below is sampled, never assumed.
 *
 * @param jobs        rows with at least {slug, origin}
 * @param runOne      async (job) -> result. Must not throw for a per-job
 *                    condition; a throw here aborts the pool, which is correct
 *                    only for a StopError.
 * @param concurrency worker count.
 * @param onResult    called with each result as it lands, for progress output.
 * @param shouldStop  called before each job is started; returning a truthy
 *                    value stops the pool from starting NEW work. In-flight
 *                    jobs are allowed to finish — killing them mid-fill would
 *                    leave exactly the ambiguous half-states the ledger exists
 *                    to avoid.
 * @returns {{results, max_in_flight, started, skipped, stopped_reason}}
 */
export async function runPool({
  jobs,
  runOne,
  concurrency = 1,
  onResult = null,
  shouldStop = null,
  onSkip = null,
} = {}) {
  if (typeof runOne !== "function")
    throw new TypeError("runPool requires runOne")
  const queue = [...(jobs ?? [])]
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new TypeError(`runPool: concurrency must be >= 1, got ${concurrency}`)

  const results = []
  const busyOrigins = new Set()
  let inFlight = 0
  let maxInFlight = 0
  let started = 0
  let stoppedReason = null
  const skipped = []

  // A job whose origin is busy is not dropped and not re-queued at the end: it
  // is left in place and retried on the next pass. Moving it to the back would
  // reorder the queue by origin contention, which silently de-prioritises
  // exactly the boards the user has most leads for.
  let cursor = 0
  const takeNext = () => {
    for (let i = cursor; i < queue.length; i++) {
      const j = queue[i]
      if (j === undefined) continue
      const origin = j?.origin ?? null
      // A job with NO origin is serialised against every other origin-less job
      // under one shared key rather than being let through unbounded. A missing
      // origin means we do not know what it shares state with, and "unknown"
      // must be the cautious end.
      const key = origin ?? NO_ORIGIN
      if (busyOrigins.has(key)) continue
      queue[i] = undefined
      while (cursor < queue.length && queue[cursor] === undefined) cursor++
      return { job: j, key }
    }
    return null
  }

  const remaining = () => queue.some((j) => j !== undefined)

  async function worker() {
    for (;;) {
      if (stoppedReason) return
      const stop = shouldStop ? await shouldStop() : null
      if (stop) {
        stoppedReason = typeof stop === "string" ? stop : "stop requested"
        return
      }
      const next = takeNext()
      if (!next) {
        // Nothing startable RIGHT NOW. If work remains it is blocked on an
        // origin another worker holds, so yield and look again — this is the
        // one place a busy-wait is correct, because the unblocking event is
        // another worker's completion and there is nothing to await on.
        if (!remaining() || inFlight === 0) return
        await new Promise((r) => setTimeout(r, 15))
        continue
      }
      const { job, key } = next
      busyOrigins.add(key)
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      started += 1
      try {
        const r = await runOne(job)
        results.push(r)
        if (onResult) onResult(r)
      } finally {
        inFlight -= 1
        busyOrigins.delete(key)
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker),
  )

  // Anything left when the pool stopped early. Named, counted and handed back
  // so the caller can write a `board-paused`-style reason to each one rather
  // than leaving it sitting in 'queued' with no kind at all — the largest
  // single loss bucket in a degraded run must not be invisible.
  for (const j of queue) {
    if (j === undefined) continue
    skipped.push(j)
    if (onSkip) onSkip(j, stoppedReason)
  }

  return {
    results,
    max_in_flight: maxInFlight,
    started,
    skipped,
    stopped_reason: stoppedReason ? safeText(stoppedReason, 200) : null,
  }
}

/**
 * How many distinct origins the queue holds.
 *
 * The useful upper bound on real concurrency, and worth printing next to N:
 * a run of 50 jobs at concurrency 8 across 3 origins can never exceed 3, and
 * without this number that reads as the pool underperforming rather than as
 * the queue being the constraint.
 */
export function originCount(jobs) {
  return new Set((jobs ?? []).map((j) => j?.origin ?? NO_ORIGIN)).size
}
