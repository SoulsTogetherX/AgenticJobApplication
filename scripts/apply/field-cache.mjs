// Remembers the SHAPE of a form we have already filled: which widget each
// field is, what options it offers, and (once learned) which combo strategy
// actually worked on it.
//
// Why it matters: the expensive half of a page scan is probing custom
// dropdowns. The scanner opens each one, waits for the menu to render, reads
// the options and closes it again — up to 15 of them, in the browser, every
// time. Everything it learns is identical on the next application to the same
// board, so it only ever needs learning once.
//
// Keyed by the form's shape rather than its URL: two Coinbase postings are
// different URLs but the same Greenhouse form, and a board that redesigns its
// form gets a different fingerprint and re-probes automatically.
//
// The cache never stores answers — only the structure of the page. Answers live
// in profile/answers.yaml and go through save-answer.mjs.
import fs from "node:fs"
import crypto from "node:crypto"

// Bumped 2 -> 3: a checkbox/radio group whose COMPLETE visible label exceeds
// 120 chars and now earns the scan-page.js vouch gets a new, longer `f.l` —
// fieldKey() below hashes `norm(f.l)`, so the field's own key changes and the
// old cache entry is orphaned (never read again, harmlessly). Second-order:
// `fingerprint()` hashes `norm(f.l)` of every REQUIRED field, so a required
// consent box whose label just got longer changes the board's fingerprint
// too — one full re-probe per board, once. Third-order: scan-page.js's own
// isReq() matches a trailing `*`, which used to sit past the old 120-char
// cut on some labels — a field can newly read as `req:true`, which ALSO
// feeds the fingerprint. loadCache() already starts clean on any mismatch,
// so bumping this is the whole fix; no migration code needed.
export const CACHE_VERSION = 3

// scan-page.js's own MAX_OPTS (40) already truncates a long list before it
// ever reaches this file; this cap exists so a caller that hands recordCache
// a list some OTHER way (bypassing that scanner) cannot blow the cache file
// up unboundedly. It is deliberately above scan-page.js's cap, so under
// normal operation this file is never the one doing the cutting — see
// `optsTruncated` below for what happens when a list WAS cut somewhere.
const MAX_CACHED_OPTS = 60

const norm = (s) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()

// Keyed by label AND widget type: composite widgets put a picker and a text
// input under one label (a phone country selector next to the number), and a
// label-only key would hand the country list to the text input.
const fieldKey = (f) => `${norm(f.l)}|${f.t ?? ""}`

// Required labels only: optional fields (EEO blocks especially) come and go
// between postings on the same board and would churn the key for no reason.
export function fingerprint(scan, atsId) {
  const labels = (scan.fields ?? [])
    .filter((f) => f.req)
    .map((f) => norm(f.l))
    .filter(Boolean)
    .sort()
  const basis = `${atsId}|${labels.join("\n")}`
  return crypto.createHash("sha1").update(basis).digest("hex").slice(0, 16)
}

export function loadCache(file) {
  if (!fs.existsSync(file)) return { v: CACHE_VERSION, forms: {} }
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"))
    // A version bump means the shape changed; start clean rather than guess.
    if (c.v !== CACHE_VERSION) return { v: CACHE_VERSION, forms: {} }
    c.forms ??= {}
    return c
  } catch {
    return { v: CACHE_VERSION, forms: {} }
  }
}

export function saveCache(file, cache) {
  fs.writeFileSync(file, JSON.stringify(cache, null, 2) + "\n")
}

// Fill in what this scan did not capture. Never overwrites live data — a fresh
// probe always wins over a remembered one.
//
// Reports THREE counts, not two, against every field that needs an option
// list — not just the ones the cache happened to know:
//   probed  this scan already opened the dropdown itself
//   hits    the cache supplied options this scan did not have to probe
//   miss    NEITHER of the above — a combo/select the cache has never seen
//           and this scan did not probe either. This is the count that used
//           to vanish: a field landing here previously incremented nothing,
//           so a form that is entirely new (every combo a genuine miss) and
//           a form with no combos at all both printed "0/0" — indistinguishable,
//           even though the first one needs a full probe and the second needs
//           nothing. `hits + probed + miss` is the true total of fields that
//           need an option list, so a caller can tell "nothing to probe" (all
//           three zero) from "everything needs probing" (miss > 0) apart.
export function applyCache(scan, entry) {
  let hits = 0
  let probed = 0
  let miss = 0
  for (const f of scan.fields ?? []) {
    const wantsOptions = f.t === "combo" || f.t === "select"
    if (Array.isArray(f.opts) && f.opts.length) {
      if (wantsOptions) probed++
      continue
    }
    const known = entry?.fields?.[fieldKey(f)]
    if (known && Array.isArray(known.opts) && known.opts.length) {
      f.opts = known.opts.slice()
      if (known.optsTruncated) f.optsTruncated = true
      // The REAL count, when the scanner (or a previous field-cache write)
      // recorded one. Re-served alongside the cached list so a caller that
      // only sees a re-served options array still knows "40 of 200", not
      // just "40, maybe incomplete" — see answer-bank.mjs's noteFor(), which
      // reads this to give the user a number instead of a caveat with no
      // scale.
      if (known.optsTotal) f.optsTotal = known.optsTotal
      if (wantsOptions) hits++
    } else if (wantsOptions) {
      miss++
    }
    if (known && !f.sel && known.sel) f.sel = known.sel
    if (known && known.via && !f.via) f.via = known.via
  }
  return { hits, probed, miss }
}

// Remember whatever this scan did learn, merging over any earlier entry.
//
// `optsTruncated` travels with the options themselves: a field the scanner
// (or field-cache's own MAX_CACHED_OPTS cap) cut short is flagged so a later
// reader never treats the cached list as exhaustive. scan-page.js does not
// yet emit this — MAX_OPTS=40 there truncates silently — so today this only
// ever fires from field-cache's OWN cap; the field is read defensively
// (`f.optsTruncated`) so the day the scanner starts reporting it, the whole
// chain (cache -> answer-bank's NEEDS-CHOICE note) lights up with no further
// changes here.
export function recordCache(cache, { fp, scan, atsId, url, now = new Date() }) {
  const entry = cache.forms[fp] ?? { ats: atsId, fields: {} }
  entry.ats = atsId
  entry.url = url ?? entry.url
  entry.updated = now.toISOString().slice(0, 10)
  for (const f of scan.fields ?? []) {
    if (!norm(f.l)) continue
    const key = fieldKey(f)
    const prev = entry.fields[key] ?? {}
    // `l` and `req` are the label as the form writes it and whether the form
    // insists on it. They are shape, like the options are, and they are what
    // pending-questions.mjs needs to say "these four applications will all ask
    // this, and the fact base cannot answer it" before a browser is opened.
    const next = { t: f.t ?? prev.t, l: f.l ?? prev.l }
    const req = f.req ?? prev.req
    if (req) next.req = true
    const freshOpts = Array.isArray(f.opts) && f.opts.length
    const opts = freshOpts ? f.opts : prev.opts
    if (opts) {
      next.opts = opts.slice(0, MAX_CACHED_OPTS)
      // Truncated if THIS scan says so, if field-cache's own cap just cut it,
      // or if we are reusing an earlier entry that was already flagged —
      // reusing prev.opts must not quietly drop a truncation warning just
      // because this particular scan did not re-probe.
      const truncated =
        !!f.optsTruncated ||
        opts.length > MAX_CACHED_OPTS ||
        (!freshOpts && !!prev.optsTruncated)
      if (truncated) next.optsTruncated = true
      // The real total, same freshness rule as opts/optsTruncated above: a
      // fresh scan's number wins, and a re-record that did not re-probe
      // keeps whatever the cache already knew rather than silently dropping
      // it. Both scanners set this from the actual DOM/react-select list
      // length, not the post-cut array length, so it survives being cut
      // again by MAX_CACHED_OPTS here.
      const total = freshOpts ? f.optsTotal : (f.optsTotal ?? prev.optsTotal)
      if (total) next.optsTotal = total
    }
    const sel = f.sel ?? prev.sel
    if (sel) next.sel = sel
    const via = f.via ?? prev.via
    if (via) next.via = via
    entry.fields[key] = next
  }
  cache.forms[fp] = entry
  return entry
}

// Called when the browser reported a mismatch on a field we thought we knew —
// the remembered shape is wrong, so it must go rather than be trusted again.
export function invalidate(cache, fp) {
  if (!cache.forms[fp]) return false
  delete cache.forms[fp]
  return true
}

// Persist which combo strategy actually worked, so the next application to
// this same form does not re-discover it (measured at 1.5-2.5s per combo,
// walking the adapter's whole strategy list). `report` is exactly what
// fill-engine.mjs's fillPage() returns: `comboVia` is `{ [item.k]: via }` for
// every combo it filled, `comboStrategy` is the single strategy that won the
// most combos on this form. `plan` is the SAME plan object that was just
// filled — its `items[].label` is what maps an engine key back to this
// cache's label|type field key.
//
// `item.matchedLabel ?? item.label`, not `item.label` alone: fill-plan.mjs's
// buildPlan() shows the user the PAGE's visible label (`lSeen`) when it
// disagrees with the label the scan actually matched on, and rides the
// matched string along as `item.matchedLabel` whenever the two differ (see
// buildPlan's own comment on why `l`/the matched string is what fieldKey()
// keys on — it is never repointed). Looking this cache up by the DISPLAYED
// string for such a field would silently stop finding it — not a wrong
// answer, just a missed optimisation (the combo strategy hint would not be
// remembered), so this reads the matched string when it is available.
export function recordVia(cache, fp, plan, report) {
  const entry = cache.forms[fp]
  if (!entry) return 0
  const comboVia = report?.comboVia ?? {}
  let updated = 0
  for (const item of plan?.items ?? []) {
    if (item.how !== "combo") continue
    const via = comboVia[item.k]
    if (!via) continue
    const field = entry.fields[`${norm(item.matchedLabel ?? item.label)}|combo`]
    if (!field) continue
    field.via = via
    updated++
  }
  // The board-level summary: even a combo the fact base could not resolve
  // (so it never became a plan item, and therefore never got a per-field
  // `via`) benefits from trying the board's usual winner first.
  if (report?.comboStrategy) entry.comboStrategy = report.comboStrategy
  return updated
}
