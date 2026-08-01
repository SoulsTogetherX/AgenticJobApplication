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
  buildPlan,
  readiness,
  submitReadiness,
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

// E1 CLOSED (the scanner half) 2026-07-31 by w2-engine. The cut is still 40 —
// that is a latency decision, not the defect — but it is no longer SILENT:
// both scanners now record `optsTruncated` and the real `optsTotal`, so the
// flag field-cache.mjs has always read defensively finally arrives.
test("E1 HANDLED [w2-engine]: the 200 -> 40 cut still happens but is now RECORDED, in both scanners", () => {
  const engine = src("scripts/apply/scan-engine.mjs")
  const scanner = src(".claude/skills/apply-job/scan-page.js")

  assert.match(scanner, /const MAX_OPTS = 40/, "scan-page.js still cuts at 40")
  // Both of scan-page.js's option branches — the native <select> and the
  // react-select probe — must set it. One of two is the shape of a half-fix,
  // and a count is how this notices.
  const flagged = scanner.match(/f\.optsTruncated = true/g) ?? []
  assert.equal(
    flagged.length,
    2,
    "both the <select> branch and the probe branch must flag truncation",
  )
  assert.match(scanner, /f\.optsTotal = all\.length/)
  assert.match(
    engine,
    /f\.optsTruncated = true/,
    "the local-runner scan engine must record it too",
  )
})

test("E1 HANDLED [w2-engine]: a probe whose page-side list was cut comes back flagged with the REAL total", async () => {
  // The behavioural half, because the grep above cannot tell a live
  // assignment from a dead one. The probe's return value crosses the
  // page boundary as data, so the double can supply either shape.
  const scan = {
    kind: "form",
    fields: [{ k: "c1", t: "combo", l: "Country *", req: true }],
    btns: [{ k: "b1", l: "Submit", r: "submit" }],
  }
  const cut = instrumentedPage({ scan, menuOptions: 40, menuTotal: 200 })
  const out = unwrapScan(await scanPage(cut.page, {}))
  const f = out.scan.fields.find((x) => x.k === "c1")
  assert.equal(f.opts.length, 40, "40 options came back")
  assert.equal(f.optsTruncated, true, "and the engine says so")
  assert.equal(f.optsTotal, 200, "with the real length, not the cut one")

  // The control: a genuinely short list must NOT be flagged, or the flag
  // means nothing and every combo defers forever.
  const whole = instrumentedPage({ scan, menuOptions: 12, menuTotal: 12 })
  const out2 = unwrapScan(await scanPage(whole.page, {}))
  const f2 = out2.scan.fields.find((x) => x.k === "c1")
  assert.equal(f2.opts.length, 12)
  assert.equal(f2.optsTruncated, undefined, "a complete list carries no flag")
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

// E4 CLOSED 2026-07-31 by w2-engine, and NOT by adding retries — that is the
// part worth reading. A form that remounts on a timer is racing the locator,
// so no attempt count wins; the fix is that the VERIFY pass reads the DOM in a
// single page.evaluate, which cannot be raced, and promotes a stale failure
// whose value is in fact on the page. The retry cap did move (1 -> 3 attempts)
// but that only absorbs Ashby's single async remount.
test("E4 HANDLED [w2-engine]: a value that landed under a repeating remount is reconciled to ok, not reported failed", async () => {
  const rig = instrumentedPage({
    elements: { "#f1": { kind: "input", value: "" } },
    staleForever: true,
    // The page's own answer at verify time: the value IS there. This is the
    // live-run case — tests/fixtures/hostile/forms/remount-mid-fill.html
    // remounts every 400ms and PRESERVES typed values.
    verifyLanded: ["f1"],
  })
  const report = await fillPage(rig.page, {
    items: [{ k: "f1", how: "fill", sel: "#f1", value: "Ada", label: "First" }],
  })
  assert.equal(report.failed, 0, "a landed value must not be reported failed")
  assert.equal(report.ok, 1)
  assert.deepEqual(
    report.reconciled.map((r) => r.k),
    ["f1"],
    "and the rescue must be VISIBLE, not a silent upgrade",
  )
  assert.match(report.reconciled[0].why, /not attached to the dom/i)

  // Every attempt still ran, and the cap is still finite — the reconciliation
  // is a second mechanism, not a licence to retry forever. kindOf() is the
  // first thing actOn touches, so it is what the remount detaches and what
  // counts the attempts.
  const kindOfCalls = rig.cost.calls.filter(
    (c) => c[0] === "locator.evaluate",
  ).length
  assert.equal(kindOfCalls, 3, "STALE_ATTEMPTS = 3, bounded")
})

test("E4 HANDLED [w2-engine]: the rescue is not a blanket pass — a value that did NOT land stays failed", async () => {
  // The safe direction, and the assertion that stops the test above from
  // being satisfied by "promote every stale failure". A failure blocks the
  // unattended path; a false ok would not.
  const rig = instrumentedPage({
    elements: { "#f1": { kind: "input", value: "" } },
    staleForever: true,
    verifyLanded: [], // the verify pass read the page and the value is absent
  })
  const report = await fillPage(rig.page, {
    items: [{ k: "f1", how: "fill", sel: "#f1", value: "Ada", label: "First" }],
  })
  assert.equal(report.failed, 1)
  assert.equal(report.ok, 0)
  assert.deepEqual(report.reconciled, [])
  assert.match(report.failures[0].why, /not attached to the dom/i)
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

// E5 PARTIALLY closed 2026-07-31 by w2-engine, and the split matters more than
// either half: a shadow root holding form controls is now DETECTED and
// reported, and it is still UNFILLABLE. Collapsing those into one "handled"
// would be the documentation slacking signature — a defence described as
// stronger than it is.
test("E5 HANDLED [w2-engine]: a shadow root holding form controls is detected and signalled", () => {
  const scanner = src(".claude/skills/apply-job/scan-page.js")
  assert.match(scanner, /\.shadowRoot/, "the scanner must look for one")
  assert.match(
    scanner,
    /shadow root\(s\) hold form controls this scanner cannot see or fill/,
    "and say so in a signal the user can act on",
  )
  // Detection is gated on the root actually holding a CONTROL, not on the
  // root existing — a shadow root wrapping a styled button is not a blind
  // spot, and a signal that fires on every design-system page gets ignored.
  assert.match(scanner, /querySelector\(HIDDEN_CONTROL\)/)
})

test("E5 BREAKS [w2-engine]: detecting a shadow root is not filling one — no API in either engine can cross the boundary", () => {
  // Method: read the two files that actually touch elements and search for
  // every API that can cross a shadow boundary. Absence is the finding. The
  // scanner is excluded from this sweep on purpose — it now legitimately
  // mentions shadowRoot for the DETECTION above, which is exactly why the two
  // halves are separate tests.
  for (const f of [
    "scripts/apply/scan-engine.mjs",
    "scripts/apply/fill-engine.mjs",
  ]) {
    const text = src(f)
    assert.equal(
      /shadowRoot|attachShadow|::part\(|:host\b/.test(text),
      false,
      `THE REMAINING DEFECT: ${f} has no way into a shadow root. A form ` +
        `inside a web component is reported and then handed to the user.`,
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

// E7 CLOSED 2026-07-31 by w3-resolution. The BREAKS assertion below used to
// read: "nothing in the planner reads scan.kind", and it was green because the
// hand-off existed only as prose in apply-job/SKILL.md — an instruction a
// MODEL reads, which the Phase 3 unattended runner does not have on its green
// path. `buildPlan()` now short-circuits on the page's own classification.
//
// The three tests below are deliberately not one test. The grep proves the
// check is IN the file; the behavioural test proves it WORKS. A grep alone
// cannot tell a live guard from a commented-out one, which is exactly the
// slacking signature the protocol calls "a test that asserts the mock rather
// than the behaviour" — flagged by w3-resolution against its own fix, and it
// was right.
const LOGIN_ADAPTER = {
  id: "generic",
  comboStrategies: [],
  fileFields: [],
  fileOrder: [],
}

test("E7 HANDLED [w3-resolution]: the planner reads scan.kind and signals, as a BRANCH not a mention", () => {
  const planner = src("scripts/apply/fill-plan.mjs")
  assert.match(
    planner,
    /scan\.kind === "login"/,
    "the planner must read the scanner's own login classification",
  )
  assert.match(planner, /captcha/i, "and its CAPTCHA signal")
  // A mention is not a branch. Every non-comment line naming scan.kind must
  // sit in control flow — the same method the old BREAKS test used against
  // fill-engine.mjs's signals, inverted.
  const kindLines = src("scripts/apply/fill-plan.mjs")
    .split(/\r?\n/)
    .filter((l) => /scan\.kind/.test(l) && !/^\s*\/\//.test(l))
  assert.ok(kindLines.length > 0, "scan.kind must appear outside comments")
  assert.ok(
    kindLines.some((l) => /===|!==|\bif\b/.test(l)),
    `scan.kind is read but never compared: ${JSON.stringify(kindLines)}`,
  )
  // ...and the comparison must short-circuit rather than annotate: the guard
  // returns a whole plan of its own. Asserted on the source because the
  // behavioural tests below cannot tell "returned early" from "produced no
  // items for some other reason".
  assert.match(
    planner,
    /if \(captchaSignal \|\| blockedKind\) \{[\s\S]{0,600}?items: \[\],/,
    "the guard must return a plan with empty items, before the field loop",
  )
  // The engine's `signals` are still data only — that has NOT changed, and it
  // is correct: the stop belongs in the planner, which runs before anything
  // touches the page. Kept so a future "fix" that moves the branch into the
  // engine has to say so.
  const signalLines = src("scripts/apply/fill-engine.mjs")
    .split(/\r?\n/)
    .filter((l) => /\bsignals\b/.test(l) && !/^\s*\/\//.test(l))
  assert.ok(signalLines.length > 0, "the engine does carry signals")
  for (const l of signalLines) {
    assert.equal(
      /\b(if|return|throw|continue|break)\b/.test(l),
      false,
      `the engine branching on signals would be a second, weaker gate: ${l.trim()}`,
    )
  }
})

// The behavioural half. Each case is a page the pipeline must REFUSE, carrying
// a field the fact base can answer perfectly well — that is the trap: a login
// wall's stray inputs resolve OK like any others, so `readiness()` alone can
// never catch this. Only a page-shape refusal can.
for (const c of [
  {
    name: "a login wall (password field on the page)",
    scan: { kind: "login", heading: "Sign in to continue", signals: [] },
    expect: /login wall/i,
  },
  {
    name: "an already-submitted confirmation page",
    scan: { kind: "confirm", heading: "Thanks for applying", signals: [] },
    expect: /confirmation/i,
  },
  {
    name: "a CAPTCHA, even on a page that classifies as a form",
    scan: {
      kind: "form",
      heading: "Apply",
      signals: ["iframe:recaptcha challenge"],
    },
    expect: /captcha/i,
  },
]) {
  test(`E7 HANDLED [w3-resolution]: buildPlan refuses ${c.name} — no items, blocks both readiness gates`, () => {
    const scan = {
      url: "https://job-boards.greenhouse.io/x/jobs/1",
      // A field the fact base answers with total confidence. If the guard ran
      // AFTER the field loop, or not at all, this would be planned as a fill.
      fields: [
        { k: "f1", sel: "#e", n: "email", t: "text", l: "Email", req: true },
      ],
      ...c.scan,
    }
    const resolved = resolveFields(scan.fields, {
      profile: path.join(ROOT, "tests", "fixtures", "profile.yaml"),
      answers: path.join(ROOT, "tests", "fixtures", "answers.yaml"),
    })
    assert.equal(
      resolved[0].status,
      "OK",
      "precondition: this field DOES resolve, so nothing but the page-shape guard can stop it",
    )
    const plan = buildPlan({
      scan,
      resolved,
      adapter: LOGIN_ADAPTER,
      url: scan.url,
    })
    assert.deepEqual(plan.items, [], "nothing may be handed to the fill engine")
    assert.equal(plan.defer.length, 1, "exactly one defer, naming the page")
    assert.match(plan.defer[0].why, c.expect)
    // THE ONE THAT MATTERS MOST: either exempted marker would route a login
    // wall straight through readiness() and re-mark the page ready.
    assert.notEqual(plan.defer[0].why, "consent")
    assert.notEqual(plan.defer[0].why, "confirm-widget")
    assert.equal(readiness(plan).ready, false)
    assert.equal(submitReadiness(plan).ready, false)
  })
}

test("E7 HANDLED [w3-resolution]: the control — an ordinary form with the same field is unaffected and reaches ready:true", () => {
  // Without this, the three refusals above are satisfied by a planner that
  // refuses everything. `kind: "form"` and no signals is the normal case.
  const scan = {
    url: "https://job-boards.greenhouse.io/x/jobs/1",
    kind: "form",
    heading: "Apply",
    signals: [],
    fields: [
      { k: "f1", sel: "#e", n: "email", t: "text", l: "Email", req: true },
    ],
  }
  const resolved = resolveFields(scan.fields, {
    profile: path.join(ROOT, "tests", "fixtures", "profile.yaml"),
    answers: path.join(ROOT, "tests", "fixtures", "answers.yaml"),
  })
  const plan = buildPlan({
    scan,
    resolved,
    adapter: LOGIN_ADAPTER,
    url: scan.url,
  })
  assert.deepEqual(
    plan.items.map((i) => `${i.k}:${i.how}`),
    ["f1:fill"],
  )
  assert.deepEqual(plan.defer, [])
  assert.equal(readiness(plan).ready, true)
  assert.equal(submitReadiness(plan).ready, true)
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

// UPDATED 2026-07-31: this test used to send a plan of ONE ambiguous item, and
// w2-engine's new wrong-page floor now fires first on that input (if not one
// of the plan's items resolves, the engine says "wrong page" once instead of N
// indistinguishable per-field failures). So the plan needs a field that DOES
// resolve, or the ambiguity refusal is never reached and this test silently
// measures the other guard. Both guards are now asserted, separately.
test("E7 HANDLED [w2-engine]: a locator that resolves to more than one element is refused", async () => {
  const rig = instrumentedPage({
    elements: { "#ok": { kind: "input", value: "" } },
  })
  const realLocator = rig.page.locator.bind(rig.page)
  rig.page.locator = (sel) => {
    const loc = realLocator(sel)
    if (sel === ".dup") loc.count = async () => 2 // two matches for one selector
    return loc
  }
  const report = await fillPage(rig.page, {
    items: [
      { k: "f0", how: "fill", sel: "#ok", value: "Ada", label: "Fine" },
      { k: "f1", how: "fill", sel: ".dup", value: "x", label: "Dup" },
    ],
  })
  assert.equal(report.ok, 1, "the unambiguous field still fills")
  assert.equal(report.failed, 1)
  assert.equal(report.failures[0].k, "f1")
  assert.match(report.failures[0].why, /no unique element/)
})

test("E7 HANDLED [w2-engine]: when NOT ONE of the plan's fields exists, the engine says 'wrong page' once instead of N failures", async () => {
  // E3's shape — a multi-page form on a single URL, where urlGuard cannot
  // help. Three items, none present; the report must name the cause once.
  const rig = instrumentedPage({ elements: {} })
  const report = await fillPage(rig.page, {
    items: [
      { k: "f1", how: "fill", sel: "#a", value: "1", label: "A" },
      { k: "f2", how: "fill", sel: "#b", value: "2", label: "B" },
      { k: "f3", how: "fill", sel: "#c", value: "3", label: "C" },
    ],
  })
  assert.equal(
    report.failed,
    1,
    "one guard failure, not one per field — three identical 'no unique " +
      "element' lines is what this replaced. Got: " +
      JSON.stringify(report.failures),
  )
  assert.equal(report.failures[0].how, "guard")
  assert.match(report.failures[0].why, /same URL, different form/i)
  assert.match(report.failures[0].why, /re-scan before filling/i)
  assert.equal(report.ok, 0, "and nothing was filled on the wrong page")
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
  // STALE: this used to pin the literal keys ("f5","f6"), which is a scanner
  // STAMPING detail (combos are stamped before file inputs), not the
  // property this test is about. qa-adversary regenerating the fixture from
  // the real scanner (2184cc1) shifted the numbering to f6/f7 and broke a
  // pin that was never the point — fixed to assert what actually matters:
  // exactly two distinct file inputs, indistinguishable by anything but
  // document order, which is the whole defect this test exists to show.
  const keys = scan.fields.filter((f) => f.t === "file").map((f) => f.k)
  assert.equal(keys.length, 2, "both file inputs must still be present")
  assert.equal(new Set(keys).size, 2, "the two file inputs must be distinct")
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
        "E5 proves the scanner now DETECTS a shadow root holding controls " +
        "and that neither engine has an API to cross one — both structural " +
        "findings from the source. It does not run a web-component form, so " +
        "whether the detection fires on a real one is still unproven.",
      needs: "a Playwright leg",
    },
  ]
  assert.equal(gaps.length, 4)
  for (const g of gaps) {
    assert.ok(g.why.length > 40, `gap ${g.id} must say how it was looked at`)
    assert.equal(g.needs, "a Playwright leg")
  }
})
