// The structural edge-case corpus.
//
// These break the engine on SHAPE, not on malice — that split is why this file
// and tests/security/hostile-forms.test.mjs are separate. Nothing here is an
// attack; every case is a form somebody built badly, or built for humans, and
// they are far more common than hostile boards.
//
// Each case is one of two kinds, and the difference is stated in the test name:
//
//   HANDLED — the product code already copes, and the test pins that so a
//             later change cannot quietly undo it.
//   BREAKS  — the product code does the wrong thing today. The assertion
//             describes the WRONG behaviour, so the test is green now and goes
//             red the moment it is fixed, at which point the assertion flips
//             and the finding closes. That is deliberate: a test that fails on
//             HEAD blocks everyone else's wave, and this file's job is to make
//             the gap findable and falsifiable, not to hold the build hostage.
//             Every BREAKS case names its owner.
//
// NO BROWSER RUNS HERE. The project has no Playwright (see
// scripts/apply/browser.mjs), so cases that need a live DOM — react-select
// opening, shadow roots, a real remount — are exercised either against the
// engine with an instrumented page, or as a STRUCTURAL assertion about the
// source (the absence of frameLocator is a fact about the code, not a guess
// about the browser). Where neither works, the case is named in
// tests/apply/edge-cases.test.mjs's final test as an open gap rather than
// silently dropped.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import fillPage from "../../scripts/apply/fill-engine.mjs"
import scanPage from "../../scripts/apply/scan-engine.mjs"
import { matchOption } from "../../scripts/apply/answer-bank.mjs"
import { recordCache, fingerprint } from "../../scripts/apply/field-cache.mjs"
import {
  resolveFields,
  resolveScanPath,
} from "../../scripts/apply/fill-plan.mjs"
import { instrumentedPage, unwrapScan } from "../../scripts/dev/bench-apply.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const BOARDS = path.join(ROOT, "tests", "fixtures", "boards")
const SCANS = path.join(BOARDS, "scans")
const readScan = (n) => JSON.parse(fs.readFileSync(path.join(SCANS, n), "utf8"))
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")

// ---------------------------------------------------------------------------
// E1 — a 200-option dropdown
// ---------------------------------------------------------------------------

test("E1 BREAKS [w2-engine]: the 200 -> 40 cut is silent, in both scanners", () => {
  // The cut itself happens INSIDE a page.evaluate arrow, so it needs a DOM to
  // observe and the assertion here is structural: both scanners hard-slice,
  // and neither records that it did. Method — read the two constants out of
  // the source, then prove the consequence at the two consumers that can be
  // run in-process (the cache and matchOption).
  const engine = src("scripts/apply/scan-engine.mjs")
  const scanner = src(".claude/skills/apply-job/scan-page.js")

  const engineCut = /\.slice\(0,\s*(\d+)\)/.exec(
    engine.split("pick(\"[role='option']\")")[1] ?? "",
  )
  assert.ok(engineCut, "the probe must still slice its option list")
  assert.equal(engineCut[1], "40", "scan-engine.mjs cuts at 40")
  assert.match(scanner, /const MAX_OPTS = 40/, "scan-page.js cuts at 40 too")
  assert.equal(
    /optsTruncated/.test(engine) || /optsTruncated/.test(scanner),
    false,
    "THE DEFECT: neither scanner records that it dropped options, so the " +
      "flag field-cache.mjs reads defensively never arrives",
  )
})

test("E1 BREAKS [w3-resolution]: 40 of 200 is cached as if it were the whole list", () => {
  // The cache caps at MAX_CACHED_OPTS=60 and flags `optsTruncated` only when
  // ITS OWN cap bites. A list already cut from 200 to 40 upstream is under
  // that cap, so it is stored with no flag at all and re-served as complete.
  const cut = Array.from({ length: 40 }, (_, i) => "Option " + (i + 1))
  const scan = {
    url: "http://127.0.0.1/x",
    fields: [{ k: "c1", t: "combo", l: "Country *", req: true, opts: cut }],
    btns: [{ k: "b1", l: "Submit", r: "submit" }],
  }
  const cache = { v: 1, forms: {} }
  const fp = fingerprint(scan, "greenhouse")
  recordCache(cache, { fp, scan, atsId: "greenhouse", url: scan.url })
  const stored = Object.values(cache.forms[fp].fields)[0]
  assert.equal(stored.opts.length, 40)
  assert.equal(
    stored.optsTruncated,
    undefined,
    "THE DEFECT: 40 survivors of 200 are indistinguishable from a genuine " +
      "40-option list, because 40 < MAX_CACHED_OPTS",
  )
  // A 61-option list DOES get flagged, which is what makes the gap specific
  // rather than a blanket absence — the machinery exists, it just never fires
  // for the case that matters.
  const long = Array.from({ length: 61 }, (_, i) => "Option " + (i + 1))
  const cache2 = { v: 1, forms: {} }
  const scan2 = { ...scan, fields: [{ ...scan.fields[0], opts: long }] }
  const fp2 = fingerprint(scan2, "greenhouse")
  recordCache(cache2, { fp: fp2, scan: scan2, atsId: "greenhouse", url: "u" })
  assert.equal(Object.values(cache2.forms[fp2].fields)[0].optsTruncated, true)

  // And the consequence at the consumer: an answer the real form DOES offer,
  // but past the cut, is deferred as if it were not offered at all.
  const r = matchOption("Option 150", cut, {
    requireOptions: true,
    label: "Country *",
  })
  assert.equal(
    r.needsChoice,
    true,
    "a true answer past the cut looks unofferable to the user",
  )
})

// ---------------------------------------------------------------------------
// E2 — more than 18 comboboxes
// ---------------------------------------------------------------------------

test("E2 HANDLED [w2-engine]: the probe caps at 18 and says which it skipped", async () => {
  const scan = {
    fields: Array.from({ length: 23 }, (_, i) => ({
      k: "c" + (i + 1),
      t: "combo",
      l: "Dropdown " + (i + 1),
      req: true,
    })),
    btns: [{ k: "b1", l: "Submit", r: "submit" }],
  }
  const rig = instrumentedPage({ scan, menuOptions: 6 })
  const out = unwrapScan(await scanPage(rig.page)).scan
  assert.equal(out.probe.probed, 18)
  assert.equal(out.probe.capped, 5)
  const skipped = out.fields.filter((f) => f.probe_skipped === "probe cap")
  assert.equal(skipped.length, 5, "a capped field must say so, not look probed")
  for (const f of skipped) {
    assert.equal(f.opts, undefined, "a capped field has no options at all")
  }
})

test("E2 HANDLED [w3-resolution]: an UNPROBED combo defers instead of resolving OK", () => {
  // The audit's finding was that matchOption returned the first candidate when
  // `opts` was empty, with no needsChoice — so a dropdown nobody had opened
  // silently accepted whatever the fact base offered. The requireOptions guard
  // closes it; this pins that closure.
  const unprobed = matchOption("Option 1", [], {
    requireOptions: true,
    label: "Dropdown 19",
  })
  assert.equal(unprobed.needsChoice, true)
  assert.equal(unprobed.unprobed, true)

  // A text field genuinely has no option list, and must NOT be caught by it.
  const text = matchOption("Ada", [], { requireOptions: false, label: "Name" })
  assert.equal(text.needsChoice, undefined)

  // ...and end to end through the resolver, so the guard is proven at the
  // consumer rather than at the helper.
  const resolved = resolveFields(
    [{ k: "c19", t: "combo", l: "Are you authorized to work in the US?" }],
    {
      profile: path.join(ROOT, "tests", "fixtures", "profile.yaml"),
      answers: path.join(ROOT, "tests", "fixtures", "answers.yaml"),
    },
  )
  assert.notEqual(
    resolved[0].status,
    "OK",
    "a combo whose options were never seen must never resolve OK, however " +
      "confidently the fact base answers the question",
  )
})

// ---------------------------------------------------------------------------
// E3 — a multi-page form that never changes its URL
// ---------------------------------------------------------------------------

test("E3 HANDLED [w3-resolution]: two scans in a job dir is an error, not a guess", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edge-scan-"))
  try {
    fs.writeFileSync(path.join(dir, "scan-p1.json"), "{}")
    fs.writeFileSync(path.join(dir, "scan-p2.json"), "{}")
    const r = resolveScanPath(dir, {})
    assert.ok(
      r.error,
      "with two pages on disk the planner must refuse rather than default to " +
        "page 1 and put page 1's answers into page 2's fields",
    )
    assert.match(r.error, /scan-p1\.json.*scan-p2\.json|2 scans found/)
    // ...and naming the page explicitly still works.
    assert.equal(
      resolveScanPath(dir, { pageFlag: "2" }).path,
      path.join(dir, "scan-p2.json"),
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("E3 BREAKS [w2-engine]: urlGuard cannot tell page 2 from page 1", async () => {
  // The Greenhouse fixture is one URL serving two steps (GET vs POST). The
  // guard compares URLs with the query and hash stripped, so it passes on a
  // page it has never seen. The fixture exists precisely to pin this.
  const p1 = readScan("greenhouse-step1.scan.json")
  const p2 = readScan("greenhouse-step2.scan.json")
  assert.equal(
    p1.url.split("?")[0],
    p2.url.split("?")[0],
    "the fixture must keep both steps on one URL or this case is not being " +
      "tested at all",
  )

  const url = p1.url.split("?")[0]
  const rig = instrumentedPage({
    url,
    elements: { "#p1field": { kind: "input", value: "" } },
  })
  const report = await fillPage(rig.page, {
    urlGuard: url,
    items: [
      { k: "f1", how: "fill", sel: "#p1field", value: "Ada", label: "First" },
    ],
  })
  assert.equal(
    report.failed,
    0,
    "THE DEFECT: a plan built for step 1 fills happily while the browser is " +
      "on step 2, because the URL is identical. The guard is structurally " +
      "unable to catch a single-URL multi-step form.",
  )
})

// ---------------------------------------------------------------------------
// E4 — a React form that remounts mid-fill
// ---------------------------------------------------------------------------

test("E4 BREAKS [w2-engine]: a form remounting faster than one retry reports a landed value as failed", async () => {
  // tests/fixtures/hostile/forms/remount-mid-fill.html remounts every 400ms
  // and PRESERVES typed values. The engine retries a stale locator exactly
  // once (fill-engine.mjs actOn/isStaleError), which is enough for Ashby's
  // single async remount and not enough for a form that keeps doing it.
  const rig = instrumentedPage({
    elements: { "#f1": { kind: "input", value: "" } },
    staleForever: true,
  })
  const report = await fillPage(rig.page, {
    items: [{ k: "f1", how: "fill", sel: "#f1", value: "Ada", label: "First" }],
  })
  assert.equal(report.failed, 1)
  assert.match(report.failures[0].why, /not attached to the dom/i)
  assert.equal(
    report.ok,
    0,
    "THE DEFECT: one retry is not enough against a repeating remount, and " +
      "the report says failed for a field whose value may well have landed",
  )
  // The retry did happen — one replay, not zero and not a loop. kindOf() is
  // the first thing actOn touches, so it is what the remount detaches, and it
  // is therefore what counts the attempts.
  const kindOfCalls = rig.cost.calls.filter(
    (c) => c[0] === "locator.evaluate",
  ).length
  assert.equal(
    kindOfCalls,
    2,
    "exactly one replay: the cap is right, its size is not",
  )
})

test("E4 HANDLED [w2-engine]: one async remount (Ashby's) IS absorbed", async () => {
  const el = { kind: "input", value: "", throwOnce: true }
  const rig = instrumentedPage({ elements: { "#f1": el } })
  // Detach on the first touch only — Ashby's resume-autofill remount landing
  // between locate() and the interaction after it.
  let thrown = false
  const realLocator = rig.page.locator.bind(rig.page)
  rig.page.locator = (sel) => {
    const loc = realLocator(sel)
    const scroll = loc.scrollIntoViewIfNeeded.bind(loc)
    loc.scrollIntoViewIfNeeded = async () => {
      if (!thrown) {
        thrown = true
        throw new Error("Element is not attached to the DOM")
      }
      return scroll()
    }
    return loc
  }
  const report = await fillPage(rig.page, {
    items: [{ k: "f1", how: "fill", sel: "#f1", value: "Ada", label: "First" }],
  })
  assert.equal(report.failed, 0)
  assert.equal(report.ok, 1)
  assert.equal(el.value, "Ada")
})

// ---------------------------------------------------------------------------
// E5 — shadow DOM and same-origin iframes
// ---------------------------------------------------------------------------

test("E5 BREAKS [w2-engine]: nothing in the scan or fill path can see a shadow root", () => {
  // Method: read the three files that touch the page and search for every API
  // that can cross a shadow boundary. Absence is the finding — a scanner built
  // only on document.querySelectorAll cannot see into an open shadow root, let
  // alone a closed one, so a form inside a web component is invisible.
  const files = [
    ".claude/skills/apply-job/scan-page.js",
    "scripts/apply/scan-engine.mjs",
    "scripts/apply/fill-engine.mjs",
  ]
  for (const f of files) {
    const text = src(f)
    assert.equal(
      /shadowRoot|attachShadow|::part\(|:host\b/.test(text),
      false,
      `${f} unexpectedly mentions shadow DOM — if support was added, this ` +
        `finding is closed and the assertion must flip`,
    )
  }
})

test("E5 BREAKS [w2-engine]: the engine has no frameLocator, so an iframe form is unfillable", () => {
  const engine = src("scripts/apply/fill-engine.mjs")
  assert.equal(
    /frameLocator|page\.frames\(|contentFrame/.test(engine),
    false,
    "THE DEFECT: every locator is page-level. A form inside a same-origin " +
      "iframe cannot be filled at all.",
  )
  // The scanner does at least NOTICE one: it reports a signal telling the
  // model to navigate to the embed instead. That is a hand-off, not support,
  // and it only covers the seven ATS names in the pattern.
  const scanner = src(".claude/skills/apply-job/scan-page.js")
  assert.match(scanner, /application embedded in iframe/)
  assert.match(
    scanner,
    /greenhouse\|lever\|ashby\|workday\|smartrecruiters\|jobvite\|icims/,
    "the embed signal is an allowlist of seven names; an in-house iframe " +
      "form matches none of them and produces no signal at all",
  )
})

// ---------------------------------------------------------------------------
// E6 — a conditional reveal ("if yes, explain")
// ---------------------------------------------------------------------------

test("E6 BREAKS [w2-engine]: a field revealed BY the fill is never verified", async () => {
  // The verify pass probes exactly the plan's own items (fill-engine.mjs
  // builds `probes` from `items`). A required field that only exists once
  // "Yes" is picked is therefore not in the plan, not in the probes, and not
  // in requiredEmpty — so the run reports a clean fill of an incomplete form.
  const rig = instrumentedPage({
    elements: { "#q1": { kind: "input", value: "" } },
  })
  const seen = []
  const realEval = rig.page.evaluate.bind(rig.page)
  rig.page.evaluate = async (fn, arg) => {
    if (String(fn).includes("requiredEmpty")) seen.push(arg)
    return realEval(fn, arg)
  }
  const report = await fillPage(rig.page, {
    items: [{ k: "q1", how: "check", sel: "#q1", value: true, label: "Yes" }],
  })
  assert.equal(report.failed, 0)
  const probed = seen[0].map((p) => p.k)
  assert.deepEqual(
    probed,
    ["q1"],
    "THE DEFECT: the verify sweep can only see fields the plan already knew " +
      "about, so a conditional reveal is invisible to it",
  )
  assert.deepEqual(report.verify.requiredEmpty, [])
})

// ---------------------------------------------------------------------------
// E7 — login walls, CAPTCHAs, malformed markup
// ---------------------------------------------------------------------------

test("E7 HANDLED [w2-engine]: a password field classifies the page as login", () => {
  // The classification exists and is what the skill branches on. Asserted
  // against the scanner's source because running it needs a DOM.
  const scanner = src(".claude/skills/apply-job/scan-page.js")
  assert.match(scanner, /password field — login wall, hand off to the user/)
  assert.match(scanner, /signals\.some\(\(s\) => s\.startsWith\("password"\)\)/)
  assert.match(scanner, /recaptcha\|hcaptcha\|turnstile/)
  assert.match(scanner, /CAPTCHA present — hand off to the user/)
})

test("E7 BREAKS [w3-resolution]: fill-plan.mjs plans a form regardless of scan.kind", () => {
  // The login/CAPTCHA hand-off is written in SKILL.md, i.e. it is a model
  // instruction, and there is nothing mechanical behind it. A scan whose kind
  // is `login` still produces a fill plan, so the unattended runner (Phase 3,
  // which has no model on the green path) would fill a login wall.
  const planner = src("scripts/apply/fill-plan.mjs")
  assert.equal(
    /scan\.kind|kind === "login"|kind !== "form"/.test(planner),
    false,
    "THE DEFECT: nothing in the planner reads scan.kind. The only thing " +
      "stopping a login wall from being filled is the model reading SKILL.md, " +
      "which the auto path removes.",
  )
  // ...and the engine only COPIES signals into its report. Method: every
  // non-comment line of fill-engine.mjs that mentions `signals`, checked for a
  // control-flow keyword. A signal that is only ever assigned stops nothing.
  const signalLines = src("scripts/apply/fill-engine.mjs")
    .split(/\r?\n/)
    .filter((l) => /\bsignals\b/.test(l) && !/^\s*\/\//.test(l))
  assert.ok(signalLines.length > 0, "the engine does carry signals")
  for (const l of signalLines) {
    assert.equal(
      /\b(if|return|throw|continue|break)\b/.test(l),
      false,
      `THE DEFECT: signals are data only, never a branch: ${l.trim()}`,
    )
  }
})

test("E7 HANDLED: a malformed scan does not crash the planner", () => {
  // Deliberately broken shapes: a field with no type, no label, no key.
  const junk = [
    { k: "f1" },
    { t: "combo" },
    { k: "f3", t: "nonsense", l: "?" },
    {},
  ]
  const resolved = resolveFields(junk, {
    profile: path.join(ROOT, "tests", "fixtures", "profile.yaml"),
    answers: path.join(ROOT, "tests", "fixtures", "answers.yaml"),
  })
  assert.equal(resolved.length, junk.length)
  for (const r of resolved) {
    assert.notEqual(
      r.status,
      "OK",
      "a field the scanner could not describe must never resolve OK",
    )
  }
})

test("E7 HANDLED [w2-engine]: a locator that resolves to more than one element is refused", async () => {
  const rig = instrumentedPage({ elements: {} })
  const realLocator = rig.page.locator.bind(rig.page)
  rig.page.locator = (sel) => {
    const loc = realLocator(sel)
    loc.count = async () => 2 // ambiguous markup: two matches for one selector
    return loc
  }
  const report = await fillPage(rig.page, {
    items: [{ k: "f1", how: "fill", sel: ".dup", value: "x", label: "Dup" }],
  })
  assert.equal(report.failed, 1)
  assert.match(report.failures[0].why, /no unique element/)
})

// ---------------------------------------------------------------------------
// E8 — a field whose label sits under a heading that says something else
// ---------------------------------------------------------------------------

test("E8 HANDLED [w3-resolution]: two inputs both labelled 'Attach' are told apart by order", () => {
  // The Greenhouse replica labels BOTH file inputs "Attach"; the heading that
  // distinguishes resume from cover letter is outside the element the scanner
  // reads. The planner falls back to document order, which every one of these
  // boards renders resume-first.
  const scan = readScan("greenhouse-step1.scan.json")
  const files = scan.fields.filter((f) => f.t === "file")
  assert.equal(files.length, 2)
  assert.deepEqual(
    files.map((f) => f.l),
    ["Attach", "Attach"],
    "the fixture must keep both labels identical or this case is not tested",
  )

  const adapter = src("scripts/apply/ats/greenhouse.mjs")
  assert.match(adapter, /fileOrder: \["resume", "cover"\]/)
  const planner = src("scripts/apply/fill-plan.mjs")
  assert.match(
    planner,
    /fall back to document\s*\n?\s*\/\/ order/,
    "the order fallback must stay documented as the reason this works",
  )
})

test("E8 BREAKS [w2-engine]: the label is all the scanner reports; the heading above it is dropped", () => {
  // A field whose visible label says one thing while the section heading above
  // it says another is indistinguishable, in the scan, from a field with a
  // correct label. Nothing carries the heading, so nothing downstream can
  // notice the contradiction.
  const scan = readScan("greenhouse-step1.scan.json")
  for (const f of scan.fields) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(f, "section"),
      false,
      "THE DEFECT: no field carries the heading it sits under, so 'Attach' " +
        "under 'Resume' and 'Attach' under 'Cover letter' are the same string",
    )
  }
  // The consequence is already visible in the fixture: the only thing telling
  // the two apart is their index.
  const keys = scan.fields.filter((f) => f.t === "file").map((f) => f.k)
  assert.deepEqual(keys, ["f5", "f6"])
})

// ---------------------------------------------------------------------------
// What this file still cannot reach
// ---------------------------------------------------------------------------

test("the open gaps are named, not silently dropped", () => {
  // Kept as a test so it is impossible to forget: a gap that only lives in a
  // report stops being read the day the report is filed.
  const gaps = [
    {
      id: "remount-mid-fill.html",
      why:
        "the fixture is real HTML with a 400ms setInterval remount; " +
        "running it needs a browser. E4 above exercises the ENGINE's " +
        "behaviour under the same condition, not the page.",
      needs: "a Playwright leg",
    },
    {
      id: "ashby CSP proof (window.__ajCspProof stays undefined)",
      why:
        "a Content-Security-Policy is only enforced by a browser. The " +
        "harness confirms the HEADER is served; it cannot confirm the " +
        "policy blocked anything.",
      needs: "a Playwright leg",
    },
    {
      id: "labelOf() tier selection",
      why:
        "which of the four label tiers fires is a DOM property. The scan " +
        "fixtures assert what the scanner SHOULD produce, not that it does.",
      needs: "a Playwright leg",
    },
    {
      id: "shadow DOM at runtime",
      why:
        "E5 proves the APIs are absent from the source, which is the " +
        "structural finding. It does not run a web-component form.",
      needs: "a Playwright leg",
    },
  ]
  assert.equal(gaps.length, 4)
  for (const g of gaps) {
    assert.ok(g.why.length > 40, `gap ${g.id} must say how it was looked at`)
    assert.equal(g.needs, "a Playwright leg")
  }
})
