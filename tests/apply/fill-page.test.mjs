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
// Shape F's false-positive arm needs the REAL scanner run over the REAL served
// board HTML, and dom.mjs is the harness that does exactly that without a
// browser. Read-only use of a fixture owned by qa-adversary.
import { parseHtml, runScanner } from "../fixtures/boards/dom.mjs"
import { buildPlan } from "../../scripts/apply/fill-plan.mjs"
import greenhouseAdapter from "../../scripts/apply/ats/greenhouse.mjs"

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
      // A ROW LOCATOR IS A WHOLE LOCATOR. It used to be a stub carrying only
      // first(), which was enough while the engine's only move was
      // `.filter().first().click()`. It now asks whether the exact row exists
      // before clicking it (`.count()`), because a substring match picked the
      // wrong option on a real form — so a stub that cannot be counted reads as
      // "no such row" and sends every combo down the fallback path.
      filter() {
        return mk(sel + " >> option")
      },
      first() {
        return loc
      },
      // The engine asks the CONTROL which menu is its own (aria-controls)
      // instead of searching the page. A fixture declares it per element:
      // elements["#c"] = { kind: "combo", attrs: { "aria-controls": "m1" } }.
      async getAttribute(name) {
        log.push(["getAttribute", sel, name])
        const attrs = (spec && spec.attrs) || {}
        return attrs[name] == null ? null : String(attrs[name])
      },
      locator: (sub) => mk(sub),
      // The last resort for a menu whose rows declare neither an option role
      // nor an option class — which is what an ORC listbox is.
      getByText: () => mk(sel + " >> text"),
    }
    return loc
  }

  return {
    log,
    url: () => url,
    locator: (sel) => mk(sel),
    getByText: () => mk("[role='listbox'] >> text"),
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
      // The stamp pass WRITES; the upload readback that follows it only reads.
      // Both mention data-ajup, so they are told apart by the write, not by
      // the attribute name — a fake that confused them would answer the
      // readback with the stamp's own answer and hide a misroute.
      if (src.includes("data-ajup") && src.includes("setAttribute")) {
        // One routine, two callers: the dry set-level pass (commit false,
        // writes nothing) and the real per-item stamp. They are logged apart
        // so a test can assert that the dry pass did not attach anything.
        const specs = (arg && arg.specs) || []
        for (const s of specs)
          log.push([arg.commit ? "stampTrigger" : "stampDry", s.pattern, s.tag])
        // `free: 1` because this fake models one input per pattern — each tag
        // has its own entry in `elements`. It therefore cannot exercise the
        // ambiguous (free >= 2) path at all; that is the real-DOM tests' job,
        // and saying so here beats a fake quietly asserting non-ambiguity.
        return specs.map((s) =>
          elements[`[data-ajup="${s.tag}"]`] !== undefined
            ? { ok: true, how: "label", depth: 2, target: s.tag, free: 1 }
            : { ok: false, inputs: 0, free: 0 },
        )
      }
      if (src.includes("data-ajup")) {
        log.push(["uploadReadback"])
        // This fake has no file inputs to read: it models locators, not a DOM.
        // Answering with something that is not a list is how the engine is
        // told "nothing was observed" — see the Array.isArray guard there.
        return undefined
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

// --- upload ROUTING, against a real DOM -----------------------------------
//
// The fake page above models locators, not a document, so it cannot say which
// input a stamp landed on — and that is precisely the question the misroute
// turned on: the engine attached the cover letter ON TOP OF the resume,
// attached no cover letter at all, and reported ok=6 failed=0 failures=[].
// Confirmed on the served fixture through a real Chromium
// (`benchBrowserFill({board, boardName:"greenhouse"})`):
//
//   [ { id: 'resume',       ajup: 'u2', n: 1, f: 'cover-letter.pdf' },
//     { id: 'cover_letter', ajup: null, n: 0, f: undefined } ]
//
// So these run the engine's REAL page-side arrow over the REAL served HTML,
// parsed by the fixture DOM. No browser, no new dependency — the arrow is
// self-contained by construction (it has to be; it is serialised into the
// page), so `new Function` with a document shim runs exactly the code
// Playwright would.
// `sleep: true` makes waitForTimeout actually sleep. Off by default — most
// tests here assert on what the engine DID, and paying its strategy delays
// would only make the suite slower. It is on for the settle tests, where a
// ceiling that terminates the wait is the property under test and a fake clock
// that never advances cannot express it.
const domPage = (
  html,
  { url = "https://board.test/apply", onUpload, sleep = false } = {},
) => {
  const { root } = parseHtml(html)
  const log = []
  const q = (sel) => root.querySelectorAll(sel)
  const doc = {
    querySelectorAll: (s) => q(s),
    querySelector: (s) => q(s)[0] || null,
  }
  const run = (fn, arg) =>
    new Function("document", "return (" + String(fn) + ")")(doc)(arg)
  const mk = (sel) => ({
    async count() {
      return q(sel).length
    },
    async waitFor() {
      log.push(["waitFor", sel])
    },
    async setInputFiles(paths) {
      const el = q(sel)[0]
      if (!el) throw new Error("no element for " + sel)
      // What a browser does: the input now HAS files, readable back off it.
      el.files = [].concat(paths).map((p) => ({
        name: String(p).split(/[\\/]/).pop(),
      }))
      log.push(["setFiles", el.id || el.name, el.files[0].name])
      if (onUpload) onUpload(el, root)
    },
    async scrollIntoViewIfNeeded() {},
    async evaluate() {
      return "input"
    },
    async fill() {},
  })
  return {
    log,
    root,
    url: () => url,
    locator: mk,
    keyboard: { async type() {}, async insertText() {}, async press() {} },
    async waitForTimeout(ms) {
      log.push(["wait", ms])
      if (sleep) await new Promise((r) => setTimeout(r, ms))
    },
    async evaluate(fn, arg) {
      const src = String(fn)
      if (src.includes("data-ajup")) return run(fn, arg)
      if (src.includes("requiredEmpty"))
        return {
          mismatch: [],
          errors: [],
          requiredEmpty: [],
          landed: [],
          revealed: [],
        }
      return undefined
    },
  }
}

const GREENHOUSE_HTML = fs.readFileSync(
  path.join(
    ROOT,
    "tests",
    "fixtures",
    "boards",
    "pages",
    "greenhouse-step1.html",
  ),
  "utf8",
)

// The exact plan shape fill-plan.mjs emits for this page's two file fields.
const uploadPlan = () =>
  plan([
    {
      k: "f1",
      how: "upload",
      labelMatch: "resume|\\bcv\\b",
      paths: ["C:\\jobs\\x\\resume.pdf"],
    },
    {
      k: "f2",
      how: "upload",
      labelMatch: "cover letter",
      paths: ["C:\\jobs\\x\\cover-letter.pdf"],
    },
  ])

const inputsOf = (root) =>
  root.querySelectorAll("input[type=file]").map((el) => ({
    id: el.id,
    ajup: el.getAttribute("data-ajup"),
    files: (el.files || []).map((f) => f.name),
  }))

test("the cover letter never lands on the resume input", async () => {
  const page = domPage(GREENHOUSE_HTML)
  const out = await fillPage(page, uploadPlan())

  assert.deepEqual(plain(inputsOf(page.root)), [
    { id: "resume", ajup: "u1", files: ["resume.pdf"] },
    { id: "cover_letter", ajup: "u2", files: ["cover-letter.pdf"] },
  ])
  assert.equal(out.ok, 2)
  assert.equal(out.failed, 0)
})

test("a shared container is not evidence for either input", async () => {
  // WHY the misroute happened: both inputs live in one <form> whose innerText
  // contains BOTH headings, three levels up from each. The old walk climbed
  // 8 levels and returned the first input in DOM order with ANY matching
  // ancestor, so /cover letter/ matched the RESUME input there. An ancestor
  // holding two file inputs cannot tell them apart and neither can anything
  // above it, so the walk must stop at it — asserted directly, because the
  // test above would also pass on a rule that merely got lucky on order.
  const page = domPage(GREENHOUSE_HTML)
  await fillPage(
    page,
    plan([
      {
        k: "f2",
        how: "upload",
        labelMatch: "cover letter",
        paths: ["cover-letter.pdf"],
      },
    ]),
  )
  const stamped = page.root
    .querySelectorAll("input[type=file]")
    .filter((el) => el.getAttribute("data-ajup"))
  assert.equal(stamped.length, 1)
  assert.equal(
    stamped[0].id,
    "cover_letter",
    "the cover letter went to the resume slot — the shared <form> was read " +
      "as evidence about the resume input",
  )
})

test("an input that already holds a file is never stamped again", async () => {
  // A stamp is a CLAIM on an input. The resume input carried u1 and the second
  // pass overwrote it with u2, because nothing excluded an input that was
  // already spoken for.
  //
  // The resume slot IS labelled here and the second slot is not, which is the
  // only shape where the positional fallback still runs (see the ambiguity
  // tests below): once /resume/ has taken its input there is exactly ONE left
  // awaiting a file, so placing the second is forced rather than guessed. The
  // fallback must walk forward to it, not clobber the one already filled.
  const page = domPage(`<html><body><form>
      <div><label>Resume</label><input type="file" id="a" /></div>
      <div><label>Attach</label><input type="file" id="b" /></div>
    </form></body></html>`)
  const out = await fillPage(
    page,
    plan([
      { k: "f1", how: "upload", labelMatch: "resume", paths: ["resume.pdf"] },
      {
        k: "f2",
        how: "upload",
        labelMatch: "cover letter",
        paths: ["cover-letter.pdf"],
      },
    ]),
  )
  assert.deepEqual(plain(inputsOf(page.root)), [
    { id: "a", ajup: "u1", files: ["resume.pdf"] },
    { id: "b", ajup: "u2", files: ["cover-letter.pdf"] },
  ])
  assert.equal(out.failed, 0)
  assert.deepEqual(plain(out.uploads.map((u) => [u.how, u.free ?? null])), [
    ["label", null],
    // free: 1 — one slot left, so the placement was forced, not chosen. That
    // number is what separates this from the refusal cases below, so the
    // report has to carry it rather than leave `how: "order"` ambiguous.
    ["order", 1],
  ])
})

// --- positional routing is a guess, and a guess attaches nothing -----------

const TWO_BLANK = `<html><body><form>
    <div><label>Attach</label><input type="file" id="a" /></div>
    <div><label>Attach</label><input type="file" id="b" /></div>
  </form></body></html>`

test("two indistinguishable slots attach NOTHING, and say why", async () => {
  // The last remaining path by which the wrong document goes out under the
  // user's name. Nothing on this page tells the two inputs apart, so DOM order
  // is the only thing left to place documents by — and DOM order is a guess.
  const page = domPage(TWO_BLANK)
  const out = await fillPage(
    page,
    plan([
      { k: "f1", how: "upload", labelMatch: "resume", paths: ["resume.pdf"] },
      {
        k: "f2",
        how: "upload",
        labelMatch: "cover letter",
        paths: ["cover-letter.pdf"],
      },
    ]),
  )
  assert.deepEqual(plain(inputsOf(page.root)), [
    { id: "a", ajup: null, files: [] },
    { id: "b", ajup: null, files: [] },
  ])
  assert.equal(out.ok, 0)
  assert.equal(out.failed, 2)
  for (const f of out.failures) {
    assert.match(f.why, /tells its 2 empty file inputs apart/)
    assert.match(f.why, /attach them by hand/)
    assert.ok(
      f.why.length <= 140,
      "the reason reaches the user verbatim; a sentence cut mid-word is not " +
        "something anyone can act on",
    )
  }
})

test("the set is decided BEFORE anything is attached, never halfway", async () => {
  // Deciding per item would attach file 1 positionally and then refuse file 2:
  // a wrong document on the form AND an incomplete application, which is worse
  // than either outcome alone. The dry pass exists to make that unreachable —
  // so it must write nothing, and no file may be attached at all.
  const page = domPage(TWO_BLANK)
  await fillPage(
    page,
    plan([
      { k: "f1", how: "upload", labelMatch: "resume", paths: ["resume.pdf"] },
      {
        k: "f2",
        how: "upload",
        labelMatch: "cover letter",
        paths: ["cover-letter.pdf"],
      },
    ]),
  )
  assert.deepEqual(
    page.log.filter((e) => e[0] === "setFiles"),
    [],
    "a set that could not be told apart attached a file anyway",
  )
})

test("ONE empty input left is forced, not guessed, and proceeds", async () => {
  // The boundary is the number of inputs still awaiting a file, NOT the number
  // of uploads in the plan. With one, positional is the only possible answer
  // and there is nothing to confuse — this is the ordinary single-attachment
  // board and it must not start failing.
  const page = domPage(`<html><body><form>
      <div><label>Attach</label><input type="file" id="only" /></div>
    </form></body></html>`)
  const out = await fillPage(
    page,
    plan([
      { k: "f1", how: "upload", labelMatch: "resume", paths: ["resume.pdf"] },
    ]),
  )
  assert.deepEqual(plain(inputsOf(page.root)), [
    { id: "only", ajup: "u1", files: ["resume.pdf"] },
  ])
  assert.equal(out.ok, 1)
  assert.equal(out.failed, 0)
  assert.equal(out.uploads[0].how, "order")
})

test("one upload item among two blank inputs is still a guess", async () => {
  // A single-item plan never takes the dry pass, so the per-item check has to
  // hold this on its own: one document and two empty slots is a guess about
  // which slot, exactly as much as two documents would be. The planner having
  // deferred the other slot does not make the choice safe.
  const page = domPage(TWO_BLANK)
  const out = await fillPage(
    page,
    plan([
      { k: "f1", how: "upload", labelMatch: "resume", paths: ["resume.pdf"] },
    ]),
  )
  assert.deepEqual(plain(inputsOf(page.root)), [
    { id: "a", ajup: null, files: [] },
    { id: "b", ajup: null, files: [] },
  ])
  assert.equal(out.failed, 1)
  assert.match(out.failures[0].why, /tells its 2 empty file inputs apart/)
})

test("a discriminated set is not held up by the ambiguity check", async () => {
  // The check must cost real boards nothing. Greenhouse labels both slots, so
  // the dry pass resolves both by label and the run proceeds untouched.
  const page = domPage(GREENHOUSE_HTML)
  const out = await fillPage(page, uploadPlan())
  assert.equal(out.failed, 0)
  assert.equal(out.ok, 2)
  assert.deepEqual(
    out.uploads.map((u) => u.how),
    ["label", "label"],
  )
})

test("no input left awaiting a file is a failure, not a clobber", async () => {
  const page = domPage(`<html><body><form>
      <div><label>Attach</label><input type="file" id="only" /></div>
    </form></body></html>`)
  const out = await fillPage(
    page,
    plan([
      { k: "f1", how: "upload", labelMatch: "resume", paths: ["resume.pdf"] },
      {
        k: "f2",
        how: "upload",
        labelMatch: "cover letter",
        paths: ["cover-letter.pdf"],
      },
    ]),
  )
  assert.deepEqual(plain(inputsOf(page.root)), [
    { id: "only", ajup: "u1", files: ["resume.pdf"] },
  ])
  assert.equal(out.ok, 1)
  assert.equal(out.failed, 1)
  assert.match(out.failures[0].why, /no file input left/)
})

test("the report says which file went to which input, not just how many", async () => {
  // `ok` is a COUNT. The misroute produced ok=6 failed=0 while the cover letter
  // sat on the resume input, so anything built from the count — the approval
  // message the user reads before pressing Submit — was told a falsehood. The
  // per-upload record is the only thing that can contradict it, and `seen` is
  // read back off the page rather than restated from the plan.
  const page = domPage(GREENHOUSE_HTML)
  const out = await fillPage(page, uploadPlan())
  // `settled` is part of the record deliberately: it says what the settle
  // watch SAW the board do with each stamped input, and the words are about
  // the page rather than about our clock. `held` is this static fixture's
  // honest answer — the file is on the input and nothing ever came to take it.
  // `detached` is the Greenhouse swap, `reset` a board that read the file out
  // and emptied the input. A held input is less settled than a detached one,
  // which is the kind of thing this record exists to be able to say.
  assert.deepEqual(plain(out.uploads), [
    {
      k: "f1",
      tag: "u1",
      file: "resume.pdf",
      match: "resume|\\bcv\\b",
      how: "label",
      target: "resume",
      settled: "held",
      attached: true,
      seen: "attached",
      seenFile: "resume.pdf",
    },
    {
      k: "f2",
      tag: "u2",
      file: "cover-letter.pdf",
      match: "cover letter",
      how: "label",
      target: "cover_letter",
      settled: "held",
      attached: true,
      seen: "attached",
      seenFile: "cover-letter.pdf",
    },
  ])
})

test("an input swapped out by the remount is 'gone', never a failure", async () => {
  // Greenhouse replaces the input with an attached-file view. There is then
  // nothing left to read, and reading nothing must not be reported as an
  // upload that did not happen — that would fail every working Greenhouse run.
  const page = domPage(GREENHOUSE_HTML, {
    onUpload: (el) => {
      const p = el.parentElement
      p.childNodes = p.childNodes.filter((n) => n !== el)
      el.parentElement = null
    },
  })
  const out = await fillPage(page, uploadPlan())
  assert.equal(out.ok, 2)
  assert.equal(out.failed, 0)
  assert.deepEqual(
    out.uploads.map((u) => [u.target, u.seen]),
    [
      ["resume", "gone"],
      ["cover_letter", "gone"],
    ],
  )
})

// --- 'empty' is the one readback answer that is a FAILURE -------------------
//
// setInputFiles not throwing was the entire evidence for `ok`, and on Ashby it
// was wrong 7 runs out of 7 at 0b6db30: `fill: ok=4 failed=0 deferred=2` with
// `_systemfield_resume` holding zero files (tests/dev/b1-browser-fill.test.mjs
// records the observation). The engine already read the DOM afterwards and
// wrote `seen: "empty"` — nothing anywhere read it, so the application went out
// with no resume and the report said everything succeeded.

test("an input still on the page holding no file is a failure, not an ok", async () => {
  // The board took the call and kept the input, empty. That is not "nothing
  // observed" — it is positive evidence the file did not land, and it is the
  // only readback answer that is.
  const page = domPage(GREENHOUSE_HTML, {
    onUpload: (el) => {
      el.files = []
    },
  })
  const out = await fillPage(page, uploadPlan())
  assert.equal(out.ok, 0, "a file that is not on the input is not an ok")
  assert.equal(out.failed, 2)
  assert.deepEqual(
    out.uploads.map((u) => [u.target, u.seen, u.attached]),
    [
      // `attached` is what a caller reads to say "the file is on the field",
      // so it is corrected too — the record must not contradict itself.
      ["resume", "empty", false],
      ["cover_letter", "empty", false],
    ],
  )
  assert.deepEqual(
    out.failures.map((f) => [f.k, f.how]),
    [
      ["f1", "upload"],
      ["f2", "upload"],
    ],
  )
  for (const f of out.failures) {
    assert.match(f.why, /still on the page holding no file/)
    assert.ok(
      f.why.length <= 140,
      "the reason reaches the user verbatim; a sentence cut mid-word is not " +
        "something anyone can act on",
    )
  }
  // The filename comes off OUR disk, so naming it costs nothing and tells the
  // user which document to attach by hand.
  assert.match(out.failures[0].why, /resume\.pdf/)
  assert.match(out.failures[1].why, /cover-letter\.pdf/)
})

test("only the EMPTY input is demoted — a 'gone' one beside it stays ok", async () => {
  // The boundary that matters. `gone` is a WORKING Greenhouse upload, so a rule
  // that demoted "not attached" as a class would fail every real run on that
  // board. One page, one of each.
  const page = domPage(GREENHOUSE_HTML, {
    onUpload: (el) => {
      if (el.id === "cover_letter") {
        el.files = []
        return
      }
      const p = el.parentElement
      p.childNodes = p.childNodes.filter((n) => n !== el)
      el.parentElement = null
    },
  })
  const out = await fillPage(page, uploadPlan())
  assert.equal(out.ok, 1)
  assert.equal(out.failed, 1)
  assert.deepEqual(
    out.uploads.map((u) => [u.target, u.seen, u.attached]),
    [
      ["resume", "gone", true],
      ["cover_letter", "empty", false],
    ],
  )
  assert.deepEqual(
    out.failures.map((f) => f.k),
    ["f2"],
  )
})

test("an upload that already failed is not failed a second time", async () => {
  // A board that REJECTS the file rejects the call too. `fail()` has already
  // run by the time the readback sees the empty input, and one document that
  // did not attach must produce exactly one failure — a demotion that did not
  // check `attached` would count it twice and leave `ok` at -1.
  const page = domPage(
    `<html><body><form>
      <div><label>Resume</label><input type="file" id="only" /></div>
    </form></body></html>`,
    {
      onUpload: (el) => {
        el.files = []
        throw new Error("File type not allowed")
      },
    },
  )
  const out = await fillPage(
    page,
    plan([
      { k: "f1", how: "upload", labelMatch: "resume", paths: ["resume.pdf"] },
    ]),
  )
  assert.equal(out.ok, 0)
  assert.equal(out.failed, 1)
  assert.equal(out.failures.length, 1)
  assert.match(out.failures[0].why, /File type not allowed/)
  assert.equal(out.uploads[0].seen, "empty")
  assert.equal(out.uploads[0].attached, false)
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

test("an upload pays no serial wait of its own; the settle is charged once", async () => {
  // WHAT CHANGED AND WHY. Each upload used to be followed by
  // `waitFor({state:"detached", timeout:1000})` on its own stamp, and B1
  // measured that wait settling by TIMEOUT on all three boards in every run —
  // Greenhouse, with two uploads, paid 2,014.58ms of a 2,753.73ms fill. A
  // ceiling paid in full every time is a flat sleep with a condition's name
  // on it, and two of them are two flat sleeps. The window a board needs to
  // react is now opened ONCE, before the verify pass, anchored at the last
  // upload — so a second upload adds no waiting at all.
  const page = fakePage({
    elements: {
      '[data-ajup="u1"]': { kind: "input" },
      '[data-ajup="u2"]': { kind: "input" },
    },
  })
  await fillPage(
    page,
    plan([
      { k: "f1", how: "upload", labelMatch: "resume", paths: ["r.pdf"] },
      { k: "f2", how: "upload", labelMatch: "cover letter", paths: ["c.pdf"] },
    ]),
  )
  assert.equal(
    page.log.filter((e) => e[0] === "waitFor" && /data-ajup/.test(e[1] || ""))
      .length,
    0,
    "no per-upload wait may return: that is the 1s-per-file cost B1 measured",
  )
  assert.ok(
    !page.log.some((e) => e[0] === "wait" && e[1] >= 450),
    "and it must not come back as a flat sleep either: " +
      JSON.stringify(page.log.filter((e) => e[0] === "wait")),
  )
})

// --- the settle: what it exits early on, and what it refuses to ------------
//
// Two arms, and they are deliberately asymmetric. The upload arm and the
// validation arm both end early ONLY on positive evidence from the page;
// silence pays the ceiling. A settle that treated "nothing yet" as "nothing
// coming" would report a clean fill of a form the board had not finished
// judging, and `verify.errors` is a submit-gate input.

test("the settle ends when the board has visibly taken the file", async () => {
  // Greenhouse's real behaviour: the input is swapped for an attached-file
  // view, so the stamped element leaves the DOM. That is observable, so the
  // wait ends on it rather than on the clock — and `settled` says which.
  const page = domPage(GREENHOUSE_HTML, {
    onUpload: (el) => {
      const p = el.parentElement
      p.childNodes = p.childNodes.filter((n) => n !== el)
      el.parentElement = null
    },
  })
  const out = await fillPage(page, uploadPlan(), {
    settle: { uploadMs: 1000, quietMs: 450, pollMs: 10 },
  })
  assert.equal(out.ok, 2, JSON.stringify(out.failures))
  assert.deepEqual(
    out.uploads.map((u) => u.settled),
    ["detached", "detached"],
    "a swapped-out input is the board taking the file, observed not assumed",
  )
  assert.equal(out.settle.uploads, true, "the upload arm resolved on evidence")
})

test("the settle refuses to end early while a file is still sitting on an input", async () => {
  // THE FAILURE ARM. This board does nothing at all: the file stays on the
  // input, which is exactly what a board looks like in the moment BEFORE its
  // async parse takes the file away (Ashby's lands ~700ms after the upload and
  // drops the FileList). "Nothing has happened yet" is not evidence that
  // nothing will, so this pays the ceiling and says so.
  // A REAL clock here: the property is that the ceiling ENDS the wait, and a
  // fake waitForTimeout that returns instantly cannot express one. Scaled down
  // to 80ms so the evidence costs 80ms.
  const page = domPage(GREENHOUSE_HTML, { sleep: true })
  const t0 = Date.now()
  const out = await fillPage(page, uploadPlan(), {
    settle: { uploadMs: 80, quietMs: 40, pollMs: 10 },
  })
  const ms = Date.now() - t0
  assert.deepEqual(
    out.uploads.map((u) => u.settled),
    ["held", "held"],
    "a file still on the input is 'held' — the watch reports what it saw",
  )
  assert.equal(
    out.settle.uploads,
    true,
    "the arm still terminates: it is a ceiling, not a hang",
  )
  assert.ok(
    ms < 800,
    `the ceiling bounds it: 80ms asked for, ${ms}ms paid — a wait that ` +
      "outruns its own ceiling by 10x is not a ceiling",
  )
  // And the readback that follows still gets its answer off the settled DOM.
  assert.equal(out.uploads[0].seen, "attached")
  assert.equal(out.ok, 2)
})

test("a fill that touched nothing settles nothing", async () => {
  // Every item skipped means no interaction happened, so there is no board
  // reaction to wait out. The old flat 450ms was paid here too — per page, on
  // every page of a multi-page walk whose fields were all deferred.
  const page = fakePage({ elements: { "#a": { kind: "input" } } })
  const out = await fillPage(page, plan([{ k: "f1", sel: "#a", how: "skip" }]))
  assert.equal(out.ok, 0)
  assert.equal(out.failed, 0)
  assert.equal(out.settle.ms < 50, true, `settled for ${out.settle.ms}ms`)
  assert.ok(
    !page.log.some((e) => e[0] === "wait"),
    "no sleep may be paid for a page this run never changed",
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
      "[class*='__option']:visible, [role='option']:visible >> option": {
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
      "[class*='__option']:visible, [role='option']:visible >> option": {
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
  const opt = "[class*='__option']:visible, [role='option']:visible >> option"
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
  // Attributes the probe can read off a control, keyed by selector. The probe
  // asks a combobox which menu is its own (aria-controls) before it guesses,
  // so a board that names its menu — every Oracle Recruiting Cloud form does —
  // is modelled by declaring it here. Empty means "names nothing", which is
  // react-select and is what every test written before this assumed.
  attrs = {},
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
        async getAttribute(name) {
          log.push(["getAttribute", sel, name])
          const a = attrs[sel] || {}
          return a[name] == null ? null : String(a[name])
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

// --- knownFor: the same two maps, supplied once the structure scan exists ---
// (Phase 5, 2026-08-14.) The field cache keys its knowledge on the form's
// fingerprint, which nobody can compute before the fields are known — so a
// caller hands the scanner a FUNCTION of the structure scan instead of a value.

test("knownFor is called with the structure scan and its options skip the probe", async () => {
  const page = fakeScanPage({
    scan: comboScan(3, ["Country", "How did you hear about us?", "Pronouns"]),
  })
  const seen = []
  const { scan } = await scanPage(page, {
    scannerSrc: "",
    knownFor: (structure) => {
      seen.push(structure)
      return { knownOpts: { country: ["United States", "Canada"] } }
    },
  })
  assert.equal(seen.length, 1, "called exactly once")
  assert.equal(seen[0].fields.length, 3, "with the structure scan (all fields)")
  assert.deepEqual(plain(scan.fields[0].opts), ["United States", "Canada"])
  assert.equal(scan.fields[0].opts_from, "cache")
  assert.equal(scan.probe.cached, 1)
  assert.equal(scan.probe.probed, 2)
  assert.deepEqual(
    plain(page.log.filter((e) => e[0] === "click").map((e) => e[1])),
    ['[data-aj="f2"]', '[data-aj="f3"]'],
    "only the dropdowns nobody remembers are opened",
  )
})

test("knownFor merges OVER direct knownOpts/skipProbe, and may be async", async () => {
  const page = fakeScanPage({
    scan: comboScan(3, ["Country", "Visa status", "Pronouns"]),
  })
  const { scan } = await scanPage(page, {
    scannerSrc: "",
    knownOpts: { Country: ["stale"] },
    knownFor: async () => ({
      knownOpts: { Country: ["fresh"] },
      skipProbe: ["Pronouns"],
    }),
  })
  assert.deepEqual(plain(scan.fields[0].opts), ["fresh"], "late value wins")
  assert.equal(scan.fields[2].probe_skipped, "answer already known")
  assert.equal(scan.probe.cached, 1)
  assert.equal(scan.probe.skipped, 1)
  assert.equal(scan.probe.probed, 1)
})

test("a knownFor that throws, or returns nothing, costs its hints and never the scan", async () => {
  // The fallback is the full probe — the safe direction. A scan that did not
  // happen is a job that defers "nothing to fill".
  for (const knownFor of [
    () => {
      throw new Error("cache unreadable")
    },
    () => null,
    () => undefined,
    async () => ({}),
  ]) {
    const page = fakeScanPage({ scan: comboScan(2, ["Country", "Degree"]) })
    const { scan } = await scanPage(page, { scannerSrc: "", knownFor })
    assert.equal(scan.probe.probed, 2)
    assert.equal(scan.probe.cached, 0)
    assert.deepEqual(plain(scan.fields[0].opts), ["Yes", "No"])
  }
})

test("without knownFor the probe selection is byte-identical to before it existed", async () => {
  const run = async (extra) => {
    const page = fakeScanPage({
      scan: comboScan(3, ["Country", "Visa status", "Pronouns"]),
    })
    const { scan } = await scanPage(page, {
      scannerSrc: "",
      knownOpts: { Country: ["United States"] },
      skipProbe: ["Pronouns"],
      ...extra,
    })
    return {
      scan: plain(scan),
      clicks: plain(page.log.filter((e) => e[0] === "click")),
    }
  }
  const before = await run({})
  const withNoop = await run({ knownFor: () => null })
  assert.deepEqual(withNoop, before)
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
  // The cap is 24 since 2026-08-07 (was 18 — Coinbase's Greenhouse form has 23
  // combos and the old ceiling skipped 5 of them). It is still a CAP, which is
  // what this pins: a form past it is bounded and says so.
  const page = fakeScanPage({ scan: comboScan(26) })
  const { scan } = await scanPage(page, { scannerSrc: "" })
  assert.equal(scan.probe.probed, 24)
  assert.equal(scan.probe.capped, 2)
  assert.equal(page.log.filter((e) => e[0] === "click").length, 24)
})

test("the probe stops when its TIME budget is gone, not only its count", async () => {
  // THE COUNT WAS ONLY EVER A PROXY. The cap's comment has always said "a long
  // form should not spend a minute in here", and that held while a control cost
  // at most ~4s. Raising the cap 18 -> 24 alongside 2s -> 6s of click patience
  // took the pathological form — every control timing out — from ~72s to ~264s,
  // which is a latency regression smuggled in behind a coverage fix.
  //
  // THE CLOCK IS INJECTED, and that is not incidental. The first version of
  // this test set a 1ms budget and trusted the loop to be slower than that; it
  // passed in a worktree and FAILED in the main repo, because the stub page
  // probes 26 controls inside a single millisecond on a fast box. A bound
  // asserted by racing the clock is not asserted at all.
  //
  // Here the clock jumps past the budget after the loop has started, so what
  // is pinned is the BEHAVIOUR — stop, and say which bound stopped you — with
  // no dependence on how fast the machine is.
  let ticks = 0
  const page = fakeScanPage({ scan: comboScan(26) })
  const { scan } = await scanPage(page, {
    scannerSrc: "",
    probeBudgetMs: 1000,
    probeMax: 26,
    now: () => (ticks++ === 0 ? 0 : 999_999),
  })
  assert.equal(
    scan.probe.probed,
    0,
    "the budget was already gone at the first control, so none is opened",
  )
  assert.equal(
    page.log.filter((e) => e[0] === "click").length,
    0,
    "a budget that is gone must stop CLICKS, not merely stop recording them",
  )
  const cut = scan.fields.filter((f) => f.probe_skipped === "probe budget")
  assert.ok(cut.length > 0, "a field cut by the budget must say which bound")
  for (const f of cut) {
    assert.equal(
      f.opts,
      undefined,
      "a field the budget skipped has no options at all — it must not read " +
        "as a field that was probed and found empty",
    )
  }
  assert.equal(
    scan.probe.probed + scan.probe.capped,
    26,
    "every combo is accounted for as either probed or stopped",
  )
})

test("a healthy form is never cut by the time budget", async () => {
  // The budget must not become a second cap. 24 fast controls finish nowhere
  // near 60s, so the coverage the raised cap bought is actually delivered.
  const page = fakeScanPage({ scan: comboScan(24) })
  const { scan } = await scanPage(page, { scannerSrc: "" })
  assert.equal(scan.probe.probed, 24)
  assert.equal(scan.probe.capped, 0)
  assert.equal(
    scan.fields.filter((f) => f.probe_skipped === "probe budget").length,
    0,
  )
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

// The probe's menu wait, pinned once and asserted of BOTH page-side scanners
// below. One string in one place, because two copies of it drifting apart is
// exactly the failure these assertions exist to catch.
const MENU_WAIT =
  'waitFor({ state: menuId ? "visible" : "attached", timeout: 300 })'

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
  // The menu wait's STATE is chosen at run time — a control that names its own
  // menu (aria-controls, which is every Oracle Recruiting Cloud picker) is
  // waited on until VISIBLE, because that element is the menu itself rather
  // than a class-name guess about what a menu looks like. The ceiling is what
  // this test is about and it is unchanged.
  assert.ok(driverCode.includes(MENU_WAIT))
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
  // ANCHORED ON THE CONSTANT'S NAME, not on the regex text alone. scan-page.js
  // grew a SECOND destructive word list — the button-pair detector's backstop,
  // which is a different guard with a different job — and it sits earlier in
  // the file, so a search for the regex text alone found that one and reported
  // a drift the probe guard had not suffered.
  const re = /DESTRUCTIVE_LABEL\s*=\s*(\/\\b\(withdraw\|delete[^\n]*\/i)/
  const found = [engine, DRIVER, scanner].map((s) => re.exec(s)?.[1])
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
    MENU_WAIT,
    'waitFor({ state: "detached", timeout: 80 })',
    'waitFor({ state: "attached", timeout: 1500 })',
  ]) {
    assert.ok(engine.includes(ceiling), `engine lost: ${ceiling}`)
    assert.ok(driverCode.includes(ceiling), `driver lost: ${ceiling}`)
  }
  // Both cap the probe at the same number of dropdowns. Raised 18 -> 24 on
  // 2026-08-07: Coinbase's Greenhouse form carries 23 combos, so the old cap
  // skipped 5 and deferred them for a reason the form was not responsible for.
  assert.ok(driverCode.includes("todo.length >= 24"))
  assert.ok(engine.includes("opts.probeMax === undefined ? 24"))
  // Both are patient enough for a heavy form. Same measurement: the 2s click
  // ceiling fired on controls a human clicks without noticing a delay.
  for (const ceiling of [
    "click({ timeout: 6000 })",
    "scrollIntoViewIfNeeded({ timeout: 5000 })",
  ]) {
    assert.ok(engine.includes(ceiling), `engine lost: ${ceiling}`)
    assert.ok(driverCode.includes(ceiling), `driver lost: ${ceiling}`)
  }
  // And both redirect the aria read to the inner combobox when the stamped
  // shell is silent, which is the react-select shape. A copy that loses this
  // reads null and probes nothing, which is what it did before the fix.
  for (const src of [engine, driverCode]) {
    assert.ok(/ariaOf\(f\.k, "aria-controls"\)/.test(src))
    assert.ok(/ariaOf\(f\.k, "aria-expanded"\)/.test(src))
    assert.ok(/menuOf\(el\) \|\| portalMenu\(\)/.test(src))
    // The time budget is the bound that keeps the raised cap honest. A copy
    // that carries the cap but not the budget is the ~264s worst case.
    assert.ok(/probe_skipped = "probe budget"/.test(src))
    assert.ok(/60000/.test(src), "the one-minute budget must be in both")
  }
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

// ---------------------------------------------------------------------------
// SHAPE F — the detector is focusability, and the role list is a nicety.
//
// Shape E fixed the blindness with a SELECTOR LIST, which is the same defect
// one rewording later: role="menuitemcheckbox", role="option" inside a listbox
// and a bare <span tabindex="0"> with a click handler all fell straight back
// into the original silence. The axis these tests pin: ANY focusable non-native
// control with no verb is reported BY DEFAULT, and the role only decides what
// `t` reads as.
//
// The safety property is unchanged and is asserted alongside: reporting is not
// a verb, and the engine still cannot click.
// ---------------------------------------------------------------------------

const BOARD_PAGES = path.join(ROOT, "tests", "fixtures", "boards", "pages")
const formPage = (body) =>
  "<html><body><h1>Apply</h1><form>" + body + "</form></body></html>"

test("SHAPE F: a control with NO role at all is reported, not skipped", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // The 26th rewording. Nothing here names a role, so every selector list in
  // the scanner misses it — and it is a consent tick with a click handler.
  const scan = await withPage(async (page) => {
    await page.setContent(
      formPage(
        '<label for="n">Full name</label><input id="n">' +
          '<span id="agree" tabindex="0">I agree to binding arbitration</span>' +
          '<my-toggle id="rel" tabindex="0" aria-label="Willing to relocate"></my-toggle>',
      ),
    )
    return (await scanPage(page, { probeMax: 0 })).scan
  })
  const swept = scan.fields.filter((f) => f.widget === "aria")
  assert.equal(swept.length, 2, "both unnamed controls must be seen")
  assert.deepEqual(
    swept.map((f) => f.t),
    ["widget", "widget"],
    "a role this file does not recognise is the GENERIC verb-less type",
  )
  assert.deepEqual(swept.map((f) => f.l).sort(), [
    "I agree to binding arbitration",
    "Willing to relocate",
  ])
  assert.equal(swept[0].sel, "#agree")
  // The honest field is untouched, so this is a finding about the controls.
  assert.ok(scan.fields.some((f) => f.l === "Full name" && f.t === "text"))
})

test("SHAPE F: the role list only names the type; it never gates detection", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const scan = await withPage(async (page) => {
    await page.setContent(
      formPage(
        '<div id="arb" role="menuitemcheckbox" tabindex="0" aria-checked="false"' +
          ' aria-label="I accept binding arbitration"></div>' +
          '<div role="listbox" aria-label="Country">' +
          '<div id="us" role="option" tabindex="0">United States</div></div>' +
          '<div id="pl" contenteditable aria-label="Cover letter"></div>',
      ),
    )
    return (await scanPage(page, { probeMax: 0 })).scan
  })
  const byKey = Object.fromEntries(scan.fields.map((f) => [f.sel, f]))
  assert.equal(byKey["#arb"].t, "aria-menuitemcheckbox")
  assert.equal(byKey["#us"].t, "aria-option")
  assert.equal(
    byKey["#us"].l,
    "United States",
    "own text names an unlabelled control",
  )
  // A bare `contenteditable` is NOT `contenteditable="true"`, so the richtext
  // loop never saw it. It is reported WITHOUT the `type` verb on purpose: a
  // broad sweep hands out no verbs, only reports.
  assert.equal(byKey["#pl"].t, "widget")
  assert.equal(byKey["#pl"].widget, "aria")
})

test("SHAPE F: Shape E's coverage did not narrow — role, no tabindex", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // THE REGRESSION THIS ALMOST SHIPPED. Shape E collected [role='checkbox']
  // with no focusability test at all, so a <div role="checkbox"> carrying NO
  // tabindex was reported. Detecting on focusability ALONE silently dropped it
  // — narrowing coverage while claiming to widen it. The detectors are OR'd.
  const scan = await withPage(async (page) => {
    await page.setContent(
      formPage(
        '<div id="c1" role="checkbox" aria-label="I certify this is true"></div>' +
          '<div id="c2" role="checkbox" tabindex="-1" aria-label="Background check"></div>',
      ),
    )
    return (await scanPage(page, { probeMax: 0 })).scan
  })
  assert.deepEqual(
    scan.fields
      .filter((f) => f.widget === "aria")
      .map((f) => f.sel)
      .sort(),
    ["#c1", "#c2"],
    "a declared control role is reported whatever its tabindex",
  )
})

test("SHAPE F: a toggle that carries STATE is a field, not a button", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // Measured dead code, caught before shipping: the button loop stamps every
  // [role='button'] first, so the sweep's aria-pressed escape hatch never ran
  // and this control produced ZERO fields. A board can render a consent tick as
  // a toggle button; a control with state is a value, not an action.
  const scan = await withPage(async (page) => {
    await page.setContent(
      formPage(
        '<div id="cert" role="button" tabindex="0" aria-pressed="false">' +
          "I certify the above is true</div>" +
          '<div id="go" role="button" tabindex="0">Submit application</div>',
      ),
    )
    return (await scanPage(page, { probeMax: 0 })).scan
  })
  const swept = scan.fields.filter((f) => f.widget === "aria")
  assert.deepEqual(
    swept.map((f) => f.sel),
    ["#cert"],
  )
  assert.deepEqual(
    scan.btns.map((b) => b.l),
    ["Submit application"],
    "a stateless button stays a button and never becomes a field",
  )
})

test("SHAPE F: links, iframes, wrappers and hidden nodes are NOT fields", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // THE FALSE-POSITIVE ARM, and every entry here was a MEASURED false positive
  // in an intermediate build of this sweep, not a hypothetical. A checker that
  // cries wolf gets ignored, and auto-apply blocks on any unsupported field, so
  // one spurious defer per board would end the unattended path entirely.
  const scan = await withPage(async (page) => {
    await page.setContent(
      formPage(
        '<div id="wrap" tabindex="0"><label for="n">Full name</label>' +
          '<input id="n"></div>' +
          '<a id="pp" href="/privacy" tabindex="0">Privacy policy</a>' +
          // ACTION_ROLE's own two cases, which the button loop does NOT stamp
          // and so are the only thing that guard actually catches: a div
          // wearing role="link" (never selected by the button loop) and an
          // icon-only role="button" (selected, but DROPPED there for having no
          // accessible name, so it arrives here unstamped).
          '<div id="ln" role="link" tabindex="0">Terms of service</div>' +
          '<div id="icon" role="button" tabindex="0"><svg width="8" height="8"></svg></div>' +
          '<details><summary tabindex="0">More info</summary><p>x</p></details>' +
          '<div id="dec" tabindex="0" aria-hidden="true">decoration</div>' +
          '<div id="off" tabindex="0" aria-disabled="true" aria-label="Not yet"></div>' +
          '<div id="gone" tabindex="0" style="display:none">hidden</div>',
      ),
    )
    return (await scanPage(page, { probeMax: 0 })).scan
  })
  assert.deepEqual(
    scan.fields.filter((f) => f.widget === "aria").map((f) => f.sel),
    [],
    "no focusable wrapper, link, summary, hidden or disabled node is a field",
  )
  assert.ok(scan.fields.some((f) => f.l === "Full name" && f.t === "text"))
})

test("SHAPE F: the honest board pages gain not one field", async () => {
  // The broadest false-positive check available without a live employer: run
  // the REAL scanner over the REAL served HTML of every board page in
  // tests/fixtures/boards/pages/ and assert the sweep contributes NOTHING. No
  // browser needed, so this arm runs everywhere and cannot skip into silence.
  const files = fs.readdirSync(BOARD_PAGES).filter((f) => f.endsWith(".html"))
  assert.ok(files.length >= 5, "the board corpus must not have shrunk away")
  for (const f of files) {
    const scan = await runScanner(
      fs.readFileSync(path.join(BOARD_PAGES, f), "utf8"),
    )
    assert.deepEqual(
      scan.fields.filter((x) => x.widget === "aria").map((x) => x.l),
      [],
      f + " must gain no swept field",
    )
    assert.ok(scan.fields.length > 0, f + " must still scan as a form")
  }
})

test("SHAPE F: everything the sweep reports DEFERS, and gains no verb", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // The end of the chain, asserted on behaviour rather than on a comment: a
  // swept control reaches buildPlan and comes back as a defer with NO item, so
  // nothing unattended can act on it. Reporting is not a verb.
  const scan = await withPage(async (page) => {
    await page.setContent(
      formPage(
        '<span id="agree" tabindex="0">I agree to binding arbitration</span>' +
          '<div id="arb" role="menuitemcheckbox" tabindex="0" aria-checked="false"' +
          ' aria-label="Preferred start date"></div>',
      ),
    )
    return (await scanPage(page, { probeMax: 0 })).scan
  })
  const swept = scan.fields.filter((f) => f.widget === "aria")
  assert.equal(swept.length, 2)
  const plan = buildPlan({
    scan,
    resolved: swept.map((f) => ({ k: f.k, status: "OK", value: "Yes" })),
    adapter: greenhouseAdapter,
    files: {},
  })
  const why = {}
  for (const f of swept) {
    assert.ok(
      !plan.items.some((i) => i.k === f.k),
      f.t + " must produce no fillable item",
    )
    const d = plan.defer.find((x) => x.k === f.k)
    assert.ok(d, f.t + " must produce a defer")
    why[f.sel] = d.why
  }
  // The neutral one proves the VERB gate specifically: nothing about its label
  // is special, and it still cannot be acted on, because `t` has no verb.
  assert.match(why["#arb"], /unsupported field type aria-menuitemcheckbox/)
  // The consent one defers EARLIER, on the consent gate, which is stronger
  // still — asserted rather than assumed so a future reorder cannot silently
  // turn "deferred twice over" into "deferred not at all".
  assert.equal(why["#agree"], "consent")
  // And the engine gained nothing. "no verb that clicks a BUTTON" is pinned by
  // its own two tests above ("the engine cannot express clicking a button",
  // "neither engine has a verb that clicks a button") and is deliberately not
  // re-asserted here as a bare /\.click\(/ grep — the combo verb opens a picker
  // with a real click, so that grep is red on correct code and would be
  // "fixed" by weakening the real test. What THIS case owns is narrower and
  // exact: widening the scanner handed the engine no new verb.
  assert.ok(
    !/"widget"|aria-menuitemcheckbox|aria-option/.test(SRC),
    "the engine must gain no verb for a swept control",
  )
})

test("SHAPE F: the sweep's cut is stated, never silent", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // Same reasoning as optsTruncated: 40 survivors of a 200-option list are
  // indistinguishable from a genuine 40. A cut that says nothing is a silence,
  // which is the exact failure this whole shape exists to end.
  let body = ""
  for (let i = 0; i < 30; i++)
    body += '<span tabindex="0">Consent item ' + i + "</span>"
  const scan = await withPage(async (page) => {
    await page.setContent(formPage(body))
    return (await scanPage(page, { probeMax: 0 })).scan
  })
  assert.equal(scan.fields.filter((f) => f.widget === "aria").length, 25)
  assert.ok(
    (scan.signals ?? []).some((s) =>
      /5 further focusable control\(s\) this scanner has no verb for/.test(s),
    ),
    "the 5 dropped controls must be stated: " + JSON.stringify(scan.signals),
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

  // THE MECHANISM IS THE ASSERTION, and the wall clock is only corroboration.
  // This test used to compare two wall-clock samples (`ashby.ms > fast.ms`,
  // `fast.ms < 1000`) and went intermittently red because of it: 2 of 6
  // full-gate runs on identical committed code on 2026-08-02, while passing
  // 3/3 in isolation. Contention inflates a sample, so either bound can fail
  // for reasons that have nothing to do with the code under test — and an
  // intermittently red gate teaches people to re-run until green, which is
  // worse than the flake.
  //
  // Loosening the bounds was the wrong repair. The claim worth protecting is a
  // LATENCY claim (a 120ms board costs 120ms, not a flat second) and a bound
  // slack enough never to fail would no longer express it. So the claim is
  // asserted where it is actually decided instead: `settled` says whether the
  // wait returned on the observable detach or fell through to the 1s ceiling.
  // If both remount speeds resolve on the detach, the cost tracked the remount
  // by construction — no timing needed, and nothing for load to perturb.
  const fast = await run(120)
  const ashby = await run(700)
  assert.equal(fast.out.ok, 1, JSON.stringify(fast.out.failures))
  assert.equal(ashby.out.ok, 1, JSON.stringify(ashby.out.failures))
  assert.equal(
    fast.out.uploads[0].settled,
    "detached",
    "a 120ms remount must resolve the wait on the DETACH, not the 1s ceiling — " +
      "a flat sleep cannot report this",
  )
  assert.equal(
    ashby.out.uploads[0].settled,
    "detached",
    "a 700ms Ashby-speed remount must still resolve on the detach, inside the ceiling",
  )

  // The latency payoff, kept but made robust. Contention can only ever inflate
  // a measurement, never deflate it below the true cost, so the MINIMUM of
  // several samples is the honest estimate and is what the bound is applied
  // to. A flat 1000ms sleep would fail this at every sample, so best-of-N
  // costs nothing in sensitivity to the regression it guards.
  const samples = [fast.ms, (await run(120)).ms, (await run(120)).ms]
  const best = Math.min(...samples)
  say("upload, board remounts in 120ms", best, "old cost: 1000 ms flat")
  say(
    "upload, board remounts in 700ms (Ashby)",
    ashby.ms,
    "old cost: 1000 ms flat",
  )
  assert.ok(
    best < 1000,
    `a 120ms remount must not cost a second: best=${best} of ${JSON.stringify(samples)}`,
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

// --- the readback says WHICH file, so check WHICH file ----------------------
//
// `seenFile` — the name the PAGE reports for the file sitting on the input —
// has been recorded here for as long as this readback has existed, and was read
// by no code at all. The only thing comparing it to the file we sent was a
// sentence in SKILL.md asking the agent to eyeball the two, which is not a
// control and is absent entirely on the unattended path, where nothing reads
// `uploads`.
//
// MEASURED 2026-08-06 on three live Ashby applications: a third file input
// labelled "Name" consumed the document-order slot and the résumé was planned
// twice, so a document could land in a slot the user never chose while `seen:
// "attached"` — which only ever meant "some file is here" — counted it ok.

test("a file the page reports under another name is a failure, not an ok", async () => {
  // The board accepted the call and kept an input holding a DIFFERENT document.
  // Nothing about "a file is present" distinguishes this from success, which
  // is exactly why presence was the wrong question.
  const page = domPage(GREENHOUSE_HTML, {
    onUpload: (el) => {
      if (el.id === "cover_letter") el.files = [{ name: "resume.pdf" }]
    },
  })
  const out = await fillPage(page, uploadPlan())
  assert.equal(out.ok, 1, "the mis-targeted upload was still counted ok")
  assert.equal(out.failed, 1)
  assert.deepEqual(
    out.uploads.map((u) => [u.target, u.seen, u.seenFile, u.attached]),
    [
      ["resume", "attached", "resume.pdf", true],
      // Present, and wrong. `attached` is corrected so the record cannot
      // contradict itself.
      ["cover_letter", "attached", "resume.pdf", false],
    ],
  )
  assert.deepEqual(
    out.failures.map((f) => [f.k, f.how]),
    [["f2", "upload"]],
  )
  const why = out.failures[0].why
  assert.match(why, /upload-wrong-file/)
  // Our own basename, so naming it tells the user which document to attach.
  assert.match(why, /cover-letter\.pdf/)
  assert.ok(
    why.length <= 140,
    "the reason reaches the user verbatim; a sentence cut mid-word is not " +
      "something anyone can act on",
  )
})

test("BOUNDARY: a board that APPENDS beside our file has not mis-targeted it", async () => {
  // Membership, not equality. Our file is present; something else is too. That
  // is not a document in the wrong slot, and failing it would cost the user a
  // working upload on every board that behaves this way.
  const page = domPage(GREENHOUSE_HTML, {
    onUpload: (el) => {
      if (el.id === "cover_letter") {
        el.files = [{ name: "cover-letter.pdf" }, { name: "extra.pdf" }]
      }
    },
  })
  const out = await fillPage(page, uploadPlan())
  assert.equal(out.ok, 2)
  assert.equal(out.failed, 0)
  assert.equal(out.failures.length, 0)
})

test("BOUNDARY: the filename check is case- and whitespace-insensitive", async () => {
  // A board that echoes the name back with different casing has not swapped
  // the document, and Windows paths make that a real possibility.
  const page = domPage(GREENHOUSE_HTML, {
    onUpload: (el) => {
      if (el.id === "cover_letter") el.files = [{ name: " Cover-Letter.PDF " }]
    },
  })
  const out = await fillPage(page, uploadPlan())
  assert.equal(out.ok, 2, "a case difference was read as the wrong document")
  assert.equal(out.failed, 0)
})

test("BOUNDARY: a 'gone' input is still not subject to the filename check", async () => {
  // `gone` means the board swapped the input for its attached-file view — the
  // normal Greenhouse success — and there is no name to read. The check must
  // not turn the absence of evidence into evidence of the wrong file.
  const page = domPage(GREENHOUSE_HTML, {
    onUpload: (el) => {
      const p = el.parentElement
      p.childNodes = p.childNodes.filter((n) => n !== el)
      el.parentElement = null
    },
  })
  const out = await fillPage(page, uploadPlan())
  assert.equal(out.ok, 2)
  assert.equal(out.failed, 0)
  assert.deepEqual(
    out.uploads.map((u) => u.seen),
    ["gone", "gone"],
  )
})
