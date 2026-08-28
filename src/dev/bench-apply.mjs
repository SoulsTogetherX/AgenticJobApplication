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
// THE DEFAULT RUN OPENS NO BROWSER, and that is a choice about cost, not a
// fact about the repo. This comment used to read "there is no Playwright and
// no browser in this repo" — that stopped being true when `playwright-core`
// became a committed devDependency and Chromium was installed, and it was
// still here on 2026-07-31, which is how a stale comment turns into three
// agents believing a number could not be taken (innov-perf found it;
// qa-breaker wired the leg). `playwright` is still avoided — its postinstall
// pulls ~150MB — but `playwright-core` + an installed Chromium is present, so
// `--browser` is real. Every number carries a `method` and the CLI prints it:
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
// The browser leg slots in without changing the schema: `--browser` runs the
// real engines against the loopback fixture in real Chromium, and the
// `unmeasured` entries it closes flip to `measured` with `closed_by:
// "--browser"`. It closes five of the six; `react_select_behaviour` stays
// unmeasured on purpose, because the fixture's combos are the fixture's, not a
// real react-select, and reporting them as one would be the estimate this
// harness exists to refuse. Absent the dependency the leg reports why it did
// not run and every entry stays open.
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
//   node src/dev/bench-apply.mjs --board greenhouse
//   node src/dev/bench-apply.mjs --board greenhouse --runs 7 --json
//   node src/dev/bench-apply.mjs --shape combo14 --profile worst
//   node src/dev/bench-apply.mjs --ledger          # paste-ready entry
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import vm from "node:vm"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import scanPage from "../apply/scan-engine.mjs"
import {
  ROUTES,
  start as startBoard,
} from "../../tests/fixtures/boards/server.mjs"

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
    cite: "SKILL.md:142 node src/apply/fill-plan.mjs <slug>",
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
    cite: "SKILL.md:177 node src/documents/reuse-check.mjs <slug>",
    when: (c) => !c.ready,
  },
  {
    id: "pending-questions",
    browser: false,
    turn: true,
    cite: "SKILL.md:196 node src/apply/pending-questions.mjs",
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
 * @param {number} [spec.menuTotal]     how many options the page ACTUALLY has,
 *                                      when the page-side scanner cut the list
 *                                      at MAX_OPTS. Makes the probe return
 *                                      `{opts, total}` instead of a bare array,
 *                                      which is the shape scan-engine.mjs
 *                                      reads to set optsTruncated/optsTotal.
 *                                      Absent -> bare array, the pre-truncation
 *                                      shape, which must still work.
 * @param {string[]} [spec.verifyLanded] keys the verify pass reports as having
 *                                      their value on the page after all. The
 *                                      engine promotes a STALE failure whose
 *                                      key is here back to `ok`; that is the
 *                                      only rescue path and it needs a double
 *                                      that can say "it landed".
 * @param {boolean} [spec.menuRenders]  does the __option wait resolve early
 * @param {string}  [spec.comboWinner]  which strategy actually sets the value
 * @param {boolean} [spec.richtextTakesFill]
 * @param {boolean} [spec.richtextTakesInsert]
 * @param {boolean} [spec.uploadDetaches]
 * @param {boolean} [spec.staleForever] every touch throws "not attached"
 * @param {boolean} [spec.realSleep]    actually sleep instead of accounting
 * @param {(ms:number)=>Promise<void>} [spec.sleepFn] the sleep primitive
 *                                      `realSleep` drives. Defaults to a real
 *                                      setTimeout. Inject a virtual clock to
 *                                      assert the accounting exactly without
 *                                      making the assertion a race against the
 *                                      machine's load — see
 *                                      tests/apply/bench-apply.test.mjs.
 */
export function instrumentedPage(spec = {}) {
  const {
    url = "http://127.0.0.1/apply",
    scan = { fields: [], btns: [{ k: "b1", l: "Submit", r: "submit" }] },
    elements = {},
    menuOptions = 12,
    menuTotal = null,
    verifyLanded = null,
    menuRenders = true,
    comboWinner = "type-enter",
    richtextTakesFill = true,
    richtextTakesInsert = true,
    uploadDetaches = true,
    staleForever = false,
    realSleep = false,
    sleepFn = asleep,
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
    if (realSleep) await sleepFn(ms)
  }

  // A conditional wait. `fires` says whether the DOM condition this model
  // describes would be satisfied; when it is not, the full timeout is paid.
  const conditionalWait = async (label, timeout, fires) => {
    cost.sleep_conditional_ceiling_ms += timeout
    if (!fires) {
      cost.sleep_conditional_hit_ms += timeout
      if (realSleep) await sleepFn(timeout)
    }
    cost.calls.push(["waitFor", label, timeout, fires ? "early" : "timeout"])
  }

  const el = (sel) => elements[sel] || null

  // THE ROW MATCHER IS A RegExp NOW, and the double needs the literal it
  // stands for. fill-engine.mjs matches an option row on its WHOLE text
  // (`^\s*value\s*$`, case-insensitive) rather than on containment, because a
  // substring match put "Protected Veteran" into a real Veteran Status field.
  // What this model has to reproduce is "clicking this row commits THAT
  // value", so it unpicks the pattern back into the value it was built from.
  // A plain string still passes straight through.
  const matcherText = (m) =>
    m instanceof RegExp
      ? String(m.source)
          .replace(/^\^\\s\*/, "")
          .replace(/\\s\*\$$/, "")
          .replace(/\\s\+/g, " ")
          .replace(/\\(.)/g, "$1")
      : m

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
      // A menu scoped to the control that named it: page.locator(menu).locator(rows).
      locator(sub) {
        note("locator.locator", sel, sub)
        return makeLocator(sub)
      },
      getByText(matcher) {
        note("locator.getByText", sel)
        return makeLocator(sel + " :text", matcherText(matcher))
      },
      filter({ hasText }) {
        return makeLocator(sel, matcherText(hasText))
      },
      // The engines now ask the CONTROL which menu is its own (aria-controls)
      // instead of searching the page, so the double has to be able to answer.
      // A fixture declares them per element: elements["#x"] = { attrs: {...} }.
      async getAttribute(name) {
        note("getAttribute", sel, name)
        if (staleForever) throw stale()
        const attrs = (el(sel) || {}).attrs || {}
        return attrs[name] == null ? null : String(attrs[name])
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
    // The fallback row lookup, for a menu whose rows declare no option role or
    // class — which is what an ORC listbox is. Same commit behaviour as a
    // filtered row locator: this IS a row, identified by its whole text.
    getByText(matcher) {
      note("getByText", String(matcher))
      return makeLocator("[role='listbox'] :text", matcherText(matcher))
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
        if (realSleep) await sleepFn(text.length * delay)
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
      // THE SETTLE PROBE, and it has to be answered in the model's own terms or
      // the engine takes a branch no real page would put it on. It polls one
      // question per stamped upload — has this input reacted to its file? — and
      // a double that cannot answer makes the engine stop settling AT ONCE,
      // which reports as zero sleep and reads as a speed-up. That is M6's exact
      // shape (a number that measures the double refusing, not the product
      // running), so `uploadDetaches` — the same profile flag that used to
      // decide whether the old per-upload detach wait fired — decides it here:
      //
      //   uploadDetaches true  -> "gone": the board swapped the input out, the
      //                           settle has its evidence and exits early.
      //   uploadDetaches false -> "held": nothing observable happened, so the
      //                           settle pays its ceiling in poll gaps, which
      //                           is what a real board of that kind costs.
      //
      // `err: ""` throughout: this model has no rendered validation text, so
      // the quiet arm has nothing to see and pays its ceiling — the honest
      // answer for a page with no board-side validation.
      // MATCHED ON THE PROBE'S OWN KEY, never on "upl"/"err": both of those
      // substrings appear in the VERIFY pass's source too ("upload", "errors"),
      // and a double that matched on them answered the verify call with this
      // shape — which cost E4 its `landed` list and reported a filled field as
      // failed (tests/apply/edge-cases.test.mjs).
      // THE FOCUSED-ROW PROBE (2026-08-18). type-enter presses Enter only
      // when the page reports a focused option — Enter with none is the
      // browser's implicit form submission (measured on Greenhouse). The
      // double answers in its own terms: a combo that this fill OPENED and
      // TYPED INTO has a focused row (the model has no rows to focus, so
      // "open and filtered" is the state the real widget is in when a row is
      // highlighted); anything else does not. `menuRenders: false` profiles
      // — no menu ever opens — answer false, which is what sends them down
      // the ladder exactly as a real board with no menu would.
      if (src.includes("ajFocusedOptionProbe")) {
        return !!(menuRenders && combo.open && combo.sawType)
      }
      // The submit guard's arm/disarm evaluates: nothing to model, nothing
      // was blocked.
      if (src.includes("__ajSubmitGuards")) return 0
      if (src.includes("ajSettleProbe")) {
        return {
          upl: (Array.isArray(arg) ? arg : []).map(() =>
            uploadDetaches ? "gone" : "held",
          ),
          err: "",
        }
      }
      if (src.includes("data-ajup")) return true
      if (src.includes("requiredEmpty")) {
        return {
          mismatch: [],
          errors: [],
          requiredEmpty: [],
          ...(verifyLanded ? { landed: [...verifyLanded] } : {}),
        }
      }
      if (src.includes("activeElement")) return undefined
      if (src.includes("__option")) {
        const opts = Array.from(
          { length: menuOptions },
          (_, i) => "Option " + (i + 1),
        )
        // Two shapes, both real: a bare array is what the probe returned
        // before the truncation flag existed, `{opts,total}` is what it
        // returns once the page-side cut at MAX_OPTS has bitten.
        return menuTotal == null ? opts : { opts, total: menuTotal }
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

// ---------------------------------------------------------------------------
// The GATE shapes — what a CONFIRM and a confirm-widget defer actually cost.
//
// Two plan-side gates decide whether a page needs a human, and until now this
// harness could not make either of them fire: the fixture boards produce a
// CONFIRM only alongside three unrelated blockers, so the gate's own cost was
// buried in theirs, and no shape produced a `confirm-widget` defer at all.
// An unmeasured gate is an unbudgeted one.
//
// The design is an A/B on the INPUT, not on the code, because the pre-rule
// planner is not available to run: five shapes that differ by exactly one
// field, so the delta between any two IS the cost of the thing that differs.
//
//   gate-base        3 profile facts. ready=true. The floor.
//   gate-select      + the SAME question, as a <select>          -> fills
//   gate-radio-opt   + the SAME question, as an OPTIONAL radio   -> confirm-widget, !req
//   gate-radio-req   + the SAME question, as a REQUIRED radio    -> confirm-widget, req
//   gate-confirm     + an assertion-class question as text       -> confirm
//
// gate-select vs gate-radio-* is the whole experiment: identical question,
// identical stored answer, identical resolution — only the WIDGET differs, and
// the rule says a widget carries assent rather than a value. Whatever these
// two shapes differ by in the three columns is what the check-widget rule
// costs, with nothing else moving.
// ---------------------------------------------------------------------------
export const GATE_BASE_FIELDS = [
  {
    k: "f1",
    sel: '[data-aj="f1"]',
    n: "name",
    t: "text",
    l: "Full name",
    req: true,
  },
  {
    k: "f2",
    sel: '[data-aj="f2"]',
    n: "email",
    t: "text",
    l: "Email",
    req: true,
  },
  {
    k: "f3",
    sel: '[data-aj="f3"]',
    n: "phone",
    t: "text",
    l: "Phone",
    req: true,
  },
]

// A `datum`-class question (a fact ABOUT the user, not something they assert).
// This is the case the rule is really about: the bank CAN answer it, and the
// old planner ticked the box for it with no human in the loop.
export const GATE_DATUM_Q = "What is your highest level of education?"
export const GATE_DATUM_A = "Bachelor's degree"
export const GATE_DATUM_OPTS = [
  "High school",
  GATE_DATUM_A,
  "Master's degree",
  "Doctorate",
]

// An `assertion`-class question — something the user ASSERTS rather than
// states. resolveFields() stamps CONFIRM on it whatever the widget is, which
// is the gate that already existed. It is the base bench answer, so no extra
// stored answer is needed to make it resolve.
export const GATE_ASSERTION_Q = "Are you authorized to work in the US?"

export const GATE_SHAPES = [
  "gate-base",
  "gate-select",
  "gate-radio-opt",
  "gate-radio-req",
  "gate-confirm",
]

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
  if (GATE_SHAPES.includes(kind)) {
    base.heading = `${kind} (synthetic gate probe)`
    base.fields = GATE_BASE_FIELDS.map((f) => ({ ...f }))
    base.btns = [{ k: "b1", l: "Submit application", r: "submit" }]
    if (kind === "gate-select") {
      base.fields.push({
        k: "s1",
        sel: '[data-aj="s1"]',
        n: "education",
        t: "select",
        l: GATE_DATUM_Q,
        req: true,
        opts: [...GATE_DATUM_OPTS],
      })
      answers.push({ question: GATE_DATUM_Q, answer: GATE_DATUM_A })
    } else if (kind === "gate-radio-opt" || kind === "gate-radio-req") {
      base.fields.push({
        k: "g1",
        t: "radio",
        l: GATE_DATUM_Q,
        ...(kind === "gate-radio-req" ? { req: true } : {}),
        o: GATE_DATUM_OPTS.map((l, i) => ({
          k: "o" + (i + 1),
          sel: '[data-aj="o' + (i + 1) + '"]',
          n: "education",
          l,
        })),
      })
      answers.push({ question: GATE_DATUM_Q, answer: GATE_DATUM_A })
    } else if (kind === "gate-confirm") {
      base.fields.push({
        k: "a1",
        sel: '[data-aj="a1"]',
        n: "work_auth",
        t: "text",
        l: GATE_ASSERTION_Q,
        req: true,
      })
      // No extra answer: GATE_ASSERTION_Q is writeBenchAnswers' base entry, so
      // the resolution comes from the same bank every other shape uses.
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
//
// THE IDS MUST BE `a-NNN`. Found 2026-07-31 while trying to make the assertion
// gate fire: resolveFields() only runs answerClass() on a row whose `source`
// matches fill-plan.mjs:306's `BANK_ID_RE = /^(a-\d+)@/`, so the bench's
// previous `bench-001` ids made a CONFIRM structurally unreachable — every
// bench answer resolved OK no matter what it said, and the class gate's cost
// read as zero because the gate never ran. A harness that cannot reproduce a
// gate is not evidence that the gate is cheap. The 900 block is used so a
// bench id can never be confused with a real stored answer.
export const BENCH_ANSWER_ID_BASE = 900

export function writeBenchAnswers(dir, extra = []) {
  const base = JSON.parse(
    JSON.stringify([
      {
        id: "a-" + BENCH_ANSWER_ID_BASE,
        question: "Are you authorized to work in the US?",
        answer: "Yes, US citizen, no sponsorship needed.",
        added: "2026-07-31",
      },
    ]),
  )
  const rows = base.concat(
    extra.map((a, i) => ({
      id: "a-" + String(BENCH_ANSWER_ID_BASE + 1 + i),
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
  const args = ["src/apply/fill-plan.mjs", slug, "--json"]
  args.push("--jobs-dir", jobsDir)
  args.push("--url", url)
  args.push("--profile", FIXTURE_PROFILE)
  args.push("--answers", answersFile)
  // PINNED, like --profile and --answers above: without this the subprocess
  // reads the machine's live docs/application-limits.yaml, and the bench's
  // gate numbers move when the USER flips an unattended_assent key (measured
  // 2026-08-21: required_assertions:true actuated gate-confirm and the gate
  // matrix read 0 defers). The path does not exist, which loadAssentPolicy
  // defines as every grant OFF — the policy every gate expectation was
  // measured under.
  args.push("--assent-limits", path.join(jobsDir, "no-assent.yaml"))
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
    gate: gateBreakdown(parsed.plan),
    plan: parsed.plan,
    planFile: path.join(jobDir, "fill-plan.js"),
  }
}

/**
 * The two plan-side gates, counted separately, because they are not the same
 * thing and readiness() does not treat them the same.
 *
 *   confirm         an ASSERTION-class bank answer the class gate stopped
 *                   short of auto-filling. Blocks readiness unconditionally.
 *   confirm-widget  ANY check-verb resolution — a checkbox or radio group,
 *                   whatever the answer's class. Blocks readiness only when
 *                   the form itself marks the field required.
 *   consent         a tickbox the user must tick themselves. Never blocks
 *                   readiness; always blocks submitReadiness.
 *
 * Counting them apart is what makes "the gate cost N turns" falsifiable — a
 * single `defers` number cannot tell you which gate you paid for. It also
 * fails loudly if the markers are ever conflated: `confirm` and
 * `confirm-widget` are DISTINCT strings on purpose (an exemption keyed on the
 * shared prefix re-marked unreviewed work-authorisation pages as ready), and
 * an exact-match count here is the harness-side witness to that.
 */
export function gateBreakdown(plan) {
  const d = plan.defer || []
  const widget = d.filter((x) => x.why === "confirm-widget")
  return {
    confirm: d.filter((x) => x.why === "confirm").length,
    confirm_widget: widget.length,
    confirm_widget_required: widget.filter((x) => x.req).length,
    consent: d.filter((x) => x.why === "consent").length,
    other: d.filter(
      (x) => !["confirm", "confirm-widget", "consent"].includes(x.why),
    ).length,
    why: d.map((x) => `${x.k}:${x.why}${x.req ? "(req)" : ""}`),
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
// M6. A measurement of a run that did not complete its fill is not a baseline,
// it is a smaller number — the fill stopped early, so every leg after the stop
// contributed nothing and `wall_ms` looks good for the worst possible reason.
//
// The specific miss: `node src/dev/bench-apply.mjs --board greenhouse`
// printed `fill: ok=2 failed=1 deferred=3` and exited 0, for eleven days. The
// one failure was the page guard aborting the whole fill, and the harness
// reported the truncated wall time as the baseline anyway.
//
// DEFERRALS ARE NOT FAILURES and this must never conflate them: a deferred
// field is the gate working (CLAUDE.md rule 6), and a run with three deferrals
// and no failures is a complete, measurable fill. Only `failed` disqualifies.
export function fillCompleteness(report, label = "fill") {
  const failures = (report?.failures || []).map((f) => ({
    k: f.k,
    how: f.how,
    why: f.why,
    stale: f.stale || false,
  }))
  return {
    label,
    complete: (report?.failed ?? 0) === 0,
    ok: report?.ok ?? 0,
    failed: report?.failed ?? 0,
    deferred: report?.deferred ?? 0,
    // Aborts, not per-field failures: the engine reports these with k="-".
    aborted: failures.some((f) => f.k === "-"),
    failures,
  }
}

/** Human-readable, and it NAMES THE FIELDS — a count alone is not actionable. */
export function fillFailureText(cs) {
  const lines = [
    `MEASUREMENT REFUSED — the ${cs.label} did not complete.`,
    `  ok=${cs.ok} failed=${cs.failed} deferred=${cs.deferred}` +
      (cs.aborted ? "   (the fill ABORTED; later items never ran)" : ""),
    `  a run whose fill failed is not a baseline, it is a smaller number.`,
  ]
  for (const f of cs.failures)
    lines.push(
      `  FAILED  ${String(f.k).padEnd(6)} how=${String(f.how).padEnd(8)}` +
        `${f.stale ? " stale" : ""}  ${f.why}`,
    )
  if (!cs.failures.length)
    lines.push(
      `  (the report counted ${cs.failed} failure(s) but listed none — ` +
        `that is itself a defect in the report)`,
    )
  return lines.join("\n")
}

export function assertFillComplete(report, label = "fill") {
  const cs = fillCompleteness(report, label)
  if (!cs.complete) {
    const e = new Error(fillFailureText(cs))
    e.completeness = cs
    throw e
  }
  return cs
}

export async function benchFill({ planFile, plan, url, behaviour, realSleep }) {
  const elements = {}
  // THE PAGE GUARD'S ANCHORS EXIST ON THE PAGE WHETHER OR NOT THE PLAN FILLS
  // THEM. `plan.pageGuard` is built from the scan's REQUIRED fields
  // (fill-plan.mjs buildPageGuard), and a required field that DEFERRED is
  // still on the form — greenhouse-step1's `#gh_long_q` is exactly that. The
  // double registered only `plan.items`, so the guard found 0 of them, the
  // engine correctly aborted with "the form is not the one the plan was built
  // for", and the harness measured the abort. Registering them is making the
  // double faithful to the page, not relaxing the guard: the guard still runs,
  // and tests/apply/bench-apply.test.mjs asserts it still fires when the
  // anchors are genuinely absent.
  for (const sel of plan.pageGuard || []) {
    elements[sel] = { kind: "input", value: "" }
  }
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

/**
 * Which fixture scan a `--page N` run measures.
 *
 * `--page` used to move the PROTOCOL column (page 1 pays a browser_navigate)
 * without moving the scan, so `--page 2` measured page 1's form and reported
 * page 2's round trips. That is the same class of bug the planner's own
 * `scan-p1.json` default has (docs/next-session-plan.md, multi-page forms
 * sharing one URL), and a harness that reproduces it silently is worse than
 * one that cannot see page 2 at all. So it REFUSES rather than falling back:
 * a page with no fixture is an error, never page 1's numbers under page 2's
 * label.
 */
export function fixtureScanPath(boardName, page = 1, dir = FIXTURE_SCANS) {
  const stepped = path.join(dir, `${boardName}-step${page}.scan.json`)
  if (fs.existsSync(stepped)) return stepped
  if (page === 1) {
    const bare = path.join(dir, `${boardName}.scan.json`)
    if (fs.existsSync(bare)) return bare
  }
  const have = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(boardName) && f.endsWith(".scan.json"))
    : []
  throw new Error(
    `no scan fixture for board=${boardName} page=${page} (looked for ` +
      `${path.basename(stepped)}). Refusing to measure a different page ` +
      `under this page's label. Available: ${have.join(", ") || "none"}`,
  )
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
    scan = JSON.parse(
      fs.readFileSync(fixtureScanPath(boardName, opts.page), "utf8"),
    )
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
    // M6. Carried on every sample rather than thrown here: the gate matrix and
    // the tests drive runOnce directly and a throw would make an incomplete
    // fill indistinguishable from a crashed harness. main() refuses to print
    // a baseline or a ledger entry when this is false — see assertMeasurable.
    fill_completeness: fillCompleteness(
      fillLeg.report,
      `accounted fill (${shape ? "shape=" + shape : "board=" + boardName})`,
    ),
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
// The gate matrix. Seven runs whose only interesting differences are the one
// field that changes between neighbours, so a delta in the three columns can
// be attributed to that field and nothing else.
//
// `baseline` names the row this row is compared against. Comparing every row
// to a single global baseline would attribute the fixture boards' own
// unrelated blockers (an unprobed required combo, two unrecognised attachment
// slots) to the gate.
// ---------------------------------------------------------------------------
export const GATE_MATRIX = [
  {
    id: "greenhouse-p1",
    board: "greenhouse",
    page: 1,
    baseline: null,
    claim: "0 added turns: the page was already not-ready for other reasons",
  },
  {
    id: "greenhouse-p2",
    board: "greenhouse",
    page: 2,
    baseline: null,
    claim: "0 added turns: the optional EEO block",
  },
  {
    id: "gate-base",
    shape: "gate-base",
    baseline: null,
    claim: "the floor — three profile facts, no gate fires, ready=true",
  },
  {
    id: "gate-select",
    shape: "gate-select",
    baseline: "gate-base",
    claim: "0 added turns: the same question as a <select> just fills",
  },
  {
    id: "gate-radio-opt",
    shape: "gate-radio-opt",
    baseline: "gate-select",
    claim: "0 added turns: an OPTIONAL widget defer is exempt from readiness",
  },
  {
    id: "gate-radio-req",
    shape: "gate-radio-req",
    baseline: "gate-select",
    claim: "the number under test: a REQUIRED widget the bank CAN answer",
  },
  {
    id: "gate-confirm",
    shape: "gate-confirm",
    baseline: "gate-base",
    claim: "the pre-existing class gate, for comparison — an assertion as text",
  },
]

export async function runGateMatrix({ board, jobsDir, runs, profileName }) {
  const rows = []
  for (const spec of GATE_MATRIX) {
    const samples = []
    for (let i = 0; i < runs; i++) {
      samples.push(
        await runOnce({
          boardName: spec.board ?? "greenhouse",
          shape: spec.shape ?? null,
          page: spec.page ?? 1,
          profileName,
          board,
          jobsDir,
        }),
      )
    }
    const sum = summarize(samples)
    rows.push({ ...spec, summary: sum })
  }
  for (const r of rows) {
    const b = r.baseline && rows.find((x) => x.id === r.baseline)
    r.delta = b
      ? {
          round_trips:
            r.summary.columns.round_trips.value -
            b.summary.columns.round_trips.value,
          sleep_ms:
            r.summary.columns.sleep_ms.value - b.summary.columns.sleep_ms.value,
          model_turns:
            r.summary.columns.model_turns.value -
            b.summary.columns.model_turns.value,
          added_steps: r.summary.columns.model_turns.steps.filter(
            (s) => !b.summary.columns.model_turns.steps.includes(s),
          ),
        }
      : null
  }
  return rows
}

function printGate(rows) {
  const L = (s) => process.stdout.write(s + "\n")
  L("")
  L("gate cost matrix — what a CONFIRM and a confirm-widget defer cost")
  L("")
  L(
    "row               ready  gate(c/w/wreq/cons)  trips  sleep  turns   vs baseline",
  )
  L("-".repeat(94))
  for (const r of rows) {
    const c = r.summary.columns
    const g = r.summary.plan.gate
    const d = r.delta
    L(
      `${r.id.padEnd(17)} ${String(r.summary.plan.ready).padEnd(6)} ` +
        `${`${g.confirm}/${g.confirm_widget}/${g.confirm_widget_required}/${g.consent}`.padEnd(20)} ` +
        `${String(c.round_trips.value).padEnd(6)} ${String(c.sleep_ms.value).padEnd(6)} ` +
        `${String(c.model_turns.value).padEnd(7)} ` +
        (d
          ? `${r.baseline}: ${signed(d.round_trips)}/${signed(d.sleep_ms)}/${signed(d.model_turns)}`
          : "—"),
    )
  }
  L("")
  L("per row: what fired, and what it cost")
  for (const r of rows) {
    L(`  ${r.id}`)
    L(`    claim   ${r.claim}`)
    L(`    defers  ${r.summary.plan.gate.why.join(", ") || "none"}`)
    L(`    reason  ${r.summary.plan.reason ?? "(ready)"}`)
    if (r.delta) {
      L(
        `    DELTA   round_trips ${signed(r.delta.round_trips)}  ` +
          `sleep_ms ${signed(r.delta.sleep_ms)}  ` +
          `model_turns ${signed(r.delta.model_turns)}` +
          (r.delta.added_steps.length
            ? `  (added: ${r.delta.added_steps.join(", ")})`
            : ""),
      )
    }
  }
  L("")
  L(
    "model_turns is DERIVED from the PROTOCOL step list, not clocked — each\n" +
      "added step names the SKILL.md line that prescribes it, so a reader who\n" +
      "thinks a step is unnecessary on this path can say which one and why.",
  )
  L("")
}

const signed = (n) => (n > 0 ? `+${n}` : String(n))

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
      gate: first.plan.gate,
    },
    fill_report: {
      ok: first.fill.report.ok,
      failed: first.fill.report.failed,
      deferred: first.fill.report.deferred,
      complete: first.fill_completeness.complete,
      failures: first.fill_completeness.failures,
    },
    // Every sample, not just the first — an intermittent failure on run 4 of 5
    // is the exact thing a median hides.
    fill_completeness: samples.map((s) => s.fill_completeness),
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
// The optional browser leg (--browser). WIRED 2026-07-31 (qa-breaker).
//
// It was a stub for two waves and three agents were blocked on it, so what it
// does and does not claim is written here rather than inferred.
//
// WHAT IT MEASURES, and how. The accounted harness above records the ARGUMENT
// of every wait; it cannot record what a wait COSTS, because a conditional
// wait costs whatever the DOM takes to satisfy it. So this leg wraps a real
// Playwright page in `clockedPage()` — a thin recorder that times each wait
// instead of replacing it — and runs the real engines against the real
// loopback fixture through it. Every number it reports is a wall clock over
// product code, not a model of one.
//
// The one thing it must never become is a second opinion generator: a leg that
// silently reported zeros when the scan failed would look like the fast path.
// Every sub-leg is individually try/caught and records `error` with the
// message; a leg that did not run reports null and says so, exactly like the
// unmeasured list it is closing entries out of.
//
// IT ONLY EVER POINTS AT LOOPBACK. The URL comes from the fixture server's own
// pageUrl(), and launchBrowser()'s session.goto re-checks it against
// assertAllowedTarget — so this cannot be aimed at an employer by editing one
// argument.
// ---------------------------------------------------------------------------

// A recorder, not a double. It forwards to the real page and times the calls
// whose COST is the thing this harness could not previously see. Two buckets,
// kept apart for the same reason the three columns are:
//   slept_ms      — waitForTimeout: a flat sleep, paid in full, every time.
//   conditional_ms — waitFor/waitForLoadState/waitForSelector: paid only until
//                    the DOM satisfies it, which is the number the source
//                    cannot tell you and the accounted harness reports as the
//                    ceiling.
export function clockedPage(page) {
  const cost = {
    slept_ms: 0,
    conditional_ms: 0,
    conditional_calls: 0,
    conditional_ceiling_ms: 0,
    // How many conditional waits ended on their TIMEOUT rather than on the
    // condition they were waiting for. This is the only load-independent way
    // to ask "did this wait pay its ceiling": the elapsed wall clock is not,
    // because it also counts protocol overhead the timeout does not govern,
    // so on a loaded machine a wait that resolved early can still measure
    // longer than its own ceiling. Asserting on the durations is what made
    // tests/apply/bench-apply.test.mjs flake under a contended full run.
    conditional_timeouts: 0,
    cdp_calls: 0,
    waits: [],
    // UNCAPPED, unlike `waits`. `waits` is a 60-entry sample for a human to
    // read; a fill on a combo-heavy form blows past that, and the one column
    // that has to be attributable — post-upload remount — is paid by waits
    // that can land anywhere in the sequence. Keyed `selector::state`, so a
    // caller can sum a subset (the `data-ajup` detach waits ARE the remount
    // cost) without the recorder needing to know what an upload is.
    by_target: {},
  }
  const bucket = (key, ms, ceiling) => {
    const b = (cost.by_target[key] ||= { n: 0, ms: 0, ceiling_ms: 0 })
    b.n++
    b.ms = round(b.ms + ms)
    b.ceiling_ms += ceiling || 0
  }
  const clock = async (label, ceiling, fn, sel = null) => {
    const t = performance.now()
    let timedOut = false
    try {
      return await fn()
    } catch (e) {
      // Playwright throws TimeoutError, and only TimeoutError, when the
      // condition never became true within the ceiling. Any other throw is
      // the wait failing for some other reason and is not a timeout. The
      // error is re-thrown untouched — the caller decides what it means.
      if (e && e.name === "TimeoutError") timedOut = true
      throw e
    } finally {
      const ms = performance.now() - t
      cost.conditional_ms += ms
      cost.conditional_calls++
      cost.conditional_ceiling_ms += ceiling || 0
      if (timedOut) cost.conditional_timeouts++
      bucket((sel ?? "-") + "::" + label, ms, ceiling)
      if (cost.waits.length < 60)
        cost.waits.push({
          label,
          sel,
          ms: round(ms),
          ceiling_ms: ceiling || null,
          timedOut,
        })
    }
  }
  const wrapLocator = (loc, sel = null) =>
    new Proxy(loc, {
      get(t, p, r) {
        const v = Reflect.get(t, p, r)
        if (p === "waitFor" && typeof v === "function") {
          return (o = {}) =>
            clock(
              "locator.waitFor:" + (o.state || "visible"),
              o.timeout,
              () => v.call(t, o),
              sel,
            )
        }
        if (p === "first" || p === "last" || p === "nth") {
          return (...a) => wrapLocator(v.apply(t, a), sel)
        }
        if (typeof v === "function") {
          return (...a) => {
            cost.cdp_calls++
            return v.apply(t, a)
          }
        }
        return v
      },
    })
  const proxy = new Proxy(page, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r)
      if (p === "waitForTimeout" && typeof v === "function") {
        return async (ms) => {
          const t0 = performance.now()
          await v.call(t, ms)
          cost.slept_ms += performance.now() - t0
        }
      }
      if (p === "waitForLoadState" && typeof v === "function") {
        return (...a) =>
          clock("waitForLoadState:" + (a[0] ?? "load"), null, () =>
            v.apply(t, a),
          )
      }
      if (p === "waitForSelector" && typeof v === "function") {
        return (...a) =>
          clock(
            "waitForSelector",
            a[1]?.timeout,
            () => v.apply(t, a),
            String(a[0]),
          )
      }
      if (p === "locator" && typeof v === "function") {
        return (...a) => {
          cost.cdp_calls++
          return wrapLocator(v.apply(t, a), String(a[0]))
        }
      }
      if (typeof v === "function") {
        return (...a) => {
          cost.cdp_calls++
          return v.apply(t, a)
        }
      }
      return v
    },
  })
  return { page: proxy, cost }
}

// The unmeasured ids this leg can close. Named as a constant so the CLI, the
// summary and the tests all agree on what --browser is claiming; a hand-kept
// list in three places is how a closed entry stays printed as open.
export const BROWSER_CLOSES = [
  "conditional_wait_actual",
  "cdp_latency",
  "label_resolution",
  "page_side_scanner",
  "csp_enforcement",
]

export async function benchBrowser({ board, boardName, pings = 20 } = {}) {
  const { launchBrowser } = await import("../apply/browser.mjs")
  const out = { ran: false, board: boardName, legs: {}, closes: [] }
  let session
  try {
    session = await launchBrowser({ headless: true })
  } catch (e) {
    return { ...out, error: String(e.message).split("\n")[0].slice(0, 160) }
  }
  out.ran = true
  const url = board.pageUrl(boardName)
  out.url = url
  try {
    // --- nav: a real navigation to the loopback fixture -------------------
    const t0 = performance.now()
    const resp = await session.goto(url)
    out.legs.nav = {
      ms: round(performance.now() - t0),
      status: resp ? resp.status() : null,
      method: "measured",
    }

    // --- cdp_latency: what ONE Playwright round trip actually costs -------
    // The derived round_trips column counts calls; it has never been able to
    // price one. n is reported so a single sample cannot be quoted as a rate.
    const pings_ms = []
    for (let i = 0; i < pings; i++) {
      const t = performance.now()
      await session.page.evaluate(() => 1)
      pings_ms.push(performance.now() - t)
    }
    out.legs.cdp_round_trip = { ...stats(pings_ms), method: "measured" }
    out.closes.push("cdp_latency")

    // --- the real scan, through the clock ---------------------------------
    const { page: clocked, cost } = clockedPage(session.page)
    try {
      const t = performance.now()
      const res = await scanPage(clocked)
      const ms = performance.now() - t
      const { scan } = unwrapScan(res)
      out.legs.scan = {
        ms: round(ms),
        method: "measured",
        fields: scan?.fields?.length ?? null,
        kind: scan?.kind ?? null,
        probe: scan?.probe ?? null,
        conditional_actual_ms: round(cost.conditional_ms),
        conditional_ceiling_ms: cost.conditional_ceiling_ms,
        conditional_timeouts: cost.conditional_timeouts,
        slept_ms: round(cost.slept_ms),
        cdp_calls: cost.cdp_calls,
        waits: cost.waits,
      }
      out.closes.push("conditional_wait_actual")

      // --- label_resolution: does the real DOM produce the labels the
      // committed scan fixture claims? A fixture that has drifted from its
      // page makes every accounted number above a measurement of fiction,
      // so this is a fixture-drift detector as much as a browser leg.
      try {
        const fixture = JSON.parse(
          fs.readFileSync(fixtureScanPath(boardName, 1), "utf8"),
        )
        // JOIN KEY. Three wrong choices were tried before this one and each
        // produced a confident, false answer, which is why the reasoning is
        // written down rather than the result:
        //   f.label — the wire key is `l`. Reported NINE phantom mismatches.
        //   f.k     — assigned in DOM order, so one inserted field renames
        //             every later key and the whole form reads as drift.
        //   f.sel   — a react-select combo has NO selector: greenhouse-step1
        //             has two such fields (f1 "Country *", g1 the work
        //             authorisation radio group), they both key on
        //             `undefined`, the Map collapses them into one, and the
        //             leg reports a mismatch that is its own bug.
        // So: selector when there is one, else the form control's name, else
        // the label itself — and the count of unjoinable fields is reported,
        // because a join that silently drops rows is the same failure again.
        const joinKey = (f) =>
          f.sel || (f.n ? "name:" + f.n : f.l ? "label:" + f.l : null)
        const live = new Map()
        let liveUnjoinable = 0
        for (const f of scan?.fields ?? []) {
          const k = joinKey(f)
          if (k === null) liveUnjoinable++
          else live.set(k, f.l ?? null)
        }
        const rows = []
        let fixtureUnjoinable = 0
        for (const f of fixture.fields ?? []) {
          const k = joinKey(f)
          if (k === null) {
            fixtureUnjoinable++
            continue
          }
          const got = live.has(k) ? live.get(k) : undefined
          if (got !== (f.l ?? null))
            rows.push({
              key: k,
              fixture: f.l ?? null,
              live: got === undefined ? "(no such field live)" : got,
            })
        }
        out.legs.label_resolution = {
          method: "measured",
          fixture_fields: (fixture.fields ?? []).length,
          live_fields: (scan?.fields ?? []).length,
          unjoinable: { fixture: fixtureUnjoinable, live: liveUnjoinable },
          mismatches: rows.slice(0, 20),
          agree: rows.length === 0 && !fixtureUnjoinable && !liveUnjoinable,
        }
        out.closes.push("label_resolution")
      } catch (e) {
        out.legs.label_resolution = {
          method: "unmeasured",
          error: String(e.message).slice(0, 160),
        }
      }
    } catch (e) {
      out.legs.scan = {
        method: "unmeasured",
        error: String(e.message).split("\n")[0].slice(0, 160),
      }
    }

    // --- page_side_scanner: __ajScan(true), the PROBE path -----------------
    // Neither engine calls it (both pass false), so its 200ms + 80ms x
    // MAX_PROBE sleeps have never appeared in any column. This is the only
    // place they can be clocked, because they only exist page-side.
    try {
      const t = performance.now()
      // __ajScan is `async (PROBE = true) =>` — awaited, or the probe sleeps
      // are not in the clock and `.fields` is read off a Promise.
      const probed = await session.page.evaluate(async () => {
        if (typeof window.__ajScan !== "function") return null
        const s = await window.__ajScan(true)
        return { fields: (s.fields || []).length, probe: s.probe ?? null }
      })
      out.legs.page_side_probe = probed
        ? { ms: round(performance.now() - t), method: "measured", ...probed }
        : {
            method: "unmeasured",
            error: "window.__ajScan was not installed on this page",
          }
      if (probed) out.closes.push("page_side_scanner")
    } catch (e) {
      out.legs.page_side_probe = {
        method: "unmeasured",
        error: String(e.message).split("\n")[0].slice(0, 160),
      }
    }

    // --- csp_enforcement: the gotcha, executed instead of asserted --------
    // "The bootstrap loads by filename, never addScriptTag" is a load-bearing
    // rule (CLAUDE.md, Gotchas A) whose evidence was a served header. On the
    // ashby fixture the policy is nonce-based, so addScriptTag must be
    // REFUSED while page.evaluate over CDP still works. Both halves are
    // recorded; one without the other proves nothing.
    try {
      const csp = ROUTES.find((r) => r.name === "ashby" && r.csp)
      if (!csp) throw new Error("no csp fixture route named ashby")
      await session.goto(board.pageUrl("ashby"))
      let injected = null
      try {
        await session.page.addScriptTag({ content: "window.__ajCsp = 1" })
        injected = await session.page.evaluate(() => window.__ajCsp ?? null)
      } catch (e) {
        injected = "refused: " + String(e.message).split("\n")[0].slice(0, 80)
      }
      const viaCdp = await session.page.evaluate(() => {
        window.__ajCdp = 1
        return window.__ajCdp
      })
      out.legs.csp = {
        method: "measured",
        add_script_tag_result: injected,
        add_script_tag_blocked: injected !== 1,
        page_evaluate_works: viaCdp === 1,
      }
      out.closes.push("csp_enforcement")
    } catch (e) {
      out.legs.csp = {
        method: "unmeasured",
        error: String(e.message).split("\n")[0].slice(0, 160),
      }
    }
  } finally {
    await session.close()
  }
  out.still_unmeasured = BROWSER_CLOSES.filter((id) => !out.closes.includes(id))
  return out
}

// ---------------------------------------------------------------------------
// The browser FILL leg (--browser-fill). Phase 0.9 / baseline B1.
//
// `--browser` clocks the SCAN in a real browser. Nothing has ever clocked the
// FILL in one, and the fill is where the plan says the time is: the accounted
// harness can only report the ARGUMENT of a wait and the CEILING of a
// conditional one, and both of the fill's largest suspected terms — the
// post-upload remount settle and the combo strategy ladder — are conditional.
// A ceiling is not a cost. This leg is the only place the difference is
// visible.
//
// THREE COLUMNS, REPORTED SEPARATELY, for the same reason the top-level three
// are (see the file header):
//
//   fill_wall_ms            measured. Wall clock over fillPage() only — the
//                           scan and the plan are timed as their own legs, so
//                           this is not a sum with anything.
//   unconditional_sleep_ms  measured. Flat page.waitForTimeout, paid in full
//                           every time regardless of what the DOM does. This
//                           is the term that is removable by editing code.
//                           SINCE 2026-08-10 it also carries the settle stage's
//                           poll gaps, which are flat sleeps between two
//                           observations of the page — see settle_ms, which
//                           reports that stage's whole wall cost separately so
//                           the two are never inferred from each other.
//   settle_ms               measured, by the ENGINE, and read off its report
//                           (`report.settle`) rather than reconstructed here.
//                           One stage now covers what used to be a per-upload
//                           `detached` wait plus a flat pre-verify sleep: it
//                           watches the stamped inputs and the board's
//                           validation text and ends on whichever evidence
//                           arrives, or on its ceiling. `settle_uploads` and
//                           `settle_quiet` say which arm resolved, so a
//                           ceiling paid in full is never read as a settle
//                           time — the mistake B1 had to correct about the
//                           column below.
//   post_upload_remount_ms  UNMEASURED since 2026-08-10, and null with a
//                           reason. It attributed the `detached` wait on each
//                           upload's own `data-ajup` stamp, by selector out of
//                           clockedPage's `by_target`. B1 measured that wait
//                           settling by TIMEOUT on all three boards in every
//                           run — 2,014.58ms of a 2,753.73ms Greenhouse fill,
//                           i.e. a ceiling paid in full and not a remount cost
//                           at all — so the engine no longer waits per upload
//                           and there is nothing left to attribute. The
//                           attribution code below is KEPT, not deleted: if a
//                           per-upload wait ever comes back it is measured the
//                           day it does, instead of arriving unpriced.
//
// ONE REAL FILE UPLOAD, and it is verified rather than assumed: after the fill
// the leg reads `input[type=file].files.length` back out of the real DOM. A
// remount cost measured on an upload that never attached anything would be a
// measurement of nothing, and setInputFiles fails silently often enough that
// this had to be checked rather than trusted. The bytes are a placeholder PDF
// in a temp dir — never a document out of profile/.
//
// It runs fill-engine.mjs directly (the brief's ask), NOT the generated
// bootstrap; benchFill above covers the bootstrap path, and running both means
// a divergence between them would show as a number rather than hide.
//
// LOOPBACK ONLY: the URL comes from the fixture server's own pageUrl() and
// session.goto re-checks it against assertAllowedTarget. Nothing here clicks:
// fill-engine.mjs has no verb that presses a button (its own header says so),
// so this cannot submit even by accident.
export async function benchBrowserFill({
  board,
  boardName = "greenhouse",
  jobsDir,
  page: pageNo = 1,
} = {}) {
  const { launchBrowser } = await import("../apply/browser.mjs")
  const fillPage = (await import("../apply/fill-engine.mjs")).default
  const out = { ran: false, board: boardName, page: pageNo, legs: {} }
  let session
  try {
    session = await launchBrowser({ headless: true })
  } catch (e) {
    return { ...out, error: String(e.message).split("\n")[0].slice(0, 160) }
  }
  out.ran = true
  const url = board.pageUrl(boardName)
  out.url = url
  try {
    const t0 = performance.now()
    const resp = await session.goto(url)
    out.legs.nav = {
      ms: round(performance.now() - t0),
      status: resp ? resp.status() : null,
      method: "measured",
    }

    // --- scan the REAL dom, so the plan is built for the page we will fill --
    // Deliberately not the committed scan fixture: a plan built off a stale
    // fixture would fail the page guard and produce exactly the truncated
    // measurement M6 is about.
    const tScan = performance.now()
    const scanRes = await scanPage(session.page)
    const scanMs = performance.now() - tScan
    const { scan } = unwrapScan(scanRes)
    if (!scan || !(scan.fields || []).length)
      throw new Error("the live scan found no fields; nothing to fill")
    scan.url = url
    out.legs.scan = {
      ms: round(scanMs),
      method: "measured",
      fields: scan.fields.length,
    }

    // --- real bytes on disk, so the upload verb has something to attach ----
    const filesDir = path.join(jobsDir, "_bfiles")
    fs.mkdirSync(filesDir, { recursive: true })
    const resume = path.join(filesDir, "resume.pdf")
    const cover = path.join(filesDir, "cover-letter.pdf")
    fs.writeFileSync(resume, "%PDF-1.4 bench placeholder resume\n%%EOF\n")
    fs.writeFileSync(cover, "%PDF-1.4 bench placeholder cover\n%%EOF\n")
    const answersFile = writeBenchAnswers(jobsDir)

    const planLeg = benchPlan({
      scan,
      url,
      jobsDir,
      slug: "bench-browser",
      files: { resume, cover },
      answersFile,
    })
    const uploads = (planLeg.plan.items || []).filter(
      (i) => i.how === "upload",
    ).length
    out.legs.plan = {
      ms: round(planLeg.ms),
      method: "measured",
      items: planLeg.items,
      defers: planLeg.defers,
      uploads,
      page_guard: (planLeg.plan.pageGuard || []).length,
    }
    if (uploads < 1)
      throw new Error(
        "the plan carries no upload item, so this leg cannot measure a real " +
          "file upload — refusing to report a remount cost of zero",
      )

    // --- the fill, through the clock --------------------------------------
    const { page: clocked, cost } = clockedPage(session.page)
    const tFill = performance.now()
    const report = await fillPage(clocked, planLeg.plan)
    const fillMs = performance.now() - tFill

    // Attribution by selector, not by subtraction. Every `detached` wait on an
    // upload stamp; there is one per upload item.
    let remount = { n: 0, ms: 0, ceiling_ms: 0 }
    for (const [key, b] of Object.entries(cost.by_target)) {
      if (!/data-ajup/.test(key)) continue
      if (!/::locator\.waitFor:detached$/.test(key)) continue
      remount = {
        n: remount.n + b.n,
        ms: round(remount.ms + b.ms),
        ceiling_ms: remount.ceiling_ms + b.ceiling_ms,
      }
    }

    // --- did a file ACTUALLY attach, and to the RIGHT input? --------------
    //
    // Both halves, because the first one alone passes on the bug it found.
    // `data-ajup` is read back too: the engine stamps each upload with its own
    // tag, so a stamp landing twice on one input is visible here and nowhere
    // else — the fill report cannot see it (it counts setInputFiles calls that
    // did not throw) and neither can the accounted harness (its double has no
    // ancestor text to walk). See UPLOAD-MISDIRECTION in the report.
    const attached = await session.page.evaluate(() =>
      [...document.querySelectorAll("input[type=file]")].map((el) => ({
        id: el.id || el.name || null,
        ajup: el.getAttribute("data-ajup"),
        files: el.files ? el.files.length : 0,
        names: el.files ? [...el.files].map((f) => f.name) : [],
      })),
    )
    const filesAttached = attached.reduce((a, b) => a + b.files, 0)
    const inputsWithFiles = attached.filter((a) => a.files > 0).length
    out.upload_integrity = {
      method: "measured",
      planned: uploads,
      files_attached: filesAttached,
      inputs_with_files: inputsWithFiles,
      // One upload item per input, one file per item. Anything else means an
      // item's file went somewhere its plan did not say.
      ok: inputsWithFiles === uploads && filesAttached === uploads,
      per_input: attached,
    }

    // The settle stage, read off the engine's own report. Reported even when
    // absent (an older engine, or a fill that touched nothing and settled
    // nothing) — as null with a method, never as a zero that would average in.
    const settle = report.settle || null
    out.legs.fill = {
      method: "measured",
      fill_wall_ms: round(fillMs),
      unconditional_sleep_ms: round(cost.slept_ms),
      settle_ms: settle ? round(settle.ms) : null,
      settle_method: settle ? "measured" : "unmeasured",
      ...(settle
        ? { settle_quiet: settle.quiet, settle_uploads: settle.uploads }
        : {
            settle_why:
              "the fill report carries no `settle` — nothing waited, or an " +
              "engine that predates the stage",
          }),
      // Null-with-a-reason whenever no per-upload wait was issued at all,
      // which is every run since the engine stopped issuing them. A 0 here
      // would average into a distribution as if it were a fast remount.
      post_upload_remount_ms: remount.n ? remount.ms : null,
      ...(remount.n
        ? {}
        : {
            post_upload_remount_method: "unmeasured",
            post_upload_remount_why:
              "the engine issues no per-upload `detached` wait; the window a " +
              "board gets to react is now the settle stage — see settle_ms",
          }),
      post_upload_remount_ceiling_ms: remount.ceiling_ms,
      post_upload_remount_waits: remount.n,
      conditional_total_ms: round(cost.conditional_ms),
      conditional_ceiling_ms: cost.conditional_ceiling_ms,
      cdp_calls: cost.cdp_calls,
      // DERIVED, and labelled so: wall minus the two clocked wait buckets. It
      // is what is left after the waiting, i.e. CDP time plus engine logic.
      non_wait_ms: {
        value: round(fillMs - cost.slept_ms - cost.conditional_ms),
        method: "derived",
        from: "fill_wall_ms - unconditional_sleep_ms - conditional_total_ms",
      },
      uploads_planned: uploads,
      files_attached: filesAttached,
      file_inputs: attached,
      ok: report.ok,
      failed: report.failed,
      deferred: report.deferred,
      waits: cost.waits,
    }
    out.completeness = fillCompleteness(
      report,
      `browser fill (board=${boardName})`,
    )
    if (filesAttached < 1) {
      // Not an exception: the fill numbers are still real, but the remount
      // column is not, and saying so beats dropping the whole leg.
      out.legs.fill.post_upload_remount_ms = null
      out.legs.fill.post_upload_remount_method = "unmeasured"
      out.legs.fill.post_upload_remount_why =
        "no file ever attached to any input[type=file]; a remount cost " +
        "measured on an upload that did not happen is a measurement of nothing"
    }
  } catch (e) {
    out.error = String(e.message).split("\n")[0].slice(0, 200)
  } finally {
    await session.close()
  }
  return out
}

function printBrowserFill(b) {
  const L = (s) => process.stdout.write(s + "\n")
  L("")
  if (!b.ran) {
    L(`browser-fill leg: DID NOT RUN — ${b.error}`)
    return
  }
  L(`browser-fill leg — real Chromium, real upload, against ${b.url}`)
  const g = b.legs
  if (g.nav) L(`  nav                 ${g.nav.ms} ms   (HTTP ${g.nav.status})`)
  if (g.scan)
    L(`  scan (live DOM)     ${g.scan.ms} ms   fields=${g.scan.fields}`)
  if (g.plan)
    L(
      `  plan                ${g.plan.ms} ms   items=${g.plan.items} defer=${g.plan.defers} ` +
        `uploads=${g.plan.uploads} pageGuard=${g.plan.page_guard}`,
    )
  if (!g.fill) {
    L(`  fill                DID NOT RUN — ${b.error}`)
    return
  }
  const f = g.fill
  L("")
  L("  column                    value    method      note")
  L("  " + "-".repeat(76))
  L(
    `  fill_wall_ms              ${String(f.fill_wall_ms).padEnd(8)} measured    fillPage() only, real Chromium`,
  )
  L(
    `  unconditional_sleep_ms    ${String(f.unconditional_sleep_ms).padEnd(8)} measured    flat waitForTimeout, paid in full`,
  )
  L(
    `  post_upload_remount_ms    ${String(f.post_upload_remount_ms ?? "null").padEnd(8)} ` +
      `${(f.post_upload_remount_method || "measured").padEnd(11)} ` +
      (f.post_upload_remount_why
        ? f.post_upload_remount_why.slice(0, 60)
        : `${f.post_upload_remount_waits} detach wait(s) of a ${f.post_upload_remount_ceiling_ms} ms ceiling`),
  )
  L(
    `  conditional_total_ms      ${String(f.conditional_total_ms).padEnd(8)} measured    of a ${f.conditional_ceiling_ms} ms ceiling`,
  )
  L(
    `  non_wait_ms               ${String(f.non_wait_ms.value).padEnd(8)} derived     ${f.non_wait_ms.from}`,
  )
  L("")
  const ui = b.upload_integrity
  L(
    `  upload: planned=${f.uploads_planned} files_attached=${f.files_attached} ` +
      `[${f.file_inputs.map((i) => `${i.id} ajup=${i.ajup ?? "-"} files=${i.files}${i.names.length ? " " + i.names.join(",") : ""}`).join("  |  ")}]`,
  )
  if (ui && !ui.ok)
    L(
      `  *** UPLOAD MISDIRECTION: ${ui.planned} upload item(s) planned but only ` +
        `${ui.inputs_with_files} input(s) received a file. The remount and wall ` +
        `columns above are still real; the upload ROUTING is not. ***`,
    )
  L(
    `  fill: ok=${f.ok} failed=${f.failed} deferred=${f.deferred}  cdp_calls=${f.cdp_calls}`,
  )
  L("")
}

function printBrowser(b) {
  const L = (s) => process.stdout.write(s + "\n")
  L("")
  if (!b.ran) {
    L(`browser leg: DID NOT RUN — ${b.error}`)
    return
  }
  L(`browser leg — real Chromium against ${b.url}`)
  const g = b.legs
  if (g.nav) L(`  nav                 ${g.nav.ms} ms   (HTTP ${g.nav.status})`)
  if (g.cdp_round_trip)
    L(
      `  cdp round trip      ${round(g.cdp_round_trip.median)} ms median  ` +
        `(n=${g.cdp_round_trip.n}, ${round(g.cdp_round_trip.min)}–${round(g.cdp_round_trip.max)}, sd ${g.cdp_round_trip.stddev})`,
    )
  if (g.scan)
    L(
      g.scan.error
        ? `  scan                DID NOT RUN — ${g.scan.error}`
        : `  scan (real DOM)     ${g.scan.ms} ms   fields=${g.scan.fields}  ` +
            `conditional actual=${g.scan.conditional_actual_ms} ms of a ` +
            `${g.scan.conditional_ceiling_ms} ms ceiling, flat sleep=${g.scan.slept_ms} ms`,
    )
  if (g.label_resolution)
    L(
      g.label_resolution.error
        ? `  label resolution    DID NOT RUN — ${g.label_resolution.error}`
        : `  label resolution    ${g.label_resolution.agree ? "fixture AGREES with the live DOM" : `DRIFT: ${g.label_resolution.mismatches.length} field(s) differ`}` +
            ` (fixture ${g.label_resolution.fixture_fields}, live ${g.label_resolution.live_fields}` +
            (g.label_resolution.unjoinable.fixture ||
            g.label_resolution.unjoinable.live
              ? `, unjoinable f=${g.label_resolution.unjoinable.fixture}/l=${g.label_resolution.unjoinable.live}`
              : "") +
            ")",
    )
  if (g.page_side_probe)
    L(
      g.page_side_probe.error
        ? `  page-side probe     DID NOT RUN — ${g.page_side_probe.error}`
        : `  page-side probe     ${g.page_side_probe.ms} ms  fields=${g.page_side_probe.fields}  (__ajScan(true), the path neither engine takes)`,
    )
  if (g.csp)
    L(
      g.csp.error
        ? `  csp enforcement     DID NOT RUN — ${g.csp.error}`
        : `  csp enforcement     addScriptTag blocked=${g.csp.add_script_tag_blocked}, ` +
            `page.evaluate works=${g.csp.page_evaluate_works}`,
    )
  L(`  closed: ${b.closes.join(", ") || "(none)"}`)
  if (b.still_unmeasured.length)
    L(`  STILL UNMEASURED: ${b.still_unmeasured.join(", ")}`)
  L("")
}

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
  "src/apply/scan-engine.mjs",
  "src/apply/fill-engine.mjs",
  "src/apply/fill-plan.mjs",
  // Added for baseline B1. fill-plan.mjs is the whole plan leg's wall time on
  // paper, but it SHELLS OUT and the two modules it spends that time in were
  // not hashed: answer-bank.mjs resolves every field and field-cache.mjs
  // decides whether a dropdown has to be re-probed. A plan_ms that moved
  // because one of those changed would have been unattributable, which is the
  // exact failure the file_sha1 mechanism exists to prevent.
  "src/apply/answer-bank.mjs",
  "src/apply/field-cache.mjs",
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
    browserFill: false,
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
    else if (a === "--browser-fill") o.browserFill = true
    else if (a === "--all-profiles") o.allProfiles = true
    else if (a === "--verbs") o.verbs = true
    else if (a === "--gate") o.gate = true
    else if (a === "--help" || a === "-h") o.help = true
    else throw new Error("unknown option " + a)
  }
  return o
}

const USAGE = `bench-apply.mjs — scan -> plan -> fill against the local fake ATS

  --board <greenhouse|lever|ashby>  fixture board (default greenhouse)
  --shape <combo14|combo23|richtext|gate-*>  synthetic form shape instead of a fixture
                                    gate-base / gate-select / gate-radio-opt /
                                    gate-radio-req / gate-confirm differ by ONE
                                    field, so their deltas isolate the gates
  --gate                            run the whole gate matrix and print the
                                    added cost of a CONFIRM and a confirm-widget
  --profile <best|typical|worst>    widget behaviour model (default typical)
  --page N                          which page of the form (page 1 pays a navigate)
  --all-profiles                    run all three and print the range
  --verbs                           per-verb unit costs, including the richtext
                                    ceiling the planner cannot currently reach
  --runs N                          samples (default 5); a single one is not a measurement
  --real-sleep                      actually sleep instead of accounting (proves the accounting)
  --browser                         run the real-Chromium legs against the loopback
                                    fixture: cdp round-trip cost, the scan's ACTUAL
                                    conditional wait vs its ceiling, fixture-vs-live
                                    label drift, __ajScan(true)'s page-side probe, and
                                    the Ashby nonce-CSP block. Closes 5 of the 6
                                    unmeasured entries; react_select_behaviour stays open
  --browser-fill                    run fill-engine.mjs itself in real Chromium against
                                    the loopback fixture, INCLUDING one real file upload,
                                    and report fill wall / unconditional sleep /
                                    post-upload remount as SEPARATE columns
  --json                            full record
  --ledger                          a paste-ready docs/measurements.md entry

Nothing here touches a live employer's board. See tests/fixtures/boards/README.md.`

// `browserRun` is optional and the METHOD LINE depends on it. That line used
// to say "conditional-wait actuals unmeasured (no browser)" unconditionally,
// which would have gone into docs/measurements.md as a false claim the moment
// --browser started working. A provenance line that lies about its method is
// worse than a missing number.
export function ledgerEntry(sum, prov, browserRun = null, fillRun = null) {
  const c = sum.columns
  const shape = sum.shape ? `shape=${sum.shape}` : `board=${sum.board}`
  const dirty =
    prov.dirty_measured_files && prov.dirty_measured_files.length
      ? ` (+${prov.dirty_measured_files.length} uncommitted measured file(s))`
      : ""
  const browserOk = browserRun?.ran && !browserRun.legs?.scan?.error
  const lines = [
    `- harness:  node src/dev/bench-apply.mjs --board ${sum.board}` +
      (sum.shape ? ` --shape ${sum.shape}` : "") +
      ` --profile ${sum.profile} --runs ${sum.runs}` +
      (browserRun ? " --browser" : ""),
    `- baseline: ${prov.sha}${dirty} — round_trips=${c.round_trips.value} ` +
      `sleep_ms=${c.sleep_ms.value} model_turns=${c.model_turns.value} ` +
      `wall_ms=${c.wall_ms.value}`,
    `- worst:    sleep_ms=${c.sleep_ms.worst_case_ms} ` +
      `(unconditional ${c.sleep_ms.value} + conditional ceiling ` +
      `${c.sleep_ms.conditional_ceiling_ms}) ${shape}`,
    `- method:   round_trips/model_turns derived (PROTOCOL citations); ` +
      `sleep measured by executing the engines; conditional-wait actuals ` +
      (browserOk
        ? `MEASURED in real Chromium (--browser)`
        : `unmeasured (no browser leg in this run)`),
  ]
  if (browserRun) {
    const s = browserRun.legs?.scan
    const cdp = browserRun.legs?.cdp_round_trip
    lines.push(
      `- browser:  ` +
        (browserRun.ran
          ? (s && !s.error
              ? `scan ${s.ms}ms wall, conditional ${s.conditional_actual_ms}ms ` +
                `of a ${s.conditional_ceiling_ms}ms ceiling; `
              : `scan DID NOT RUN (${s?.error}); `) +
            (cdp
              ? `cdp round trip ${round(cdp.median)}ms median n=${cdp.n}; `
              : "") +
            `closed [${browserRun.closes.join(", ")}]` +
            (browserRun.still_unmeasured?.length
              ? `; STILL OPEN [${browserRun.still_unmeasured.join(", ")}]`
              : "")
          : `DID NOT RUN — ${browserRun.error}`),
    )
  }
  if (fillRun) {
    const f = fillRun.legs?.fill
    lines.push(
      `- browserfill: ` +
        (fillRun.ran && f
          ? `fill_wall=${f.fill_wall_ms}ms (measured) ` +
            `unconditional_sleep=${f.unconditional_sleep_ms}ms (measured) ` +
            `post_upload_remount=${f.post_upload_remount_ms ?? "null"}ms ` +
            `(${f.post_upload_remount_method || "measured"}, ceiling ${f.post_upload_remount_ceiling_ms}ms) ` +
            `non_wait=${f.non_wait_ms.value}ms (derived); ` +
            `uploads=${f.uploads_planned} files_attached=${f.files_attached}` +
            (fillRun.upload_integrity && !fillRun.upload_integrity.ok
              ? ` UPLOAD-MISDIRECTION(only ${fillRun.upload_integrity.inputs_with_files} of ${fillRun.upload_integrity.planned} inputs got a file)`
              : "") +
            `; ok=${f.ok} failed=${f.failed} deferred=${f.deferred}`
          : `DID NOT RUN — ${fillRun.error}`),
    )
  }
  lines.push(
    `- bytes:    ` +
      Object.entries(prov.file_sha1)
        .map(([f, h]) => `${h} ${path.basename(f)}`)
        .join("  "),
  )
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// M6, the enforcement half. Collects every completeness verdict in a run and
// refuses the whole measurement if any of them failed.
//
// It returns rather than exits so the tests can drive it; main() is the only
// caller that turns a refusal into a non-zero status. Exit 3 and not 1: 1 is
// what an unhandled throw already gives, and "the harness crashed" and "the
// harness worked and the fill did not" are different facts.
// ---------------------------------------------------------------------------
export function collectIncomplete({ results = [], browserFill = null } = {}) {
  const bad = []
  for (const sum of results)
    for (const cs of sum.fill_completeness || []) if (!cs.complete) bad.push(cs)
  if (
    browserFill?.ran &&
    browserFill.completeness &&
    !browserFill.completeness.complete
  )
    bad.push(browserFill.completeness)
  return bad
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
  const g = sum.plan.gate
  if (g) {
    L(
      `gate: confirm=${g.confirm} confirm-widget=${g.confirm_widget} ` +
        `(required ${g.confirm_widget_required}) consent=${g.consent} other=${g.other}` +
        (g.why.length ? `  [${g.why.join(", ")}]` : ""),
    )
  }
  L(
    `fill: ok=${sum.fill_report.ok} failed=${sum.fill_report.failed} deferred=${sum.fill_report.deferred}` +
      (sum.fill_report.complete
        ? ""
        : "   *** INCOMPLETE — NOT A BASELINE ***"),
  )
  for (const f of sum.fill_report.failures || [])
    L(`  FAILED ${f.k} how=${f.how}: ${f.why}`)
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
    if (opts.gate) {
      const rows = await runGateMatrix({
        board,
        jobsDir,
        runs: opts.runs,
        profileName: opts.profile,
      })
      const prov = await provenance()
      if (opts.json) {
        process.stdout.write(
          JSON.stringify(
            {
              provenance: prov,
              rows: rows.map((r) => ({
                id: r.id,
                claim: r.claim,
                baseline: r.baseline,
                ready: r.summary.plan.ready,
                gate: r.summary.plan.gate,
                columns: {
                  round_trips: r.summary.columns.round_trips.value,
                  sleep_ms: r.summary.columns.sleep_ms.value,
                  model_turns: r.summary.columns.model_turns.value,
                  wall_ms: r.summary.columns.wall_ms.value,
                },
                steps: r.summary.columns.model_turns.steps,
                delta: r.delta,
              })),
            },
            null,
            2,
          ) + "\n",
        )
      } else {
        printGate(rows)
        process.stdout.write(`sha=${prov.sha}`)
        process.stdout.write(
          prov.dirty_measured_files?.length
            ? ` DIRTY (${prov.dirty_measured_files.length} measured file(s) uncommitted)\n`
            : " clean\n",
        )
      }
      return
    }
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
    // --browser is opt-in because it launches Chromium and costs seconds; the
    // accounted columns above are unaffected by it either way, so a run with
    // and a run without are directly comparable.
    const browserRun = opts.browser
      ? await benchBrowser({ board, boardName: opts.board })
      : null
    if (browserRun?.closes?.length) {
      for (const sum of results) {
        for (const u of sum.unmeasured) {
          if (browserRun.closes.includes(u.id)) {
            u.method = "measured"
            u.closed_by = "--browser"
          }
        }
      }
    }
    const fillRun = opts.browserFill
      ? await benchBrowserFill({ board, boardName: opts.board, jobsDir })
      : null
    const prov = await provenance()

    // M6. Before anything is printed as a baseline. `--json` still emits (a
    // machine consumer wants the failure record too) but the exit status is
    // non-zero either way, so no caller can treat an aborted fill as a run.
    const incomplete = collectIncomplete({ results, browserFill: fillRun })

    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            provenance: prov,
            browser,
            browser_run: browserRun,
            browser_fill: fillRun,
            measurable: incomplete.length === 0,
            incomplete,
            results,
          },
          null,
          2,
        ) + "\n",
      )
    } else if (opts.ledger) {
      if (incomplete.length) {
        // A ledger entry IS the artifact that outlives the run. Emitting one
        // for an aborted fill is how a wrong number becomes permanent.
        for (const cs of incomplete)
          process.stderr.write(fillFailureText(cs) + "\n\n")
        process.stderr.write(
          "REFUSING to emit a ledger entry for a run whose fill did not " +
            "complete.\n",
        )
        process.exitCode = 3
        return
      }
      for (const sum of results) {
        process.stdout.write(
          ledgerEntry(sum, prov, browserRun, fillRun) + "\n\n",
        )
      }
    } else {
      for (const sum of results) printHuman(sum)
      if (browserRun) printBrowser(browserRun)
      else
        process.stdout.write(
          browser.ok
            ? "browser leg: playwright-core present — pass --browser to run it\n"
            : `browser leg: UNAVAILABLE — ${browser.why}\n`,
        )
      if (fillRun) printBrowserFill(fillRun)
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
    if (incomplete.length) {
      for (const cs of incomplete)
        process.stderr.write("\n" + fillFailureText(cs) + "\n")
      process.stderr.write(
        "\nThis run is NOT a baseline. Fix the fill, or measure a form the " +
          "fill completes.\n",
      )
      process.exitCode = 3
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
