// The worker pool (§4.2). Two properties, and the second is the one revision 1
// of the plan got wrong:
//
//   * N is a RESOURCE limit, never a volume limit — every queued job runs.
//   * at most one job in flight per ORIGIN, not per board_key. Eight concurrent
//     Greenhouse tenants are eight tabs on ONE origin sharing one cookie jar
//     and one localStorage, and a resume upload token from one is spendable by
//     another.
//
// MAX-IN-FLIGHT IS OBSERVED HERE, not configured. A pool capable of eight that
// serialises on its exclusion key reports N=1 throughput under an N=8 label,
// and that is then the number a gate enforces forever.
import test from "node:test"
import assert from "node:assert/strict"
import { runPool, originCount } from "../../scripts/auto/pool.mjs"

const jobs = (specs) =>
  specs.map(([slug, origin]) => ({ slug, origin, board_key: `b:${slug}` }))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test("every queued job runs, even far past the worker count", async () => {
  const list = jobs(
    Array.from({ length: 40 }, (_, i) => [`s${i}`, `https://o${i % 8}.test`]),
  )
  const seen = []
  const out = await runPool({
    jobs: list,
    concurrency: 4,
    runOne: async (j) => {
      seen.push(j.slug)
      return { slug: j.slug, state: "deferred" }
    },
  })
  assert.equal(out.results.length, 40)
  assert.equal(new Set(seen).size, 40, "no job ran twice and none was dropped")
  assert.equal(out.skipped.length, 0)
})

test("40 jobs on ONE origin still all run — serialised, never dropped", async () => {
  const list = jobs(
    Array.from({ length: 40 }, (_, i) => [`s${i}`, "https://one.test"]),
  )
  const out = await runPool({
    jobs: list,
    concurrency: 8,
    runOne: async () => ({ state: "deferred" }),
  })
  assert.equal(out.results.length, 40, "N bounds the rate, not the volume")
  assert.equal(
    out.max_in_flight,
    1,
    "one origin can only ever have one job in flight",
  )
})

test("two jobs on the same origin are never in flight together", async () => {
  const list = jobs([
    ["a", "https://same.test"],
    ["b", "https://same.test"],
    ["c", "https://same.test"],
    ["d", "https://other.test"],
  ])
  const live = new Map()
  let violation = null
  const out = await runPool({
    jobs: list,
    concurrency: 4,
    runOne: async (j) => {
      const n = (live.get(j.origin) ?? 0) + 1
      live.set(j.origin, n)
      if (n > 1) violation = j.origin
      await sleep(10)
      live.set(j.origin, live.get(j.origin) - 1)
      return { state: "deferred" }
    },
  })
  assert.equal(violation, null, `two jobs were in flight on ${violation}`)
  assert.equal(out.results.length, 4)
  assert.equal(
    out.max_in_flight,
    2,
    "three same-origin jobs plus one other gives an observed max of 2",
  )
})

test("distinct origins do run concurrently — the pool is not a queue", async () => {
  const list = jobs(
    Array.from({ length: 8 }, (_, i) => [`s${i}`, `https://o${i}.test`]),
  )
  const out = await runPool({
    jobs: list,
    concurrency: 8,
    runOne: async () => {
      await sleep(25)
      return { state: "deferred" }
    },
  })
  assert.equal(
    out.max_in_flight,
    8,
    "eight origins at concurrency 8 must observe eight in flight, or the " +
      "exclusion key is serialising work it should not",
  )
})

test("jobs with no origin are serialised against each other, not let through", async () => {
  // "Unknown" must be the cautious end: a job whose origin we do not know is a
  // job whose shared state we cannot reason about.
  const list = jobs([
    ["a", null],
    ["b", null],
    ["c", null],
  ])
  let concurrent = 0
  let max = 0
  const out = await runPool({
    jobs: list,
    concurrency: 3,
    runOne: async () => {
      concurrent += 1
      max = Math.max(max, concurrent)
      await sleep(10)
      concurrent -= 1
      return { state: "deferred" }
    },
  })
  assert.equal(max, 1)
  assert.equal(out.results.length, 3)
})

test("shouldStop halts NEW work and leaves the rest countable", async () => {
  const list = jobs(
    Array.from({ length: 10 }, (_, i) => [`s${i}`, `https://o${i}.test`]),
  )
  let done = 0
  const skipped = []
  const out = await runPool({
    jobs: list,
    concurrency: 1,
    shouldStop: () => (done >= 3 ? "STOP is set" : null),
    onSkip: (j) => skipped.push(j.slug),
    runOne: async () => {
      done += 1
      return { state: "deferred" }
    },
  })
  assert.equal(out.results.length, 3)
  assert.equal(out.stopped_reason, "STOP is set")
  assert.equal(
    skipped.length,
    7,
    "a job the run never reached must be handed back by name — the largest " +
      "loss bucket in a degraded run cannot be an absence",
  )
})

test("a stop mid-flight lets the in-flight job finish", async () => {
  // Killing a job mid-fill would leave exactly the ambiguous half-states the
  // ledger exists to avoid.
  const list = jobs([
    ["a", "https://o1.test"],
    ["b", "https://o2.test"],
  ])
  let stop = false
  let finished = 0
  await runPool({
    jobs: list,
    concurrency: 1,
    shouldStop: () => (stop ? "stopping" : null),
    runOne: async () => {
      stop = true
      await sleep(15)
      finished += 1
      return { state: "deferred" }
    },
  })
  assert.equal(finished, 1)
})

test("originCount is the real ceiling on concurrency, and is reported", () => {
  assert.equal(
    originCount(
      jobs([
        ["a", "https://x.test"],
        ["b", "https://x.test"],
        ["c", "https://y.test"],
      ]),
    ),
    2,
  )
  assert.equal(originCount([]), 0)
})

test("concurrency must be a positive integer", async () => {
  await assert.rejects(
    () => runPool({ jobs: [], concurrency: 0, runOne: async () => ({}) }),
    /concurrency must be >= 1/,
  )
})
