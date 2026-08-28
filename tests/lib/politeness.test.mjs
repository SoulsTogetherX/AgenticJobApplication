// Per-host politeness (Phase 2). Two hosts declare crawl-delay expectations —
// api.lever.co and index.commoncrawl.org — and a 429 from anywhere pauses its
// host. The tests that matter most are the NEGATIVE ones: an unthrottled host
// must pay no sleeps and no serialization (the sweep's whole concurrency win),
// and a 429'd request must never be silently retried (the host said no; a
// retry is the impolite version of what this layer exists to prevent).
//
// All timing runs on an injected fake clock, so a 1-second spacing asserts in
// microseconds and a 60-second pause costs nothing real.
import test from "node:test"
import assert from "node:assert/strict"

import {
  fetchJson,
  fetchText,
  setPolitenessClock,
  resetHostGates,
  retryAfterMs,
  HOST_MIN_DELAY_MS,
  RETRY_AFTER_DEFAULT_MS,
  RETRY_AFTER_CAP_MS,
} from "../../src/lib/lib.mjs"
import { findBoard } from "../../src/leads/find-boards.mjs"

// --- harness ---------------------------------------------------------------

// Fake clock: now() is a counter, sleep() parks a resolver until fireNext()
// advances time to the earliest sleeper. sleeps counts every park, which is
// how "zero sleeps" is asserted.
function fakeClock() {
  let t = 0
  const sleepers = []
  return {
    now: () => t,
    sleep(ms) {
      this.sleeps++
      return new Promise((resolve) => sleepers.push({ at: t + ms, resolve }))
    },
    sleeps: 0,
    fireNext() {
      if (!sleepers.length) return false
      sleepers.sort((a, b) => a.at - b.at)
      const s = sleepers.shift()
      t = Math.max(t, s.at)
      s.resolve()
      return true
    },
  }
}

const flush = () => new Promise((r) => setImmediate(r))

// Drive a promise to settlement, firing fake sleepers as they appear. The
// iteration cap turns a deadlock into a test failure instead of a hang.
async function settle(clock, p) {
  let settled = false
  const done = p.then(
    (v) => ({ ok: true, v }),
    (e) => ({ ok: false, e }),
  )
  done.finally(() => (settled = true))
  for (let i = 0; i < 10_000 && !settled; i++) {
    await flush()
    if (!settled) clock.fireNext()
  }
  assert.ok(settled, "promise never settled under the fake clock")
  return done
}

// Response-shaped stub, same idiom as query-list.test.mjs's stubFetch but
// with status/headers so 429s can be staged.
function jsonRes(data, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    json: async () => data,
    text: async () => JSON.stringify(data),
  }
}

function stubFetch(clock, handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    const call = { url: String(url), at: clock.now() }
    calls.push(call)
    return handler(call, init, calls.length)
  }
  return { calls, restore: () => (globalThis.fetch = original) }
}

function harness(t, handler) {
  const clock = fakeClock()
  const stub = stubFetch(clock, handler)
  const restoreClock = setPolitenessClock(clock)
  resetHostGates()
  t.after(() => {
    stub.restore()
    restoreClock()
    resetHostGates()
  })
  return { clock, calls: stub.calls }
}

const LEVER = (s) => `https://api.lever.co/v0/postings/${s}?mode=json`
const OTHER = (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`

// --- fast path -------------------------------------------------------------

test("an unthrottled host passes straight through: zero sleeps, no serialization", async (t) => {
  const { clock, calls } = harness(t, () => jsonRes({ jobs: [] }))
  const results = await settle(
    clock,
    Promise.all([1, 2, 3, 4, 5].map((i) => fetchJson(OTHER(`c${i}`)))),
  )
  assert.ok(results.ok)
  assert.equal(calls.length, 5)
  assert.equal(clock.sleeps, 0, "fast path must never sleep")
  assert.ok(
    calls.every((c) => c.at === 0),
    "all five must start immediately, not in single file",
  )
})

test("fetchText takes the same gate as fetchJson", async (t) => {
  const { clock, calls } = harness(t, () => jsonRes("ok"))
  const r = await settle(clock, fetchText("https://example.com/page"))
  assert.ok(r.ok)
  assert.equal(calls.length, 1)
  assert.equal(clock.sleeps, 0)
})

// --- throttled hosts -------------------------------------------------------

test("lever requests space start-to-start >= 1s under concurrency", async (t) => {
  const { clock, calls } = harness(t, () => jsonRes([{ id: 1 }]))
  const r = await settle(
    clock,
    Promise.all([
      fetchJson(LEVER("a")),
      fetchJson(LEVER("b")),
      fetchJson(LEVER("c")),
    ]),
  )
  assert.ok(r.ok)
  const starts = calls.map((c) => c.at)
  assert.deepEqual(starts, [0, 1000, 2000], "starts must be 1s apart")
})

test("the throttle is per host: lever spacing does not slow other hosts", async (t) => {
  const { clock, calls } = harness(t, () => jsonRes({ jobs: [] }))
  const r = await settle(
    clock,
    Promise.all([
      fetchJson(LEVER("a")),
      fetchJson(LEVER("b")),
      fetchJson(OTHER("acme")),
    ]),
  )
  assert.ok(r.ok)
  const other = calls.find((c) => c.url.includes("greenhouse"))
  assert.equal(other.at, 0, "the greenhouse call must not wait in lever's line")
})

// --- 429 handling ----------------------------------------------------------

test("a 429 surfaces with .status, pauses the host, and is never retried", async (t) => {
  const { clock, calls } = harness(t, (call) =>
    call.url.includes("/postings/hit429")
      ? jsonRes(null, { status: 429, headers: { "retry-after": "2" } })
      : jsonRes([{ id: 1 }]),
  )

  const first = await settle(clock, fetchJson(LEVER("hit429")))
  assert.ok(!first.ok, "the 429 must surface, not be swallowed")
  assert.equal(first.e.status, 429)
  assert.match(first.e.message, /HTTP 429/)
  assert.equal(calls.length, 1, "the failed request must NOT be retried")

  // The next request to the same host waits out the 2s pause.
  const second = await settle(clock, fetchJson(LEVER("later")))
  assert.ok(second.ok)
  assert.equal(calls.length, 2)
  assert.ok(
    calls[1].at >= 2000,
    `second request started at ${calls[1].at}ms, before the pause ended`,
  )
})

test("a 429 on an UNthrottled host pauses that host too", async (t) => {
  const { clock, calls } = harness(t, (call, init, n) =>
    n === 1
      ? jsonRes(null, { status: 429, headers: { "retry-after": "3" } })
      : jsonRes({ jobs: [] }),
  )
  const first = await settle(clock, fetchJson(OTHER("acme")))
  assert.ok(!first.ok)
  const second = await settle(clock, fetchJson(OTHER("globex")))
  assert.ok(second.ok)
  assert.ok(calls[1].at >= 3000, "same-host request must wait out the pause")
})

test("one paused host does not delay another host", async (t) => {
  const { clock, calls } = harness(t, (call) =>
    call.url.includes("lever")
      ? jsonRes(null, { status: 429, headers: { "retry-after": "60" } })
      : jsonRes({ jobs: [] }),
  )
  await settle(clock, fetchJson(LEVER("a")))
  const sleepsAfterPause = clock.sleeps
  const r = await settle(clock, fetchJson(OTHER("acme")))
  assert.ok(r.ok)
  assert.equal(
    clock.sleeps,
    sleepsAfterPause,
    "an unrelated host must not sleep because lever is paused",
  )
  assert.equal(calls.at(-1).at, calls.at(-2).at, "no wall time passed")
})

// --- Retry-After parsing ---------------------------------------------------

test("Retry-After: absent or garbage defaults, huge values are capped", (t) => {
  t.after(resetHostGates)
  assert.equal(retryAfterMs(null), RETRY_AFTER_DEFAULT_MS)
  assert.equal(retryAfterMs(""), RETRY_AFTER_DEFAULT_MS)
  assert.equal(retryAfterMs("soon"), RETRY_AFTER_DEFAULT_MS)
  assert.equal(retryAfterMs("7"), 7000)
  assert.equal(retryAfterMs("999999"), RETRY_AFTER_CAP_MS)
})

test("Retry-After: an HTTP-date is a delta from now; a past date defaults", (t) => {
  const epoch = Date.parse("2026-01-01T00:00:00Z")
  const restore = setPolitenessClock({ now: () => epoch })
  t.after(() => {
    restore()
    resetHostGates()
  })
  const in30s = new Date(epoch + 30_000).toUTCString()
  assert.equal(retryAfterMs(in30s), 30_000)
  const past = new Date(epoch - 30_000).toUTCString()
  assert.equal(retryAfterMs(past), RETRY_AFTER_DEFAULT_MS)
})

// --- config sanity ---------------------------------------------------------

test("the throttle list names exactly the two crawl-delay hosts", () => {
  // Growing this list is a decision, not a drive-by: every entry serializes a
  // host the sweep may fan out over.
  assert.deepEqual(Object.keys(HOST_MIN_DELAY_MS).sort(), [
    "api.lever.co",
    "index.commoncrawl.org",
  ])
  assert.ok(Object.values(HOST_MIN_DELAY_MS).every((ms) => ms >= 1000))
})

// --- find-boards probing ---------------------------------------------------

test("a rate-limited probe reports rateLimited, never 'no public board'", async (t) => {
  const { clock } = harness(t, (call) =>
    call.url.includes("api.lever.co")
      ? jsonRes(null, { status: 429, headers: { "retry-after": "1" } })
      : jsonRes(null, { status: 404 }),
  )
  const r = await settle(clock, findBoard("Acme"))
  assert.ok(r.ok)
  assert.equal(r.v.type, null)
  assert.equal(r.v.rateLimited, true)
})

test("a plain miss still reports no board, without the rateLimited flag", async (t) => {
  const { clock } = harness(t, () => jsonRes(null, { status: 404 }))
  const r = await settle(clock, findBoard("Acme"))
  assert.ok(r.ok)
  assert.equal(r.v.type, null)
  assert.equal(r.v.rateLimited, false)
})

test("a rate-limited ATS does not mask a hit on a later probe", async (t) => {
  // lever 429s, but the same slug answers on ashby — the company IS findable.
  const { clock } = harness(t, (call) => {
    if (call.url.includes("api.lever.co"))
      return jsonRes(null, { status: 429, headers: { "retry-after": "1" } })
    if (call.url.includes("api.ashbyhq.com/posting-api/job-board/acme"))
      return jsonRes({ jobs: [{ id: 1 }] })
    return jsonRes(null, { status: 404 })
  })
  const r = await settle(clock, findBoard("Acme"))
  assert.ok(r.ok)
  assert.equal(r.v.type, "ashby")
  assert.equal(r.v.slug, "acme")
})
