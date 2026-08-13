#!/usr/bin/env node
// Propose new boards for docs/job-sources.yaml — but only ones that can be
// SHOWN to produce a role this profile could actually take. Deterministic.
//
// This is deliberately NOT a bulk slug crawler. On 2026-07-28 the 41 boards
// already tracked carried 8,576 live postings and yielded 18 reachable ones
// (0.21%), and 28 boards yielded zero. Adding companies indiscriminately makes
// that worse twice over: every junk board costs sweep time forever, and its
// postings bury the reachable leads in noise that then costs a model read to
// reject. So a candidate must clear the same yield bar the audit applies to
// existing boards before it is proposed at all.
//
// Reports only — it never edits docs/job-sources.yaml. Adding a board is the
// user's call, via manage-sources.
//
// Usage:
//   node scripts/leads/discover-boards.mjs --candidates <file.yaml|file.json>
//   node scripts/leads/discover-boards.mjs --type greenhouse --slug acme --company "Acme"
//   [--min-solid 1] [--concurrency 6] [--query "full stack"] [--json]
import fs from "node:fs"
import { pathToFileURL } from "node:url"
import path from "node:path"
import yaml from "js-yaml"
import { isTerse, mapPool } from "../lib/lib.mjs"
import { loadSources, loadLimits, fetchBoard } from "./find-jobs.mjs"
import { scoreBoard } from "./board-yield.mjs"

function flag(args, name, fallback = null) {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const boardId = (b) =>
  `${b.type}:${b.slug ?? b.tenant ?? b.host ?? ""}`.toLowerCase()

// Candidate pools, in priority order. These are the three places a board is
// actually likely to clear the bar — see docs in the plan:
//   local     Las Vegas metro. On-site is acceptable, so the WHOLE board
//             counts rather than only its remote reqs, and local employers
//             hire across all levels.
//   levelled  companies that demonstrably post Engineer I/II, Associate,
//             Junior or New Grad titles. If a company has never posted below
//             Senior, brand does not matter — it cannot yield.
//   remote    genuinely remote-US companies (verified from the posting, not
//             from a location field that says "Remote" over an office city).
export const POOLS = ["local", "levelled", "remote"]

const JUNIOR_TITLE =
  /\b(junior|jr\.?|associate|entry|new ?grad|graduate|apprentice|intern|i{1,3}\b|[123]\b)\b/i

// Does this board ever post below Senior? Cheap, and it is the single best
// predictor of whether a company is reachable at ~2.5 years.
export function postsBelowSenior(postings) {
  return postings.some((p) => JUNIOR_TITLE.test(String(p.title ?? "")))
}

export function evaluateCandidate(candidate, postings, limits, now) {
  const row = scoreBoard(candidate, postings, limits, now)
  row.pool = candidate.pool ?? null
  row.posts_below_senior = postsBelowSenior(postings)
  return row
}

function loadCandidates(file) {
  const raw = fs.readFileSync(file, "utf8")
  const doc = file.endsWith(".json") ? JSON.parse(raw) : yaml.load(raw)
  const list = Array.isArray(doc) ? doc : (doc?.candidates ?? doc?.boards ?? [])
  if (!Array.isArray(list) || !list.length)
    throw new Error(`no candidates found in ${file}`)
  return list
}

async function main() {
  const args = process.argv.slice(2)
  const query = flag(args, "--query", "full stack")
  const minSolid = Number(flag(args, "--min-solid", 1))
  const concurrency = Number(flag(args, "--concurrency", 6))
  const asJson = args.includes("--json")
  const file = flag(args, "--candidates")

  let candidates
  if (file) {
    candidates = loadCandidates(file)
  } else {
    const type = flag(args, "--type")
    const slug = flag(args, "--slug")
    const company = flag(args, "--company")
    if (!type || !slug) {
      console.error(
        "usage: discover-boards.mjs --candidates <file> | --type <ats> --slug <slug> [--company X]",
      )
      process.exit(2)
    }
    candidates = [{ type, slug, company: company ?? slug }]
  }

  // Never re-propose something already swept.
  const known = new Set(loadSources().map(boardId))
  const fresh = candidates.filter((c) => !known.has(boardId(c)))
  const dupes = candidates.length - fresh.length

  const limits = loadLimits()
  const now = new Date()
  const t0 = Date.now()
  const rows = await mapPool(fresh, concurrency, async (c) => {
    try {
      return evaluateCandidate(c, await fetchBoard(c, query), limits, now)
    } catch (e) {
      const row = evaluateCandidate(c, [], limits, now)
      row.error = e.message
      return row
    }
  })
  const ms = Date.now() - t0

  const accepted = rows.filter((r) => !r.error && r.solid >= minSolid)
  const rejected = rows.filter((r) => !r.error && r.solid < minSolid)
  const broken = rows.filter((r) => r.error)
  accepted.sort((a, b) => b.solid - a.solid || b.yield - a.yield)

  if (asJson) {
    return console.log(
      JSON.stringify({ ms, accepted, rejected, broken, dupes }, null, 2),
    )
  }

  if (isTerse()) {
    for (const r of accepted)
      console.log(
        `ACCEPT|${r.label}|${r.company}|live=${r.live}|solid=${r.solid}|yield=${r.yield}%|below_senior=${r.posts_below_senior}`,
      )
    // Rejects are printed too: a silent cap reads as "nothing was out there".
    for (const r of rejected)
      console.log(
        `reject|${r.label}|${r.company}|live=${r.live}|solid=${r.solid}|hard=${r.hard_filtered}|loc=${r.location}`,
      )
    for (const r of broken) console.log(`error|${r.label}|${r.error}`)
    return console.log(
      `candidates=${candidates.length} skipped_known=${dupes} accepted=${accepted.length} rejected=${rejected.length} broken=${broken.length} ms=${ms}`,
    )
  }

  console.log(
    `\nChecked ${fresh.length} candidate board(s) in ${(ms / 1000).toFixed(1)}s` +
      (dupes ? ` (${dupes} already tracked, skipped)` : "") +
      `\nBar: at least ${minSolid} live posting that passes every limit.\n`,
  )
  if (accepted.length) {
    console.log(`ACCEPTED — ${accepted.length} board(s) cleared the bar:\n`)
    for (const r of accepted) {
      console.log(
        `  ${r.company} (${r.label})\n` +
          `    ${r.live} live, ${r.solid} reachable (${r.yield}%)` +
          `${r.posts_below_senior ? ", posts below Senior" : ", NEVER posts below Senior"}\n` +
          (r.samples.length ? `    e.g. ${r.samples[0]}\n` : "") +
          `    node scripts/leads/manage-sources.mjs add --type ${r.type} --slug ${r.label.split(":")[1]} --company "${r.company}"\n`,
      )
    }
  } else {
    console.log("ACCEPTED — none. No candidate produced a reachable posting.\n")
  }
  if (rejected.length) {
    console.log(`Rejected (${rejected.length}), with why:`)
    for (const r of rejected) {
      console.log(
        `  ${r.company}: ${r.live} live, 0 reachable — ${r.hard_filtered} over-level/wrong-role, ${r.location} location, ${r.title} off-target title`,
      )
    }
    console.log("")
  }
  if (broken.length) {
    console.log(`Could not fetch (${broken.length}):`)
    for (const r of broken) console.log(`  ${r.company} — ${r.error}`)
    console.log("")
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain)
  main().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
