// L3 — is this job real? Scam, ghost and evergreen-posting signals.
//
// Industry research puts ghost jobs at 18-40% of live listings and names
// REPOSTING as the single strongest signal: a listing that disappears and comes
// back every few weeks with an unchanged description is a pipeline-warming ad,
// not a vacancy.
//
// The pipeline could not see that. A re-swept posting arrives with a fresh
// board id ("greenhouse:acme:123" becomes "greenhouse:acme:456"), a fresh
// posted_at, and looks brand new. Nothing compared it to what had been seen
// before, so the one signal that matters most was the one signal unavailable.
//
// What this file adds on top of the scam/culture/blocker patterns already in
// screen.mjs:
//
//   repost detection      keyed on company::title across the WHOLE store,
//                         dismissed leads included, recorded at ingest
//   evergreen phrasing    "we are always hiring", "pipeline requisition"
//   boilerplate ratio     a description that is nearly all company boilerplate
//                         and nearly no job
//   duplicate body        one description reused verbatim across several of the
//                         same company's postings
//
// Like L2 this only ever rejects on unambiguous evidence. A ghost job costs an
// application; a false reject costs a job. They are not symmetric.

import { sanitizeUntrusted, isDisqualifying } from "../lib/untrusted.mjs"

// Deliberately narrow. "Ongoing recruitment" and "we are growing fast" are NOT
// here — plenty of real postings say them.
const EVERGREEN = [
  [
    /\b(?:we|this)\s+(?:are|is)\s+always\s+(?:hiring|recruiting|accepting)/i,
    "always_hiring",
  ],
  [
    /\b(?:pipeline|evergreen|talent\s+pool)\s+(?:requisition|req|posting|role)\b/i,
    "pipeline_req",
  ],
  [
    /\bthis\s+(?:is\s+)?(?:a\s+)?(?:general|generic)\s+(?:application|posting|req)/i,
    "general_application",
  ],
  [
    /\bwe\s+(?:accept|collect)\s+applications?\s+(?:on\s+an?\s+)?(?:ongoing|rolling|continuous)\s+basis/i,
    "rolling_basis",
  ],
  [
    /\bno\s+(?:specific|current|immediate)\s+(?:opening|vacancy|role)\b/i,
    "no_current_opening",
  ],
  [/\bfuture\s+(?:opportunit|opening|consideration)/i, "future_consideration"],
]

// Company boilerplate: text about the employer rather than the job. A posting
// that is almost entirely this describes no actual work.
const BOILERPLATE =
  /\b(?:equal\s+opportunity\s+employer|without\s+regard\s+to\s+race|reasonable\s+accommodation|e-verify|at-will\s+employment|drug[\s-]free\s+workplace|background\s+check|our\s+mission\s+is|founded\s+in\s+\d{4}|we\s+believe\s+that|diversity\s+and\s+inclusion)/gi

// Words that describe actual engineering work. Used as the denominator for the
// boilerplate ratio — a real posting has some of these.
const SUBSTANCE =
  /\b(?:you\s+will|you'?ll|responsibilities|build|design|implement|ship|develop|maintain|debug|deploy|collaborate|own|architect|test|review|migrate|optimi[sz]e)\b/gi

export const RISK_DEFAULTS = {
  // Times the same company+title has been seen before this lead. Industry
  // guidance treats repeated reposting as the strongest ghost signal, but two
  // sightings can be an honest re-open, so the reject bar sits above that.
  repost_caution: 1,
  repost_reject: 3,
  // A description needs at least this many "actual work" verbs. Below it, with
  // boilerplate present, the posting describes a company rather than a job.
  min_substance: 2,
  // Only applied to descriptions long enough for the ratio to mean anything.
  min_length_for_ratio: 600,
  // Identical description reused across this many of one company's postings.
  duplicate_body_reject: 3,
}

const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()

export const repostKey = (job) => `${norm(job.company)}::${norm(job.title)}`

// Fingerprint of a description, for spotting one body reused verbatim across
// several of a company's postings.
//
// This deliberately fingerprints the WHOLE normalized description, not a
// prefix. A prefix was tried and matched 49 of 102 stored leads — because
// Coinbase, Grafana Labs, Twilio and IGT all open every single posting with the
// same company paragraph ("Ready to do the most impactful work of your
// career..."). Sharing a boilerplate intro is not evidence of a ghost job; it
// is evidence of a marketing department. Two postings whose ENTIRE body matches
// are a real signal, and different roles at the same company always differ once
// the requirements section is included.
export function bodyFingerprint(text) {
  const t = norm(text)
  // Too short to be distinctive: a two-line description would collide with
  // every other two-line description.
  return t && t.length >= 200 ? t : null
}

// Build the history a lead is judged against, from every OTHER lead in the
// store — dismissed ones included, which is the whole point: a lead dismissed
// three weeks ago is exactly the evidence that this one is a repost.
export function buildHistory(leads, { now = new Date() } = {}) {
  const byKey = new Map()
  const byFingerprint = new Map()
  for (const l of leads ?? []) {
    const k = repostKey(l)
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push({
      id: l.id,
      posted_at: l.posted_at ?? null,
      found_at: l.found_at ?? null,
    })
    const fp = bodyFingerprint(l.description)
    if (fp) {
      const ck = `${norm(l.company)}::${fp}`
      byFingerprint.set(ck, (byFingerprint.get(ck) ?? 0) + 1)
    }
  }
  return { byKey, byFingerprint, now }
}

export function scoreRisk(job, history = null, opts = {}) {
  const cfg = { ...RISK_DEFAULTS, ...(opts.limits?.ghost_signals ?? {}) }
  const text = [job.title, job.description, ...(job.requirements ?? [])]
    .filter(Boolean)
    .join("\n")
  const reasons = []
  const flags = []
  const signals = []

  // --- reposting ------------------------------------------------------------
  //
  // Two sources, because they see different halves of the same thing:
  //   job.repost_count   sightings recorded at ingest, when a re-posted copy
  //                      was dropped as a duplicate (see dedupeLeads). This is
  //                      the real signal — the store cannot hold two leads with
  //                      the same company+title, so history alone finds nothing.
  //   history.byKey      near-duplicate titles that slipped past dedupe, e.g.
  //                      a lead imported by hand or under a different id.
  let repostCount = job.repost_count ?? 0
  if (history) {
    const seen = history.byKey.get(repostKey(job)) ?? []
    // Don't count the lead against itself when it is already in the store.
    repostCount = Math.max(
      repostCount,
      seen.filter((s) => s.id !== job.id).length,
    )
  }
  // Outside the history branch: an ingest-recorded repost_count must still be
  // judged when no history map was supplied (screen.mjs on a JSON fixture).
  if (repostCount >= cfg.repost_reject) {
    signals.push(`reposted_${repostCount}x`)
    reasons.push(
      `l3: same company and title seen ${repostCount} times before — reposting is the strongest ghost-job signal`,
    )
  } else if (repostCount > cfg.repost_caution) {
    signals.push(`reposted_${repostCount}x`)
    flags.push("repost")
  }

  // --- duplicate body across the company's own postings ----------------------
  if (history && job.description) {
    const fp = bodyFingerprint(job.description)
    const n = fp
      ? (history.byFingerprint.get(`${norm(job.company)}::${fp}`) ?? 0)
      : 0
    if (n >= cfg.duplicate_body_reject) {
      signals.push(`duplicate_body_${n}x`)
      flags.push("duplicate_body")
    }
  }

  // --- evergreen phrasing ---------------------------------------------------
  for (const [re, name] of EVERGREEN) {
    if (re.test(text)) {
      signals.push(name)
      // Explicit "this is not a real opening" language is the posting telling
      // you outright, so it rejects rather than cautions.
      if (name === "no_current_opening" || name === "pipeline_req") {
        reasons.push(`l3: evergreen posting (${name})`)
      } else {
        flags.push("evergreen")
      }
    }
  }

  // --- text that is trying to act on the agent ------------------------------
  //
  // A posting carrying instructions aimed at an AI is telling you something
  // about whoever wrote it, so it is a screening signal in its own right, not
  // just something to strip. On the human-facing recommendation flow this only
  // ever flags: these patterns are regexes over someone else's prose and a
  // false reject is a job the user never sees.
  //
  // On the auto-apply path (w4-autonomy's `evaluateStages(..., ["l0","l1","l3"])`
  // call, which skips l2 fit but still runs l3) an ACTUAL injection attempt has
  // to be disqualifying — nobody is reading the approval message before that
  // path fires, so "flag it and hope a human notices" is not a control there.
  // `isDisqualifying` draws the line, not a hardcoded list here: it rejects the
  // eight instruction-shaped kinds and never `hidden_html` / `hidden_attr_text`
  // / `invisible_characters` / `homoglyph_text` / `encoded_blob` on their own —
  // a CMS emits comments and a logo has alt text, and those alone are messy,
  // not hostile.
  const scan = sanitizeUntrusted(text)
  if (!scan.clean) {
    for (const f of scan.findings) signals.push(`injection:${f.kind}`)
    const hostile = scan.findings.filter(isDisqualifying)
    if (hostile.length) {
      reasons.push(
        `injection_attempt:${[...new Set(hostile.map((f) => f.kind))].sort().join("+")}`,
      )
    } else {
      flags.push("injection_attempt")
    }
  }

  // --- boilerplate ratio ----------------------------------------------------
  const desc = String(job.description ?? "")
  if (desc.length >= cfg.min_length_for_ratio) {
    const boiler = (desc.match(BOILERPLATE) ?? []).length
    const substance = (desc.match(SUBSTANCE) ?? []).length
    if (boiler >= 2 && substance < cfg.min_substance) {
      signals.push("boilerplate_only")
      flags.push("vague_scope")
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    flags,
    risk_signals: signals,
    repost_count: repostCount,
  }
}
