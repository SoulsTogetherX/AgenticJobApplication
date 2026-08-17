// How far the machine can carry a lead: the applicability tiers.
//
// Shared by prep-queue.mjs (which orders its queue by it) and recommend.mjs
// (which can now print the automatable leads on their own). One module rather
// than a copy in each, and rather than a static import cycle between two
// scripts that each import the other.
import { allowlistEntry } from "../auto/trust.mjs"

// --- applicability: can the machine actually finish this one? -----------------
//
// WHY THIS EXISTS. Score alone ranks by fit, which is the right question for a
// human reading a list and the wrong one for a queue whose output is a tailored
// document. Measured on the real store 2026-08-09: 81 of 81 adzuna leads and
// 14 of 14 jobicy leads carry no `apply_url`, because those two aggregators do
// not expose the employer's posting to anything but a logged-in browser (four
// resolution paths were tried and all are closed — see canonical.mjs). They are
// 46% of the store, they outrank everything on fit, and they filled all ten
// prep slots on the 2026-08-09 cycle while nine ready-to-apply leads — Cloudflare
// x3, OpenAI x2, Twilio, Coinbase, Wynn Resorts — sat below the cut-off. Zero
// documents were prepared that run.
//
// THEY ARE ORDERED, NOT DROPPED. An unresolvable lead is still a job the user
// can apply to by hand, and the cycle report names them for exactly that reason.
// Filtering them out would hide supply; ranking them below the leads the machine
// can finish spends the ten slots on work that produces something.
//
// TIER 1 IS THE INTERESTING ONE. A lead can resolve to a real ATS posting and
// still be refused by the gate because its board is not on the user's allowlist
// — SmartRecruiters, Workday and Oracle Cloud all resolve here and none has an
// adapter this repo ships. Those rank above the unresolvable ones (they are one
// adapter away from automatable) and below the ones that work today.
export const APPLICABILITY = Object.freeze({
  AUTOMATABLE: 0, // resolved to an ATS posting on the user's allowlist
  RESOLVED_OFF_ALLOWLIST: 1, // resolved, but no adapter/allowlist entry serves it
  MANUAL_ONLY: 2, // never resolved past the aggregator — hand-apply only
})

/** Tier -> the name reported to agents and humans. Indexed by tier number. */
export const APPLICABILITY_NAMES = Object.freeze([
  "automatable",
  "off-allowlist",
  "manual-only",
])

/**
 * How far the machine can carry this lead. Pure; `entries` is a normalised
 * allowlist (an empty one collapses tier 0 into tier 1, which is correct — with
 * no allowlist nothing is automatable).
 */
export function applicability(lead, entries = []) {
  if (!lead?.apply_url) return APPLICABILITY.MANUAL_ONLY
  let host
  try {
    host = new URL(lead.apply_url).hostname
  } catch {
    // An apply_url that does not parse is not one. Same door as canonical.mjs:
    // never "resolved to whatever it gave us".
    return APPLICABILITY.MANUAL_ONLY
  }
  return allowlistEntry(host, entries)
    ? APPLICABILITY.AUTOMATABLE
    : APPLICABILITY.RESOLVED_OFF_ALLOWLIST
}

/**
 * Stable partition of a ranked list by applicability, best tier first.
 *
 * MUST RUN BEFORE CLUSTERING, not inside buildQueue(). `buildQueue` relies on a
 * cluster leader appearing ahead of its members — it attaches a member to
 * `byLeader.get(leader)` with `?.`, so a member seen first is silently dropped.
 * Reordering upstream of clusterLeads() keeps leaders and members consistent
 * because the leaders are re-derived from this order.
 */
export function preferApplicable(ranked, entries = []) {
  return (
    [...(ranked ?? [])]
      .map((lead, i) => ({ lead, i, tier: applicability(lead, entries) }))
      // Score order is preserved within a tier: `i` breaks every tie, so this is
      // a reordering by applicability and nothing else.
      .sort((a, b) => a.tier - b.tier || a.i - b.i)
      .map((x) => x.lead)
  )
}
