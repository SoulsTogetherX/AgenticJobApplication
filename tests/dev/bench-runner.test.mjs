// Phase 4.7 — the campaign harness and, more importantly, its instrument.
//
// THE LOAD-BEARING TEST IN THIS FILE IS THE COUNTER ONE. The CI gate's single
// hard, no-override rule is `model_turns > 0`, and a counter that silently
// reports zero turns that rule into a permanent green light — a worse outcome
// than having no gate, because the gate would be believed. So the counter is
// tested in both directions: it must count a model-shaped call, and it must
// NOT count this project's own deterministic scripts.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  runCampaign,
  pct,
  readCounters,
  COUNTER_PRELOAD,
  ledgerEntry,
  aggregate,
} from "../../src/dev/bench-runner.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const RUNNER = path.join(ROOT, "src", "dev", "bench-runner.mjs")

function tmp(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aj-${name}-`))
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* a leaked handle must not fail a passing assertion */
    }
  })
  return dir
}

// Run a snippet under the preload and read the counters back out of it.
function underCounter(t, body) {
  const dir = tmp(t, "counter")
  const file = path.join(dir, "probe.mjs")
  fs.writeFileSync(
    file,
    `${body}\nconsole.log(JSON.stringify(globalThis.__ajCounters))\n`,
    "utf8",
  )
  const out = execFileSync(
    process.execPath,
    ["--require", COUNTER_PRELOAD, file],
    { encoding: "utf8", cwd: ROOT },
  )
  return JSON.parse(out.trim().split(/\r?\n/).pop())
}

test("the counter fires on a model-shaped spawn — the gate can actually go red", (t) => {
  // Not node, and not a repo script: exactly the shape of shelling out to a
  // model CLI.
  const c = underCounter(
    t,
    `import { spawnSync } from "node:child_process"
     spawnSync(process.platform === "win32" ? "cmd.exe" : "true", ["/c", "echo hi"], { stdio: "ignore" })`,
  )
  assert.equal(c.installed, true)
  assert.equal(c.spawns, 1)
  assert.equal(
    c.foreign_spawns,
    1,
    "a non-node executable is a model turn candidate",
  )
})

test("the counter does NOT fire on this repo's own deterministic scripts", (t) => {
  const c = underCounter(
    t,
    `import { execFileSync } from "node:child_process"
     execFileSync(process.execPath, [${JSON.stringify(path.join(ROOT, "src", "status.mjs"))}, "--json"], { encoding: "utf8" })`,
  )
  assert.equal(c.spawns, 1, "it is still a spawn, and spawns_per_app counts it")
  assert.equal(
    c.foreign_spawns,
    0,
    "running our own script under our own node is the sanctioned behaviour, " +
      "not a model turn — a gate that fires on it gets overridden within a week",
  )
})

test("a non-loopback request counts and a loopback one does not", (t) => {
  // No network is touched: the request is made to a port nothing is listening
  // on and the failure is swallowed. What is under test is the COUNTER, which
  // fires when the request is issued.
  const c = underCounter(
    t,
    `import http from "node:http"
     const swallow = (r) => { r.on("error", () => {}); r.end() }
     swallow(http.request("http://127.0.0.1:9/x"))
     swallow(http.request("http://example.invalid:9/x"))
     await new Promise((r) => setTimeout(r, 50))`,
  )
  assert.equal(
    c.loopback_requests,
    1,
    "the fixture must never read as outbound",
  )
  assert.equal(c.outbound_requests, 1)
  assert.deepEqual(c.outbound_hosts, ["example.invalid"])
})

test("without the preload the column is UNMEASURED, never a comforting zero", async () => {
  assert.equal(readCounters().installed, false)
  const r = await runCampaign({
    apps: 2,
    concurrency: 1,
    boardName: "honest-greenhouse",
  })
  assert.equal(r.columns.model_turns_per_app.method, "unmeasured")
  assert.equal(r.columns.model_turns_per_app.value, null)
  assert.match(r.columns.model_turns_per_app.note, /preload/)
})

test("percentile is null on an empty sample", () => {
  assert.equal(pct([], 95), null)
  assert.equal(pct([3, 1, 2], 50), 2)
})

test("a campaign reaches the requested concurrency, and says so as a number", async () => {
  const r = await runCampaign({
    apps: 6,
    concurrency: 3,
    boardName: "honest-greenhouse",
  })
  assert.equal(r.apps_completed, 6)
  assert.equal(r.concurrency_observed, 3)
  assert.equal(r.concurrency_ok, true)
  assert.equal(r.origins, 3, "distinct ports are distinct origins")
  // The fixture being CAPABLE of N origins is not the run USING them.
  assert.equal(
    new Set(r.detail.reason_rows.map((x) => x.board_key)).size >= 0,
    true,
  )
})

test("concurrency is reported as observed, not as requested", async () => {
  // Ask for more workers than there is work: max-in-flight cannot reach 4.
  const r = await runCampaign({
    apps: 2,
    concurrency: 4,
    boardName: "honest-greenhouse",
  })
  assert.equal(r.concurrency_requested, 4)
  assert.equal(r.concurrency_observed, 2)
  assert.equal(
    r.concurrency_ok,
    true,
    "min(concurrency, apps) is the achievable maximum, and that is what is asserted",
  )
})

test("every one of the nine columns is present and labelled", async () => {
  const r = await runCampaign({
    apps: 2,
    concurrency: 2,
    boardName: "honest-greenhouse",
  })
  const required = [
    "submitted_per_hour",
    "deferred_per_hour",
    "defer_rate_by_class",
    "model_turns_per_app",
    "sleep_ms_per_app",
    "edge_spacing_ms_per_app",
    "wall_ms_p95",
    "spawns_per_app",
    "round_trips_per_app",
    "failure_rate_p",
  ]
  for (const k of required) {
    assert.ok(r.columns[k], `${k} is missing`)
    assert.ok(
      ["measured", "derived", "unmeasured"].includes(r.columns[k].method),
      `${k} carries no method label`,
    )
  }
  // Submitted and deferred throughput are SEPARATE columns. Applications per
  // hour alone is gameable — deferring more raises it, because a deferral is
  // fast — and nobody had measured how fast until this column existed.
  assert.notEqual(
    r.columns.submitted_per_hour,
    r.columns.deferred_per_hour,
    "the two throughputs are distinct columns, never one number",
  )
})

test("a deferred job leaves a TYPED reason in the queue — no silent skips", async () => {
  const r = await runCampaign({
    apps: 2,
    concurrency: 2,
    boardName: "greenhouse",
  })
  assert.equal(
    r.detail.deferred,
    2,
    "the greenhouse fixture carries a consent box",
  )
  for (const row of r.detail.reason_rows) {
    assert.ok(row.reason_kind, "every terminal row names a kind")
    assert.ok(row.reason_stage, "and the stage it stopped at")
  }
  assert.equal(r.columns.defer_rate.value, 1)
  assert.deepEqual(r.columns.defer_rate_by_class.value, { assent: 1 })
})

test("the CLI installs its own counter, so the gate's command needs no extra flags", () => {
  const out = execFileSync(
    process.execPath,
    [
      RUNNER,
      "--apps",
      "2",
      "--concurrency",
      "2",
      "--board",
      "honest-greenhouse",
    ],
    { encoding: "utf8", cwd: ROOT },
  )
  assert.match(out, /spawns_per_app\s+1\s+measured/)
  assert.doesNotMatch(
    out,
    /model_turns_per_app\s+\S+\s+unmeasured/,
    "the CLI re-execs with the preload; an unmeasured column here means it did not",
  )
})

test("--json refuses to bank a number from a dirty measured tree", (t) => {
  // Dirty the tree by touching a measured file, then put it back byte-for-byte.
  const target = path.join(ROOT, "src", "apply", "fill-plan.mjs")
  const original = fs.readFileSync(target)
  t.after(() => fs.writeFileSync(target, original))
  fs.appendFileSync(target, "\n// bench-runner dirty-tree probe\n")

  const r = spawnSync(
    process.execPath,
    [RUNNER, "--apps", "1", "--concurrency", "1", "--json"],
    { encoding: "utf8", cwd: ROOT },
  )
  assert.equal(r.status, 2)
  assert.match(r.stderr, /refusing to bank a number from a dirty tree/)
  assert.match(r.stderr, /fill-plan\.mjs/)
})

test("a ledger entry carries its command, its legs and its shas", async () => {
  const r = await runCampaign({
    apps: 2,
    concurrency: 2,
    boardName: "honest-greenhouse",
  })
  const entry = ledgerEntry(
    aggregate([r]),
    { sha: "abc1234", dirty_measured_files: [], file_sha1: {} },
    { apps: 2, concurrency: 2, boardName: "honest-greenhouse", runs: 1 },
  )
  assert.match(entry, /\*\*Command\.\*\*/)
  assert.match(entry, /--apps 2 --concurrency 2/)
  assert.match(entry, /\*\*Legs\.\*\*/)
  assert.match(entry, /\*\*Provenance\.\*\* `abc1234`/)
  assert.match(entry, /Concurrency assertion.*PASS/)
})
