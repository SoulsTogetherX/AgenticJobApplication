// The screening pipeline as an ordered list of named stages.
//
// Before this, the same decisions were spread across three places with no
// shared vocabulary: passesLimits and bodyDisqualifiers ran inside
// find-jobs.mjs' ingest(), screen.mjs ran a separate mix of scam/seniority/ghost
// checks afterwards, and nothing recorded WHICH check had discarded a posting.
// "Why did I never see this job?" was not an answerable question.
//
// Stages run cheapest-first and stop at the first rejection, because the whole
// design is that an expensive check only ever sees what the cheap ones let
// through:
//
//   L0 title  board list payload only (title, location, date, salary).
//             Free. Discards thousands.
//   L1 body   hard disqualifiers stated in the description. Needs the text,
//             which for four ATS types costs one fetch per surviving posting.
//   L2 fit    can this profile actually do this job? Free, given L1's text.
//   L3 risk   is this job real? scam / ghost / repost signals. Free.
//
// A stage returns { ok, reasons[], flags[], ...extra }. Rejection reasons are
// prefixed with the stage id so a stored verdict says who decided.

import { passesLimits, bodyDisqualifiers } from "./find-jobs.mjs"
import { scoreFit } from "./fit.mjs"
import { scoreRisk } from "./risk.mjs"

export const STAGE_IDS = ["l0", "l1", "l2", "l3"]

export const STAGE_LABELS = {
  l0: "title/location/date",
  l1: "body disqualifiers",
  l2: "profile fit",
  l3: "scam/ghost risk",
}

// Each entry: { id, run(job, ctx) -> {ok, reasons, flags, ...} }.
// ctx carries { limits, now, profileYears, profileTech, keywords, history }.
//
// Registration happens HERE rather than in each check's own module. Letting
// fit.mjs and risk.mjs self-register would mean importing this file from
// there and this file importing them back — a cycle. The checks stay pure
// functions in their own modules; this file is the only thing that knows the
// order they run in.
const REGISTRY = new Map()

export function registerStage(id, run) {
  if (!STAGE_IDS.includes(id)) throw new Error(`unknown stage id "${id}"`)
  REGISTRY.set(id, run)
}

registerStage("l0", (job, ctx) => passesLimits(job, ctx.limits, ctx.now))
registerStage("l1", (job, ctx) => bodyDisqualifiers(job, ctx.limits))
registerStage("l2", (job, ctx) =>
  scoreFit(job, ctx.profileTech ?? new Set(), {
    limits: ctx.limits,
    indexed: ctx.keywords,
  }),
)
registerStage("l3", (job, ctx) =>
  scoreRisk(job, ctx.history ?? null, { limits: ctx.limits }),
)

// Run a lead through the stages in order, stopping at the first rejection.
// Returns:
//   { ok, stage, reasons, flags, stages: { l0: {...}, ... } }
// where `stage` is the id that rejected it, or null when everything passed.
export function evaluateStages(job, ctx = {}, only = STAGE_IDS) {
  const flags = new Set(job.flags ?? [])
  const stages = {}
  let extra = {}

  for (const id of STAGE_IDS) {
    if (!only.includes(id)) continue
    const run = REGISTRY.get(id)
    if (!run) continue // stage not registered (l2/l3 before phase B)

    // Each stage sees the flags every earlier stage raised — l1's
    // "did this arrive on a loose title match?" test depends on l0's flags.
    const {
      ok,
      reasons = [],
      flags: newFlags = [],
      ...rest
    } = run({ ...job, flags: [...flags] }, ctx)
    newFlags.forEach((f) => flags.add(f))
    stages[id] = { ok, reasons, flags: newFlags, ...rest }
    extra = { ...extra, ...rest }

    if (!ok) {
      return {
        ok: false,
        stage: id,
        reasons: reasons.map((r) => (r.includes(":") ? r : `${id}: ${r}`)),
        flags: [...flags],
        stages,
        ...extra,
      }
    }
  }

  return {
    ok: true,
    stage: null,
    reasons: [],
    flags: [...flags],
    stages,
    ...extra,
  }
}
