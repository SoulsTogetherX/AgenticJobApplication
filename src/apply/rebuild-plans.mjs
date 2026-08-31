#!/usr/bin/env node
// Rebuild every jobs/<slug>/fill-plan.json that predates the things that built
// it, from the scan already on disk.
//
// WHY THIS EXISTS AS A COMMAND. A fill plan is a cached derivation of (scan,
// planner, fact base) and only the scan is bound to it (`fp`). Nothing rebuilt
// a plan when a planner fix landed or when the user banked an answer, so the
// defer list on disk drifted away from what current code would decide — and
// pending-questions.mjs read that drift straight back to the user as open
// questions. Measured 2026-08-20: seven jobs were still asking for a location
// answered on 2026-08-07 and fixed in the Greenhouse adapter on 2026-08-18.
//
// This reads a saved scan and opens NO BROWSER, so it is cheap and safe to run
// on a schedule. It changes no answers and makes no decisions: every defer it
// clears is one current code resolves on its own.
//
// Usage: node src/apply/rebuild-plans.mjs [<slug> ...] [--all] [--dry-run]
//        [--jobs-dir jobs]
//
// Exit codes: 0 ok (including nothing to do), 1 one or more rebuilds failed,
//             2 usage / missing jobs dir.
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { newestInputMtime, factBaseInputs } from "./pending-questions.mjs"
import { assertKnownFlags } from "#lib/args.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

// The highest-numbered scan page, because a later page's plan supersedes an
// earlier one — and a single-page form (the common case) has only p1 anyway.
function newestScan(dir) {
  let best = null
  let bestN = -1
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return null
  }
  for (const e of entries) {
    const m = /^scan-p(\d+)\.json$/.exec(e)
    if (!m) continue
    const n = Number(m[1])
    if (n > bestN) {
      bestN = n
      best = path.join(dir, e)
    }
  }
  return best
}

/**
 * Rebuild every stale plan and RETURN what happened, printing nothing.
 *
 * EXTRACTED FROM `main()` 2026-08-24 so `cycle.mjs` can own this sweep the way
 * it already owns `reverifySweep`. Until then this file had NO caller anywhere
 * — not in the cycle, not in package.json, not scheduled — so the rebuild it
 * performs happened only when a human remembered to type the command. That is
 * why 35 of 36 plans were stale two hours after a full rebuild: one
 * `save-answer.mjs` write moves the fact base mtime past every plan at once,
 * and nothing swept them afterwards.
 *
 * @returns {{rebuilt:number, failed:number, noScan:string[], checked:number,
 *            results:Array<{slug:string, ok:boolean, head:string}>}}
 */
export function rebuildPlans({
  jobsDir = path.join(ROOT, "jobs"),
  only = [],
  all = false,
  dryRun = false,
  answersFlag = null,
} = {}) {
  if (!fs.existsSync(jobsDir)) {
    const e = new Error(`no jobs directory at ${jobsDir}`)
    e.exitCode = 2
    throw e
  }

  const threshold = newestInputMtime(factBaseInputs({ answersFlag }))

  const slugs = only.length
    ? only
    : fs
        .readdirSync(jobsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)

  const todo = []
  const noScan = []
  for (const slug of slugs) {
    const dir = path.join(jobsDir, slug)
    const planPath = path.join(dir, "fill-plan.json")
    if (!fs.existsSync(planPath)) continue
    let mtime = 0
    try {
      mtime = fs.statSync(planPath).mtimeMs
    } catch {
      // Unreadable stat: rebuild rather than assume current.
    }
    if (!all && mtime >= threshold) continue
    const scan = newestScan(dir)
    if (!scan) {
      // A plan with no scan on disk cannot be rebuilt without a browser, and
      // this command never opens one. Named, not skipped in silence.
      noScan.push(slug)
      continue
    }
    todo.push({ slug, scan })
  }

  if (!todo.length) {
    console.log(
      `nothing to rebuild (checked=${slugs.length} no-scan=${noScan.length})` +
        (noScan.length ? `\nno-scan\t${noScan.join(",")}` : ""),
    )
    return { rebuilt: 0, failed: 0, noScan, checked: slugs.length, results: [] }
  }

  const results = []
  let failed = 0
  for (const { slug, scan } of todo) {
    if (dryRun) {
      results.push({ slug, ok: true, head: `would rebuild ${scan}` })
      console.log(`would rebuild\t${slug}\t${path.basename(scan)}`)
      continue
    }
    const r = spawnSync(
      process.execPath,
      [path.join(ROOT, "src", "apply", "fill-plan.mjs"), slug, "--scan", scan],
      { cwd: ROOT, encoding: "utf8" },
    )
    // The FIRST line only. fill-plan prints the plan body and a bootstrap
    // block; echoing all of it for 28 jobs buries the one number that matters.
    const head = String(r.stdout ?? "")
      .split("\n")
      .find((l) => l.startsWith("ats="))
    if (r.status === 0) {
      results.push({ slug, ok: true, head: head ?? "" })
      console.log(`rebuilt\t${slug}\t${head ?? ""}`)
    } else {
      failed += 1
      results.push({
        slug,
        ok: false,
        head: String(r.stderr ?? "").split("\n")[0],
      })
      console.log(
        `FAILED\t${slug}\texit=${r.status}\t${String(r.stderr ?? "").split("\n")[0]}`,
      )
    }
  }
  console.log(
    `rebuilt=${todo.length - failed} failed=${failed} no-scan=${noScan.length}` +
      (noScan.length ? `\nno-scan\t${noScan.join(",")}` : ""),
  )
  return {
    rebuilt: todo.length - failed,
    failed,
    noScan,
    checked: slugs.length,
    results,
  }
}

// The repo idiom: importing this file must not rebuild 28 plans as a side
// effect of reading one of its helpers.
const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
// Every flag this command understands. STRICT, because an unrecognised one used
// to be dropped by `args.filter((a) => !a.startsWith("--"))` — which left the
// slug list EMPTY, and an empty slug list means "every workspace". So
// `rebuild-plans.mjs --help` spawned fill-plan.mjs for all 36 jobs and rewrote
// every plan and the shared field cache.
const REBUILD_FLAGS = ["--all", "--dry-run", "--jobs-dir", "--help"]
const REBUILD_VALUE_FLAGS = ["--jobs-dir"]

const USAGE = `rebuild-plans.mjs — rebuild stale jobs/<slug>/fill-plan.json from the saved scan

  <slug> ...        rebuild only these (default: every workspace with a stale plan)
  --all             rebuild every workspace, stale or not
  --dry-run         report what would be rebuilt and write nothing
  --jobs-dir <dir>  workspace root. Defaults to jobs/

Opens no browser. Writes fill-plan.json and the shared field cache.
`

if (isMain) {
  // A thin argument shim over rebuildPlans(), so the command a human types and
  // the sweep cycle.mjs runs cannot drift apart.
  const args = process.argv.slice(2)
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    process.exit(0)
  }
  try {
    assertKnownFlags(args, {
      known: REBUILD_FLAGS,
      valueFlags: REBUILD_VALUE_FLAGS,
      script: "rebuild-plans.mjs",
      note: "an unknown flag used to be dropped, leaving an empty slug list, which means EVERY workspace",
    })
  } catch (e) {
    console.error(e.message)
    process.exit(e.exitCode ?? 2)
  }
  const i = args.indexOf("--jobs-dir")
  const jobsDir =
    i === -1 ? path.join(ROOT, "jobs") : path.resolve(args[i + 1] ?? "")
  if (i !== -1) args.splice(i, 2)
  try {
    const out = rebuildPlans({
      jobsDir,
      only: args.filter((a) => !a.startsWith("--")),
      all: args.includes("--all"),
      dryRun: args.includes("--dry-run"),
    })
    if (out.failed) process.exit(1)
  } catch (e) {
    console.error(e.message)
    process.exit(e.exitCode ?? 1)
  }
}
