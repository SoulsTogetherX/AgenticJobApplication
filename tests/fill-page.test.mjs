// The fill engine is shipped as SOURCE and eval'd Playwright-side, so these
// tests reconstitute it exactly the way the driver does, then run it against a
// fake `page`. That covers what actually goes wrong in this layer: ordering,
// guards, and one bad field taking the whole plan down with it.
//
// Not covered here: real browser behaviour. The project has no Playwright
// dependency (a browser download this repo deliberately avoids), so the
// react-select and file-chooser strategies are verified live against a real
// Greenhouse form instead.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const ENGINE = path.join(ROOT, ".claude", "skills", "apply-job", "fill-page.js")
const SRC = fs.readFileSync(ENGINE, "utf8")

// Exactly what scan.driver-style bootstrapping does: run the file, take the
// string off window, eval it back into a function.
function loadEngine() {
  const ctx = { window: {} }
  vm.createContext(ctx)
  vm.runInContext(SRC, ctx)
  assert.equal(typeof ctx.window.__ajFillSrc, "string")
  return vm.runInContext("(" + ctx.window.__ajFillSrc + ")", ctx)
}

// The engine runs inside a vm context, so the objects it returns carry that
// realm's prototypes and strict deep-equality rejects them. Compare by value.
const plain = (v) => JSON.parse(JSON.stringify(v))

// --- a fake page ----------------------------------------------------------
// Records every interaction so tests can assert on ordering and on what was
// never touched.
function fakePage({ url = "https://ats.test/apply", elements = {} } = {}) {
  const log = []
  const mk = (sel) => {
    const spec = elements[sel]
    const loc = {
      async count() {
        return spec ? 1 : 0
      },
      async scrollIntoViewIfNeeded() {},
      async click() {
        log.push(["click", sel])
        if (spec && spec.throwOnClick) throw new Error(spec.throwOnClick)
      },
      async fill(v) {
        log.push(["fill", sel, v])
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
        return String(fn).includes("forbidden:")
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
      },
      async press(k) {
        log.push(["press", k])
      },
    },
    async waitForTimeout() {},
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

test("the engine reconstitutes from source as an async (page, plan)", () => {
  const fn = loadEngine()
  assert.equal(typeof fn, "function")
  assert.equal(fn.constructor.name, "AsyncFunction")
  assert.equal(fn.length, 2)
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

test("refuses to fill a page the plan was not built for", async () => {
  const fn = loadEngine()
  const page = fakePage({ url: "https://ats.test/other" })
  const out = await fn(
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
  const fn = loadEngine()
  const page = fakePage({
    url: "https://ats.test/apply?gh_jid=1#form",
    elements: { "#a": { kind: "input" } },
  })
  const out = await fn(
    page,
    plan([{ k: "f1", sel: "#a", how: "fill", value: "x" }], {
      urlGuard: "https://ats.test/apply",
    }),
  )
  assert.equal(out.ok, 1)
})

test("uploads run before anything else", async () => {
  const fn = loadEngine()
  const page = fakePage({
    elements: {
      "#name": { kind: "input" },
      '[data-ajup="u1"]': { kind: "input" },
    },
  })
  await fn(
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
  const fn = loadEngine()
  const page = fakePage({
    elements: {
      '[data-ajup="u1"]': { kind: "input" },
      '[data-ajup="u2"]': { kind: "input" },
    },
  })
  const out = await fn(
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
  const fn = loadEngine()
  const page = fakePage({ elements: {} })
  const out = await fn(
    page,
    plan([
      { k: "f1", how: "upload", labelMatch: "cover letter", paths: ["c.pdf"] },
    ]),
  )
  assert.equal(out.failed, 1)
  assert.match(out.failures[0].why, /no file input left/)
})

test("refuses any element that is not a form control", async () => {
  const fn = loadEngine()
  const page = fakePage({ elements: { "#trap": { kind: "forbidden:div" } } })
  const out = await fn(
    page,
    plan([{ k: "f1", sel: "#trap", how: "fill", value: "x" }]),
  )
  assert.equal(out.ok, 0)
  assert.equal(out.failed, 1)
  assert.match(out.failures[0].why, /not a form control/)
  assert.ok(!page.log.some((e) => e[0] === "fill"))
})

test("one bad field does not abort the rest of the plan", async () => {
  const fn = loadEngine()
  const page = fakePage({
    elements: {
      "#a": { kind: "input" },
      "#bad": { kind: "input", throwOnFill: "detached" },
      "#c": { kind: "input" },
    },
  })
  const out = await fn(
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
  const fn = loadEngine()
  const page = fakePage({ elements: { "#c": { kind: "combo", value: "" } } })
  // shownValue reads spec.value, which nothing in the fake ever sets for a
  // combo — so every strategy is tried and the failure is reported honestly.
  const out = await fn(
    page,
    plan([{ k: "f1", sel: "#c", how: "combo", value: "United States" }]),
  )
  assert.equal(out.failed, 1)
  const typed = page.log.filter((e) => e[0] === "type").length
  assert.ok(typed >= 1, "at least the typeahead strategy ran")
  assert.ok(page.log.some((e) => e[0] === "press" && e[1] === "Enter"))
})

test("reports the next button without ever clicking it", async () => {
  const fn = loadEngine()
  const page = fakePage({ elements: { "#a": { kind: "input" } } })
  const out = await fn(
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
  const fn = loadEngine()
  const page = fakePage({ elements: { "#a": { kind: "input" } } })
  const out = await fn(
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
  const fn = loadEngine()
  const page = fakePage({ elements: { "#a": { kind: "input" } } })
  const out = await fn(page, plan([{ k: "f1", sel: "#a", how: "skip" }]))
  assert.equal(out.ok, 0)
  assert.equal(out.failed, 0)
  assert.equal(page.log.filter((e) => e[0] !== "verify").length, 0)
})
