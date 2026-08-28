#!/usr/bin/env node
// Cover letters, per reuse cluster rather than per job — and what that costs.
//
// WHY THE LETTER STAYS MODEL-AUTHORED (Phase 3 item 3.3). Everything else in
// the document pipeline is now deterministic: assemble-resume.mjs emits the
// user's own sentences verbatim and takes zero model turns. It is tempting to
// finish the job and template the letter too. Do not. The only field
// experiment on the question — ResumeGo, n=7,287 applications, ~2020 — puts
// tailored letters at 16.4% callbacks against 12.5% for a generic one. That is
// a 31% relative lift on the metric the whole pipeline exists to move, and a
// template throws it away to save a cost this file exists to show is small.
//
// If letter throughput is the bottleneck, SCALE THE CLUSTERING, not the
// quality: one letter per cluster of near-identical postings, not one per job.
// That is what this script plans. `scripts/leads/cluster.mjs` already groups
// leads by 0.5*title + 0.5*stack similarity; this turns those clusters into a
// letter work list — one ANCHOR per cluster, the rest marked as reusing it —
// and prices the result.
//
// THE PRICE IS THE POINT. After Phase 3 this is the only model cost left in
// the system, and it was unpriced. The estimate is computed here rather than
// written in a document so it moves when the inputs move; every constant it
// rests on is declared below with its provenance, and `--json` prints the
// method alongside the number so nobody quotes the total without the basis.
//
// Usage:
//   node scripts/documents/letter-plan.mjs [--status new|all] [--threshold 0.6]
//     [--leads <path>] [--json] [--price-only] [--in <tok>] [--out <tok>]
//     [--in-rate <usd/Mtok>] [--out-rate <usd/Mtok>] [--revisions <n>]
//
// Exit codes: 0 = ran fine, 2 = usage / missing store.
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { isTerse } from "../lib/lib.mjs"
import { clusterLeads } from "../leads/cluster.mjs"
import {
  openDb,
  readLeadStore,
  resolveLeadSource,
  keywordMap,
} from "../lib/db.mjs"

// ---------------------------------------------------------------------------
// The cost model. Every number here is DECLARED, with where it comes from.
// None of them is measured from a live run — no cover letter has been authored
// under this plan yet — so the whole estimate is labelled an estimate and the
// basis travels with it.
// ---------------------------------------------------------------------------
export const COST_MODEL = {
  // INPUT the model reads to write one cluster's letter.
  input_tokens: {
    profile: 2600, // profile.yaml + answers.yaml, the fixture is ~1.4k tok;
    //                 the real one is larger. Rounded up.
    posting: 1200, // the cluster ANCHOR's sanitised description, capped by
    //                 SNIPPET_MAX = 4000 chars ~= 1000 tok, plus title/company.
    shared_terms: 100, // the cluster's `shared` keyword set.
    instructions: 900, // the skill's letter rules and the house style.
    resume: 700, // the assembled resume, so the letter does not repeat it.
    _basis:
      "chars/4 on the real artifacts; profile and instructions dominate and are per-call, not per-job",
  },
  // OUTPUT: one letter is 250-400 words. 350 words ~= 470 tokens; rounded up
  // for the preamble a model writes around it.
  output_tokens: 600,
  // A letter is drafted, verify-claims is run, and in the common case that is
  // it. One revision is budgeted because R6 rejects a term roughly as often as
  // a posting names one the fact base cannot back.
  revisions: 1,
  // Sonnet-class list pricing, USD per million tokens, 2026-08. Letter writing
  // is explicitly NOT frontier work (token discipline 5); the pipeline pins
  // per-job work to Sonnet already.
  usd_per_mtok_in: 3.0,
  usd_per_mtok_out: 15.0,
  _model:
    "sonnet-class, per token discipline 5 (per-job work is Sonnet-pinned)",
}

/**
 * Cost of ONE cluster's letter, and the per-application cost that implies.
 * Pure arithmetic over the model above — no I/O, so a test can pin every term.
 */
export function priceCluster(size = 1, model = COST_MODEL) {
  const inPer = Object.entries(model.input_tokens)
    .filter(([k]) => !k.startsWith("_"))
    .reduce((s, [, v]) => s + v, 0)
  // A revision re-sends the input and re-generates the output.
  const calls = 1 + model.revisions
  const tokens_in = inPer * calls
  const tokens_out = model.output_tokens * calls
  const usd =
    (tokens_in / 1e6) * model.usd_per_mtok_in +
    (tokens_out / 1e6) * model.usd_per_mtok_out
  return {
    tokens_in,
    tokens_out,
    tokens_total: tokens_in + tokens_out,
    usd: Number(usd.toFixed(4)),
    applications: size,
    usd_per_application: Number((usd / Math.max(1, size)).toFixed(4)),
  }
}

/** The same arithmetic over a whole plan. */
export function pricePlan(clusters, model = COST_MODEL) {
  const per = clusters.map((c) => priceCluster(c.size, model))
  const sum = (k) => per.reduce((s, p) => s + p[k], 0)
  const applications = clusters.reduce((s, c) => s + c.size, 0)
  const usd = Number(sum("usd").toFixed(4))
  return {
    clusters: clusters.length,
    applications,
    letters: clusters.length,
    letters_saved: applications - clusters.length,
    tokens_in: sum("tokens_in"),
    tokens_out: sum("tokens_out"),
    tokens_total: sum("tokens_total"),
    usd,
    usd_per_application: Number((usd / Math.max(1, applications)).toFixed(4)),
    usd_per_letter: Number((usd / Math.max(1, clusters.length)).toFixed(4)),
  }
}

/**
 * Clusters -> a letter work list. One anchor per cluster (the leader, which is
 * the best-scoring lead when ranked leads go in), everyone else reuses it.
 */
export function letterPlan(clusters) {
  return clusters.map((c) => ({
    cluster: c.lead_id,
    anchor: {
      id: c.members[0].id,
      company: c.members[0].company,
      title: c.members[0].title,
    },
    reuses: c.members.slice(1).map((m) => ({
      id: m.id,
      company: m.company,
      title: m.title,
      score: m.score,
    })),
    size: c.size,
    shared: c.shared,
    // Named so the approval message can say WHY one letter covers several
    // postings, in the same mechanical terms the resume selection diff uses.
    why: c.shared.length
      ? `all ${c.size} posting(s) share ${c.shared.join(", ")}`
      : `all ${c.size} posting(s) matched on title alone`,
  }))
}

function flag(args, name, dflt = null) {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : dflt
}

function main(argv = process.argv.slice(2)) {
  const model = {
    ...COST_MODEL,
    output_tokens: Number(flag(argv, "--out", COST_MODEL.output_tokens)),
    revisions: Number(flag(argv, "--revisions", COST_MODEL.revisions)),
    usd_per_mtok_in: Number(
      flag(argv, "--in-rate", COST_MODEL.usd_per_mtok_in),
    ),
    usd_per_mtok_out: Number(
      flag(argv, "--out-rate", COST_MODEL.usd_per_mtok_out),
    ),
  }
  const inOverride = flag(argv, "--in", null)
  if (inOverride !== null)
    model.input_tokens = { total: Number(inOverride), _basis: "--in override" }

  // --price-only answers "what does one letter cost?" without a lead store,
  // which is the form the number is usually wanted in.
  if (argv.includes("--price-only")) {
    const one = priceCluster(1, model)
    const four = priceCluster(4, model)
    if (argv.includes("--json"))
      console.log(JSON.stringify({ model, one, four }, null, 2))
    else {
      console.log(
        `one letter: ${one.tokens_in} in + ${one.tokens_out} out = ${one.tokens_total} tok, $${one.usd.toFixed(4)}`,
      )
      console.log(
        `spread over a 4-posting cluster: $${four.usd_per_application.toFixed(4)} per application`,
      )
    }
    return 0
  }

  const leadsPath = flag(argv, "--leads") || resolveLeadSource().file
  if (!fs.existsSync(leadsPath)) {
    console.error(`no lead store at ${leadsPath} — run a search first`)
    process.exit(2)
  }
  const status = flag(argv, "--status", "new")
  const threshold = Number(flag(argv, "--threshold", "0.6"))
  const all = readLeadStore(leadsPath).leads ?? []
  const leads = all.filter((l) => status === "all" || l.status === status)

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
  const plan = letterPlan(clusters)
  const price = pricePlan(clusters, model)
  const perJob = pricePlan(
    leads.map(() => ({ size: 1 })),
    model,
  )

  const out = {
    threshold,
    status,
    leads: leads.length,
    plan,
    price,
    if_written_per_job: { usd: perJob.usd, letters: perJob.letters },
    saved_usd: Number((perJob.usd - price.usd).toFixed(4)),
    model,
    caveat:
      "ESTIMATE. No letter has yet been authored under this plan; every token " +
      "count is declared in COST_MODEL, not measured. Replace with measured " +
      "counts as soon as one real cluster has run.",
  }

  if (argv.includes("--json")) {
    console.log(JSON.stringify(out, null, 2))
    return 0
  }
  if (isTerse()) {
    console.log(
      `leads=${out.leads} clusters=${price.clusters} letters=${price.letters} saved=${price.letters_saved} ` +
        `tok=${price.tokens_total} usd=${price.usd.toFixed(4)} usd_per_app=${price.usd_per_application.toFixed(4)} ` +
        `usd_if_per_job=${perJob.usd.toFixed(4)}`,
    )
    for (const c of plan)
      console.log(
        `letter\t${c.anchor.id}\t${c.size}\t${c.anchor.company}\t${c.anchor.title}\t${c.shared.join(",")}`,
      )
    return 0
  }
  console.log(
    `${price.letters} cover letter(s) cover ${price.applications} application(s) — ${price.letters_saved} letter(s) not written.\n`,
  )
  for (const c of plan) {
    console.log(
      `${c.anchor.company} — ${c.anchor.title}  (${c.size} posting(s))`,
    )
    for (const r of c.reuses)
      console.log(`   reuses: ${r.company} — ${r.title}`)
    console.log(`   ${c.why}`)
  }
  console.log(
    `\nEstimated model cost: $${price.usd.toFixed(4)} total, $${price.usd_per_application.toFixed(4)} per application ` +
      `(${price.tokens_total} tokens). Per-job letters would cost $${perJob.usd.toFixed(4)}.`,
  )
  console.log(`\n${out.caveat}`)
  return 0
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) main()
