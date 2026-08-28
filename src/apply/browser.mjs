// browser.mjs — the Node-side plumbing for the browser path: launch a browser,
// open a page, and run the two engines against it.
//
// There are two ways the engines reach a `page`, and this file serves both:
//
//   1. The LOCAL RUNNER (src/auto/*, tests against the fake board under
//      tests/fixtures/boards/). Ordinary Node, ordinary `import` — launchBrowser()
//      here, then fillPage(page, plan) / scanPage(page). No MCP, no model.
//   2. The MCP path (`browser_run_code_unsafe { filename }`), whose vm has no
//      working `import` and no fs. src/apply/fill-plan.mjs reads the engine
//      text off OUR OWN DISK with engineSandboxSource() below and embeds it in
//      the generated jobs/<slug>/fill-plan.js, which eval's that one string.
//
// Neither path reads executable code back out of the page. That round trip —
// inject the engine, read window.__ajFillSrc back, eval it Playwright-side —
// was the hole: a board defining that getter chose what ran with a live `page`
// handle, up to and including clicking Submit. See the header of
// src/apply/fill-engine.mjs.
//
// SAFETY: nothing in this file clicks a button, and neither engine has a verb
// for it. Do not add a submit helper here to "complete" the API.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import fillPage from "./fill-engine.mjs"
import scanPage, { SCANNER_PATH, readScannerSource } from "./scan-engine.mjs"

export { fillPage, scanPage, SCANNER_PATH, readScannerSource }

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

// Resolved from this file, never from the cwd: a scheduled task's working
// directory is not ours to assume.
export const ENGINE_PATH = path.join(ROOT, "src", "apply", "fill-engine.mjs")

export function readEngineSource(file = ENGINE_PATH) {
  return fs.readFileSync(file, "utf8")
}

// `export default async function fillPage(...)` -> a string the MCP vm can
// eval, whose completion value is that function.
const DEFAULT_EXPORT =
  /^export default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/m

// The engine is a module for importers and a STRING for the sandbox, and the
// sandbox has no module loader at all (playwright-core's runCode.ts supplies no
// importModuleDynamically callback, so even `await import()` throws). The
// translation is exactly one keyword: drop `export default`, then name the
// function so eval's completion value is it.
//
// Everything this asserts is a real constraint on fill-engine.mjs, not
// decoration — an `import` line or a second export would compile as a module
// and throw as a script, i.e. it would break only in the browser, only in
// production. tests/apply/fill-page.test.mjs pins all of it.
// JSON.stringify's output is a valid JS literal with exactly one exception:
// U+2028 and U+2029 are legal inside a JSON string and are LINE TERMINATORS in
// JS source. The plan carries labels copied verbatim off a third-party page, so
// escape them rather than trust the parser version inside the MCP vm. Used by
// fill-plan.mjs's buildDriverSource() for every value it embeds.
const LINE_SEPARATORS = new RegExp("[\\u2028\\u2029]", "g")

// A RegExp becomes `{}` under JSON.stringify. The plan's `valueAliases` (an
// adapter's "this board shows a chosen value differently" knowledge) are
// RegExps, and the engine that reads them accepts `{source, flags}` for
// exactly this reason — see fill-engine.mjs's toRe(). Same replacer for every
// value embedded here and for fill-plan.json.
export function jsonReplacer(key, value) {
  return value instanceof RegExp
    ? { source: value.source, flags: value.flags }
    : value
}

export function embedLiteral(value) {
  return JSON.stringify(value, jsonReplacer).replace(
    LINE_SEPARATORS,
    (c) => "\\u" + c.charCodeAt(0).toString(16),
  )
}

export function engineSandboxSource(src = readEngineSource()) {
  const m = DEFAULT_EXPORT.exec(src)
  if (!m) {
    throw new Error(
      "fill-engine.mjs must default-export a named function declaration",
    )
  }
  const body = src.replace(/^export default\s+/m, "")
  const stray = body
    .split(/\r?\n/)
    .find((l) => /^\s*(import\s|export\s|import\()/.test(l))
  if (stray) {
    throw new Error(
      `fill-engine.mjs must stay self-contained for the sandbox; found: ${stray.trim().slice(0, 60)}`,
    )
  }
  return `${body}\n${m[1]}\n`
}

// --- where a browser is allowed to point ----------------------------------
// Loopback and file: only, unless the caller explicitly opts out. This build's
// runners and tests never touch a real employer's board, and that is enforced
// here rather than remembered: a fixture server on 127.0.0.1 passes, a real
// ATS host does not. Production callers (src/auto/*) pass
// { localOnly: false } deliberately, or set AJ_BROWSER_ALLOW_REMOTE=1.
const LOOPBACK = /^(localhost|127(\.\d+){1,3}|\[?::1\]?|0\.0\.0\.0)$/i

export function isLocalUrl(url) {
  let u
  try {
    u = new URL(String(url))
  } catch {
    return false
  }
  if (u.protocol === "file:") return true
  if (u.protocol !== "http:" && u.protocol !== "https:") return false
  return LOOPBACK.test(u.hostname)
}

export function assertAllowedTarget(url, { localOnly } = {}) {
  const restrict =
    localOnly === undefined
      ? process.env.AJ_BROWSER_ALLOW_REMOTE !== "1"
      : localOnly
  if (restrict && !isLocalUrl(url)) {
    throw new Error(
      `refusing to open ${url}: this runner is restricted to localhost and file: URLs ` +
        `(pass { localOnly: false } or set AJ_BROWSER_ALLOW_REMOTE=1 to allow a real board)`,
    )
  }
  return url
}

// --- launching -------------------------------------------------------------
// playwright-core, never `playwright`: the latter's postinstall downloads
// ~150MB of browsers on every CI leg, which this repo deliberately avoids. The
// browser binary comes from PLAYWRIGHT_CHROMIUM or the installed channel.
export async function loadChromium() {
  try {
    const pw = await import("playwright-core")
    return pw.chromium ?? pw.default?.chromium
  } catch (e) {
    throw new Error(
      "playwright-core is not installed — `npm i -D playwright-core` " +
        `(not \`playwright\`, whose postinstall pulls ~150MB of browsers). Cause: ${e.message}`,
    )
  }
}

// Returns { context, page, close }. With userDataDir it is a persistent
// context, which is how a logged-in ATS session survives between runs — and
// why two processes must never share one directory: Chromium takes an
// exclusive SingletonLock on it.
export async function launchBrowser(opts = {}) {
  const {
    userDataDir = null,
    headless = true,
    executablePath = process.env.PLAYWRIGHT_CHROMIUM || undefined,
    channel = process.env.PLAYWRIGHT_CHANNEL || undefined,
    timeout = 30000,
    args = [],
    localOnly,
  } = opts
  const chromium = await loadChromium()
  const common = { headless, executablePath, channel, args }

  let browser = null
  let context
  if (userDataDir) {
    context = await chromium.launchPersistentContext(userDataDir, common)
  } else {
    browser = await chromium.launch(common)
    context = await browser.newContext()
  }
  context.setDefaultTimeout(timeout)
  const page = context.pages()[0] || (await context.newPage())

  return {
    browser,
    context,
    page,
    localOnly,
    async goto(url, gotoOpts = {}) {
      assertAllowedTarget(url, { localOnly })
      return page.goto(url, { waitUntil: "domcontentloaded", ...gotoOpts })
    },
    async close() {
      try {
        await context.close()
      } catch {}
      if (browser) {
        try {
          await browser.close()
        } catch {}
      }
    },
  }
}

// Guarantees the browser is closed even when the body throws — an orphaned
// Chromium keeps the SingletonLock and blocks the next run.
export async function withBrowser(opts, fn) {
  const session = await launchBrowser(opts)
  try {
    return await fn(session)
  } finally {
    await session.close()
  }
}
