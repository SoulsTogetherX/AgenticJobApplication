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
//        node scripts/leads/board-yield.mjs --history [--live] [--json]
//                                     [--dead-days 30] [--zero-streak 5]
//                                     [--min-sweeps 5]
//
// Two modes, and the difference is the whole point of --history. The default
// mode fetches every board and scores THIS MOMENT: it needs the network, takes
// tens of seconds, and cannot tell a board that is permanently dead from one
// that happens to be between reqs today. --history reads the accumulated
// board_stats counters instead — offline, sub-second — so a removal proposal
// rests on how a board has behaved over weeks. --live joins today's snapshot
// onto that history when you want both in one table.
import {
  loadSources,
  loadLimits,
  passesLimits,
  fetchBoard,
  parseQueries,
  DEFAULT_SEARCH_QUERY,
} from "./find-jobs.mjs"
import { isTerse, mapPool } from "../lib/lib.mjs"
import { openDb, resolveLeadSource, readBoardStats } from "../lib/db.mjs"
import { assertKnownFlags } from "../lib/args.mjs"

const DEFAULT_CONCURRENCY = 6

// Thresholds for a removal proposal. Deliberately generous: this prints shell
// lines for a human to run, and the cost of proposing a live board is that the
// user deletes a board they wanted, while the cost of missing a dead one is a
// few seconds of sweep time.
export const DEFAULT_DEAD_DAYS = 30
export const DEFAULT_ZERO_STREAK = 5
export const DEFAULT_MIN_SWEEPS = 5
const DAY_MS = 86_400_000

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
  const { query = DEFAULT_SEARCH_QUERY, concurrency = DEFAULT_CONCURRENCY } =
    opts
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

// Pure core, exported for tests: which boards has history earned a removal
// proposal for? Three triggers, and it takes all three because each alone has
// a blind spot:
//
//   1. zero_streak >= N — the direct signal, but useless on a fresh install
//      and on any row healed into this shape, where the streak starts at 0.
//   2. never yielded across N counted sweeps — catches the board that was
//      wrong from the day it was added, which rule 1 also catches eventually
//      but only after the counter has had time to run.
//   3. last yield older than --dead-days — the only rule that can fire on
//      HISTORICAL data, since last_qualifying_at predates the counters. It is
//      what makes this useful on the first run rather than five sweeps later.
//
// NULL counters mean "swept before counting existed", not zero sweeps, so they
// read as 0 here and hold the board back from rules 1 and 2 until it has a
// real record. Erring toward proposing nothing is the right direction: an
// unproposed dead board costs sweep seconds, a wrongly proposed live one costs
// the user a source they wanted.
export function proposeRemovals(rows, opts = {}) {
  const {
    deadDays = DEFAULT_DEAD_DAYS,
    zeroStreak = DEFAULT_ZERO_STREAK,
    minSweeps = DEFAULT_MIN_SWEEPS,
    now = new Date(),
  } = opts
  const out = []
  for (const r of rows) {
    const sweeps = r.sweeps ?? 0
    const streak = r.zero_streak ?? 0
    const reasons = []
    if (streak >= zeroStreak) {
      reasons.push(`${streak} consecutive sweeps with nothing reachable`)
    }
    if (!r.last_qualifying_at && sweeps >= minSweeps) {
      reasons.push(`never yielded a reachable posting in ${sweeps} sweeps`)
    }
    if (r.last_qualifying_at) {
      const at = new Date(r.last_qualifying_at)
      const days = Math.floor((now.getTime() - at.getTime()) / DAY_MS)
      // An unparseable timestamp gives NaN, and NaN > deadDays is false — so a
      // corrupt value proposes nothing rather than proposing everything.
      if (days > deadDays) {
        reasons.push(`last reachable posting ${days}d ago`)
      }
    }
    if (reasons.length) out.push({ ...r, reasons })
  }
  return out
}

function loadHistory() {
  const src = resolveLeadSource()
  if (src.kind !== "db") return []
  const db = openDb(src.file)
  try {
    return readBoardStats(db)
  } finally {
    db.close()
  }
}

async function historyMain(args) {
  const asJson = args.includes("--json")
  const opts = {
    deadDays: Number(getFlag(args, "--dead-days", DEFAULT_DEAD_DAYS)),
    zeroStreak: Number(getFlag(args, "--zero-streak", DEFAULT_ZERO_STREAK)),
    minSweeps: Number(getFlag(args, "--min-sweeps", DEFAULT_MIN_SWEEPS)),
  }
  const t0 = Date.now()
  const rows = loadHistory()

  // --live is the expensive half and stays opt-in: it re-fetches every board
  // so the table can show what is on them right now next to what they have
  // produced over time. Measured 2026-08-17 on 57 boards: 5 ms offline,
  // 22.6 s with --live. That ratio is why history is the default.
  //
  // Joined on board_id, which is the label find-jobs recorded the sweep under.
  // The join is NOT total, and the miss is reported rather than hidden: a
  // board_stats row survives a board's removal from job-sources.yaml (that is
  // the point of history), and the two labels can also simply disagree — a
  // board with no slug is `jobicy:undefined` in board_stats but `jobicy:` out
  // of scoreBoard, so it silently matched nothing until this said so. Fixing
  // that by changing either label would re-key the history and orphan it,
  // which costs more than the mismatch does.
  const wantLive = args.includes("--live")
  if (wantLive) {
    const query = parseQueries(getFlag(args, "--query")) ?? DEFAULT_SEARCH_QUERY
    const concurrency = Number(
      getFlag(args, "--concurrency", DEFAULT_CONCURRENCY),
    )
    const live = await auditBoards(loadSources(), loadLimits(), {
      query,
      concurrency,
    })
    const byLabel = new Map(live.map((r) => [r.label, r]))
    for (const r of rows) {
      const l = byLabel.get(r.board_id)
      r.matched_live = Boolean(l)
      r.live_now = l && !l.error ? l.live : null
      r.solid_now = l && !l.error ? l.solid : null
      r.error = l?.error ?? null
    }
  }
  const ms = Date.now() - t0
  const proposals = proposeRemovals(rows, opts)

  if (asJson) {
    console.log(JSON.stringify({ ms, rows, proposals }, null, 2))
    return
  }

  const day = (s) => (s ? String(s).slice(0, 10) : "never")
  // Only meaningful under --live: how many history rows found no board to join
  // against. Printed even when it is 0, so the absence of a warning is
  // evidence rather than the two cases looking alike.
  const unmatched = wantLive ? rows.filter((r) => !r.matched_live) : []
  const liveCol = (r) =>
    !wantLive
      ? ""
      : r.matched_live
        ? `|live=${r.live_now ?? "err"}|solid=${r.solid_now ?? "err"}`
        : "|live=no-board"
  if (isTerse()) {
    for (const r of rows) {
      console.log(
        `${r.board_id}|${r.company ?? ""}|swept=${day(r.last_swept)}|last_ok=${day(r.last_qualifying_at)}` +
          `|leads=${r.leads_produced ?? 0}|streak=${r.zero_streak ?? "?"}/${r.sweeps ?? "?"}` +
          liveCol(r),
      )
    }
    for (const p of proposals) {
      console.log(`propose-remove|${p.board_id}|${p.reasons.join("; ")}`)
    }
    console.log(
      `boards=${rows.length} proposals=${proposals.length} ms=${ms} offline=${!wantLive}` +
        (wantLive ? ` unmatched=${unmatched.length}` : ""),
    )
    return
  }

  const pad = (s, n) => String(s).padEnd(n)
  console.log(
    `\nBoard history — ${rows.length} boards from board_stats (${ms} ms)\n`,
  )
  console.log(
    `${pad("COMPANY", 28)}${pad("SWEPT", 12)}${pad("LAST OK", 12)}${pad("LEADS", 7)}${pad("DRY/SWEEPS", 12)}`,
  )
  console.log("-".repeat(72))
  for (const r of rows) {
    console.log(
      `${pad(r.company ?? r.board_id, 28)}${pad(day(r.last_swept), 12)}${pad(day(r.last_qualifying_at), 12)}` +
        `${pad(r.leads_produced ?? 0, 7)}${pad(`${r.zero_streak ?? "?"}/${r.sweeps ?? "?"}`, 12)}` +
        liveCol(r).replace(/\|/g, " ").trim(),
    )
  }

  if (!rows.length) {
    console.log("  (no rows yet — board_stats fills in as sweeps run)")
  }
  console.log(
    "\nA '?' in DRY/SWEEPS means the board was swept before these counters " +
      "existed;\ncounting starts at the next sweep.",
  )
  if (unmatched.length) {
    console.log(
      `\n${unmatched.length} history row(s) matched no board in docs/job-sources.yaml ` +
        `(shown as live=no-board).\nEither the board was removed — history outliving it is intended — ` +
        `or its\nrecorded label differs from the one the audit builds.`,
    )
  }
  if (proposals.length) {
    console.log(
      `\n${proposals.length} board(s) look dead on history. Proposed removals ` +
        `(review first — nothing was changed):`,
    )
    for (const p of proposals) {
      console.log(
        `  node scripts/leads/manage-sources.mjs remove "${p.company ?? p.board_id}"   # ${p.reasons.join("; ")}`,
      )
    }
  } else {
    console.log(`\nNo board meets the removal thresholds.`)
  }
  console.log("")
}

async function main() {
  const args = process.argv.slice(2)
  // STRICT. a bare run performs a LIVE network sweep of every tracked board, so an unrecognised flag must not
  // be ignored. See scripts/lib/args.mjs.
  try {
    assertKnownFlags(args, {
      known: ["--concurrency", "--dead-days", "--history", "--json", "--live", "--min-qualifying", "--min-sweeps", "--query", "--zero-streak", "--help"],
      valueFlags: ["--concurrency", "--dead-days", "--history", "--min-qualifying", "--min-sweeps", "--query", "--zero-streak"],
      script: "board-yield.mjs",
      note: "a bare run performs a LIVE network sweep of every tracked board",
    })
  } catch (e) {
    console.error(e.message)
    process.exit(e.exitCode ?? 2)
  }
  if (args.includes("--history")) return historyMain(args)
  // Comma-separated --query becomes a list here for the same reason it does in
  // cmdSearch: measuring a Workday board with one query measures one slice of
  // it, which is what made three tracked gaming boards look nearly empty.
  const query = parseQueries(getFlag(args, "--query")) ?? DEFAULT_SEARCH_QUERY
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
