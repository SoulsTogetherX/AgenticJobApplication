// The anomaly circuit breaker (§4.6). Phase 5 W2/W4.
//
// THE CHECK THIS FILE EXISTS FOR, in the plan's own words: "This is the check
// that the breaker is not a throttle." The user's decision is UNLIMITED
// application volume, so a mechanism that quietly reduced throughput would be a
// defect rather than a safety feature — and the shape of that defect is a
// breaker that fires on healthy runs. Half these tests are the breaker NOT
// firing.
//
// The other half is N-invariance: a healthy run of 999 must be no likelier to
// halt than a healthy run of 3. Every rule is a statement about the last few
// attempts, and the tests drive long runs to prove the windows do not
// accumulate.
import test from "node:test"
import assert from "node:assert/strict"
import {
  makeBreaker,
  movesBreaker,
  isTransient,
} from "../../src/auto/breaker.mjs"

// A clock the tests own. A timed backoff tested against the real clock is a
// test that sleeps, and a test that sleeps is one people delete.
function clock(startMs = 1_000_000) {
  let t = startMs
  return { now: () => new Date(t), advance: (ms) => (t += ms) }
}

const fail = (board, kind = "nav-timeout", stage = "plan", slug = "s") => ({
  board_key: board,
  kind,
  stage,
  slug,
})
const ok = (board) => ({ board_key: board, kind: null, slug: "s" })

// A kind that is a malfunction and NOT transient, so it counts immediately and
// the retry path is not in the way of the rule under test.
const HARD = "plan-error"

// --- what moves the breaker at all --------------------------------------------

test("an honest deferral never moves the breaker", () => {
  // THE THROTTLE TEST. A run whose every job defers because the user has not
  // banked an answer is a run that is WORKING — hard rule 6 says a stated
  // deferral is the designed outcome. A breaker that paused boards over it
  // would convert the system's caution into a volume limit.
  const c = clock()
  const b = makeBreaker({ now: c.now })
  for (let i = 0; i < 50; i++)
    for (const kind of [
      "consent-tickbox",
      "confirm-widget",
      "unknown-field",
      "cap-company",
      "l3-rejected",
      "board-untrusted",
      "doc-unverified",
      // 2026-08-18: a PDF nobody rendered, a host nobody captured a page for,
      // and a queue row the ledgers already say was applied to — none of them
      // is the board misbehaving.
      "doc-unrendered",
      "board-unsighted",
      "already-applied",
    ]) {
      const got = b.record({ ...fail("greenhouse", kind), slug: `s${i}` })
      assert.equal(got.action, "none", `${kind} must not move the breaker`)
    }
  assert.deepEqual(b.pausedBoards(), [])
  assert.equal(b.runStopReason, null)
  assert.deepEqual(b.admit({ board_key: "greenhouse" }), { ok: true })
})

test("a bot challenge DOES move it — the board is working as designed", () => {
  // C13/F6. Greenhouse documents Invisible reCAPTCHA analysing mouse and typing
  // patterns; a Playwright fill emits near-zero input events. So a challenge is
  // strong evidence about ONE BOARD. It is not a malfunction, so it must never
  // be a run STOP — but ignoring it would let a board that is refusing every
  // application be hammered all night.
  assert.equal(movesBreaker("bot-challenge"), true)
  assert.equal(movesBreaker("email-code-challenge"), true)
  assert.equal(movesBreaker("captcha"), true)
})

test("a rehearsal and the other non-faults do NOT move it", () => {
  // THE SET IS THE DIFFERENCE BETWEEN A BREAKER AND A THROTTLE. A dry run
  // defers every job by construction, so with `rehearsed` missing from
  // NOT_A_MALFUNCTION a 12-job rehearsal produced rehearsed=4 and
  // board-paused=8 — every board the run touched paused on evidence that
  // nothing had gone wrong. Measured 2026-08-25, alongside the
  // already-applied omission that preceded it.
  //
  // The rest are outcomes rather than faults: a closed req, the two human
  // brakes this module itself respects (counting one as a failure would let a
  // brake manufacture the evidence for more braking), and a form this repo
  // cannot walk, which is a gap in our adapters and not a board misbehaving.
  for (const k of [
    "rehearsed",
    "posting-gone",
    "company-stopped",
    "board-stopped",
    "multipage-unresolvable",
  ])
    assert.equal(movesBreaker(k), false, k)
})

test("only nav-timeout and browser-crash are transient", () => {
  assert.ok(isTransient("nav-timeout"))
  assert.ok(isTransient("browser-crash"))
  for (const k of ["plan-error", "bot-challenge", "db-write-failed"])
    assert.equal(isTransient(k), false, k)
})

// --- W2's named check ----------------------------------------------------------

test("a reCAPTCHA resubmit yields a BOARD PAUSE, not a run STOP", () => {
  // W2's falsifiable check, in one test.
  const c = clock()
  const b = makeBreaker({ now: c.now })
  assert.equal(
    b.record(fail("greenhouse", "bot-challenge", "post-submit", "a")).action,
    "none",
    "one challenge is not evidence of anything",
  )
  const second = b.record(
    fail("greenhouse", "bot-challenge", "post-submit", "b"),
  )
  assert.equal(second.action, "pause-board")
  assert.equal(second.board, "greenhouse")
  assert.equal(b.runStopReason, null, "and the RUN is untouched")

  // Other boards keep running.
  assert.deepEqual(b.admit({ board_key: "lever" }), { ok: true })
  const held = b.admit({ board_key: "greenhouse" })
  assert.equal(held.ok, false)
  assert.match(held.reason, /same failure twice in a row/)
})

// --- the three rules -----------------------------------------------------------

test("rule 1: the same signature twice CONSECUTIVELY pauses the board", () => {
  const c = clock()
  const b = makeBreaker({ now: c.now })
  b.record(fail("gh", HARD, "plan", "a"))
  assert.equal(b.record(fail("gh", HARD, "plan", "b")).action, "pause-board")
})

test("rule 1 needs them CONSECUTIVE — a success in between breaks the run", () => {
  const c = clock()
  const b = makeBreaker({ now: c.now })
  b.record(fail("gh", HARD, "plan", "a"))
  b.record(ok("gh"))
  assert.equal(
    b.record(fail("gh", HARD, "plan", "b")).action,
    "none",
    "two failures either side of a success are not a signature",
  )
})

test("rule 1 needs the SAME signature — two different failures are not one", () => {
  const c = clock()
  const b = makeBreaker({ now: c.now })
  b.record(fail("gh", HARD, "plan", "a"))
  assert.equal(
    b.record(fail("gh", "db-write-failed", "authorize", "b")).action,
    "none",
  )
})

test("rule 2: 3 failures in a board's last 5 attempts pauses it", () => {
  const c = clock()
  const b = makeBreaker({ now: c.now })
  // Alternating, so rule 1 never fires and rule 2 is what is under test.
  b.record(fail("gh", HARD, "a", "1"))
  b.record(ok("gh"))
  b.record(fail("gh", "db-write-failed", "b", "2"))
  b.record(ok("gh"))
  const got = b.record(fail("gh", "plan-error", "c", "3"))
  assert.equal(got.action, "pause-board")
  assert.match(got.reason, /3 of this board's last 5/)
})

test("rule 2 is a RATIO, not a count — 3 failures across 50 jobs is fine", () => {
  // The N-invariance property, and the bug a failures-only history would have
  // had: it would read "3 of 3" and pause a board that is 94% healthy.
  const c = clock()
  const b = makeBreaker({ now: c.now })
  for (let i = 0; i < 50; i++) {
    const r =
      i % 17 === 0
        ? b.record(fail("gh", HARD, `stage${i}`, `s${i}`))
        : b.record(ok("gh"))
    assert.notEqual(r.action, "pause-board", `paused at job ${i}`)
  }
  assert.deepEqual(b.pausedBoards(), [])
})

test("rule 3: 8 of the last 10 across >=2 boards stops the RUN", () => {
  const c = clock()
  const b = makeBreaker({ now: c.now })
  let stopped = null
  for (let i = 0; i < 10; i++) {
    const board = i % 2 ? "gh" : "lever"
    const r =
      i < 8
        ? b.record(fail(board, `kind-${i}`, `stage-${i}`, `s${i}`))
        : b.record(ok(board))
    if (r.action === "stop-run") stopped = r
  }
  assert.ok(stopped, "a systemic failure must stop the run")
  assert.match(b.runStopReason, /across 2 distinct boards/)
  assert.equal(b.admit({ board_key: "ashby" }).ok, false, "everything halts")
})

test("rule 3 needs >=2 boards — one broken board never stops the run", () => {
  // THE HEADLINE PROPERTY: "A run must never halt because one board is broken."
  const c = clock()
  const b = makeBreaker({ now: c.now })
  for (let i = 0; i < 40; i++)
    b.record(fail("gh", `kind-${i}`, `stage-${i}`, `s${i}`))
  assert.equal(b.runStopReason, null)
  assert.deepEqual(b.admit({ board_key: "lever" }), { ok: true })
})

test("a healthy run of 999 is no likelier to halt than one of 3", () => {
  // N-invariance, driven rather than argued. A rule that counted over the run
  // rather than over a window would fire somewhere in here.
  const c = clock()
  for (const n of [3, 999]) {
    const b = makeBreaker({ now: c.now })
    for (let i = 0; i < n; i++)
      b.record({ board_key: i % 3 ? "gh" : "lever", kind: null, slug: `s${i}` })
    assert.equal(b.runStopReason, null, `halted on a healthy run of ${n}`)
    assert.deepEqual(b.pausedBoards(), [], `paused on a healthy run of ${n}`)
  }
})

// --- transients ----------------------------------------------------------------

test("a transient is RETRIED before it counts, and leaves no trace if it recovers", () => {
  // The 20-second wifi drop at job 41. Without this, it would have paused
  // Greenhouse for the rest of a run holding 900 Greenhouse leads and reported
  // the outcome as `ok`.
  const c = clock()
  const b = makeBreaker({ now: c.now, maxRetries: 2 })
  assert.equal(b.record(fail("gh", "nav-timeout", "nav", "x")).action, "retry")
  assert.equal(b.record(fail("gh", "nav-timeout", "nav", "x")).action, "retry")
  b.record(ok("gh"))
  // A second job hitting the same transient starts its own retry budget, and
  // neither job's retried attempts are in any window.
  assert.equal(b.record(fail("gh", "nav-timeout", "nav", "y")).action, "retry")
  assert.deepEqual(b.pausedBoards(), [])
})

test("a transient that exhausts its retries DOES count", () => {
  const c = clock()
  const b = makeBreaker({ now: c.now, maxRetries: 1 })
  b.record(fail("gh", "nav-timeout", "nav", "x")) // retry
  b.record(fail("gh", "nav-timeout", "nav", "x")) // counts
  const got = b.record(fail("gh", "nav-timeout", "nav", "y")) // retry (new slug)
  assert.equal(got.action, "retry")
  const then = b.record(fail("gh", "nav-timeout", "nav", "y")) // counts, same sig
  assert.equal(then.action, "pause-board")
})

// --- the pause is a backoff, not a stop -----------------------------------------

test("a pause expires, and exactly ONE job is re-admitted as the probe", () => {
  const c = clock()
  const b = makeBreaker({ now: c.now, backoffMs: 60_000 })
  b.record(fail("gh", HARD, "plan", "a"))
  b.record(fail("gh", HARD, "plan", "b"))
  assert.equal(b.admit({ board_key: "gh" }).ok, false)

  c.advance(60_001)
  const probe = b.admit({ board_key: "gh" })
  assert.equal(probe.ok, true)
  assert.equal(probe.probe, true, "this job is the re-admission probe")

  const second = b.admit({ board_key: "gh" })
  assert.equal(second.ok, false, "a second probe would double the traffic")
  assert.match(second.reason, /probe is already in flight/)
})

test("a probe that SUCCEEDS clears the pause, and the board starts clean", () => {
  const c = clock()
  const b = makeBreaker({ now: c.now, backoffMs: 60_000 })
  b.record(fail("gh", HARD, "plan", "a"))
  b.record(fail("gh", HARD, "plan", "b"))
  c.advance(60_001)
  b.admit({ board_key: "gh" })

  b.record(ok("gh"))
  assert.deepEqual(b.pausedBoards(), [])
  assert.deepEqual(b.admit({ board_key: "gh" }), { ok: true })

  // And the old failures are gone: one new failure must not re-pause it.
  assert.equal(b.record(fail("gh", HARD, "plan", "c")).action, "none")
})

test("a pause never sets the run's stop reason", () => {
  // The distinction the whole module exists to hold. A run with a paused board
  // still reports its outcome as ok — writing a stop reason here would make a
  // 998-application success read as a stopped run.
  const c = clock()
  const b = makeBreaker({ now: c.now })
  b.record(fail("gh", HARD, "plan", "a"))
  b.record(fail("gh", HARD, "plan", "b"))
  assert.equal(b.runStopReason, null)
  assert.equal(b.pausedBoards().length, 1)
})

test("paused boards are a first-class outcome, reported as a number", () => {
  // §4.6: "paused boards and their held job counts are a first-class run
  // outcome, reported as a number, not as an absence".
  const c = clock()
  const b = makeBreaker({ now: c.now })
  for (const board of ["gh", "lever"]) {
    b.record(fail(board, HARD, "plan", "a"))
    b.record(fail(board, HARD, "plan", "b"))
  }
  const paused = b.pausedBoards()
  assert.equal(paused.length, 2)
  for (const p of paused) {
    assert.ok(p.reason, "a pause without a stated reason is a silent skip")
    assert.match(p.until, /^\d{4}-\d{2}-\d{2}T/)
  }
})

test("a job with no board is never paused, and never pauses anything", () => {
  const c = clock()
  const b = makeBreaker({ now: c.now })
  b.record({ kind: HARD, stage: "plan", slug: "a" })
  b.record({ kind: HARD, stage: "plan", slug: "b" })
  assert.deepEqual(b.pausedBoards(), [])
  assert.deepEqual(b.admit({}), { ok: true })
})

test("the breaker records nothing to a db it was not given", () => {
  // db and runId are optional: the rules are run state, and a breaker driven in
  // a unit test must not need a database to be exercised.
  const c = clock()
  const b = makeBreaker({ now: c.now })
  b.record(fail("gh", HARD, "plan", "a"))
  assert.doesNotThrow(() => b.record(fail("gh", HARD, "plan", "b")))
})
