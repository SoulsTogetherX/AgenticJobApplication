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
  COVER_LETTER,
  MEASURED_FILES,
  PROFILES,
  PROTOCOL,
  benchPlan,
  benchServe,
  benchVerbCosts,
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
    const entry = ledgerEntry(sum, await provenance())
    assert.match(entry, /- harness: {2}node scripts\/dev\/bench-apply\.mjs/)
    assert.match(entry, /round_trips=\d+ sleep_ms=\d+ model_turns=\d+/)
    assert.match(entry, /unmeasured \(no browser\)/)
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
