// Remembers the SHAPE of a form we have already filled: which widget each
// field is, and what options it offers.
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

export const CACHE_VERSION = 2

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
// Reports hits against every field that needs an option list, not just the
// ones the cache happened to know — otherwise a total miss and an empty form
// both read as "0/0" and there is no way to tell them apart.
export function applyCache(scan, entry) {
  let hits = 0
  let probed = 0
  for (const f of scan.fields ?? []) {
    const wantsOptions = f.t === "combo" || f.t === "select"
    if (Array.isArray(f.opts) && f.opts.length) {
      if (wantsOptions) probed++
      continue
    }
    const known = entry?.fields?.[fieldKey(f)]
    if (!known) continue
    if (Array.isArray(known.opts) && known.opts.length) {
      f.opts = known.opts.slice()
      if (wantsOptions) hits++
    }
    if (!f.sel && known.sel) f.sel = known.sel
  }
  return { hits, probed }
}

// Remember whatever this scan did learn, merging over any earlier entry.
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
    const opts = Array.isArray(f.opts) && f.opts.length ? f.opts : prev.opts
    if (opts) next.opts = opts.slice(0, 60)
    const sel = f.sel ?? prev.sel
    if (sel) next.sel = sel
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
