#!/usr/bin/env node
// "What are the jobs asking for that I have but never wrote down?"
//
// profile-gaps.mjs already answers the harsher question — what is demanded and
// NOT evidenced — and treats every one of those as a learning gap. But most of
// that list is not a gap at all. Someone who has shipped React and Node.js has
// almost certainly written an Express route, run Jest, and built a REST
// endpoint; those simply never made it into profile.yaml. Meanwhile
// verify-claims R6 correctly refuses to let a tailored resume mention any tech
// the fact base cannot back, so an unrecorded skill is an invisible skill.
//
// Three buckets, and the middle one is the point:
//
//   covered  demanded and evidenced -> already usable in a tailored resume
//   ask      demanded, NOT evidenced, but close to something evidenced
//            -> probably yours; confirm and record it
//   gap      demanded, not evidenced, not close to anything -> a learning gap
//
// Two routes into `ask`, and they are labelled differently because they are
// different strengths of claim:
//   "adjacent"   a hand-checked edge in the lexicon (React -> Redux). Strong.
//   "same-area"  you evidence several skills in this group already. Weak, and
//                only offered because the adjacency map is hand-maintained and
//                therefore incomplete. Shown last.
//
// DEMAND IS NOT ONE NUMBER. A skill listed under "Minimum Qualifications" is a
// different thing from one under "Nice to have", so demand is counted twice:
// `required` (read live from each description via the same splitRequirements
// the L2 fit stage uses) and `total` (from lead_keywords). Ranking is by
// required first — that is the difference between "you cannot apply without
// this" and "it would be nice".
//
// This NEVER writes to profile/. CLAUDE.md rule 2: the agent does not edit the
// fact base. It prints the save-answer.mjs command; the user answers in chat.
//
// Usage:
//   node scripts/profile/keyword-coverage.mjs [--min-demand 2] [--top 40]
//        [--include-dismissed] [--job jobs/<slug>/job.json] [--json]
//        [--profile <p>] [--answers <a>] [--leads <l>]
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { loadYamlFile, isTerse, evidenceText } from "../lib/lib.mjs"
import { extractTech, adjacentTo, SKILL_BY_NAME } from "../lib/keywords.mjs"
import { splitRequirements } from "../leads/fit.mjs"
import { profileText } from "./profile-gaps.mjs"
import {
  readLeadStore,
  resolveLeadSource,
  openDb,
  keywordMap,
} from "../lib/db.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

function flag(args, name, fallback = null) {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

// How many evidenced skills in the same group it takes before "you have four
// Backend skills, you have probably touched this fifth one" is worth ASKING.
//
// This is a deliberately weaker claim than an adjacency edge and is labelled as
// such in the output. It exists because adjacency is a hand-maintained map with
// ~180 edges over 142 skills, so it is necessarily incomplete, and a skill that
// 10 postings REQUIRE is worth one question even on a weak hunch. It never
// asserts anything — the user still answers.
const GROUP_AFFINITY_MIN = 4

// Pure core (exported for tests).
//   demand    Map<skill, {required, total}> — or Map<skill, number>, which is
//             read as {required: 0, total: n} so older callers keep working
//   evidenced Set<skill>                    — what the fact base can back
//
// Ranking is by REQUIRED demand first, then total. A skill ten postings list
// under "Minimum Qualifications" is a different thing from one ten postings
// list under "Nice to have", and counting them the same is what this function
// used to do — it took a flat count out of lead_keywords, which indexes a
// posting's whole text with no idea which half a term came from.
export function coverage(demand, evidenced, { minDemand = 2 } = {}) {
  // Adjacency is computed from what the user ALREADY has, not from what is
  // demanded: the claim is "you have React, so you probably have Redux", never
  // "the market wants Redux, so you probably have it".
  const suggestions = adjacentTo([...evidenced], evidenced)

  // Group affinity, same direction: derived from the evidenced set only.
  const evidencedPerGroup = new Map()
  for (const s of evidenced) {
    const g = SKILL_BY_NAME.get(s)?.group
    if (!g) continue
    evidencedPerGroup.set(g, (evidencedPerGroup.get(g) ?? 0) + 1)
  }

  const covered = []
  const ask = []
  const gap = []

  for (const [skill, raw] of demand) {
    const d = typeof raw === "number" ? { required: 0, total: raw } : raw
    // max, NOT total. The two counts come from different places and either can
    // be zero while the other is large: lead_keywords is indexed once at ingest,
    // so any skill added to the lexicon since the last sweep has total = 0 while
    // its required count is read live from the descriptions. Gating on total
    // alone silently dropped System design at required = 8 — the single most
    // required skill in the store — because the index predated the term.
    if (Math.max(d.total, d.required) < minDemand) continue
    const group = SKILL_BY_NAME.get(skill)?.group
    const row = {
      skill,
      demand: d.total,
      required_demand: d.required,
      group,
    }
    if (evidenced.has(skill)) {
      covered.push(row)
    } else if (suggestions.has(skill)) {
      // Why we think it is probably theirs — shown so the user can judge the
      // suggestion rather than take it on faith.
      ask.push({
        ...row,
        confidence: "adjacent",
        implied_by: suggestions.get(skill),
      })
    } else if ((evidencedPerGroup.get(group) ?? 0) >= GROUP_AFFINITY_MIN) {
      ask.push({
        ...row,
        confidence: "same-area",
        implied_by: [`${evidencedPerGroup.get(group)} other ${group} skills`],
      })
    } else {
      gap.push(row)
    }
  }

  // Required demand dominates: it is the difference between "you cannot apply
  // without this" and "it would be nice".
  const rank = (a, b) =>
    b.required_demand - a.required_demand ||
    b.demand - a.demand ||
    a.skill.localeCompare(b.skill)
  // Within ask, a real adjacency edge outranks a same-area hunch.
  const rankAsk = (a, b) =>
    (a.confidence === "adjacent" ? 0 : 1) - (b.confidence === "adjacent" ? 0 : 1) ||
    rank(a, b)
  return {
    covered: covered.sort(rank),
    ask: ask.sort(rankAsk),
    gap: gap.sort(rank),
  }
}

// The command that would record an answer, once the user confirms it is true.
export function saveCommand(skill) {
  const q = `Do you have hands-on experience with ${skill}?`
  return `node scripts/profile/save-answer.mjs "${q}" "<your answer>"`
}

// Demand counts, split by whether a posting REQUIRED the skill or merely
// preferred it.
//
// Two passes, because they see different things and neither alone is enough:
//
//   lead_keywords   indexed once at ingest from a posting's whole text. Cheap
//                   (a GROUP BY, no re-parsing) and it still covers leads whose
//                   description was never stored. But it has no idea which HALF
//                   of the posting a term came from.
//   the description the required/nice-to-have split, via the same
//                   splitRequirements the L2 fit stage uses. Only available
//                   where a description was stored, which is 92 of 102 leads.
//
// So total demand comes from the index and required demand comes from the text.
// A skill ten postings list under "Minimum Qualifications" is a different thing
// from one ten postings list under "Nice to have"; ranking them together was
// this report's biggest blind spot.
export function gatherDemand({
  leadsPath,
  includeDismissed = false,
  jobFile = null,
  jobWeight = 3,
}) {
  const demand = new Map()
  const bump = (t, { required = 0, total = 0 }) => {
    const d = demand.get(t) ?? { required: 0, total: 0 }
    d.required += required
    d.total += total
    demand.set(t, d)
  }

  if (fs.existsSync(leadsPath)) {
    // A dismissed lead is a posting already judged not worth pursuing, so by
    // default it does not get a vote on what to learn next. --include-dismissed
    // brings them back for a wider view of the market.
    const leads = (readLeadStore(leadsPath).leads ?? []).filter(
      (l) => includeDismissed || l.status !== "dismissed",
    )
    const keep = new Set(leads.map((l) => l.id))

    let indexed = new Map()
    if (String(leadsPath).endsWith(".db")) {
      try {
        const db = openDb(leadsPath)
        try {
          indexed = keywordMap(db)
        } finally {
          db.close()
        }
      } catch (e) {
        console.error(`warn: keyword index unavailable (${e.message})`)
      }
    }
    for (const [leadId, terms] of indexed) {
      if (!keep.has(leadId)) continue
      for (const t of terms) bump(t, { total: 1 })
    }
    for (const l of leads) {
      // Leads with nothing indexed still contribute their title.
      if (!indexed.get(l.id)?.size) {
        for (const t of extractTech(l.title ?? "")) bump(t, { total: 1 })
      }
      // The required half, where there is text to read.
      const body = [l.description, ...(l.requirements ?? [])]
        .filter(Boolean)
        .join("\n")
      if (!body) continue
      const parts = splitRequirements(body)
      // Only count a REQUIRED section that was actually found. Falling back to
      // the general text here would mark every term in an unstructured posting
      // as required, which is exactly the flattening this pass exists to undo.
      if (!parts.required) continue
      for (const t of extractTech(parts.required)) bump(t, { required: 1 })
    }
  }

  // A specific posting counts heavily: it is the job actually being applied to,
  // and its required section counts as required.
  if (jobFile && fs.existsSync(jobFile)) {
    const j = JSON.parse(fs.readFileSync(jobFile, "utf8"))
    const body = [j.description, ...(j.requirements ?? [])]
      .filter(Boolean)
      .join("\n")
    for (const t of extractTech(`${j.title ?? ""}\n${body}`)) {
      bump(t, { total: jobWeight })
    }
    const parts = splitRequirements(body)
    for (const t of extractTech(parts.required || body)) {
      bump(t, { required: jobWeight })
    }
  }
  return demand
}

function main() {
  const args = process.argv.slice(2)
  const profilePath =
    flag(args, "--profile") || path.join(ROOT, "profile", "profile.yaml")
  const answersPath =
    flag(args, "--answers") || path.join(ROOT, "profile", "answers.yaml")
  const leadsPath = flag(args, "--leads") || resolveLeadSource().file
  const jobFile = flag(args, "--job")
  const minDemand = Number(flag(args, "--min-demand", 2))
  const top = Number(flag(args, "--top", 40))
  // Was --status, which read backwards: "--status all" meant "include
  // dismissed" and anything else meant "exclude" — so "--status new" silently
  // counted recommended and applied leads too. Named for what it does now.
  const includeDismissed = args.includes("--include-dismissed")
  const asJson = args.includes("--json")

  if (!fs.existsSync(profilePath)) {
    console.error(`profile not found at ${profilePath}`)
    process.exit(2)
  }

  // Evidence = what the fact base can actually back. An answer the user gave is
  // exactly as citable as a profile bullet, and answers.yaml is where this
  // script's own suggestions end up once confirmed.
  //
  // evidenceText, NOT the raw file: answers.yaml stores each form QUESTION
  // beside its answer, and a question reading "[... 5 = Cloud Technologies
  // (AWS, Azure, or GCP)]" is not evidence of Azure. Counting it as such would
  // mark a genuine gap as already covered and hide it from this report — the
  // exact opposite of the job. Same rule verify-claims R6 applies.
  const blob = evidenceText(
    profileText(loadYamlFile(profilePath)),
    fs.existsSync(answersPath) ? loadYamlFile(answersPath) : { answers: [] },
  )
  const evidenced = extractTech(blob)

  const demand = gatherDemand({ leadsPath, includeDismissed, jobFile })
  const out = coverage(demand, evidenced, { minDemand })
  out.ask = out.ask.slice(0, top)
  out.gap = out.gap.slice(0, top)

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          ...out,
          commands: out.ask.map((r) => saveCommand(r.skill)),
          evidenced: [...evidenced].sort(),
        },
        null,
        2,
      ),
    )
    return
  }

  if (isTerse()) {
    for (const r of out.ask) {
      console.log(
        `ask|${r.skill}|req=${r.required_demand}|total=${r.demand}|${r.confidence}|${r.implied_by.join(",")}`,
      )
    }
    for (const r of out.gap) {
      console.log(`gap|${r.skill}|req=${r.required_demand}|total=${r.demand}`)
    }
    console.log(
      `covered=${out.covered.length} ask=${out.ask.length} gap=${out.gap.length}`,
    )
    return
  }

  console.log(
    `\n${out.covered.length} demanded skill(s) already evidenced in your profile.\n`,
  )
  const askedBy = (r) =>
    r.required_demand
      ? `REQUIRED by ${r.required_demand} posting(s), mentioned by ${r.demand}`
      : `mentioned by ${r.demand} posting(s), none as a hard requirement`

  if (out.ask.length) {
    console.log(
      "PROBABLY YOURS — demanded, close to what you already have, but not\n" +
        "recorded anywhere. Until one of these is in the fact base, no tailored\n" +
        "resume is allowed to mention it (verify-claims R6).\n",
    )
    for (const r of out.ask) {
      const how =
        r.confidence === "adjacent"
          ? `you already have: ${r.implied_by.join(", ")}`
          : `weaker hunch — you have ${r.implied_by.join(", ")}`
      console.log(`  ${r.skill}  (${askedBy(r)})`)
      console.log(`    ${how}`)
      console.log(`    ${saveCommand(r.skill)}\n`)
    }
    console.log("Confirm each one before recording it — a guess is not a fact.\n")
  } else {
    console.log("Nothing to confirm: every nearby demanded skill is recorded.\n")
  }
  if (out.gap.length) {
    console.log(
      "GENUINE GAPS — demanded, and not close to anything you have.\n" +
        "Ordered by how often a posting made it a hard requirement, which is a\n" +
        'different question from how often it was mentioned:\n',
    )
    for (const r of out.gap) console.log(`  ${r.skill}  (${askedBy(r)})`)
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) main()
