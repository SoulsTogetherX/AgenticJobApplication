// The fill engine is an ordinary ES module that runs Playwright-side, so these
// tests import it and run it against a fake `page`. That covers what actually
// goes wrong in this layer: ordering, guards, and one bad field taking the
// whole plan down with it.
//
// It is ALSO shipped as a string to the Playwright MCP vm (which has no working
// `import`), so a second block of tests reconstitutes it exactly the way
// scripts/apply/fill-plan.mjs's generated bootstrap does — from our own disk,
// never from the page — and proves a hostile page cannot substitute itself.
//
// Not covered here: real browser behaviour. The project has no Playwright
// dependency (a browser download this repo deliberately avoids), so the
// react-select and file-chooser strategies are verified against the local fake
// board under tests/fixtures/boards/, never a live employer.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"
import { fileURLToPath } from "node:url"
import fillPage from "../../scripts/apply/fill-engine.mjs"
import scanPage, {
  SCANNER_PATH,
  probeRefusal,
  scannerExpression,
} from "../../scripts/apply/scan-engine.mjs"
import {
  ENGINE_PATH,
  assertAllowedTarget,
  embedLiteral,
  engineSandboxSource,
  isLocalUrl,
  launchBrowser,
} from "../../scripts/apply/browser.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const ENGINE = path.join(ROOT, "scripts", "apply", "fill-engine.mjs")
const SRC = fs.readFileSync(ENGINE, "utf8")
const SCANNER_TEXT = fs.readFileSync(SCANNER_PATH, "utf8")

// The engine used to be run through a vm realm, so the objects it returned
// carried that realm's prototypes and strict deep-equality rejected them. The
// sandbox tests below still do, so keep comparing by value.
const plain = (v) => JSON.parse(JSON.stringify(v))

// --- a fake page ----------------------------------------------------------
// Records every interaction so tests can assert on ordering and on what was
// never touched.
function fakePage({ url = "https://ats.test/apply", elements = {} } = {}) {
  const log = []
  // Which element the keyboard is aimed at. Only elements that opt in with
  // `typable` / `insertable` record what the keyboard sends — a react-select
  // combo must not, or the combo fall-through tests stop exercising anything.
  let focused = null
  const mk = (sel) => {
    const spec = elements[sel]
    const loc = {
      async count() {
        return spec ? 1 : 0
      },
      async waitFor(o = {}) {
        log.push(["waitFor", sel, o.state, o.timeout])
        if (spec && spec.waitForThrows) throw new Error("timeout exceeded")
      },
      async scrollIntoViewIfNeeded() {
        log.push(["scroll", sel])
        // Fires once then clears itself: models a locator whose element goes
        // stale on first touch (a remount raced it) and is fine on the next
        // re-resolution, exactly like Ashby's async resume-autofill remount.
        if (spec && spec.throwOnScrollOnce) {
          const msg = spec.throwOnScrollOnce
          spec.throwOnScrollOnce = null
          throw new Error(msg)
        }
        // Fires every time: a genuine, persistent detachment.
        if (spec && spec.throwOnScroll) throw new Error(spec.throwOnScroll)
      },
      async click() {
        log.push(["click", sel])
        if (spec && spec.throwOnClick) throw new Error(spec.throwOnClick)
        focused = spec || null
        // Models a menu row: clicking it puts the value into the widget.
        if (spec && spec.setsOnClick) {
          const [target, value] = spec.setsOnClick
          if (elements[target]) elements[target].value = value
        }
      },
      async fill(v) {
        log.push(["fill", sel, v])
        if (spec && spec.throwOnFillOnce) {
          const msg = spec.throwOnFillOnce
          spec.throwOnFillOnce = null
          throw new Error(msg)
        }
        if (spec && spec.throwOnFill) throw new Error(spec.throwOnFill)
        spec.value = v
      },
      async selectOption(o) {
        log.push(["selectOption", sel, o.label])
        spec.value = o.label
      },
      async setInputFiles(paths) {
        log.push(["setFiles", String(paths)])
        if (spec && spec.throwOnUpload) throw new Error(spec.throwOnUpload)
      },
      async check() {
        log.push(["check", sel])
        spec.value = "true"
      },
      async uncheck() {
        log.push(["uncheck", sel])
        spec.value = ""
      },
      async evaluate(fn) {
        // kindOf vs shownValue, told apart by their source.
        const isKindOf = String(fn).includes("forbidden:")
        if (isKindOf && spec && spec.throwOnEvaluateOnce) {
          spec.throwOnEvaluateOnce = false
          throw new Error("Element is not attached to the DOM")
        }
        return isKindOf
          ? (spec && spec.kind) || "input"
          : (spec && spec.value) || ""
      },
      filter() {
        return { first: () => mk(sel + " >> option") }
      },
    }
    return loc
  }

  return {
    log,
    url: () => url,
    locator: (sel) => mk(sel),
    keyboard: {
      async type(t) {
        log.push(["type", t])
        if (focused && focused.typable)
          focused.value = (focused.value || "") + t
      },
      async insertText(t) {
        log.push(["insertText", t])
        if (focused && focused.insertable) focused.value = t
      },
      async press(k) {
        log.push(["press", k])
      },
    },
    async waitForTimeout(ms) {
      log.push(["wait", ms])
    },
    async waitForEvent() {
      log.push(["filechooser"])
      return {
        async setFiles(paths) {
          log.push(["setFiles", String(paths)])
        },
      }
    },
    async evaluate(fn, arg) {
      const src = String(fn)
      // Reading executable code back out of the page is the vulnerability this
      // engine was rewritten to remove. If it ever tries again, fail loudly
      // rather than quietly returning something.
      if (/__ajFillSrc|__ajPlan/.test(src)) {
        throw new Error(
          "the engine must never read code back out of the page: " + src,
        )
      }
      if (src.includes("data-ajup")) {
        log.push(["stampTrigger", arg.pattern, arg.tag])
        return elements[`[data-ajup="${arg.tag}"]`] !== undefined
      }
      if (src.includes("requiredEmpty")) {
        log.push(["verify", (arg || []).length])
        return { mismatch: [], errors: [], requiredEmpty: [] }
      }
      if (src.includes("__ajScan")) {
        return {
          signals: [],
          btns: [{ k: "b9", l: "Submit application", r: "submit" }],
        }
      }
      return undefined
    },
  }
}

const plan = (items, over = {}) => ({
  v: 1,
  slug: "x",
  ats: "greenhouse",
  items,
  defer: [],
  ...over,
})

// --- the shape of the module ----------------------------------------------

test("the engine is an async (page, plan) module export", () => {
  assert.equal(typeof fillPage, "function")
  assert.equal(fillPage.constructor.name, "AsyncFunction")
  assert.equal(fillPage.length, 2)
})

test("the engine is never put into the page and never read back out", () => {
  // This is the fix for the code round-trip: the engine used to stringify
  // itself onto window.__ajFillSrc, and the bootstrap read that value back out
  // of a third-party page and eval'd it Playwright-side, where `page` lives. A
  // board defining that getter therefore chose what ran with a live page
  // handle — including clicking Submit.
  const code = SRC.split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n")
  assert.ok(
    !/__ajFillSrc/.test(code),
    "the engine must not install itself into the page",
  )
  assert.ok(
    !/__ajPlan/.test(code),
    "the plan travels as an argument, never through window",
  )
  assert.ok(!/\beval\s*\(/.test(code), "the engine itself never evals anything")
  // The comment that explains why page-side injection uses CDP evaluation
  // rather than an inline <script> must survive every move of this file.
  assert.match(SRC, /addScriptTag/)
  assert.match(SRC, /nonce-based CSP/)
  assert.match(SRC, /Runtime\.evaluate/)
})

test("the engine cannot express clicking a button", () => {
  // The safety property is structural: there is no verb for it. If someone
  // adds one, this test is the thing that should stop them.
  const verbs = SRC.match(/item\.how === "(\w+)"/g) || []
  const names = new Set(verbs.map((v) => v.match(/"(\w+)"/)[1]))
  assert.deepEqual(
    [...names].sort(),
    ["check", "combo", "fill", "select", "skip", "type", "upload"],
    "verb set changed — a button-clicking verb must never be added here",
  )
  assert.ok(
    !/\bnext\b[^\n]*\.click\(/.test(SRC),
    "must never click the next/submit button",
  )
  assert.match(
    SRC,
    /deliberately no verb that clicks a button/,
    "the comment stating the safety property must survive",
  )
})

test("no bare locator calls — the sandbox has no default timeout", () => {
  // The comments discuss these APIs by name, so check the code only.
  const code = SRC.split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n")
  assert.ok(
    !/\.click\(\s*\)/.test(code),
    "every click needs an explicit timeout",
  )
  assert.ok(
    !/\bsetTimeout\s*\(/.test(code),
    "setTimeout does not exist in the vm sandbox",
  )
  assert.ok(
    !/\bwaitForEvent\s*\(/.test(code),
    "Playwright MCP owns the filechooser event; waitForEvent stalls the call",
  )
})

// --- the sandbox string (the MCP path) ------------------------------------

test("engineSandboxSource reads our own disk and evals to the same engine", () => {
  assert.equal(ENGINE_PATH, ENGINE)
  const src = engineSandboxSource()
  assert.ok(
    !/^export |^import /m.test(src),
    "the sandbox string must be script-parseable — no module syntax",
  )
  // Exactly the shape playwright-core's runCode.ts uses:
  // vm.runInContext("(" + code + ")", ctx).
  const ctx = {}
  vm.createContext(ctx)
  const fn = vm.runInContext(src, ctx)
  assert.equal(typeof fn, "function")
  assert.equal(fn.constructor.name, "AsyncFunction")
  assert.equal(fn.length, 2)
  assert.equal(fn.name, "fillPage")
})

test("a page that defines __ajFillSrc owns nothing", async () => {
  // qa-adversary's hostile board defines window.__ajFillSrc as a getter. The
  // old bootstrap read it back out and eval'd it with a live `page`. Here the
  // engine text comes off our own disk, the vm's window is hostile, and the
  // getter is never touched — reading it is an outright test failure.
  let touched = 0
  const ctx = {
    window: {
      get __ajFillSrc() {
        touched++
        return "async () => { throw new Error('pwned') }"
      },
      get __ajPlan() {
        touched++
        return { items: [] }
      },
    },
  }
  vm.createContext(ctx)
  const fn = vm.runInContext(engineSandboxSource(), ctx)
  const page = fakePage({ elements: { "#a": { kind: "input" } } })
  const out = await fn(
    page,
    plan([{ k: "f1", sel: "#a", how: "fill", value: "x" }]),
  )
  assert.equal(plain(out).ok, 1)
  assert.equal(touched, 0, "nothing may be read back out of the page")
})

test("engineSandboxSource refuses an engine that is not self-contained", () => {
  assert.throws(
    () =>
      engineSandboxSource(
        'import fs from "node:fs"\nexport default async function f() {}',
      ),
    /self-contained/,
  )
  assert.throws(
    () => engineSandboxSource("const f = async () => {}\nexport default f"),
    /named function declaration/,
  )
})

// --- behaviour -------------------------------------------------------------

test("refuses to fill a page the plan was not built for", async () => {
  const page = fakePage({ url: "https://ats.test/other" })
  const out = await fillPage(
    page,
    plan([{ k: "f1", sel: "#a", how: "fill", value: "x" }], {
      urlGuard: "https://ats.test/apply",
    }),
  )
  assert.equal(out.failed, 1)
  assert.equal(out.ok, 0)
  assert.match(out.failures[0].why, /plan built for/)
  assert.equal(page.log.length, 0, "nothing may be touched on the wrong page")
})

test("query strings and fragments do not defeat the url guard", async () => {
  const page = fakePage({
    url: "https://ats.test/apply?gh_jid=1#form",
    elements: { "#a": { kind: "input" } },
  })
  const out = await fillPage(
    page,
    plan([{ k: "f1", sel: "#a", how: "fill", value: "x" }], {
      urlGuard: "https://ats.test/apply",
    }),
  )
  assert.equal(out.ok, 1)
})

test("uploads run before anything else", async () => {
  const page = fakePage({
    elements: {
      "#name": { kind: "input" },
      '[data-ajup="u1"]': { kind: "input" },
    },
  })
  await fillPage(
    page,
    plan([
      { k: "f1", sel: "#name", how: "fill", value: "Xavier" },
      {
        k: "f2",
        how: "upload",
        labelMatch: "resume|cv",
        paths: ["C:\\r.pdf"],
      },
    ]),
  )
  const chooser = page.log.findIndex((e) => e[0] === "setFiles")
  const filled = page.log.findIndex((e) => e[0] === "fill")
  assert.ok(chooser >= 0 && filled >= 0)
  assert.ok(
    chooser < filled,
    "uploads remount the form and drop data-aj, so they must go first",
  )
})

test("each upload is located by its own label, not by a stamp", async () => {
  // The first upload remounts the form and kills every data-aj on the page, so
  // the second must be found from scratch by its surrounding text.
  const page = fakePage({
    elements: {
      '[data-ajup="u1"]': { kind: "input" },
      '[data-ajup="u2"]': { kind: "input" },
    },
  })
  const out = await fillPage(
    page,
    plan([
      { k: "f1", how: "upload", labelMatch: "resume|cv", paths: ["r.pdf"] },
      { k: "f2", how: "upload", labelMatch: "cover letter", paths: ["c.pdf"] },
    ]),
  )
  assert.equal(out.ok, 2)
  const patterns = page.log
    .filter((e) => e[0] === "stampTrigger")
    .map((e) => e[1])
  assert.deepEqual(plain(patterns), ["resume|cv", "cover letter"])
  const files = page.log.filter((e) => e[0] === "setFiles").map((e) => e[1])
  assert.deepEqual(
    plain(files),
    ["r.pdf", "c.pdf"],
    "documents must not be swapped",
  )
})

test("a missing file input is reported, not silently skipped", async () => {
  const page = fakePage({ elements: {} })
  const out = await fillPage(
    page,
    plan([
      { k: "f1", how: "upload", labelMatch: "cover letter", paths: ["c.pdf"] },
    ]),
  )
  assert.equal(out.failed, 1)
  assert.match(out.failures[0].why, /no file input left/)
})

test("refuses any element that is not a form control", async () => {
  const page = fakePage({ elements: { "#trap": { kind: "forbidden:div" } } })
  const out = await fillPage(
    page,
    plan([{ k: "f1", sel: "#trap", how: "fill", value: "x" }]),
  )
  assert.equal(out.ok, 0)
  assert.equal(out.failed, 1)
  assert.match(out.failures[0].why, /not a form control/)
  assert.ok(!page.log.some((e) => e[0] === "fill"))
})

test("one bad field does not abort the rest of the plan", async () => {
  const page = fakePage({
    elements: {
      "#a": { kind: "input" },
      "#bad": { kind: "input", throwOnFill: "detached" },
      "#c": { kind: "input" },
    },
  })
  const out = await fillPage(
    page,
    plan([
      { k: "f1", sel: "#a", how: "fill", value: "1" },
      { k: "f2", sel: "#bad", how: "fill", value: "2" },
      { k: "f3", sel: "#missing", how: "fill", value: "3" },
      { k: "f4", sel: "#c", how: "fill", value: "4" },
    ]),
  )
  assert.equal(out.ok, 2)
  assert.equal(out.failed, 2)
  assert.deepEqual(plain(out.failures.map((f) => f.k).sort()), ["f2", "f3"])
  assert.match(out.failures.find((f) => f.k === "f3").why, /no unique element/)
})

test("combo falls through strategies until the value sticks", async () => {
  const page = fakePage({ elements: { "#c": { kind: "combo", value: "" } } })
  // shownValue reads spec.value, which nothing in the fake ever sets for a
  // combo — so every strategy is tried and the failure is reported honestly.
  const out = await fillPage(
    page,
    plan([{ k: "f1", sel: "#c", how: "combo", value: "United States" }]),
  )
  assert.equal(out.failed, 1)
  const typed = page.log.filter((e) => e[0] === "type").length
  assert.ok(typed >= 1, "at least the typeahead strategy ran")
  assert.ok(page.log.some((e) => e[0] === "press" && e[1] === "Enter"))
})

test("reports the next button without ever clicking it", async () => {
  const page = fakePage({ elements: { "#a": { kind: "input" } } })
  const out = await fillPage(
    page,
    plan([{ k: "f1", sel: "#a", how: "fill", value: "x" }]),
  )
  assert.deepEqual(plain(out.next), {
    btn: "b9",
    label: "Submit application",
    role: "submit",
  })
  assert.ok(
    !page.log.some((e) => e[0] === "click" && e[1].includes("b9")),
    "the submit button is reported, never pressed",
  )
})

test("deferred items are passed through untouched and counted", async () => {
  const page = fakePage({ elements: { "#a": { kind: "input" } } })
  const out = await fillPage(
    page,
    plan([{ k: "f1", sel: "#a", how: "fill", value: "x" }], {
      defer: [
        {
          k: "f9",
          label: "I agree to the arbitration agreement",
          why: "consent",
        },
      ],
    }),
  )
  assert.equal(out.deferred, 1)
  assert.equal(out.defer[0].why, "consent")
  assert.ok(!page.log.some((e) => e[1] === "#f9"))
})

test("skip items are never touched", async () => {
  const page = fakePage({ elements: { "#a": { kind: "input" } } })
  const out = await fillPage(page, plan([{ k: "f1", sel: "#a", how: "skip" }]))
  assert.equal(out.ok, 0)
  assert.equal(out.failed, 0)
  const touched = page.log.filter(
    (e) => e[0] !== "verify" && e[0] !== "wait" && e[0] !== "waitFor",
  )
  assert.equal(touched.length, 0)
})

// --- stale-locator retry (Ashby's async resume-autofill remount) ----------
//
// The engine's per-item locate() runs right before each fill, but on Ashby
// the resume-autofill parses the uploaded PDF and remounts the form
// ASYNCHRONOUSLY, after the upload settle delay — so the remount can land
// between locate() and the interaction that follows it, detaching the
// element mid-action. Playwright reports that as "Element is not attached to
// the DOM". A stale hit is retried once with a freshly re-resolved locator;
// anything else fails immediately, and a second stale hit is still reported.

test("a stale locator is re-resolved once and the retry recovers", async () => {
  const page = fakePage({
    elements: {
      "#_systemfield_email": {
        kind: "input",
        throwOnScrollOnce: "Element is not attached to the DOM",
      },
    },
  })
  const out = await fillPage(
    page,
    plan([
      {
        k: "f3",
        sel: "#_systemfield_email",
        how: "fill",
        value: "xavier@example.com",
      },
    ]),
  )
  assert.equal(
    out.failed,
    0,
    "one retry must recover from a transient stale hit",
  )
  assert.equal(out.ok, 1)
  assert.deepEqual(plain(out.failures), [])
  const scrolls = page.log.filter((e) => e[0] === "scroll")
  assert.equal(scrolls.length, 2, "the retry re-ran scrollIntoViewIfNeeded")
  const fills = page.log.filter((e) => e[0] === "fill")
  assert.equal(fills.length, 1, "fill only runs after a successful scroll")
  assert.equal(fills[0][2], "xavier@example.com")
})

test("a non-stale error is reported immediately, never retried", async () => {
  const page = fakePage({
    elements: { "#a": { kind: "input", throwOnFill: "boom" } },
  })
  const out = await fillPage(
    page,
    plan([{ k: "f1", sel: "#a", how: "fill", value: "x" }]),
  )
  assert.equal(out.failed, 1)
  assert.equal(out.ok, 0)
  assert.equal(out.failures[0].why, "boom")
  const fills = page.log.filter((e) => e[0] === "fill")
  assert.equal(fills.length, 1, "a non-stale failure must not be retried")
})

test("a persistent stale error survives the retry and is reported, not swallowed", async () => {
  const page = fakePage({
    elements: {
      "#a": {
        kind: "input",
        throwOnScroll: "Element is not attached to the DOM",
      },
    },
  })
  const out = await fillPage(
    page,
    plan([{ k: "f1", sel: "#a", how: "fill", value: "x" }]),
  )
  assert.equal(
    out.failed,
    1,
    "a genuine, persistent failure must still surface",
  )
  assert.equal(out.ok, 0)
  assert.match(out.failures[0].why, /not attached to the dom/i)
  const scrolls = page.log.filter((e) => e[0] === "scroll")
  assert.equal(
    scrolls.length,
    3,
    "three attempts, then it stops — a BOUNDED retry, not an infinite loop. " +
      "One replay absorbed Ashby's single async remount and nothing more; a " +
      "form that remounts on a timer detaches the replay as well.",
  )
  assert.equal(
    page.log.filter((e) => e[0] === "fill").length,
    0,
    "a scroll that never succeeds must never reach fill",
  )
  assert.equal(
    out.failures[0].stale,
    true,
    "the failure is marked stale, which is what lets the verify pass overturn " +
      "it when the value turns out to have landed anyway",
  )
})

test("a stale failure whose value DID land is not reported as a failure", async () => {
  // The live Ashby incident: the form remounted between locate() and the
  // interaction, every attempt threw "not attached", and the run logged a
  // failure for a field whose value was on the page. Retries cannot settle
  // this — the locator is racing a remount that never stops. The verify pass
  // can, because it reads the DOM in ONE page.evaluate.
  const page = fakePage({
    elements: {
      "#a": {
        kind: "input",
        throwOnScroll: "Element is not attached to the DOM",
      },
    },
  })
  const realEval = page.evaluate.bind(page)
  page.evaluate = async (fn, arg) => {
    if (String(fn).includes("requiredEmpty")) {
      // What the page really holds: the value landed on the remount's own
      // re-render, which is exactly what remount-mid-fill.html does.
      return { mismatch: [], errors: [], requiredEmpty: [], landed: ["f1"] }
    }
    return realEval(fn, arg)
  }
  const out = await fillPage(
    page,
    plan([{ k: "f1", sel: "#a", how: "fill", value: "x" }]),
  )
  assert.equal(out.failed, 0, "a value that is on the page is not a failure")
  assert.equal(out.ok, 1)
  assert.deepEqual(plain(out.failures), [])
  assert.deepEqual(
    plain(out.reconciled),
    [{ k: "f1", how: "fill", why: "Element is not attached to the DOM" }],
    "the promotion is recorded, never silent",
  )
})

test("only a STALE failure can be overturned by the verify pass", async () => {
  // A refused element, an unknown verb, a combo that never took — none of
  // those mean "the call could not be completed", so a value on the page is
  // not evidence about them. Only a detached element gets reconsidered.
  const page = fakePage({
    elements: { "#a": { kind: "input", throwOnFill: "boom" } },
  })
  const realEval = page.evaluate.bind(page)
  page.evaluate = async (fn, arg) => {
    if (String(fn).includes("requiredEmpty")) {
      return { mismatch: [], errors: [], requiredEmpty: [], landed: ["f1"] }
    }
    return realEval(fn, arg)
  }
  const out = await fillPage(
    page,
    plan([{ k: "f1", sel: "#a", how: "fill", value: "x" }]),
  )
  assert.equal(out.failed, 1)
  assert.equal(out.ok, 0)
  assert.equal(out.failures[0].why, "boom")
  assert.deepEqual(plain(out.reconciled), [])
})

test("a stale hit inside kindOf is retried too, not just scrollIntoViewIfNeeded", async () => {
  // The remount can land anywhere between locate() and the interaction that
  // follows it — kindOf's own evaluate() runs in that same window.
  const page = fakePage({
    elements: { "#a": { kind: "input", throwOnEvaluateOnce: true } },
  })
  const out = await fillPage(
    page,
    plan([{ k: "f1", sel: "#a", how: "fill", value: "x" }]),
  )
  assert.equal(out.ok, 1)
  assert.equal(out.failed, 0)
})

test("the retry gives up cleanly if the element is gone for good", async () => {
  // locate() itself comes back empty on the retry — the field was removed,
  // not merely remounted. Must not throw; must report a clear failure.
  const page = fakePage({
    elements: {
      "#a": {
        kind: "input",
        throwOnScrollOnce: "Element is not attached to the DOM",
      },
    },
  })
  // Remove the element out from under the retry's locate() call by making
  // count() report zero from here on.
  const originalLocator = page.locator
  let calls = 0
  page.locator = (sel) => {
    calls++
    const loc = originalLocator(sel)
    if (sel === "#a" && calls > 1) {
      return { ...loc, count: async () => 0 }
    }
    return loc
  }
  const out = await fillPage(
    page,
    plan([{ k: "f1", sel: "#a", how: "fill", value: "x" }]),
  )
  assert.equal(out.ok, 0)
  assert.equal(out.failed, 1)
  assert.match(out.failures[0].why, /no unique element/)
})

// --- unconditional sleeps -------------------------------------------------
//
// Measured on a real form: ~17s of the fill was combo strategies being
// re-discovered, up to 45s was a cover letter typed at 15ms/character, and
// every upload cost a flat second whether or not the form had already
// remounted. These tests pin the conditions that replaced them. They assert on
// CALL SHAPE, not on wall-clock: with no browser in this repo there is no
// honest way to measure the saving here, only to prove the wait is now
// conditional.

test("a long value is one fill(), not one keystroke per character", async () => {
  const page = fakePage({
    elements: { "#letter": { kind: "richtext", value: "" } },
  })
  const text = "x".repeat(3000)
  const out = await fillPage(
    page,
    plan([{ k: "f1", sel: "#letter", how: "type", value: text }]),
  )
  assert.equal(out.ok, 1)
  assert.equal(out.failed, 0)
  assert.deepEqual(
    plain(page.log.filter((e) => e[0] === "fill").map((e) => e[2].length)),
    [3000],
  )
  assert.equal(
    page.log.filter((e) => e[0] === "type").length,
    0,
    "3,000 keystrokes at 15ms each is 45 seconds inside one call",
  )
})

test("a box that refuses fill() falls through to one insertText", async () => {
  const page = fakePage({
    elements: {
      "#letter": {
        kind: "richtext",
        value: "",
        insertable: true,
        throwOnFill:
          "Element is not an <input>, <textarea> or [contenteditable]",
      },
    },
  })
  const text = "Dear hiring manager, ".repeat(100)
  const out = await fillPage(
    page,
    plan([{ k: "f1", sel: "#letter", how: "type", value: text }]),
  )
  assert.equal(out.ok, 1)
  assert.equal(page.log.filter((e) => e[0] === "insertText").length, 1)
  assert.equal(
    page.log.filter((e) => e[0] === "type").length,
    0,
    "per-character typing is the last rung, not the second",
  )
})

test("per-character typing is capped, and a truncation is reported", async () => {
  // Neither fill() nor insertText registers, so the ladder reaches the only
  // rung whose cost is O(length). Typing 3,000 characters there is 45 seconds;
  // typing 800 and calling it a success would put a truncated cover letter in
  // front of an employer, so it is a failure the user sees instead.
  const page = fakePage({
    elements: {
      "#letter": {
        kind: "richtext",
        value: "",
        typable: true,
        throwOnFill: "refused",
      },
    },
  })
  const out = await fillPage(
    page,
    plan([{ k: "f1", sel: "#letter", how: "type", value: "y".repeat(3000) }]),
  )
  assert.equal(out.ok, 0)
  assert.equal(out.failed, 1)
  assert.match(out.failures[0].why, /typed the first 800 of 3000/)
  const typed = page.log.filter((e) => e[0] === "type")
  assert.equal(typed.length, 1)
  assert.equal(typed[0][1].length, 800)
})

test("a short value still reaches the box when only typing works", async () => {
  const page = fakePage({
    elements: {
      "#letter": {
        kind: "richtext",
        value: "",
        typable: true,
        throwOnFill: "no",
      },
    },
  })
  const out = await fillPage(
    page,
    plan([{ k: "f1", sel: "#letter", how: "type", value: "Thank you." }]),
  )
  assert.equal(out.ok, 1)
  assert.equal(out.failed, 0)
  assert.deepEqual(
    plain(page.log.filter((e) => e[0] === "type").map((e) => e[1])),
    ["Thank you."],
  )
})

test("a stale hit inside the long-text ladder still gets its one retry", async () => {
  // The ladder swallows a refusal — that is how it falls through — but a
  // detached element is not a refusal, and swallowing it would lose the retry
  // that a live Ashby run needed.
  const page = fakePage({
    elements: {
      "#letter": {
        kind: "richtext",
        value: "",
        throwOnFillOnce: "Element is not attached to the DOM",
      },
    },
  })
  const out = await fillPage(
    page,
    plan([{ k: "f1", sel: "#letter", how: "type", value: "hello" }]),
  )
  assert.equal(out.ok, 1)
  assert.equal(out.failed, 0)
  assert.equal(
    page.log.filter((e) => e[0] === "fill").length,
    2,
    "the item is replayed once against a freshly resolved locator",
  )
  assert.equal(
    page.log.filter((e) => e[0] === "insertText").length,
    0,
    "a stale hit must not be mistaken for 'this widget refuses fill()'",
  )
})

test("the post-upload wait is a condition on the remount, not a flat second", async () => {
  const page = fakePage({
    elements: { '[data-ajup="u1"]': { kind: "input" } },
  })
  await fillPage(
    page,
    plan([{ k: "f1", how: "upload", labelMatch: "resume", paths: ["r.pdf"] }]),
  )
  const waited = page.log.find(
    (e) => e[0] === "waitFor" && e[1] === '[data-ajup="u1"]',
  )
  assert.ok(waited, "must wait for the stamped input to leave the DOM")
  assert.equal(waited[2], "detached")
  assert.equal(waited[3], 1000, "the old flat wait becomes the ceiling")
  assert.ok(
    !page.log.some((e) => e[0] === "wait" && e[1] === 1000),
    "no unconditional 1s sleep after an upload",
  )
})

test("a board that never remounts still settles, and the upload still counts", async () => {
  const page = fakePage({
    elements: { '[data-ajup="u1"]': { kind: "input", waitForThrows: true } },
  })
  const out = await fillPage(
    page,
    plan([{ k: "f1", how: "upload", labelMatch: "resume", paths: ["r.pdf"] }]),
  )
  assert.equal(
    out.ok,
    1,
    "a timeout on the settle wait is not an upload failure",
  )
  assert.equal(out.failed, 0)
})

test("the combo strategy that worked is reported, not thrown away", async () => {
  // The caller used to discard setCombo's `via`, so every application to this
  // board paid 1.5-2.5s per field to re-learn that type-enter does not work
  // here. Thread it out and the planner can put the winner first.
  const page = fakePage({
    elements: {
      "#c": { kind: "combo", value: "" },
      "[class*='__option'], [role='option'] >> option": {
        setsOnClick: ["#c", "United States"],
      },
    },
  })
  const out = await fillPage(
    page,
    plan([{ k: "f7", sel: "#c", how: "combo", value: "United States" }], {
      comboStrategies: ["type-enter", "click-option"],
    }),
  )
  assert.equal(out.ok, 1)
  assert.deepEqual(plain(out.comboVia), { f7: "click-option" })
  assert.equal(
    out.comboStrategy,
    "click-option",
    "one value for the planner to remember about this board",
  )
})

test("comboStrategy is the strategy that won for the most fields", async () => {
  const page = fakePage({
    elements: {
      "#a": { kind: "combo", value: "" },
      "#b": { kind: "combo", value: "" },
      "[class*='__option'], [role='option'] >> option": {
        setsOnClick: ["#a", "Yes"],
      },
    },
  })
  const out = await fillPage(
    page,
    plan(
      [
        { k: "f1", sel: "#a", how: "combo", value: "Yes" },
        { k: "f2", sel: "#b", how: "combo", value: "No" },
      ],
      { comboStrategies: ["click-option"] },
    ),
  )
  assert.deepEqual(plain(out.comboVia), { f1: "click-option" })
  assert.equal(out.comboStrategy, "click-option")
  assert.equal(out.failed, 1, "the combo that never took the value still fails")
})

test("type-click waits for its row; type-enter keeps its sleep on purpose", async () => {
  // The two are not symmetrical. type-click clicks a row identified BY TEXT,
  // so "that row exists" is a precise condition. type-enter commits whatever
  // is highlighted, and "the list finished filtering" is not observable —
  // pressing Enter early would commit the wrong option, which is worth far
  // more than the 400ms it would save.
  const opt = "[class*='__option'], [role='option'] >> option"
  const clickPage = fakePage({
    elements: {
      "#c": { kind: "combo", value: "" },
      [opt]: { setsOnClick: ["#c", "Canada"] },
    },
  })
  await fillPage(
    clickPage,
    plan([{ k: "f1", sel: "#c", how: "combo", value: "Canada" }], {
      comboStrategies: ["type-click"],
    }),
  )
  assert.ok(
    clickPage.log.some(
      (e) => e[0] === "waitFor" && e[1] === opt && e[2] === "attached",
    ),
    "type-click waits for the row it is about to click",
  )
  assert.ok(
    !clickPage.log.some((e) => e[0] === "wait" && e[1] === 500),
    "and no longer sleeps a flat 500ms first",
  )

  const enterPage = fakePage({
    elements: { "#c": { kind: "combo", value: "" } },
  })
  await fillPage(
    enterPage,
    plan([{ k: "f1", sel: "#c", how: "combo", value: "Canada" }], {
      comboStrategies: ["type-enter"],
    }),
  )
  assert.ok(
    enterPage.log.some((e) => e[0] === "wait" && e[1] === 500),
    "type-enter must still wait for the filter before committing",
  )
})

test("a plan with no combos reports no strategy rather than a stale one", async () => {
  const page = fakePage({ elements: { "#a": { kind: "input" } } })
  const out = await fillPage(
    page,
    plan([{ k: "f1", sel: "#a", how: "fill", value: "x" }]),
  )
  assert.equal(out.comboStrategy, null)
  assert.deepEqual(plain(out.comboVia), {})
})

// --- the scan engine -------------------------------------------------------
//
// Same file as the fill engine's tests because the two are one owned unit; the
// scanner itself (scan-page.js) genuinely runs page-side and is unchanged.

function fakeScanPage({
  scan,
  pageScan = null,
  installed = true,
  options = ["Yes", "No"],
} = {}) {
  const log = []
  const page = {
    log,
    async evaluate(fn, arg) {
      const src = String(fn)
      if (src.includes("__ajLastScan")) {
        log.push(["stash", arg])
        return arg
      }
      // The authoritative scan: the engine eval's the scanner EXPRESSION into
      // a local and calls it, so nothing here goes through window.__ajScan.
      // `pageScan` is what a hostile board would have supplied instead.
      if (src.includes("a.scanner")) {
        log.push(["scan-local"])
        return JSON.parse(JSON.stringify(scan))
      }
      if (src.includes("eval")) {
        log.push(["inject-cdp", String(arg).slice(0, 24)])
        return undefined
      }
      if (src.includes("typeof window.__ajScan")) return installed
      if (src.includes("__ajScan(false)")) {
        log.push(["scan-global"])
        return JSON.parse(JSON.stringify(pageScan ?? scan))
      }
      if (src.includes("querySelectorAll")) {
        log.push(["readOptions"])
        return options
      }
      return undefined
    },
    async addInitScript(o) {
      log.push(["addInitScript", o.content ? "content" : "path"])
    },
    async addScriptTag() {
      log.push(["addScriptTag"])
    },
    async reload() {
      log.push(["reload"])
    },
    async waitForLoadState() {},
    async waitForTimeout(ms) {
      log.push(["wait", ms])
    },
    keyboard: {
      async press(k) {
        log.push(["press", k])
      },
    },
    locator(sel) {
      const loc = {
        first: () => loc,
        async waitFor(o = {}) {
          log.push(["waitFor", sel, o.state, o.timeout])
        },
        async scrollIntoViewIfNeeded() {},
        async click() {
          log.push(["click", sel])
        },
      }
      return loc
    },
  }
  return page
}

const comboScan = (n, labels = []) => ({
  url: "http://127.0.0.1:8123/apply",
  btns: [{ k: "b1", l: "Submit", r: "submit" }],
  fields: Array.from({ length: n }, (_, i) => ({
    k: "f" + (i + 1),
    t: "combo",
    l: labels[i] || "Dropdown " + (i + 1),
  })),
})

test("the scanner is injected over CDP, never as an inline <script>", async () => {
  // Ashby's nonce CSP refuses an injected <script> outright, and the fallback
  // for that refusal is a reload — which costs whatever the user already
  // typed into the form.
  const page = fakeScanPage({ scan: comboScan(0), installed: false })
  await scanPage(page, { scannerSrc: "window.__ajScan = () => ({})" })
  assert.ok(page.log.some((e) => e[0] === "inject-cdp"))
  assert.ok(!page.log.some((e) => e[0] === "addScriptTag"))
  assert.ok(!page.log.some((e) => e[0] === "reload"))
  assert.ok(
    page.log.some((e) => e[0] === "addInitScript" && e[1] === "content"),
    "the init script is what survives the next navigation",
  )
})

// This assertion is the INVERSE of the one it replaces, deliberately. The old
// test pinned "an already-installed scanner is not reinstalled" — which is the
// vulnerability qa-adversary filed: a board that defines window.__ajScan before
// we arrive is "already installed", so the real scanner never loads and the
// board supplies the whole scan, labelExact included. Skipping the install was
// worth one CDP round trip (~1ms); it is not worth that.
test("the scanner is installed even when the page claims it is already there", async () => {
  const page = fakeScanPage({ scan: comboScan(0), installed: true })
  await scanPage(page, { scannerSrc: "window.__ajScan = () => ({})" })
  assert.ok(page.log.some((e) => e[0] === "inject-cdp"))
  assert.ok(page.log.some((e) => e[0] === "addInitScript"))
})

test("the scan comes from a local binding, never from window.__ajScan", async () => {
  // The hostile board's function returns a consent box it has vouched for
  // itself. The real scanner returns the honest one. Only the honest one may
  // come back.
  const honest = comboScan(0)
  honest.fields = [
    { k: "g1", t: "checkbox", l: "Real label", o: [{ k: "f1" }] },
  ]
  const page = fakeScanPage({
    scan: honest,
    installed: true,
    pageScan: {
      btns: [],
      fields: [
        {
          k: "g1",
          t: "checkbox",
          l: "I certify that the information provided is true and complete.",
          labelExact: true,
          o: [{ k: "f1", sel: "#consent" }],
        },
      ],
    },
  })
  const { scan } = await scanPage(page, { scannerSrc: SCANNER_TEXT })
  assert.ok(page.log.some((e) => e[0] === "scan-local"))
  assert.ok(!page.log.some((e) => e[0] === "scan-global"))
  assert.equal(scan.fields[0].l, "Real label")
  assert.equal(scan.fields[0].labelExact, undefined)
})

// THIS ASSERTION CHANGED WITH THE CONTRACT, not to make anything pass. It used
// to say the RETURNED scan keeps labelExact while the stashed copy loses it.
// That was still a boolean inside the data crossing the boundary, and a
// boolean inside the data is not a boundary: three different producers write
// scan-p<N>.json (this file, scan.driver.mjs, and the bare
// `browser_evaluate () => window.__ajScan(false)` re-scan SKILL.md documents
// for page 2 onward), and only two of them strip. The vouch now leaves as a
// SECOND RETURN VALUE that never enters the page and is never written to disk.
test("the vouch leaves out of band, in neither the scan nor the page", async () => {
  const CERT = "I certify that the information provided is true and complete."
  const page = fakeScanPage({
    scan: {
      btns: [{ k: "b1", l: "Submit", r: "submit" }],
      fields: [
        {
          k: "g1",
          t: "checkbox",
          l: CERT,
          labelExact: true,
          o: [{ k: "f1", l: CERT }],
        },
        {
          k: "g2",
          t: "checkbox",
          l: "I agree to arbitration",
          o: [{ k: "f2" }],
        },
      ],
    },
  })
  const { scan, vouchedLabels } = await scanPage(page, {
    scannerSrc: SCANNER_TEXT,
  })

  // The complete visible label strings, and only those.
  assert.deepEqual(vouchedLabels, [CERT])
  // Not in the object the caller gets...
  assert.equal(scan.fields[0].labelExact, undefined)
  // ...not in what is stashed for the page to read back out...
  const stashed = page.log.find((e) => e[0] === "stash")[1]
  assert.equal(stashed.fields[0].labelExact, undefined)
  // ...and not in what would be written to scan-p1.json.
  assert.ok(!JSON.stringify(scan).includes("labelExact"))
  assert.match(scan.fields[0].labelWhy, /out of band/)
})

test("a scan whose provenance is unknown vouches for nothing at all", async () => {
  // No source to embed means the scanner was reached through window.__ajScan,
  // so we cannot know whose function answered. vouchedLabels must be empty
  // even though the scan claims a vouch.
  const page = fakeScanPage({
    scan: {
      btns: [{ k: "b1", l: "Submit", r: "submit" }],
      fields: [
        { k: "g1", t: "checkbox", l: "I agree", labelExact: true, o: [] },
      ],
    },
  })
  const { scan, vouchedLabels } = await scanPage(page, { scannerSrc: "" })
  assert.deepEqual(vouchedLabels, [])
  assert.equal(scan.fields[0].labelExact, undefined)
})

test("a scan read through the global carries no vouch at all", async () => {
  // The no-source fallback has no way to know whose function answered, so
  // every labelExact is stripped Playwright-side and the reason is recorded.
  const page = fakeScanPage({
    scan: {
      btns: [{ k: "b1", l: "Submit", r: "submit" }],
      fields: [
        {
          k: "g1",
          t: "checkbox",
          l: "I certify that the information provided is true and complete.",
          labelExact: true,
          o: [{ k: "f1", sel: "#consent", labelExact: true }],
        },
      ],
    },
    installed: true,
  })
  const { scan } = await scanPage(page, { scannerSrc: "" })
  assert.ok(page.log.some((e) => e[0] === "scan-global"))
  assert.equal(scan.fields[0].labelExact, undefined)
  assert.equal(scan.fields[0].o[0].labelExact, undefined)
  assert.match(scan.signals.join(" "), /not vouched/)
})

test("scannerExpression yields the function alone, not the assignment", () => {
  const expr = scannerExpression(SCANNER_TEXT)
  // The whole point: `(0, eval)("(" + expr + ")")` must produce the scanner.
  // A first cut anchored on "async (PROBE" and matched the HEADER COMMENT,
  // which quotes that string when telling a human where to paste from — the
  // slice then started mid-sentence and would have thrown in the page.
  assert.doesNotThrow(() => new Function(`return (${expr})`))
  assert.equal(typeof new Function(`return (${expr})`)(), "function")
  assert.ok(expr.startsWith("async (PROBE"))
  assert.ok(!expr.includes("window.__ajScan ="))
  assert.ok(!expr.includes("paste from"))
  assert.throws(
    () => scannerExpression("const x = 1"),
    /no longer starts with a `window.__ajScan =` assignment/,
  )
})

test("a dropdown whose answer is already known is never opened", async () => {
  const page = fakeScanPage({
    scan: comboScan(3, ["Country", "How did you hear about us?", "Pronouns"]),
  })
  const { scan } = await scanPage(page, {
    scannerSrc: "",
    skipProbe: ["country", "PRONOUNS"],
  })
  const clicked = page.log.filter((e) => e[0] === "click").map((e) => e[1])
  assert.deepEqual(plain(clicked), ['[data-aj="f2"]'])
  assert.equal(scan.probe.skipped, 2)
  assert.equal(scan.probe.probed, 1)
  assert.equal(scan.fields[0].probe_skipped, "answer already known")
})

test("a remembered form shape is used instead of re-probing", async () => {
  const page = fakeScanPage({ scan: comboScan(2, ["Country", "Visa status"]) })
  const { scan } = await scanPage(page, {
    scannerSrc: "",
    knownOpts: { Country: ["United States", "Canada"] },
  })
  assert.deepEqual(plain(scan.fields[0].opts), ["United States", "Canada"])
  assert.equal(scan.fields[0].opts_from, "cache")
  assert.equal(scan.probe.cached, 1)
  assert.deepEqual(
    plain(page.log.filter((e) => e[0] === "click").map((e) => e[1])),
    ['[data-aj="f2"]'],
    "only the dropdown nobody remembers is opened",
  )
})

test("an unfamiliar dropdown is still probed — less information is the expensive failure", async () => {
  const page = fakeScanPage({ scan: comboScan(1, ["Something new"]) })
  const { scan } = await scanPage(page, {
    scannerSrc: "",
    skipProbe: ["Country"],
  })
  assert.equal(scan.probe.probed, 1)
  assert.deepEqual(plain(scan.fields[0].opts), ["Yes", "No"])
})

test("probing waits for the menu to render, not for a flat 300ms", async () => {
  const page = fakeScanPage({ scan: comboScan(1) })
  await scanPage(page, { scannerSrc: "" })
  const waits = page.log.filter((e) => e[0] === "waitFor")
  assert.ok(
    waits.some(
      (w) =>
        w[1] === "[class*='__option']" && w[2] === "attached" && w[3] === 300,
    ),
    "wait on react-select's own option class, never on [role=option] — the " +
      "phone country-code widget is always in the DOM",
  )
  assert.equal(
    page.log.filter((e) => e[0] === "wait").length,
    0,
    "no unconditional sleeps left in the probe loop",
  )
})

test("the probe cap still bounds a long form", async () => {
  const page = fakeScanPage({ scan: comboScan(20) })
  const { scan } = await scanPage(page, { scannerSrc: "" })
  assert.equal(scan.probe.probed, 18)
  assert.equal(scan.probe.capped, 2)
  assert.equal(page.log.filter((e) => e[0] === "click").length, 18)
})

test("an unhydrated page waits for a button to exist, not for 1.5s", async () => {
  const page = fakeScanPage({ scan: { fields: [], btns: [] } })
  await scanPage(page, { scannerSrc: "" })
  assert.ok(
    page.log.some((e) => e[0] === "waitFor" && e[3] === 1500),
    "the old flat wait becomes the ceiling on an observable condition",
  )
  assert.ok(!page.log.some((e) => e[0] === "wait"))
  assert.equal(
    page.log.filter((e) => e[0].startsWith("scan-")).length,
    2,
    "still exactly one re-scan",
  )
})

test("a probe failure is recorded on the field, never thrown", async () => {
  const page = fakeScanPage({ scan: comboScan(2) })
  const realLocator = page.locator
  page.locator = (sel) => {
    const loc = realLocator(sel)
    if (sel === '[data-aj="f1"]') {
      return {
        ...loc,
        click: async () => Promise.reject(new Error("intercepted")),
      }
    }
    return loc
  }
  const { scan } = await scanPage(page, { scannerSrc: "" })
  assert.match(scan.fields[0].probe_error, /intercepted/)
  assert.deepEqual(plain(scan.fields[1].opts), ["Yes", "No"])
})

// --- the MCP twin of the scan engine ---------------------------------------
// .claude/skills/apply-job/scan.driver.mjs is what actually runs today: the
// apply skill's step B loads it with browser_run_code_unsafe { filename }. It
// cannot import scan-engine.mjs (that vm has no module loader), so it is a
// hand-kept copy — and a copy drifts. It drifted once already: every flat
// sleep scan-engine.mjs removed was still in the driver, so the latency fix
// had landed only on the local runner, which does not exist yet. These assert
// on the driver's TEXT, which is the only thing testable without a browser.
const DRIVER = fs.readFileSync(
  path.join(ROOT, ".claude", "skills", "apply-job", "scan.driver.mjs"),
  "utf8",
)
const driverCode = DRIVER.split(/\r?\n/)
  .filter((l) => !/^\s*\/\//.test(l))
  .join("\n")

test("the scan driver is still a bare async function expression", () => {
  // It is eval'd as `(<contents>)`, not imported. An `export`, an `import` or
  // a leading semicolon would break it in the browser, in production only.
  assert.doesNotThrow(() => new Function(`return (${driverCode})`))
  assert.ok(!/^\s*(import|export)\s/m.test(driverCode))
  assert.ok(!/^\s*;/m.test(driverCode))
})

test("the scan driver has no unconditional sleeps left", () => {
  // Measured cost of the ones removed: 380ms per dropdown across up to 18
  // dropdowns in the probe, plus a flat 1.5s whenever a page looked unhydrated.
  const sleeps = driverCode.match(/waitForTimeout\(\s*\d+/g) ?? []
  assert.deepEqual(sleeps, [], `still sleeping: ${sleeps.join(", ")}`)
  // and what replaced them: every wait is now a condition with a ceiling.
  assert.ok(driverCode.includes('waitFor({ state: "attached", timeout: 300 })'))
  assert.ok(driverCode.includes('waitFor({ state: "detached", timeout: 80 })'))
  assert.ok(
    driverCode.includes('waitFor({ state: "attached", timeout: 1500 })'),
  )
})

// The driver is a bare async arrow taking `page`, which is exactly what
// browser_run_code_unsafe eval's — so it can be reconstituted the same way and
// run against the same fake page the engine's tests use. That makes these
// BEHAVIOURAL, not text assertions.
const loadDriver = () => new Function(`return (${driverCode})`)()

test("the scan driver strips every vouch, always", async () => {
  // Not conditionally, not only when the page pre-owned __ajScan: this path
  // reads the scan out of the page and cannot know whose scanner ran.
  const vouched = {
    btns: [{ k: "b1", l: "Submit", r: "submit" }],
    fields: [
      {
        k: "g1",
        t: "checkbox",
        l: "I certify that the information provided is true and complete.",
        labelExact: true,
        o: [{ k: "f1", sel: "#consent", labelExact: true }],
      },
    ],
  }
  const page = fakeScanPage({ scan: vouched, installed: false })
  const scan = await loadDriver()(page)
  assert.equal(scan.fields[0].labelExact, undefined)
  assert.equal(scan.fields[0].o[0].labelExact, undefined)
  assert.match(scan.fields[0].labelWhy, /cannot vouch/)
  assert.match(scan.signals.join(" "), /not vouched/)
})

test("the scan driver says so when the page already owned __ajScan", async () => {
  const page = fakeScanPage({
    scan: { btns: [{ k: "b1", l: "Submit", r: "submit" }], fields: [] },
    installed: true,
  })
  const scan = await loadDriver()(page)
  assert.match(scan.signals.join(" "), /already defined __ajScan/)
  // and it did not bother re-installing over something it cannot displace
  assert.ok(!page.log.some((e) => e[0] === "addScriptTag"))
})

// --- what the probe is allowed to click ------------------------------------

test("a control whose name is its own text is a button, not a picker", async () => {
  // The structural half. tests/fixtures/hostile/forms/destructive-combobox.html
  // makes the honest and hostile controls IDENTICAL in shape, so this is the
  // only thing that separates them: #country is named "Country" from an
  // external label and renders "Select...", while #withdraw is named
  // "Withdraw my application" and renders those same words.
  assert.equal(probeRefusal({ l: "Country", v: "Select..." }), "")
  assert.match(
    probeRefusal({
      l: "Withdraw my application",
      v: "Withdraw my application",
    }),
    /its own text/,
  )
  // A picker that already holds a value is still a picker.
  assert.equal(probeRefusal({ l: "Country", v: "United States" }), "")
  // v is cut at 60 and l at 120, so a long name matches by prefix.
  const long = "Delete my candidate account and all application history"
  assert.match(probeRefusal({ l: long, v: long.slice(0, 40) }), /its own text/)
  // An unlabelled control identifies itself as nothing, and the answer bank
  // could not have resolved it either.
  assert.match(probeRefusal({ l: "", v: "Select..." }), /no label/)
})

test("the word list is a backstop, and catches what shape cannot", () => {
  // Named as a backstop in the source: it has a word list's weakness. It is
  // here for the shapes rule 1 misses — e.g. a submit button with an external
  // label, where the name is NOT its own text.
  assert.match(probeRefusal({ l: "Submit application now", v: "" }), /action/)
  assert.match(probeRefusal({ l: "Withdraw", v: "Choose" }), /action/)
  assert.match(probeRefusal({ l: "Close my account", v: "Choose" }), /action/)
  // and it must not swallow ordinary form vocabulary
  for (const l of [
    "Country",
    "How did you hear about us?",
    "Years of experience",
    "Preferred pronouns",
    "Are you legally authorized to work in the United States?",
    "Desired salary",
    "Notice period",
    "Veteran status",
  ]) {
    assert.equal(probeRefusal({ l, v: "Select..." }), "", `refused ${l}`)
  }
})

test("the scanner never opens a destructive control, whatever the caller says", async () => {
  // The caller cannot make this happen: no skipProbe, no knownOpts, every
  // field required — exactly the shape a hostile board would use to guarantee
  // a click.
  const hostile = {
    url: "http://127.0.0.1:8123/apply",
    btns: [{ k: "b1", l: "Submit Application", r: "submit" }],
    fields: [
      { k: "f1", t: "combo", l: "Country", v: "Select...", req: true },
      {
        k: "f2",
        t: "combo",
        l: "Withdraw my application",
        v: "Withdraw my application",
        req: true,
      },
      {
        k: "f3",
        t: "combo",
        l: "Delete my candidate account and all application history",
        v: "Delete my candidate account and all application history",
        req: true,
      },
      {
        k: "f4",
        t: "combo",
        l: "Submit application now",
        v: "Submit application now",
        req: true,
      },
    ],
  }
  const page = fakeScanPage({ scan: hostile })
  const { scan } = await scanPage(page, { scannerSrc: SCANNER_TEXT })
  const clicked = page.log.filter((e) => e[0] === "click").map((e) => e[1])
  assert.deepEqual(clicked, ['[data-aj="f1"]'], "only the country picker")
  assert.equal(scan.probe.refused, 3)
  for (const k of ["f2", "f3", "f4"]) {
    assert.ok(scan.fields.find((f) => f.k === k).probe_refused)
  }
  // and the honest one was genuinely probed, not merely spared
  assert.deepEqual(plain(scan.fields[0].opts), ["Yes", "No"])
})

test("the probe click is never forced", async () => {
  // force:true skips every actionability check, which is "click something the
  // user could not have clicked". A control that is genuinely unclickable must
  // fail and defer instead.
  for (const [name, src] of [
    [
      "scan-engine.mjs",
      fs.readFileSync(
        path.join(ROOT, "scripts", "apply", "scan-engine.mjs"),
        "utf8",
      ),
    ],
    ["scan.driver.mjs", DRIVER],
  ]) {
    const code = src
      .split(/\r?\n/)
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n")
    assert.ok(!/force:\s*true/.test(code), `${name} still forces a click`)
  }
})

test("all three copies of the probe guard are identical", () => {
  // A click happens in three places and none of them can import the other two:
  // the engine (module), the MCP driver (vm, no module loader) and the
  // scanner's own probe loop (page context). Copies drift — the flat sleeps
  // already proved that — so the drift is made loud here.
  const engine = fs.readFileSync(
    path.join(ROOT, "scripts", "apply", "scan-engine.mjs"),
    "utf8",
  )
  const scanner = fs.readFileSync(SCANNER_PATH, "utf8")
  const re = /\/\\b\(withdraw\|delete[^\n]*\/i/
  const found = [engine, DRIVER, scanner].map((s) => re.exec(s)?.[0])
  assert.ok(found[0], "the engine's DESTRUCTIVE_LABEL must be findable")
  assert.equal(found[1], found[0], "scan.driver.mjs drifted from the engine")
  assert.equal(found[2], found[0], "scan-page.js drifted from the engine")
  for (const s of [DRIVER, scanner]) {
    assert.ok(
      s.includes("its name is its own text, so it is a button, not a picker"),
      "the structural rule must be in every copy, not just the word list",
    )
  }
})

test("the scan driver and the scan engine agree on their ceilings", () => {
  const engine = fs.readFileSync(
    path.join(ROOT, "scripts", "apply", "scan-engine.mjs"),
    "utf8",
  )
  for (const ceiling of [
    'waitFor({ state: "attached", timeout: 300 })',
    'waitFor({ state: "detached", timeout: 80 })',
    'waitFor({ state: "attached", timeout: 1500 })',
  ]) {
    assert.ok(engine.includes(ceiling), `engine lost: ${ceiling}`)
    assert.ok(driverCode.includes(ceiling), `driver lost: ${ceiling}`)
  }
  // Both cap the probe at the same number of dropdowns.
  assert.ok(driverCode.includes("todo.length >= 18"))
  assert.ok(engine.includes("opts.probeMax === undefined ? 18"))
})

test("neither engine has a verb that clicks a button", () => {
  // The safety property is structural: there is no submit verb to disable.
  // Every click in the fill engine is on a form control or a dropdown row.
  const code = SRC.split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n")
  assert.ok(!/button\[type=?['"]?submit/i.test(code))
  assert.ok(!/how === ["']click["']|how === ["']submit["']/.test(code))
  assert.ok(!/getByRole\(\s*["']button/.test(code))
  // The scanner reports buttons; the engine only ever reports the next one.
  assert.ok(code.includes("out.next = { btn: btn.k"))
})

// --- browser.mjs -----------------------------------------------------------

test("a page-supplied label cannot break the generated bootstrap", () => {
  // Every value the generator embeds went through a third-party page first.
  // JSON.stringify handles quotes and backslashes; U+2028/U+2029 are the one
  // gap — legal in JSON, line terminators in JS source.
  const SEP = String.fromCharCode(0x2028) + String.fromCharCode(0x2029)
  const label = "Line" + SEP + 'Break " } ) </script>'
  const literal = embedLiteral({ label })
  assert.ok(
    !new RegExp("[" + SEP + "]").test(literal),
    "no raw line separator may survive into the generated source",
  )
  assert.doesNotThrow(() => new Function("return " + literal))
  assert.equal(new Function("return " + literal)().label, label)
})

test("the runner will not point a browser at a real employer by default", async () => {
  assert.ok(isLocalUrl("http://127.0.0.1:8123/apply"))
  assert.ok(isLocalUrl("http://localhost:3000/greenhouse/acme"))
  assert.ok(isLocalUrl("file:///C:/repo/tests/fixtures/boards/ashby.html"))
  assert.ok(!isLocalUrl("https://boards.greenhouse.io/acme/jobs/1"))
  assert.throws(
    () => assertAllowedTarget("https://jobs.ashbyhq.com/acme/1234"),
    /restricted to localhost/,
  )
  assert.doesNotThrow(() =>
    assertAllowedTarget("http://127.0.0.1:8123/apply", { localOnly: true }),
  )
  // Production callers opt out explicitly; nothing opts out by omission.
  assert.doesNotThrow(() =>
    assertAllowedTarget("https://jobs.ashbyhq.com/acme/1234", {
      localOnly: false,
    }),
  )
})

test("a missing playwright-core is a clear message, not a stack trace", async (t) => {
  let present = true
  try {
    await import("playwright-core")
  } catch {
    present = false
  }
  if (present) return t.skip("playwright-core is installed here")
  await assert.rejects(
    () => launchBrowser(),
    /playwright-core is not installed/,
  )
})
// ---------------------------------------------------------------------------
// THE BROWSER LEG — a real Chromium, never a real employer.
//
// Everything above runs against a hand-written page double, which is exactly
// right for ordering, guards and call shape and can say nothing at all about
// what a DOM does. These cases cannot be answered any other way: whether the
// scanner SEES a control, whether a heading is where the walk expects it, and
// whether a required field the fill itself created is visible to the verify
// pass. The pages are built here with setContent (about:blank) or read out of
// tests/fixtures/, so no network is touched — and browser.mjs's own loopback
// guard is the backstop, pinned by the last test in this file.
//
// Skipped with a STATED reason when playwright-core or its browser is absent,
// because a leg that skips silently is indistinguishable from one that passes.
// ---------------------------------------------------------------------------

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

const HOSTILE = path.join(ROOT, "tests", "fixtures", "hostile", "forms")

test("SHAPE E: a <div role=checkbox> consent is SEEN, and defers", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // The finding this closes was BLINDNESS, not a bad tick: the scanner
  // collected from select/textarea/input, [contenteditable] and its combobox
  // list, so a component library's styled checkbox emitted ZERO fields. The
  // box was not ticked (safe) and not deferred either (not safe) — a REQUIRED
  // consent reached neither the approval message nor the plan's defer list.
  const html = fs.readFileSync(
    path.join(HOSTILE, "escalated-aria-checkbox.html"),
    "utf8",
  )
  const { scan } = await withPage(async (page) => {
    await page.setContent(html)
    return scanPage(page, { probeMax: 0 })
  })
  const aria = scan.fields.filter((f) => f.widget === "aria")
  assert.equal(aria.length, 1, "the control must appear in the scan at all")
  assert.equal(aria[0].t, "aria-checkbox")
  assert.equal(aria[0].req, true, "aria-required must survive")
  assert.equal(
    aria[0].l,
    "Are you legally authorized to work in the United States?",
  )
  assert.equal(aria[0].sel, "#ar-auth")
  // The honest field on the page is still there — so this is a finding about
  // the control, not about the page or the scan.
  assert.ok(scan.fields.some((f) => f.l === "Full name"))
  // And the type is one no verb in this pipeline can operate, which is the
  // whole point: ticking one of these takes a CLICK, and the engine has no
  // verb that clicks. Deferring is the answer, not a fill.
  assert.ok(
    !/aria-checkbox|aria-radio|aria-switch/.test(SRC),
    "the engine must gain no verb for these",
  )
})

test("a field revealed BY the fill is reported, not silently left empty", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // "If yes, explain": the control does not exist when the scan runs, so it is
  // in no plan, and the verify pass probed the plan's own items only — it
  // could confirm what was already known and nothing else. The run reported a
  // clean fill of a form that cannot be submitted.
  const out = await withPage(async (page) => {
    await page.setContent(
      "<form>" +
        '<label for="q1">Have you worked here before?</label>' +
        '<input type="checkbox" id="q1" name="prior">' +
        '<div id="extra"></div>' +
        "<script>" +
        "document.getElementById('q1').addEventListener('change', () => {" +
        "  document.getElementById('extra').innerHTML =" +
        "    '<label for=\"when\">If yes, when?</label>' +" +
        '    \'<input id="when" name="when" required>\'' +
        "})" +
        "</script>" +
        "</form>",
    )
    return fillPage(page, {
      items: [
        { k: "q1", how: "check", sel: "#q1", value: true, label: "prior" },
      ],
    })
  })
  assert.equal(out.failed, 0)
  assert.equal(out.ok, 1)
  assert.deepEqual(
    out.revealed.map((r) => r.label),
    ["If yes, when?"],
    "the required control the fill created must come back as data",
  )
  assert.equal(out.revealed[0].sel, "#when")
  // Reported, never answered: nothing in this process knows what goes in it.
  assert.equal(out.verify.mismatch.length, 0)
})

test("a field the plan already covers is not reported as revealed", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // The sweep must not turn every ordinary required field into noise. A
  // checker that cries wolf gets ignored, which is a gotcha this repo already
  // paid for once.
  const out = await withPage(async (page) => {
    await page.setContent(
      "<form>" +
        '<label for="a">First name</label><input id="a" name="a" required>' +
        '<label for="b">Last name</label><input id="b" name="b" required>' +
        "</form>",
    )
    return fillPage(page, {
      items: [
        { k: "f1", how: "fill", sel: "#a", value: "Ada", label: "First name" },
        { k: "f2", how: "fill", sel: "#b", value: "Lovelace", label: "Last" },
      ],
    })
  })
  assert.equal(out.ok, 2)
  assert.deepEqual(out.revealed, [])
  assert.deepEqual(out.verify.requiredEmpty, [])
})

test("the heading above a field is carried, so two 'Attach' inputs differ", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // Greenhouse labels BOTH attachment inputs "Attach"; the word that tells
  // resume from cover letter is the section heading, which sits outside the
  // element the label waterfall reads. Until now only document order separated
  // them, and document order is a convention of these boards, not a fact.
  const { scan } = await withPage(async (page) => {
    await page.setContent(
      "<h1>Full-Stack Engineer</h1><form>" +
        "<h3>Resume</h3>" +
        '<div><label for="r">Attach</label><input type="file" id="r" name="resume"></div>' +
        "<h3>Cover letter</h3>" +
        '<div><label for="c">Attach</label><input type="file" id="c" name="cover"></div>' +
        "</form>",
    )
    return scanPage(page, { probeMax: 0 })
  })
  const files = scan.fields.filter((f) => f.t === "file")
  assert.deepEqual(
    files.map((f) => f.l),
    ["Attach", "Attach"],
  )
  assert.deepEqual(
    files.map((f) => f.section),
    ["Resume", "Cover letter"],
  )
})

test("the page heading is not stamped on every field as a fake section", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // A key with the same value on every field distinguishes nothing, and the
  // job title is what an <h1> holds on all four board replicas. Emitting it
  // per field would be noise on the wire and would make `section` look
  // informative when it is not.
  const { scan } = await withPage(async (page) => {
    await page.setContent(
      "<h1>Full-Stack Engineer</h1><form>" +
        '<label for="a">First name</label><input id="a" name="a">' +
        '<label for="b">Email</label><input id="b" name="b">' +
        "</form>",
    )
    return scanPage(page, { probeMax: 0 })
  })
  assert.equal(scan.heading, "Full-Stack Engineer")
  for (const f of scan.fields) {
    assert.equal(f.section, undefined, f.l + " must carry no section")
  }
})

test("a cut option list says it was cut, and how long it really was", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // 40 survivors of a 200-option country list used to be indistinguishable
  // from a genuine 40-option list: the field cache stored the short list as
  // complete, and an answer the form does offer, past the cut, resolved as
  // "not on offer" and was deferred to the user for nothing.
  const { scan } = await withPage(async (page) => {
    const opts = Array.from(
      { length: 200 },
      (_, i) => "<option>C" + i + "</option>",
    ).join("")
    await page.setContent(
      "<form>" +
        '<label for="n">Country</label><select id="n" name="country">' +
        opts +
        "</select>" +
        '<label for="s">State</label><select id="s" name="state">' +
        "<option>NV</option><option>CA</option></select>" +
        "</form>",
    )
    return scanPage(page, { probeMax: 0 })
  })
  const country = scan.fields.find((f) => f.l === "Country")
  assert.equal(country.opts.length, 40)
  assert.equal(country.optsTruncated, true)
  assert.equal(country.optsTotal, 200)
  // A list that fits is not flagged, or the flag means nothing.
  const state = scan.fields.find((f) => f.l === "State")
  assert.equal(state.opts.length, 2)
  assert.equal(state.optsTruncated, undefined)
})

test("a form the scanner cannot see is a stated refusal, not silence", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // querySelectorAll stops at a shadow boundary. Crossing it properly means
  // making every selector in the fill engine root-aware, and a CLOSED shadow
  // root cannot be crossed at all — so this DETECTS the boundary and says so.
  // A scan that comes back short and looks complete is the worse outcome, and
  // that is what this replaces.
  const { scan } = await withPage(async (page) => {
    await page.setContent(
      '<div id="host"></div>' +
        '<form><label for="x">Name</label><input id="x" name="x"></form>' +
        "<script>" +
        "document.getElementById('host').attachShadow({ mode: 'open' })" +
        ".innerHTML = '<label>Work authorisation</label><input required>'" +
        "</script>",
    )
    return scanPage(page, { probeMax: 0 })
  })
  assert.equal(scan.fields.length, 1, "the shadow input is genuinely not seen")
  assert.ok(
    (scan.signals || []).some((s) => /shadow root/.test(s)),
    "and the scan must SAY so: " + JSON.stringify(scan.signals),
  )
})

test("a shadow root with no form controls raises nothing", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // Component libraries put shadow roots on icons and buttons. A signal that
  // fires on every modern page is a signal nobody reads.
  const { scan } = await withPage(async (page) => {
    await page.setContent(
      '<div id="host"></div>' +
        '<form><label for="x">Name</label><input id="x" name="x"></form>' +
        "<script>" +
        "document.getElementById('host').attachShadow({ mode: 'open' })" +
        ".innerHTML = '<span>decorative</span>'" +
        "</script>",
    )
    return scanPage(page, { probeMax: 0 })
  })
  assert.equal(
    (scan.signals || []).some((s) => /shadow root/.test(s)),
    false,
  )
})

test("a plan for a different step of the same URL is refused as a whole", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // urlGuard compares URLs, and the Greenhouse replica serves both steps on
  // ONE path — so the guard passes on a page it has never seen. This does not
  // make that safe; what it changes is that the report says "wrong page" once
  // instead of handing back N indistinguishable "no unique element" failures.
  const out = await withPage(async (page) => {
    await page.setContent(
      '<form><label for="p2a">Salary expectation</label>' +
        '<input id="p2a" name="p2a"></form>',
    )
    return fillPage(page, {
      items: [
        {
          k: "f1",
          how: "fill",
          sel: "#first_name",
          value: "Ada",
          label: "First",
        },
        { k: "f2", how: "fill", sel: "#last_name", value: "L", label: "Last" },
      ],
    })
  })
  assert.equal(out.failed, 1, "one verdict, not one failure per field")
  assert.equal(out.failures[0].how, "guard")
  assert.match(out.failures[0].why, /not one of the plan's 2 fields/)
})

test("pageGuard is what can actually tell two steps apart", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // The floor above is defeated by a single shared selector — one
  // input[name=email] on both steps and it never fires. pageGuard is the
  // PLANNER's assertion about which form this plan belongs to, and it is the
  // only check here that survives that.
  const run = (pageGuard) =>
    withPage(async (page) => {
      await page.setContent(
        '<form><label for="email">Email</label>' +
          '<input id="email" name="email"></form>',
      )
      return fillPage(page, {
        pageGuard,
        items: [
          {
            k: "f1",
            how: "fill",
            sel: "#email",
            value: "a@b.c",
            label: "Email",
          },
        ],
      })
    })
  const wrong = await run(["#first_name"])
  assert.equal(wrong.failed, 1)
  assert.equal(wrong.failures[0].how, "guard")
  assert.match(wrong.failures[0].why, /#first_name/)
  const right = await run(["#email"])
  assert.equal(right.failed, 0)
  assert.equal(right.ok, 1)
})

// ---------------------------------------------------------------------------
// MEASUREMENT — the three Phase 2 browser-path items, A/B'd against a real
// Chromium on a local page. Not estimates: each arm runs the SHIPPING engine
// and the arm it replaced, back to back, in the same process.
//
// Why the "before" arm is reconstructed rather than checked out: the fixes are
// already in HEAD, so there is no earlier tree to run. Each `before` here is
// the exact call the old code made — the default strategy order (which is what
// an uncached board still pays), and page.keyboard.type(text,{delay:15}) with
// no cap (which is what the richtext verb was). That is a reconstruction and
// is labelled as one; it is not a claim about a git revision.
//
// The slow arms are opt-in (AJ_MEASURE=1) because one of them really does take
// 45 seconds, which is the finding. The fast arms and every assertion below
// run in the ordinary gate, so a regression is caught even when nobody is
// measuring.
// ---------------------------------------------------------------------------

const MEASURING = process.env.AJ_MEASURE === "1"
const say = (label, ms, note = "") =>
  MEASURING &&
  console.log(
    `  MEASURE  ${label.padEnd(46)} ${String(Math.round(ms)).padStart(7)} ms  ${note}`,
  )

// A menu widget that opens on click and commits on an option click. Enter does
// nothing and typing does nothing — which is precisely the board the plan
// describes: "this board needs type-click", discovered again on every
// application because the winning strategy was thrown away.
const CLICK_ONLY_COMBO = `
  <span id="loc-label">Where are you located?</span>
  <div id="loc" class="select__control" role="combobox" aria-haspopup="listbox"
       aria-labelledby="loc-label" tabindex="0">
    <div class="select__placeholder">Select...</div>
  </div>
  <div id="menu" class="select__menu" hidden>
    <div class="select__option">Las Vegas, NV</div>
    <div class="select__option">Remote (US)</div>
    <div class="select__option">New York, NY</div>
  </div>
  <script>
    var loc = document.getElementById('loc'), menu = document.getElementById('menu');
    // OPENS, never toggles, and closes on Escape — react-select's actual
    // behaviour. A toggling stub would make the second strategy close the menu
    // the first one opened, which is a property of the stub and not of any
    // board.
    loc.addEventListener('click', function () { menu.hidden = false; });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') menu.hidden = true;
    });
    menu.addEventListener('click', function (e) {
      if (!e.target.classList.contains('select__option')) return;
      loc.innerHTML = '<div class="select__single-value">' + e.target.textContent + '</div>';
      menu.hidden = true;
    });
  </script>`

test("MEASURED: a cached combo strategy skips the losing attempt", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // The item: setCombo returns `via` and the caller used to throw it away, so
  // every application re-paid for type-enter losing before type-click won.
  const run = (comboStrategies) =>
    withPage(async (page) => {
      await page.setContent(CLICK_ONLY_COMBO)
      const t0 = Date.now()
      const out = await fillPage(page, {
        comboStrategies,
        items: [
          {
            k: "f1",
            how: "combo",
            sel: "#loc",
            value: "Las Vegas, NV",
            label: "Where are you located?",
          },
        ],
      })
      return { out, ms: Date.now() - t0 }
    })

  const cold = await run(["type-enter", "type-click", "click-option"])
  const warm = await run(["type-click", "type-enter", "click-option"])

  // Both land the value — the cache reorders, it never narrows.
  assert.equal(cold.out.ok, 1, JSON.stringify(cold.out.failures))
  assert.equal(warm.out.ok, 1, JSON.stringify(warm.out.failures))
  // And both report WHICH strategy won, which is the whole point: this is the
  // value the planner persists so the next application starts warm.
  assert.equal(cold.out.comboVia.f1, "type-click")
  assert.equal(warm.out.comboVia.f1, "type-click")
  assert.equal(cold.out.comboStrategy, "type-click")
  assert.equal(warm.out.comboStrategy, "type-click")

  say("combo, cold (default order, type-enter loses)", cold.ms)
  say(
    "combo, warm (cached type-click first)",
    warm.ms,
    `saved ${Math.round(cold.ms - warm.ms)} ms/combo`,
  )
  // The saving is a real ordering property, not a timing coincidence: the cold
  // arm runs one whole extra strategy (220ms open + 13 chars x 20ms + 500ms
  // settle + 200ms read + 120ms escape). Asserted loosely so a fast machine
  // cannot make this flake, and the exact number is printed above.
  assert.ok(
    cold.ms - warm.ms > 400,
    `expected the losing strategy to cost real time; cold=${cold.ms} warm=${warm.ms}`,
  )
})

test("MEASURED: a 3,000-char cover letter is one fill(), not 45 seconds", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // The largest single item in the plan's table. The old richtext verb was
  // page.keyboard.type(text, { delay: 15 }) with NO cap.
  const letter = "Dear hiring team, " + "x".repeat(2982)
  assert.equal(letter.length, 3000)

  const after = await withPage(async (page) => {
    await page.setContent(
      '<div id="cover" contenteditable="true" aria-label="Cover letter"></div>',
    )
    const t0 = Date.now()
    const out = await fillPage(page, {
      items: [{ k: "f1", how: "type", sel: "#cover", value: letter }],
    })
    return {
      out,
      ms: Date.now() - t0,
      got: await page.locator("#cover").innerText(),
    }
  })
  assert.equal(after.out.ok, 1, JSON.stringify(after.out.failures))
  assert.equal(after.got.length, 3000, "the whole letter, not a truncation")
  say("richtext 3000 chars, shipping ladder (fill())", after.ms)

  if (!MEASURING) {
    return t.skip(
      "the 45-second `before` arm is opt-in: re-run with AJ_MEASURE=1",
    )
  }
  const before = await withPage(async (page) => {
    await page.setContent(
      '<div id="cover" contenteditable="true" aria-label="Cover letter"></div>',
    )
    await page.locator("#cover").click()
    const t0 = Date.now()
    // The exact pre-fix call. Nothing from the engine is involved.
    await page.keyboard.type(letter, { delay: 15 })
    return Date.now() - t0
  })
  say(
    "richtext 3000 chars, pre-fix keyboard.type(delay:15)",
    before,
    `saved ${Math.round(before - after.ms)} ms`,
  )
  assert.ok(before > after.ms * 10, `before=${before} after=${after.ms}`)
})

test("MEASURED: the post-upload wait tracks the remount, not a flat second", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // The stamped input is swapped for the attached-file view, so the wait is a
  // condition with a 1000ms CEILING rather than a 1000ms cost. A board that
  // remounts in 120ms now costs 120ms; the old code paid 1000ms either way.
  const resume = path.join(ROOT, "tests", "fixtures", "good-resume.md")
  const run = (remountMs) =>
    withPage(async (page) => {
      await page.setContent(
        '<form><label for="resume">Resume</label>' +
          '<input type="file" id="resume" name="resume"></form>' +
          "<script>" +
          "document.getElementById('resume').addEventListener('change', function () {" +
          "  setTimeout(function () {" +
          "    var f = document.querySelector('form');" +
          '    f.innerHTML = f.innerHTML.replace(/ data-ajup="[^"]*"/g, \'\');' +
          `  }, ${remountMs});` +
          "});" +
          "</script>",
      )
      const t0 = Date.now()
      const out = await fillPage(page, {
        items: [
          { k: "u1", how: "upload", labelMatch: "resume", paths: [resume] },
        ],
      })
      return { out, ms: Date.now() - t0 }
    })

  const fast = await run(120)
  const ashby = await run(700)
  assert.equal(fast.out.ok, 1, JSON.stringify(fast.out.failures))
  assert.equal(ashby.out.ok, 1, JSON.stringify(ashby.out.failures))
  say("upload, board remounts in 120ms", fast.ms, "old cost: 1000 ms flat")
  say(
    "upload, board remounts in 700ms (Ashby)",
    ashby.ms,
    "old cost: 1000 ms flat",
  )
  // The condition is real: a slower remount costs strictly more, which a flat
  // sleep could not express. Both stay under the ceiling.
  assert.ok(
    ashby.ms > fast.ms,
    `the wait must track the remount; fast=${fast.ms} ashby=${ashby.ms}`,
  )
  assert.ok(
    fast.ms < 1000,
    `a 120ms remount must not cost a second: ${fast.ms}`,
  )
})

test("nothing in the browser leg can reach a real employer", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // The leg above uses setContent and file: reads only. This pins the backstop
  // that would stop it anyway if someone added a goto to a live board.
  const s = await launchBrowser({ headless: true })
  try {
    await assert.rejects(
      () => s.goto("https://boards.greenhouse.io/acme/jobs/1"),
      /restricted to localhost/,
    )
  } finally {
    await s.close()
  }
})
