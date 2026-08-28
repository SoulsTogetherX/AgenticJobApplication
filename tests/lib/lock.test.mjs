import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFile, execFileSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  acquire,
  withLock,
  withLockAsync,
  readLock,
  readHolder,
  breakStale,
  lockAgeMs,
  lockPathFor,
  isRetryableCreateError,
  LockTimeoutError,
  LEADS_LOCK,
  DEFAULT_STALE_MS,
  DEFAULT_TIMEOUT_MS,
} from "#lib/lock.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
// A FILESYSTEM path, not an import specifier — workers spawned from temp
// dirs import lock.mjs by this absolute URL because "#lib/*" resolves only
// under the package root. Segment form on purpose: a string sweep rewriting
// "../../src/lib/..." specifiers must not touch it (one did, 2026-08-27).
const LOCK_MJS = pathToFileURL(
  path.resolve(HERE, "..", "..", "src", "lib", "lock.mjs"),
).href

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aj-lock-"))
}

// Stands in for a heartbeat, so a test can hold a lock that never ages out
// without waiting real seconds for it. `lockAgeMs` clamps a future mtime to 0,
// so this is a permanently-fresh lock rather than a trick — and it is the only
// way to observe the poll path now that `timeoutMs > staleMs` is enforced,
// because any real waiter outlives any real staleness window by construction.
function keepFresh(p) {
  const future = new Date(Date.now() + 600_000)
  fs.utimesSync(p, future, future)
}

// --- acquisition -------------------------------------------------------------

test("acquire creates the lock and writes the holder's identity into it", () => {
  const dir = tmpdir()
  const p = path.join(dir, "a.lock")
  const h = acquire(p)
  try {
    assert.ok(fs.existsSync(p))
    const holder = readHolder(p)
    assert.equal(holder.pid, process.pid)
    assert.equal(holder.host, os.hostname())
    assert.equal(holder.nonce, h.nonce)
    assert.equal(h.brokeStale, null, "a clean acquisition breaks nothing")
    assert.ok(h.stillHeld())
  } finally {
    h.release()
  }
  assert.equal(fs.existsSync(p), false, "release removes the lock")
})

test("acquire creates the lock's parent directory", () => {
  const dir = tmpdir()
  const p = path.join(dir, "nested", "deeper", "a.lock")
  const h = acquire(p)
  assert.ok(fs.existsSync(p))
  h.release()
})

test("a second acquisition while the first is held times out and takes nothing", () => {
  const dir = tmpdir()
  const p = path.join(dir, "a.lock")
  const first = acquire(p)
  keepFresh(p) // a live, heartbeating holder: never a candidate for breaking
  try {
    const started = Date.now()
    assert.throws(
      () => acquire(p, { timeoutMs: 120, staleMs: 60, pollMs: 10 }),
      (err) => {
        assert.ok(err instanceof LockTimeoutError)
        assert.equal(err.code, "ELOCKTIMEOUT")
        assert.equal(err.lockTimeout, true, "save-answer.mjs branches on this")
        assert.equal(err.holder.pid, process.pid)
        assert.match(err.message, /NOTHING WAS DONE/)
        return true
      },
    )
    assert.ok(Date.now() - started >= 100, "it actually waited")
    assert.equal(
      readHolder(p).nonce,
      first.nonce,
      "the timed-out waiter must not have disturbed the holder",
    )
  } finally {
    first.release()
  }
})

// --- the timeout > staleness invariant ---------------------------------------

// This shipped inverted (timeout 10s, stale 30s), which meant a DEFAULT caller
// could never reach the staleness window: measured ELOCKTIMEOUT after 10153ms
// with the orphaned lock still sitting there. That is why the destructive pid
// probe looked load-bearing — it was covering for a recovery path that could
// not run.
test("acquire refuses a timeout that can never outlive the staleness window", () => {
  const dir = tmpdir()
  const p = path.join(dir, "a.lock")
  assert.throws(
    () => acquire(p, { timeoutMs: 1000, staleMs: 5000 }),
    (e) => {
      assert.ok(e instanceof RangeError)
      assert.match(e.message, /must be greater than staleMs/)
      return true
    },
  )
  assert.equal(fs.existsSync(p), false, "a refused acquire creates nothing")
  assert.throws(
    () => acquire(p, { timeoutMs: 5000, staleMs: 5000 }),
    RangeError,
    "equal is not greater: one full stale window must fit inside the wait",
  )
})

test("the shipped defaults satisfy the invariant they assert", () => {
  assert.ok(
    DEFAULT_TIMEOUT_MS > DEFAULT_STALE_MS,
    `defaults are inverted: timeout ${DEFAULT_TIMEOUT_MS} <= stale ${DEFAULT_STALE_MS}`,
  )
  const dir = tmpdir()
  const p = path.join(dir, "a.lock")
  const h = acquire(p) // would throw RangeError if the defaults were inverted
  h.release()
})

// --- staleness ---------------------------------------------------------------

// NOTE ON WHAT IS *NOT* HERE. There is no "a dead pid is recovered immediately"
// test, because the pid probe is gone by ruling and by measurement: over 112
// instrumented breaks it fired 112/112, the age leg 0/112, and every one of
// those breaks destroyed a DIFFERENT, LIVE holder's lock at ageMs 0. The
// inference "the pid that wrote this record is dead => this lockfile is
// abandoned" is invalid for short-lived processes, and a guard on an invalid
// inference is still invalid. Age recovers the same orphans a few seconds
// later; the three tests below are that recovery.
test("a lock older than staleMs is broken even when its holder cannot be judged", () => {
  const dir = tmpdir()
  const p = path.join(dir, "a.lock")
  // Deliberately unparseable: this is the holder-died-between-create-and-write
  // window, where identity says nothing and only age can decide.
  fs.writeFileSync(p, "")
  const old = new Date(Date.now() - 60_000)
  fs.utimesSync(p, old, old)
  const h = acquire(p, { staleMs: 1000, timeoutMs: 2000 })
  try {
    assert.match(h.brokeStale, /old \(stale after/)
    assert.equal(readHolder(p).nonce, h.nonce)
  } finally {
    h.release()
  }
})

test("a lock from a host that no longer exists is recovered by age alone", () => {
  const dir = tmpdir()
  const p = path.join(dir, "a.lock")
  fs.writeFileSync(
    p,
    JSON.stringify({
      pid: 4242,
      host: "some-decommissioned-machine",
      nonce: "theirs",
      at: new Date(Date.now() - 60_000).toISOString(),
    }),
  )
  const old = new Date(Date.now() - 60_000)
  fs.utimesSync(p, old, old)
  const h = acquire(p, { staleMs: 1000, timeoutMs: 2000 })
  try {
    assert.equal(readHolder(p).nonce, h.nonce)
  } finally {
    h.release()
  }
})

test("an unparseable but FRESH lock is not broken — garbage is not evidence of absence", () => {
  const dir = tmpdir()
  const p = path.join(dir, "a.lock")
  fs.writeFileSync(p, "{not json")
  keepFresh(p)
  assert.throws(
    () => acquire(p, { timeoutMs: 300, pollMs: 10, staleMs: 200 }),
    (e) => e.code === "ELOCKTIMEOUT",
  )
  assert.equal(fs.readFileSync(p, "utf8"), "{not json", "left untouched")
})

// The same fact without the future-mtime stand-in: an unjudgeable lock is left
// alone for a full staleness window and only then recovered. This is the ONLY
// leg that may break a lock, so its delay is the whole safety margin.
test("an unjudgeable lock is left alone until it has aged out, then recovered", () => {
  const dir = tmpdir()
  const p = path.join(dir, "a.lock")
  fs.writeFileSync(p, "") // died between create and write: identity says nothing
  const started = Date.now()
  const h = acquire(p, { staleMs: 400, timeoutMs: 4000, pollMs: 10 })
  try {
    assert.ok(
      Date.now() - started >= 350,
      "it broke a lock that was still inside its staleness window",
    )
    assert.match(h.brokeStale, /old \(stale after/)
  } finally {
    h.release()
  }
})

// THE 43-vs-0 DIFFERENCE. Judging a lock old and taking it are two steps, and
// the holder can release and a new writer acquire in between. The breaker
// therefore re-ages what the rename actually took, and puts back anything that
// turns out to be fresh — so calling it directly on a live lock must be a
// no-op, not a deletion.
test("breakStale refuses to delete a lock that is fresh at the moment it takes it", () => {
  const dir = tmpdir()
  const p = path.join(dir, "a.lock")
  const h = acquire(p)
  try {
    assert.equal(
      breakStale(p, "some-breaker", 10_000),
      false,
      "a fresh lock is not ours to break, however old it looked a moment ago",
    )
    assert.ok(fs.existsSync(p), "the live holder's lock is still there")
    assert.equal(readHolder(p).nonce, h.nonce, "and is byte-for-byte theirs")
    assert.ok(h.stillHeld())
    assert.equal(
      fs.readdirSync(dir).filter((f) => f.includes(".stale-")).length,
      0,
      "and no .stale- corpse was left behind",
    )
  } finally {
    h.release()
  }
})

test("breakStale removes a genuinely stale lock and reports it", () => {
  const dir = tmpdir()
  const p = path.join(dir, "a.lock")
  fs.writeFileSync(p, JSON.stringify({ nonce: "orphan" }))
  const old = new Date(Date.now() - 60_000)
  fs.utimesSync(p, old, old)
  assert.equal(breakStale(p, "breaker", 1000), true)
  assert.equal(fs.existsSync(p), false)
})

test("lockAgeMs clamps a future mtime to 0, and reports null when it cannot stat", () => {
  const dir = tmpdir()
  const p = path.join(dir, "a.lock")
  fs.writeFileSync(p, "{}")
  const future = new Date(Date.now() + 600_000)
  fs.utimesSync(p, future, future)
  assert.equal(lockAgeMs(p), 0, "a clock-skewed future mtime is not a huge age")
  assert.equal(
    lockAgeMs(path.join(dir, "nope.lock")),
    null,
    "unknown age is null, never 0 and never Infinity — it must not decide a break",
  )
})

// --- reading the lock --------------------------------------------------------

test("readLock separates 'no lock' from 'could not read the lock'", () => {
  const dir = tmpdir()
  const p = path.join(dir, "a.lock")
  assert.equal(readLock(p).state, "absent")
  fs.writeFileSync(p, JSON.stringify({ nonce: "x" }))
  assert.equal(readLock(p).state, "held")
  fs.writeFileSync(p, "") // a holder mid-acquire, not a corpse
  assert.equal(readLock(p).state, "unreadable")
  assert.equal(readHolder(p), null)
})

// --- win32 create-error classification ---------------------------------------

// `openSync(path, "wx")` returns EPERM, not EEXIST, when the path is
// delete-pending — which is what a NORMAL release looks like from a waiter's
// side. Measured on this host, one churner against one waiter over 3s:
// 7357 attempts, EEXIST 3529, EPERM 636 (8.6%). Special-casing EEXIST alone
// rethrew that 8.6% as a raw stack trace out of a live writer process.
test("EPERM/EACCES/EBUSY are poll-path conditions, not crash-path ones", () => {
  for (const code of ["EEXIST", "EPERM", "EACCES", "EBUSY"]) {
    assert.equal(isRetryableCreateError(code), true, `${code} must be retried`)
  }
  for (const code of ["ENOENT", "ENOTDIR", "EROFS", "EMFILE", undefined]) {
    assert.equal(
      isRetryableCreateError(code),
      false,
      `${code} is a real failure and must surface`,
    )
  }
})

test("acquire survives a path that is being created and deleted underneath it", () => {
  const dir = tmpdir()
  const p = path.join(dir, "churn.lock")
  const churn = path.join(dir, "churn.mjs")
  // Reproduces the delete-pending window by brute force: create/unlink as fast
  // as the filesystem allows while a real acquire runs against it.
  fs.writeFileSync(
    churn,
    `import fs from "node:fs"
const p = process.argv[2]
const end = Date.now() + 2500
while (Date.now() < end) {
  try { fs.closeSync(fs.openSync(p, "wx")) } catch { continue }
  try { fs.unlinkSync(p) } catch {}
}
`,
  )
  const kid = execFile(process.execPath, [churn, p], () => {})
  try {
    // Whatever happens, it must be a lock outcome — never a raw EPERM escaping.
    let acquired = 0
    const until = Date.now() + 2000
    while (Date.now() < until) {
      try {
        const h = acquire(p, { timeoutMs: 400, staleMs: 200, pollMs: 3 })
        acquired++
        h.release()
      } catch (err) {
        assert.equal(
          err.code,
          "ELOCKTIMEOUT",
          `acquire leaked a raw ${err.code}: ${err.message}`,
        )
      }
    }
    assert.ok(acquired > 0, "and it did manage to acquire at least once")
  } finally {
    kid.kill()
  }
})

// --- bounded waiting ---------------------------------------------------------

// The loop used to check its deadline only on the fall-through path, so a
// `continue` after a failed break skipped both the deadline check and the
// sleep — a hot spin for the full (one-hour, for the auto-run lock) timeout.
// The deadline is the first thing checked now, so no branch can outlive it.
//
// HONEST LIMIT: this asserts the bound, which is the property that matters. It
// does not by itself distinguish a hot spin from a polite one — an unbounded
// spin under the old shape would hang this test rather than fail it cleanly.
test("acquire never outlives its deadline, however the contention behaves", () => {
  const dir = tmpdir()
  const p = path.join(dir, "a.lock")
  fs.writeFileSync(p, "{not json") // unjudgeable: identity can never decide
  keepFresh(p) // and never stale: nothing may break it, so it must poll to the end
  const started = Date.now()
  assert.throws(
    () => acquire(p, { timeoutMs: 500, staleMs: 250, pollMs: 5 }),
    (e) => e.code === "ELOCKTIMEOUT",
  )
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 450, `gave up too early (${elapsed}ms)`)
  assert.ok(elapsed < 3000, `blew past its own deadline (${elapsed}ms)`)
})

// --- keeping and losing a hold ----------------------------------------------

test("release does NOT unlink a lock that another process has since taken", () => {
  const dir = tmpdir()
  const p = path.join(dir, "a.lock")
  const h = acquire(p)
  // Simulate: a waiter judged us stale, broke our lock, and took it.
  fs.writeFileSync(p, JSON.stringify({ pid: 999, host: "x", nonce: "theirs" }))
  assert.equal(h.stillHeld(), false)
  assert.equal(h.release(), false, "release reports it released nothing")
  assert.equal(
    readHolder(p).nonce,
    "theirs",
    "the new holder's lock must survive our release",
  )
})

test("touch refreshes the lock's age, and refuses once the lock is not ours", () => {
  const dir = tmpdir()
  const p = path.join(dir, "a.lock")
  const h = acquire(p)
  const old = new Date(Date.now() - 60_000)
  fs.utimesSync(p, old, old)
  assert.ok(lockAgeMs(p) > 50_000)
  assert.equal(h.touch(), true)
  assert.ok(lockAgeMs(p) < 5_000, "a long-running holder can stay alive")

  fs.writeFileSync(p, JSON.stringify({ pid: 999, host: "x", nonce: "theirs" }))
  const before = fs.statSync(p).mtimeMs
  assert.equal(h.touch(), false, "never extend someone else's window for them")
  assert.equal(fs.statSync(p).mtimeMs, before)
  h.release()
})

test("withLock throws ELOCKLOST when the lock was broken while the body ran", () => {
  const dir = tmpdir()
  const p = path.join(dir, "a.lock")
  assert.throws(
    () =>
      withLock(p, () => {
        fs.writeFileSync(p, JSON.stringify({ nonce: "someone-else" }))
        return "published"
      }),
    (e) => {
      assert.equal(e.code, "ELOCKLOST")
      assert.match(e.message, /unserialised/)
      return true
    },
  )
})

test("withLock releases the lock when the body throws", () => {
  const dir = tmpdir()
  const p = path.join(dir, "a.lock")
  assert.throws(() => {
    withLock(p, () => {
      throw new Error("boom")
    })
  }, /boom/)
  assert.equal(fs.existsSync(p), false)
})

test("withLock refuses an async callback instead of releasing early under it", () => {
  const dir = tmpdir()
  const p = path.join(dir, "a.lock")
  assert.throws(
    () => withLock(p, async () => 1),
    (e) => e instanceof TypeError && /withLockAsync/.test(e.message),
  )
  assert.equal(fs.existsSync(p), false)
})

// A heartbeat on a synchronous body is a mitigation that measurably does
// nothing: the interval cannot fire while the body holds the event loop, and
// the mtime advanced 0ms over a 1500ms hold. Refusing it is the point — a
// silent no-op gets budgeted on, and the budget is what breaks.
test("withLock refuses heartbeatMs rather than pretending to heartbeat", () => {
  const dir = tmpdir()
  const p = path.join(dir, "a.lock")
  assert.throws(
    () => withLock(p, () => 1, { heartbeatMs: 100 }),
    (e) => e instanceof TypeError && /never fires/.test(e.message),
  )
  assert.equal(fs.existsSync(p), false, "and takes no lock at all")
})

test("a synchronous body really does starve a setInterval — the reason above", () => {
  const dir = tmpdir()
  const p = path.join(dir, "a.lock")
  const h = acquire(p, { heartbeatMs: 20 })
  try {
    const before = fs.statSync(p).mtimeMs
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
    assert.equal(
      fs.statSync(p).mtimeMs,
      before,
      "if this ever advances, the heartbeat works and withLock may accept it",
    )
    assert.equal(h.touch(), true, "the manual refresh is the one that works")
  } finally {
    h.release()
  }
})

test("withLockAsync holds across an await and releases afterwards", async () => {
  const dir = tmpdir()
  const p = path.join(dir, "a.lock")
  const got = await withLockAsync(p, async (h) => {
    await new Promise((r) => setTimeout(r, 20))
    assert.ok(h.stillHeld())
    return 42
  })
  assert.equal(got, 42)
  assert.equal(fs.existsSync(p), false)
})

test("lockPathFor is the one naming convention, so two owners cannot disagree", () => {
  assert.equal(
    lockPathFor("/tmp/x/leads.db"),
    path.resolve("/tmp/x/leads.db") + ".lock",
  )
  assert.ok(LEADS_LOCK.endsWith("leads.db.lock"))
})

// --- the defect this file exists for ----------------------------------------
//
// THE PREVIOUS VERSION OF THIS SECTION COULD NOT FAIL ON ITS OWN SUBJECT. It
// held the critical section for 60ms and polled at 5ms, so a waiter's
// read/judge/break sequence never straddled a holder's exit — the exact
// interleaving the lock exists to serialise was made unreachable by the test's
// own timings. It passed 17/17 against an implementation measured to produce
// 43 mutual-exclusion violations, and flaked on Windows besides.
//
// The rewrite matches the one real consumer: a SHORT critical section that does
// FILE I/O inside it (save-answer.mjs reads, parses, rewrites and renames a
// YAML file in single-digit milliseconds). That is what makes the race dense.
//
// It counts MUTUAL-EXCLUSION VIOLATIONS directly — an ENTER logged while
// somebody else is inside — rather than counting lost updates. Loss is
// probabilistic and "usually survives" is exactly how the original defect hid.
// A violation is a proof, and one is a failure.

// TUNED BY MEASUREMENT, not by taste. Against a scratch reconstruction of the
// pid-probe implementation, five trials each:
//
//    6 writers x 10 rounds   violations 0,0,0,0,-    (invisible — the old shape)
//   16 writers x  3 rounds   violations 1,4,0,0,5
//   20 writers x  2 rounds   violations 3,1,1,6,0    <- densest, so this is it
//
// The violation window opens when a holder's PROCESS EXITS, so density comes
// from many short-lived writers rather than from many rounds each. Three trials
// puts the chance of a defective build slipping through at roughly 1 in 100.
const WRITERS = 20
const ROUNDS = 2
const TRIALS = 3

function raceChildSource({ locked, rounds = ROUNDS }) {
  const body = `
  fs.appendFileSync(log, "E " + process.pid + "\\n")
  // Real I/O inside the section, like the consumer's read-modify-rewrite.
  const tmp = scratch + "/w-" + process.pid + "-" + i + ".tmp"
  const seen = fs.readFileSync(log, "utf8")
  const fd = fs.openSync(tmp, "w")
  fs.writeSync(fd, seen)
  fs.fsyncSync(fd)
  fs.closeSync(fd)
  fs.unlinkSync(tmp)
  fs.appendFileSync(log, "X " + process.pid + "\\n")`

  return `import fs from "node:fs"
import { withLock } from ${JSON.stringify(LOCK_MJS)}
const [lock, log, scratch, startAt] = process.argv.slice(2)
// A start barrier, so the rounds x N processes actually collide instead of
// being serialised by process-spawn jitter.
const wait = Number(startAt) - Date.now()
if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait)
for (let i = 0; i < ${rounds}; i++) {
${
  locked
    ? `  withLock(lock, () => {${body}\n  }, { timeoutMs: 60000, staleMs: 10000, pollMs: 3 })`
    : `  {${body}\n  }`
}
}
`
}

// An ENTER while somebody else is inside. Returns every violation, not a count,
// so a failure names the processes that overlapped.
function mutexViolations(logText) {
  const out = []
  let inside = null
  for (const line of logText.trim().split(/\r?\n/)) {
    const [kind, pid] = line.split(" ")
    if (kind === "E") {
      if (inside !== null && inside !== pid)
        out.push(`${pid} entered while ${inside} was inside`)
      inside = pid
    } else if (kind === "X") {
      if (inside === pid) inside = null
    }
  }
  return out
}

async function runRace({ writers, locked, rounds = ROUNDS }) {
  const dir = tmpdir()
  const lock = path.join(dir, "shared.lock")
  const log = path.join(dir, "critical.log")
  const scratch = path.join(dir, "scratch")
  fs.mkdirSync(scratch)
  fs.writeFileSync(log, "")
  const child = path.join(dir, `child-${locked ? "locked" : "bare"}.mjs`)
  fs.writeFileSync(child, raceChildSource({ locked, rounds }))

  const startAt = String(Date.now() + 900 + writers * 25)
  await Promise.all(
    Array.from(
      { length: writers },
      () =>
        new Promise((resolve, reject) =>
          execFile(
            process.execPath,
            [child, lock, log, scratch, startAt],
            (err, _o, stderr) =>
              err ? reject(new Error(stderr || err.message)) : resolve(),
          ),
        ),
    ),
  )

  const text = fs.readFileSync(log, "utf8")
  return {
    dir,
    lock,
    lines: text.trim().split(/\r?\n/),
    violations: mutexViolations(text),
  }
}

// THE CANARY. If the detector cannot see a violation when there is definitely
// one, a green run above means nothing. Same children, same barrier, same I/O —
// the lock is the only variable removed.
test("the violation detector fires when the critical section is unguarded", async () => {
  const r = await runRace({ writers: 8, locked: false, rounds: 10 })
  assert.ok(
    r.violations.length > 0,
    "8 unguarded writers x 10 rounds produced no detectable overlap — the detector is blind",
  )
})

test(`${WRITERS} concurrent processes never overlap inside a short, I/O-heavy critical section`, async () => {
  for (let trial = 0; trial < TRIALS; trial++) {
    const r = await runRace({ writers: WRITERS, locked: true })
    assert.deepEqual(
      r.violations,
      [],
      `trial ${trial}: mutual exclusion violated ${r.violations.length} time(s)`,
    )
    assert.equal(
      r.lines.length,
      WRITERS * ROUNDS * 2,
      `trial ${trial}: not every process completed every round`,
    )
    assert.equal(
      fs.existsSync(r.lock),
      false,
      `trial ${trial}: a child did not release`,
    )
  }
})

test("a lock left behind by a killed process does not wedge the resource forever", () => {
  const dir = tmpdir()
  const lock = path.join(dir, "orphan.lock")
  const child = path.join(dir, "holder.mjs")
  fs.writeFileSync(
    child,
    `import { acquire } from ${JSON.stringify(LOCK_MJS)}
acquire(process.argv[2])
console.log("held")
process.exit(0)   // exits WITHOUT releasing, exactly like a crash
`,
  )
  const out = execFileSync(process.execPath, [child, lock], {
    encoding: "utf8",
  })
  assert.match(out, /held/)
  assert.ok(fs.existsSync(lock), "the orphaned lock is genuinely still there")

  // Age is the ONLY recovery path now, so this waits out the window rather than
  // recovering instantly — that delay is the stated price of deleting the pid
  // probe, and it is asserted here so nobody is surprised by it later.
  //
  // THE EPOCH THIS USED TO MEASURE FROM WAS THE WRONG ONE, and it made this the
  // flakiest test in the suite. Staleness runs off the LOCKFILE'S MTIME —
  // `lockAgeMs` stats the file — while the assertion timed from the PARENT'S
  // wall clock, started only after the child's process.exit, the OS teardown,
  // execFileSync returning, an assert.match and an existsSync. Call that gap G:
  // the lock is already G old when timing starts, acquire breaks it at ~400+G
  // on the file's clock, and the assertion therefore measured 400-G. It held
  // only while G stayed under about 80ms.
  //
  // Measured here: G is 8-10ms at rest and reached 675ms with the suite running
  // 6-way. Injecting a 250ms gap made the old assertion fail 8/8 while the
  // recovery itself was correct every single time — the code was right and the
  // clock was wrong. Under load the whole file failed 12/48 (25%).
  //
  // Two corrections, and the threshold goes UP rather than down. Lowering 350
  // would have bought quiet by making the assertion measure less; the property
  // worth keeping sharp is that a stale lock is waited out and NOT grabbed early.
  //
  //   1. Re-stamp the lock immediately before timing, so the staleness window
  //      starts here and none of it has already quietly elapsed. Rewriting the
  //      same bytes refreshes mtime from the OS clock; utimesSync would go
  //      through a seconds-valued conversion, and a stamp rounded into the past
  //      would break the lock instantly and fail this test for a new wrong reason.
  //   2. Measure the age from that stamp, the same way `lockAgeMs` does, so the
  //      assertion and the implementation read one clock. This is why the
  //      threshold can be the full staleMs: `acquire` breaks only when its own
  //      `Date.now() - mtimeMs` exceeds 400, and this reads the same difference
  //      strictly later, so it cannot be smaller. Any filesystem-vs-Date.now
  //      skew (measured up to 11ms here) appears on both sides and cancels.
  fs.writeFileSync(lock, fs.readFileSync(lock)) // same bytes, fresh mtime
  const stampedAt = fs.statSync(lock).mtimeMs
  const h = acquire(lock, { staleMs: 400, timeoutMs: 5000, pollMs: 20 })
  try {
    assert.match(h.brokeStale, /old \(stale after/)
    const ageAtBreak = Date.now() - stampedAt
    assert.ok(
      ageAtBreak >= 400,
      `broke a lock only ${Math.round(ageAtBreak)}ms old with staleMs=400 — ` +
        `it did not wait out the staleness window`,
    )
  } finally {
    h.release()
  }
})
