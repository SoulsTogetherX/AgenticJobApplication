// Phase 4.8 — the performance gate's rules.
//
// Driven with SYNTHETIC results rather than by running the harness, so each
// rule is exercised in both directions in milliseconds. The harness itself is
// covered by tests/dev/bench-runner.test.mjs, and the gate's ability to go red
// against the REAL tree was proved by mutation and recorded in
// docs/measurements.md M9 — that proof is not repeatable in a unit test
// without editing product files, which a test must not do.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import {
  RULES,
  evaluate,
  parseBudget,
  acrossRuns,
  toBaseline,
  BASELINE_PATH,
} from "../../.github/workflows/perf-gate.mjs"

const run = (columns, extra = {}) => ({
  concurrency_observed: 8,
  concurrency_requested: 8,
  apps_completed: 50,
  ledger: {
    durable_rows: 25,
    reached_authorized: 25,
    rows_in_state_attempted: 0,
    ok: true,
  },
  columns: Object.fromEntries(
    Object.entries(columns).map(([k, v]) => [
      k,
      { value: v, method: "measured", statistic: "mean" },
    ]),
  ),
  ...extra,
})

const CLEAN = {
  model_turns_per_app: 0,
  sleep_ms_per_app: 450,
  round_trips_per_app: 60,
  defer_rate: 0.5,
  wall_ms_p95: 1500,
}
const result = (columns, extra = {}) => ({
  runs: 1,
  concurrency_ok: true,
  per_run: [run(columns, extra)],
})
const BASE = { columns: { ...CLEAN } }

test("an unchanged run produces no findings", () => {
  assert.deepEqual(evaluate(result(CLEAN), BASE), [])
})

test("model_turns is HARD and no budget line clears it", () => {
  const f = evaluate(
    result({ ...CLEAN, model_turns_per_app: 1 }),
    BASE,
    // Every plausible spelling somebody might reach for.
    { model_turns: 99, model_turns_per_app: 99 },
  )
  const hit = f.find((x) => x.key === "model_turns_per_app")
  assert.equal(hit.severity, "fail")
  assert.equal(
    hit.budget_applied,
    null,
    "there is no override and there must never be one",
  )
  // The rule itself declares that it is not overridable, so a future edit that
  // adds a budget key has to change this line too.
  assert.equal(
    RULES.find((r) => r.key === "model_turns_per_app").overridable,
    false,
  )
})

test("an UNMEASURED model_turns column fails the hard gate rather than clearing it", () => {
  const r = result(CLEAN)
  r.per_run[0].columns.model_turns_per_app = {
    value: null,
    method: "unmeasured",
    statistic: null,
    note: "counter not installed",
  }
  const f = evaluate(r, BASE)
  assert.ok(
    f.some((x) => x.key === "model_turns_per_app" && x.severity === "fail"),
    "a column nobody measured cannot clear a gate — that is how a broken " +
      "instrument becomes a permanent green light",
  )
})

test("sleep_ms fails past +10% and a matching budget line clears it", () => {
  const hot = result({ ...CLEAN, sleep_ms_per_app: 650 })
  assert.ok(
    evaluate(hot, BASE).some(
      (f) => f.key === "sleep_ms_per_app" && f.severity === "fail",
    ),
  )
  // Within the 10% allowance: not a finding at all.
  assert.deepEqual(
    evaluate(result({ ...CLEAN, sleep_ms_per_app: 490 }), BASE).filter(
      (f) => f.key === "sleep_ms_per_app",
    ),
    [],
  )
  assert.deepEqual(
    evaluate(hot, BASE, { sleep_ms: 200 }).filter(
      (f) => f.key === "sleep_ms_per_app",
    ),
    [],
  )
})

test("defer_rate fails past +2pp, and is NOT overridable", () => {
  assert.deepEqual(
    evaluate(result({ ...CLEAN, defer_rate: 0.52 }), BASE).filter(
      (f) => f.key === "defer_rate",
    ),
    [],
    "exactly 2pp is within the allowance",
  )
  const f = evaluate(result({ ...CLEAN, defer_rate: 0.55 }), BASE, {
    defer_rate: 1,
  })
  assert.ok(f.some((x) => x.key === "defer_rate" && x.severity === "fail"))
})

test("wall_ms_p95 is WARN, never FAIL", () => {
  const f = evaluate(result({ ...CLEAN, wall_ms_p95: 9999 }), BASE)
  const hit = f.find((x) => x.key === "wall_ms_p95")
  assert.equal(hit.severity, "warn")
  assert.equal(
    f.filter((x) => x.severity === "fail").length,
    0,
    "the noisiest column must not be able to turn the build red on its own",
  )
})

test("the ledger invariant is the CORRECTED one — deferrals are not attempts", () => {
  // 50 applications, 25 submitted, 25 deferred before an attempted row was
  // ever written. Revision 1's `durable_attempted_rows != apps_started` would
  // have failed this healthy run; the corrected form passes it.
  assert.deepEqual(evaluate(result(CLEAN), BASE), [])

  // A row still in 'attempted' at run end IS a failure: a click went out and
  // nothing resolved it.
  const orphaned = result(CLEAN)
  orphaned.per_run[0].ledger = {
    durable_rows: 25,
    reached_authorized: 25,
    rows_in_state_attempted: 1,
    ok: false,
  }
  const f = evaluate(orphaned, BASE)
  assert.ok(f.some((x) => x.key === "ledger" && x.severity === "fail"))
  assert.match(
    f.find((x) => x.key === "ledger").message,
    /still in 'attempted'/,
  )
})

test("a run that missed its concurrency fails before any column is compared", () => {
  const r = result(CLEAN)
  r.concurrency_ok = false
  r.per_run[0].concurrency_observed = 1
  const f = evaluate(r, BASE)
  const hit = f.find((x) => x.key === "concurrency")
  assert.equal(hit.severity, "fail")
  assert.match(hit.message, /a label the run did not run at/)
})

test("a missing baseline warns rather than passing silently", () => {
  const f = evaluate(result(CLEAN), { columns: {} })
  assert.equal(f.length, RULES.length)
  for (const x of f) {
    assert.equal(x.severity, "warn")
    assert.match(x.message, /no baseline/)
  }
})

test("perf-budget lines are parsed off a PR body, and nothing else is", () => {
  assert.deepEqual(
    parseBudget("Fixes the thing.\n\nperf-budget: sleep_ms +150\n"),
    { sleep_ms: 150 },
  )
  assert.deepEqual(
    parseBudget("perf-budget: sleep_ms +150\nperf-budget: round_trips +2"),
    { sleep_ms: 150, round_trips: 2 },
  )
  assert.deepEqual(parseBudget("we should budget sleep_ms soon"), {})
  assert.deepEqual(parseBudget(null), {})
})

test("every gated column names the statistic it compares on", () => {
  for (const rule of RULES) {
    assert.ok(
      rule.statistic,
      `${rule.key} does not say what statistic it compares`,
    )
    assert.ok(rule.why, `${rule.key} does not say why it is gated`)
  }
})

test("acrossRuns takes the median, so one noisy run cannot fail the build", () => {
  const rule = RULES.find((r) => r.key === "wall_ms_p95")
  const runs = [
    run({ ...CLEAN, wall_ms_p95: 1400 }),
    run({ ...CLEAN, wall_ms_p95: 9999 }),
    run({ ...CLEAN, wall_ms_p95: 1500 }),
  ]
  assert.equal(acrossRuns(runs, rule), 1500)
})

test("the committed baseline is real, complete, and carries its command", () => {
  const b = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"))
  for (const rule of RULES) {
    assert.ok(rule.key in b.columns, `baseline has no ${rule.key}`)
    assert.equal(
      b.statistic[rule.key],
      rule.statistic,
      `the baseline's statistic for ${rule.key} has drifted from the rule's`,
    )
  }
  assert.match(b.command, /bench-runner\.mjs/)
  assert.ok(
    b.provenance?.sha,
    "a number with no sha cannot be compared to anything",
  )
})

test("toBaseline records the statistic beside every number", () => {
  const b = toBaseline(result(CLEAN), { sha: "deadbee" })
  assert.equal(b.columns.sleep_ms_per_app, 450)
  assert.equal(
    b.statistic.wall_ms_p95,
    "p95, compared on the median of the runs",
  )
  assert.equal(b.provenance.sha, "deadbee")
})
