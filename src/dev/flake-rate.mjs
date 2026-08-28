#!/usr/bin/env node
// flake-rate.mjs — turn "that test is flaky" into a number with an interval.
//
// WHY THIS EXISTS. Two tests were reported as intermittent with "3 failures in
// 7 runs" and "1 failure in 3 runs". Those are the right instinct and the wrong
// evidence: 1 failure in 3 runs is consistent with a true failure rate
// anywhere from 6.1% to 79.2% (Wilson, 95%), so a fix that removes four fifths
// of the flakiness and a fix that does nothing look the same from the outside.
// That number is asserted in tests/dev/flake-rate.test.mjs rather than quoted
// from memory. Two flaky tests is the point where a red build gets
// re-run instead of read, and a gate nobody reads is a gate that is gone — so
// the rate has to be measurable before and after, like any other number in
// docs/measurements.md.
//
// WHAT IT REPORTS
//   - failures / runs, and the WILSON 95% score interval on that proportion.
//     Wilson, not the textbook normal approximation, because at 0 failures in
//     20 runs the normal interval is [0, 0] — it claims certainty from the
//     absence of evidence, which is the exact error this file exists to stop.
//   - the runs needed to distinguish the observed rate from zero, so "we ran it
//     again and it passed" can be priced.
//   - per-run wall time, so a fix that trades flakiness for slowness is visible.
//
// CONCURRENCY IS THE POINT, NOT A SETTING. Both reported flakes are contention:
// `node --test` runs files in parallel, and each of these spawns its own
// subprocesses (four SQLite writers; one headless Chrome per PDF). So the rate
// is meaningless without saying what else was running. --load N runs N copies
// of the target at once and reports the rate per load level, which is what
// turns "flaky on my machine" into "fails above N concurrent writers".
//
//   node src/dev/flake-rate.mjs tests/lib/db.test.mjs --runs 20
//   node src/dev/flake-rate.mjs tests/lib/db.test.mjs --runs 12 --load 4
//   node src/dev/flake-rate.mjs tests/documents/render-pdf.test.mjs --runs 6 --json
//
// It runs tests and nothing else: no network, no browser of its own, no writes
// outside the temp directories the tests themselves make.
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { positionals } from "../lib/args.mjs"

// Flags that take a VALUE, so positionals() never reads one as the
// positional. `flake-rate.mjs --runs 20 t.test.mjs` ran the target "20".
const VALUE_FLAGS = ["--runs", "--load", "--alongside"]

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

/**
 * Wilson score interval for a binomial proportion.
 *
 * The normal approximation is wrong exactly where this tool is used most —
 * small n, proportions near 0 — and its failure mode is to report a
 * zero-width interval, i.e. false certainty. Wilson stays honest there.
 */
export function wilson(failures, runs, z = 1.96) {
  if (runs === 0) return { low: 0, high: 1, point: 0 }
  const p = failures / runs
  const d = 1 + (z * z) / runs
  const centre = p + (z * z) / (2 * runs)
  const spread =
    z * Math.sqrt((p * (1 - p)) / runs + (z * z) / (4 * runs * runs))
  return {
    point: round(p),
    low: round(Math.max(0, (centre - spread) / d)),
    high: round(Math.min(1, (centre + spread) / d)),
  }
}

/**
 * How many consecutive passes are needed before "it passed on the re-run" is
 * evidence rather than noise, at a given true failure rate.
 *
 * ln(alpha) / ln(1 - rate): the runs after which the chance of seeing no
 * failure, if the rate really is `rate`, drops below alpha.
 */
export function runsToRuleOut(rate, alpha = 0.05) {
  if (rate <= 0) return Infinity
  if (rate >= 1) return 1
  return Math.ceil(Math.log(alpha) / Math.log(1 - rate))
}

const round = (x) => Math.round(x * 1000) / 1000

function runOnce(target, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now()
    // TAP is FORCED, not assumed. Node 24 defaults to the `spec` reporter even
    // when stdout is a pipe, so the `not ok` parser below silently matched
    // nothing and every failure was attributed to "<file-level>" — a rate with
    // no test name, which is half a measurement. Measured 2026-08-01: a 41.7%
    // flake rate that could not be attributed until this line existed.
    const p = spawn(
      process.execPath,
      ["--test", "--test-reporter=tap", target],
      {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    let out = ""
    let err = ""
    p.stdout.on("data", (d) => (out += d))
    p.stderr.on("data", (d) => (err += d))
    const timer = setTimeout(() => {
      p.kill("SIGKILL")
    }, timeoutMs)
    p.on("close", (code, signal) => {
      clearTimeout(timer)
      const text = out + err
      // The failing subtest names, so a rate is attributable to a test rather
      // than to a file. `not ok N - name` is TAP; the reporter also prints a
      // "✖ name" line.
      // Leading whitespace is allowed because TAP indents subtests, and an
      // anchored `^not ok` misses every nested failure.
      const tap = [...text.matchAll(/^[ \t]*not ok \d+ - (.+)$/gm)].map((m) =>
        m[1].trim(),
      )
      // Fallback for the `spec` reporter, in case the forced reporter above is
      // ever dropped or Node changes the flag. Deduped: spec prints a failing
      // name twice, inline and again in the trailing summary.
      const spec = [
        ...new Set(
          [...text.matchAll(/^[ \t]*✖ (.+?) \(\d[\d.]*ms\)$/gm)].map((m) =>
            m[1].trim(),
          ),
        ),
      ]
      const failing = tap.length ? tap : spec
      const cause = /SQLITE_BUSY|database is locked/i.test(text)
        ? "SQLITE_BUSY"
        : /timed out|ETIMEDOUT/i.test(text)
          ? "timeout"
          : null
      resolve({
        ok: code === 0 && !signal,
        code,
        signal,
        ms: performance.now() - t0,
        failing,
        cause,
        tail: code === 0 ? null : text.slice(-1200),
      })
    })
  })
}

/**
 * @param {string} target test file or directory
 * @param {{runs?: number, load?: number, timeoutMs?: number,
 *          onRun?: (r: object, i: number) => void}} opts
 */
export async function measureFlakeRate(target, opts = {}) {
  const {
    runs = 10,
    load = 1,
    timeoutMs = 180000,
    alongside = [],
    onRun,
  } = opts
  const results = []
  for (let i = 0; i < runs; i++) {
    // At load > 1 the target competes with N-1 copies of itself. All N are
    // recorded: a batch where one of four fails is one failure in four runs,
    // not one in one, and conflating those overstates the rate fourfold.
    //
    // `alongside` is the OTHER kind of contention, and for both known flakes
    // it is the one that matters: the target competes with a DIFFERENT test
    // file, exactly as it does under `node --test`, which runs files in
    // parallel. Those runs are started and awaited but NOT counted — they are
    // the load, not the sample.
    const competitors = alongside.map((a) => runOnce(a, { timeoutMs }))
    const batch = await Promise.all(
      Array.from({ length: load }, () => runOnce(target, { timeoutMs })),
    )
    for (const r of batch) {
      results.push(r)
      onRun?.(r, results.length)
    }
    await Promise.all(competitors)
  }
  const failures = results.filter((r) => !r.ok)
  const interval = wilson(failures.length, results.length)
  const byTest = new Map()
  for (const f of failures) {
    for (const name of f.failing.length ? f.failing : ["<file-level>"]) {
      byTest.set(name, (byTest.get(name) ?? 0) + 1)
    }
  }
  const times = results.map((r) => r.ms).sort((a, b) => a - b)
  return {
    target,
    load,
    runs: results.length,
    failures: failures.length,
    rate: interval,
    runs_to_rule_out_at_95: runsToRuleOut(interval.point),
    // The honest upper bound: even a clean sweep only bounds the rate.
    max_rate_consistent_with_this_sample: interval.high,
    causes: [...new Set(failures.map((f) => f.cause).filter(Boolean))],
    failing_tests: [...byTest.entries()].map(([name, n]) => ({ name, n })),
    ms: {
      min: Math.round(times[0] ?? 0),
      median: Math.round(times[(times.length - 1) >> 1] ?? 0),
      max: Math.round(times[times.length - 1] ?? 0),
    },
    sample_tails: failures.slice(0, 2).map((f) => f.tail),
  }
}

const USAGE = `flake-rate.mjs — measure how often a test actually fails

  node src/dev/flake-rate.mjs <test file or dir> [--runs N] [--load N] [--json]

  --runs N   batches to run (default 10)
  --load N   copies of the target to run CONCURRENTLY per batch (default 1).
             Both known flakes are contention, so the rate is only meaningful
             beside the load it was measured at.
  --json     the full record

Reports failures/runs with a Wilson 95% interval, because "1 failure in 3 runs"
is consistent with a true rate anywhere from 1% to 91% and cannot be used to
judge a fix.`

async function main() {
  const argv = process.argv.slice(2)
  if (!argv.length || argv.includes("--help")) {
    process.stdout.write(USAGE + "\n")
    return
  }
  const target = positionals(argv, VALUE_FLAGS)[0]
  const num = (flag, dflt) => {
    const i = argv.indexOf(flag)
    return i === -1 ? dflt : Number(argv[i + 1])
  }
  const json = argv.includes("--json")
  const runs = num("--runs", 10)
  const load = num("--load", 1)
  const alongside = argv
    .map((a, i) => (a === "--alongside" ? argv[i + 1] : null))
    .filter(Boolean)

  const r = await measureFlakeRate(target, {
    runs,
    load,
    alongside,
    onRun: (res, i) => {
      if (!json) {
        process.stderr.write(
          `  run ${String(i).padStart(3)}  ${res.ok ? "pass" : "FAIL"}  ` +
            `${Math.round(res.ms)}ms${res.cause ? "  " + res.cause : ""}\n`,
        )
      }
    },
  })

  if (json) {
    process.stdout.write(JSON.stringify(r, null, 2) + "\n")
    return
  }
  const L = (s) => process.stdout.write(s + "\n")
  L("")
  L(
    `flake rate — ${r.target}  (load=${r.load}` +
      (alongside.length ? `, alongside ${alongside.join(" + ")}` : "") +
      ")",
  )
  L("-".repeat(72))
  L(`  failures        ${r.failures} / ${r.runs}`)
  L(
    `  rate            ${(r.rate.point * 100).toFixed(1)}%  ` +
      `[95% CI ${(r.rate.low * 100).toFixed(1)}% – ${(r.rate.high * 100).toFixed(1)}%]`,
  )
  L(
    `  a clean re-run  proves nothing until ${
      Number.isFinite(r.runs_to_rule_out_at_95)
        ? r.runs_to_rule_out_at_95 + " consecutive passes"
        : "n/a (no failures observed)"
    }`,
  )
  L(
    `  even at 0/${r.runs}, the true rate could still be as high as ` +
      `${(r.max_rate_consistent_with_this_sample * 100).toFixed(1)}%`,
  )
  L(`  wall ms         min ${r.ms.min}  median ${r.ms.median}  max ${r.ms.max}`)
  if (r.causes.length) L(`  causes          ${r.causes.join(", ")}`)
  for (const f of r.failing_tests) L(`  failed ${f.n}x     ${f.name}`)
  L("")
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) await main()
