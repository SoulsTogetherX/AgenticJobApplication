// A --require preload that counts every child process and every outbound
// request the run makes. Phase 4.7's instrument for `model_turns`.
//
// WHY A PRELOAD AND NOT A MONKEYPATCH IN THE HARNESS. Measured, not assumed:
// patching `child_process.execFileSync` from inside an ESM module counts ZERO,
// because a module that did `import { execFileSync } from "node:child_process"`
// is bound to the export the builtin published at bootstrap, not to the
// property being reassigned. Both obvious workarounds were tried and both also
// counted zero — patching before a dynamic `import()` of the caller, and
// patching the default-imported namespace object.
//
//   node -e '...'  patch-then-static-import   -> 0
//                  patch-then-dynamic-import  -> 0
//                  --require preload          -> 1   <- this file
//
// That matters more than a normal implementation detail. A counter that
// silently reports 0 is worse than no counter: the CI gate's one hard,
// no-override rule is `model_turns > 0`, and a broken instrument turns that
// rule into a permanent green light. Requiring this file BEFORE any ESM in the
// graph is what makes the named binding resolve to the wrapped function.
//
// It counts. It never blocks, never rewrites arguments, and never fails a call.
"use strict"

// IT MUST FOLLOW THE WORK INTO CHILD PROCESSES, and that is not optional.
//
// Measured: with the preload in the parent only, a model call added to
// `scripts/apply/fill-plan.mjs` — which the plan leg SHELLS OUT to, once per
// application — was counted as ZERO. The parent never sees the child's
// requests. The gate stayed green through the exact mutation the plan names as
// its falsifiable check.
//
// So the parent sets NODE_OPTIONS=--require <this file> plus AJ_COUNTER_FILE,
// every descendant loads this, and each writes ONE JSON line on exit. The
// parent sums itself plus every row that is not its own pid. A file is the
// only channel available: a child's counters die with the child, and stdout
// belongs to whatever the child was actually doing.
const child_process = require("node:child_process")
const http = require("node:http")
const https = require("node:https")
const path = require("node:path")
const fs = require("node:fs")

const ROOT = path.resolve(__dirname, "..", "..")
const SCRIPTS_DIR = path.join(ROOT, "scripts")

// Loopback in every form a request can carry it. The fixture is loopback, and
// counting it as outbound would report a model turn per application.
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|\[?::1\]?|0\.0\.0\.0)$/i
const isLoopback = (h) => LOOPBACK.test(String(h || "").replace(/:\d+$/, ""))

const counters = {
  spawns: 0,
  foreign_spawns: 0,
  outbound_requests: 0,
  loopback_requests: 0,
  spawn_argv: [],
  outbound_hosts: [],
  installed: true,
}
globalThis.__ajCounters = counters

// A spawn of THIS repo's own node running a file under scripts/ is a
// deterministic local script — the thing the plan wants more of, not a model
// turn. Everything else is foreign: another interpreter, a CLI, anything at
// all outside the tree.
function isRepoScript(cmd, args) {
  try {
    if (path.resolve(String(cmd)) !== path.resolve(process.execPath))
      return false
    const first = (args || []).find((a) => !String(a).startsWith("-"))
    if (!first) return false
    return path.resolve(ROOT, String(first)).startsWith(SCRIPTS_DIR + path.sep)
  } catch {
    return false
  }
}

for (const name of [
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
]) {
  const original = child_process[name]
  if (typeof original !== "function") continue
  child_process[name] = function (cmd, args, ...rest) {
    counters.spawns += 1
    const argv = Array.isArray(args) ? args : []
    if (!isRepoScript(cmd, argv)) {
      counters.foreign_spawns += 1
      if (counters.spawn_argv.length < 20)
        counters.spawn_argv.push(String(cmd) + " " + argv.slice(0, 2).join(" "))
    }
    return original.call(this, cmd, args, ...rest)
  }
}

function note(target) {
  let host = null
  try {
    if (typeof target === "string") host = new URL(target).hostname
    else if (target && typeof target.hostname === "string")
      host = target.hostname
    else if (target && typeof target.host === "string") host = target.host
    else if (target && typeof target.url === "string")
      host = new URL(target.url).hostname
  } catch {
    /* unparseable: treated as outbound below — loud beats silent */
  }
  if (host && isLoopback(host)) counters.loopback_requests += 1
  else {
    counters.outbound_requests += 1
    if (counters.outbound_hosts.length < 20)
      counters.outbound_hosts.push(String(host || "(unparsed)"))
  }
}

for (const [mod, name] of [
  [http, "http"],
  [https, "https"],
]) {
  const original = mod.request
  mod.request = function (a, b, c) {
    note(typeof a === "string" || a instanceof URL ? a : a)
    return original.call(this, a, b, c)
  }
  const originalGet = mod.get
  mod.get = function (a, b, c) {
    note(typeof a === "string" || a instanceof URL ? a : a)
    return originalGet.call(this, a, b, c)
  }
  void name
}

const originalFetch = globalThis.fetch
if (typeof originalFetch === "function") {
  globalThis.fetch = function (input, init) {
    note(
      typeof input === "string"
        ? input
        : input && input.url
          ? input.url
          : input,
    )
    return originalFetch.call(this, input, init)
  }
}

// Report on the way out, one line per process. Appended, never rewritten, so
// eight concurrent workers' children cannot lose each other's rows; each write
// is a few hundred bytes, which O_APPEND makes atomic.
//
// Silent on failure BY DESIGN: this is an instrument bolted onto somebody
// else's process, and it has no business turning their exit into a crash. The
// cost of that choice is that a missing row looks like a zero, which is why
// bench-runner asserts its own row rather than trusting the file to be
// complete.
if (process.env.AJ_COUNTER_FILE) {
  process.on("exit", () => {
    try {
      fs.appendFileSync(
        process.env.AJ_COUNTER_FILE,
        JSON.stringify({
          pid: process.pid,
          argv: process.argv.slice(1, 3).join(" "),
          spawns: counters.spawns,
          foreign_spawns: counters.foreign_spawns,
          outbound_requests: counters.outbound_requests,
          loopback_requests: counters.loopback_requests,
          spawn_argv: counters.spawn_argv,
          outbound_hosts: counters.outbound_hosts,
        }) + "\n",
        "utf8",
      )
    } catch {
      /* an instrument must never break the process it is measuring */
    }
  })
}
