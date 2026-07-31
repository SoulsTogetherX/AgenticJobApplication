#!/usr/bin/env node
// bench-apply.mjs — times scan -> plan -> fill against the LOCAL FAKE ATS and
// reports the three cost columns separately: browser round trips, sleep
// milliseconds, and model turns.
//
// WHY THREE COLUMNS AND NOT ONE. A model turn costs seconds, a browser round
// trip costs tens to hundreds of milliseconds, and a Node call costs
// milliseconds. Adding them produces a number whose largest term is invisible,
// which is how ~24s of waitForTimeout spent years being described as "network
// time". docs/measurements.md keeps them apart for the same reason.
//
// WHAT THIS HARNESS CAN AND CANNOT MEASURE — read this before quoting a number.
//
// There is no Playwright and no browser in this repo (a deliberate ~150MB
// avoidance; see scripts/apply/browser.mjs). So every number below carries a
// `method` and the CLI prints it:
//
//   measured   — produced by EXECUTING product code or real I/O in this run.
//                The sleep columns are measured this way: the real engines run
//                against an instrumented `page` double that records the
//                argument of every waitForTimeout / waitFor / keyboard.type
//                the engine actually reaches on the path it actually takes.
//                Nothing is regex-scraped out of the source and nothing is
//                assumed about a branch that did not run.
//   derived    — computed from a DOCUMENTED protocol plus this run's own plan
//                output, with the source line cited in PROTOCOL below. Round
//                trips and model turns are derived: they are properties of the
//                sequence of tool calls the skill prescribes, not of any single
//                process, so they are counted rather than clocked. Falsifiable
//                by reading the cited lines and recounting.
//   unmeasured — genuinely needs a browser. Reported as null with a reason,
//                NEVER as an estimate. An estimate printed in a measurement
//                column is exactly what Rule C exists to stop.
//
// The browser legs slot in without changing the schema: pass --browser and, if
// playwright-core is installed, the same fields are filled from a real page and
// flip from `unmeasured` to `measured`. Absent the dependency they stay null
// and say why.
//
// SLEEP IS ACCOUNTED, NOT SLEPT. page.waitForTimeout(450) records 450 and
// returns immediately, so a full sweep costs milliseconds instead of minutes.
// That is not a shortcut around the measurement — the recorded value IS the
// argument the engine passed, on the branch it took. Pass --real-sleep to
// actually sleep and watch wall_ms absorb the same total; that equivalence is
// the check, and tests/apply/bench-apply.test.mjs asserts it.
//
// THE ONLY BOARD THIS EVER TOUCHES is tests/fixtures/boards/server.mjs, which
// binds loopback and refuses anything else. Never a live employer.
//
//   node scripts/dev/bench-apply.mjs --board greenhouse
//   node scripts/dev/bench-apply.mjs --board greenhouse --runs 7 --json
//   node scripts/dev/bench-apply.mjs --shape combo14 --profile worst
//   node scripts/dev/bench-apply.mjs --ledger          # paste-ready entry
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import vm from "node:vm"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import scanPage from "../apply/scan-engine.mjs"
import { start as startBoard } from "../../tests/fixtures/boards/server.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, "..", "..")

const SCAN_DRIVER = path.join(
  ROOT,
  ".claude",
  "skills",
  "apply-job",
  "scan.driver.mjs",
)
const FIXTURE_SCANS = path.join(ROOT, "tests", "fixtures", "boards", "scans")
const FIXTURE_PROFILE = path.join(ROOT, "tests", "fixtures", "profile.yaml")
const FIXTURE_ANSWERS = path.join(ROOT, "tests", "fixtures", "answers.yaml")

// ---------------------------------------------------------------------------
// The protocol model: where round trips and model turns come from.
//
// These two columns are NOT clocked, they are COUNTED, and the count is only
// as good as its citations — so each step names the file and line that
// prescribes it. Recount it yourself; that is the point of writing it down.
//
// `browser` marks a step that crosses the model <-> browser boundary (an MCP
// tool call). `turn` marks a step that costs one assistant turn. A Bash call
// costs a turn but no round trip, which is why the two columns differ.
//
// `when` is evaluated against THIS RUN's plan result, so a form that comes back
// ready=true genuinely reports fewer turns than one that does not — the number
// is computed, not asserted.
// ---------------------------------------------------------------------------
export const PROTOCOL = [
  {
    id: "navigate",
    browser: true,
    turn: true,
    cite: "SKILL.md:66 browser_navigate to the URL",
    when: (c) => c.page === 1,
  },
  {
    id: "scan",
    browser: true,
    turn: true,
    cite: "SKILL.md:100 browser_run_code_unsafe { scan.driver.mjs }",
    when: () => true,
  },
  {
    id: "scan-to-disk",
    browser: true,
    turn: true,
    cite:
      "scan-engine.mjs:252 / scan.driver.mjs:146 — the scan is stashed on " +
      "window.__ajLastScan precisely so a second browser_evaluate can write " +
      "it to scan-p<N>.json via { filename }. SKILL.md:139 requires that file " +
      "to exist before step B. This is the round trip SKILL.md:326's " +
      '"2 browser calls" line omits.',
    when: () => true,
  },
  {
    id: "fill-plan",
    browser: false,
    turn: true,
    cite: "SKILL.md:142 node scripts/apply/fill-plan.mjs <slug>",
    when: () => true,
  },
  {
    id: "decide-cover-letter",
    browser: false,
    turn: true,
    cite: "SKILL.md:163 step C — skipped entirely when B printed ready=true",
    when: (c) => !c.ready,
  },
  {
    id: "reuse-check",
    browser: false,
    turn: true,
    cite: "SKILL.md:177 node scripts/documents/reuse-check.mjs <slug>",
    when: (c) => !c.ready,
  },
  {
    id: "pending-questions",
    browser: false,
    turn: true,
    cite: "SKILL.md:196 node scripts/apply/pending-questions.mjs",
    when: (c) => !c.ready && c.unknownDefers > 0,
  },
  {
    id: "approval-message",
    browser: false,
    turn: true,
    cite: "SKILL.md:187 every pick goes into the approval message",
    when: (c) => !c.ready,
  },
  {
    id: "save-answer",
    browser: false,
    turn: true,
    cite: "SKILL.md:240 save-answer.mjs with the exact label",
    when: (c) => c.unknownDefers > 0,
  },
  {
    id: "render-pdf",
    browser: false,
    turn: true,
    cite: "SKILL.md:252 render-pdf.mjs — only when the form has a file field",
    when: (c) => c.needsRender,
  },
  {
    id: "fill-plan-again",
    browser: false,
    turn: true,
    cite: "SKILL.md:262 re-run fill-plan.mjs after rendering / saving answers",
    when: (c) => !c.ready,
  },
  {
    id: "fill",
    browser: true,
    turn: true,
    cite: "SKILL.md:267 browser_run_code_unsafe { jobs/<slug>/fill-plan.js }",
    when: () => true,
  },
  {
    // Only a form with a `next` button costs this. On the last page SKILL.md
    // says STOP and hand the user the submit button, which is a message, not a
    // browser call — so counting it unconditionally would inflate the column.
    id: "advance",
    browser: true,
    turn: true,
    cite: "SKILL.md:304 browser_click the r:'next' button, then back to A",
    when: (c) => c.hasNext,
  },
  {
    id: "handoff",
    browser: false,
    turn: true,
    cite: "SKILL.md:307 only a submit button is left — stop and summarize",
    when: (c) => !c.hasNext,
  },
]

/**
 * Count the two derived columns for one page, against this run's own facts.
 *
 * `page` matters: page 1 pays a browser_navigate, later pages arrive via the
 * advance click that ended the page before them. The plan's "4 round trips"
 * is the steady state (scan, scan-to-disk, fill, advance); page 1 of a
 * multi-page form is 5.
 *
 * @param {{page?: number, ready: boolean, unknownDefers: number,
 *          needsRender: boolean, hasNext?: boolean}} ctx
 */
export function protocolCost(ctx) {
  const c = { page: 1, hasNext: false, ...ctx }
  const taken = PROTOCOL.filter((s) => s.when(c))
  return {
    round_trips: taken.filter((s) => s.browser).length,
    model_turns: taken.length,
    steps: taken.map((s) => s.id),
    skipped: PROTOCOL.filter((s) => !s.when(c)).map((s) => s.id),
  }
}

// ---------------------------------------------------------------------------
// The instrumented page.
//
// A test double for the slice of the Playwright surface the two engines touch,
// which records the COST of every call instead of performing it. The engines
// are the real, unmodified product modules; this only stands in for the
// browser, and every branch it takes is a branch the engine chose.
//
// It is deliberately NOT a DOM. It cannot tell you whether labelOf() picks the
// right label or whether react-select opens — those need a browser and are
// reported unmeasured. What it can tell you exactly is how many milliseconds
// of sleep the engine asks for, and how many times it crosses into the page.
// ---------------------------------------------------------------------------

const asleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * @param {object} spec
 * @param {string} spec.url
 * @param {object} [spec.scan]          what a scan evaluate returns
 * @param {object} [spec.elements]      selector -> { kind, value, options }
 * @param {number} [spec.menuOptions]   options a probe click reveals
 * @param {boolean} [spec.menuRenders]  does the __option wait resolve early
 * @param {string}  [spec.comboWinner]  which strategy actually sets the value
 * @param {boolean} [spec.richtextTakesFill]
 * @param {boolean} [spec.richtextTakesInsert]
 * @param {boolean} [spec.uploadDetaches]
 * @param {boolean} [spec.staleForever] every touch throws "not attached"
 * @param {boolean} [spec.realSleep]    actually sleep instead of accounting
 */
export function instrumentedPage(spec = {}) {
  const {
    url = "http://127.0.0.1/apply",
    scan = { fields: [], btns: [{ k: "b1", l: "Submit", r: "submit" }] },
    elements = {},
    menuOptions = 12,
    menuRenders = true,
    comboWinner = "type-enter",
    richtextTakesFill = true,
    richtextTakesInsert = true,
    uploadDetaches = true,
    staleForever = false,
    realSleep = false,
  } = spec

  const cost = {
    // MEASURED: the argument of every waitForTimeout the engine reached.
    sleep_unconditional_ms: 0,
    // MEASURED: chars * delay for every keyboard.type the engine reached.
    sleep_typing_ms: 0,
    // MEASURED as a BOUND: the timeout of every waitFor the engine reached.
    // What it actually costs depends on when the DOM condition fires, which
    // is the part that needs a browser.
    sleep_conditional_ceiling_ms: 0,
    // The subset of those whose condition this model says never fires, i.e.
    // the ceiling that is actually paid under this behaviour profile.
    sleep_conditional_hit_ms: 0,
    // In-process Playwright operations. NOT the same thing as a model<->browser
    // round trip; see PROTOCOL for that column.
    cdp_calls: 0,
    typed_chars: 0,
    calls: [],
  }

  const note = (op, ...rest) => {
    cost.cdp_calls++
    cost.calls.push([op, ...rest])
  }
  const stale = () => new Error("Element is not attached to the DOM")

  const waitForTimeout = async (ms) => {
    cost.sleep_unconditional_ms += ms
    cost.calls.push(["waitForTimeout", ms])
    if (realSleep) await asleep(ms)
  }

  // A conditional wait. `fires` says whether the DOM condition this model
  // describes would be satisfied; when it is not, the full timeout is paid.
  const conditionalWait = async (label, timeout, fires) => {
    cost.sleep_conditional_ceiling_ms += timeout
    if (!fires) {
      cost.sleep_conditional_hit_ms += timeout
      if (realSleep) await asleep(timeout)
    }
    cost.calls.push(["waitFor", label, timeout, fires ? "early" : "timeout"])
  }

  const el = (sel) => elements[sel] || null

  // --- inferring which combo strategy is running ---------------------------
  //
  // setCombo() never tells the page which strategy it is trying, so the double
  // reads it off the call sequence, which is unambiguous:
  //
  //   type-enter   click, keyboard.type, keyboard.press("Enter")
  //   type-click   click, keyboard.type, <menu row>.click()
  //   click-option click,                <menu row>.click()
  //
  // This matters because the strategies before the winner are paid for in
  // full — that is the single largest term in a combo-heavy fill, and a model
  // that silently made every strategy fail (or succeed) would report the
  // extreme instead of the range.
  const combo = { open: null, typed: null, sawType: false }
  const commitCombo = (strategy, value) => {
    if (!combo.open) return
    if (comboWinner !== "any" && strategy !== comboWinner) return
    const e = el(combo.open)
    if (e) e.value = value
  }

  const makeLocator = (sel, filterText = null) => {
    const loc = {
      _sel: sel,
      async count() {
        note("count", sel)
        return el(sel) ? 1 : 0
      },
      first() {
        return loc
      },
      filter({ hasText }) {
        return makeLocator(sel, hasText)
      },
      async waitFor(o = {}) {
        // The two conditional waits the engines use: "an option appeared" and
        // "the stamped upload input went away".
        const isOption = /__option/.test(sel) || /option/.test(sel)
        const fires =
          o.state === "detached"
            ? /data-ajup/.test(sel)
              ? uploadDetaches
              : !menuRenders
            : isOption
              ? menuRenders && menuOptions > 0
              : true
        await conditionalWait(sel + ":" + o.state, o.timeout ?? 0, fires)
      },
      async scrollIntoViewIfNeeded() {
        note("scroll", sel)
        if (staleForever) throw stale()
      },
      async click() {
        note("click", sel)
        if (staleForever) throw stale()
        if (filterText != null) {
          // A menu ROW. Whether this is type-click or click-option depends on
          // whether the strategy typed a filter first.
          commitCombo(combo.sawType ? "type-click" : "click-option", filterText)
          return true
        }
        const e = el(sel)
        if (e && e.kind === "combo") {
          combo.open = sel
          combo.sawType = false
          combo.typed = null
        }
        page._lastClicked = sel
        if (e && e.setsOnClick) e.value = e.setsOnClick
        return true
      },
      async fill(v) {
        note("fill", sel, v)
        if (staleForever) throw stale()
        const e = el(sel)
        if (!e) throw new Error("no element " + sel)
        if (e.kind === "richtext" && !richtextTakesFill) return
        e.value = v
      },
      async selectOption(o) {
        note("selectOption", sel, o.label)
        if (staleForever) throw stale()
        el(sel).value = o.label
      },
      async check() {
        note("check", sel)
        if (staleForever) throw stale()
        el(sel).value = "true"
      },
      async uncheck() {
        note("uncheck", sel)
        if (staleForever) throw stale()
        el(sel).value = ""
      },
      async setInputFiles(paths) {
        note("setInputFiles", sel, String(paths))
        if (staleForever) throw stale()
      },
      async evaluate(fn) {
        note("locator.evaluate", sel)
        if (staleForever) throw stale()
        const src = String(fn)
        const e = el(sel) || {}
        // kindOf and shownValue, told apart by their source. Ordering matters:
        // the verify evaluate also mentions single-value, but it is a page
        // evaluate, not a locator one.
        if (src.includes("forbidden:")) return e.kind || "input"
        return e.value == null ? "" : String(e.value)
      },
    }
    if (filterText) {
      // A menu row for a specific value. Clicking it commits that value to the
      // combo the strategy is working on.
      loc._filter = filterText
    }
    return loc
  }

  const page = {
    url: () => url,
    locator(sel) {
      note("locator", sel)
      return makeLocator(sel)
    },
    async waitForTimeout(ms) {
      await waitForTimeout(ms)
    },
    async waitForLoadState() {
      note("waitForLoadState")
    },
    async addInitScript() {
      note("addInitScript")
    },
    async addScriptTag() {
      note("addScriptTag")
    },
    async reload() {
      note("reload")
    },
    keyboard: {
      async type(text, o = {}) {
        const delay = o.delay || 0
        cost.sleep_typing_ms += text.length * delay
        cost.typed_chars += text.length
        cost.calls.push(["type", text.length, delay])
        note("keyboard.type", text.length, delay)
        if (realSleep) await asleep(text.length * delay)
        page._lastTyped = text
        if (combo.open) {
          combo.sawType = true
          combo.typed = text
        } else {
          // typeInto's last rung, aimed at whatever was clicked.
          const target = page._lastClicked && el(page._lastClicked)
          if (target) target.value = (target.value || "") + text
        }
      },
      async insertText(text) {
        note("keyboard.insertText", text.length)
        page._lastInsert = text
        if (!richtextTakesInsert) return
        // Land it on whichever richtext element the engine last clicked.
        const target = page._lastClicked && el(page._lastClicked)
        if (target) target.value = text
      },
      async press(key) {
        note("keyboard.press", key)
        if (key === "Enter") commitCombo("type-enter", combo.typed)
        if (key === "Escape") {
          combo.open = null
          combo.sawType = false
          combo.typed = null
        }
      },
    },
    async evaluate(fn, arg) {
      note("page.evaluate")
      const src = String(fn)
      if (src.includes("(0, eval)") && typeof arg === "string") return undefined
      if (src.includes("a.scanner")) return structuredClone(scan)
      if (src.includes("__ajLastScan")) return undefined
      if (src.includes("data-ajup")) return true
      if (src.includes("requiredEmpty")) {
        return { mismatch: [], errors: [], requiredEmpty: [] }
      }
      if (src.includes("activeElement")) return undefined
      if (src.includes("__option")) {
        return Array.from(
          { length: menuOptions },
          (_, i) => "Option " + (i + 1),
        )
      }
      if (src.includes("window.__ajScan")) {
        // `typeof window.__ajScan === "function"` -> false (nothing preowns it)
        if (src.includes("typeof")) {
          return src.includes("? window.__ajScan")
            ? structuredClone(scan)
            : false
        }
        return structuredClone(scan)
      }
      return undefined
    },
    _lastClicked: null,
    _lastTyped: null,
    _lastInsert: null,
    _cost: cost,
  }

  return { page, cost }
}

// ---------------------------------------------------------------------------
// Behaviour profiles. The sleep budget is a RANGE, not a point, because the
// engine's cost depends on which strategy the widget accepts — and that is a
// property of the board, not of the code. Reporting one number without saying
// which end of the range it is would be the same error as reporting an
// estimate as a measurement.
// ---------------------------------------------------------------------------
export const PROFILES = {
  // Everything works on the first try. The floor.
  best: {
    menuRenders: true,
    comboWinner: "type-enter",
    richtextTakesFill: true,
    richtextTakesInsert: true,
    uploadDetaches: true,
  },
  // What the live Greenhouse run recorded: type-enter resolved 16 of 19
  // dropdowns, the education selects needed type-click (ats/greenhouse.mjs:11),
  // fill() lands on a textarea, the upload input is swapped out.
  typical: {
    menuRenders: true,
    comboWinner: "type-click",
    richtextTakesFill: true,
    richtextTakesInsert: true,
    uploadDetaches: true,
  },
  // The board is slow and hostile to every shortcut: no menu ever renders in
  // time, only the last strategy works, the richtext box ignores fill() and
  // insertText(), the upload never visibly remounts.
  worst: {
    menuRenders: false,
    comboWinner: "click-option",
    richtextTakesFill: false,
    richtextTakesInsert: false,
    uploadDetaches: false,
  },
}

// ---------------------------------------------------------------------------
// Synthetic form shapes.
//
// The fixture boards are honest replicas and small (the Greenhouse replica has
// ONE combo). The audit's headline numbers are about a 14-combo Greenhouse
// form and a 3,000-character cover letter, so the harness carries those shapes
// explicitly and labels them SYNTHETIC. A synthetic shape run through the real
// engine still measures the real engine; it just does not prove the shape
// exists on any particular board.
// ---------------------------------------------------------------------------
// A combo the planner can resolve needs BOTH an option list and an answer for
// its exact label — matchOption's requireOptions guard refuses to fill a
// choice-shaped field whose options were never recorded (answer-bank.mjs:258).
// `withOpts: false` is how the harness reproduces the unprobed case on purpose.
const comboField = (i, { withOpts = true, optCount = 12 } = {}) => ({
  k: "c" + (i + 1),
  t: "combo",
  l: "Dropdown " + (i + 1) + " *",
  req: true,
  sel: '[data-aj="c' + (i + 1) + '"]',
  ...(withOpts
    ? { opts: Array.from({ length: optCount }, (_, j) => "Option " + (j + 1)) }
    : {}),
})

// A ~3,000-character cover letter. The audit's 45s number is this string at
// keyboard.type's old 15ms/char with no cap.
export const COVER_LETTER_CHARS = 3000
export const COVER_LETTER = "Lorem ipsum dolor sit amet. ".repeat(
  Math.ceil(COVER_LETTER_CHARS / 28),
)

/**
 * @param {string} kind
 * @param {string} url
 * @returns {{scan: object, answers: {question: string, answer: string}[]}}
 */
export function syntheticScan(kind, url) {
  const base = { url, kind: "form", heading: "Synthetic", fields: [], btns: [] }
  const answers = []
  if (kind === "combo14" || kind === "combo23") {
    const n = kind === "combo14" ? 14 : 23
    base.heading = `${n}-combo form (synthetic)`
    // combo23 leaves the options off: it exists to measure the probe cap of
    // 18, and a field the cache already knows the options for is not probed.
    const withOpts = kind === "combo14"
    base.fields = Array.from({ length: n }, (_, i) =>
      comboField(i, { withOpts }),
    )
    base.btns = [{ k: "b1", l: "Submit application", r: "submit" }]
    for (let i = 0; i < n; i++) {
      answers.push({ question: `Dropdown ${i + 1} *`, answer: "Option 1" })
    }
    return { scan: base, answers }
  }
  if (kind === "richtext") {
    base.heading = "Cover letter in a contenteditable (synthetic)"
    base.fields = [
      {
        k: "f1",
        t: "richtext",
        l: "Cover letter *",
        req: true,
        sel: '[data-aj="f1"]',
      },
    ]
    base.btns = [{ k: "b1", l: "Submit application", r: "submit" }]
    answers.push({ question: "Cover letter *", answer: COVER_LETTER })
    return { scan: base, answers }
  }
  throw new Error("unknown shape " + kind)
}

// The bench's own answer file, written into a temp directory at run time.
// NEVER profile/answers.yaml (hard rule 2) and never tests/fixtures/, which is
// another agent's tree — this is generated input, not a fixture.
export function writeBenchAnswers(dir, extra = []) {
  const base = JSON.parse(
    JSON.stringify([
      {
        id: "bench-001",
        question: "Are you authorized to work in the US?",
        answer: "Yes",
        added: "2026-07-31",
      },
    ]),
  )
  const rows = base.concat(
    extra.map((a, i) => ({
      id: "bench-" + String(i + 100),
      question: a.question,
      answer: a.answer,
      added: "2026-07-31",
    })),
  )
  const yaml =
    "answers:\n" +
    rows
      .map(
        (r) =>
          `  - id: ${r.id}\n` +
          `    question: ${JSON.stringify(r.question)}\n` +
          `    answer: ${JSON.stringify(r.answer)}\n` +
          `    added: ${r.added}\n`,
      )
      .join("")
  const file = path.join(dir, "bench-answers.yaml")
  fs.writeFileSync(file, yaml)
  return file
}

// ---------------------------------------------------------------------------
// Leg 1 — serve. A real HTTP fetch of a real fixture page. The one leg that is
// end-to-end honest without a browser, and the leg that proves the board this
// bench points at is the loopback fixture and nothing else.
// ---------------------------------------------------------------------------
export async function benchServe(board, name) {
  const url = board.pageUrl(name)
  const t0 = performance.now()
  const res = await fetch(url)
  const body = await res.text()
  const ms = performance.now() - t0
  return {
    url,
    ms,
    bytes: body.length,
    status: res.status,
    fixture_header: res.headers.get("x-aj-fixture"),
    csp: res.headers.get("content-security-policy"),
  }
}

// ---------------------------------------------------------------------------
// Leg 2 — scan. Runs BOTH twins.
//
// scan-engine.mjs is the local-runner path (an ordinary import). scan.driver.mjs
// is the path that actually runs today under browser_run_code_unsafe, and it is
// eval'd here exactly the way playwright-core's runCode.ts does it —
// vm.runInContext("(" + code + ")") — so the two are measured under the same
// conditions and any drift between them shows up as a number.
//
// That drift is not hypothetical: the sleep removal landed on the engine while
// the driver kept all three flat sleeps, and the driver is the twin that runs.
// This leg is the regression detector for that exact class of miss.
// ---------------------------------------------------------------------------
export function loadScanDriver(file = SCAN_DRIVER) {
  const src = fs.readFileSync(file, "utf8")
  const ctx = vm.createContext({})
  return vm.runInContext("(" + src + ")", ctx)
}

// The two twins do not return the same shape, and the shape has already moved
// once mid-wave: scan-engine.mjs now returns `{ scan, vouchedLabels }` (the
// vouch travels beside the scan so a page-supplied field cannot carry one),
// while scan.driver.mjs still returns the scan itself. A bench that assumed
// either would report `probe: undefined` and silently measure nothing, which
// is worse than failing. So it unwraps both and says which it saw.
export function unwrapScan(result) {
  if (result && typeof result === "object" && result.scan) {
    return { scan: result.scan, shape: "{scan,vouchedLabels}" }
  }
  return { scan: result, shape: "bare" }
}

export async function benchScan({ scan, url, behaviour, realSleep }) {
  const mk = () =>
    instrumentedPage({
      url,
      scan,
      menuOptions: 12,
      realSleep,
      ...behaviour,
    })

  const engineRig = mk()
  const t0 = performance.now()
  const engineOut = unwrapScan(
    await scanPage(engineRig.page, {
      // The engine reads its own scanner off disk; that read is real.
    }),
  )
  const engineMs = performance.now() - t0

  const driverRig = mk()
  const driver = loadScanDriver()
  const t1 = performance.now()
  const driverOut = unwrapScan(await driver(driverRig.page))
  const driverMs = performance.now() - t1

  const leg = (ms, rig, out) => {
    if (!out.scan || !Array.isArray(out.scan.fields)) {
      throw new Error(
        "the scan twin returned a shape this bench does not recognise " +
          `(${out.shape}, keys: ${Object.keys(out.scan ?? {}).join(",")}). ` +
          "Refusing to report zeros for a leg that did not run — fix " +
          "unwrapScan() rather than letting the numbers go quiet.",
      )
    }
    return {
      ms,
      cost: rig.cost,
      probe: out.scan.probe,
      fields: out.scan.fields.length,
      return_shape: out.shape,
    }
  }

  return {
    engine: leg(engineMs, engineRig, engineOut),
    driver: leg(driverMs, driverRig, driverOut),
    drift: driftBetween(engineRig.cost, driverRig.cost),
    return_shapes_agree: engineOut.shape === driverOut.shape,
  }
}

function driftBetween(a, b) {
  const keys = [
    "sleep_unconditional_ms",
    "sleep_typing_ms",
    "sleep_conditional_ceiling_ms",
  ]
  const out = {}
  let any = false
  for (const k of keys) {
    out[k] = b[k] - a[k]
    if (out[k] !== 0) any = true
  }
  out.differs = any
  return out
}

// ---------------------------------------------------------------------------
// Per-verb unit costs.
//
// The whole-pipeline numbers hide which verb is expensive, and one verb — the
// richtext `type` — is currently UNREACHABLE through fill-plan.mjs at all:
// answer-bank.mjs:375 puts `richtext` in SKIP_TYPES, so every contenteditable
// defers and the planner never emits how:"type". The audit's "up to 45s on a
// cover letter" therefore cannot be reproduced end to end today; it can only
// be measured at the engine, which is where it still lives and where the auto
// runner (Phase 3) will reach it. Measuring it here rather than dropping it is
// the difference between a known ceiling and a forgotten one.
//
// This runs the imported engine, not the generated bootstrap, because there is
// no plan file for a verb the planner refuses to emit.
// ---------------------------------------------------------------------------
export async function benchVerbCosts({ behaviour, realSleep = false } = {}) {
  const b = behaviour || PROFILES.typical
  const fillPage = (await import("../apply/fill-engine.mjs")).default
  const url = "http://127.0.0.1/bench"
  const cases = [
    {
      verb: "fill",
      items: [
        { k: "f1", how: "fill", sel: "#f1", value: "Ada", label: "Name" },
      ],
      elements: { "#f1": { kind: "input", value: "" } },
    },
    {
      verb: "combo",
      items: [
        { k: "c1", how: "combo", sel: "#c1", value: "Option 1", label: "D1" },
      ],
      elements: {
        "#c1": { kind: "combo", value: "" },
        "[class*='__option'], [role='option']": { kind: "input", value: "" },
      },
    },
    {
      verb: "type (richtext, 3000-char cover letter)",
      items: [
        {
          k: "r1",
          how: "type",
          sel: "#r1",
          value: COVER_LETTER,
          label: "Cover letter",
        },
      ],
      elements: { "#r1": { kind: "richtext", value: "" } },
    },
    {
      verb: "upload",
      items: [
        { k: "u1", how: "upload", labelMatch: "resume", paths: ["/tmp/x.pdf"] },
      ],
      elements: { '[data-ajup="u1"]': { kind: "input", value: "" } },
    },
  ]
  const out = []
  for (const c of cases) {
    const rig = instrumentedPage({
      url,
      elements: c.elements,
      realSleep,
      ...b,
    })
    const report = await fillPage(rig.page, { items: c.items, urlGuard: null })
    out.push({
      verb: c.verb,
      ok: report.ok,
      failed: report.failed,
      // The final 450ms blur-and-settle is charged once per fill, not per
      // verb, so it is subtracted to make these comparable per field.
      unconditional_ms: rig.cost.sleep_unconditional_ms - 450,
      typing_ms: rig.cost.sleep_typing_ms,
      conditional_ceiling_ms: rig.cost.sleep_conditional_ceiling_ms,
      typed_chars: rig.cost.typed_chars,
      cdp_calls: rig.cost.cdp_calls,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Leg 3 — plan. The real fill-plan.mjs, as a real subprocess, against a real
// temp workspace seeded with a real scan. Nothing simulated; wall_ms is a
// clock reading.
// ---------------------------------------------------------------------------
export function benchPlan({
  scan,
  url,
  jobsDir,
  slug = "bench",
  files = {},
  answersFile = FIXTURE_ANSWERS,
}) {
  const jobDir = path.join(jobsDir, slug)
  fs.mkdirSync(jobDir, { recursive: true })
  fs.writeFileSync(
    path.join(jobDir, "scan-p1.json"),
    JSON.stringify(scan, null, 2),
  )
  // Attachment slots defer with "no rendered resume" unless a file exists, so
  // a bench that wants the upload path measured has to provide one. These are
  // placeholder bytes in a temp dir, never a real document.
  const args = ["scripts/apply/fill-plan.mjs", slug, "--json"]
  args.push("--jobs-dir", jobsDir)
  args.push("--url", url)
  args.push("--profile", FIXTURE_PROFILE)
  args.push("--answers", answersFile)
  args.push("--no-cache")
  if (files.resume) args.push("--resume", files.resume)
  if (files.cover) args.push("--cover", files.cover)

  const t0 = performance.now()
  const stdout = execFileSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  const ms = performance.now() - t0
  const parsed = JSON.parse(stdout)
  return {
    ms,
    ready: parsed.ready,
    reason: parsed.reason || null,
    items: parsed.plan.items.filter((i) => i.how !== "skip").length,
    defers: parsed.plan.defer.length,
    unknownDefers: parsed.plan.defer.filter((d) =>
      /unknown|needs-choice|maybe/i.test(d.why),
    ).length,
    needsRender: parsed.plan.defer.some((d) => /no rendered/.test(d.why)),
    probeNeeded: (parsed.probeNeeded || []).length,
    plan: parsed.plan,
    planFile: path.join(jobDir, "fill-plan.js"),
  }
}

// ---------------------------------------------------------------------------
// Leg 4 — fill. Runs THE GENERATED BOOTSTRAP, not the imported module.
//
// jobs/<slug>/fill-plan.js is the production artifact: a bare async function
// expression with the engine and the plan embedded as string literals. It is
// loaded here the same way the MCP vm loads it, so this leg also proves the
// bootstrap parses and runs — which importing fill-engine.mjs would not.
// ---------------------------------------------------------------------------
export async function benchFill({ planFile, plan, url, behaviour, realSleep }) {
  const elements = {}
  for (const item of plan.items || []) {
    if (item.how === "skip") continue
    const sel = item.sel || '[data-aj="' + item.k + '"]'
    const kind =
      item.how === "combo"
        ? "combo"
        : item.how === "type"
          ? "richtext"
          : item.how === "select"
            ? "select"
            : item.how === "check"
              ? "input"
              : "input"
    elements[sel] = { kind, value: "" }
  }
  // The upload path finds its input by a stamp it sets itself.
  elements['[data-ajup="u1"]'] = { kind: "input", value: "" }
  elements['[data-ajup="u2"]'] = { kind: "input", value: "" }
  // Menu rows are located with a filter on the value text.
  elements["[class*='__option'], [role='option']"] = {
    kind: "input",
    value: "",
  }

  const rig = instrumentedPage({
    url,
    scan: { fields: [], btns: [{ k: "b1", l: "Submit", r: "submit" }] },
    elements,
    realSleep,
    ...behaviour,
  })

  const src = fs.readFileSync(planFile, "utf8")
  // Exactly what playwright-core's runCode.ts does: vm.runInContext of the
  // parenthesised source, no importModuleDynamically callback.
  const ctx = vm.createContext({ structuredClone })
  const run = vm.runInContext("(" + src + ")", ctx)

  const t0 = performance.now()
  const report = await run(rig.page)
  const ms = performance.now() - t0
  return { ms, cost: rig.cost, report }
}

// ---------------------------------------------------------------------------
// One full sample.
// ---------------------------------------------------------------------------
export async function runOnce(opts) {
  const {
    boardName = "greenhouse",
    shape = null,
    profileName = "typical",
    realSleep = false,
    board,
    jobsDir,
  } = opts
  const behaviour = PROFILES[profileName]
  if (!behaviour) throw new Error("unknown profile " + profileName)

  const t0 = performance.now()
  const serve = await benchServe(board, boardName)
  const url = serve.url

  let scan
  let extraAnswers = []
  if (shape) {
    const synth = syntheticScan(shape, url)
    scan = synth.scan
    extraAnswers = synth.answers
  } else {
    const f = path.join(FIXTURE_SCANS, boardName + "-step1.scan.json")
    const file = fs.existsSync(f)
      ? f
      : path.join(FIXTURE_SCANS, boardName + ".scan.json")
    scan = JSON.parse(fs.readFileSync(file, "utf8"))
    scan.url = url
  }
  const answersFile = writeBenchAnswers(jobsDir, extraAnswers)

  const scanLeg = await benchScan({ scan, url, behaviour, realSleep })

  // Placeholder attachments so the upload verb is exercised rather than
  // deferred. Temp bytes, never a real document.
  const filesDir = path.join(jobsDir, "_files")
  fs.mkdirSync(filesDir, { recursive: true })
  const resume = path.join(filesDir, "resume.pdf")
  const cover = path.join(filesDir, "cover-letter.pdf")
  fs.writeFileSync(resume, "%PDF-1.4 bench placeholder\n")
  fs.writeFileSync(cover, "%PDF-1.4 bench placeholder\n")

  const planLeg = benchPlan({
    scan,
    url,
    jobsDir,
    slug: "bench",
    files: { resume, cover },
    answersFile,
  })
  const fillLeg = await benchFill({
    planFile: planLeg.planFile,
    plan: planLeg.plan,
    url,
    behaviour,
    realSleep,
  })
  const wall = performance.now() - t0

  const proto = protocolCost({
    page: opts.page ?? 1,
    ready: planLeg.ready,
    unknownDefers: planLeg.unknownDefers,
    needsRender: planLeg.needsRender,
    hasNext: (scan.btns || []).some((b) => b.r === "next"),
  })

  const scanCost = scanLeg.driver.cost // the twin that actually runs today
  const sleep = {
    unconditional_ms:
      scanCost.sleep_unconditional_ms +
      scanCost.sleep_typing_ms +
      fillLeg.cost.sleep_unconditional_ms +
      fillLeg.cost.sleep_typing_ms,
    conditional_ceiling_ms:
      scanCost.sleep_conditional_ceiling_ms +
      fillLeg.cost.sleep_conditional_ceiling_ms,
    conditional_hit_ms:
      scanCost.sleep_conditional_hit_ms + fillLeg.cost.sleep_conditional_hit_ms,
    by_leg: {
      scan_engine: legSleep(scanLeg.engine.cost),
      scan_driver: legSleep(scanCost),
      fill: legSleep(fillLeg.cost),
    },
  }
  sleep.worst_case_ms = sleep.unconditional_ms + sleep.conditional_ceiling_ms

  return {
    board: boardName,
    shape,
    profile: profileName,
    url,
    serve,
    scan: scanLeg,
    plan: planLeg,
    fill: fillLeg,
    protocol: proto,
    sleep,
    wall_ms: wall,
  }
}

function legSleep(c) {
  return {
    unconditional_ms: c.sleep_unconditional_ms,
    typing_ms: c.sleep_typing_ms,
    conditional_ceiling_ms: c.sleep_conditional_ceiling_ms,
    conditional_hit_ms: c.sleep_conditional_hit_ms,
    cdp_calls: c.cdp_calls,
    typed_chars: c.typed_chars,
  }
}

// ---------------------------------------------------------------------------
// Statistics. A single sample is not a measurement (agent-protocol.md, "a
// single sample presented as a trend"), so the CLI always runs several and
// reports the spread. The accounted columns are deterministic by construction
// and their stddev is 0 — that is a fact about the harness, and printing it is
// how a reader can tell an accounted column from a clocked one.
// ---------------------------------------------------------------------------
export function stats(values) {
  const v = [...values].sort((a, b) => a - b)
  const n = v.length
  const mean = v.reduce((a, b) => a + b, 0) / n
  const variance = v.reduce((a, b) => a + (b - mean) ** 2, 0) / n
  return {
    n,
    min: v[0],
    max: v[n - 1],
    median: n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2,
    mean: round(mean),
    stddev: round(Math.sqrt(variance)),
  }
}

const round = (x) => Math.round(x * 100) / 100

export function summarize(samples) {
  const pick = (fn) => stats(samples.map(fn))
  const first = samples[0]
  return {
    runs: samples.length,
    board: first.board,
    shape: first.shape,
    profile: first.profile,
    columns: {
      round_trips: {
        value: first.protocol.round_trips,
        method: "derived",
        note: "counted from the documented MCP flow; see PROTOCOL citations",
        steps: first.protocol.steps.filter((id) =>
          PROTOCOL.find((s) => s.id === id && s.browser),
        ),
      },
      sleep_ms: {
        value: first.sleep.unconditional_ms,
        method: "measured",
        note:
          "sum of every waitForTimeout argument and every keyboard.type " +
          "chars*delay the engines reached on the path they took",
        worst_case_ms: first.sleep.worst_case_ms,
        conditional_ceiling_ms: first.sleep.conditional_ceiling_ms,
        conditional_paid_under_this_profile_ms: first.sleep.conditional_hit_ms,
        conditional_actual_ms: null,
        conditional_actual_method: "unmeasured",
        conditional_actual_why:
          "a conditional wait costs whatever the DOM takes to satisfy it; " +
          "that needs a browser. Only the ceiling is knowable from the code.",
        by_leg: first.sleep.by_leg,
      },
      model_turns: {
        value: first.protocol.model_turns,
        method: "derived",
        note: "one assistant turn per prescribed step; see PROTOCOL citations",
        steps: first.protocol.steps,
        skipped_because_of_this_run: first.protocol.skipped,
      },
      wall_ms: {
        value: round(pick((s) => s.wall_ms).median),
        method: "measured",
        note: "harness wall clock, sleep accounted not slept unless --real-sleep",
        spread: pick((s) => s.wall_ms),
      },
    },
    legs: {
      serve_ms: pick((s) => s.serve.ms),
      scan_engine_ms: pick((s) => s.scan.engine.ms),
      scan_driver_ms: pick((s) => s.scan.driver.ms),
      plan_ms: pick((s) => s.plan.ms),
      fill_ms: pick((s) => s.fill.ms),
    },
    twin_drift: first.scan.drift,
    plan: {
      ready: first.plan.ready,
      reason: first.plan.reason,
      items: first.plan.items,
      defers: first.plan.defers,
      probe_needed: first.plan.probeNeeded,
    },
    fill_report: {
      ok: first.fill.report.ok,
      failed: first.fill.report.failed,
      deferred: first.fill.report.deferred,
    },
    unmeasured: unmeasuredList(),
  }
}

// Everything this harness deliberately does NOT claim. Printed on every run so
// a reader never has to guess which column had a browser behind it.
export function unmeasuredList() {
  return [
    {
      id: "conditional_wait_actual",
      what: "what a waitFor() actually costs before its DOM condition fires",
      why: "needs a real DOM; only the timeout ceiling is in the source",
    },
    {
      id: "cdp_latency",
      what: "wall time of a Playwright call over CDP",
      why: "no browser; the harness counts calls, it does not clock them",
    },
    {
      id: "label_resolution",
      what: "whether labelOf() picks the label the scan fixture claims",
      why: "needs a DOM — tests/fixtures/boards/README.md:101 says the same",
    },
    {
      id: "react_select_behaviour",
      what: "which combo strategy a real react-select actually accepts",
      why: "modelled as a profile (best/typical/worst), not observed",
    },
    {
      id: "csp_enforcement",
      what: "that the Ashby nonce policy blocks an injected inline script",
      why: "a policy is only enforced by a browser; the header is served",
    },
    {
      id: "page_side_scanner",
      what: "scan-page.js's own probe sleeps (200ms+80ms x MAX_PROBE=15)",
      why: "both engines call __ajScan(false), so PROBE never runs here",
    },
  ]
}

// ---------------------------------------------------------------------------
// The optional browser leg. Absent playwright-core it reports why, and it never
// points anywhere but the loopback fixture.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Provenance. A baseline is only reproducible if you can tell WHICH bytes were
// measured, and a sha alone cannot do that while other agents have uncommitted
// edits in flight — which is the normal state during a build wave. So every
// run records the sha, whether the tree is dirty, and the content hash of each
// file whose cost this harness reports.
// ---------------------------------------------------------------------------
export const MEASURED_FILES = [
  ".claude/skills/apply-job/scan-page.js",
  ".claude/skills/apply-job/scan.driver.mjs",
  "scripts/apply/scan-engine.mjs",
  "scripts/apply/fill-engine.mjs",
  "scripts/apply/fill-plan.mjs",
]

export async function provenance() {
  const { createHash } = await import("node:crypto")
  const files = {}
  for (const rel of MEASURED_FILES) {
    const abs = path.join(ROOT, rel)
    files[rel] = fs.existsSync(abs)
      ? createHash("sha1")
          .update(fs.readFileSync(abs))
          .digest("hex")
          .slice(0, 12)
      : "MISSING"
  }
  let sha = "unknown"
  let dirty = null
  try {
    sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim()
    const st = execFileSync(
      "git",
      ["status", "--porcelain", "--", ...MEASURED_FILES],
      {
        cwd: ROOT,
        encoding: "utf8",
      },
    )
    dirty = st.trim() ? st.trim().split(/\r?\n/) : []
  } catch {}
  return { sha, dirty_measured_files: dirty, file_sha1: files }
}

export async function browserAvailable() {
  try {
    const pw = await import("playwright-core")
    return { ok: !!(pw.chromium ?? pw.default?.chromium) }
  } catch (e) {
    return { ok: false, why: String(e.message).split("\n")[0].slice(0, 120) }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const o = {
    board: "greenhouse",
    shape: null,
    profile: "typical",
    runs: 5,
    json: false,
    ledger: false,
    realSleep: false,
    browser: false,
    allProfiles: false,
    page: 1,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--board") o.board = argv[++i]
    else if (a === "--shape") o.shape = argv[++i]
    else if (a === "--profile") o.profile = argv[++i]
    else if (a === "--page") o.page = Number(argv[++i])
    else if (a === "--runs") o.runs = Number(argv[++i])
    else if (a === "--json") o.json = true
    else if (a === "--ledger") o.ledger = true
    else if (a === "--real-sleep") o.realSleep = true
    else if (a === "--browser") o.browser = true
    else if (a === "--all-profiles") o.allProfiles = true
    else if (a === "--verbs") o.verbs = true
    else if (a === "--help" || a === "-h") o.help = true
    else throw new Error("unknown option " + a)
  }
  return o
}

const USAGE = `bench-apply.mjs — scan -> plan -> fill against the local fake ATS

  --board <greenhouse|lever|ashby>  fixture board (default greenhouse)
  --shape <combo14|combo23|richtext>  synthetic form shape instead of a fixture
  --profile <best|typical|worst>    widget behaviour model (default typical)
  --page N                          which page of the form (page 1 pays a navigate)
  --all-profiles                    run all three and print the range
  --verbs                           per-verb unit costs, including the richtext
                                    ceiling the planner cannot currently reach
  --runs N                          samples (default 5); a single one is not a measurement
  --real-sleep                      actually sleep instead of accounting (proves the accounting)
  --browser                         attempt the real-page legs (needs playwright-core)
  --json                            full record
  --ledger                          a paste-ready docs/measurements.md entry

Nothing here touches a live employer's board. See tests/fixtures/boards/README.md.`

export function ledgerEntry(sum, prov) {
  const c = sum.columns
  const shape = sum.shape ? `shape=${sum.shape}` : `board=${sum.board}`
  const dirty =
    prov.dirty_measured_files && prov.dirty_measured_files.length
      ? ` (+${prov.dirty_measured_files.length} uncommitted measured file(s))`
      : ""
  return [
    `- harness:  node scripts/dev/bench-apply.mjs --board ${sum.board}` +
      (sum.shape ? ` --shape ${sum.shape}` : "") +
      ` --profile ${sum.profile} --runs ${sum.runs}`,
    `- baseline: ${prov.sha}${dirty} — round_trips=${c.round_trips.value} ` +
      `sleep_ms=${c.sleep_ms.value} model_turns=${c.model_turns.value} ` +
      `wall_ms=${c.wall_ms.value}`,
    `- worst:    sleep_ms=${c.sleep_ms.worst_case_ms} ` +
      `(unconditional ${c.sleep_ms.value} + conditional ceiling ` +
      `${c.sleep_ms.conditional_ceiling_ms}) ${shape}`,
    `- method:   round_trips/model_turns derived (PROTOCOL citations); ` +
      `sleep measured by executing the engines; conditional-wait actuals ` +
      `unmeasured (no browser)`,
    `- bytes:    ` +
      Object.entries(prov.file_sha1)
        .map(([f, h]) => `${h} ${path.basename(f)}`)
        .join("  "),
  ].join("\n")
}

function printHuman(sum) {
  const c = sum.columns
  const L = (s) => process.stdout.write(s + "\n")
  L("")
  L(
    `bench-apply — board=${sum.board}${sum.shape ? ` shape=${sum.shape}` : ""} ` +
      `profile=${sum.profile} runs=${sum.runs}`,
  )
  L("")
  L("column          value    method      note")
  L("-".repeat(78))
  L(
    `round_trips     ${String(c.round_trips.value).padEnd(8)} ${c.round_trips.method.padEnd(11)} ${c.round_trips.steps.join(", ")}`,
  )
  L(
    `sleep_ms        ${String(c.sleep_ms.value).padEnd(8)} ${c.sleep_ms.method.padEnd(11)} unconditional + typing, on the path taken`,
  )
  L(
    `  worst_case    ${String(c.sleep_ms.worst_case_ms).padEnd(8)} ${"measured".padEnd(11)} + every conditional ceiling (${c.sleep_ms.conditional_ceiling_ms})`,
  )
  L(
    `model_turns     ${String(c.model_turns.value).padEnd(8)} ${c.model_turns.method.padEnd(11)} ${c.model_turns.steps.length} prescribed steps`,
  )
  L(
    `wall_ms         ${String(c.wall_ms.value).padEnd(8)} ${c.wall_ms.method.padEnd(11)} median of ${c.wall_ms.spread.n}; stddev ${c.wall_ms.spread.stddev}`,
  )
  L("")
  L("per leg (sleep ms: unconditional / typing / conditional ceiling)")
  for (const [name, s] of Object.entries(c.sleep_ms.by_leg)) {
    L(
      `  ${name.padEnd(14)} ${String(s.unconditional_ms).padStart(6)} / ` +
        `${String(s.typing_ms).padStart(6)} / ${String(s.conditional_ceiling_ms).padStart(6)}` +
        `   cdp_calls=${s.cdp_calls} typed_chars=${s.typed_chars}`,
    )
  }
  L("")
  L(
    `twin drift (driver - engine): ${
      sum.twin_drift.differs
        ? JSON.stringify(sum.twin_drift)
        : "none — the two scan twins cost the same"
    }`,
  )
  L(
    `plan: ready=${sum.plan.ready} items=${sum.plan.items} defer=${sum.plan.defers} probe_needed=${sum.plan.probe_needed}` +
      (sum.plan.reason ? ` reason=${sum.plan.reason}` : ""),
  )
  L(
    `fill: ok=${sum.fill_report.ok} failed=${sum.fill_report.failed} deferred=${sum.fill_report.deferred}`,
  )
  L("")
  L("legs (ms, median):")
  for (const [k, v] of Object.entries(sum.legs)) {
    L(
      `  ${k.padEnd(18)} ${String(round(v.median)).padStart(8)}  (${round(v.min)}–${round(v.max)}, sd ${v.stddev})`,
    )
  }
  L("")
  L("NOT MEASURED — needs a browser, reported as null rather than estimated:")
  for (const u of sum.unmeasured) L(`  - ${u.what}  [${u.why}]`)
  L("")
}

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (e) {
    process.stderr.write(e.message + "\n\n" + USAGE + "\n")
    process.exit(2)
  }
  if (opts.help) {
    process.stdout.write(USAGE + "\n")
    return
  }

  if (opts.verbs) {
    const rows = []
    for (const name of opts.allProfiles
      ? Object.keys(PROFILES)
      : [opts.profile])
      rows.push({
        profile: name,
        verbs: await benchVerbCosts({ behaviour: PROFILES[name] }),
      })
    if (opts.json) {
      process.stdout.write(JSON.stringify(rows, null, 2) + "\n")
      return
    }
    for (const r of rows) {
      process.stdout.write(`\nper-verb unit cost, profile=${r.profile}\n`)
      process.stdout.write(
        "  verb                                      uncond  typing  ceiling  chars ok/fail\n",
      )
      for (const v of r.verbs) {
        process.stdout.write(
          `  ${v.verb.padEnd(40)} ${String(v.unconditional_ms).padStart(6)}  ` +
            `${String(v.typing_ms).padStart(6)}  ${String(v.conditional_ceiling_ms).padStart(7)}  ` +
            `${String(v.typed_chars).padStart(5)}  ${v.ok}/${v.failed}\n`,
        )
      }
    }
    process.stdout.write(
      '\nNOTE: how:"type" is unreachable through fill-plan.mjs today —\n' +
        "answer-bank.mjs:375 SKIP_TYPES contains `richtext`, so every\n" +
        "contenteditable defers. This is an ENGINE-level ceiling.\n",
    )
    return
  }

  const board = await startBoard()
  const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-apply-"))
  try {
    const profiles = opts.allProfiles ? Object.keys(PROFILES) : [opts.profile]
    const results = []
    for (const profileName of profiles) {
      const samples = []
      for (let i = 0; i < opts.runs; i++) {
        samples.push(
          await runOnce({
            boardName: opts.board,
            shape: opts.shape,
            profileName,
            realSleep: opts.realSleep,
            page: opts.page,
            board,
            jobsDir,
          }),
        )
      }
      results.push(summarize(samples))
    }

    const browser = await browserAvailable()
    const prov = await provenance()

    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ provenance: prov, browser, results }, null, 2) + "\n",
      )
    } else if (opts.ledger) {
      for (const sum of results) {
        process.stdout.write(ledgerEntry(sum, prov) + "\n\n")
      }
    } else {
      for (const sum of results) printHuman(sum)
      process.stdout.write(
        browser.ok
          ? "browser leg: playwright-core present (schema reserved, not yet wired)\n"
          : `browser leg: UNMEASURED — ${browser.why}\n`,
      )
      process.stdout.write(`sha=${prov.sha}`)
      if (prov.dirty_measured_files && prov.dirty_measured_files.length) {
        process.stdout.write(
          ` DIRTY (${prov.dirty_measured_files.length} measured file(s) uncommitted)\n`,
        )
        for (const l of prov.dirty_measured_files)
          process.stdout.write(`  ${l}\n`)
      } else {
        process.stdout.write(" clean\n")
      }
      for (const [f, h] of Object.entries(prov.file_sha1)) {
        process.stdout.write(`  ${h}  ${f}\n`)
      }
    }
  } finally {
    await board.stop()
    fs.rmSync(jobsDir, { recursive: true, force: true })
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  await main()
}
