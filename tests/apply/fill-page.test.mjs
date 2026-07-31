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
import scanPage from "../../scripts/apply/scan-engine.mjs"
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
  assert.equal(scrolls.length, 2, "exactly one retry — not an infinite loop")
  assert.equal(
    page.log.filter((e) => e[0] === "fill").length,
    0,
    "a scroll that never succeeds must never reach fill",
  )
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
  installed = true,
  options = ["Yes", "No"],
} = {}) {
  const log = []
  const page = {
    log,
    async evaluate(fn, arg) {
      const src = String(fn)
      if (src.includes("__ajLastScan")) {
        log.push(["stash"])
        return arg
      }
      if (src.includes("eval")) {
        log.push(["inject-cdp", String(arg).slice(0, 24)])
        return undefined
      }
      if (src.includes("typeof window.__ajScan")) return installed
      if (src.includes("__ajScan(false)")) {
        log.push(["scan"])
        return JSON.parse(JSON.stringify(scan))
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

test("an already-installed scanner is not reinstalled", async () => {
  const page = fakeScanPage({ scan: comboScan(0), installed: true })
  await scanPage(page, { scannerSrc: "window.__ajScan = () => ({})" })
  assert.ok(!page.log.some((e) => e[0] === "inject-cdp"))
  assert.ok(!page.log.some((e) => e[0] === "addInitScript"))
})

test("a dropdown whose answer is already known is never opened", async () => {
  const page = fakeScanPage({
    scan: comboScan(3, ["Country", "How did you hear about us?", "Pronouns"]),
  })
  const scan = await scanPage(page, {
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
  const scan = await scanPage(page, {
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
  const scan = await scanPage(page, { scannerSrc: "", skipProbe: ["Country"] })
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
  const scan = await scanPage(page, { scannerSrc: "" })
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
    page.log.filter((e) => e[0] === "scan").length,
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
  const scan = await scanPage(page, { scannerSrc: "" })
  assert.match(scan.fields[0].probe_error, /intercepted/)
  assert.deepEqual(plain(scan.fields[1].opts), ["Yes", "No"])
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
