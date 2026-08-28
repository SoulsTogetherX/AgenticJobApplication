// The cache exists to skip re-probing dropdowns in the browser. The risks are
// that it goes stale silently, or that it overwrites something freshly read —
// both would be worse than not caching at all.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  fingerprint,
  hostOf,
  loadCache,
  saveCache,
  updateCache,
  applyCache,
  recordCache,
  invalidate,
  recordVia,
  recordShapeHistory,
  promoteComboStrategy,
  knownOptsFromEntry,
  CACHE_VERSION,
} from "../../src/apply/field-cache.mjs"
import { lockPathFor } from "../../src/lib/lock.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

const scanOf = (fields) => ({
  url: "https://job-boards.greenhouse.io/x/jobs/1",
  fields,
})

test("the key follows the form's required shape, not its URL", () => {
  const a = scanOf([
    { k: "f1", t: "text", l: "First Name", req: true },
    { k: "f2", t: "combo", l: "Degree", req: true },
  ])
  // Same required labels in a different order, different URL, different options.
  const b = scanOf([
    { k: "fA", t: "combo", l: "  degree  ", req: true, opts: ["x"] },
    { k: "fB", t: "text", l: "First Name", req: true },
  ])
  b.url = "https://job-boards.greenhouse.io/y/jobs/99"
  assert.equal(fingerprint(a, "greenhouse"), fingerprint(b, "greenhouse"))
})

test("optional fields do not churn the key", () => {
  const base = [{ k: "f1", t: "text", l: "First Name", req: true }]
  const a = scanOf(base)
  const b = scanOf([...base, { k: "f2", t: "combo", l: "Veteran Status" }])
  assert.equal(fingerprint(a, "greenhouse"), fingerprint(b, "greenhouse"))
})

test("a redesigned form gets a different key, so it re-probes", () => {
  const a = scanOf([{ k: "f1", t: "text", l: "First Name", req: true }])
  const b = scanOf([
    { k: "f1", t: "text", l: "First Name", req: true },
    { k: "f2", t: "combo", l: "Work Authorization", req: true },
  ])
  assert.notEqual(fingerprint(a, "greenhouse"), fingerprint(b, "greenhouse"))
})

test("the same shape on a different ATS is a different key", () => {
  const s = scanOf([{ k: "f1", t: "text", l: "First Name", req: true }])
  assert.notEqual(fingerprint(s, "greenhouse"), fingerprint(s, "lever"))
})

// --- Phase 0.5: the host is part of the key --------------------------------
//
// The old basis was `atsId + "|" + labels`, cross-tenant by construction: any
// two employers whose REQUIRED labels agree (name, email, resume — the common
// case) shared one fingerprint, so employer B was served employer A's
// remembered option lists and selectors. That is wrong data, not a missed
// optimisation: a "How did you hear about us?" list is written per employer.
test("two different hosts with identical label sets are different keys", () => {
  const fields = [
    { k: "f1", t: "text", l: "First Name", req: true },
    { k: "f2", t: "text", l: "Email", req: true },
  ]
  const a = { url: "https://acme.wd5.myworkdayjobs.com/careers/job/1", fields }
  const b = {
    url: "https://globex.wd5.myworkdayjobs.com/careers/job/1",
    fields,
  }
  assert.notEqual(fingerprint(a, "workday"), fingerprint(b, "workday"))
})

test("the host is normalized: case and a leading www. do not fork the key", () => {
  const fields = [{ k: "f1", t: "text", l: "First Name", req: true }]
  const plain = { url: "https://jobs.lever.co/acme/1", fields }
  const shouty = { url: "https://JOBS.LEVER.CO/acme/1", fields }
  const dubdub = { url: "https://www.jobs.lever.co/acme/1", fields }
  assert.equal(fingerprint(plain, "lever"), fingerprint(shouty, "lever"))
  assert.equal(fingerprint(plain, "lever"), fingerprint(dubdub, "lever"))
})

test("a scan with no URL, or an unparseable one, keys on a sentinel instead of throwing", () => {
  // fingerprint() runs on the plan path before anything is filled, and a scan
  // fixture without a URL is a legitimate input. It must not throw, and it
  // must not silently share a key with a real board.
  const fields = [{ k: "f1", t: "text", l: "First Name", req: true }]
  const none = fingerprint({ fields }, "greenhouse")
  const empty = fingerprint({ url: "", fields }, "greenhouse")
  const junk = fingerprint({ url: "not a url", fields }, "greenhouse")
  const real = fingerprint(
    { url: "https://job-boards.greenhouse.io/acme/jobs/1", fields },
    "greenhouse",
  )
  assert.equal(none, empty)
  assert.equal(none, junk, "no URL and an unparseable URL are the same unknown")
  assert.notEqual(none, real, "and neither may collide with a real host")
})

test("hostOf strips the port and the path, keeps the subdomain", () => {
  assert.equal(
    hostOf("https://boards.greenhouse.io:8443/acme/jobs/1"),
    "boards.greenhouse.io",
  )
  assert.equal(
    hostOf("https://acme.wd5.myworkdayjobs.com/x"),
    "acme.wd5.myworkdayjobs.com",
  )
  assert.equal(hostOf(undefined), "?")
})

// THE RESIDUAL, PINNED DELIBERATELY. Phase 0.5 says "registrable host", and
// that is what shipped — but the host does NOT separate path-based tenancy,
// which is the majority board shape here. Two employers on Greenhouse (or
// Lever) with identical required labels STILL share a fingerprint after this
// change. This is asserted rather than left unstated so nobody reads
// "cross-tenant fixed" off the item title. Closing it means keying on the
// first path segment, which over-fragments embedded Greenhouse
// (`/embed/job_app?token=<per-posting>`) into a cache that never hits — the
// silent-amber failure the v2/v3 discard bug already cost this project once.
// If someone closes it, THIS TEST GOES RED, and that is the intended signal to
// come read this comment.
test("KNOWN RESIDUAL: same host, different tenant path still collides", () => {
  const fields = [
    { k: "f1", t: "text", l: "First Name", req: true },
    { k: "f2", t: "text", l: "Email", req: true },
  ]
  const empA = { url: "https://job-boards.greenhouse.io/emp-a/jobs/1", fields }
  const empB = { url: "https://job-boards.greenhouse.io/emp-b/jobs/2", fields }
  assert.equal(
    fingerprint(empA, "greenhouse"),
    fingerprint(empB, "greenhouse"),
    "not a passing property — a documented, priced-out gap (see the comment)",
  )
})

test("the v3 cache written before the host was in the basis is discarded", (t) => {
  // The bump is deliberate, not a ride on the accident that the on-disk file
  // was already stale: every v3 fingerprint was computed WITHOUT the host, so
  // re-serving one would hand a remembered shape to the wrong tenant.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "field-cache-v3-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const f = path.join(dir, "c.json")
  fs.writeFileSync(
    f,
    JSON.stringify({ v: 3, forms: { old: { ats: "greenhouse", fields: {} } } }),
  )
  const restore = console.error
  console.error = () => {}
  let loaded
  try {
    loaded = loadCache(f)
  } finally {
    console.error = restore
  }
  assert.equal(CACHE_VERSION, 4, "0.5 bumped it; a silent revert is a re-serve")
  assert.deepEqual(loaded.forms, {})
  assert.equal(loaded.discarded.fromVersion, 3)
})

test("cached options fill in a scan that skipped the probe", () => {
  const cache = { v: CACHE_VERSION, forms: {} }
  const probed = scanOf([
    {
      k: "f1",
      t: "combo",
      l: "Degree*",
      req: true,
      opts: ["Bachelor's Degree", "Master's Degree"],
      sel: "#deg",
    },
  ])
  const fp = fingerprint(probed, "greenhouse")
  recordCache(cache, { fp, scan: probed, atsId: "greenhouse", url: probed.url })

  const unprobed = scanOf([{ k: "fZ", t: "combo", l: "Degree*", req: true }])
  const stats = applyCache(unprobed, cache.forms[fp])
  assert.equal(stats.hits, 1)
  assert.deepEqual(unprobed.fields[0].opts, [
    "Bachelor's Degree",
    "Master's Degree",
  ])
  assert.equal(unprobed.fields[0].sel, "#deg", "the selector is remembered too")
})

test("a genuine miss is distinguishable from an empty form", () => {
  // A form the cache has never seen, with a combo that was not probed either
  // (e.g. scanned with `__ajScan(false)`): previously this incremented
  // neither `hits` nor `probed`, so it read exactly like a form with no
  // combos at all — both were "0/0". `miss` is what makes them different.
  const brandNewForm = scanOf([
    { k: "f1", t: "combo", l: "Work Authorization", req: true },
  ])
  const stats = applyCache(brandNewForm, undefined)
  assert.equal(stats.hits, 0)
  assert.equal(stats.probed, 0)
  assert.equal(
    stats.miss,
    1,
    "a real gap must not read the same as nothing to do",
  )

  const textOnlyForm = scanOf([
    { k: "f1", t: "text", l: "First Name", req: true },
  ])
  const nothingToDo = applyCache(textOnlyForm, undefined)
  assert.equal(nothingToDo.hits, 0)
  assert.equal(nothingToDo.probed, 0)
  assert.equal(
    nothingToDo.miss,
    0,
    "a form with nothing to probe is a real zero",
  )
})

test("a cache entry that never recorded options for a field is still a miss", () => {
  // The cache KNOWS about this field (label/type/req were recorded) but never
  // captured its options — e.g. a first pass ran with the probe skipped.
  // Knowing the field exists is not the same as knowing what it offers.
  const cache = { v: CACHE_VERSION, forms: {} }
  const scan = scanOf([{ k: "f1", t: "select", l: "Country", req: true }])
  const fp = fingerprint(scan, "greenhouse")
  recordCache(cache, { fp, scan, atsId: "greenhouse" })

  const stats = applyCache(
    scanOf([{ k: "f9", t: "select", l: "Country", req: true }]),
    cache.forms[fp],
  )
  assert.equal(stats.hits, 0)
  assert.equal(stats.miss, 1)
})

test("optsTruncated survives a cache round trip", () => {
  // scan-page.js does not emit this signal yet (MAX_OPTS truncates silently),
  // but field-cache.mjs's OWN cap must never re-serve a cut list as though it
  // were complete — and once the scanner does start flagging a cut, this is
  // the path that carries it through untouched.
  const cache = { v: CACHE_VERSION, forms: {} }
  const scan = scanOf([
    {
      k: "f1",
      t: "combo",
      l: "Country",
      req: true,
      opts: ["United States", "Canada"],
      optsTruncated: true,
    },
  ])
  const fp = fingerprint(scan, "greenhouse")
  recordCache(cache, { fp, scan, atsId: "greenhouse" })
  assert.equal(cache.forms[fp].fields["country|combo"].optsTruncated, true)

  const unprobed = scanOf([{ k: "f9", t: "combo", l: "Country", req: true }])
  applyCache(unprobed, cache.forms[fp])
  assert.equal(
    unprobed.fields[0].optsTruncated,
    true,
    "a re-served cached list must still say it might be incomplete",
  )
})

test("field-cache's own cap flags truncation even without an incoming signal", () => {
  const cache = { v: CACHE_VERSION, forms: {} }
  // 310 exceeds MAX_CACHED_OPTS=300 (raised with the scanner cap 2026-08-21
  // so a full country list stays servable instead of buying a re-probe).
  const longList = Array.from({ length: 310 }, (_, i) => `Country ${i}`)
  const scan = scanOf([
    { k: "f1", t: "combo", l: "Country", req: true, opts: longList },
  ])
  const fp = fingerprint(scan, "greenhouse")
  recordCache(cache, { fp, scan, atsId: "greenhouse" })
  const stored = cache.forms[fp].fields["country|combo"]
  assert.equal(stored.opts.length, 300, "still capped, for file size")
  assert.equal(stored.optsTruncated, true)
})

test("recordVia persists which combo strategy worked, keyed off the plan", () => {
  const cache = { v: CACHE_VERSION, forms: {} }
  const scan = scanOf([
    { k: "f1", t: "combo", l: "School", req: true, opts: ["UNLV"] },
  ])
  const fp = fingerprint(scan, "greenhouse")
  recordCache(cache, { fp, scan, atsId: "greenhouse" })

  const plan = {
    items: [{ k: "f1", how: "combo", label: "School", value: "UNLV" }],
  }
  // Exactly the shape fill-engine.mjs's fillPage() returns: comboVia is
  // { [item.k]: via }, comboStrategy is the board-wide winner.
  const report = { comboVia: { f1: "type-click" }, comboStrategy: "type-click" }
  const updated = recordVia(cache, fp, plan, report)
  assert.equal(updated, 1)
  assert.equal(cache.forms[fp].fields["school|combo"].via, "type-click")
  assert.equal(
    cache.forms[fp].comboStrategy,
    "type-click",
    "the board-level summary is also remembered",
  )

  // And it round-trips back out through applyCache, onto a later unprobed scan.
  const later = scanOf([{ k: "f9", t: "combo", l: "School", req: true }])
  applyCache(later, cache.forms[fp])
  assert.equal(later.fields[0].via, "type-click")
})

test("recordVia is a no-op for a fingerprint the cache has never seen", () => {
  const cache = { v: CACHE_VERSION, forms: {} }
  const updated = recordVia(
    cache,
    "nope",
    { items: [] },
    {
      comboVia: { f1: "type-click" },
    },
  )
  assert.equal(updated, 0)
})

test("recordVia uses item.matchedLabel when the plan showed the user a different string", () => {
  // fill-plan.mjs's buildPlan() shows the user the PAGE's visible label
  // (`lSeen`) when it disagrees with the label the scan actually matched on
  // (fieldKey() below, and the cache's own key, are always the MATCHED
  // string — buildPlan never repoints that). Without preferring
  // matchedLabel here, a combo field with a display divergence would look
  // up the cache by the wrong key and silently stop being found — not a
  // wrong VALUE, just a missed optimisation (the combo strategy hint is
  // never remembered for that one field).
  const cache = { v: CACHE_VERSION, forms: {} }
  const scan = scanOf([
    { k: "f1", t: "combo", l: "School (internal)", req: true, opts: ["UNLV"] },
  ])
  const fp = fingerprint(scan, "greenhouse")
  recordCache(cache, { fp, scan, atsId: "greenhouse" })

  const plan = {
    items: [
      {
        k: "f1",
        how: "combo",
        label: "School",
        matchedLabel: "School (internal)",
        value: "UNLV",
      },
    ],
  }
  const report = { comboVia: { f1: "type-click" }, comboStrategy: "type-click" }
  const updated = recordVia(cache, fp, plan, report)
  assert.equal(updated, 1, "must find the field by the MATCHED label")
  assert.equal(
    cache.forms[fp].fields["school (internal)|combo"].via,
    "type-click",
  )
})

// --- Phase 4 (2026-08-14): the recordVia key, the shared promotion helper,
// and the locked read-modify-write the unattended path writes through -----

test("recordVia finds the entry when the scanner typed the control as `select` but the plan filled it as a combo", () => {
  // The scanner has read the same library-drawn dropdown both ways across
  // scans (native <select> before hydration, combo after). recordCache keyed
  // the entry `label|select`; the plan item is `how: "combo"`. The old
  // hard-coded `|combo` lookup missed here and the strategy was learned and
  // dropped on every run — never a wrong answer, which is why nobody saw it.
  const cache = { v: CACHE_VERSION, forms: {} }
  const scan = scanOf([
    { k: "f1", t: "select", l: "Country", req: true, opts: ["US", "CA"] },
  ])
  const fp = fingerprint(scan, "greenhouse")
  recordCache(cache, { fp, scan, atsId: "greenhouse" })
  assert.ok(
    cache.forms[fp].fields["country|select"],
    "keyed as the scan typed it",
  )

  const plan = {
    items: [{ k: "f1", how: "combo", label: "Country", value: "US" }],
  }
  const report = { comboVia: { f1: "type-enter" }, comboStrategy: "type-enter" }
  assert.equal(recordVia(cache, fp, plan, report), 1, "cross-type fallback hit")
  assert.equal(cache.forms[fp].fields["country|select"].via, "type-enter")
})

test("recordVia's cross-type fallback works in the other direction too, and prefers the exact type when both exist", () => {
  const cache = { v: CACHE_VERSION, forms: {} }
  const scan = scanOf([
    { k: "f1", t: "combo", l: "Country", req: true, opts: ["US"] },
    { k: "f2", t: "select", l: "Country", req: true, opts: ["US"] },
  ])
  const fp = fingerprint(scan, "greenhouse")
  recordCache(cache, { fp, scan, atsId: "greenhouse" })
  // A select-verb item with a via (the engine never emits one today, but the
  // key derivation must not depend on that): exact `|select` key wins.
  recordVia(
    cache,
    fp,
    { items: [{ k: "f2", how: "select", label: "Country" }] },
    { comboVia: { f2: "native" } },
  )
  assert.equal(cache.forms[fp].fields["country|select"].via, "native")
  assert.equal(
    cache.forms[fp].fields["country|combo"].via,
    undefined,
    "the exact-type entry was found, so the sibling was not touched",
  )
})

test("recordVia's plain-combo behaviour is unchanged, and non-option verbs are still skipped", () => {
  const cache = { v: CACHE_VERSION, forms: {} }
  const scan = scanOf([
    { k: "f1", t: "combo", l: "School", req: true, opts: ["UNLV"] },
    { k: "f2", t: "text", l: "School", req: true },
  ])
  const fp = fingerprint(scan, "greenhouse")
  recordCache(cache, { fp, scan, atsId: "greenhouse" })
  const updated = recordVia(
    cache,
    fp,
    {
      items: [
        { k: "f1", how: "combo", label: "School", value: "UNLV" },
        // A `fill` item can never carry a via; even if a report claimed one it
        // must not be written onto the text input's entry.
        { k: "f2", how: "fill", label: "School", value: "UNLV" },
      ],
    },
    { comboVia: { f1: "type-click", f2: "type-click" } },
  )
  assert.equal(updated, 1)
  assert.equal(cache.forms[fp].fields["school|combo"].via, "type-click")
  assert.equal(cache.forms[fp].fields["school|text"].via, undefined)
})

test("a re-probed combo still receives the remembered via and sel — a probe is not fresher about those", () => {
  // The old `continue` past a field that already had options also skipped the
  // via/sel merge, so on the unattended path — which re-probes every combo
  // until the scanner is handed the cache's options — the strategy learned on
  // the last application was never served. Options: fresh probe wins,
  // unchanged. Hint and selector: from the cache, because no probe produces
  // them.
  const cache = { v: CACHE_VERSION, forms: {} }
  const first = scanOf([
    { k: "f1", t: "combo", l: "School", req: true, opts: ["UNLV"], sel: "#s" },
  ])
  const fp = fingerprint(first, "greenhouse")
  recordCache(cache, { fp, scan: first, atsId: "greenhouse" })
  recordVia(
    cache,
    fp,
    { items: [{ k: "f1", how: "combo", label: "School" }] },
    { comboVia: { f1: "type-click" }, comboStrategy: "type-click" },
  )

  // The next scan probed the same combo again (fresh, and different, options).
  const again = scanOf([
    { k: "f9", t: "combo", l: "School", req: true, opts: ["UNLV", "UNR"] },
  ])
  const stats = applyCache(again, cache.forms[fp])
  assert.deepEqual(stats, { hits: 0, probed: 1, miss: 0 })
  assert.deepEqual(again.fields[0].opts, ["UNLV", "UNR"], "fresh options win")
  assert.equal(again.fields[0].via, "type-click", "the hint is still served")
  assert.equal(again.fields[0].sel, "#s", "and so is the remembered selector")
})

test("options the scanner took from the cache count as hits, not probes", () => {
  // scan-engine.mjs marks a combo it filled from knownOpts with
  // `opts_from: "cache"`. The browser did no work for those, so applyCache
  // must not report the scan as cold.
  const cache = { v: CACHE_VERSION, forms: {} }
  const scan = scanOf([
    { k: "f1", t: "combo", l: "School", req: true, opts: ["UNLV"] },
  ])
  const fp = fingerprint(scan, "greenhouse")
  recordCache(cache, { fp, scan, atsId: "greenhouse" })
  const warm = scanOf([
    {
      k: "f1",
      t: "combo",
      l: "School",
      req: true,
      opts: ["UNLV"],
      opts_from: "cache",
    },
    { k: "f2", t: "combo", l: "Degree", req: true, opts: ["BS"] },
  ])
  assert.deepEqual(applyCache(warm, cache.forms[fp]), {
    hits: 1,
    probed: 1,
    miss: 0,
  })
})

test("recordVia stores only identifier-shaped strategy names — a page-shaped value is dropped, not remembered", () => {
  // On the attended path the report reaches recordVia through the page
  // (window.__ajLastFill), so a board can hand back anything. A strategy is
  // an identifier; a paragraph, a script, or a 10MB string is not one and must
  // not land in the cache file.
  const cache = { v: CACHE_VERSION, forms: {} }
  const scan = scanOf([
    { k: "f1", t: "combo", l: "School", req: true, opts: ["UNLV"] },
    { k: "f2", t: "combo", l: "Degree", req: true, opts: ["BS"] },
  ])
  const fp = fingerprint(scan, "greenhouse")
  recordCache(cache, { fp, scan, atsId: "greenhouse" })
  const updated = recordVia(
    cache,
    fp,
    {
      items: [
        { k: "f1", how: "combo", label: "School" },
        { k: "f2", how: "combo", label: "Degree" },
      ],
    },
    {
      comboVia: {
        f1: "type-click",
        f2: "<img src=x onerror=alert(1)> ".repeat(3),
      },
      comboStrategy: "x".repeat(500),
    },
  )
  assert.equal(updated, 1, "only the real name was recorded")
  assert.equal(cache.forms[fp].fields["school|combo"].via, "type-click")
  assert.equal(cache.forms[fp].fields["degree|combo"].via, undefined)
  assert.equal(
    cache.forms[fp].comboStrategy,
    undefined,
    "an over-long board-level name is not stored either",
  )
})

// --- Phase 5 (2026-08-14): what the cache may tell the scanner before a probe

test("knownOptsFromEntry serves complete option lists by label, and nothing else", () => {
  const entry = {
    ats: "greenhouse",
    fields: {
      "country|combo": { t: "combo", l: "Country", opts: ["US", "CA"] },
      "degree|select": { t: "select", l: "Degree", opts: ["BS", "MS"] },
      // A text input remembers a selector, never options — not served.
      "first name|text": { t: "text", l: "First Name", sel: "#fn" },
      // A combo the cache knows the shape of but never got options for.
      "school|combo": { t: "combo", l: "School" },
    },
  }
  const out = knownOptsFromEntry(entry)
  assert.deepEqual(out, {
    knownOpts: { country: ["US", "CA"], degree: ["BS", "MS"] },
    skipProbe: [],
  })
  // Copies, not the cache's own arrays: the scanner writes f.opts = cached
  // straight onto the scan, and a later mutation must not reach the file.
  out.knownOpts.country.push("MX")
  assert.deepEqual(entry.fields["country|combo"].opts, ["US", "CA"])
})

test("knownOptsFromEntry never serves a truncated list — a probe restores the true one", () => {
  const entry = {
    fields: {
      "country|combo": {
        t: "combo",
        l: "Country",
        opts: ["US", "CA"],
        optsTruncated: true,
      },
      "state|combo": {
        t: "combo",
        l: "State",
        opts: ["NV", "CA"],
        // The scanner recorded the real total: 40 of 52 were kept.
        optsTotal: 52,
      },
      "degree|combo": { t: "combo", l: "Degree", opts: ["BS"], optsTotal: 1 },
    },
  }
  assert.deepEqual(knownOptsFromEntry(entry).knownOpts, { degree: ["BS"] })
})

test("knownOptsFromEntry drops a label two option-bearing fields share with different lists", () => {
  // The scanner keys knownOpts by label alone; two fields under one label
  // with different menus could each be handed the other's. Ambiguity probes.
  const entry = {
    fields: {
      "phone|combo": { t: "combo", l: "Phone", opts: ["+1", "+44"] },
      "phone|select": { t: "select", l: "Phone", opts: ["Mobile", "Home"] },
      // Same label, SAME list on both types: not ambiguous, served once.
      "country|combo": { t: "combo", l: "Country", opts: ["US"] },
      "country|select": { t: "select", l: "Country", opts: ["US"] },
    },
  }
  assert.deepEqual(knownOptsFromEntry(entry).knownOpts, { country: ["US"] })
})

test("knownOptsFromEntry on nothing is an empty answer, never a throw", () => {
  assert.deepEqual(knownOptsFromEntry(undefined), {
    knownOpts: {},
    skipProbe: [],
  })
  assert.deepEqual(knownOptsFromEntry({}), { knownOpts: {}, skipProbe: [] })
  assert.deepEqual(knownOptsFromEntry({ fields: { "x|combo": null } }), {
    knownOpts: {},
    skipProbe: [],
  })
})

test("promoteComboStrategy moves the remembered winner to the head and never invents one", () => {
  const plan = { comboStrategies: ["type-enter", "type-click", "click-option"] }
  assert.equal(
    promoteComboStrategy(plan, { comboStrategy: "click-option" }),
    true,
  )
  assert.deepEqual(plan.comboStrategies, [
    "click-option",
    "type-enter",
    "type-click",
  ])
  // Already at the head: no change reported, order intact.
  assert.equal(
    promoteComboStrategy(plan, { comboStrategy: "click-option" }),
    false,
  )
  // A strategy the adapter no longer offers is NOT resurrected from the cache.
  assert.equal(promoteComboStrategy(plan, { comboStrategy: "retired" }), false)
  assert.deepEqual(plan.comboStrategies, [
    "click-option",
    "type-enter",
    "type-click",
  ])
  // Nothing remembered, or nothing to reorder: safe no-ops.
  assert.equal(promoteComboStrategy(plan, undefined), false)
  assert.equal(promoteComboStrategy({}, { comboStrategy: "type-enter" }), false)
})

test("a via/comboStrategy written under v4 loads without a discard — the key fix moves no bytes", (t) => {
  // The fix is in how recordVia LOOKS UP an entry, not in what is stored, so
  // CACHE_VERSION must not have moved: a cache written before the fix must
  // load whole. A bump here would discard every remembered form (the silent-
  // amber cost loadCache's own header documents) for nothing.
  assert.equal(CACHE_VERSION, 4, "no bump — the on-disk shape is unchanged")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aj-fc-v4-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, ".field-cache.json")
  const preFix = {
    v: 4,
    forms: {
      abc: {
        ats: "greenhouse",
        comboStrategy: "type-click",
        fields: {
          "school|combo": {
            t: "combo",
            l: "School",
            opts: ["UNLV"],
            via: "type-click",
          },
        },
      },
    },
  }
  fs.writeFileSync(file, JSON.stringify(preFix))
  const loaded = loadCache(file)
  assert.equal(loaded.discarded, undefined, "no discard")
  assert.equal(loaded.forms.abc.comboStrategy, "type-click")
  assert.equal(loaded.forms.abc.fields["school|combo"].via, "type-click")
  // And it round-trips through save (atomic now) and load byte-for-byte in
  // meaning: same forms, same version.
  saveCache(file, loaded)
  assert.deepEqual(loadCache(file), loaded)
  assert.ok(
    !fs.readdirSync(dir).some((f) => f.endsWith(".tmp")),
    "the temp file used for the atomic write is gone",
  )
})

test("updateCache is a locked read-modify-write: two writers both land, and the lock is released", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aj-fc-lock-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, ".field-cache.json")
  const scanA = scanOf([{ k: "a", t: "combo", l: "A", req: true, opts: ["1"] }])
  const scanB = scanOf([{ k: "b", t: "combo", l: "B", req: true, opts: ["2"] }])
  const fpA = fingerprint(scanA, "greenhouse")
  const fpB = fingerprint(scanB, "greenhouse")

  // The lost-update shape: both callers hold a stale in-memory copy. Through
  // updateCache each re-reads under the lock, so both entries survive.
  const staleA = loadCache(file)
  const staleB = loadCache(file)
  recordCache(staleA, { fp: fpA, scan: scanA, atsId: "greenhouse" })
  recordCache(staleB, { fp: fpB, scan: scanB, atsId: "greenhouse" })
  updateCache(file, (c) =>
    recordCache(c, { fp: fpA, scan: scanA, atsId: "greenhouse" }),
  )
  updateCache(file, (c) =>
    recordCache(c, { fp: fpB, scan: scanB, atsId: "greenhouse" }),
  )
  const final = loadCache(file)
  assert.ok(
    final.forms[fpA] && final.forms[fpB],
    "both writers' entries present",
  )

  // The mutator's return value comes back out (recordVia's count rides it).
  assert.equal(
    updateCache(file, () => 42),
    42,
  )
  // Released: the lock file does not linger after the hold.
  assert.equal(fs.existsSync(lockPathFor(file)), false, "lock released")
})

test("updateCache refuses an async mutator — a yield inside the hold would stall sibling workers", (t) => {
  // withLock throws on a promise-returning body, and updateCache leans on
  // that refusal: acquire() waits with a BLOCKING sleep, so a second worker
  // in the same process reaching the lock while the first was parked on an
  // await inside the hold would freeze the event loop — first worker
  // included — until the lock timed out. Synchronous bodies cannot yield.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aj-fc-async-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, ".field-cache.json")
  assert.throws(
    () => updateCache(file, async () => {}),
    /promise|async|synchronous/i,
  )
  assert.equal(fs.existsSync(lockPathFor(file)), false, "released even so")
})

test("a fresh probe always beats a remembered one", () => {
  const cache = { v: CACHE_VERSION, forms: {} }
  const old = scanOf([
    { k: "f1", t: "combo", l: "Degree", req: true, opts: ["stale"] },
  ])
  const fp = fingerprint(old, "greenhouse")
  recordCache(cache, { fp, scan: old, atsId: "greenhouse" })

  const fresh = scanOf([
    { k: "f1", t: "combo", l: "Degree", req: true, opts: ["current"] },
  ])
  const stats = applyCache(fresh, cache.forms[fp])
  assert.deepEqual(
    fresh.fields[0].opts,
    ["current"],
    "live data must never be overwritten",
  )
  assert.equal(stats.hits, 0)
  assert.equal(stats.probed, 1)
})

test("recording twice keeps what the later scan did not see", () => {
  const cache = { v: CACHE_VERSION, forms: {} }
  const full = scanOf([
    { k: "f1", t: "combo", l: "Degree", req: true, opts: ["A", "B"] },
  ])
  const fp = fingerprint(full, "greenhouse")
  recordCache(cache, { fp, scan: full, atsId: "greenhouse" })
  // A later run without a probe must not erase what we already knew.
  recordCache(cache, {
    fp,
    scan: scanOf([{ k: "f1", t: "combo", l: "Degree", req: true }]),
    atsId: "greenhouse",
  })
  assert.deepEqual(cache.forms[fp].fields["degree|combo"].opts, ["A", "B"])
})

test("a composite widget's options do not leak onto its text input", () => {
  // Greenhouse's phone field is a country picker plus a tel input, both
  // labelled "Phone". Handing the country list to the tel input made the phone
  // number resolve to NEEDS-CHOICE and bounced it to the user for no reason.
  const cache = { v: CACHE_VERSION, forms: {} }
  const probed = scanOf([
    {
      k: "f1",
      t: "combo",
      l: "Phone",
      opts: ["United States +1", "Canada +1"],
    },
    { k: "f2", t: "tel", l: "Phone", req: true },
  ])
  const fp = fingerprint(probed, "greenhouse")
  recordCache(cache, { fp, scan: probed, atsId: "greenhouse" })

  const unprobed = scanOf([
    { k: "f1", t: "combo", l: "Phone" },
    { k: "f2", t: "tel", l: "Phone", req: true },
  ])
  applyCache(unprobed, cache.forms[fp])
  assert.deepEqual(unprobed.fields[0].opts, ["United States +1", "Canada +1"])
  assert.equal(
    unprobed.fields[1].opts,
    undefined,
    "the tel input has no options",
  )
})

// 0.12 support: an append-only sidecar, never read by applyCache/recordCache,
// carrying only a date, the ATS, the fingerprint and one boolean per scan —
// specifically NOT a second copy of entry.fields (no labels, no options, no
// selectors).
test("recordShapeHistory appends one line per call, carrying only date/ats/fp/boolean", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shape-history-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, ".shape-history.jsonl")

  const withCheckbox = scanOf([
    { k: "f1", t: "text", l: "First Name", req: true },
    { k: "f2", t: "checkbox", l: "Current role" },
  ])
  const clean = scanOf([{ k: "f1", t: "text", l: "First Name", req: true }])

  const r1 = recordShapeHistory(file, {
    fp: "abc123",
    ats: "greenhouse",
    scan: withCheckbox,
    now: new Date("2026-08-01T00:00:00Z"),
  })
  assert.equal(r1.hasCheckboxOrRadio, true)

  const r2 = recordShapeHistory(file, {
    fp: "def456",
    ats: "generic",
    scan: clean,
    now: new Date("2026-08-01T00:00:00Z"),
  })
  assert.equal(r2.hasCheckboxOrRadio, false)

  const lines = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  assert.equal(lines.length, 2, "one appended line per call")
  assert.deepEqual(lines[0], {
    date: "2026-08-01",
    ats: "greenhouse",
    fp: "abc123",
    hasCheckboxOrRadio: true,
  })
  assert.deepEqual(lines[1], {
    date: "2026-08-01",
    ats: "generic",
    fp: "def456",
    hasCheckboxOrRadio: false,
  })
  // Carries none of the live cache's field-level content.
  for (const l of lines) {
    assert.equal(Object.keys(l).length, 4)
    assert.equal("fields" in l, false)
  }
})

test("recordShapeHistory detects a radio group the same as a checkbox", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shape-history-radio-"))
  const file = path.join(dir, ".shape-history.jsonl")
  const r = recordShapeHistory(file, {
    fp: "xyz",
    ats: "workday",
    scan: scanOf([{ k: "f1", t: "radio", l: "Work authorization" }]),
    now: new Date("2026-08-01T00:00:00Z"),
  })
  assert.equal(r.hasCheckboxOrRadio, true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("invalidate drops the entry", () => {
  const cache = {
    v: CACHE_VERSION,
    forms: { abc: { ats: "greenhouse", fields: {} } },
  }
  assert.equal(invalidate(cache, "abc"), true)
  assert.equal(cache.forms.abc, undefined)
  assert.equal(
    invalidate(cache, "abc"),
    false,
    "evicting twice is not an error",
  )
})

test("a corrupt or outdated cache file starts clean instead of throwing", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "field-cache-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const f = path.join(dir, "c.json")
  fs.writeFileSync(f, "{ not json")
  assert.deepEqual(loadCache(f).forms, {})

  saveCache(f, { v: CACHE_VERSION + 99, forms: { old: { fields: {} } } })
  assert.deepEqual(
    loadCache(f).forms,
    {},
    "a version bump discards rather than guesses",
  )

  assert.deepEqual(loadCache(path.join(dir, "missing.json")).forms, {})
})

// FIX (w3-resolution, 2026-08-01): the discard above used to be silent — this
// is the live incident it hid. jobs/.field-cache.json sat at v2 with 7 real
// fingerprints on disk while CACHE_VERSION moved to 3; loadCache() threw all
// 7 away on every load with nothing printed anywhere, so green tier went
// unreachable for every lead and nobody could see why. A missing cache file
// (never had data) must stay silent; a cache that DID have data and got
// discarded must not.
test("a version-mismatch discard is audible: logged, and carried on the return value", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "field-cache-audible-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const f = path.join(dir, "c.json")

  // Mirrors the live shape: 7 remembered forms at v2, code now expects v3.
  const forms = {}
  for (let i = 0; i < 7; i++)
    forms[`fp${i}`] = { ats: "greenhouse", fields: {} }
  fs.writeFileSync(f, JSON.stringify({ v: 2, forms }))

  const calls = []
  const restore = console.error
  console.error = (...args) => calls.push(args.join(" "))
  let result
  try {
    result = loadCache(f)
  } finally {
    console.error = restore
  }

  assert.deepEqual(result.forms, {}, "the discard itself is unchanged")
  assert.deepEqual(result.discarded, {
    fromVersion: 2,
    toVersion: CACHE_VERSION,
    forms: 7,
  })
  assert.equal(calls.length, 1, "exactly one warning line, not silence")
  assert.match(calls[0], /discarding 7 remembered form/)
  assert.match(calls[0], /v2/)
  assert.match(calls[0], new RegExp(`v${CACHE_VERSION}`))
})

test("a missing cache file is not a discard — no warning, nothing to lose", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "field-cache-missing-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const calls = []
  const restore = console.error
  console.error = (...args) => calls.push(args.join(" "))
  let result
  try {
    result = loadCache(path.join(dir, "missing.json"))
  } finally {
    console.error = restore
  }
  assert.deepEqual(result, { v: CACHE_VERSION, forms: {} })
  assert.equal(result.discarded, undefined)
  assert.equal(calls.length, 0)
})

test("an unparseable cache file is also an audible discard", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "field-cache-corrupt-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const f = path.join(dir, "c.json")
  fs.writeFileSync(f, "{ not json")
  const calls = []
  const restore = console.error
  console.error = (...args) => calls.push(args.join(" "))
  let result
  try {
    result = loadCache(f)
  } finally {
    console.error = restore
  }
  assert.deepEqual(result.forms, {})
  assert.equal(calls.length, 1)
  assert.match(calls[0], /could not read/)
})

test("end to end: a second run reuses the shape the first one learned", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fill-plan-cache-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const slug = "acme-swe"
  const jobDir = path.join(dir, slug)
  fs.mkdirSync(jobDir, { recursive: true })

  const probed = scanOf([
    { k: "f1", t: "text", l: "First Name", req: true },
    {
      k: "f2",
      t: "combo",
      l: "Degree*",
      req: true,
      opts: ["Bachelor's Degree"],
    },
  ])
  fs.writeFileSync(path.join(jobDir, "probed.json"), JSON.stringify(probed))

  // Same form, scanned without opening any dropdown.
  const unprobed = scanOf([
    { k: "f1", t: "text", l: "First Name", req: true },
    { k: "f2", t: "combo", l: "Degree*", req: true },
  ])
  fs.writeFileSync(path.join(jobDir, "unprobed.json"), JSON.stringify(unprobed))

  const run = (scanFile) =>
    spawnSync(
      process.execPath,
      [
        path.join(ROOT, "src", "apply", "fill-plan.mjs"),
        slug,
        "--jobs-dir",
        dir,
        "--scan",
        path.join(jobDir, scanFile),
        "--profile",
        path.join(ROOT, "tests", "fixtures", "profile.yaml"),
        "--answers",
        path.join(ROOT, "tests", "fixtures", "answers-bank.yaml"),
      ],
      { cwd: ROOT, encoding: "utf8" },
    )

  const cold = run("probed.json")
  assert.equal(cold.status, 0, cold.stderr)
  assert.match(
    cold.stdout,
    /cache=0\/1/,
    "nothing known yet; one field was probed live",
  )

  const warm = run("unprobed.json")
  assert.equal(warm.status, 0, warm.stderr)
  assert.match(
    warm.stdout,
    /cache=1\/1/,
    "the dropdown did not need re-probing",
  )
  assert.ok(fs.existsSync(path.join(dir, ".field-cache.json")))

  // The 0.12 sidecar is written on every scan-backed run, one line each —
  // both runs share a fingerprint (same required shape), so this also proves
  // the sidecar is APPEND-only rather than keyed/overwritten like the live
  // cache is.
  const historyFile = path.join(dir, ".shape-history.jsonl")
  assert.ok(fs.existsSync(historyFile))
  const lines = fs
    .readFileSync(historyFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  assert.equal(lines.length, 2, "one line per run, not deduped or overwritten")
  for (const l of lines) {
    assert.equal(
      l.hasCheckboxOrRadio,
      false,
      "neither scan has a checkbox/radio field",
    )
    assert.equal(l.ats, "greenhouse")
  }
})

// --- lFull rides the cache as display-only shape ---------------------------

test("lFull round-trips through recordCache -> saveCache -> loadCache", (t) => {
  const long =
    "This role is about the infrastructure ML models run on - distributed systems, GPU serving, and developer tooling - working closely with research teams."
  const cut = long.slice(0, 120)
  const scan = scanOf([
    { k: "f1", sel: "#q", t: "textarea", l: cut, lFull: long, req: true },
  ])
  const fp = fingerprint(scan, "greenhouse")
  const cache = { v: CACHE_VERSION, forms: {} }
  recordCache(cache, { fp, scan, atsId: "greenhouse", url: scan.url })

  const entry = cache.forms[fp]
  const stored = Object.values(entry.fields)[0]
  assert.equal(stored.l, cut, "the matching key stays the 120-cut label")
  assert.equal(stored.lFull, long, "the display companion is carried")

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aj-lfull-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, "cache.json")
  saveCache(file, cache)
  const loaded = loadCache(file)
  assert.equal(Object.values(loaded.forms[fp].fields)[0].lFull, long)
})

test("a v4 entry without lFull loads unchanged — no version bump, no discard", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aj-lfull-old-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, "cache.json")
  fs.writeFileSync(
    file,
    JSON.stringify({
      v: CACHE_VERSION,
      forms: {
        abc: {
          ats: "greenhouse",
          fields: { "degree*|combo": { t: "combo", l: "Degree*", req: true } },
        },
      },
    }),
  )
  const loaded = loadCache(file)
  assert.ok(loaded.forms.abc, "an old-shape entry must survive the load")
  assert.equal(loaded.forms.abc.fields["degree*|combo"].lFull, undefined)
})

test("a short label never grows an lFull in the cache", () => {
  const scan = scanOf([
    { k: "f1", sel: "#n", t: "text", l: "Full name", req: true },
  ])
  const fp = fingerprint(scan, "greenhouse")
  const cache = { v: CACHE_VERSION, forms: {} }
  recordCache(cache, { fp, scan, atsId: "greenhouse", url: scan.url })
  const stored = Object.values(cache.forms[fp].fields)[0]
  assert.equal("lFull" in stored, false)
})
