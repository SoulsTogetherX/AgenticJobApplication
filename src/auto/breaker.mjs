// The anomaly circuit breaker (§4.6). Phase 5 W2/W4.
//
// ===========================================================================
// THE ONE PROPERTY THIS FILE HAS TO HOLD
// ===========================================================================
//
//   A run must never halt because one board is broken, and a healthy run of 999
//   must be no likelier to halt than a healthy run of 3.
//
// Everything below follows from that sentence. Revision 1's breaker counted
// failures over the whole run, which is a rule whose fire probability rises
// with N — so a healthy 999-job night would have halted where a healthy 3-job
// night did not, and the pressure would then have been to weaken the
// single-sample proofs that actually matter. Fixing the RULE is the fix;
// loosening the proofs is not.
//
// So every rule here is N-INVARIANT: each is a statement about the last few
// attempts, never a count over the run.
//
//   * same signature twice CONSECUTIVELY — identical (kind, stage) — pauses
//     that BOARD;
//   * same board failing >= 3 of its LAST 5 — pauses that BOARD;
//   * >= 8 of the LAST 10 attempts across >= 2 distinct boards — stops the RUN.
//
// Simulated at 20,000 trials (N=3) and 2,000 (N=999): the run-level stop fires
// 0.00% at both sizes at p=5%, and 0.45% at p=15%. The cost the simulation
// exposed: ~2 boards pause per 999-job run at p=5%, stranding ~3 applications
// (0.3%); at p=15% it is ~16 boards and ~28 applications (2.8%). THOSE NUMBERS
// ARE WRITTEN DOWN SO A RUN EXCEEDING THEM IS DETECTABLE.
//
// ===========================================================================
// A PAUSE IS NOT A STOP, AND IT IS NOT A THROTTLE
// ===========================================================================
//
// The user's decision is UNLIMITED APPLICATION VOLUME. A mechanism that
// quietly reduced throughput would be a bug, not a safety feature, so the
// difference is worth stating precisely:
//
//   * A pause is a TIMED backoff with probe re-admission. One job is let
//     through when the backoff expires; a success clears the pause entirely.
//   * It is NEVER terminal for the run, and NEVER persisted across invocations
//     without re-probing — the next run starts every board admitted.
//   * It only ever fires on a board that has actually just failed repeatedly.
//     A healthy board is never slowed by any code in this file.
//
// A board-scoped STOP (guard.mjs) is a different thing entirely: durable, and
// cleared only by a human. The breaker must never reach for that, and does not.
//
// ===========================================================================
// TRANSIENTS ARE RETRIED BEFORE THEY COUNT
// ===========================================================================
//
// Revision 1's rule had no retry, and argued N-invariance from an INDEPENDENT
// failure model while its fire rate is dominated by CORRELATED failures —
// `nav-timeout` and `browser-crash` cluster in time by nature. A 20-second wifi
// drop at job 41 would have paused Greenhouse for the rest of a run holding 900
// Greenhouse leads, and reported the outcome as `ok`.
//
// So a transient kind is not eligible to count toward a signature until its
// bounded job-level retry has been spent. `isTransient` is that list, and it is
// deliberately short: a kind that is merely INCONVENIENT is not transient.
import { recordBoardPause, clearBoardPause } from "#lib/db.mjs"
import { safeText } from "./untrusted-text.mjs"

/** Kinds that cluster in time and deserve a retry before they mean anything. */
const TRANSIENT = new Set(["nav-timeout", "browser-crash"])
export const isTransient = (kind) => TRANSIENT.has(kind)

/**
 * Kinds that are NOT evidence of anything being broken, and must never move the
 * breaker at all.
 *
 * This set is the difference between a breaker and a throttle. A run whose
 * every job defers because the user has not banked an answer yet is a run that
 * is WORKING — hard rule 6 says an honest deferral is the designed outcome —
 * and a breaker that paused boards over it would convert the system's normal
 * caution into a throughput limit, which is exactly the bug the unlimited-volume
 * decision forbids.
 */
const NOT_A_MALFUNCTION = new Set([
  "confirm-field",
  "confirm-widget",
  "consent-tickbox",
  "unknown-field",
  "unprobed-dropdown",
  "freetext-disclosure",
  "doc-unverified",
  // A PDF nobody rendered and a board nobody has captured a page for are the
  // user's pipeline lagging, not the board misbehaving — same as the two above.
  "doc-unrendered",
  "board-unsighted",
  "fact-base-changed",
  "board-untrusted",
  "l3-rejected",
  "cap-company",
  "board-paused",
  "reconciled-not-sent",
  // Read off the ledgers, like cap-company: the queue was stale, nothing
  // malfunctioned. (Was missing here; a stale queue of ten already-applied
  // rows moved the breaker as if a board had failed ten times.)
  "already-applied",
  // A DRY RUN IS A REHEARSAL, AND A REHEARSAL IS THE SYSTEM WORKING. This was
  // the same omission as `already-applied` and cost more: a dry run defers
  // every job by construction, so a 12-job rehearsal produced rehearsed=4 and
  // board-paused=8 — the breaker pausing every board the run touched, on
  // evidence that nothing at all had gone wrong.
  "rehearsed",
  // The four below are outcomes, not faults. A posting that is gone is the
  // employer closing a req; a company or board STOP is a human brake this
  // very module respects elsewhere, so counting it as a failure would let a
  // brake manufacture the evidence for more braking; and a form still
  // offering `next` after maxPages is a form this repo cannot walk, which is
  // a gap in our adapters rather than a board malfunctioning.
  "posting-gone",
  "company-stopped",
  "board-stopped",
  "multipage-unresolvable",
])

/**
 * Kinds that DO move the breaker.
 *
 * `bot-challenge` and `email-code-challenge` are in here and that is C13's
 * whole point: Greenhouse documents Invisible reCAPTCHA analysing mouse and
 * typing patterns, and a Playwright fill emits near-zero input events — so
 * being challenged is THE BOARD WORKING AS DESIGNED against automation, and its
 * incidence rises with N. They are not malfunctions, so they are never a run
 * STOP; but they are strong evidence about ONE BOARD, so they feed the pause.
 * Treating them as either "ignore" or "halt" gets a real behaviour wrong.
 */
export function movesBreaker(kind) {
  if (!kind) return false
  return !NOT_A_MALFUNCTION.has(kind)
}

/** One attempt's signature. Identical (kind, stage) twice running is the
 *  strongest same-cause signal available without a model. */
const signature = (r) => `${r?.kind ?? "?"}|${r?.stage ?? "?"}`

/**
 * The breaker for one run.
 *
 * IN-MEMORY, with the DB used only for the record a human reads. The rules are
 * all "the last few attempts", which is run state — persisting a pause across
 * invocations is exactly what §4.6 forbids without a re-probe.
 *
 * @param backoffMs      how long a paused board stays paused before ONE probe.
 * @param maxRetries     bounded job-level retries for a transient kind.
 * @param now            injected clock. A timed backoff tested against the real
 *                       clock is a test that sleeps, and a test that sleeps is
 *                       one people delete.
 */
export function makeBreaker({
  db = null,
  runId = null,
  backoffMs = 5 * 60 * 1000,
  maxRetries = 2,
  now = () => new Date(),
  onPause = null,
} = {}) {
  // Per-board history, newest last, capped at 5 — the longest window any board
  // rule looks at.
  const boardHistory = new Map()
  // Run-wide history of the last 10, for the run-level rule only.
  const recent = []
  const paused = new Map() // board -> {until, reason, probing}
  const retries = new Map() // slug -> count
  let runStopReason = null

  const hist = (board) => {
    if (!boardHistory.has(board)) boardHistory.set(board, [])
    return boardHistory.get(board)
  }

  /**
   * May this job start?
   *
   * @returns {{ok: true} | {ok: false, reason, until, probe: boolean}}
   *   `probe: true` means the backoff has expired and THIS job is the one
   *   re-admission attempt. Exactly one job gets it; the rest keep waiting.
   */
  function admit(job) {
    if (runStopReason)
      return { ok: false, reason: runStopReason, until: null, probe: false }
    const board = job?.board_key ?? job?.board ?? null
    const p = board ? paused.get(board) : null
    if (!p) return { ok: true }

    const t = now().getTime()
    if (t < p.until)
      return {
        ok: false,
        reason: p.reason,
        until: new Date(p.until).toISOString(),
        probe: false,
      }
    if (p.probing)
      // Another job is already the probe. Two probes would double the traffic
      // at a board that just failed repeatedly, which is the opposite of a
      // backoff.
      return {
        ok: false,
        reason: `${p.reason} (a re-admission probe is already in flight)`,
        until: new Date(p.until).toISOString(),
        probe: false,
      }
    p.probing = true
    return { ok: true, probe: true }
  }

  /**
   * Record how a job came out, and decide what that means.
   *
   * @returns {{action, board, reason}} where action is
   *   `none` | `retry` | `pause-board` | `stop-run`.
   */
  function record(result) {
    const board = result?.board_key ?? result?.board ?? null
    const kind = result?.kind ?? null
    const failed = Boolean(kind) && movesBreaker(kind)

    // A TRANSIENT GETS ITS BOUNDED RETRIES BEFORE IT IS ELIGIBLE TO COUNT, and
    // it is recorded in NO history until they are spent. A wifi drop that is
    // about to be retried successfully must leave no trace in the windows the
    // rules read, or the retry is decorative.
    if (failed && isTransient(kind)) {
      const n = (retries.get(result.slug) ?? 0) + 1
      if (n <= maxRetries) {
        retries.set(result.slug, n)
        return {
          action: "retry",
          board,
          reason:
            `${kind} (attempt ${n} of ${maxRetries + 1}) — a transient is ` +
            `retried before it counts toward a signature`,
        }
      }
    }

    // BOTH OUTCOMES GO INTO BOTH WINDOWS. "3 of the last 5" is a ratio, and a
    // history holding only failures cannot express one — it would read 3 of 3
    // and pause a board that failed three times across fifty successes.
    const h = board ? hist(board) : []
    h.push({ ok: !failed, sig: failed ? signature(result) : null })
    if (h.length > 5) h.shift()
    recent.push({ board, ok: !failed })
    if (recent.length > 10) recent.shift()

    // A SUCCESS ON A PAUSED BOARD CLEARS THE PAUSE ENTIRELY. §4.6: "one job;
    // success clears it". The history is reset with it, so a board that
    // recovered does not carry its old failures into the next evaluation and
    // re-pause on the first new hiccup.
    if (!failed) {
      if (board && paused.has(board)) {
        paused.delete(board)
        boardHistory.set(board, [])
        if (db && runId)
          try {
            clearBoardPause(db, board, { run_id: runId })
          } catch {
            /* the record is for a human; it must not break the run */
          }
      }
      return { action: "none", board, reason: null }
    }

    // Rule 3 FIRST: the run-level stop is the widest claim, and checking it
    // before the board rules keeps a genuinely systemic failure from being
    // reported as a series of unrelated board pauses.
    const lastTen = recent.slice(-10)
    const failures = lastTen.filter((r) => !r.ok)
    const boards = new Set(failures.map((r) => r.board).filter(Boolean))
    // NO "the window must be full yet" GUARD, and that was a real bug rather
    // than a simplification: `recent` is capped at 10, so `failures >= 8`
    // already implies at least 8 of at most 10. Requiring 10 entries first
    // meant a run whose first 8 attempts ALL failed across several boards
    // sailed past the rule — precisely the run that should never have been
    // allowed to reach job 11.
    if (failures.length >= 8 && boards.size >= 2) {
      runStopReason =
        `${failures.length} of the last ${lastTen.length} attempts failed, across ` +
        `${boards.size} distinct boards — this is not one board being broken`
      return { action: "stop-run", board, reason: runStopReason }
    }

    if (!board) return { action: "none", board, reason: null }

    // Rule 1: the same signature twice consecutively. Both must be failures —
    // a success between them breaks the sequence, which is what "consecutively"
    // means and what a sig-only comparison would miss.
    const [prev, last] = h.slice(-2)
    if (h.length >= 2 && !prev.ok && !last.ok && prev.sig === last.sig)
      return pause(
        board,
        `the same failure twice in a row on this board (${safeText(last.sig, 60)})`,
        kind,
      )

    // Rule 2: >= 3 failures in this board's last 5 attempts.
    const window = h.slice(-5)
    const fails = window.filter((x) => !x.ok).length
    if (fails >= 3)
      return pause(
        board,
        `${fails} of this board's last ${window.length} attempts failed`,
        kind,
      )

    return { action: "none", board, reason: null }
  }

  function pause(board, reason, kind) {
    const until = now().getTime() + backoffMs
    paused.set(board, { until, reason, probing: false })
    if (db && runId)
      try {
        recordBoardPause(db, {
          board_key: board,
          run_id: runId,
          paused_at: now(),
          until: new Date(until),
          reason_kind: kind,
          reason_detail: safeText(reason, 200),
        })
      } catch {
        /* the record is for a human; it must not break the run */
      }
    if (onPause) onPause({ board, reason, until: new Date(until), kind })
    return { action: "pause-board", board, reason }
  }

  return {
    admit,
    record,
    /** Why the RUN stopped, or null. A board pause never sets this — that is
     *  the difference the whole file exists to hold. */
    get runStopReason() {
      return runStopReason
    },
    /** Paused boards and their reasons, as a FIRST-CLASS RUN OUTCOME. §4.6:
     *  reported as a number, never as an absence. */
    pausedBoards() {
      return [...paused].map(([board, p]) => ({
        board,
        reason: p.reason,
        until: new Date(p.until).toISOString(),
      }))
    },
  }
}
