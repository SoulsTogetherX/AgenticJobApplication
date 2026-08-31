// What one form extracts from the fact base — the two limits of autonomy plan
// v2 items 2.2 and 2.3. They live together because they answer the same
// question from two directions: 2.2 asks how MUCH of one banked answer a
// single field pulls, 2.3 asks how MANY distinct banked facts one form pulls.
//
// THE GAP BOTH CLOSE. The read side of the fact base is a lookup keyed on an
// attacker-chosen string: `normalizeQuestion` over the page's own label.
// Nothing before this counted the result. A hostile form that asks forty
// questions to harvest forty facts was indistinguishable from a long-but-honest
// one, and a textarea labelled "Anything else we should know?" was a fillable
// target that could pull a 235-character narrative the user wrote for a
// different employer.
//
// NEITHER IS A VOLUME THROTTLE. 2.2 defers a FIELD, never an application — the
// rest of the form still fills and the application still goes forward. 2.3
// defers one application, and only one whose disclosure set is outside the
// measured range of a real form. Unlimited application volume is deliberate
// (the caps are the user's); nothing here counts applications.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadYamlFile } from "#lib/lib.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

// ---------------------------------------------------------------------------
// the numbers, and where they come from
// ---------------------------------------------------------------------------
// MEASURED, not chosen. Both were taken on 2026-08-02 from this machine's real
// 47-entry `profile/answers.yaml` and the two real scanned forms in `jobs/`
// (Affirm/Greenhouse, 27 fields; Coinbase/Greenhouse, 35 fields). The
// measurement commands are in the commit message for this change; the numbers
// are restated here because a threshold whose basis is not written next to it
// becomes taste within a month.
//
// freeTextMaxChars: 200.
//   Answer lengths in the real bank, sorted: 45 of the 47 entries are 115
//   characters or shorter (median 22, p90 79). The two that are not are 223
//   and 235 characters, and both are prose — 40 words / 3 sentences and 29
//   words / 3 sentences. There is an EMPTY BAND between 115 and 223 with
//   nothing in it, and 200 sits inside that band: 74% clear of the longest
//   structured answer (a location, a notice period, a salary figure, a URL)
//   and 10% below the shortest narrative. It is not a guess about what a
//   sentence weighs; it is the gap the user's own data already has.
//
// disclosureFloor: 20, disclosureFraction: 0.25.
//   Bracketed from both ends rather than picked.
//
//   FROM BELOW — it must not fire on a form this pipeline has actually
//   planned. Measured: the two real scanned forms pull 6 and 9 DISTINCT bank
//   ids (over 27 and 35 fields respectively — most fields resolve from
//   profile.yaml, or not at all). The densest form the repository can produce
//   is not either of those: it is the `combo14` synthetic in the apply bench,
//   14 fields each answerable from its own distinct bank entry against a
//   14-entry bank, i.e. 100% of the fact base, built deliberately to be
//   maximally answerable. 14 is therefore the real floor constraint, not 9.
//
//   FROM ABOVE — it must fire well below the threat the plan names, which is
//   "a hostile form that asks forty questions to harvest forty facts". 20 is
//   43% above the densest form observed and half of the named harvest.
//
//   THE FRACTION exists because a floor alone does not scale: a bank of 200
//   answers legitimately lets a form resolve more fields from it, and
//   `budget = max(floor, ceil(bankSize * fraction))` grows with the store
//   instead of turning into a throttle on a user who has answered more
//   questions. At today's 47 entries the floor dominates (ceil(47*0.25) = 12);
//   past 80 entries the fraction takes over.
//
//   HONEST LIMIT OF THIS NUMBER: three forms is a small corpus, and 20 sits
//   nearer the "no false positive" end than an even split would. The right
//   input is a real distribution, which `jobs/.shape-history.jsonl`
//   (recordShapeHistory, item 0.12) is accumulating and which is empty today.
//   Tighten this against that file once it has forms in it; that is a
//   measurement, not a preference, and the number is configurable precisely so
//   it can move without a code change.
export const DEFAULT_LIMITS = Object.freeze({
  freeTextMaxChars: 200,
  disclosureFloor: 20,
  disclosureFraction: 0.25,
})

// CONFIGURABLE, not magic. Three layers, weakest first:
//
//   1. DEFAULT_LIMITS above.
//   2. `auto_apply` in docs/application-limits.yaml, if the user has put any
//      of `max_freetext_chars` / `disclosure_budget` / `disclosure_fraction`
//      there. That file is the USER'S — this reads it and never writes it, and
//      the keys are optional, so a file without them behaves exactly as today.
//   3. an explicit override from the caller (fill-plan.mjs's CLI flags), which
//      is what a dry-run report is produced with.
//
// A value that is not a finite positive number is IGNORED rather than
// corrected, and ignoring means falling back to the stricter default. A
// typo in the user's YAML must not be able to switch a limit off.
const positive = (v) => (Number.isFinite(v) && v > 0 ? v : null)

export function loadDisclosureLimits({
  limitsFile = path.join(ROOT, "docs", "application-limits.yaml"),
  overrides = {},
} = {}) {
  const out = { ...DEFAULT_LIMITS }
  let auto = null
  try {
    if (fs.existsSync(limitsFile)) auto = loadYamlFile(limitsFile)?.auto_apply
  } catch {
    /* an unreadable or unparsable limits file leaves the defaults standing —
       the safe direction, same as loadConsentAllowlist's empty set. */
  }
  if (auto && typeof auto === "object") {
    const a = positive(Number(auto.max_freetext_chars))
    const b = positive(Number(auto.disclosure_budget))
    const c = positive(Number(auto.disclosure_fraction))
    if (a) out.freeTextMaxChars = a
    if (b) out.disclosureFloor = b
    if (c && c <= 1) out.disclosureFraction = c
  }
  for (const k of Object.keys(DEFAULT_LIMITS)) {
    const v = positive(Number(overrides[k]))
    if (v) out[k] = v
  }
  return out
}

// ---------------------------------------------------------------------------
// 2.2 — long bank-sourced free text defers, as a FIELD
// ---------------------------------------------------------------------------
// `answer-bank.mjs`'s SKIP_TYPES skips `file` and `richtext`, so a `textarea`
// is an ordinary fillable target: a banked answer resolves onto it and the
// engine types it in. That is right for "Notice period" and wrong for
// "Anything else we should know?".
//
// SCOPED TO BANK-SOURCED VALUES on purpose. A long value from profile.yaml is
// not the hazard: profile facts are a fixed, small, structured set the user
// curated as their public-facing record, and none of them is a narrative. The
// answer bank is the open-ended store that grows one form question at a time,
// and it is the one a page can address by choosing a label.
const BANK_SOURCE_RE = /^(?:a-\d+)@|^bank\./

// Types where a 200-character value is a NARRATIVE rather than a long datum.
// A select/combo/radio/checkbox has an option list, so its value is bounded by
// what the page offers and this rule has nothing to say about it.
const FREE_TEXT_TYPES = new Set(["textarea", "text", "richtext"])

/**
 * Why this field's resolved value must not be filled unattended, or null.
 *
 * Returns a REASON STRING, never a boolean: hard rule 6 says an application
 * the agent declined to send must say why in terms the user can act on, and a
 * defer whose `note` is "true" is a silent skip wearing a different hat.
 */
export function longFreeTextReason(field, resolved, limits = DEFAULT_LIMITS) {
  if (!FREE_TEXT_TYPES.has(field?.t)) return null
  const source = String(resolved?.source ?? "")
  if (!BANK_SOURCE_RE.test(source)) return null
  const value = String(resolved?.value ?? "")
  if (value.length <= limits.freeTextMaxChars) return null
  const id = /^(a-\d+)@/.exec(source)?.[1] ?? source
  return (
    `${value.length} characters of banked free text (${id}) exceeds the ` +
    `${limits.freeTextMaxChars}-character unattended limit — a long answer ` +
    `written for one employer is not automatically right for this one; ` +
    `paste or edit it by hand`
  )
}

// ---------------------------------------------------------------------------
// 2.3 — the per-form disclosure declaration
// ---------------------------------------------------------------------------
/**
 * Name the bank ids this plan will disclose, and say whether the set is
 * unusual.
 *
 * WHAT COUNTS. Only ids on rows that will actually be FILLED — `items` with a
 * real verb and a value. A deferred field discloses nothing: its value goes
 * into the approval message the user reads, not into the page. A `skip` item
 * discloses nothing either. Counting defers would make the number rise exactly
 * when the pipeline got more cautious, which is backwards.
 *
 * WHAT DOES NOT COUNT, AND WHY. Profile-sourced fields (`contact.email`,
 * `experience.current`, `education`) are recorded in `profileFields` for the
 * record but are not budgeted. They are a fixed, small, enumerable set that
 * every honest application form asks for; there is no long tail to harvest and
 * no way for a page to make the pipeline disclose a profile fact it does not
 * have a rule for. The answer bank is the open-ended one.
 *
 * @param {object[]} items         plan items (post-build)
 * @param {object[]} resolved      answer-bank rows, for `source`
 * @param {number}   bankSize      entries in answers.yaml; 0 when unknown
 * @param {object}   limits        from loadDisclosureLimits()
 */
export function buildDisclosure(
  items,
  resolved,
  { bankSize = 0, limits = DEFAULT_LIMITS } = {},
) {
  const bySource = new Map(
    (resolved ?? []).map((r) => [r.k, String(r.source ?? "")]),
  )
  const ids = new Set()
  const profileFields = new Set()
  for (const it of items ?? []) {
    if (!it || it.how === "skip") continue
    // An upload discloses a rendered document, not a bank fact, and the
    // document went through verify-claims and the user's approval already.
    if (it.how === "upload") continue
    if (it.value === "" || it.value == null) continue
    const src = bySource.get(it.k) ?? ""
    const m = /^(a-\d+)@/.exec(src)
    if (m) ids.add(m[1])
    else if (src && src !== "-") profileFields.add(src.split("@")[0])
  }
  const budget = Math.max(
    limits.disclosureFloor,
    Math.ceil(bankSize * limits.disclosureFraction),
  )
  const list = [...ids].sort()
  const unusual = list.length > budget
  return {
    ids: list,
    count: list.length,
    profileFields: [...profileFields].sort(),
    bankSize,
    budget,
    unusual,
    reason: unusual
      ? `this form would disclose ${list.length} distinct banked facts ` +
        `(${list.join(", ")}); the budget is ${budget} ` +
        `(max of a floor of ${limits.disclosureFloor} and ` +
        `${Math.round(limits.disclosureFraction * 100)}% of a ${bankSize}-entry ` +
        `bank). A form asking for more of the fact base than any measured real ` +
        `one is not understood well enough to fill unattended`
      : null,
  }
}

/** The shape a plan carries when there was nothing to declare. */
export const emptyDisclosure = (limits = DEFAULT_LIMITS, bankSize = 0) =>
  buildDisclosure([], [], { bankSize, limits })
