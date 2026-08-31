// The unattended-assent policy: WHICH assent-shaped fields the runner may act
// on without a human on the page, read from the user's own limits file.
//
// WHY THIS FILE EXISTS. Measured on the 2026-08-17 live run: 7 of 8 deferrals
// were assent fields — work-authorisation and sponsorship answers the user had
// already banked (`confirm-field`), radio/checkbox groups whose answer the bank
// held (`confirm-widget`), and consent tickboxes (`consent-tickbox`). Every one
// of them defers by design on the unattended path, and every US application
// form carries several, so an unattended run on US forms submitted nothing and
// structurally never could. On 2026-08-18 the user decided the policy in
// their own words: "If required, fuzzy exact. Otherwise leave them alone." —
// with the match strength clarified as answer-bank's status OK (fuzzy wording
// allowed, polarity/intent-checked, one entry fits) — and, for consent boxes,
// "tick required, except legal-weight" (arbitration, background check,
// e-signature stay theirs).
//
// THE SHAPE OF THE CONTROL, and why it is a config key rather than a code
// change. fill-plan.mjs's header records two earlier attempts at this — a
// consent-allowlist grant deleted on 2026-08-01 because "one config key away
// from on" was judged unsafe, and an exact-banked CONFIRM fill reverted on
// 2026-08-04 because a hostile fixture defeats it — and both were reasoned
// from the position that the assent decision was NOT the user's yet. It now
// is. What that changes is not the security analysis (which is unchanged and
// still true: a lying label deceives the machine exactly as it deceives a
// human) but WHO decides whether to accept it. So the grant lives in the
// user's file, defaults to OFF, and every branch that acts under it records
// what it did in `plan.actuated` with the grant's name — the user is
// delegating assent, not waiving the record of it (hard rule 6).
//
// WHAT NEVER MOVES, whatever this file says:
//   * UNKNOWN / NEEDS-CHOICE / MAYBE still defer. The policy widens what a
//     RESOLVED answer may do; it never resolves anything. Rule 6: throughput
//     rises only through deterministic understanding.
//   * fieldIdentityMismatch still wins over every grant — a control whose
//     id/name/autocomplete contradict its label is deferred before any grant is
//     consulted.
//   * legal-weight consent (isHardConsent) defers under `non-legal`, which is
//     the user's chosen setting; `all` exists so the file can say otherwise
//     explicitly, never by default.
//   * a consent tick needs a VOUCHED label (scan-page's `labelExact`) — the
//     decoupling attack (matched on one string, showing another) is a
//     different attack from a lying label and is still closed mechanically.
//
// THE KEYS, under `auto_apply.unattended_assent` in docs/application-limits.yaml
// (the user's file — this reads it and never writes it):
//
//   required_assertions: true|false   fill a REQUIRED assertion-class answer
//                                     (work authorisation, sponsorship…) that
//                                     answer-bank resolved with status OK
//   required_widgets:    true|false   tick/select a REQUIRED radio/checkbox
//                                     group whose banked answer names one of
//                                     its options (status OK, a real pick)
//   required_consent:    none|non-legal|all
//                                     tick a REQUIRED consent box (vouched
//                                     label); `non-legal` excludes arbitration,
//                                     background check and e-signature
//   optional:            defer|skip   what an OPTIONAL assent field does:
//                                     `skip` leaves it empty and lets the
//                                     submit proceed; `defer` is today's
//                                     behaviour (blocks the unattended click)
//
// A key that is absent, misspelt or malformed is the OFF value for that key —
// a typo in the user's YAML must not be able to switch a grant on.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadYamlFile } from "#lib/lib.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

/** Every grant OFF. This is what every existing test and every caller that
 *  does not pass a policy runs under, and it is byte-for-byte today's
 *  behaviour. */
export const ASSENT_OFF = Object.freeze({
  required_assertions: false,
  required_widgets: false,
  required_consent: "none",
  optional: "defer",
})

/** The names a granted `actuated` entry carries. Closed set: submitReadiness
 *  exempts an entry only when its grant is one of these AND the policy it was
 *  handed enables that grant. */
export const GRANTS = Object.freeze({
  REQUIRED_ASSERTION: "required-assertion",
  REQUIRED_WIDGET: "required-widget",
  REQUIRED_CONSENT: "required-consent",
})

const CONSENT_VALUES = new Set(["none", "non-legal", "all"])
const OPTIONAL_VALUES = new Set(["defer", "skip"])

/**
 * Normalise anything into a policy. Booleans must be literal `true`; strings
 * must be one of the enumerated values; everything else is the OFF value.
 * Never throws.
 */
export function normalizeAssentPolicy(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
  return Object.freeze({
    required_assertions: r.required_assertions === true,
    required_widgets: r.required_widgets === true,
    required_consent: CONSENT_VALUES.has(r.required_consent)
      ? r.required_consent
      : "none",
    optional: OPTIONAL_VALUES.has(r.optional) ? r.optional : "defer",
  })
}

/**
 * Read `auto_apply.unattended_assent` from the user's limits file.
 * An absent, unreadable or unparsable file is the OFF policy — the safe
 * direction, same as loadDisclosureLimits and loadConsentAllowlist.
 */
export function loadAssentPolicy({
  limitsFile = path.join(ROOT, "docs", "application-limits.yaml"),
} = {}) {
  let auto = null
  try {
    if (limitsFile && fs.existsSync(limitsFile))
      auto = loadYamlFile(limitsFile)?.auto_apply
  } catch {
    /* unreadable or malformed: every grant stays off */
  }
  return normalizeAssentPolicy(auto?.unattended_assent)
}

/** True when this policy enables the named grant. Unknown grant → false. */
export function grantEnabled(policy, grant) {
  const p = normalizeAssentPolicy(policy)
  switch (grant) {
    case GRANTS.REQUIRED_ASSERTION:
      return p.required_assertions
    case GRANTS.REQUIRED_WIDGET:
      return p.required_widgets
    case GRANTS.REQUIRED_CONSENT:
      return p.required_consent !== "none"
    default:
      return false
  }
}

/** Is any grant on at all? Reports and digests use this to say whether a run
 *  ran under a policy. */
export function anyGrant(policy) {
  const p = normalizeAssentPolicy(policy)
  return (
    p.required_assertions ||
    p.required_widgets ||
    p.required_consent !== "none" ||
    p.optional === "skip"
  )
}
