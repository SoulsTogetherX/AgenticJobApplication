#!/usr/bin/env node
// Score every board in docs/job-sources.yaml by how many of its LIVE postings
// actually pass docs/application-limits.yaml. Deterministic, no LLM.
//
// Why this exists: a board that lists 200 reqs and none this profile could take
// is not neutral — it costs sweep time on every run and buries the reachable
// leads in noise that then costs a model read to reject. On 2026-07-28 a sweep
// of 41 boards produced 47 leads and every single one was unreachable. Board
// count is not a number to pick; it is an output of this measurement.
//
// Reports only. Removing a board is the user's call (docs/job-sources.yaml is
// user-facing), so this prints proposals and never edits anything.
//
// Usage: node scripts/leads/board-yield.mjs [--query "full stack"] [--json]
//                                     [--concurrency N] [--min-qualifying N]
import {
  loadSources,
  loadLimits,
  passesLimits,
  fetchBoard,
} from "./find-jobs.mjs"
import { isTerse, mapPool } from "../lib/lib.mjs"

const DEFAULT_CONCURRENCY = 6

function getFlag(args, name, fallback = null) {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

// Shared with the sweep — one implementation, in lib.mjs. Re-exported so the
// existing tests and importers keep working.
export { mapPool }

// Pure core, exported for tests: given a board's postings, how many survive?
export function scoreBoard(board, postings, limits, now = new Date()) {
  const label = `${board.type}:${board.slug ?? board.tenant ?? board.host ?? ""}`
  const row = {
    label,
    company: board.company ?? label,
    type: board.type,
    live: postings.length,
    qualifying: 0,
    // Of those, the ones whose location is actually CONFIRMED. passesLimits
    // lets "remote_unverified" and "unknown_location" through as flags rather
    // than rejects, and on 2026-07-28 every such lead checked (OpenAI, Ramp)
    // turned out to be Hybrid SF/NYC — a relocation. Counting them as yield
    // would make office-bound boards look productive, so they are split out.
    solid: 0,
    // Why the rest were dropped — this is what distinguishes a board that is
    // simply senior-only from one that is merely in the wrong city.
    hard_filtered: 0,
    location: 0,
    title: 0,
    stale: 0,
    other: 0,
    error: null,
    samples: [],
  }
  for (const p of postings) {
    const v = passesLimits(p, limits, now)
    if (v.ok) {
      row.qualifying++
      const unconfirmed = (v.flags ?? []).some(
        (f) => f === "remote_unverified" || f === "unknown_location",
      )
      if (!unconfirmed) {
        row.solid++
        if (row.samples.length < 3) row.samples.push(p.title)
      }
      continue
    }
    const r = String(v.reasons[0] ?? "")
    if (r.includes("hard-filtered")) row.hard_filtered++
    else if (r.startsWith("location:")) row.location++
    else if (r.startsWith("title:")) row.title++
    else if (r.startsWith("stale") || r.includes("older than")) row.stale++
    else row.other++
  }
  // Yield is measured on confirmed-location postings: an unverified "remote"
  // that is really a hybrid office is not a lead this profile can act on.
  row.yield = row.live ? Math.round((row.solid / row.live) * 1000) / 10 : 0
  return row
}

export async function auditBoards(boards, limits, opts = {}) {
  const { query = "full stack", concurrency = DEFAULT_CONCURRENCY } = opts
  const now = opts.now ?? new Date()
  return mapPool(boards, concurrency, async (board) => {
    try {
      const postings = await fetchBoard(board, query)
      return scoreBoard(board, postings, limits, now)
    } catch (e) {
      const row = scoreBoard(board, [], limits, now)
      row.error = e.message
      return row
    }
  })
}

async function main() {
  const args = process.argv.slice(2)
  const query = getFlag(args, "--query", "full stack")
  const concurrency = Number(
    getFlag(args, "--concurrency", DEFAULT_CONCURRENCY),
  )
  const minQualifying = Number(getFlag(args, "--min-qualifying", 0))
  const asJson = args.includes("--json")

  const limits = loadLimits()
  const boards = loadSources()
  const t0 = Date.now()
  const rows = await auditBoards(boards, limits, { query, concurrency })
  const ms = Date.now() - t0

  // Ranked on confirmed-reachable postings, not on raw qualifying: a board
  // whose only "hits" are unverified-remote is not a productive board.
  rows.sort((a, b) => b.solid - a.solid || b.yield - a.yield || b.live - a.live)
  const dead = rows.filter((r) => !r.error && r.solid <= minQualifying)
  const broken = rows.filter((r) => r.error)
  const totals = rows.reduce(
    (a, r) => ({
      live: a.live + r.live,
      qualifying: a.qualifying + r.qualifying,
      solid: a.solid + r.solid,
    }),
    { live: 0, qualifying: 0, solid: 0 },
  )

  if (asJson) {
    console.log(JSON.stringify({ ms, totals, rows }, null, 2))
    return
  }

  if (isTerse()) {
    for (const r of rows) {
      console.log(
        r.error
          ? `${r.label}|${r.company}|ERROR|${r.error}`
          : `${r.label}|${r.company}|live=${r.live}|solid=${r.solid}|unconfirmed=${r.qualifying - r.solid}|yield=${r.yield}%|hard=${r.hard_filtered}|loc=${r.location}|title=${r.title}`,
      )
    }
    console.log(
      `boards=${rows.length} live=${totals.live} solid=${totals.solid} unconfirmed=${totals.qualifying - totals.solid} dead=${dead.length} broken=${broken.length} ms=${ms}`,
    )
    return
  }

  const pad = (s, n) => String(s).padEnd(n)
  console.log(
    `\nBoard yield — ${rows.length} boards, ${totals.live} live postings, ` +
      `${totals.solid} reachable, ${totals.qualifying - totals.solid} unconfirmed-location (${ms} ms)\n`,
  )
  console.log(
    `${pad("COMPANY", 30)}${pad("LIVE", 6)}${pad("OK", 5)}${pad("UNCONF", 8)}${pad("YIELD", 8)}${pad("WHY DROPPED", 30)}`,
  )
  console.log("-".repeat(80))
  for (const r of rows) {
    if (r.error) {
      console.log(
        `${pad(r.company, 30)}${pad("-", 6)}${pad("-", 5)}${pad("-", 8)}${pad("-", 8)}error: ${r.error}`,
      )
      continue
    }
    const why = [
      r.hard_filtered ? `${r.hard_filtered} over-level/wrong-role` : null,
      r.location ? `${r.location} location` : null,
      r.title ? `${r.title} off-target title` : null,
      r.stale ? `${r.stale} stale` : null,
    ]
      .filter(Boolean)
      .join(", ")
    console.log(
      `${pad(r.company, 30)}${pad(r.live, 6)}${pad(r.solid, 5)}${pad(r.qualifying - r.solid, 8)}${pad(r.yield + "%", 8)}${why}`,
    )
  }

  if (dead.length) {
    console.log(
      `\n${dead.length} board(s) produced no reachable posting. Proposed removals ` +
        `(review first — nothing was changed):`,
    )
    for (const r of dead) {
      console.log(
        `  node scripts/leads/manage-sources.mjs remove "${r.company}"   # ${r.live} live, 0 reachable`,
      )
    }
  }
  if (broken.length) {
    console.log(`\n${broken.length} board(s) failed to fetch:`)
    for (const r of broken) console.log(`  ${r.company} — ${r.error}`)
  }
  console.log("")
}

const invoked = process.argv[1] && process.argv[1].endsWith("board-yield.mjs")
if (invoked) {
  main().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
