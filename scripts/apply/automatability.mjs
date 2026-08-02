#!/usr/bin/env node
// Can the deterministic pipeline apply to this posting WITHOUT a human?
//
// A MODULE, NOT A SCREENING STAGE, and that is the whole design.
// `evaluateStages` returns on the first rejection and `screen.mjs` turns any
// stage rejection into `dismissed`. Registering automatability as an `l4`
// would therefore convert "the engine cannot do this one alone" into "the user
// never sees this job" — the outcome `gate-audit.mjs` calls the worst failure
// in the system. Automatability is also a fact about US, not about the
// posting: it changes every time the user answers a question, and a screening
// verdict that flips on our own state is not a screening verdict.
//
// Four tiers, evaluated in this order, first match wins:
//
//   handoff  the board needs an account we are not permitted to create
//   blocked  something about OUR state forbids applying at all
//   amber    could be automatable, but we cannot know from here
//   green    a pre-filter says the engine alone would very likely suffice
//
// GREEN IS A PRE-FILTER, NOT AN AUTHORISATION. It reasons entirely from a
// REMEMBERED form shape (jobs/.field-cache.json) — no browser, no network, no
// model. The remembered shape can be out of date, and the page it describes is
// written by a third party. So green means only "worth opening", and the real
// gate is the pair that runs after the live scan: `readiness()` on the built
// plan, and `submitReadiness()` requiring zero failures, zero verify
// mismatches, zero required-empty, zero defers and a submit-role button. Two
// independent keys, read at different times from different evidence. Nothing
// in this file authorises a click.
//
// TWO RULES THIS FILE MUST STAY CONSISTENT WITH, both stricter than the
// original plan text:
//
//   * A CHECKBOX OR RADIO GROUP NEVER AUTO-ACTS UNATTENDED, whatever the
//     answer's class. A tick carries ASSENT, on a control the board owns, not
//     a value. buildPlan defers every check-verb resolution as
//     `why: "confirm-widget"`, and `submitReadiness()` blocks on any defer. So
//     a remembered shape containing a checkbox or radio group cannot be green.
//   * NOTHING AUTO-TICKS CONSENT, on any path. The `consent_allowlist` design
//     in the plan was superseded: its three supposedly independent controls all
//     read one string the attacker chose. A consent box is the user's to tick,
//     always, so a remembered shape containing one cannot be green either.
//
// Both of those are checked on the SHAPE of the remembered form, not on
// whether the fact base happens to hold an answer — the fact base holding an
// answer is exactly the condition that used to make 34 boxes tick themselves.
//
// L2 (profile fit) IS DELIBERATELY NOT CONSULTED. User decision: a slim-chance
// job should still be applied to. The caller runs `evaluateStages` with
// `["l0","l1","l3"]` and calls `scoreFit` separately, purely to order the
// queue. Scams and stale postings still hard-gate — a slim chance is fine,
// submitting personal data to a scam is not. This needs zero changes to
// stages.mjs; `only` already exists.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { detectAts, ADAPTERS } from "./ats/index.mjs"
import { loadCache } from "./field-cache.mjs"
import { predictedFields } from "./pending-questions.mjs"
import {
  resolveFields,
  isConsent,
  looksLikeAgreementProse,
} from "./fill-plan.mjs"
import { isTerse } from "../lib/lib.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

export const TIERS = ["handoff", "blocked", "amber", "green"]

// A remembered form shape older than this is not trusted to still describe the
// page. Boards redesign; a stale shape that has silently gained a required
// field is exactly how an unattended run submits an incomplete application.
export const DEFAULT_CACHE_MAX_AGE_DAYS = 30

// Statuses that mean the fact base did NOT settle the field. "CONFIRM" is in
// here on purpose: it is an answer the user ASSERTS rather than states (work
// authorisation, arbitration, background check, relocation), and hard rule 6
// blocks the submit on any of them.
const NOT_SETTLED = new Set([
  "UNKNOWN",
  "NEEDS-CHOICE",
  "MAYBE",
  "CONFIRM",
  "UNRESOLVED",
])

const ADAPTER_IDS = new Set(ADAPTERS.map((a) => a.id))

const norm = (s) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()

// Query parameters that carry the EMPLOYER's identity rather than the
// posting's. See boardKey for why leaving one out is a correctness bug and not
// a missed optimisation.
const EMPLOYER_PARAMS = ["for", "company", "c"]

/**
 * The identity of a BOARD, not of an ATS: hostname, first path segment, and any
 * query parameter that names the employer. `boards.greenhouse.io/acme/jobs/123`
 * and `.../acme/jobs/456` are two postings on one form;
 * `boards.greenhouse.io/other/...` is a different employer's form with
 * different questions. Green needs a shape remembered for THIS board — matching
 * on the ATS alone would let one employer's remembered form vouch for
 * another's.
 *
 * THE ASYMMETRY THAT DECIDES THE DESIGN: a key that is too SPECIFIC fails to
 * match, the lead falls to amber, and the cost is a missed optimisation. A key
 * that is too GENERAL matches the wrong employer's form and green is asserted
 * from a shape that describes a different set of questions. So every doubt
 * resolves toward more specific.
 *
 * MEASURED, and the reason EMPLOYER_PARAMS exists: the real cache holds
 * `job-boards.greenhouse.io/embed/job_app?for=tebra&...` and
 * `...?for=coinbase&...`. Path-only keying collapsed both to
 * `job-boards.greenhouse.io/embed`, so Coinbase's remembered form would have
 * vouched for Tebra's. Greenhouse's embedded boards put the employer in `for=`,
 * never in the path.
 */
export function boardKey(url) {
  try {
    const u = new URL(String(url ?? ""))
    const seg = u.pathname.split("/").filter(Boolean)[0] ?? ""
    let key = `${u.hostname.toLowerCase()}/${seg.toLowerCase()}`
    for (const p of EMPLOYER_PARAMS) {
      const v = u.searchParams.get(p)
      if (v) key += `?${p}=${v.toLowerCase()}`
    }
    return key
  } catch {
    return ""
  }
}

function ageDays(updated, now) {
  if (!updated) return Infinity
  const t = Date.parse(updated)
  if (Number.isNaN(t)) return Infinity
  return (now.getTime() - t) / 86_400_000
}

/**
 * Every remembered shape recorded for this lead's board, with its fingerprint.
 * More than one is normal (a board with two form variants), and green requires
 * ALL of them to be automatable — we cannot know which variant this posting
 * will render until the page is open.
 */
export function shapesForBoard(cache, url, atsId) {
  const key = boardKey(url)
  const out = []
  for (const [fp, entry] of Object.entries(cache?.forms ?? {})) {
    if (entry?.ats !== atsId) continue
    if (!entry.url || boardKey(entry.url) !== key) continue
    out.push({ fp, entry })
  }
  return out
}

/**
 * Why a single remembered shape cannot be driven unattended, or null.
 *
 * `resolvedByKey` is the batched resolution keyed as predictedFields keys it
 * (`${fp}:${label}|${type}`), so this does no resolving of its own.
 */
export function shapeBlockers(fp, entry, resolvedByKey, { now, maxAgeDays }) {
  const blockers = []
  const fieldEntries = Object.entries(entry.fields ?? {})
  const age = ageDays(entry.updated, now)
  if (age > maxAgeDays) {
    blockers.push(
      entry.updated
        ? `remembered form shape is ${Math.round(age)} days old (max ${maxAgeDays})`
        : "remembered form shape has no recorded date",
    )
  }

  for (const [key, f] of fieldEntries) {
    const label = f.l ?? key.split("|")[0] ?? ""
    // SHAPE CHECKS FIRST, and the ordering is load-bearing for a mechanical
    // reason, not a historical one.
    //
    // An earlier version of this comment justified the ordering with the
    // 34-box incident. That was an ACTION failure — the planner ticked boxes
    // because the fact base held an answer — and it was fixed structurally at
    // the planner (fill-plan.mjs, where buildPlan now emits no check verb for
    // any widget on any path). It is not evidence about the ORDER here, and
    // a reader who notices the mismatch is one step from relaxing the rule.
    //
    // The real reason: the `req` gate below skips a field entirely, and the
    // widget rules must be TOTAL — every checkbox, radio and consent box in the
    // shape, required or not. An optional consent tickbox is still the user's
    // to tick. Run the `req` gate first and every optional widget stops being
    // examined, which is the same hole in a different place.
    //
    // The checks also read the WIDGET, never whether the fact base has an
    // answer: an answer being available is not evidence that ticking is safe.
    if (
      isConsent(label) ||
      looksLikeAgreementProse({ t: f.t, l: label }, label)
    ) {
      blockers.push(
        `consent tickbox present ("${label}") — the user ticks those, always`,
      )
      continue
    }
    if (f.t === "checkbox" || f.t === "radio") {
      blockers.push(
        `${f.t} group present ("${label}") — a tick carries assent, not a value, and never auto-acts unattended`,
      )
      continue
    }
    if (!f.req) continue // optional and not a widget: the planner skips it

    const r = resolvedByKey.get(`${fp}:${key}`)
    const status = r?.status ?? "UNRESOLVED"
    if (NOT_SETTLED.has(status)) {
      blockers.push(`required field "${label}" is ${status.toLowerCase()}`)
      continue
    }
    // An option list that was cut short cannot be checked for a better match,
    // so an apparently-OK pick against it is a guess. field-cache.mjs carries
    // this flag precisely so a later reader does not treat the list as
    // exhaustive.
    if (f.optsTruncated) {
      blockers.push(
        `required field "${label}" was matched against a truncated option list`,
      )
    }
  }

  // --- the two ways this function can be vacuously satisfied -----------------
  //
  // Both are appended AFTER the loop so a widget or an unsettled field stays
  // the headline: those name a specific thing to fix, and this names an absence.
  //
  // 1. NOTHING TO EXAMINE. A remembered entry with no fields passes every check
  //    above by having nothing to fail, and "no blockers" would read as "safe".
  if (!fieldEntries.length) {
    blockers.push(
      "remembered form shape records no fields at all — there is nothing to check, " +
        "which is not the same as nothing being wrong",
    )
    return blockers
  }

  // 2. REQUIREDNESS WAS NEVER RECORDED, and this is the one that was live.
  //
  //    field-cache.mjs writes `req` ONLY when it is true (`if (req) next.req =
  //    true`), so an absent `req` is ambiguous by construction: on a modern
  //    entry it means "optional", and on an entry written by a scanner that
  //    never supplied requiredness it means "nobody knows". `if (!f.req)
  //    continue` reads both as optional, so a shape recording requiredness
  //    nowhere skips EVERY field and returns no blockers — green asserted with
  //    nothing having been examined.
  //
  //    MEASURED 2026-08-02 on the real jobs/.field-cache.json: 4 of 7 remembered
  //    shapes carry `req` on no field at all, non-adversarially, purely from
  //    scanner vintage. Form aa5c650e (greenhouse, 26 fields, no widgets) is one
  //    of them, and it classified GREEN. The widget rule was the only thing
  //    masking this on the other three.
  //
  //    The discriminator has to be per-ENTRY, because per-field is exactly the
  //    ambiguity: if any field in the entry carries `req`, the scanner did
  //    record requiredness and an absent `req` on its siblings means optional.
  //
  //    Deliberately NOT "treat every unknown-req field as required and resolve
  //    it". predictedFields() only emits rows for `req` fields, so resolvedByKey
  //    holds no row for any of them and every one would come back UNRESOLVED —
  //    a blocker dressed up as an examination. Widening predictedFields is
  //    pending-questions.mjs's call, not this file's; until it happens, the
  //    honest tier for a shape we cannot read is amber, which still shows the
  //    user the job.
  const recordsRequiredness = fieldEntries.some(([, f]) => f?.req !== undefined)
  if (!recordsRequiredness) {
    blockers.push(
      `remembered form shape does not record which fields the form requires ` +
        `(${fieldEntries.length} fields, none carrying \`req\`) — "every required field is ` +
        `settled" cannot be checked against it, so it is not evidence of anything`,
    )
  }
  return blockers
}

/**
 * Classify one lead. Pure: every input is passed in, nothing is read from disk
 * and nothing is written.
 *
 * ctx:
 *   cache             jobs/.field-cache.json, already loaded
 *   resolvedByKey     Map from the ONE batched resolveFields() call
 *   profileApproved   profile.yaml meta.approved_by_user
 *   hasVerifiedResume boolean for this lead (a verified tailored resume exists,
 *                     or reuse-check cleared a sibling's)
 *   alreadyApplied    boolean
 *   stages            the result of evaluateStages(job, ctx, ["l0","l1","l3"])
 *   now, maxAgeDays
 */
export function classify(lead, ctx = {}) {
  const {
    cache = { forms: {} },
    resolvedByKey = new Map(),
    profileApproved = false,
    hasVerifiedResume = false,
    alreadyApplied = false,
    stages = null,
    now = new Date(),
    maxAgeDays = DEFAULT_CACHE_MAX_AGE_DAYS,
  } = ctx

  const url = lead?.apply_url || lead?.url || lead?.source_url || ""
  const evidence = { url, board: boardKey(url) }

  // --- handoff ---------------------------------------------------------------
  if (!url) {
    return tier("blocked", "no application URL on the lead", evidence)
  }
  const adapter = detectAts(url)
  evidence.ats = adapter?.id ?? null
  if (adapter?.handoff) {
    return tier("handoff", adapter.reason, evidence)
  }

  // --- blocked ---------------------------------------------------------------
  // OUR state, not the posting's. Each of these means applying is wrong right
  // now, and none of them is a reason to hide the job from the user.
  if (!profileApproved) {
    return tier(
      "blocked",
      "profile.yaml meta.approved_by_user is not true — nothing may be tailored or submitted from an unapproved fact base",
      evidence,
    )
  }
  if (alreadyApplied) {
    return tier(
      "blocked",
      "already applied to this company and title",
      evidence,
    )
  }
  if (!hasVerifiedResume) {
    return tier(
      "blocked",
      "no verify-claims-passed resume for this posting, and no cleared reuse",
      evidence,
    )
  }
  if (stages && stages.ok === false) {
    return tier(
      "blocked",
      `screening rejected at ${stages.stage}: ${(stages.reasons ?? []).join("; ")}`,
      { ...evidence, stage: stages.stage },
    )
  }
  if (!stages) {
    // Refusing to guess. An unscreened lead is not a safe lead; it is an
    // unknown one, and the unattended path treats unknown as amber, never as
    // green.
    return tier(
      "amber",
      "l0/l1/l3 screening has not been run for this lead",
      evidence,
    )
  }

  // --- amber -----------------------------------------------------------------
  if (!ADAPTER_IDS.has(adapter?.id)) {
    return tier(
      "amber",
      `generic ATS (${adapter?.id ?? "unknown"}) — no adapter, so the form is unmapped`,
      evidence,
    )
  }
  const shapes = shapesForBoard(cache, url, adapter.id)
  evidence.shapes = shapes.length
  if (!shapes.length) {
    return tier(
      "amber",
      "no remembered form shape for this board — it has never been scanned",
      evidence,
    )
  }

  const blockers = []
  for (const { fp, entry } of shapes) {
    blockers.push(
      ...shapeBlockers(fp, entry, resolvedByKey, { now, maxAgeDays }),
    )
  }
  if (blockers.length) {
    evidence.blockers = blockers
    return tier("amber", blockers[0], evidence)
  }

  // --- green -----------------------------------------------------------------
  return tier(
    "green",
    "known adapter, fresh remembered shape, every required field settled, no consent box, no checkbox or radio group",
    evidence,
  )
}

function tier(t, reason, evidence) {
  return { tier: t, reason, evidence }
}

/**
 * Classify many leads with ONE batched resolveFields() call, not one per lead.
 *
 * This is the part that has to be O(1) in fact-base reads rather than O(n):
 * resolveFields loads and indexes profile.yaml and answers.yaml, and doing that
 * per lead is the difference between a classification pass and a latency
 * problem. `predictedFields` is likewise called once for the union of ATS ids.
 *
 * `perLead(lead)` supplies the facts this module cannot know:
 *   { hasVerifiedResume, alreadyApplied, stages }
 */
export function classifyAll(leads, opts = {}) {
  const {
    cache = { forms: {} },
    profile = null,
    answers = null,
    profileApproved = false,
    perLead = () => ({}),
    now = new Date(),
    maxAgeDays = DEFAULT_CACHE_MAX_AGE_DAYS,
    // Seam, not configuration. The batching claim ("one resolveFields call for
    // N leads, not N") is only falsifiable if a test can count the calls, and a
    // performance property nobody can assert is a performance property that
    // quietly regresses.
    resolve = resolveFields,
  } = opts

  const atsIds = new Set()
  for (const lead of leads) {
    const url = lead?.apply_url || lead?.url || lead?.source_url || ""
    if (!url) continue
    const a = detectAts(url)
    if (a && !a.handoff && ADAPTER_IDS.has(a.id)) atsIds.add(a.id)
  }

  const fields = atsIds.size ? predictedFields(cache, atsIds) : []
  const resolved = fields.length ? resolve(fields, { profile, answers }) : []
  const resolvedByKey = new Map(resolved.map((r) => [r.k, r]))

  return leads.map((lead) => ({
    lead,
    ...classify(lead, {
      cache,
      resolvedByKey,
      profileApproved,
      now,
      maxAgeDays,
      ...perLead(lead),
    }),
  }))
}

/**
 * The queue's sort key for one `scoreFit` result. Unevaluable sorts LAST.
 *
 * THE BUG THIS FIXES, measured by innov-architect on a real data-engineering
 * posting: `fit_score: 1` with the thin flag set, because 2 of roughly 10 real
 * requirements were recognised by the lexicon and both happened to match. The
 * queue then ordered that 1.0 above a fully-read 0.8. The caller already had
 * the right instinct — `?? -1` sorts an unevaluable score last — but `null` is
 * only ONE of the two ways `scoreFit` says it could not read a posting.
 *
 * ONE AUTHORITATIVE CHECK, AND IT IS NOT OURS. `fit.mjs:isEvaluable` owns the
 * definition of "this score can be trusted", and this function does nothing but
 * obey it. Two earlier versions of this were worse:
 *
 *   * matching flag NAMES — fragile by construction, and it stops working
 *     SILENTLY in the direction of trusting a score nobody could compute. P3
 *     renamed `fit_thin` to `posting_thin`/`lexicon_blind` within days.
 *   * RECOMPUTING the rule (`required_terms.length >= min_required_terms`) —
 *     rename-proof, but a second copy of somebody else's rule, which stops
 *     meaning the same thing the moment evaluability is redefined there.
 *
 * The name list is DELETED rather than kept as a second net, and the reason is
 * evidence, not taste. `scoreFit` emits `posting_thin`/`lexicon_blind` from a
 * single site inside `if (!evaluable)`, so a flag can never claim unevaluable
 * while `isEvaluable` says otherwise — confirmed on the whole 149-lead store,
 * 2026-08-02: evaluable-and-thin-flagged = 0, unevaluable-and-unflagged = 0. A
 * redundant second net would not be free either: `lexicon_blind` is a statement
 * about OUR VOCABULARY, and a list here that demoted on the name would quietly
 * turn it into "we could not read the posting" the first time that flag was
 * emitted alongside a usable score.
 *
 * It can only ever push a score DOWN to -1. There is no branch that invents a
 * usable score, promotes one, or makes the classifier more lenient — the
 * unreadable posting still appears in the queue, at the bottom, where a number
 * nobody could compute belongs.
 *
 * @param fit  a scoreFit() result, or null/undefined.
 * @param isEvaluable  fit.mjs's predicate, INJECTED rather than imported: the
 *   pure half of this file stays importable without pulling in the leads
 *   pipeline (see the CLI's own import comment). Required — a missing one
 *   throws rather than defaulting to "evaluable", because a wiring slip that
 *   silently restored the old behaviour is exactly this bug returning.
 * @param limits  the same limits the lead was scored with, threaded through so
 *   a project-level `min_required_terms` override cannot be lost on the way.
 */
export function fitSortKey(fit, { isEvaluable, limits = null } = {}) {
  if (typeof isEvaluable !== "function")
    throw new TypeError(
      "fitSortKey requires fit.mjs's isEvaluable — without it an unreadable " +
        "posting sorts as though its score were real",
    )
  if (!isEvaluable(fit, { limits })) return -1
  return fit.fit_score
}

export function tierCounts(results) {
  const counts = Object.fromEntries(TIERS.map((t) => [t, 0]))
  for (const r of results) counts[r.tier] = (counts[r.tier] ?? 0) + 1
  return counts
}

// --- CLI ---------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2)
  const wantJson = args.includes("--json")
  const flag = (name, fallback = null) => {
    const i = args.indexOf(name)
    if (i === -1) return fallback
    const v = args[i + 1]
    return v === undefined || v.startsWith("--") ? true : v
  }
  const jobsDir = flag("--jobs-dir", path.join(ROOT, "jobs"))
  const cacheFile = flag("--cache", path.join(jobsDir, ".field-cache.json"))
  const profileFlag = flag("--profile")
  const answersFlag = flag("--answers")
  const top = Number(flag("--top", 0)) || 0

  // Imported here rather than at module scope so the pure half of this file
  // stays importable (and testable) without pulling in the whole leads
  // pipeline, its YAML limits file, or its network-capable modules.
  const [
    { readLeadStore, openDb, readApplications },
    { evaluateStages },
    { scoreFit, isEvaluable },
  ] = await Promise.all([
    import("../lib/db.mjs"),
    import("../leads/stages.mjs"),
    import("../leads/fit.mjs"),
  ])
  const { loadYamlFile } = await import("../lib/lib.mjs")
  const { extractTech } = await import("../lib/keywords.mjs")

  const limits = loadYamlFile(
    path.join(ROOT, "docs", "application-limits.yaml"),
  )
  const profileFile =
    typeof profileFlag === "string"
      ? profileFlag
      : path.join(ROOT, "profile", "profile.yaml")
  const profileDoc = loadYamlFile(profileFile) ?? {}
  const profileApproved = profileDoc?.meta?.approved_by_user === true

  const { leads } = readLeadStore()
  const applications = readApplications()
  const appliedKeys = new Set(
    applications.map((a) => `${norm(a.company)}|${norm(a.title)}`),
  )

  const cache = loadCache(cacheFile)
  const now = new Date()

  // A verified resume is evidenced by the job workspace: verify-claims writes
  // nothing durable, so the check is "does a tailored resume exist for a slug
  // whose job.json points at this lead". Deliberately conservative — an
  // unmatched lead is `blocked`, which is visible, never hidden.
  const verified = new Map()
  if (fs.existsSync(jobsDir)) {
    for (const e of fs.readdirSync(jobsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const jobFile = path.join(jobsDir, e.name, "job.json")
      const resume = path.join(jobsDir, e.name, "resume.md")
      if (!fs.existsSync(jobFile) || !fs.existsSync(resume)) continue
      try {
        const job = JSON.parse(fs.readFileSync(jobFile, "utf8"))
        const u = job.apply_url || job.url || job.source_url
        if (u) verified.set(u, e.name)
      } catch {
        /* an unreadable workspace simply does not vouch for anything */
      }
    }
  }

  const results = classifyAll(leads, {
    cache,
    profile: typeof profileFlag === "string" ? profileFlag : null,
    answers: typeof answersFlag === "string" ? answersFlag : null,
    profileApproved,
    now,
    perLead: (lead) => {
      const url = lead.apply_url || lead.url || lead.source_url || ""
      let stages = null
      try {
        stages = evaluateStages(lead, { limits, now }, ["l0", "l1", "l3"])
      } catch {
        stages = null // an unscreenable lead falls to amber, never to green
      }
      return {
        stages,
        hasVerifiedResume: verified.has(url),
        alreadyApplied: appliedKeys.has(
          `${norm(lead.company)}|${norm(lead.title)}`,
        ),
      }
    },
  })

  // Fit ORDERS the queue and never rejects here (user decision: slim-chance
  // jobs should still be applied to, so l2 is left out of the stage list
  // above and scoreFit is called separately). Its `ok` field is deliberately
  // discarded — reading it would silently reintroduce the l2 rejection this
  // whole arrangement exists to avoid.
  //
  // extractTech from lib/keywords.mjs is the SAME function fit.mjs scores the
  // posting with, so both sides of the comparison speak one vocabulary.
  // lib.mjs's techTermsIn is a different extractor that returns an ARRAY, and
  // passing it here threw inside scoreFit on `profileTech.has(...)` — silently,
  // because an earlier version of this loop caught and zeroed it, which made
  // the ordering a no-op that still looked like it worked.
  const profileTech = extractTech(fs.readFileSync(profileFile, "utf8"))
  for (const r of results) {
    try {
      // `fit_score`, NOT `score` — the latter is undefined, which coerced every
      // lead to 0. An unevaluable score sorts LAST rather than pretending to be
      // a zero or, worse, a 1.0 computed from two terms (see fitSortKey).
      // `isEvaluable` decides that, and it is fit.mjs's to decide.
      r.fit = fitSortKey(scoreFit(r.lead, profileTech, { limits }), {
        isEvaluable,
        limits,
      })
    } catch (e) {
      // Never silent. A blanket catch that zeroes the sort key hides exactly
      // the class of bug described above.
      console.error(`fit scoring failed for ${r.lead.id}: ${e.message}`)
      r.fit = -1
    }
  }
  const rank = { green: 0, amber: 1, handoff: 2, blocked: 3 }
  results.sort((a, b) => rank[a.tier] - rank[b.tier] || b.fit - a.fit)
  const shown = top ? results.slice(0, top) : results

  if (wantJson) {
    console.log(
      JSON.stringify(
        {
          counts: tierCounts(results),
          results: shown.map((r) => ({
            id: r.lead.id,
            company: r.lead.company,
            title: r.lead.title,
            tier: r.tier,
            reason: r.reason,
            fit: r.fit,
            evidence: r.evidence,
          })),
        },
        null,
        2,
      ),
    )
    return
  }

  const counts = tierCounts(results)
  if (isTerse()) {
    console.log(
      TIERS.map((t) => `${t}=${counts[t]}`).join("|") +
        `|total=${results.length}`,
    )
    for (const r of shown) {
      console.log(`${r.tier}\t${r.lead.company} — ${r.lead.title}\t${r.reason}`)
    }
    return
  }
  console.log(
    `Automatability over ${results.length} lead(s): ` +
      TIERS.map((t) => `${counts[t]} ${t}`).join(", "),
  )
  console.log(
    "\nGreen is a PRE-FILTER, not an authorisation: the live scan's readiness()\n" +
      "and submitReadiness() are the gate, and auto-submit ships disabled.\n",
  )
  for (const r of shown) {
    console.log(`  [${r.tier}] ${r.lead.company} — ${r.lead.title}`)
    console.log(`         ${r.reason}`)
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) await main()
