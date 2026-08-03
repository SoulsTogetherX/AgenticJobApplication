#!/usr/bin/env node
// The Phase 4.8 performance gate.
//
// Runs bench-runner against the loopback fixture, compares the columns against
// a committed baseline, and fails the build on a regression.
//
// Usage:
//   node .github/workflows/perf-gate.mjs                 # check against the baseline
//   node .github/workflows/perf-gate.mjs --update        # write a new baseline
//   node .github/workflows/perf-gate.mjs --json
//
// ===========================================================================
// WHY EACH RULE IS THE STRENGTH IT IS
// ===========================================================================
//
// The rules are not uniformly strict, and the differences are deliberate.
//
//   HARD, NO OVERRIDE — model_turns. Green tier is DEFINED as removing the
//   model from the path, so a model turn on it is not a regression in degree,
//   it is the property being gone. There is no budget line for this and there
//   must never be one: an override here would let the single change this whole
//   plan exists to prevent — a model reading an attacker-controlled page in
//   the same context as the fact base — land behind a one-line PR annotation.
//   4.7's harness makes the column OBSERVED so the rule can actually fire;
//   revision 1's derived column could not.
//
//   BUDGET-OVERRIDABLE — sleep_ms and round_trips. Both are real costs and
//   both sometimes have to rise for a real reason (a board that genuinely
//   needs a settle, a page that genuinely needs a second read). The override
//   is a line in the PR body, so the rise is a thing somebody wrote down
//   rather than a thing that happened.
//
//   HARD BUT CHEAP — the ledger invariant. Durable rows must equal the
//   applications that reached the point of clicking, and nothing may be left
//   in 'attempted'. Revision 1 of the plan wrote this as
//   `durable_attempted_rows != apps_started`, which contradicts its own state
//   machine: deferrals exit BEFORE the attempted row is written, and there are
//   14 pre-attempt defer kinds, so that gate would have been red on every run
//   by construction. Within a week it would have been passing with an override
//   line — the exact failure the plan reasons about correctly elsewhere and
//   then walked into. The corrected form is below.
//
//   WARN ONLY — wall_ms_p95. It is the noisiest column by far and the one most
//   affected by whatever else the machine is doing. A hard rule on it would
//   teach people to ignore red, which costs more than the regressions it would
//   catch.
//
// EVERY GATED COLUMN NAMES THE STATISTIC IT COMPARES ON, because "sleep went
// up" is not a claim until you know whether that is a mean, a min or a p50.
// Revision 1 left this unstated for all five.
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const RUNNER = path.join(ROOT, "scripts", "dev", "bench-runner.mjs")
export const BASELINE_PATH = path.join(ROOT, "docs", "perf-baseline.json")

// The gate's own command. Fixed here rather than passed in, because a gate
// whose workload is a parameter is a gate whose baseline means nothing.
export const GATE_ARGS = [
  "--apps",
  "50",
  "--concurrency",
  "8",
  // A MIX, and this is the one place the plan's literal command is widened.
  // `--board greenhouse` alone gives defer_rate = 1.0 by construction (that
  // fixture carries a consent tickbox), so submitted throughput is
  // structurally zero and the defer-rate rule can never move. A gate whose
  // columns cannot move is not a gate.
  "--board",
  "greenhouse,honest-greenhouse",
  "--runs",
  "3",
  "--json",
]

/**
 * The rules, as data.
 *
 * `pick` reads the number out of a run; `limit` turns a baseline into the
 * threshold; `bad` decides. Written this way so the rule set is readable in
 * one screen and so a test can drive each rule with a synthetic pair rather
 * than by regressing the real tree.
 */
export const RULES = [
  {
    key: "model_turns_per_app",
    statistic: "mean over the run",
    severity: "fail",
    overridable: false,
    pick: (r) => r.columns.model_turns_per_app.value,
    limit: () => 0,
    bad: (v, limit) => v === null || v > limit,
    why:
      "green tier is DEFINED as removing the model from the path. There is no " +
      "budget line for this and there must never be one. A null here means the " +
      "counter was not installed, which is also a failure — an unmeasured " +
      "column cannot clear a hard gate.",
  },
  {
    key: "sleep_ms_per_app",
    statistic: "mean",
    severity: "fail",
    overridable: "sleep_ms",
    pick: (r) => r.columns.sleep_ms_per_app.value,
    limit: (base, budget) => base * 1.1 + (budget ?? 0),
    bad: (v, limit) => v > limit,
    why: "unconditional sleep is the largest avoidable cost this project has measured",
  },
  {
    key: "round_trips_per_app",
    statistic: "mean",
    severity: "fail",
    overridable: "round_trips",
    pick: (r) => r.columns.round_trips_per_app.value,
    limit: (base, budget) => base + (budget ?? 0),
    bad: (v, limit) => v > limit,
    why: "a round trip is tens to hundreds of milliseconds and they compound with N",
  },
  {
    key: "defer_rate",
    statistic: "mean",
    severity: "fail",
    overridable: false,
    pick: (r) => r.columns.defer_rate.value,
    limit: (base) => base + 0.02,
    bad: (v, limit) => v > limit,
    why:
      "a rising defer rate is the machine understanding LESS. It is not " +
      "overridable because the sanctioned ways to move it are all in the other " +
      "direction: an adapter, a probed option list, or a banked answer.",
  },
  {
    key: "wall_ms_p95",
    statistic: "p95, compared on the median of the runs",
    severity: "warn",
    overridable: false,
    pick: (r) => r.columns.wall_ms_p95.value,
    limit: (base) => base * 1.25,
    bad: (v, limit) => v > limit,
    why: "the noisiest column; hard-failing on it teaches people to ignore red",
  },
]

/** `perf-budget: sleep_ms +150` in a PR body. One line, per column. */
export function parseBudget(body) {
  const out = {}
  if (!body) return out
  for (const m of String(body).matchAll(
    /perf-budget:\s*([a-z_]+)\s*\+\s*(\d+(?:\.\d+)?)/gi,
  ))
    out[m[1]] = Number(m[2])
  return out
}

/** The value a rule compares on, across N runs. Median: --runs 3 exists for this. */
export function acrossRuns(runs, rule) {
  const xs = runs
    .map(rule.pick)
    .filter((v) => v !== null && v !== undefined)
    .sort((a, b) => a - b)
  if (!xs.length) return null
  return xs[Math.floor((xs.length - 1) / 2)]
}

export function evaluate(result, baseline, budget = {}) {
  const runs = result.per_run
  const findings = []

  if (!result.concurrency_ok)
    findings.push({
      key: "concurrency",
      severity: "fail",
      value: runs[0]?.concurrency_observed,
      limit: runs[0]?.concurrency_requested,
      message:
        "observed max-in-flight did not reach the requested concurrency — every " +
        "throughput number in this run is reported under a label the run did not " +
        "run at, so none of them may be compared or banked",
    })

  for (const run of runs) {
    if (run.ledger && !run.ledger.ok)
      findings.push({
        key: "ledger",
        severity: "fail",
        value: `durable_rows=${run.ledger.durable_rows} reached_authorized=${run.ledger.reached_authorized} attempted=${run.ledger.rows_in_state_attempted}`,
        limit: "durable_rows === reached_authorized AND attempted === 0",
        message:
          run.ledger.rows_in_state_attempted > 0
            ? "a job is still in 'attempted' at run end — a click was issued and " +
              "nothing ever said what happened next"
            : "the durable rows do not account for the applications that reached " +
              "the point of clicking",
      })
  }

  for (const rule of RULES) {
    const value = acrossRuns(runs, rule)
    const base = baseline?.columns?.[rule.key]
    if (base === undefined || base === null) {
      findings.push({
        key: rule.key,
        severity: "warn",
        value,
        limit: null,
        message: `no baseline for ${rule.key} — nothing to compare against (run --update)`,
      })
      continue
    }
    const allowance = rule.overridable ? budget[rule.overridable] : undefined
    const limit = rule.limit(base, allowance)
    if (rule.bad(value, limit))
      findings.push({
        key: rule.key,
        severity: rule.severity,
        value,
        baseline: base,
        limit,
        statistic: rule.statistic,
        budget_applied: allowance ?? null,
        message:
          `${rule.key} ${value} exceeds ${limit} (baseline ${base}, ${rule.statistic})` +
          (rule.overridable && allowance === undefined
            ? ` — add \`perf-budget: ${rule.overridable} +N\` to the PR body if this is intended`
            : "") +
          `\n    ${rule.why}`,
      })
  }
  return findings
}

/** The shape written to docs/perf-baseline.json. */
export function toBaseline(result, provenance) {
  const columns = {}
  for (const rule of RULES) columns[rule.key] = acrossRuns(result.per_run, rule)
  return {
    taken_at: new Date().toISOString(),
    command: `node scripts/dev/bench-runner.mjs ${GATE_ARGS.join(" ")}`,
    runs: result.runs,
    statistic: Object.fromEntries(RULES.map((r) => [r.key, r.statistic])),
    columns,
    provenance,
  }
}

/**
 * Run the harness, and fail with the harness's own message rather than a
 * stack trace.
 *
 * The commonest non-zero exit is the dirty-tree refusal, which is not a bug —
 * it is the harness declining to produce a number that cannot be compared. In
 * CI it never fires (a checkout is committed); locally it fires constantly,
 * and a wall of `execFileSync` internals in place of one sentence is how a
 * correct refusal gets mistaken for a broken gate and worked around.
 *
 * `--allow-dirty` is passed through for exactly one use: proving the gate can
 * go red by mutating a measured file. Anything it prints under that flag is
 * evidence about the GATE, never a number to bank.
 */
function runBench(extra = []) {
  try {
    return JSON.parse(
      execFileSync(process.execPath, [RUNNER, ...GATE_ARGS, ...extra], {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }),
    )
  } catch (e) {
    const said = String(e?.stderr ?? "").trim()
    console.error(said || `bench-runner failed: ${e?.message ?? e}`)
    process.exit(e?.status ?? 1)
  }
}

function prBody() {
  if (process.env.PR_BODY) return process.env.PR_BODY
  try {
    const ev = JSON.parse(
      fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"),
    )
    return ev?.pull_request?.body ?? ""
  } catch {
    return ""
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const passthrough = argv.includes("--allow-dirty") ? ["--allow-dirty"] : []
  const result = runBench(passthrough)

  if (argv.includes("--update")) {
    const baseline = toBaseline(result, result.provenance)
    fs.writeFileSync(
      BASELINE_PATH,
      JSON.stringify(baseline, null, 2) + "\n",
      "utf8",
    )
    console.log(`wrote ${path.relative(ROOT, BASELINE_PATH)}`)
    console.log(JSON.stringify(baseline.columns, null, 2))
    return
  }

  const baseline = fs.existsSync(BASELINE_PATH)
    ? JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"))
    : null
  const budget = parseBudget(prBody())
  const findings = evaluate(result, baseline, budget)

  if (argv.includes("--json")) {
    console.log(JSON.stringify({ findings, result, baseline }, null, 2))
  } else {
    const r = result.per_run[0]
    console.log(
      `perf-gate — ${r.apps_completed} apps at concurrency ${r.concurrency_observed}, ` +
        `${result.runs} runs, sha ${result.provenance?.sha}`,
    )
    for (const rule of RULES)
      console.log(
        `  ${rule.key.padEnd(22)} ${String(acrossRuns(result.per_run, rule)).padEnd(12)} ` +
          `baseline ${baseline?.columns?.[rule.key] ?? "—"}  (${rule.statistic})`,
      )
    if (Object.keys(budget).length)
      console.log(`  budget from PR body: ${JSON.stringify(budget)}`)
    for (const f of findings)
      console.log(
        `${f.severity === "fail" ? "::error::" : "::warning::"}${f.key}: ${f.message}`,
      )
    if (!findings.length) console.log("  no findings")
  }
  if (findings.some((f) => f.severity === "fail")) process.exitCode = 1
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) await main()
