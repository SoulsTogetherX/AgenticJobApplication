// Tests for the benchmark harness itself.
//
// A harness nobody has tested is an opinion generator. The things that must be
// true for its numbers to mean anything:
//
//   1. The accounted sleep really is the sleep. The harness records
//      waitForTimeout arguments instead of sleeping them, so the one thing
//      that could invalidate every number is a mismatch between the two —
//      asserted directly by running the same plan both ways and comparing.
//   2. The derived columns are computed from THIS run's facts, not hardcoded.
//      A protocolCost() that returned 4 no matter what would look right on the
//      day it was written and never move again.
//   3. The twin-drift detector actually detects drift. This is the harness's
//      one regression guard against the exact miss that already happened once
//      (the sleep removal landed on scan-engine.mjs while scan.driver.mjs, the
//      twin that runs, kept all three flat sleeps).
//   4. It never points at anything but loopback.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import fillPage from "../../scripts/apply/fill-engine.mjs"
import {
  BROWSER_CLOSES,
  COVER_LETTER,
  GATE_MATRIX,
  GATE_SHAPES,
  MEASURED_FILES,
  PROFILES,
  PROTOCOL,
  benchBrowser,
  benchPlan,
  benchServe,
  benchVerbCosts,
  clockedPage,
  fixtureScanPath,
  gateBreakdown,
  instrumentedPage,
  ledgerEntry,
  loadScanDriver,
  protocolCost,
  provenance,
  stats,
  summarize,
  syntheticScan,
  unmeasuredList,
  writeBenchAnswers,
} from "../../scripts/dev/bench-apply.mjs"
import { start } from "../fixtures/boards/server.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

const tmp = (tag) =>
  fs.mkdtempSync(path.join(os.tmpdir(), "bench-" + tag + "-"))

// --- 1. the accounting is the sleep ---------------------------------------

test("accounted sleep equals real sleep for the same plan", async () => {
  const items = [
    { k: "c1", how: "combo", sel: "#c1", value: "Option 1", label: "D1" },
  ]
  const elements = () => ({
    "#c1": { kind: "combo", value: "" },
    "[class*='__option'], [role='option']": { kind: "input", value: "" },
  })

  const accounted = instrumentedPage({
    elements: elements(),
    ...PROFILES.best,
  })
  await fillPage(accounted.page, { items })

  const slept = instrumentedPage({
    elements: elements(),
    ...PROFILES.best,
    realSleep: true,
  })
  const t0 = performance.now()
  await fillPage(slept.page, { items })
  const wall = performance.now() - t0

  const budget =
    accounted.cost.sleep_unconditional_ms + accounted.cost.sleep_typing_ms
  assert.ok(budget > 0, "the case must actually cost sleep to be a test")
  assert.equal(
    slept.cost.sleep_unconditional_ms,
    accounted.cost.sleep_unconditional_ms,
    "the two modes must account identically",
  )
  // setTimeout only guarantees "not before", so the wall clock is a lower
  // bound with slack above it, never below.
  assert.ok(
    wall >= budget * 0.9,
    `real sleep ${Math.round(wall)}ms should be at least the accounted ${budget}ms`,
  )
  assert.ok(
    wall < budget + 4000,
    `real sleep ${Math.round(wall)}ms wildly exceeds the accounted ${budget}ms`,
  )
})

test("the accounted total is the sum of the arguments the engine passed", async () => {
  const rig = instrumentedPage({
    elements: { "#f1": { kind: "input", value: "" } },
    ...PROFILES.best,
  })
  await fillPage(rig.page, {
    items: [{ k: "f1", how: "fill", sel: "#f1", value: "Ada" }],
  })
  const fromCalls = rig.cost.calls
    .filter((c) => c[0] === "waitForTimeout")
    .reduce((a, c) => a + c[1], 0)
  assert.equal(fromCalls, rig.cost.sleep_unconditional_ms)
  // A bare fill costs exactly the one post-fill blur-and-settle.
  assert.equal(rig.cost.sleep_unconditional_ms, 450)
})

// --- 2. the derived columns are computed, not hardcoded -------------------

test("protocolCost moves with the run's own facts", () => {
  const cold = protocolCost({
    page: 1,
    ready: false,
    unknownDefers: 3,
    needsRender: true,
    hasNext: true,
  })
  const warm = protocolCost({
    page: 2,
    ready: true,
    unknownDefers: 0,
    needsRender: false,
    hasNext: false,
  })
  assert.ok(
    cold.model_turns > warm.model_turns,
    "a form needing decisions must cost more turns than a ready one",
  )
  assert.equal(
    warm.round_trips,
    3,
    "page 2 of a ready single-page form: scan, scan-to-disk, fill",
  )
  assert.equal(
    protocolCost({
      page: 1,
      ready: true,
      unknownDefers: 0,
      needsRender: false,
      hasNext: true,
    }).round_trips,
    5,
    "page 1 of a multi-page form: navigate, scan, scan-to-disk, fill, advance",
  )
  assert.equal(
    protocolCost({
      page: 2,
      ready: true,
      unknownDefers: 0,
      needsRender: false,
      hasNext: true,
    }).round_trips,
    4,
    "the plan's '4 round trips' is the steady state, not page 1",
  )
})

test("every PROTOCOL step cites the line that prescribes it", () => {
  assert.ok(PROTOCOL.length >= 10)
  for (const s of PROTOCOL) {
    assert.match(
      s.cite,
      /SKILL\.md:\d+|scan-engine\.mjs:\d+|scan\.driver\.mjs:\d+/,
      `step ${s.id} must cite a file and line, not assert a number`,
    )
    assert.equal(typeof s.when, "function")
  }
})

// --- 3. the twin-drift detector detects drift -----------------------------

test("the two scan twins are measured under identical conditions", async () => {
  const scan = syntheticScan("combo23", "http://127.0.0.1:1/x").scan
  const mk = () =>
    instrumentedPage({ scan, menuOptions: 5, ...PROFILES.typical })
  const scanPage = (await import("../../scripts/apply/scan-engine.mjs")).default

  const a = mk()
  await scanPage(a.page)
  const b = mk()
  await loadScanDriver()(b.page)

  assert.equal(
    a.cost.sleep_unconditional_ms,
    b.cost.sleep_unconditional_ms,
    "scan-engine.mjs and scan.driver.mjs must cost the same unconditional " +
      "sleep — they drifted once already and the driver is the one that runs",
  )
  assert.equal(
    a.cost.sleep_conditional_ceiling_ms,
    b.cost.sleep_conditional_ceiling_ms,
    "the two twins must cap their conditional waits identically",
  )
})

test("a driver with a flat sleep is caught by the drift detector", async () => {
  // The canary for the detector: hand it a driver that reintroduces the
  // removed sleeps and confirm the numbers separate. If this passes silently,
  // the twin comparison above proves nothing.
  const scan = syntheticScan("combo23", "http://127.0.0.1:1/x").scan
  const rig = instrumentedPage({ scan, ...PROFILES.typical })
  const regressed = async (page) => {
    await page.waitForTimeout(1500)
    const s = await page.evaluate(() => window.__ajScan(false))
    for (const f of (s.fields || []).slice(0, 18)) {
      await page.locator('[data-aj="' + f.k + '"]').click()
      await page.waitForTimeout(300)
      await page.waitForTimeout(80)
    }
    return s
  }
  await regressed(rig.page)
  assert.equal(
    rig.cost.sleep_unconditional_ms,
    1500 + 18 * 380,
    "the harness must report a reintroduced flat sleep, not smooth it over",
  )
})

// --- 4. loopback only ------------------------------------------------------

test("the bench only ever fetches the loopback fixture board", async () => {
  const board = await start()
  try {
    const served = await benchServe(board, "greenhouse")
    assert.match(served.url, /^http:\/\/127\.0\.0\.1:\d+\//)
    assert.equal(served.status, 200)
    assert.equal(
      served.fixture_header,
      "local-fake-ats",
      "every byte this bench measures must come from the fake ATS",
    )
    assert.ok(served.bytes > 0)
  } finally {
    await board.stop()
  }
})

test("the harness source names no remote host", () => {
  const src = fs.readFileSync(
    path.join(ROOT, "scripts", "dev", "bench-apply.mjs"),
    "utf8",
  )
  // Method: every http(s) URL literal in the file, checked for a non-loopback
  // host. Comments count — a copy-pasted real board URL is a hazard even in a
  // comment, because the next person runs it.
  const urls = src.match(/https?:\/\/[^\s"'`)]+/g) ?? []
  const remote = urls.filter(
    (u) => !/^https?:\/\/(127\.0\.0\.1|localhost)/.test(u),
  )
  assert.deepEqual(
    remote,
    [],
    `non-loopback URL literal(s): ${remote.join(", ")}`,
  )
})

// --- the whole pipeline, end to end ---------------------------------------

test("plan leg runs the real fill-plan.mjs and reports its own numbers", async () => {
  const board = await start()
  const dir = tmp("plan")
  try {
    const url = board.pageUrl("greenhouse")
    const { scan, answers } = syntheticScan("combo14", url)
    const answersFile = writeBenchAnswers(dir, answers)
    const r = benchPlan({ scan, url, jobsDir: dir, answersFile })
    assert.equal(r.ready, true, "14 answerable combos should plan clean")
    assert.equal(r.items, 14)
    assert.equal(r.defers, 0)
    assert.ok(r.ms > 0)
    assert.ok(fs.existsSync(r.planFile), "the bootstrap must be written")
    assert.equal(r.plan.ats, "greenhouse", "the fixture URL selects greenhouse")
  } finally {
    await board.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("the fill leg runs the GENERATED bootstrap, not the imported module", async () => {
  const board = await start()
  const dir = tmp("fill")
  try {
    const url = board.pageUrl("greenhouse")
    const { scan, answers } = syntheticScan("combo14", url)
    const answersFile = writeBenchAnswers(dir, answers)
    const planned = benchPlan({ scan, url, jobsDir: dir, answersFile })
    const src = fs.readFileSync(planned.planFile, "utf8")
    assert.match(
      src,
      /^async \(page\) => \{/m,
      "the bootstrap must stay a bare async function expression — that is " +
        "what browser_run_code_unsafe evals",
    )
    const { benchFill } = await import("../../scripts/dev/bench-apply.mjs")
    const filled = await benchFill({
      planFile: planned.planFile,
      plan: planned.plan,
      url,
      behaviour: PROFILES.best,
    })
    assert.equal(filled.report.failed, 0)
    assert.equal(filled.report.ok, 14)
  } finally {
    await board.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// --- honesty of the report -------------------------------------------------

test("every reported column carries a method, and unmeasured stays null", async () => {
  const board = await start()
  const dir = tmp("sum")
  try {
    const { runOnce } = await import("../../scripts/dev/bench-apply.mjs")
    const samples = []
    for (let i = 0; i < 2; i++) {
      samples.push(
        await runOnce({
          boardName: "greenhouse",
          shape: "combo14",
          profileName: "typical",
          board,
          jobsDir: dir,
        }),
      )
    }
    const sum = summarize(samples)
    for (const [name, col] of Object.entries(sum.columns)) {
      assert.ok(
        ["measured", "derived"].includes(col.method),
        `column ${name} must declare how it was produced`,
      )
      assert.equal(typeof col.value, "number")
    }
    assert.equal(
      sum.columns.sleep_ms.conditional_actual_ms,
      null,
      "what a conditional wait actually costs needs a browser — it must be " +
        "null, never an estimate",
    )
    assert.equal(sum.columns.sleep_ms.conditional_actual_method, "unmeasured")
    assert.ok(sum.unmeasured.length >= 5)
    for (const u of sum.unmeasured) {
      assert.ok(u.what && u.why, "each gap must say what and why")
    }
  } finally {
    await board.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("the accounted columns are deterministic across samples", async () => {
  const board = await start()
  const dir = tmp("det")
  try {
    const { runOnce } = await import("../../scripts/dev/bench-apply.mjs")
    const runs = []
    for (let i = 0; i < 3; i++) {
      runs.push(
        await runOnce({
          boardName: "greenhouse",
          shape: "combo14",
          profileName: "worst",
          board,
          jobsDir: dir,
        }),
      )
    }
    const sleeps = new Set(runs.map((r) => r.sleep.unconditional_ms))
    assert.equal(
      sleeps.size,
      1,
      "an accounted column must not vary between samples; if it does, the " +
        "harness is measuring the machine instead of the code",
    )
    // ...and the wall clock, which IS a clock reading, is allowed to.
    assert.equal(stats(runs.map((r) => r.wall_ms)).n, 3)
  } finally {
    await board.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("provenance pins the bytes measured, not just the sha", async () => {
  const p = await provenance()
  assert.match(p.sha, /^[0-9a-f]{7,}$|^unknown$/)
  for (const f of MEASURED_FILES) {
    assert.ok(p.file_sha1[f], `no content hash for ${f}`)
    assert.notEqual(
      p.file_sha1[f],
      "MISSING",
      `${f} is measured by this harness but does not exist`,
    )
  }
  assert.ok(Array.isArray(p.dirty_measured_files))
})

test("the ledger entry names the command and the method", async () => {
  const board = await start()
  const dir = tmp("ledger")
  try {
    const { runOnce } = await import("../../scripts/dev/bench-apply.mjs")
    const sum = summarize([
      await runOnce({
        boardName: "greenhouse",
        shape: "combo14",
        profileName: "typical",
        board,
        jobsDir: dir,
      }),
    ])
    const prov = await provenance()
    const entry = ledgerEntry(sum, prov)
    assert.match(entry, /- harness: {2}node scripts\/dev\/bench-apply\.mjs/)
    assert.match(entry, /round_trips=\d+ sleep_ms=\d+ model_turns=\d+/)
    assert.match(entry, /unmeasured \(no browser leg in this run\)/)
    assert.equal(
      /- browser:/.test(entry),
      false,
      "a run with no browser leg must not print a browser line at all",
    )

    // THE METHOD LINE MUST TRACK THE RUN, not the day the string was written.
    // Before --browser was wired it read "unmeasured (no browser)" whatever
    // happened, so the first real browser run would have pasted a false
    // method into docs/measurements.md. Feeding it a browser result here is
    // the regression guard for that, and it needs no browser to run.
    const withBrowser = ledgerEntry(sum, prov, {
      ran: true,
      closes: ["cdp_latency", "conditional_wait_actual"],
      still_unmeasured: ["react_select_behaviour"],
      legs: {
        scan: {
          ms: 400,
          conditional_actual_ms: 88,
          conditional_ceiling_ms: 380,
        },
        cdp_round_trip: { median: 1.05, n: 20 },
      },
    })
    assert.match(
      withBrowser,
      /conditional-wait actuals MEASURED in real Chromium/,
    )
    assert.match(
      withBrowser,
      /- browser: {2}scan 400ms wall, conditional 88ms of a 380ms ceiling/,
    )
    assert.match(withBrowser, /STILL OPEN \[react_select_behaviour\]/)
    assert.match(withBrowser, /--runs \d+ --browser/)

    // And a browser leg that FAILED must say so rather than vanish, or the
    // ledger reads as though the numbers were taken and were merely absent.
    const failed = ledgerEntry(sum, prov, {
      ran: false,
      closes: [],
      error: "no usable Chromium",
    })
    assert.match(failed, /- browser: {2}DID NOT RUN — no usable Chromium/)
    assert.match(failed, /unmeasured \(no browser leg in this run\)/)
  } finally {
    await board.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// --- the per-verb ceilings -------------------------------------------------

test("per-verb costs expose the richtext ceiling the pipeline cannot reach", async () => {
  const worst = await benchVerbCosts({ behaviour: PROFILES.worst })
  const rich = worst.find((v) => v.verb.startsWith("type"))
  assert.ok(rich)
  // TYPE_MAX caps keyboard.type at 800 chars; 800 * 15ms.
  assert.equal(rich.typing_ms, 12000)
  assert.equal(rich.typed_chars, 800)
  assert.equal(
    rich.failed,
    1,
    "truncating a cover letter must be reported as a failure, not shipped",
  )
  assert.ok(COVER_LETTER.length >= 3000)

  const best = await benchVerbCosts({ behaviour: PROFILES.best })
  const richBest = best.find((v) => v.verb.startsWith("type"))
  assert.equal(
    richBest.typing_ms,
    0,
    "when loc.fill() lands, the richtext verb costs no typing at all",
  )
})

test("unmeasuredList names the browser-only quantities", () => {
  const ids = unmeasuredList().map((u) => u.id)
  for (const id of [
    "conditional_wait_actual",
    "cdp_latency",
    "label_resolution",
    "react_select_behaviour",
    "csp_enforcement",
  ]) {
    assert.ok(ids.includes(id), `missing declared gap: ${id}`)
  }
})

// --- 4b. the browser leg ---------------------------------------------------
//
// WIRED 2026-07-31. Before that `--browser` printed "schema reserved, not yet
// wired" and did nothing, which is the worst state a flag can be in: present
// in the usage text, so three separate agents planned around a measurement it
// could not take.
//
// Two things are tested WITHOUT a browser, because they are the parts that can
// be wrong silently: the claim-bookkeeping (BROWSER_CLOSES vs unmeasuredList)
// and clockedPage's arithmetic. The end-to-end leg is tested with a browser and
// SKIPS with a stated reason when there is none.

test("BROWSER_CLOSES only names ids that unmeasuredList actually declares", () => {
  // A typo here would report an entry as closed that no reader can find, or
  // silently leave a real gap open. Checked in both directions.
  const ids = new Set(unmeasuredList().map((u) => u.id))
  for (const id of BROWSER_CLOSES) {
    assert.ok(
      ids.has(id),
      `--browser claims to close an id nobody declares: ${id}`,
    )
  }
  assert.equal(
    BROWSER_CLOSES.includes("react_select_behaviour"),
    false,
    "the fixture's combos are the fixture's, not a real react-select; " +
      "claiming that one is closed would be exactly the estimate this " +
      "harness refuses to print",
  )
})

test("clockedPage separates a flat sleep from a conditional wait, and forwards to the real page", async () => {
  // A recorder, not a double: the underlying calls must still happen, or the
  // 'measured' numbers are of nothing. `hits` proves the forwarding.
  const hits = []
  const fake = {
    async waitForTimeout(ms) {
      hits.push(["sleep", ms])
      await new Promise((r) => setTimeout(r, ms))
    },
    async waitForLoadState(s) {
      hits.push(["loadstate", s])
      await new Promise((r) => setTimeout(r, 20))
    },
    locator(sel) {
      hits.push(["locator", sel])
      return {
        async waitFor(o) {
          hits.push(["waitFor", sel, o.state, o.timeout])
          await new Promise((r) => setTimeout(r, 15))
        },
        first() {
          return this
        },
      }
    },
    url: () => "http://127.0.0.1/x",
  }
  const { page, cost } = clockedPage(fake)
  await page.waitForTimeout(30)
  await page.waitForLoadState("load")
  await page
    .locator("button")
    .first()
    .waitFor({ state: "attached", timeout: 1500 })

  assert.deepEqual(hits, [
    ["sleep", 30],
    ["loadstate", "load"],
    ["locator", "button"],
    ["waitFor", "button", "attached", 1500],
  ])
  // The two buckets must not bleed into each other — collapsing them is the
  // exact mistake that let ~24s of waitForTimeout be described as network time.
  assert.ok(cost.slept_ms >= 25, `flat sleep not recorded: ${cost.slept_ms}`)
  assert.equal(cost.conditional_calls, 2)
  assert.ok(
    cost.conditional_ms >= 25,
    `conditional not clocked: ${cost.conditional_ms}`,
  )
  // The ceiling is what the source could already tell you; the actual is the
  // number this leg exists to add. Reporting only the sum would hide it.
  assert.equal(cost.conditional_ceiling_ms, 1500)
  assert.ok(
    cost.conditional_ms < cost.conditional_ceiling_ms,
    "a wait that fires early must cost less than its ceiling, or the two " +
      "columns are measuring the same thing",
  )
  assert.deepEqual(
    cost.waits.map((w) => w.label),
    ["waitForLoadState:load", "locator.waitFor:attached"],
  )
})

test("benchBrowser measures against real Chromium, or says why it did not", async (t) => {
  const board = await start()
  try {
    const run = await benchBrowser({ board, boardName: "greenhouse" })
    if (!run.ran) return t.skip("no usable Chromium: " + run.error)

    // It only ever points at loopback. Asserted on the URL it actually used,
    // not on the source.
    assert.match(run.url, /^http:\/\/127\.0\.0\.1:\d+\//)

    assert.equal(run.legs.nav.status, 200)
    assert.ok(
      run.legs.cdp_round_trip.n >= 5,
      "a rate needs more than one sample",
    )
    assert.ok(run.legs.cdp_round_trip.median > 0)

    // The number the accounted harness could never take.
    const s = run.legs.scan
    assert.equal(s.error, undefined, "the scan leg must actually run")
    assert.ok(s.fields > 0, "a scan that found no fields measured nothing")
    assert.ok(
      s.conditional_actual_ms < s.conditional_ceiling_ms,
      `actual ${s.conditional_actual_ms}ms should be under the ` +
        `${s.conditional_ceiling_ms}ms ceiling on a page that hydrates fast`,
    )

    // The fixture is only a valid stand-in for the live DOM while it agrees
    // with it. This is the drift detector, and it found its own join bug
    // before it found anything else — see the joinKey comment in the harness.
    assert.equal(
      run.legs.label_resolution.agree,
      true,
      "greenhouse-step1.scan.json has drifted from greenhouse-step1.html: " +
        JSON.stringify(run.legs.label_resolution.mismatches),
    )

    // The CSP gotcha, executed rather than asserted from a served header.
    assert.equal(run.legs.csp.add_script_tag_blocked, true)
    assert.equal(run.legs.csp.page_evaluate_works, true)

    for (const id of BROWSER_CLOSES) {
      assert.ok(run.closes.includes(id), `leg did not close ${id}`)
    }
    assert.deepEqual(run.still_unmeasured, [])
  } finally {
    await board.stop()
  }
})

// --- 5. the gate shapes: the harness can make each gate fire ---------------
//
// Why these exist: until 2026-07-31 the harness could not produce a `CONFIRM`
// OR a `confirm-widget` defer on any input, so the latency cost of both
// plan-side gates was unmeasured and "it costs about nothing" had nothing
// behind it. These are the standing guard against that quietly returning — a
// shape that stops making its gate fire reports a SMALLER number, which is the
// direction nobody notices.

test("a bench answer id can reach the classifier at all", () => {
  // THE DEFECT THAT HID THE GATE. resolveFields() only runs answerClass() on a
  // row whose source matches fill-plan.mjs's BANK_ID_RE = /^(a-\d+)@/. The
  // bench used to write `bench-001`, so every bench answer resolved OK
  // whatever it said and a CONFIRM was structurally unreachable — the gate
  // read as free because it never ran once.
  const dir = tmp("ids")
  const file = writeBenchAnswers(dir, [
    { question: "Q one", answer: "A one" },
    { question: "Q two", answer: "A two" },
  ])
  const text = fs.readFileSync(file, "utf8")
  const ids = [...text.matchAll(/^\s*- id:\s*(\S+)/gm)].map((m) => m[1])
  assert.equal(ids.length, 3, "one base answer plus the two extras")
  for (const id of ids) {
    assert.match(
      id,
      /^a-\d+$/,
      `bench answer id ${id} can never match fill-plan.mjs's BANK_ID_RE, so ` +
        `the datum/assertion classifier will never run on it`,
    )
  }
  assert.equal(new Set(ids).size, ids.length, "ids must be unique")
  fs.rmSync(dir, { recursive: true, force: true })
})

test("every gate shape builds, and each differs from gate-base by exactly one field", () => {
  const url = "http://127.0.0.1/x"
  const base = syntheticScan("gate-base", url).scan
  assert.equal(base.fields.length, 3)
  for (const kind of GATE_SHAPES) {
    const { scan, answers } = syntheticScan(kind, url)
    assert.equal(scan.url, url)
    assert.ok(scan.btns.length > 0, `${kind} must have a submit button`)
    assert.equal(
      scan.fields.length,
      kind === "gate-base" ? 3 : 4,
      `${kind} must differ from gate-base by exactly one field, or its delta ` +
        `cannot be attributed to the gate`,
    )
    // The first three fields are identical across every shape.
    assert.deepEqual(scan.fields.slice(0, 3), base.fields)
    if (kind !== "gate-base") {
      assert.ok(answers.length <= 1, `${kind} adds at most one stored answer`)
    }
  }
})

test("the gate shapes each make their OWN gate fire, and no other", async (t) => {
  // The point of the whole harness change, asserted end to end through the
  // real fill-plan.mjs subprocess. Every expectation here is the CLAIM the
  // measurement rests on; if the planner's policy moves, this goes red and the
  // number in the report has to be re-taken rather than re-quoted.
  const board = await start()
  const jobsDir = tmp("gate")
  t.after(async () => {
    await board.stop()
    fs.rmSync(jobsDir, { recursive: true, force: true })
  })
  const url = board.pageUrl("greenhouse")

  const expected = {
    "gate-base": { confirm: 0, widget: 0, req: 0, ready: true },
    "gate-select": { confirm: 0, widget: 0, req: 0, ready: true },
    "gate-radio-opt": { confirm: 0, widget: 1, req: 0, ready: true },
    "gate-radio-req": { confirm: 0, widget: 1, req: 1, ready: false },
    "gate-confirm": { confirm: 1, widget: 0, req: 0, ready: false },
  }
  for (const kind of GATE_SHAPES) {
    const synth = syntheticScan(kind, url)
    const answersFile = writeBenchAnswers(jobsDir, synth.answers)
    const leg = benchPlan({
      scan: synth.scan,
      url,
      jobsDir,
      slug: "gate-" + kind,
      answersFile,
    })
    const e = expected[kind]
    assert.equal(
      leg.gate.confirm,
      e.confirm,
      `${kind}: confirm defers — got ${JSON.stringify(leg.gate.why)}`,
    )
    assert.equal(
      leg.gate.confirm_widget,
      e.widget,
      `${kind}: confirm-widget defers — got ${JSON.stringify(leg.gate.why)}`,
    )
    assert.equal(leg.gate.confirm_widget_required, e.req, `${kind}: required`)
    assert.equal(
      leg.ready,
      e.ready,
      `${kind}: ready — reason ${leg.reason ?? "(none)"}`,
    )
    // Nothing else may defer, or the delta measures that instead of the gate.
    assert.equal(
      leg.gate.other,
      0,
      `${kind}: an unrelated defer contaminates the measurement: ${JSON.stringify(leg.gate.why)}`,
    )
  }
})

test("gateBreakdown counts `confirm` and `confirm-widget` as DISTINCT markers", () => {
  // A prefix match here would report the two gates as one, which is the same
  // conflation that once re-marked an unreviewed work-authorisation page as
  // ready (see readiness()'s own comment). The harness must not be able to
  // launder that into a single number.
  const g = gateBreakdown({
    defer: [
      { k: "a", why: "confirm" },
      { k: "b", why: "confirm-widget", req: true },
      { k: "c", why: "confirm-widget" },
      { k: "d", why: "consent" },
      { k: "e", why: "unknown" },
    ],
  })
  assert.equal(g.confirm, 1, "a prefix match would say 3 here")
  assert.equal(g.confirm_widget, 2)
  assert.equal(g.confirm_widget_required, 1)
  assert.equal(g.consent, 1)
  assert.equal(g.other, 1)
  assert.deepEqual(g.why, [
    "a:confirm",
    "b:confirm-widget(req)",
    "c:confirm-widget",
    "d:consent",
    "e:unknown",
  ])
})

test("every GATE_MATRIX baseline names a row that exists, and no row is its own baseline", () => {
  const ids = new Set(GATE_MATRIX.map((r) => r.id))
  assert.equal(ids.size, GATE_MATRIX.length, "row ids must be unique")
  for (const r of GATE_MATRIX) {
    assert.ok(r.claim.length > 10, `${r.id} must state what it claims`)
    if (!r.baseline) continue
    assert.ok(ids.has(r.baseline), `${r.id} compares against a missing row`)
    assert.notEqual(r.baseline, r.id)
  }
})

test("fixtureScanPath refuses a page it has no fixture for, instead of measuring page 1", () => {
  const dir = path.join(ROOT, "tests", "fixtures", "boards", "scans")
  assert.match(
    fixtureScanPath("greenhouse", 1, dir),
    /greenhouse-step1\.scan\.json$/,
  )
  assert.match(
    fixtureScanPath("greenhouse", 2, dir),
    /greenhouse-step2\.scan\.json$/,
  )
  // THE FAILURE THAT MUST NOT BE SILENT: a page with no fixture used to fall
  // back to page 1, so `--page 3` would report page 1's plan under page 3's
  // round trips. Same class as the planner always reading scan-p1.json.
  assert.throws(
    () => fixtureScanPath("greenhouse", 3, dir),
    /Refusing to measure a different page/,
  )
  assert.throws(() => fixtureScanPath("nosuchboard", 1, dir), /no scan fixture/)
})

test("the instrumented page can express both probe shapes and both verify outcomes", async () => {
  // The double's two new degrees of freedom, asserted directly — a spec option
  // that silently did nothing would make the tests depending on it (E1's
  // truncation flag, E4's reconciliation) pass for the wrong reason.
  const probe = () => "__option"
  const verify = () => "requiredEmpty"

  const bare = await instrumentedPage({ menuOptions: 3 }).page.evaluate(probe)
  assert.ok(Array.isArray(bare), "no menuTotal -> the bare pre-flag array")
  assert.equal(bare.length, 3)

  const cut = await instrumentedPage({
    menuOptions: 3,
    menuTotal: 200,
  }).page.evaluate(probe)
  assert.equal(cut.total, 200, "menuTotal -> the {opts,total} shape")
  assert.equal(cut.opts.length, 3)

  const noLand = await instrumentedPage({}).page.evaluate(verify)
  assert.equal(noLand.landed, undefined, "no verifyLanded -> no landed key")
  const landed = await instrumentedPage({
    verifyLanded: ["f1"],
  }).page.evaluate(verify)
  assert.deepEqual(landed.landed, ["f1"])
})
