// The structural edge-case corpus.
//
// These break the engine on SHAPE, not on malice — that split is why this file
// and tests/security/hostile-forms.test.mjs are separate. Nothing here is an
// attack; every case is a form somebody built badly, or built for humans, and
// they are far more common than hostile boards.
//
// Each case is one of two kinds, and the difference is stated in the test name:
//
//   "E<n> HANDLED [<owner>]: ..."
//             the product code already copes, and the test pins that so a
//             later change cannot quietly undo it.
//   "FINDING (<owner>): E<n> BREAKS — ..."
//             the product code does the wrong thing today. The assertion
//             describes the WRONG behaviour, so the test is green now and goes
//             red the moment it is fixed, at which point the assertion flips
//             and the finding closes. That is deliberate: a test that fails on
//             HEAD blocks everyone else's wave, and this file's job is to make
//             the gap findable and falsifiable, not to hold the build hostage.
//
// THE `FINDING (<owner>):` PREFIX IS LOAD-BEARING, not decoration. It is what
// .github/workflows/test-gate.mjs's OWNED_RE — /^FINDING \(([^)]+)\)/, anchored
// at the start of the test name — matches to route a red into the "known,
// owned" bucket instead of "UNEXPECTED — nobody owns these". These tests used
// to be named `E8 BREAKS [w2-engine]: ...`; square brackets do not match, and
// mid-name does not match either, so an owned failure was reported as
// unattributed, which is exactly the noise that split exists to remove
// (ci-engineer, 2026-07-31). The classification is reporting only — it cannot
// make a red run green — but a mis-bucketed red is a red nobody reads.
//
// NO BROWSER RUNS HERE. The project has no Playwright (see
// scripts/apply/browser.mjs), so cases that need a live DOM — react-select
// opening, shadow roots, a real remount — are exercised either against the
// engine with an instrumented page, or as a STRUCTURAL assertion about the
// source. Where neither works, the case is named in this file's final test as
// an open gap rather than silently dropped.
//
// A SOURCE GREP IS A LAST RESORT, AND SAYS SO WHERE IT IS USED. A test that
// matches its subject's source passes the moment the string appears: it cannot
// tell a live guard from a commented-out one, and it breaks when somebody
// improves a comment — which is how three tests in this file went red in one
// session (2026-07-31) on a string rather than on behaviour. Two greps are
// legitimate and both are labelled in place: an ABSENCE (no frameLocator, no
// shadowRoot API, the engine never branching on `signals`), which no input can
// exhibit, and DOM-only code that cannot be executed without a browser. Never
// grep for a comment's wording; never grep for something the code can be made
// to demonstrate. Each surviving grep names its behavioural sibling.
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
import greenhouse from "../../scripts/apply/ats/greenhouse.mjs"
import { instrumentedPage, unwrapScan } from "../../scripts/dev/bench-apply.mjs"
import { launchBrowser } from "../../scripts/apply/browser.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const BOARDS = path.join(ROOT, "tests", "fixtures", "boards")
const SCANS = path.join(BOARDS, "scans")
const readScan = (n) => JSON.parse(fs.readFileSync(path.join(SCANS, n), "utf8"))
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")

// --- real Chromium, for the cases a fake page cannot decide ----------------
// This file's header says "NO BROWSER RUNS HERE", and that is now true of
// everything EXCEPT E6. It stopped being true on 2026-07-31 because
// playwright-core is a committed dependency and Chromium is installed, and
// because the E6 assertion could not be made honest without a DOM: the reveal
// is created by an onchange handler, so no instrumented double can produce it.
// Probed once at load; a missing browser SKIPS with a stated reason, because a
// leg that skips silently is indistinguishable from one that passed.
const NO_BROWSER = await (async () => {
  try {
    const s = await launchBrowser({ headless: true })
    await s.close()
    return null
  } catch (e) {
    return "no usable Chromium: " + String(e.message).slice(0, 90)
  }
})()

const withPage = async (fn) => {
  const s = await launchBrowser({ headless: true })
  try {
    return await fn(s.page)
  } finally {
    await s.close()
  }
}

// ---------------------------------------------------------------------------
// E1 — a 200-option dropdown
// ---------------------------------------------------------------------------

// E1 CLOSED (the scanner half) 2026-07-31 by w2-engine. The cut moved 40 ->
// 250 on 2026-08-21 (a real 197-row country list lost its banked answer to
// the old cap) — the cap is a bound on pathological lists, not the defect —
// and it is no longer SILENT:
// both scanners now record `optsTruncated` and the real `optsTotal`, so the
// flag field-cache.mjs has always read defensively finally arrives.
test("E1 HANDLED [w2-engine]: the over-cap cut still happens but is now RECORDED, in both scanners", () => {
  // GREP, DELIBERATELY, AND SAID SO: scan-page.js is DOM-only and cannot be
  // executed here. Its behavioural sibling is the very next test, which runs
  // scan-engine.mjs against an instrumented page and reads the flag off the
  // returned scan; this one exists only to prove the OTHER scanner — the one
  // that runs on a live board — was not left behind by a half-fix.
  const engine = src("scripts/apply/scan-engine.mjs")
  const scanner = src(".claude/skills/apply-job/scan-page.js")

  assert.match(
    scanner,
    /const MAX_OPTS = 250/,
    "scan-page.js cuts at 250 (raised from 40, 2026-08-21)",
  )
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

test("FINDING (w3-resolution): E1 BREAKS — 40 of 200 is cached as if it were the whole list", () => {
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
  // 301 exceeds MAX_CACHED_OPTS=300 (raised with the scanner cap 2026-08-21).
  const long = Array.from({ length: 301 }, (_, i) => "Option " + (i + 1))
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
// E2 — more than 24 comboboxes
//
// The cap moved 18 -> 24 on 2026-08-07: Coinbase's Greenhouse form carries 23
// combos, so at 18 it skipped 5 real required fields and each came back
// NEEDS-CHOICE for a reason the form was not responsible for. What this test
// is about is unchanged and is not the number: a capped field must SAY it was
// capped rather than look like a probed field with no options.
// ---------------------------------------------------------------------------

test("E2 HANDLED [w2-engine]: the probe caps at 24 and says which it skipped", async () => {
  const scan = {
    fields: Array.from({ length: 29 }, (_, i) => ({
      k: "c" + (i + 1),
      t: "combo",
      l: "Dropdown " + (i + 1),
      req: true,
    })),
    btns: [{ k: "b1", l: "Submit", r: "submit" }],
  }
  const rig = instrumentedPage({ scan, menuOptions: 6 })
  const out = unwrapScan(await scanPage(rig.page)).scan
  assert.equal(out.probe.probed, 24)
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

test("FINDING (w2-engine): E3 BREAKS — urlGuard cannot tell page 2 from page 1", async () => {
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

test("FINDING (w2-engine): E5 BREAKS — detecting a shadow root is not filling one — no API in either engine can cross the boundary", () => {
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

test("FINDING (w2-engine): E5 BREAKS — the engine has no frameLocator, so an iframe form is unfillable", () => {
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

// E6 CLOSED 2026-07-31 by w2-engine (fill-engine.mjs:735-778, the page-wide
// sweep inside the verify evaluate). REWRITTEN 2026-07-31 by qa-breaker,
// because the test that was here COULD NOT DETECT THE FIX.
//
// The old assertion was `deepEqual(probed, ["q1"])` on the ARGUMENT passed to
// the verify evaluate. The fix adds a document-wide sweep INSIDE that
// evaluate and deliberately leaves the probe list alone — so the old test was
// green before the fix, green after it, and would stay green if the sweep were
// deleted again tomorrow. That is the protocol's "asserts nothing meaningful"
// signature and it is the third source/argument-shaped assertion in this file
// to be proven blind.
//
// It is replaced by a behavioural test against real Chromium. The reveal is
// produced by an onchange handler, so there is no instrumented double that can
// produce it — the browser is the only thing that can decide this case.
//
// CANARIED: with the `res.revealed.push(...)` block deleted in a sandbox copy
// of scripts/apply/, this test fails on the `["If yes, when?"]` assertion.
const E6_FORM = `<!doctype html><form>
<label for="q1">Have you worked here before?</label>
<input type="checkbox" id="q1" name="q1">
<div id="reveal" hidden></div>
<script>
document.getElementById('q1').addEventListener('change', function () {
  var d = document.getElementById('reveal')
  if (!this.checked) { d.hidden = true; d.innerHTML = ''; return }
  d.hidden = false
  d.innerHTML =
    '<label for="when">If yes, when?</label>' +
    '<input id="when" name="when" required>' +
    '<label for="proof">Proof of employment</label>' +
    '<input id="proof" name="proof" type="file" required>'
})
<\/script></form>`

const E6_PLAN = {
  items: [{ k: "q1", how: "check", sel: "#q1", value: true, label: "Yes" }],
}

test("E6 HANDLED [w2-engine]: a field revealed BY the fill comes back in report.revealed", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const report = await withPage(async (page) => {
    await page.setContent(E6_FORM)
    return fillPage(page, E6_PLAN)
  })
  // The tick itself must succeed, or the reveal never happens and the
  // assertion below would pass for the wrong reason.
  assert.equal(report.ok, 1)
  assert.equal(report.failed, 0)
  assert.deepEqual(
    report.revealed.map((r) => r.label),
    ["If yes, when?"],
    "the required text field that only exists once the box is ticked must " +
      "come back as data for the caller to defer on",
  )
  // Reported, never filled: there is no answer for it in this process.
  assert.equal(report.revealed[0].sel, "#when")
  assert.equal(report.revealed[0].type, "text")
})

test("FINDING (w2-engine): E6 RESIDUAL — a required file input revealed by the fill is invisible to the sweep", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // Stated by w2-engine against its own fix, and reproduced here so it is a
  // failing-when-fixed test rather than a note: SKIP_TYPE in fill-engine.mjs
  // excludes `file`, because a file input's value is unreadable from the page
  // and every un-uploaded slot on the form would otherwise report as revealed.
  //
  // The cost of that trade is this: a REQUIRED attachment that the reveal
  // created, and that nobody uploaded, reaches neither `revealed` nor
  // `requiredEmpty`. On the unattended path that is a form which looks
  // complete and is not. The same page carries both fields, so this is the
  // exact blind spot beside the exact thing that works.
  const report = await withPage(async (page) => {
    await page.setContent(E6_FORM)
    return fillPage(page, E6_PLAN)
  })
  const labels = report.revealed.map((r) => r.label)
  assert.equal(
    labels.includes("Proof of employment"),
    false,
    "THE REMAINING DEFECT: flip this to true when the sweep learns to report " +
      "an empty required file input",
  )
  assert.deepEqual(report.verify.requiredEmpty, [])
  // Pin the reason, so a later reader does not read the absence as an
  // oversight and 'fix' it by dropping the skip without solving readability.
  assert.match(
    src("scripts/apply/fill-engine.mjs"),
    /const SKIP_TYPE = \{[^}]*file: 1/s,
  )
})

// ---------------------------------------------------------------------------
// E7 — login walls, CAPTCHAs, malformed markup
// ---------------------------------------------------------------------------

test("E7 HANDLED [w2-engine]: a password field classifies the page as login", () => {
  // GREP, DELIBERATELY, AND SAID SO: the classification is computed from a live
  // DOM, so it cannot be executed here. Its behavioural siblings are the
  // buildPlan refusal tests further down, which take `kind: "login"` and
  // `signals: ["iframe:recaptcha challenge"]` as INPUT and prove the consumer
  // acts on them — so what stays unproven is only that a real page produces
  // them, which the open-gaps test at the bottom names.
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

// REWRITTEN 2026-07-31 (qa-breaker). This test used to prove "the guard
// short-circuits BEFORE the field loop" with a source regex —
// /if \(captchaSignal \|\| blockedKind\) \{[\s\S]{0,600}?items: \[\],/ — on the
// stated grounds that "the behavioural tests below cannot tell 'returned early'
// from 'produced no items for some other reason'". They can, and this is how:
// give the guard a scan whose OTHER fields would each leave an unmistakable
// fingerprint if the loop ran. Empty `items` alone is ambiguous; empty `items`
// AND the absence of two defers the loop is guaranteed to emit is not.
test("E7 HANDLED [w3-resolution]: the page-shape guard returns BEFORE the field loop — proven by the defers the loop would have left", () => {
  // f2 and f3 are chosen because buildPlan's field loop cannot process either
  // one silently: a file input with no rendered document defers "unrecognised
  // attachment slot", and an unknown type defers "unsupported field type". If
  // the guard ran after the loop, or merely annotated the plan, both would be
  // in plan.defer.
  const fields = [
    { k: "f1", sel: "#e", n: "email", t: "text", l: "Email", req: true },
    { k: "f2", sel: "#r", t: "file", l: "Attach", req: true },
    { k: "f3", sel: "#z", t: "nonsense", l: "What?", req: true },
  ]
  const bankOpts = {
    profile: path.join(ROOT, "tests", "fixtures", "profile.yaml"),
    answers: path.join(ROOT, "tests", "fixtures", "answers.yaml"),
  }
  const planFor = (extra) => {
    const scan = {
      url: "https://job-boards.greenhouse.io/x/jobs/1",
      fields,
      ...extra,
    }
    return buildPlan({
      scan,
      resolved: resolveFields(fields, bankOpts),
      adapter: LOGIN_ADAPTER,
      url: scan.url,
    })
  }

  // The control FIRST, so the login case below is a measured difference rather
  // than a planner that refuses everything: on an ordinary form the loop runs
  // and leaves exactly the two fingerprints.
  const ok = planFor({ kind: "form", heading: "Apply", signals: [] })
  assert.deepEqual(
    ok.items.map((i) => i.k),
    ["f1"],
  )
  assert.deepEqual(
    ok.defer.map((d) => `${d.k}|${d.why}`),
    ["f2|unrecognised attachment slot", "f3|unsupported field type nonsense"],
    "precondition: the field loop DOES leave these two marks when it runs",
  )

  // The login wall: one defer, naming the page, and neither fingerprint.
  const blocked = planFor({ kind: "login", heading: "Sign in", signals: [] })
  assert.deepEqual(blocked.items, [])
  assert.equal(
    blocked.defer.length,
    1,
    "not one defer per field — the loop never ran. Got: " +
      JSON.stringify(blocked.defer),
  )
  assert.match(blocked.defer[0].why, /login wall/i)
  assert.equal(
    blocked.defer.some((d) => d.k === "f2" || d.k === "f3"),
    false,
    "a per-field defer here would mean the guard annotated rather than " +
      "short-circuited, and a plan built past a login wall is one that can " +
      "type the user's email into a sign-in box",
  )

  // Same proof for the CAPTCHA door, which is a signal rather than a kind and
  // is therefore a genuinely separate branch.
  const captcha = planFor({
    kind: "form",
    heading: "Apply",
    signals: ["iframe:recaptcha challenge"],
  })
  assert.deepEqual(captcha.items, [])
  assert.equal(captcha.defer.length, 1)
  assert.match(captcha.defer[0].why, /captcha/i)

  // GREP, DELIBERATELY, AND SAID SO: the remaining assertion is an ABSENCE —
  // fill-engine.mjs must carry `signals` as data and never branch on them. An
  // absence cannot be demonstrated by running the code (no input exhibits a
  // branch that is not there), so a source sweep is the only available method,
  // and it is a fact about the file rather than a guess about the browser. Its
  // behavioural sibling is the whole block above: the stop lives in the
  // planner, which runs before anything touches the page. Kept so a future
  // "fix" that moves the branch into the engine has to say so.
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

// ---------------------------------------------------------------------------
// E7b — a CAPTCHA VENDOR is not a CAPTCHA CHALLENGE (narrowed 2026-08-03)
// ---------------------------------------------------------------------------
// Greenhouse, Lever and Ashby all embed reCAPTCHA in its `size=invisible`
// score-based form — a corner badge a human never interacts with. Blocking on
// the vendor name deferred every page on every adapter board at `items: 0`,
// including the ATTENDED path, which is the only lawful source of the
// post-submit corpus (§4.10). Measured that day: GitLab/Affirm/Reddit all
// `size=invisible` with `.grecaptcha-badge`; Map SSG an hCaptcha
// `#frame=checkbox` titled "...checkbox for hCaptcha security challenge".
//
// The pair below is the whole point and neither half stands alone: the first
// proves the gate OPENS for a passive widget, the second that it stays SHUT
// for a real challenge. A fix that only satisfied the first would be the
// forbidden guess with the model removed.
for (const c of [
  {
    name: "a passive invisible score-based widget does NOT block",
    signals: [
      "captcha passive: invisible score-based widget, no challenge shown",
    ],
    blocked: false,
  },
  {
    name: "a real challenge still blocks",
    signals: ["CAPTCHA present — hand off to the user"],
    blocked: true,
  },
  {
    name: "an UNRECOGNISED captcha signal fails closed",
    // The load-bearing case. A new vendor, a reworded signal or an escalated
    // challenge must block by DEFAULT — the exception is a named allow, not a
    // relaxed pattern. Invert this and an unknown signal walks straight
    // through onto a live submit.
    signals: ["hcaptcha challenge visible"],
    blocked: true,
  },
  {
    name: "a passive marker does not launder a challenge alongside it",
    signals: [
      "captcha passive: invisible score-based widget, no challenge shown",
      "CAPTCHA present — hand off to the user",
    ],
    blocked: true,
  },
]) {
  test(`E7b: ${c.name}`, () => {
    const scan = {
      url: "https://job-boards.greenhouse.io/x/jobs/1",
      kind: "form",
      heading: "Apply",
      signals: c.signals,
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
    if (c.blocked) {
      assert.deepEqual(plan.items, [], "a challenge must hand off, not fill")
      assert.equal(plan.defer.length, 1)
      assert.match(plan.defer[0].why, /captcha/i)
      assert.equal(submitReadiness(plan).ready, false)
    } else {
      assert.deepEqual(
        plan.items.map((i) => i.k),
        ["f1"],
        "a passive widget must leave the page fillable — this is the " +
          "assertion that was impossible to satisfy before the narrowing",
      )
      assert.deepEqual(plan.defer, [])
      assert.equal(readiness(plan).ready, true)
    }
  })
}

// GREP, DELIBERATELY: the scanner's classification is computed from a live DOM
// and cannot be executed here, so the shape of the discriminator is asserted
// against its source — the same method the E7 grep above already uses. What
// this pins is that `passive` requires a POSITIVE `size=invisible` match, i.e.
// that the scanner also fails closed rather than treating "not obviously a
// challenge" as safe.
test("E7b: the scanner's passive branch requires a positive size=invisible match", () => {
  const scanner = src(".claude/skills/apply-job/scan-page.js")
  assert.match(scanner, /size=invisible/)
  assert.match(scanner, /captcha passive:/)
  assert.match(scanner, /CAPTCHA present — hand off to the user/)
  // The challenge-frame list must still name the shapes that block.
  assert.match(scanner, /bframe/)
  assert.match(scanner, /frame=checkbox/)
})

// THE BUG THIS FIX SHIPPED WITH, kept as a test because the first attempt was
// green everywhere and still blocked every board. `iframes` is truncated to
// 160 chars for REPORTING; on a real Greenhouse anchor `size=invisible` sits
// past that cut, so classifying off the truncated copy silently never matched.
// The behavioural tests above could not catch it — they feed signal strings to
// the planner and never build one from a DOM — so the trap is pinned two ways:
// the real URL's own geometry, and the source reading the raw elements.
test("E7b: the 160-char report truncation destroys size=invisible — classify from the raw element", () => {
  // Captured live from GitLab's Greenhouse board 2026-08-03. `k=` is a public
  // reCAPTCHA site key, visible in any visitor's page source.
  const REAL_ANCHOR =
    "https://www.recaptcha.net/recaptcha/enterprise/anchor?ar=1&k=6LfmcbcpAAAAAChNTbhUShzUOAMj_wY9LQIvLFX0&co=aHR0cHM6Ly9qb2ItYm9hcmRzLmdyZWVuaG91c2UuaW86NDQz&hl=en&v=w_Yb7dGGXaKesJ7BMiqFJqBG&size=invisible&anchor-ms=20000&execute-ms=30000&cb=iahyxioo8qgv"
  assert.ok(
    REAL_ANCHOR.indexOf("size=invisible") > 160,
    "precondition: the marker really does sit past the truncation point",
  )
  assert.equal(
    /[?&#]size=invisible\b/i.test(REAL_ANCHOR.slice(0, 160)),
    false,
    "this is the bug: the truncated copy cannot be classified",
  )
  assert.equal(/[?&#]size=invisible\b/i.test(REAL_ANCHOR), true)

  const scanner = src(".claude/skills/apply-job/scan-page.js")
  assert.match(
    scanner,
    /captchaFrames\s*=\s*iframeEls\.filter/,
    "the captcha classification must read the RAW elements, not the " +
      "truncated report copy — the whole failure mode of the first attempt",
  )
})

// ---------------------------------------------------------------------------
// 0.6 — identity-verification wall: a named defer kind, distinct from CAPTCHA
// and from a failed fill, and explicitly NOT a malfunction.
// ---------------------------------------------------------------------------
// A Real Talent / CLEAR selfie or liveness check (or an equivalent
// identity-verification challenge) is the board working as designed — proof
// of a human, the same job a CAPTCHA does — not the pipeline breaking. A
// future circuit breaker that cannot tell "the board demanded a selfie" from
// "the run is unhealthy" halts on runs that were fine; that conflation is the
// stated incident behind this item. Detected here from `scan.iframes` and
// `scan.signals`, both already returned unconditionally by scan-page.js — see
// its `iframes: iframes.length ? iframes : undefined` line, unchanged by this
// fix. Nothing in scan-page.js (w2-engine's file) was touched.
test("0.6 HANDLED [w3-resolution]: an identity-verification iframe (Persona/Onfido/CLEAR-style) refuses the page as its own named defer kind", () => {
  const scan = {
    url: "https://job-boards.greenhouse.io/x/jobs/1",
    kind: "form",
    heading: "Apply",
    signals: [],
    iframes: [
      {
        src: "https://withpersona.com/verify?tid=abc",
        title: "Identity verification",
      },
    ],
    fields: [
      { k: "f1", sel: "#e", n: "email", t: "text", l: "Email", req: true },
    ],
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
  assert.match(plan.defer[0].why, /identity-verification/i)
  // Distinct from every OTHER page-shape and field-shape defer kind — a
  // circuit breaker (or pending-questions.mjs) that cannot tell this apart
  // from those is exactly the failure mode this item exists to prevent.
  assert.notEqual(plan.defer[0].why, "consent")
  assert.notEqual(plan.defer[0].why, "confirm-widget")
  assert.notEqual(plan.defer[0].why, "confirm")
  assert.doesNotMatch(plan.defer[0].why, /captcha/i)
  assert.doesNotMatch(plan.defer[0].why, /login wall/i)
  assert.doesNotMatch(plan.defer[0].why, /confirmation/i)
  // The load-bearing phrase: this is the board working as designed, not proof
  // the machine malfunctioned.
  assert.match(plan.defer[0].why, /not a malfunction/i)
  assert.equal(readiness(plan).ready, false)
  assert.equal(submitReadiness(plan).ready, false)
})

test("0.6 HANDLED [w3-resolution]: the same wall detected from scan.signals text, not only from an iframe", () => {
  const scan = {
    url: "https://job-boards.greenhouse.io/x/jobs/1",
    kind: "form",
    heading: "Apply",
    signals: ["liveness check required before you can continue"],
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
  assert.deepEqual(plan.items, [])
  assert.equal(plan.defer.length, 1)
  assert.match(plan.defer[0].why, /identity-verification/i)
})

test("0.6 HANDLED [w3-resolution]: an unrelated iframe (an embedded ATS, not an identity check) does not trip the identity-verification defer", () => {
  // The control. Without it, a test that merely checks "the presence of ANY
  // iframe blocks the page" would pass for the wrong reason — the embedded-ATS
  // iframe case is already handled separately (scan-page.js's `embedded`
  // signal) and must not collide with this one.
  const scan = {
    url: "https://job-boards.greenhouse.io/x/jobs/1",
    kind: "form",
    heading: "Apply",
    signals: [],
    iframes: [{ src: "https://boards.greenhouse.io/embed/job_app", title: "" }],
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
    plan.items.map((i) => i.k),
    ["f1"],
    "an embedded-ATS iframe alone is not an identity-verification wall",
  )
  assert.deepEqual(plan.defer, [])
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

// E8 CLOSED 2026-07-31, both halves: w2-engine made the scanner report the
// section heading a field sits under, and w3-resolution made buildPlan match on
// it BEFORE falling back to document order.
//
// REWRITTEN 2026-07-31 (qa-breaker). The previous version of this test asserted
// the fallback by regex-matching a COMMENT in fill-plan.mjs
// (/fall back to document\s*\n?\s*\/\/ order/). w3-resolution improved the
// comment while improving the behaviour, and the test went red on the string
// rather than on the code — the exact failure mode the protocol calls "a test
// that passes because it asserts nothing meaningful". A source grep cannot tell
// a live branch from a commented-out one; every assertion below runs buildPlan.
const uploadsOf = (scan) => {
  const resolved = resolveFields(scan.fields, {
    profile: path.join(ROOT, "tests", "fixtures", "profile.yaml"),
    answers: path.join(ROOT, "tests", "fixtures", "answers.yaml"),
  })
  const plan = buildPlan({
    scan,
    resolved,
    adapter: greenhouse,
    url: scan.url,
    files: { resume: "/x/resume.pdf", cover: "/x/cover.pdf" },
  })
  return plan.items
    .filter((i) => i.how === "upload")
    .map((i) => ({ k: i.k, doc: i.label, path: i.paths[0], m: i.labelMatch }))
}

// Swapping the DOM order of two identically-labelled inputs, or swapping their
// sections, is the only way to tell "read the heading" apart from "count from
// the top" — with a resume-first board they agree on every field.
const swapFileSections = (scan) => {
  const out = structuredClone(scan)
  for (const f of out.fields) {
    if (f.t === "file")
      f.section = f.section === "Resume" ? "Cover Letter" : "Resume"
  }
  return out
}
const reverseFileOrder = (scan) => {
  const out = structuredClone(scan)
  const idx = out.fields
    .map((f, i) => (f.t === "file" ? i : -1))
    .filter((i) => i >= 0)
  const [a, b] = idx
  ;[out.fields[a], out.fields[b]] = [out.fields[b], out.fields[a]]
  return out
}

test("E8 HANDLED [w3-resolution]: two inputs both labelled 'Attach' are told apart by their SECTION, and the plan uploads each file into the right slot", () => {
  const scan = readScan("greenhouse-step1.scan.json")
  const files = scan.fields.filter((f) => f.t === "file")
  assert.equal(files.length, 2)
  assert.deepEqual(
    files.map((f) => f.l),
    ["Attach", "Attach"],
    "the fixture must keep both labels identical, or the label branch " +
      "answers this before the section branch is ever reached and the test " +
      "measures nothing",
  )
  assert.deepEqual(
    files.map((f) => f.section),
    ["Resume", "Cover Letter"],
    "and it must keep the two headings distinct",
  )

  // The ordinary, resume-first board. Both signals agree here, so this alone
  // proves nothing about WHICH one decided — it is the baseline the two
  // disagreement cases below are measured against.
  assert.deepEqual(uploadsOf(scan), [
    { k: "f6", doc: "resume", path: "/x/resume.pdf", m: "resume|\\bcv\\b" },
    { k: "f7", doc: "cover", path: "/x/cover.pdf", m: "cover letter" },
  ])
})

test("E8 HANDLED [w3-resolution]: a board that renders COVER LETTER FIRST still gets the résumé into the résumé slot", () => {
  // THE PROPERTY THIS FILE EXISTS FOR. fileOrder assumes resume-first; a board
  // that does not silently uploaded the résumé as the cover letter, with no
  // signal anywhere. Here the DOM order is reversed and the headings stay
  // truthful, so position and section disagree — position alone misassigns.
  const scan = reverseFileOrder(readScan("greenhouse-step1.scan.json"))
  const got = uploadsOf(scan)
  assert.deepEqual(
    got.map((u) => u.k),
    ["f7", "f6"],
    "precondition: the cover-letter input is now first in the DOM",
  )
  assert.deepEqual(got, [
    { k: "f7", doc: "cover", path: "/x/cover.pdf", m: "cover letter" },
    { k: "f6", doc: "resume", path: "/x/resume.pdf", m: "resume|\\bcv\\b" },
  ])
  // labelMatch is not decoration: it is the text the ENGINE re-finds the input
  // by after the first upload remounts the form and kills every stamp. A plan
  // with the right path and the wrong labelMatch uploads to the wrong input.
  assert.equal(got[0].m, "cover letter")
})

test("E8 HANDLED [w3-resolution]: when section and position disagree, SECTION decides", () => {
  // The same disagreement from the other direction — DOM order untouched, the
  // headings swapped. If position still won, f6 would take the résumé.
  const scan = swapFileSections(readScan("greenhouse-step1.scan.json"))
  assert.deepEqual(uploadsOf(scan), [
    { k: "f6", doc: "cover", path: "/x/cover.pdf", m: "cover letter" },
    { k: "f7", doc: "resume", path: "/x/resume.pdf", m: "resume|\\bcv\\b" },
  ])
})

test("E8 HANDLED [w3-resolution]: with NO section the order fallback still works — and that fallback is the residual limit", () => {
  // The fallback must not have been deleted by the section branch: an ATS that
  // renders no headings at all is the common case, and document order is right
  // for every board this adapter has been seen on.
  const bare = readScan("greenhouse-step1.scan.json")
  for (const f of bare.fields) delete f.section
  assert.deepEqual(uploadsOf(bare), [
    { k: "f6", doc: "resume", path: "/x/resume.pdf", m: "resume|\\bcv\\b" },
    { k: "f7", doc: "cover", path: "/x/cover.pdf", m: "cover letter" },
  ])

  // THE RESIDUAL, pinned so nobody reads E8 as fully closed: cover-letter-first
  // AND no headings is still misassigned, and cannot be fixed from this scan —
  // there is no signal left to read. Not a defect of w2 or w3; a limit of the
  // page. It is why the section branch above is load-bearing rather than an
  // optimisation.
  const worst = reverseFileOrder(bare)
  const got = uploadsOf(worst)
  assert.equal(
    got[0].path,
    "/x/resume.pdf",
    "the résumé goes into the FIRST input, which here is the cover-letter one",
  )
  assert.equal(got[0].k, "f7", "and f7 is the cover-letter input")
})

test("E8 HANDLED [w2-engine]: the scan fixture carries the sections the scanner is proven to emit", () => {
  // NOT A GREP, and it was nearly one. The first draft of this test matched
  // /f\.section = s/ in scan-page.js and declared the runtime behaviour "a gap
  // needing a Playwright leg". That was wrong: tests/apply/scan-page.test.mjs
  // already runs the REAL scanner text against a hand-built DOM, and sectionOf()
  // only needs querySelectorAll, contains() and compareDocumentPosition — all of
  // which that harness has. Six behavioural cases now live there ("section: ..."),
  // including the two-identical-"Attach"-inputs shape, the fieldset legend that
  // must NOT leak onto the control after it, and a no-headings negative control.
  //
  // What is left here is the FIXTURE contract, which is a different claim: this
  // file's four buildPlan tests consume greenhouse-step1.scan.json, so that
  // hand-written artifact must keep carrying what the scanner is proven to emit.
  // Nothing else joins the two — a fixture that drifted would make the planner
  // tests pass over a shape no scanner produces.
  const scan = readScan("greenhouse-step1.scan.json")
  const sections = scan.fields.filter((f) => f.section).map((f) => f.section)
  assert.deepEqual(sections, ["Resume", "Cover Letter"])
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
      id: "CSS LAYOUT under the scanner's visibility rules",
      why:
        "NARROWED 2026-07-31 (qa-breaker) — this entry used to read 'labelOf() " +
        "tier selection ... the scan fixtures assert what the scanner SHOULD " +
        "produce, not that it does', and that was already false when written: " +
        "tests/apply/scan-page.test.mjs runs the scanner's REAL text against a " +
        "hand-built DOM and pins arialabel / fieldset legend / near / section " +
        "selection by name. What that harness cannot supply is LAYOUT — " +
        "getBoundingClientRect, inherited getComputedStyle and elementFromPoint " +
        "are stubs, so every visibility-driven refusal rests on the stub's " +
        "fidelity rather than on a rendering engine.",
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
