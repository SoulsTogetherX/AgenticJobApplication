// L2 — profile fit. "Can this profile actually do this job?", decided from the
// posting body, deterministically, with no model call.
//
// L0 reads the title and location. L1 catches hard disqualifiers stated in the
// body. Neither can tell a Full-Stack role that wants React and Node from one
// that wants Scala, Spark and a Kafka cluster — both are titled "Software
// Engineer" and both are remote and fresh. That judgement was being paid for
// with a model read, per lead, forever.
//
// Three things this does that nothing upstream could:
//
// 1. REQUIRED vs PREFERRED. Until now the whole description was one blob, so a
//    Kubernetes mention under "Nice to have" counted exactly as much as one
//    under "Minimum qualifications". Most postings list an aspirational
//    preferred section; scoring against it rejects jobs the user could do.
//
// 2. RESPONSIBILITY LEVEL. "Define the technical roadmap", "mentor the team",
//    "set architectural direction" is a senior posting whatever the title says
//    and whatever years it does or does not state. The title filter cannot see
//    it and screen.mjs' years gate only fires when a number is written down.
//
// 3. STACK OVERLAP as a ratio, not a count. Matching 3 of 4 required
//    technologies is a good fit; matching 3 of 30 is not, and a raw count calls
//    them equal.
//
// REJECTING IS A USER DECISION. The user chose a hard reject below a threshold
// (2026-07-29) over caution-only, so this stage discards. Everything below is
// built to make that safe:
//   - a description that names FEWER than `min_required_terms` technologies can
//     never be rejected here, however low the overlap; a thin description is
//     unevaluated, not a bad match
//   - every threshold lives in docs/application-limits.yaml, which the user owns
//   - every rejection is visible in gate-audit.mjs, so a mis-parse is findable
//     rather than a job that silently disappeared

import { extractTech } from "../lib/keywords.mjs"

// Section headings.
//
// These must match INLINE, not just at the start of a line. Stored descriptions
// come from textSnippet(), which strips HTML and collapses every run of
// whitespace — a Greenhouse body arrives as one 4,000-character line with zero
// newlines. A line-anchored version of this matched a heading in 0 of 92 real
// stored leads, which silently turned the whole required-vs-preferred split
// into a no-op.
//
// Two tiers, because precision matters differently per phrase:
//
//   STRONG  multi-word and unambiguous. "Minimum Qualifications" is never
//           anything but a heading, so it matches anywhere.
//   WEAK    a single common word that also appears in ordinary posting prose.
//           "Requirements" is the motivating case: "gathering requirements
//           from stakeholders" is a RESPONSIBILITY, and treating it as the
//           start of the required-skills section would score the job against
//           the wrong half of its own description. These only count as a
//           heading when punctuation or a line break marks them as one.
const STRONG = {
  required:
    /(?:what\s+you'?ll?\s+need|what\s+we'?re\s+looking\s+for|required\s+(?:skills?|qualifications?|experience)|minimum\s+qualifications?|basic\s+qualifications?|must[\s-]haves?|who\s+you\s+are|what\s+you\s+bring|skills?\s+(?:and|&)\s+experience)/gi,
  preferred:
    /(?:nice[\s-]to[\s-]haves?|preferred\s+(?:skills?|qualifications?|experience)|bonus\s+points?|it'?s\s+a\s+plus|additional\s+qualifications?|desired\s+qualifications?|even\s+better|good\s+to\s+have)/gi,
  other:
    /(?:equal\s+(?:employment\s+)?opportunity|about\s+(?:us|the\s+(?:team|company|role))|what\s+we\s+offer|why\s+(?:join|work)\s+(?:us|here)|how\s+to\s+apply|application\s+process|what\s+you'?ll?\s+do|day\s+to\s+day|pay\s+(?:range|transparency)|benefits\s+(?:and|&)\s+perks)/gi,
}

// Weak headings need a ":" or a line break right after them to count.
const WEAK = {
  required: /(?:requirements?|qualifications?)(?=\s*[:\n])/gi,
  preferred: /(?:preferred|pluses)(?=\s*[:\n])/gi,
  other:
    /(?:responsibilities|benefits?|perks?|compensation|salary|our\s+values|our\s+mission)(?=\s*[:\n])/gi,
}

// Prose that describes senior scope. Every phrase here is one a mid-level
// posting does not use — "collaborate with the team" is not on this list,
// "lead the team" is. Deliberately narrow: this contributes to a REJECT.
const SENIOR_SCOPE = [
  [
    /\b(?:define|set|drive|own)\s+(?:the\s+)?(?:technical\s+)?(?:roadmap|strategy|vision|direction)/i,
    "owns_roadmap",
  ],
  [
    /\b(?:design|define|own)\s+(?:the\s+)?(?:system\s+)?architecture\b/i,
    "owns_architecture",
  ],
  [
    /\bmentor(?:ing|ship)?\s+(?:and\s+\w+\s+)?(?:junior|other|fellow|the\s+team|engineers)/i,
    "mentors_others",
  ],
  [/\b(?:lead|leading)\s+(?:a\s+)?(?:team|squad|group|pod)\b/i, "leads_team"],
  [
    /\b(?:technical\s+)?(?:leadership|thought\s+leader)\b/i,
    "leadership_expected",
  ],
  [/\bset(?:ting)?\s+(?:technical\s+)?standards\b/i, "sets_standards"],
  [
    /\b(?:influence|drive)\s+(?:across|org-wide|company-wide|multiple\s+teams)/i,
    "org_wide_influence",
  ],
  [/\bhiring\s+(?:and\s+)?(?:interviewing|process)\b/i, "runs_hiring"],
]

export const FIT_DEFAULTS = {
  // Below this many named technologies in the required section, a low overlap
  // means "we could not read this posting", not "this is a bad match". This is
  // the single most important safety number in the file.
  min_required_terms: 4,
  // Required-stack overlap ratio.
  reject_below: 0.2,
  caution_below: 0.45,
  // Senior-scope phrases that, TOGETHER with a weak stack match, mean the
  // posting is above this profile whatever its title claims.
  senior_phrase_reject: 3,
  // Below min_required_terms, the required text is at least this many
  // characters long — see the retarget-readiness audit note above
  // `posting_thin`/`lexicon_blind` for how this number was derived.
  long_body_chars: 2000,
}

// Split a posting body into { required, preferred, general }.
//
// Everything before the first recognised heading is `general` — that is where
// the summary paragraph lives, and it usually names the core stack. Text under
// an unrecognised heading also lands in `general` rather than being dropped:
// losing text here would silently shrink the required set and make the
// min_required_terms guard fire when it should not.
export function splitRequirements(text) {
  const src = String(text ?? "")
  const out = { required: [], preferred: [], general: [] }
  if (!src.trim()) return { required: "", preferred: "", general: "" }

  // Collect every heading position, then slice between them. Doing it by
  // position rather than by line is what makes this work on the flattened
  // single-line descriptions the store actually holds.
  const marks = []
  for (const [tier, table] of [
    ["strong", STRONG],
    ["weak", WEAK],
  ]) {
    for (const [kind, re] of Object.entries(table)) {
      re.lastIndex = 0
      for (const m of src.matchAll(re)) {
        marks.push({ at: m.index, end: m.index + m[0].length, kind, tier })
      }
    }
  }
  // Earliest first; on a tie a strong heading wins over a weak one, since
  // "Preferred Qualifications" would otherwise also register as weak
  // "Qualifications" and flip the section to required.
  marks.sort(
    (a, b) => a.at - b.at || (a.tier === "strong" ? -1 : 1) || b.end - a.end,
  )
  const kept = []
  for (const m of marks) {
    // Drop headings that start inside one already accepted (the weak
    // "Qualifications" inside a strong "Minimum Qualifications").
    if (kept.length && m.at < kept[kept.length - 1].end) continue
    kept.push(m)
  }

  let bucket = "general"
  let cursor = 0
  for (const m of kept) {
    out[bucket].push(src.slice(cursor, m.at))
    bucket = m.kind === "other" ? "general" : m.kind
    cursor = m.end
  }
  out[bucket].push(src.slice(cursor))

  return {
    required: out.required.join("\n").trim(),
    preferred: out.preferred.join("\n").trim(),
    general: out.general.join("\n").trim(),
  }
}

export function seniorScopeSignals(text) {
  return SENIOR_SCOPE.filter(([re]) => re.test(String(text ?? ""))).map(
    ([, name]) => name,
  )
}

// Pure core. profileTech is a Set of canonical skill names (see keywords.mjs);
// `indexed` is the lead's lead_keywords set, unioned in so a lead whose
// description was truncated still contributes what was extracted at ingest.
export function scoreFit(job, profileTech, opts = {}) {
  const cfg = { ...FIT_DEFAULTS, ...(opts.limits?.fit ?? {}) }
  const body = [job.description, ...(job.requirements ?? [])]
    .filter(Boolean)
    .join("\n")

  if (!body.trim()) {
    // No text at all. L1 already passes these through for the same reason:
    // a stage can only speak to what it can read.
    return {
      ok: true,
      reasons: [],
      flags: ["fit_unknown"],
      fit_score: null,
      required_terms: [],
    }
  }

  const parts = splitRequirements(body)
  // The required set is what the posting says it needs. When a posting has no
  // recognisable requirements section, the general text stands in — otherwise
  // an unstructured posting would always look like it required nothing.
  const requiredText = parts.required || parts.general
  const requiredTech = extractTech(requiredText)
  // Extracted but deliberately unused in the score: technologies named ONLY
  // under "nice to have" must not count against the profile. Reported so a
  // caller can show what the posting would additionally like.
  const preferredTech = [...extractTech(parts.preferred)].filter(
    (t) => !requiredTech.has(t),
  )

  const indexed = new Set(opts.indexed ?? [])
  // Indexed keywords come from the whole posting, so they can only be used to
  // ADD evidence of a match, never to enlarge the required set — otherwise a
  // preferred-section Kubernetes would sneak back in as a requirement.
  const matched = [...requiredTech].filter((t) => profileTech.has(t))
  const missing = [...requiredTech].filter((t) => !profileTech.has(t))
  const bonus = [...indexed].filter(
    (t) => profileTech.has(t) && !requiredTech.has(t),
  )

  const denom = requiredTech.size
  const overlap = denom ? matched.length / denom : null
  const senior = seniorScopeSignals(body)

  const flags = []
  const reasons = []

  // --- the guard that makes a hard reject safe ------------------------------
  const evaluable = denom >= cfg.min_required_terms
  // `denom < min_required_terms` used to be one flag, `fit_thin`, for two
  // completely different situations: the posting genuinely states few
  // requirements (a property of the JOB), or it states plenty and this
  // lexicon simply does not have the vocabulary (a property of US — exactly
  // the shape a retarget takes). Folding them together meant a domain the
  // lexicon cannot read looked like a run of thin postings, discoverable only
  // by an audit instead of announcing itself on the first sweep
  // (retarget-readiness audit, 2026-08). The guard's SAFETY behaviour is
  // unchanged either way — both flags mean "never reject on this evidence".
  //
  // Split on the length of the text `denom` was actually computed from
  // (requiredText, not the raw job body). cfg.long_body_chars (2000) is not a
  // guessed round number: derived from the 149-lead stored corpus, 2026-08-02
  // — among the 48 non-Adzuna leads flagged thin at the time, sorted by
  // required-text length, the single largest gap in the whole distribution is
  // 1,817 -> 2,449 characters (every other adjacent gap in that sorted list is
  // under 400). That is a real elbow in the corpus, not a pick; 2000 sits in
  // the gap. Honest limit: the corpus is 149 leads, all software-domain — it
  // cannot validate that 2000 correctly separates a FUTURE retarget's actual
  // out-of-domain postings, only that it is a real, evidenced break in this
  // corpus's length distribution rather than a guess. Overridable via
  // limits.fit.long_body_chars if a retarget's own corpus argues otherwise.
  //
  // `job.partial_description` (set by screen.mjs whenever a lead has no full
  // captured posting — true for every Adzuna lead, which only ever returns a
  // teaser) exempts a lead from `lexicon_blind` regardless of length: we
  // already KNOW that body is a fragment, so blaming the lexicon for failing
  // to find terms in text we know is incomplete would be a false claim. This
  // mirrors screen.mjs's own thin_description ghost-signal, which is
  // "skipped when the text is a known-truncated aggregator teaser, which is
  // short because of the source, not because the posting is empty".
  if (!evaluable) {
    const isLong =
      !job.partial_description && requiredText.length >= cfg.long_body_chars
    flags.push(isLong ? "lexicon_blind" : "posting_thin")
  }

  if (evaluable && overlap < cfg.reject_below) {
    reasons.push(
      `l2: stack mismatch — matches ${matched.length} of ${denom} required technologies (${missing.slice(0, 6).join(", ")})`,
    )
  } else if (
    evaluable &&
    senior.length >= cfg.senior_phrase_reject &&
    overlap < cfg.caution_below
  ) {
    // Senior scope alone never rejects — plenty of mid-level postings borrow
    // the language. Senior scope AND a weak stack match is a different claim.
    reasons.push(
      `l2: senior-scope responsibilities (${senior.slice(0, 3).join(", ")}) with a weak stack match (${matched.length}/${denom})`,
    )
  } else if (evaluable && overlap < cfg.caution_below) {
    flags.push("fit_weak")
  }

  if (senior.length >= cfg.senior_phrase_reject && !reasons.length) {
    flags.push("senior_scope")
  }

  return {
    ok: reasons.length === 0,
    reasons,
    flags,
    fit_score: overlap == null ? null : Math.round(overlap * 100) / 100,
    required_terms: [...requiredTech].sort(),
    matched_terms: matched.sort(),
    missing_terms: missing.sort(),
    preferred_terms: preferredTech.sort(),
    bonus_terms: bonus.sort(),
    senior_signals: senior,
  }
}

// Whether a scoreFit() result carries a trustworthy fit_score at all —
// exported as a FUNCTION, not a flag-name list, because a consumer matching
// on flag names is fragile by construction: `automatability.mjs`'s
// `fitSortKey` (w4-autonomy) had to recompute this exact rule itself
// (`required_terms.length >= min_required_terms`) since nothing here exported
// it, which is a second copy of a rule that silently stops meaning the same
// thing the moment evaluability's definition changes here — precisely the
// risk splitting `fit_thin` into `posting_thin`/`lexicon_blind` created. A
// predicate function survives that; a name list would not.
//
// Takes the SAME limits the caller scored the lead with, never a literal
// default, so this cannot disagree with the min_required_terms `scoreFit`
// itself used for that result.
export function isEvaluable(result, opts = {}) {
  const cfg = { ...FIT_DEFAULTS, ...(opts.limits?.fit ?? {}) }
  if (!result) return false
  if (result.fit_score == null) return false
  return (result.required_terms?.length ?? 0) >= cfg.min_required_terms
}
