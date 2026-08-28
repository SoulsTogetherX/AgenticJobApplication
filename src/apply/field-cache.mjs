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
import { withLock, lockPathFor } from "#lib/lock.mjs"

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
//
// Bumped 3 -> 4 (Phase 0.5, 2026-08-02): `fingerprint()` now hashes the form's
// HOST as well as its ATS id and required labels, so every fingerprint written
// under v3 is wrong for the new basis and must not be re-served. Bumped
// deliberately rather than leaning on the accident that the on-disk file was
// already at v2 against a CACHE_VERSION of 3 — that accident made the change
// free TODAY, and would silently stop making it free the moment anyone
// regenerated the cache.
export const CACHE_VERSION = 4

// scan-page.js's own MAX_OPTS (250 since 2026-08-21, was 40) already
// truncates a long list before it ever reaches this file; this cap exists so
// a caller that hands recordCache a list some OTHER way (bypassing that
// scanner) cannot blow the cache file up unboundedly. It is deliberately
// above scan-page.js's cap — under normal operation this file is never the
// one doing the cutting, and a cache cap BELOW the scanner's would flag every
// full country list as truncated, refuse to serve it, and buy a ~2s re-probe
// on every run for nothing. See `optsTruncated` below for what happens when
// a list WAS cut somewhere.
const MAX_CACHED_OPTS = 300

const norm = (s) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()

// Keyed by label AND widget type: composite widgets put a picker and a text
// input under one label (a phone country selector next to the number), and a
// label-only key would hand the country list to the text input.
const fieldKey = (f) => `${norm(f.l)}|${f.t ?? ""}`

// The host the form was served from, lowercased, `www.` stripped, no port and
// no path — the unit `fingerprint()` below adds to the basis (Phase 0.5).
//
// A scan with no URL, or one that does not parse as a URL, returns the
// sentinel `"?"` rather than throwing or falling back to the old basis. That
// keeps a cache entry POSSIBLE for such a scan (they still collide with each
// other, which is no worse than before) while keeping it distinct from every
// real host, so a URL-less scan can never be served a real board's remembered
// shape. Deliberately not an exception: fingerprint() is called on the plan
// path before anything is filled, and a scan fixture without a URL is a
// legitimate input to it.
export function hostOf(url) {
  const raw = String(url ?? "").trim()
  if (!raw) return "?"
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "") || "?"
  } catch {
    return "?"
  }
}

// Required labels only: optional fields (EEO blocks especially) come and go
// between postings on the same board and would churn the key for no reason.
//
// FIX (Phase 0.5, 2026-08-02): the basis was `atsId + "|" + labels`, which is
// cross-tenant BY CONSTRUCTION — every employer on the same ATS whose required
// fields carry the same labels (name, email, resume: the common case) shared
// one fingerprint, so employer B was served employer A's remembered option
// lists and selectors. That is wrong DATA, not merely a missed optimisation:
// a "How did you hear about us?" list is written per employer, and the cache
// would re-serve one company's list on another company's form.
//
// The host is the unit added. It is NOT the URL: the test above this one
// ("the key follows the form's required shape, not its URL") encodes a
// deliberate prior decision that two postings by the same employer must share
// a key, and adding the host keeps that — `/x/jobs/1` and `/y/jobs/99` on one
// host still agree. What the host does NOT separate is path-based tenancy
// (`job-boards.greenhouse.io/<employer>/jobs/<id>`, and Lever's equivalent),
// where two employers still collide. Closing that would mean keying on the
// first path segment, which over-fragments embedded Greenhouse
// (`/embed/job_app?token=<per-posting>`) into a cache that never hits — the
// same silent-amber failure the v2/v3 discard bug was. It is a policy change
// with a latency cost, so it is left named here rather than taken quietly.
export function fingerprint(scan, atsId) {
  const labels = (scan.fields ?? [])
    .filter((f) => f.req)
    .map((f) => norm(f.l))
    .filter(Boolean)
    .sort()
  const basis = `${atsId}|${hostOf(scan.url)}|${labels.join("\n")}`
  return crypto.createHash("sha1").update(basis).digest("hex").slice(0, 16)
}

export function loadCache(file) {
  if (!fs.existsSync(file)) return { v: CACHE_VERSION, forms: {} }
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"))
    // A version bump means the shape changed; start clean rather than guess —
    // that part stays correct, unchanged.
    //
    // FIX (w3-resolution, 2026-08-01): the discard used to be SILENT. Found
    // live: jobs/.field-cache.json sat at v2 while CACHE_VERSION moved to 3
    // (the bump at :20-30, for an unrelated reason), so every one of its 7
    // real fingerprints was thrown away on every load with nothing printed
    // anywhere — green tier went unreachable for every lead (every board
    // reads "no remembered form shape", the same amber reason a board this
    // pipeline has genuinely never seen would report) and nobody could tell
    // the two apart from the CLI output. The discard is still correct; only
    // its silence was the bug. `discarded` also travels on the return value,
    // not just to stderr, so a caller can act on the count without scraping
    // console output.
    if (c.v !== CACHE_VERSION) {
      const forms = Object.keys(c.forms ?? {}).length
      console.error(
        `field-cache: discarding ${forms} remembered form(s) — cache is ` +
          `v${c.v ?? "?"}, this build expects v${CACHE_VERSION} (${file})`,
      )
      return {
        v: CACHE_VERSION,
        forms: {},
        discarded: {
          fromVersion: c.v ?? null,
          toVersion: CACHE_VERSION,
          forms,
        },
      }
    }
    c.forms ??= {}
    return c
  } catch {
    // Same silence, same fix: a file that exists but does not parse is also
    // a discard, just one where the prior form count cannot be known.
    console.error(`field-cache: could not read ${file} — starting clean`)
    return { v: CACHE_VERSION, forms: {}, discarded: { reason: "unreadable" } }
  }
}

// Written whole-then-renamed, so a reader that lands mid-write sees the
// previous complete file rather than half a JSON document. That matters now
// that the unattended runner writes this file from up to eight workers while
// an attended `fill-plan.mjs` may be reading it (Phase 4, 2026-08-14):
// `loadCache` treats an unparseable file as a discard, so a torn read would
// silently drop every remembered form to amber for that one plan.
//
// Rename can fail on Windows while another process has the file open for
// reading (EPERM/EBUSY, a race measured in microseconds). The retry covers
// that; the direct-write fallback after it keeps the save from being lost —
// writers are already serialised by `updateCache`'s lock, so the fallback can
// only race a READER, and only in that vanishing window.
export function saveCache(file, cache) {
  const bytes = JSON.stringify(cache, null, 2) + "\n"
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, bytes)
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file)
      return
    } catch (e) {
      if (attempt < 5 && (e.code === "EPERM" || e.code === "EBUSY")) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
        continue
      }
      try {
        fs.unlinkSync(tmp)
      } catch {}
      fs.writeFileSync(file, bytes)
      return
    }
  }
}

// One locked read-modify-write of the cache file. `mutator(cache)` runs with
// the file's lock held and MUST be synchronous — `withLock` throws if it
// returns a promise, and that refusal is load-bearing here: `acquire` waits
// with a blocking sleep, so a second worker in the SAME process reaching this
// lock while a first worker was parked on an `await` inside the hold would
// stall the whole event loop — first worker included — until the lock timed
// out. A synchronous body cannot yield, so the hold is over before any other
// worker can reach the acquire. Everything this file does under the lock is
// synchronous fs, so nothing is lost by the rule.
//
// Why a lock at all: the runner fills up to eight applications concurrently
// and each records what it learned; without this, two workers loading, merging
// and saving at once lose one worker's write (the classic lost update), and
// the attended CLI writing the same file from another process loses it too.
// Both paths — `stages.mjs` and `fill-plan.mjs` main() — write through this
// helper, because a lock only one side takes is not a lock.
export function updateCache(file, mutator, lockOpts = {}) {
  return withLock(
    lockPathFor(file),
    () => {
      const cache = loadCache(file)
      const result = mutator(cache)
      saveCache(file, cache)
      return result
    },
    lockOpts,
  )
}

// A board-level hint: even a combo the fact base could not resolve (so it
// never became a plan item and has no per-field `via`) is worth trying with
// whatever strategy usually wins on this form first. Reorders IN PLACE and
// only when the remembered strategy is one the adapter still offers — a
// strategy the adapter dropped must not be resurrected from the cache.
// Extracted from fill-plan.mjs main() so the unattended path (stages.mjs)
// promotes the same way the CLI does, instead of a second copy that drifts.
// Returns true when the order changed.
export function promoteComboStrategy(plan, entry) {
  const want = entry?.comboStrategy
  if (!want || !Array.isArray(plan?.comboStrategies)) return false
  if (!plan.comboStrategies.includes(want)) return false
  if (plan.comboStrategies[0] === want) return false
  plan.comboStrategies = [
    want,
    ...plan.comboStrategies.filter((s) => s !== want),
  ]
  return true
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
//
// THE STRATEGY HINT AND SELECTOR ARE MERGED WHETHER OR NOT THE SCAN PROBED
// (Phase 4, 2026-08-14). This used to `continue` past a field that already
// carried options, which was right for the OPTIONS — a fresh probe wins — but
// also skipped the `via`/`sel` merge below it, so a combo the scanner had just
// re-probed never received the strategy learned on the last application. On
// the unattended path every combo is re-probed on every application until the
// scanner is handed the cache's options, which made the hint unreachable on
// exactly the path that most needed it. `via` and `sel` are never something a
// probe produces, so a probe cannot be "fresher" than the cache about them.
//
// And options the SCANNER took from the cache (`opts_from: "cache"`, set by
// scan-engine.mjs when a caller supplies knownOpts) are a hit, not a probe —
// the browser did no work for them. Counting them as probed would report a
// warm scan as cold.
export function applyCache(scan, entry) {
  let hits = 0
  let probed = 0
  let miss = 0
  for (const f of scan.fields ?? []) {
    const wantsOptions = f.t === "combo" || f.t === "select"
    const known = entry?.fields?.[fieldKey(f)]
    if (Array.isArray(f.opts) && f.opts.length) {
      if (wantsOptions) {
        if (f.opts_from === "cache") hits++
        else probed++
      }
    } else if (known && Array.isArray(known.opts) && known.opts.length) {
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

// What the scanner may be told BEFORE it opens a single dropdown (Phase 5,
// 2026-08-14): the option lists this entry remembers, keyed by label, in the
// `{knownOpts, skipProbe}` shape scan-engine.mjs takes. A combo whose options
// arrive this way is not probed — measured at 1.5-2.5s per dropdown, that is
// the whole latency win of a warm cache — and applyCache() then reports it as
// a hit rather than a probe (`opts_from: "cache"`).
//
// Three refusals, each load-bearing:
//   * a TRUNCATED list is never served. `optsTruncated`, or an `optsTotal`
//     larger than what was kept, means the cache holds 40 of 200; the scanner
//     takes a supplied list as the WHOLE menu, so serving it would resolve an
//     answer past the cut as "not on offer" — a silent deferral on every
//     application to the board. A probe is what restores the true list, so
//     these fields fall through to one.
//   * a label two option-bearing fields share with DIFFERENT lists is dropped.
//     The scanner keys knownOpts by label alone (it has no cache key), so it
//     could hand either field the other's menu; ambiguity probes.
//   * `skipProbe` is EMPTY, on purpose. A combo answer must ground against
//     options (rule 1); nothing here may tell the scanner to skip a probe
//     without also supplying what the probe would have found.
export function knownOptsFromEntry(entry) {
  const knownOpts = {}
  const seen = new Map()
  const ambiguous = new Set()
  for (const [k, f] of Object.entries(entry?.fields ?? {})) {
    if (!f || (f.t !== "combo" && f.t !== "select")) continue
    if (!Array.isArray(f.opts) || !f.opts.length) continue
    if (f.optsTruncated || (f.optsTotal && f.optsTotal > f.opts.length))
      continue
    const label = norm(f.l ?? k.split("|")[0])
    if (!label) continue
    const list = f.opts.slice()
    const prior = seen.get(label)
    if (prior && JSON.stringify(prior) !== JSON.stringify(list)) {
      ambiguous.add(label)
      continue
    }
    seen.set(label, list)
    knownOpts[label] = list
  }
  for (const label of ambiguous) delete knownOpts[label]
  return { knownOpts, skipProbe: [] }
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
    // Display-only companion for a label the scanner cut at 120. Carried, not
    // keyed: fieldKey and the fingerprint stay on `l`, so old entries without
    // it load unchanged (no CACHE_VERSION move) and nothing matches on it.
    const lf = f.lFull ?? prev.lFull
    if (lf && lf !== next.l) next.lFull = lf
    entry.fields[key] = next
  }
  cache.forms[fp] = entry
  return entry
}

// --- shape-history sidecar (0.12 support, w3-resolution 2026-08-01) --------
// 0.12 asked one question — what fraction of real forms carry a checkbox or
// radio group, which permanently blocks green under automatability.mjs's
// shapeBlockers()? The honest answer today is "the sample is too small to
// gate anything" (n=6 real forms). What makes it answerable LATER, at zero
// browsing cost, is capturing this one bit on every scan that already
// happens as a side effect of an attended apply — which is exactly what
// `recordCache` below already does for the live cache, minus the history:
// `recordCache` OVERWRITES a fingerprint's entry when a board redesigns its
// form, so the fact that an earlier shape had (or lacked) a checkbox is lost.
//
// This is deliberately NOT a second copy of the cache. One append-only line
// per scan: a date, the ATS, the fingerprint, and one boolean — never a
// label, an option, a selector, or anything else `entry.fields` holds. Never
// read by `applyCache`/`recordCache`/`automatability.mjs`: it changes nothing
// about what gets filled or what counts as green. It exists to be counted,
// the same way this file's own header describes the live cache existing to
// skip a browser probe — a different job, a different file shape, on purpose.
//
// JSON Lines rather than a JSON array: an append is a single `fs.appendFileSync`
// with no read-modify-write of a growing structure, so two attended sessions
// finishing at nearly the same moment cannot clobber each other's line the
// way two writers racing on `saveCache`'s read-JSON/write-JSON could.
export function recordShapeHistory(file, { fp, ats, scan, now = new Date() }) {
  const hasCheckboxOrRadio = (scan.fields ?? []).some(
    (f) => f.t === "checkbox" || f.t === "radio",
  )
  const line = JSON.stringify({
    date: now.toISOString().slice(0, 10),
    ats,
    fp,
    hasCheckboxOrRadio,
  })
  fs.appendFileSync(file, line + "\n")
  return { hasCheckboxOrRadio }
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
//
// THE TYPE SUFFIX COMES FROM THE ITEM'S VERB, WITH A CROSS-TYPE FALLBACK
// (Phase 4, 2026-08-14). This used to be a hard-coded `|combo`, and the
// entry it looked for is written by `recordCache` under `fieldKey(f)` —
// `label|<scan type>`. Those two agree only while the scanner classifies the
// control the same way on every scan; the two widget types that carry an
// option list, `combo` and `select`, are exactly the pair it has read both
// ways (a library-drawn dropdown over a native <select>, seen before and
// after hydration). When they disagreed the lookup missed and the strategy
// was learned and thrown away, every run — a missed optimisation, never a
// wrong answer, which is why nobody saw it. Deriving the suffix from the
// verb and falling back to the sibling type finds the entry either way.
// Stored bytes are unchanged, so CACHE_VERSION does not move: a bump would
// discard every remembered form for a fix that changes only how a key is
// looked up.
const OPTION_TYPES = { combo: "select", select: "combo" }

// A strategy name is an identifier — `type-enter`, `click-option`. On the
// attended path the report reaches this function through the page
// (window.__ajLastFill, see fill-plan.mjs's driver), so a value here may be
// whatever a board chose to hand back. A name that is not identifier-shaped is
// not a strategy the engine has and is dropped rather than stored; a name that
// IS one can at most reorder which strategies are tried first (fill-engine
// skips names it does not know), never choose a value.
const VIA_NAME = /^[a-z][a-z0-9_-]{0,39}$/i
const viaName = (v) => (typeof v === "string" && VIA_NAME.test(v) ? v : null)

export function recordVia(cache, fp, plan, report) {
  const entry = cache.forms[fp]
  if (!entry) return 0
  const comboVia = report?.comboVia ?? {}
  let updated = 0
  for (const item of plan?.items ?? []) {
    if (!Object.hasOwn(OPTION_TYPES, item.how ?? "")) continue
    const via = viaName(comboVia[item.k])
    if (!via) continue
    const label = norm(item.matchedLabel ?? item.label)
    const field =
      entry.fields[`${label}|${item.how}`] ??
      entry.fields[`${label}|${OPTION_TYPES[item.how]}`]
    if (!field) continue
    field.via = via
    updated++
  }
  // The board-level summary: even a combo the fact base could not resolve
  // (so it never became a plan item, and therefore never got a per-field
  // `via`) benefits from trying the board's usual winner first.
  const strategy = viaName(report?.comboStrategy)
  if (strategy) entry.comboStrategy = strategy
  return updated
}
