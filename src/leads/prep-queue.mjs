#!/usr/bin/env node
// Which leads are worth tailoring BEFORE the user sits down to apply.
//
// Tailoring a resume takes a subagent a few minutes. Doing it at apply time
// puts that on the critical path with the user watching; doing it during the
// nightly sweep makes applying a fill-and-review step instead. This script
// picks the targets — it does no tailoring itself (that needs a model).
//
// A lead is queued when it ranks well, has not been applied to, and has no
// verified tailored resume yet.
//
// Usage: node src/leads/prep-queue.mjs [--top N] [--status new|all] [--json]
//        [--leads <path>] [--profile <path>] [--jobs-dir <path>]
//        [--applications <path>] [--limits <path>] [--cluster [--threshold 0.6]]
//        [--by-score] [--include-rejected]
//
// --cluster collapses near-duplicate postings (cluster.mjs) so a group that one
// tailored resume can serve costs one queue slot, not four.
//
// Leads whose stored screening verdict is `reject` are LEFT OUT and counted
// (`screened_out=N`); --include-rejected puts them back.
//
// Leads are ordered by APPLICABILITY first and fit second — see the block above
// `applicability()`. --by-score restores the old fit-only ordering.
//
// Exit codes: 0 ok, 2 usage / missing store.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { loadYamlFile, isTerse } from "#lib/lib.mjs"
import { profileText } from "../profile/profile-gaps.mjs"
import { rankLeads, rankingContext } from "./recommend.mjs"
import { clusterLeads, coveredBy } from "./cluster.mjs"
import {
  readLeadStore,
  resolveLeadSource,
  latestScreenVerdicts,
} from "#lib/db.mjs"
import { readApplications } from "#lib/db.mjs"
import { readLimits, normalizeAllowlist } from "../auto/trust.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

const norm = (s) =>
  String(s ?? "")
    .trim()
    .toLowerCase()
const companyTitleKey = (x) => `${norm(x.company)}::${norm(x.title)}`

// Index every job workspace by the posting URL it was created from, so a lead
// can be told apart from an untouched one without guessing at slug naming.
export function indexWorkspaces(jobsDir) {
  const byUrl = new Map()
  if (!fs.existsSync(jobsDir)) return byUrl
  for (const slug of fs.readdirSync(jobsDir)) {
    const jobFile = path.join(jobsDir, slug, "job.json")
    if (!fs.existsSync(jobFile)) continue
    let job
    try {
      job = JSON.parse(fs.readFileSync(jobFile, "utf8"))
    } catch {
      continue
    }
    let ctx = null
    const ctxFile = path.join(jobsDir, slug, "context.json")
    if (fs.existsSync(ctxFile)) {
      try {
        ctx = JSON.parse(fs.readFileSync(ctxFile, "utf8"))
      } catch {}
    }
    const entry = {
      slug,
      company: job.company,
      title: job.title,
      resume_status: ctx?.resume?.status ?? null,
      cover_status: ctx?.cover_letter?.status ?? null,
    }
    if (job.source_url) byUrl.set(job.source_url, entry)
  }
  return byUrl
}

// "verified" is the status verify-claims sets once a tailored doc passes; only
// then is there nothing left to pre-compute. "rendered"/"approved" are later
// states and equally done.
const DONE_STATUSES = new Set(["verified", "approved", "rendered"])

// --- applicability: lives in applicability.mjs, re-exported here ----------------
//
// The tiers, `applicability()` and `preferApplicable()` moved out on 2026-08-17 so
// recommend.mjs could use them without a static import cycle (prep-queue
// imports rankLeads from recommend). Re-exported so every existing caller and
// test keeps its import path.
export {
  APPLICABILITY,
  APPLICABILITY_NAMES,
  applicability,
  preferApplicable,
} from "./applicability.mjs"
import {
  applicability,
  preferApplicable,
  APPLICABILITY,
  APPLICABILITY_NAMES,
} from "./applicability.mjs"

// Pure core (exported for tests).
//
// `covered` maps a lead id to the id of the cluster leader that stands in for
// it (src/leads/cluster.mjs). A covered lead never earns its own tailoring
// run — the resume tailored for its leader is the one it would be sent with —
// so it is attached to the leader's entry as `covers` instead of queued.
export function buildQueue(
  rankedLeads,
  {
    workspaces = new Map(),
    applied = [],
    top = 5,
    covered = new Map(),
    allowlist = [],
  } = {},
) {
  const appliedKeys = new Set(applied.map(companyTitleKey))
  const queue = []
  const byLeader = new Map()
  for (const lead of rankedLeads) {
    const leader = covered.get(lead.id)
    if (leader) {
      // Checked before the `top` cut-off, not after: a cluster's members are
      // ranked below its leader by construction, so stopping at the cut-off
      // would hide exactly the postings the queued run already serves.
      byLeader.get(leader)?.covers.push({
        id: lead.id,
        company: lead.company,
        title: lead.title,
        url: lead.url,
      })
      continue
    }
    if (queue.length >= top) continue
    if (appliedKeys.has(companyTitleKey(lead))) continue

    const ws = workspaces.get(lead.url)
    if (ws && DONE_STATUSES.has(ws.resume_status)) continue

    const entry = {
      id: lead.id,
      company: lead.company,
      title: lead.title,
      url: lead.url,
      score: lead.score,
      slug: ws?.slug ?? null,
      // How far the machine can carry it, and the resolved posting when there
      // is one. Reported so a queue full of hand-apply-only leads is visible as
      // that, rather than looking like a run that simply prepared nothing.
      applicability: APPLICABILITY_NAMES[applicability(lead, allowlist)],
      apply_url: lead.apply_url ?? null,
      // Other postings one tailoring run for this lead also covers.
      covers: [],
      // Why this one needs work — the pipeline uses it to decide whether to
      // create a workspace first or just run the tailoring step.
      reason: !ws
        ? "no_workspace"
        : ws.resume_status
          ? `resume_${ws.resume_status}`
          : "no_resume",
    }
    queue.push(entry)
    byLeader.set(lead.id, entry)
  }
  return queue
}

function flag(args, name) {
  const i = args.indexOf(name)
  return i !== -1 ? (args[i + 1] ?? true) : null
}

function main() {
  const args = process.argv.slice(2)
  // Defaults to jobs/leads.db when it exists, else the legacy JSON store.
  const leadsPath = flag(args, "--leads") || resolveLeadSource().file
  const profilePath =
    flag(args, "--profile") || path.join(ROOT, "profile", "profile.yaml")
  const jobsDir = flag(args, "--jobs-dir") || path.join(ROOT, "jobs")
  const appsPath =
    flag(args, "--applications") ||
    path.join(ROOT, "profile", "applications.yaml")
  const limitsPath =
    flag(args, "--limits") || path.join(ROOT, "docs", "application-limits.yaml")
  const top = Number(flag(args, "--top") || 5)
  const status = flag(args, "--status") || "new"

  if (!fs.existsSync(leadsPath)) {
    console.error(`no lead store at ${leadsPath} — run a search first`)
    process.exit(2)
  }
  if (!fs.existsSync(profilePath)) {
    console.error(`profile not found at ${profilePath}`)
    process.exit(2)
  }

  const all = readLeadStore(leadsPath).leads ?? []
  const leads = all.filter((l) => status === "all" || l.status === status)

  // THE SAME INPUTS recommend.mjs ranks with — the ingest-time keyword index
  // and the user's limits. Without them the same lead scored 19 there and 5
  // here (Torc Robotics, 2026-08-17), and this file is what the cycle is fed
  // by, so the machine ranked on the degraded numbers while the human read
  // the full ones.
  const { keywords, limits } = rankingContext(leadsPath)

  // RANK EVERYTHING, PARTITION, THEN WINDOW — in that order, and the order is
  // the fix. This used to rank `max(top*4, 20)` by score FIRST and partition
  // by applicability inside that window. Measured 2026-08-17: at the default
  // --top 5 the twenty-by-score were all aggregator leads with no apply_url,
  // so the queue printed `manual_only=5 automatable=0` while seventeen
  // automatable leads sat just below the window; `--top 20` (window = whole
  // store) showed them. Partitioning first means the window is spent on the
  // leads the machine can finish, and score order still decides within a tier.
  const byScore = rankLeads(leads, profileText(loadYamlFile(profilePath)), {
    top: leads.length,
    keywords,
    limits,
  })

  // Reorder by how far the machine can carry each one. The user's own
  // allowlist is the authority for tier 0 — this reads that file and never
  // second-guesses it. `--by-score` restores the pure fit ordering.
  const entries = normalizeAllowlist(
    readLimits(limitsPath)?.auto_apply?.board_allowlist,
  )
  const applicable = args.includes("--by-score")
    ? byScore
    : preferApplicable(byScore, entries)

  // A LEAD SCREENING ALREADY REJECTED IS NOT WORTH A PREP SLOT (2026-08-18).
  // The queue used to be built from `status === "new"` alone and never read the
  // `screens` table, so a lead screen.mjs had rejected as stale, over the
  // experience bar or instruction-shaped still ranked into the top of the
  // queue; the cycle then either spent tailoring on it (and the runner refused
  // it at the trust gate) or, when the gate ran first, skipped it and printed
  // a shorter queue than it asked for. Measured 2026-08-17: three of the top
  // twenty. The verdict read here is the SAME one the runner reads (model
  // first, mechanical fallback), so what this drops is exactly what the gate
  // would refuse. Dropped rather than ranked down, because a rejected lead is
  // not "hand-apply only" — it is a lead the pipeline has decided against —
  // and it is COUNTED, so a queue that shrank says why. --include-rejected
  // restores the old behaviour for someone re-checking a verdict.
  let screenedOut = 0
  let ordered = applicable
  if (!args.includes("--include-rejected")) {
    let verdicts = new Map()
    try {
      verdicts = latestScreenVerdicts(leadsPath)
    } catch {
      /* an unreadable screens table leaves the queue as it was — the runner's
         own gate still refuses a rejected lead */
    }
    const rejected = (l) => verdicts.get(l.id)?.verdict === "reject"
    screenedOut = applicable.filter(rejected).length
    ordered = applicable.filter((l) => !rejected(l))
  }
  // Generous, then filtered — the top few are often already tailored, and we
  // still want a full queue underneath them.
  const ranked = ordered.slice(0, Math.max(top * 4, 20))

  const applied = readApplications(
    appsPath.endsWith("applications.yaml") ? null : appsPath,
  )

  // Clustering runs over the RANKED list so the best-scoring posting of each
  // group leads it — that is the one worth tailoring for.
  let covered = new Map()
  if (args.includes("--cluster")) {
    covered = coveredBy(
      clusterLeads(ranked, {
        threshold: Number(flag(args, "--threshold") || 0.6),
        keywords,
      }),
    )
  }

  const queue = buildQueue(ranked, {
    workspaces: indexWorkspaces(jobsDir),
    applied,
    top,
    covered,
    allowlist: entries,
  })
  // Cluster members whose leader did not make the queue (already applied to,
  // already tailored, or below the cut-off) are served by an existing resume
  // and are not silently gone — they are counted here.
  const attached = queue.reduce((n, q) => n + q.covers.length, 0)
  const suppressed = covered.size - attached

  if (args.includes("--json")) {
    console.log(JSON.stringify(queue, null, 2))
    return
  }
  // Counted per tier so "queued=10" can never again mean ten leads none of
  // which the machine could finish.
  const tally = (name) => queue.filter((q) => q.applicability === name).length
  // And the same three over the WHOLE ranked supply, not just the queue: a
  // line reading `manual_only=5` used to be the whole story, and the story
  // was that seventeen automatable leads sat outside the window (2026-08-17).
  const supplyTier = (t) =>
    ordered.filter((l) => applicability(l, entries) === t).length
  const tiers =
    ` automatable=${tally("automatable")}` +
    ` off_allowlist=${tally("off-allowlist")}` +
    ` manual_only=${tally("manual-only")}` +
    ` supply=${supplyTier(APPLICABILITY.AUTOMATABLE)}/` +
    `${supplyTier(APPLICABILITY.RESOLVED_OFF_ALLOWLIST)}/` +
    `${supplyTier(APPLICABILITY.MANUAL_ONLY)}`

  if (isTerse()) {
    for (const q of queue) {
      console.log(
        `${q.score}\t${q.reason}\t${q.applicability}\t${q.slug ?? "-"}\t${q.company}\t${q.title}\t${q.url}` +
          (q.covers.length ? `\tcovers=${q.covers.length}` : ""),
      )
      for (const c of q.covers) {
        console.log(`covers\t${c.id}\t${c.company}\t${c.title}\t${c.url}`)
      }
    }
    console.log(
      `queued=${queue.length} ranked=${ranked.length}${tiers}` +
        ` screened_out=${screenedOut}` +
        (covered.size
          ? ` clustered=${attached} covered_elsewhere=${suppressed}`
          : ""),
    )
    return
  }
  if (!queue.length) {
    console.log(
      "Nothing to pre-tailor — the top leads already have verified resumes.",
    )
    return
  }
  for (const q of queue) {
    console.log(
      `[${q.score}] ${q.company} — ${q.title}\n  ${q.reason} · ${q.applicability}${q.slug ? ` (${q.slug})` : ""}\n  ${q.apply_url ?? q.url}`,
    )
    for (const c of q.covers) {
      console.log(`  also covers: ${c.company} — ${c.title}`)
    }
  }
  console.log(
    `\n${queue.length} lead(s) ready to pre-tailor` +
      (attached
        ? `, covering ${attached} further posting(s) with the same resume.`
        : ".") +
      (suppressed > 0
        ? `\n${suppressed} more are covered by a resume that already exists.`
        : "") +
      (screenedOut > 0
        ? `\n${screenedOut} lead(s) screening already rejected were left out (--include-rejected to see them).`
        : ""),
  )
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) main()
