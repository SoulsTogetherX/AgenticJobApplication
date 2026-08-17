#!/usr/bin/env node
// Rank stored leads against the profile — deterministically, no LLM. This is
// the job the model used to do by reading every lead; now it only interprets
// a short ranked list (or nothing at all, if the user just runs it).
//
// Score = tech overlap with the profile + role-title fit + freshness
//         + salary signal - risk flags.
//
// Usage: node scripts/leads/recommend.mjs [--top N] [--status new|recommended|all]
//        [--json] [--leads <path>] [--profile <path>] [--jobs-dir <path>]
//        [--applicable [--limits <path>]]
//
// --applicable ranks the same way and then lifts the leads the machine can
// actually finish (an apply_url on the user's board_allowlist) above the rest,
// so the top N is a list of things that can be SENT rather than a list of
// things that fit. Measured 2026-08-17: four of the fit-ranked top five were
// Adzuna redirects that canonical.mjs cannot resolve (the host answers 403 to
// robots — a bot wall, not a parser gap, and never to be dressed around); the
// digest read them out every morning as recommendations nothing could act on.
// Each row carries its tier either way; --applicable only changes the order.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { loadYamlFile, isTerse } from "../lib/lib.mjs"
import { extractTech, profileText } from "../profile/profile-gaps.mjs"
import {
  readLeadStore,
  resolveLeadSource,
  openDb,
  keywordMap,
} from "../lib/db.mjs"
import { matchTitleKeyword, loadLimits } from "./find-jobs.mjs"
import { readLimits, normalizeAllowlist } from "../auto/trust.mjs"
import {
  applicability,
  preferApplicable,
  APPLICABILITY_NAMES,
} from "./applicability.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

// The ladder this hardcoded before docs/application-limits.yaml's
// roles.title_rank existed — kept as the fallback so an absent key means
// BYTE-IDENTICAL behaviour, same convention remote_synonyms already uses
// (application-limits.yaml line 30). Each entry is one rank, highest first;
// an entry may be a single phrase or an array of synonyms that TIE at that
// rank — the group below is what let "software engineer", "web developer"
// and bare "developer" share one score today, and a flat list of strings
// alone could not express that.
const DEFAULT_TITLE_RANK = [
  ["full-stack", "full stack", "fullstack"],
  ["back-end", "back end", "backend"],
  ["software engineer", "web developer", "developer"],
]

// Role fit from the title alone, retargetable via
// docs/application-limits.yaml's roles.title_rank (propose, never edited by
// this pipeline — the user owns that file). Position derives the weight:
// rank i of n groups scores (n - i) * 2, so DEFAULT_TITLE_RANK's 3 groups
// reproduce exactly 6 / 4 / 2 / 0 — the ladder this used to hardcode — and a
// differently-sized custom list changes the spread without new numbers.
// Checked in rank order and the FIRST group to match wins (mutually
// exclusive, matching the old if/else-if chain): a title naming both
// "full-stack" and "developer" scores as full-stack, not their sum.
//
// THE BUG THIS REPLACES: this comment used to claim the ladder "comes from
// docs/application-limits.yaml". It did not read that file at all — four
// identically-scored nursing leads (a retarget) silently fell through to
// alphabetical-by-company and were shown as a "ranked" list. Fixed by
// actually reading it, with the software ladder preserved as the fallback.
export function titleScore(title, opts = {}) {
  const groups = opts.limits?.roles?.title_rank ?? DEFAULT_TITLE_RANK
  const t = String(title ?? "")
  const n = groups.length
  for (let i = 0; i < n; i++) {
    const terms = Array.isArray(groups[i]) ? groups[i] : [groups[i]]
    if (matchTitleKeyword(t, terms)) return (n - i) * 2
  }
  return 0
}

export function freshnessScore(postedAt, now = new Date()) {
  if (!postedAt) return 0
  const d = new Date(postedAt)
  if (Number.isNaN(d.getTime())) return 0
  const days = (now.getTime() - d.getTime()) / 86400000
  if (days <= 3) return 4
  if (days <= 7) return 3
  if (days <= 14) return 2
  if (days <= 21) return 1
  return 0
}

const FLAG_PENALTY = {
  remote_unverified: 3,
  unknown_location: 2,
  no_salary: 1,
  unknown_age: 1,
}

// Pure core (exported for tests).
//
// `indexed` is the lead's keyword set from the lead_keywords table, extracted
// once at ingest from title + description + requirements. Passing it in matters
// more than it looks: without it this function sees only `lead.title` and
// `lead.job_text`, and job_text exists ONLY where a job workspace has been
// created. With no live workspaces — the normal state, since closing an
// application folds its directory into the documents table — every lead was
// being ranked on its title alone while 268 indexed keyword rows sat unread.
//
// The two sources are unioned rather than one preferred: the index covers leads
// that have no workspace, and a captured posting is richer than the description
// snippet the sweep stored.
export function scoreLead(
  lead,
  profileTech,
  now = new Date(),
  indexed = null,
  limits = null,
) {
  const text = [lead.title, lead.job_text].filter(Boolean).join("\n")
  const leadTech = new Set([...extractTech(text), ...(indexed ?? [])])
  const overlap = [...leadTech].filter((t) => profileTech.has(t))
  const missing = [...leadTech].filter((t) => !profileTech.has(t))

  let score = 0
  score += overlap.length * 2
  score += titleScore(lead.title, { limits })
  score += freshnessScore(lead.posted_at, now)
  if (lead.salary_max) score += 2
  for (const f of lead.flags ?? []) score -= FLAG_PENALTY[f] ?? 0

  return {
    id: lead.id,
    company: lead.company,
    title: lead.title,
    location: lead.location,
    url: lead.url,
    // The RESOLVED posting, carried through the projection because a consumer
    // that cannot see it cannot tell an applicable lead from a dead one. This
    // is a whitelist, not a spread, so anything it does not name is dropped —
    // and prep-queue.mjs's applicability ranking read `apply_url` off these
    // objects and silently graded every lead manual-only until it was added
    // (caught on the live store 2026-08-09, after the unit tests passed).
    apply_url: lead.apply_url ?? null,
    posted_at: lead.posted_at,
    score,
    matched_tech: overlap.sort(),
    missing_tech: missing.sort(),
    flags: lead.flags ?? [],
  }
}

export function rankLeads(
  leads,
  profileBlob,
  { top = 10, now = new Date(), keywords = null, limits = null } = {},
) {
  const profileTech = extractTech(profileBlob)
  return leads
    .map((l) => scoreLead(l, profileTech, now, keywords?.get(l.id), limits))
    .sort((a, b) => b.score - a.score || a.company.localeCompare(b.company))
    .slice(0, top)
}

// Honest-output guard for the ranking-honesty interim (P2): when every lead in
// the returned list ties, sorting fell through entirely to
// alphabetical-by-company, and the list is NOT a ranking, however it is
// labelled. Measured cause: four nursing leads scored 4, 4, 4, 4 — identical —
// because DEFAULT_TITLE_RANK's software vocabulary matches nothing in a
// retargeted title, so titleScore contributes 0 to every one of them, same as
// every OTHER scoring input tying. Pure length/score check, not tied to any
// one cause, so it still catches a flat list for a reason nobody anticipated.
export function isFlatRanking(ranked) {
  return ranked.length > 1 && ranked.every((r) => r.score === ranked[0].score)
}

function flag(args, name) {
  const i = args.indexOf(name)
  return i !== -1 ? (args[i + 1] ?? true) : null
}

/**
 * The two inputs `rankLeads` needs beyond the leads themselves: the ingest-time
 * keyword index and the user's limits document. Best-effort on both, with a
 * warning rather than an exit, because a ranking without them is degraded and
 * a ranking that refuses to run is worse.
 *
 * ONE FUNCTION, TWO CALLERS, and that is the point. prep-queue.mjs called
 * `rankLeads` with neither, so the same lead scored 19 here and 5 there —
 * measured 2026-08-17 on Torc Robotics — and the cycle, which is fed by
 * prep-queue, ranked on the degraded numbers while the human read the full
 * ones. Two rankers producing two numbers for one lead is a bug whatever the
 * numbers are; sharing the inputs is how they stay one ranker.
 *
 * Keywords were already extracted at ingest; re-deriving them from every stored
 * description on every run is work the store has already done. Only available
 * on the database store — a JSON fixture (what the tests point at) falls back
 * to deriving from the text. Limits are optional too: an absent/unreadable file
 * falls back to loadLimits' own built-in defaults, which is what keeps
 * titleScore's DEFAULT_TITLE_RANK fallback reachable rather than throwing.
 */
export function rankingContext(leadsPath, { warn = console.error } = {}) {
  let keywords = null
  if (String(leadsPath ?? "").endsWith(".db")) {
    try {
      const db = openDb(leadsPath)
      try {
        keywords = keywordMap(db)
      } finally {
        db.close()
      }
    } catch (e) {
      warn(`warn: keyword index unavailable (${e.message})`)
    }
  }
  let limits = null
  try {
    limits = loadLimits()
  } catch (e) {
    warn(`warn: application-limits.yaml unavailable (${e.message})`)
  }
  return { keywords, limits }
}

// Attach the captured posting text when a job workspace exists — richer than
// the title alone.
export function withJobText(leads, jobsDir) {
  if (!fs.existsSync(jobsDir)) return leads
  const texts = new Map()
  for (const slug of fs.readdirSync(jobsDir)) {
    const f = path.join(jobsDir, slug, "job.json")
    if (!fs.existsSync(f)) continue
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf8"))
      if (j.source_url) {
        texts.set(
          j.source_url,
          [j.description, ...(j.requirements ?? [])].join("\n"),
        )
      }
    } catch {}
  }
  return leads.map((l) => ({ ...l, job_text: texts.get(l.url) }))
}

function main() {
  const args = process.argv.slice(2)
  // Defaults to jobs/leads.db when it exists, else the legacy JSON store.
  // An explicit --leads is honoured verbatim so tests can use fixtures.
  const leadsPath = flag(args, "--leads") || resolveLeadSource().file
  const profilePath =
    flag(args, "--profile") || path.join(ROOT, "profile", "profile.yaml")
  const jobsDir = flag(args, "--jobs-dir") || path.join(ROOT, "jobs")
  const top = Number(flag(args, "--top") || 10)
  const status = flag(args, "--status") || "new"

  if (!fs.existsSync(profilePath)) {
    console.error(`profile not found at ${profilePath}`)
    process.exit(2)
  }
  if (!fs.existsSync(leadsPath)) {
    console.error(`no lead store at ${leadsPath} — run a search first`)
    process.exit(2)
  }
  const all = readLeadStore(leadsPath).leads ?? []
  const leads = withJobText(
    all.filter((l) => status === "all" || l.status === status),
    jobsDir,
  )
  if (!leads.length) {
    console.error(`no leads with status "${status}"`)
    process.exit(2)
  }

  const { keywords, limits } = rankingContext(leadsPath)
  const applicable = args.includes("--applicable")
  const limitsPath =
    flag(args, "--limits") || path.join(ROOT, "docs", "application-limits.yaml")
  const allow = normalizeAllowlist(
    readLimits(limitsPath)?.auto_apply?.board_allowlist,
  )
  const profileBlob = profileText(loadYamlFile(profilePath))
  // --applicable: rank EVERYTHING, lift what the machine can finish, then cut.
  // Cutting first and lifting inside the window is the defect prep-queue had
  // (see its header); the same order is used here on purpose.
  const ranked = applicable
    ? preferApplicable(
        rankLeads(leads, profileBlob, { top: leads.length, keywords, limits }),
        allow,
      ).slice(0, top)
    : rankLeads(leads, profileBlob, { top, keywords, limits })
  const tierOf = (r) => APPLICABILITY_NAMES[applicability(r, allow)]
  // Ties mean the sort fell through to alphabetical-by-company — a flat list
  // labelled as ranked is worse than a flat list labelled as flat (P2 interim,
  // retarget-readiness audit 2026-08). This is checked on every output mode
  // except --json, which is a raw data dump for a caller who has the scores
  // themselves and can compute this the same way.
  const flat = isFlatRanking(ranked)

  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        ranked.map((r) => ({ ...r, applicability: tierOf(r) })),
        null,
        2,
      ),
    )
    return
  }
  if (isTerse()) {
    for (const r of ranked) {
      console.log(
        `${r.score}|${r.id}|${r.company}|${r.title}|match:${r.matched_tech.join(",") || "-"}|gap:${r.missing_tech.join(",") || "-"}|${tierOf(r)}|${r.apply_url ?? r.url}`,
      )
    }
    console.log(
      `ranked=${ranked.length} of=${leads.length}${applicable ? " applicable=true" : ""}${flat ? " flat=true" : ""}`,
    )
    return
  }
  if (flat) {
    console.log(
      `NOTE: every lead below scored identically (${ranked[0].score}) — this is ` +
        `NOT a ranking, it fell through to alphabetical order by company. ` +
        `titleScore currently only distinguishes software-engineering titles ` +
        `(roles.title_rank in docs/application-limits.yaml); if the target role ` +
        `changed, that list needs updating for these results to mean anything.\n`,
    )
  }
  for (const r of ranked) {
    console.log(
      `[${r.score}] ${r.company} — ${r.title}\n  ${r.location || "location?"} | ${tierOf(r)} | matches: ${r.matched_tech.join(", ") || "none"}\n  ${r.apply_url ?? r.url}`,
    )
  }
  console.log(
    `\nTop ${ranked.length} of ${leads.length} lead(s) with status "${status}"${flat ? " — UNRANKED (all tied)" : ""}.`,
  )
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) main()
