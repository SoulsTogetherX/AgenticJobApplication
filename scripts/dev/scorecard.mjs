#!/usr/bin/env node
// scorecard.mjs — one JSON line answering "is the machine getting better at
// its job?" (Purpose Scorecard, plan of 2026-08-13.)
//
// The pipeline's purpose is accelerated, automated job searching + applying.
// npm test proves changes are CORRECT; nothing proved they HELP. This script
// snapshots the whole funnel — reach, conversion, automatability, deferral
// pressure, speed, outcomes — and appends the snapshot to docs/scorecard.jsonl
// so every landed change gets compared against the line before it, with a
// `note` naming what changed. Regressions in these numbers stop a phase (see
// the plan's tripwires); a change nobody measured is a change nobody proved.
//
// WHAT THIS IS NOT, deliberately:
//   - not a gate: it never exits non-zero on a bad number — humans judge the
//     direction, the tripwires live in the plan, and a scorecard that could
//     fail CI would invite gaming the metric instead of improving it;
//   - not a benchmark: wall-time p95s here are read from what the pipeline
//     already recorded (auto_queue.wall_ms, docs/perf-baseline.json), never
//     measured fresh — bench-runner.mjs owns measurement;
//   - not a second status.mjs: status answers "what should I do next?",
//     this answers "did the last change move the funnel?".
//
// Read-only everywhere except the one appended line (and --no-record skips
// even that). No LLM, no network, no browser.
//
// Usage:
//   node scripts/dev/scorecard.mjs --note "baseline"            # snapshot + append
//   node scripts/dev/scorecard.mjs --json --no-record           # inspect only
//   node scripts/dev/scorecard.mjs --db jobs/leads.db --out docs/scorecard.jsonl
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { isTerse } from "../lib/lib.mjs"
import {
  openDb,
  hasPassingVerification,
  readApplications,
  readJobWallTimes,
  readSubmitLatencies,
} from "../lib/db.mjs"
import { verifiedResumeUrls } from "../lib/verification.mjs"
import { loadSources } from "../leads/find-jobs.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

// Nearest-rank percentile. Returns null on an empty sample rather than 0 —
// the same rule readJobWallTimes applies: an unmeasured thing is unknown, and
// folding it in as zero flatters exactly the statistic it belongs to.
export function percentile(values, p) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (!xs.length) return null
  const idx = Math.max(0, Math.ceil((p / 100) * xs.length) - 1)
  return xs[idx]
}

// Deferral pressure straight off the persisted plans. why === "unknown" is
// the one class engineering is allowed to shrink (and only deterministically);
// the rest are assent/policy and are supposed to be there.
export function countDeferrals(jobsDir) {
  let fields = 0
  let unknown = 0
  let plans = 0
  if (!fs.existsSync(jobsDir)) return { plans, fields, unknown }
  for (const name of fs.readdirSync(jobsDir)) {
    if (name.startsWith(".")) continue
    const file = path.join(jobsDir, name, "fill-plan.json")
    if (!fs.existsSync(file)) continue
    try {
      const plan = JSON.parse(fs.readFileSync(file, "utf8"))
      const defer = Array.isArray(plan?.defer) ? plan.defer : []
      plans += 1
      fields += defer.length
      unknown += defer.filter((d) => d?.why === "unknown").length
    } catch {
      // an unparsable plan is a broken workspace, not a scorecard crash
      process.stderr.write(`scorecard: unparsable plan skipped: ${file}\n`)
    }
  }
  return { plans, fields, unknown }
}

// Cache warmth: how much of what fills learned has actually been kept.
// 21 forms / 0 via was the measured 2026-08-13 state — learning produced
// every run and written nowhere. Phase 4 exists to move these two counts.
export function countCache(cacheFile) {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, "utf8"))
    const forms = raw?.forms && typeof raw.forms === "object" ? raw.forms : {}
    const entries = Object.values(forms)
    return {
      forms: entries.length,
      with_strategy: entries.filter((e) => e?.comboStrategy).length,
      with_via: entries.filter((e) =>
        Object.values(e?.fields ?? {}).some((f) => f?.via),
      ).length,
    }
  } catch {
    if (fs.existsSync(cacheFile))
      process.stderr.write(`scorecard: unparsable cache: ${cacheFile}\n`)
    return { forms: 0, with_strategy: 0, with_via: 0 }
  }
}

function spawnJsonDefault(args) {
  const r = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
  })
  if (r.status !== 0 || !r.stdout) return null
  try {
    return JSON.parse(r.stdout)
  } catch {
    return null
  }
}

// All the I/O, injectable for tests. Anything that fails contributes null and
// a stderr line — a scorecard with a hole is still a scorecard, and a hole is
// itself a finding.
export function collectInputs({
  root = ROOT,
  dbFile = path.join(ROOT, "jobs", "leads.db"),
  jobsDir = path.join(ROOT, "jobs"),
  spawnJson = spawnJsonDefault,
} = {}) {
  if (!fs.existsSync(dbFile)) {
    // openDb would CREATE an empty schema here, and an all-zero line would
    // read as "the pipeline collapsed" — refuse instead.
    throw Object.assign(new Error(`no lead store at ${dbFile}`), { code: 2 })
  }
  const warn = (what, e) =>
    process.stderr.write(`scorecard: ${what} unavailable: ${e.message}\n`)

  let boards = null
  try {
    boards = loadSources().length
  } catch (e) {
    warn("sources", e)
  }

  const db = openDb(dbFile)
  let stats = null
  let leadCounts = null
  let submissions = null
  let eligible = null
  let wall = []
  let latency = []
  let applications = null
  try {
    stats = db
      .prepare(
        `SELECT COUNT(*) boards, SUM(live_postings) live, SUM(solid) solid,
                MAX(last_swept) last_swept
           FROM board_stats`,
      )
      .get()
    leadCounts = Object.fromEntries(
      db
        .prepare("SELECT status, COUNT(*) n FROM leads GROUP BY status")
        .all()
        .map((r) => [r.status ?? "unknown", r.n]),
    )
    submissions = db.prepare("SELECT COUNT(*) n FROM auto_submissions").get().n
    eligible = verifiedResumeUrls(db, {
      jobsDir,
      hasPassing: hasPassingVerification,
    }).size
    wall = readJobWallTimes(db).map((r) => r.ms)
    latency = readSubmitLatencies(db).map((r) => r.ms)
    applications = readApplications(dbFile).length
  } catch (e) {
    warn("lead store", e)
  } finally {
    db.close()
  }

  let tailored = 0
  try {
    tailored = fs
      .readdirSync(jobsDir)
      .filter(
        (n) =>
          !n.startsWith(".") &&
          fs.existsSync(path.join(jobsDir, n, "resume.md")),
      ).length
  } catch (e) {
    warn("workspaces", e)
  }

  let benchP95 = null
  try {
    benchP95 =
      JSON.parse(
        fs.readFileSync(path.join(root, "docs", "perf-baseline.json"), "utf8"),
      )?.columns?.wall_ms_p95 ?? null
  } catch (e) {
    warn("perf baseline", e)
  }

  let sha = null
  try {
    const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    })
    if (r.status === 0) sha = r.stdout.trim()
  } catch (e) {
    warn("git sha", e)
  }

  const auto = spawnJson(["scripts/apply/automatability.mjs", "--json"])
  const pending = spawnJson(["scripts/apply/pending-questions.mjs", "--json"])
  const followUps = spawnJson(["scripts/applications/follow-ups.mjs", "--json"])
  if (!auto) warn("automatability", new Error("spawn returned no JSON"))
  if (!pending) warn("pending-questions", new Error("spawn returned no JSON"))
  if (!followUps) warn("follow-ups", new Error("spawn returned no JSON"))

  return {
    sha,
    boards,
    stats,
    leadCounts,
    submissions,
    eligible,
    tailored,
    wall,
    latency,
    applications,
    benchP95,
    autoCounts: auto?.counts ?? null,
    pendingLabels: Array.isArray(pending?.questions)
      ? pending.questions.length
      : null,
    followUpsDue: Array.isArray(followUps?.due) ? followUps.due.length : null,
    deferrals: countDeferrals(jobsDir),
    cache: countCache(path.join(jobsDir, ".field-cache.json")),
  }
}

// Pure assembly — the tested seam. `now` injected so two runs on the same
// state differ only where state differed.
export function buildScorecard(inputs, { now = new Date(), note = "" } = {}) {
  const hours = (ms) => Math.round(ms / 36e5)
  return {
    at: now.toISOString(),
    note,
    sha: inputs.sha ?? null,
    reach: {
      boards: inputs.boards ?? null,
      live: inputs.stats?.live ?? null,
      qualifying: inputs.stats?.solid ?? null,
      last_swept: inputs.stats?.last_swept ?? null,
    },
    leads: inputs.leadCounts ?? null,
    docs: { tailored: inputs.tailored ?? null, eligible: inputs.eligible },
    auto: inputs.autoCounts,
    defer: {
      plans: inputs.deferrals.plans,
      fields: inputs.deferrals.fields,
      unknown: inputs.deferrals.unknown,
      labels: inputs.pendingLabels,
    },
    speed: {
      bench_p95: inputs.benchP95,
      wall_n: inputs.wall.length,
      wall_p50: percentile(inputs.wall, 50),
      wall_p95: percentile(inputs.wall, 95),
      posting_age_n: inputs.latency.length,
      posting_age_p50_h: inputs.latency.length
        ? hours(percentile(inputs.latency, 50))
        : null,
    },
    cache: inputs.cache,
    outcomes: {
      submissions: inputs.submissions,
      applications: inputs.applications,
      follow_ups_due: inputs.followUpsDue,
    },
  }
}

export function appendLine(card, outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.appendFileSync(outFile, JSON.stringify(card) + "\n")
}

function fmtTerse(c) {
  const a = c.auto ?? {}
  return (
    `boards=${c.reach.boards} live=${c.reach.live} solid=${c.reach.qualifying} ` +
    `eligible=${c.docs.eligible}/${c.docs.tailored} ` +
    `green=${a.green ?? "-"} amber=${a.amber ?? "-"} blocked=${a.blocked ?? "-"} ` +
    `defer=${c.defer.fields} unknown=${c.defer.unknown} labels=${c.defer.labels} ` +
    `wall_n=${c.speed.wall_n} bench_p95=${c.speed.bench_p95} ` +
    `cache=${c.cache.with_via}/${c.cache.forms} subs=${c.outcomes.submissions} ` +
    `apps=${c.outcomes.applications} due=${c.outcomes.follow_ups_due}`
  )
}

function fmtProse(c) {
  const a = c.auto ?? {}
  return [
    `Scorecard ${c.at}  (${c.sha ?? "no sha"}${c.note ? ` — ${c.note}` : ""})`,
    `  reach       ${c.reach.boards} boards, ${c.reach.live} live postings, ${c.reach.qualifying} qualifying (last swept ${c.reach.last_swept ?? "never"})`,
    `  documents   ${c.docs.eligible}/${c.docs.tailored} tailored resumes eligible against the current fact base`,
    `  automation  ${a.green ?? "?"} green / ${a.amber ?? "?"} amber / ${a.handoff ?? "?"} handoff / ${a.blocked ?? "?"} blocked`,
    `  deferrals   ${c.defer.fields} deferred fields across ${c.defer.plans} plans (${c.defer.unknown} unknown); ${c.defer.labels ?? "?"} unique pending labels`,
    `  speed       bench p95 ${c.speed.bench_p95 ?? "?"} ms; live wall n=${c.speed.wall_n}; posting-age n=${c.speed.posting_age_n}`,
    `  learning    ${c.cache.with_via}/${c.cache.forms} cached forms carry a via; ${c.cache.with_strategy} carry a strategy`,
    `  outcomes    ${c.outcomes.submissions} auto submissions ever; ${c.outcomes.applications} applications; ${c.outcomes.follow_ups_due ?? "?"} follow-ups due`,
  ].join("\n")
}

function main() {
  const args = process.argv.slice(2)
  const flag = (name, dflt = null) => {
    const i = args.indexOf(name)
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt
  }
  const note = flag("--note", "")
  const outFile = path.resolve(
    ROOT,
    flag("--out", path.join("docs", "scorecard.jsonl")),
  )
  let inputs
  try {
    inputs = collectInputs({
      dbFile: path.resolve(ROOT, flag("--db", path.join("jobs", "leads.db"))),
    })
  } catch (e) {
    console.error(`scorecard: ${e.message}`)
    process.exit(e.code ?? 1)
  }
  const card = buildScorecard(inputs, { note })
  if (!args.includes("--no-record")) appendLine(card, outFile)

  if (args.includes("--json")) console.log(JSON.stringify(card, null, 2))
  else if (isTerse()) console.log(fmtTerse(card))
  else console.log(fmtProse(card))
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) main()
