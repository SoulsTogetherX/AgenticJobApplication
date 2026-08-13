// Single-flight advisory file locking, with stale-holder recovery.
//
// WHY THIS EXISTS — measured, not hypothesised. Six concurrent
// save-answer.mjs writers over five trials lost 1 to 3 of the 6 answers in
// four of them, and EVERY process exited 0. Read-modify-write over a whole
// file has no serialisation of its own, so the last writer wins and the
// losers report success. The same shape is live in the lead store:
// `upsertLeads` rewrites every lead in one transaction, so a manual sweep
// overlapping the scheduled one silently drops a set of repost counters.
// SQLite's own busy_timeout does not help there — both writers are
// individually well-formed transactions; the loss is in the read that
// preceded them.
//
// THE MECHANISM is `fs.openSync(path, "wx")`: create-exclusively-or-fail.
// That single syscall's atomicity IS the lock. Nothing else here is clever;
// everything else is about the one failure a lock introduces.
//
// THE FAILURE A LOCK INTRODUCES is a lockfile that outlives its holder and
// wedges the resource forever. A guard that wedges the fact base gets deleted
// by the user, and a deleted guard protects nothing — so staleness recovery
// is not a nicety, it is what makes the lock survivable.
//
// ONE RULE BREAKS A LOCK, AND ONLY ONE:
//
//   A lock whose mtime is older than `staleMs` is abandoned and may be broken.
//   NOTHING ELSE BREAKS A LOCK.
//
// WHY NOT A PID PROBE — the obvious second mechanism, which this file shipped
// with, and which caused the exact bug the file exists to prevent.
//
// The first version also broke a lock when `process.kill(holder.pid, 0)`
// reported ESRCH, so that a killed writer recovered in milliseconds instead of
// seconds. A/B on that single variable, 20 writers x 5 trials, four reps
// (2026-07-31):
//
//   with the pid probe      LOST 7,2,13,9   MUTEX-VIOLATIONS 43,28,25,33
//   without it (age only)   LOST 0,0,0,0    MUTEX-VIOLATIONS  0, 0, 0, 0
//
// Instrumented over 112 breaks: the pid leg fired 112/112, the age leg 0/112,
// and in 112/112 the record read before the rename was NOT the record the
// rename took — every break destroyed a different, LIVE holder's lock, at an
// age of 0ms. The age check was saying "do not break" and the pid leg was
// overriding it.
//
// The probe is not lying about the pid. What is wrong is the INFERENCE:
// "the process that wrote this record is no longer running" does not imply
// "this lockfile is abandoned", because a short-lived CLI writer's pid dies
// milliseconds after it acquires, and the lockfile you are looking at may
// already be a different holder's. An invalid inference cannot be repaired by
// guarding it, so the probe is gone rather than gated.
//
// THE COST, STATED PLAINLY: a holder killed mid-critical-section blocks other
// waiters for up to `staleMs` instead of for milliseconds. That is the price of
// not letting the recovery path cause the bug it recovers from.
//
// AGE RECOVERS ALL THREE ORPHAN CLASSES anyway — a dead local pid, a lock from
// a machine that is gone, and the nastiest one: a holder that died between
// creating the lock and writing its identity into it, leaving an empty,
// unparseable record that identity could never have judged at all.
//
// TIMEOUT MUST EXCEED STALENESS, and `acquire` now asserts it. Shipping
// `timeout 10s` with `stale 30s` meant a default caller could never reach the
// staleness window at all — measured `ELOCKTIMEOUT after 10153ms` with the
// orphaned lock still sitting there untouched. That inversion is why the
// destructive pid leg looked load-bearing: it was covering for a recovery path
// that could not run. It is an asserted invariant now, not a convention.
//
// BREAKING IS ATOMIC, via rename to a unique name. When N waiters all judge
// the same lock stale, exactly one rename succeeds and the other N-1 get
// ENOENT and go back to polling. Nobody ever unlinks a path another waiter
// may have just re-created.
//
// AND THE BREAKER RE-AGES WHAT IT ACTUALLY TOOK. Between the stat that judged
// the lock old and the rename that takes it, the holder may have released and a
// NEW writer acquired — in which case the rename just took a live writer's
// lock, and deleting it would put two processes in the critical section at
// once. A file that turns out to be fresh goes straight back, via `linkSync`
// (atomic create-or-EEXIST, verified on this filesystem) so the restore can
// never clobber a lock created since.
//
// AND THE CONVERSE, which is the subtle half: a holder whose lock was broken
// out from under it must not then publish. `stillHeld()` re-reads the nonce,
// and a caller doing a read-modify-write MUST check it immediately before
// committing — otherwise the broken-out holder writes over the work of the
// writer that replaced it, which is exactly the lost update this file exists
// to prevent. `withLock` does that check for you.
//
// WIN32: "COULD NOT CREATE RIGHT NOW" IS NOT ONLY EEXIST. `openSync(p, "wx")`
// returns EPERM — not EEXIST — when the path is delete-pending, which is what a
// perfectly NORMAL release looks like from a waiter's side. Measured on this
// host with one churner and one waiter over 3s: 7357 attempts, EEXIST 3529,
// EPERM 636 (8.6%). Treating EPERM as a crash produced raw stack traces out of
// live writer processes. EPERM/EACCES/EBUSY all mean "not right now" and belong
// on the poll path, not the crash path. This is platform classification, not a
// pattern list to extend.
//
// LONG HOLDS NEED A HEARTBEAT, AND `withLock` REFUSES TO PRETEND OTHERWISE.
// `heartbeatMs` is a `setInterval`, so it can only fire when the event loop
// turns. `withLock` is synchronous by design and a synchronous body blocks the
// loop for its whole duration: measured, the mtime advanced 0ms over a 1500ms
// hold. A mitigation that silently does nothing is worse than an absent one,
// because callers budget on it — so `withLock` throws if you pass it, and only
// `withLockAsync` and a hand-held `acquire` (which can call `touch()`) accept
// one.
//
// THE HONEST LIMIT. This is COOPERATIVE and ADVISORY. It binds processes that
// take the lock and nothing else. A hand-edit, a text editor, a script that
// has not been taught to take it, or any tool from outside this repository is
// not serialised by it. It is a coordination protocol between our own
// processes, not a mandatory OS lock — and stating that is not a caveat, it
// is the contract.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

// How long a lock may sit untouched before a waiter presumes its holder is
// gone. Sized against the work being protected, not against wall-clock
// comfort: every write under this lock today is one short file rewrite or one
// small SQLite transaction, measured in single-digit milliseconds. A holder
// that has not touched its lock in 10s is not slow, it is dead. Long-running
// holders refresh instead (see `touch`).
export const DEFAULT_STALE_MS = 10_000
// How long a waiter blocks before giving up. MUST be greater than the stale
// window, or a single waiter can never recover an orphan by itself and someone
// has to delete a lockfile by hand. Asserted in `acquire`.
export const DEFAULT_TIMEOUT_MS = 20_000
export const DEFAULT_POLL_MS = 12

// A failed read is not an answer; see `readLock`.
const READ_ATTEMPTS = 5
const READ_BACKOFF_MS = 4
// Release can run from an exit handler: keep the worst case under ~100ms.
const UNLINK_ATTEMPTS = 20
const UNLINK_BACKOFF_MS = 5

// The three win32 codes that mean "not right now" rather than "broken".
const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"])

// Exported so the classification can be asserted directly rather than only
// through a probabilistic race. `wx` reports EEXIST when the file is there and
// EPERM when it is delete-pending — the same fact, seen a few microseconds
// apart, and only one of them used to be survivable.
export const isRetryableCreateError = (code) =>
  code === "EEXIST" || TRANSIENT.has(code)

export class LockTimeoutError extends Error {
  constructor(message, holder) {
    super(message)
    this.name = "LockTimeoutError"
    this.code = "ELOCKTIMEOUT"
    // Kept for compatibility with save-answer.mjs's timeout branch, which
    // exits 5 on this flag; adopting this module must not change that.
    this.lockTimeout = true
    this.holder = holder ?? null
  }
}

// The conventional lock path for a resource: the resource's own path plus
// ".lock". Callers should use this rather than inventing a name, because two
// processes guarding the same file under two different lock names are not
// guarding it at all.
export const lockPathFor = (target) => `${path.resolve(target)}.lock`

// Well-known locks, named here so independent owners cannot disagree about
// the path. LEADS_LOCK is the one w5-leads' find-jobs.mjs cmdSearch must take
// (see this file's header for what an overlapping sweep costs).
export const LEADS_LOCK = lockPathFor(path.join(ROOT, "jobs", "leads.db"))
export const AUTO_RUN_LOCK = path.join(ROOT, "jobs", ".auto", "run.lock")

function sleepSync(ms) {
  // Atomics.wait on a never-notified buffer: a real blocking sleep with no
  // busy-spin. The lock API is synchronous by design — a read-modify-write
  // cannot be allowed to interleave, so blocking is the honest primitive.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// READING THE LOCK, AND WHY IT REPORTS THREE STATES RATHER THAN TWO.
//
// Returning holder-or-null made `null` mean BOTH "there is no lock" and "I
// could not read the lock right now". Those are opposite facts, and collapsing
// them has teeth: N processes polling one path with readFileSync produce
// transient failures, and every one of them reads as "my lock is gone" — so a
// holder skips its own release (leaking a lock the next waiter reads as a
// crash) or aborts a write it was entitled to make.
//
// An empty or half-written file is a holder mid-acquire, not a corpse, so a
// parse failure is RETRIED rather than believed. Only ENOENT is an immediate
// answer, because a missing file is unambiguous.
export function readLock(lockPath) {
  let lastErr
  for (let i = 0; i < READ_ATTEMPTS; i++) {
    try {
      const holder = JSON.parse(fs.readFileSync(lockPath, "utf8"))
      if (holder && typeof holder === "object") return { state: "held", holder }
      lastErr = new Error("holder record is not an object")
    } catch (err) {
      if (err.code === "ENOENT") return { state: "absent", holder: null }
      lastErr = err
    }
    sleepSync(READ_BACKOFF_MS)
  }
  return { state: "unreadable", holder: null, err: lastErr }
}

// The friendly wrapper: the holder record, or null when there is none or it
// cannot be read. Callers deciding whether to BREAK must not use this — an
// unreadable record is not evidence of absence, and age is the only test that
// may break a lock. Use `readLock` when the distinction matters.
export function readHolder(lockPath) {
  return readLock(lockPath).holder
}

// Milliseconds since the lock was last touched, or NULL when it cannot be
// stat'd. Null means "unknown age", never "expired": treating an unknown age as
// an old one is the direction that breaks a live writer's lock.
export function lockAgeMs(lockPath, now = Date.now()) {
  try {
    // Clock skew and a filesystem timestamp from the future must not read as
    // a hugely negative age that then compares as "not stale" forever — clamp
    // at 0, which is the conservative direction (never break early).
    return Math.max(0, now - fs.statSync(lockPath).mtimeMs)
  } catch {
    return null
  }
}

// Break a lock we have judged abandoned, then VERIFY WHAT WE TOOK.
//
// The rename is atomic, so simultaneous breakers cannot both succeed. But the
// judgement happened before the rename, and the holder may have released and a
// new writer acquired in between — so the taken file is re-aged, and one that
// turns out to be fresh is put back rather than deleted. Restoring uses
// `linkSync`, which is create-or-EEXIST on this filesystem: it can never
// clobber a lock somebody created in the meantime, which closes the
// check-then-act window that a plain rename left open.
//
// Returns true only when a genuinely stale lock was removed.
export function breakStale(lockPath, nonce, staleMs) {
  const doomed = `${lockPath}.stale-${process.pid}-${nonce}`
  try {
    fs.renameSync(lockPath, doomed)
  } catch {
    return false // someone else broke it, or the holder released it cleanly
  }

  const takenAge = lockAgeMs(doomed)
  if (takenAge !== null && takenAge <= staleMs) {
    // Not ours to break: we took a live holder's lock. Put it back.
    try {
      fs.linkSync(doomed, lockPath)
      fs.unlinkSync(doomed)
      return false
    } catch {
      // EEXIST: somebody legitimately created a lock while we held this one
      // aside, so there is nothing to restore into and dropping ours is
      // correct. Any other failure leaves the .stale file, which is inert; the
      // dispossessed holder's own stillHeld() check stops it publishing.
    }
  }

  try {
    fs.unlinkSync(doomed)
  } catch {
    /* inert leftover; the lock is already released, which is what mattered */
  }
  return true
}

/**
 * Take `lockPath`, blocking until it is free, a stale holder is recovered, or
 * the timeout expires.
 *
 * @returns a handle: { path, nonce, brokeStale, stillHeld(), touch(), release() }
 *   `brokeStale` is null on a clean acquisition, or a human-readable reason
 *   when a previous holder's lock was recovered — worth logging, because a
 *   lock that is routinely broken is telling you something.
 * @throws {LockTimeoutError} on timeout. NOTHING has been acquired, so the
 *   caller's resource is untouched and a retry is always safe.
 * @throws {RangeError} when timeoutMs <= staleMs, which is unrecoverable by
 *   waiting: see the header.
 */
export function acquire(lockPath, opts = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    staleMs = DEFAULT_STALE_MS,
    pollMs = DEFAULT_POLL_MS,
    heartbeatMs = 0,
    meta = null,
  } = opts

  // The invariant, asserted rather than assumed. A caller that waits for less
  // time than a lock takes to go stale can never recover an orphan, and will
  // report a timeout while the orphan sits there — which reads as "the lock is
  // broken" and gets fixed by deleting lockfiles by hand.
  if (!(timeoutMs > staleMs)) {
    throw new RangeError(
      `lock: timeoutMs (${timeoutMs}) must be greater than staleMs (${staleMs}), or a waiter can\n` +
        `never outlive the staleness window and an abandoned lock is never recovered automatically.`,
    )
  }

  const target = path.resolve(lockPath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const nonce = crypto.randomUUID()
  const deadline = Date.now() + timeoutMs
  let brokeStale = null

  for (;;) {
    try {
      const fd = fs.openSync(target, "wx")
      try {
        fs.writeSync(
          fd,
          JSON.stringify({
            pid: process.pid,
            host: os.hostname(),
            nonce,
            at: new Date().toISOString(),
            ...(meta ? { meta } : {}),
          }),
        )
      } finally {
        fs.closeSync(fd)
      }
      return makeHandle(target, nonce, brokeStale, heartbeatMs)
    } catch (err) {
      // EEXIST: held. EPERM/EACCES/EBUSY: on win32, delete-pending — i.e. a
      // holder is releasing right now. Both are "try again", not "crash".
      if (!isRetryableCreateError(err.code)) throw err
    }

    // DEADLINE FIRST, before any branch that can `continue`. The previous
    // shape checked it only on the fall-through path, so a break that kept
    // failing spun hot for the whole timeout with no sleep between attempts.
    if (Date.now() >= deadline) {
      const holder = readHolder(target)
      const who = holder
        ? `pid ${holder.pid} on ${holder.host} since ${holder.at}`
        : "another process"
      throw new LockTimeoutError(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${target} (held by ${who}).\n` +
          `NOTHING WAS DONE — this is safe to retry. A lock left behind by a process that died is\n` +
          `broken automatically once it is ${Math.round(staleMs / 1000)}s old, or you can delete the file.`,
        holder,
      )
    }

    const age = lockAgeMs(target)
    if (age !== null && age > staleMs) {
      if (breakStale(target, nonce, staleMs)) {
        brokeStale = `lock was ${Math.round(age / 1000)}s old (stale after ${Math.round(staleMs / 1000)}s)`
        continue // deadline is re-checked at the top; this cannot spin forever
      }
    }
    sleepSync(pollMs)
  }
}

function makeHandle(target, nonce, brokeStale, heartbeatMs) {
  let released = false
  let timer = null

  // Are we still the holder? A waiter that judged us stale may have broken
  // our lock and handed the resource to someone else, in which case anything
  // we are about to publish would clobber theirs.
  //
  // AN UNREADABLE LOCK COUNTS AS NOT HELD, deliberately. The two mistakes are
  // wildly unequal: writing when we no longer own the lock is the lost update;
  // refusing to write when we do own it costs one retry. `readLock` retries
  // first, so this is rare rather than routine.
  const stillHeld = () => {
    const r = readLock(target)
    return r.state === "held" && r.holder?.nonce === nonce
  }

  // Refresh the lock's mtime so the age test does not judge a legitimately
  // long-running holder abandoned. Refuses once the lock is no longer ours —
  // touching a lock someone else now holds would extend THEIR window using our
  // liveness, which is worse than doing nothing.
  const touch = () => {
    if (released || !stillHeld()) return false
    try {
      const now = new Date()
      fs.utimesSync(target, now, now)
      return true
    } catch {
      return false
    }
  }

  if (heartbeatMs > 0) {
    timer = setInterval(touch, heartbeatMs)
    // Never keep the process alive for the sake of a heartbeat.
    timer.unref?.()
  }

  // Only ever unlink a lock that is provably ours. The retry is the same win32
  // fact the header records: removing a file another process has open fails
  // transiently, and without the retry a release silently failed, the lock
  // leaked, and the next waiter read the leak as a crashed writer.
  const release = () => {
    if (released) return false
    released = true
    if (timer) clearInterval(timer)
    if (!stillHeld()) return false
    for (let i = 0; i < UNLINK_ATTEMPTS; i++) {
      try {
        fs.unlinkSync(target)
        return true
      } catch (err) {
        if (err.code === "ENOENT") return false
        if (!TRANSIENT.has(err.code)) return false
        sleepSync(UNLINK_BACKOFF_MS)
      }
    }
    return false
  }

  return { path: target, nonce, brokeStale, stillHeld, touch, release }
}

/**
 * Run `fn` under the lock and release it however `fn` ends.
 *
 * `fn` receives the handle. The post-condition is the point: if the lock was
 * broken out from under `fn` while it ran, this THROWS rather than letting a
 * caller believe its work was serialised. A caller that would rather find out
 * before committing should check `handle.stillHeld()` itself, immediately
 * before its write.
 *
 * Refuses `heartbeatMs`: a synchronous body blocks the event loop, so the
 * interval cannot fire and the caller would be budgeting on a mitigation that
 * measurably does nothing (mtime advanced 0ms over a 1500ms hold).
 */
export function withLock(lockPath, fn, opts = {}) {
  if (opts.heartbeatMs) {
    throw new TypeError(
      "withLock cannot heartbeat: its body is synchronous and blocks the event loop, so the\n" +
        "interval never fires (measured: 0ms of mtime advance over a 1500ms hold). Either keep the\n" +
        "critical section shorter than staleMs, or use withLockAsync / acquire + touch().",
    )
  }
  const handle = acquire(lockPath, opts)
  try {
    const result = fn(handle)
    if (result && typeof result.then === "function") {
      throw new TypeError(
        "withLock is synchronous and its callback returned a promise; use withLockAsync",
      )
    }
    assertHeldThrough(handle, opts)
    return result
  } finally {
    handle.release()
  }
}

/** The async twin. Acquisition still blocks (it is brief); the body awaits. */
export async function withLockAsync(lockPath, fn, opts = {}) {
  const handle = acquire(lockPath, opts)
  try {
    const result = await fn(handle)
    assertHeldThrough(handle, opts)
    return result
  } finally {
    handle.release()
  }
}

function assertHeldThrough(handle, opts) {
  if (opts.allowBrokenHold) return
  if (handle.stillHeld()) return
  const e = new Error(
    `Lock ${handle.path} was broken while it was held — another process may have written the same\n` +
      `resource concurrently. Treat this run's result as unserialised and redo it.`,
  )
  e.code = "ELOCKLOST"
  throw e
}
