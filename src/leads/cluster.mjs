#!/usr/bin/env node
// Which stored leads are the same job wearing different company names?
//
// Tailoring is the one step in this pipeline that a script cannot do — it costs
// a subagent several minutes per posting. Two "Full-Stack Engineer" roles that
// both want React, Node, TypeScript and Postgres do not need two tailoring runs;
// they need one resume and two applications. `lead_keywords` already holds the
// tech terms per lead (extracted at ingest), so grouping is a set comparison,
// not another model read.
//
// Deterministic similarity only. Like reuse-check.mjs this RECOMMENDS — the
// user approves reusing one tailored resume across a cluster.
//
// Usage: node src/leads/cluster.mjs [--status new|all] [--threshold 0.6]
//        [--min-size 2] [--leads <path>] [--json]
//
// Exit codes: 0 = ran fine, 2 = usage / missing store.
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { isTerse, techTermsIn, titleTokens, jaccard } from "#lib/lib.mjs"
import {
  openDb,
  readLeadStore,
  resolveLeadSource,
  keywordMap,
} from "#lib/db.mjs"

// Same 50/50 split reuse-check.mjs scores workspaces with, for the same reason:
// title alone groups a back-end role with a front-end one because both say
// "Engineer", and stack alone groups a senior architect with a junior dev
// because both say "React".
export function similarity(a, b) {
  return 0.5 * jaccard(a.title, b.title) + 0.5 * jaccard(a.keywords, b.keywords)
}

// Greedy leader clustering: each lead joins the first cluster whose LEADER it
// resembles, or starts its own.
//
// Compared against the leader, deliberately, not against any member. Chaining
// (A~B, B~C, A a stranger to C) is how a cluster drifts from "React/Node
// full-stack" to "Go platform engineer" one hop at a time, and the resume
// tailored for the leader is the one every member would actually be sent with.
// Order in, order out: pass ranked leads and the best-scoring lead leads.
export function clusterLeads(leads, { threshold = 0.6, keywords } = {}) {
  const prepared = leads.map((lead) => ({
    lead,
    title: titleTokens(lead.title),
    keywords:
      keywords?.get(lead.id) ??
      new Set(
        techTermsIn(
          [lead.title ?? "", lead.description ?? "", ...(lead.tags ?? [])].join(
            " \n ",
          ),
        ),
      ),
  }))

  const clusters = []
  for (const item of prepared) {
    let best = null
    let bestScore = 0
    for (const c of clusters) {
      const score = similarity(c.leader, item)
      if (score >= threshold && score > bestScore) {
        best = c
        bestScore = score
      }
    }
    const member = {
      id: item.lead.id,
      company: item.lead.company ?? "?",
      title: item.lead.title ?? "?",
      url: item.lead.url ?? null,
      score: Number(bestScore.toFixed(2)),
    }
    if (best) {
      best.members.push(member)
      for (const k of best.shared)
        if (!item.keywords.has(k)) best.shared.delete(k)
    } else {
      clusters.push({
        leader: item,
        lead_id: item.lead.id,
        members: [{ ...member, score: 1 }],
        // What the whole cluster has in common — the terms a single tailored
        // resume has to carry. Narrows as members join.
        shared: new Set(item.keywords),
      })
    }
  }

  return clusters.map((c) => ({
    lead_id: c.lead_id,
    company: c.members[0].company,
    title: c.members[0].title,
    size: c.members.length,
    shared: [...c.shared].sort(),
    members: c.members,
  }))
}

// The leads a cluster makes redundant: everything after the leader. This is the
// number that matters — tailoring runs not paid for.
export function coveredBy(clusters) {
  const covered = new Map()
  for (const c of clusters) {
    for (const m of c.members.slice(1)) covered.set(m.id, c.lead_id)
  }
  return covered
}

function flag(args, name) {
  const i = args.indexOf(name)
  return i !== -1 ? (args[i + 1] ?? true) : null
}

function main() {
  const args = process.argv.slice(2)
  const leadsPath = flag(args, "--leads") || resolveLeadSource().file
  const threshold = Number(flag(args, "--threshold") || 0.6)
  const minSize = Number(flag(args, "--min-size") || 2)
  const status = flag(args, "--status") || "new"

  if (!fs.existsSync(leadsPath)) {
    console.error(`no lead store at ${leadsPath} — run a search first`)
    process.exit(2)
  }

  const all = readLeadStore(leadsPath).leads ?? []
  const leads = all.filter((l) => status === "all" || l.status === status)

  // Keywords come from the table when there is one; a JSON store still works,
  // it just re-extracts them from the description.
  let keywords
  if (leadsPath.endsWith(".db")) {
    const db = openDb(leadsPath)
    try {
      keywords = keywordMap(db)
    } finally {
      db.close()
    }
  }

  const clusters = clusterLeads(leads, { threshold, keywords })
  const grouped = clusters.filter((c) => c.size >= minSize)
  const saved = clusters.reduce((n, c) => n + c.size - 1, 0)

  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        { threshold, leads: leads.length, saved, clusters },
        null,
        2,
      ),
    )
    return
  }
  if (isTerse()) {
    for (const c of grouped) {
      console.log(
        `cluster\t${c.lead_id}\t${c.size}\t${c.company}\t${c.title}\t${c.shared.join(",")}`,
      )
      for (const m of c.members.slice(1)) {
        console.log(`member\t${m.id}\t${m.score}\t${m.company}\t${m.title}`)
      }
    }
    console.log(
      `leads=${leads.length} clusters=${clusters.length} grouped=${grouped.length} saved=${saved} threshold=${threshold}`,
    )
    return
  }
  if (!grouped.length) {
    console.log(
      `No two of the ${leads.length} lead(s) are similar enough to share a resume (threshold ${threshold}).`,
    )
    return
  }
  for (const c of grouped) {
    console.log(`${c.company} — ${c.title}  (${c.size} postings)`)
    for (const m of c.members.slice(1)) {
      console.log(`   ${m.score}  ${m.company} — ${m.title}`)
    }
    if (c.shared.length) console.log(`   shared: ${c.shared.join(", ")}`)
  }
  console.log(
    `\n${saved} tailoring run(s) avoidable across ${grouped.length} cluster(s) — ask before reusing one resume for a cluster.`,
  )
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) main()
