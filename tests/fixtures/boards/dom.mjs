// A DOM small enough to host the REAL scanner, built from the REAL served HTML.
//
// WHY THIS EXISTS. Every consumer test in tests/security/ feeds product code a
// hand-authored scan JSON, and board-fidelity.test.mjs bridges the gap by
// re-deriving each label from the served page with a copy of scan-page.js's
// txt(). That copy is a re-implementation, and it only ever checked `f.l`. A
// fixture can therefore claim any OTHER key — `lSeen`, `labelExact`, `sel`,
// `t`, field order — and nothing contradicts it. That is exactly how
// scans/mislabelled-inputs.scan.json kept saying "what scan-page.js produces
// for this page" for two commits after it had stopped being true.
//
// So this parses the served HTML into a DOM and runs the ACTUAL
// .claude/skills/apply-job/scan-page.js text over it. No jsdom, no Playwright,
// no new dependency: the repo deliberately has neither, and the scanner needs
// far less than a real browser.
//
// WHAT IT IS FAITHFUL ABOUT, because the scanner's answers turn on these:
//   - the label waterfall's inputs: aria-labelledby, aria-label, label[for],
//     wrapping <label>, <fieldset><legend>, the four-ancestor class walk,
//     placeholder/name
//   - innerText that skips <script>/<style>/<head> and display:none subtrees
//   - inline styles, with the INHERITING properties (color, font-size,
//     visibility) resolved up the ancestor chain, because `color: transparent`
//     on a <label> is one of the corpus's carriers
//   - the `hidden` attribute as display:none, which is what a browser does
//
// WHAT IT IS NOT. There is no layout engine: every rendered element gets the
// same 200x20 box, so a page cannot be hidden here by geometry (1x1 clipping,
// off-screen parking, overlay occlusion). Those carriers are asserted in
// tests/apply/scan-page.test.mjs against a hand-built DOM that sets rects, and
// in tests/security/browser-vouch.test.mjs when a browser is available. The
// viewport is 0x0 by default, which puts the scanner on its own documented
// below-the-fold path and skips the occlusion check entirely rather than
// faking an answer to it.
//
// PROBE IS ALWAYS OFF. Probing clicks dropdowns; there are no event handlers
// here, so a probed result would be a fiction. Scan fixtures in this directory
// are non-probe scans for the same reason.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { decodeEntities } from "#lib/lib.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const SCANNER_PATH = path.resolve(
  HERE,
  "..",
  "..",
  "..",
  ".claude",
  "skills",
  "apply-job",
  "scan-page.js",
)

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
])
// Elements whose content is text, never markup.
const RAW = new Set(["script", "style", "textarea", "title"])
// Elements whose text is not rendered to the eye.
const UNRENDERED = new Set(["SCRIPT", "STYLE", "HEAD", "TEMPLATE", "NOSCRIPT"])
// Inline CSS properties that inherit down the tree.
const INHERITED = ["color", "font-size", "visibility"]

let ORDER = 0

class Text {
  constructor(data) {
    this.data = data
  }
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.attrs = new Map()
    this.childNodes = []
    this.parentElement = null
    this.order = ORDER++
    this.ownerRoot = null
  }

  append(node) {
    node.parentElement = this
    this.childNodes.push(node)
    return node
  }

  // --- attribute-backed properties the scanner reads ---------------------
  get id() {
    return this.attrs.get("id") || ""
  }
  get name() {
    return this.attrs.get("name") || ""
  }
  get type() {
    return this.attrs.get("type") || ""
  }
  get placeholder() {
    return this.attrs.get("placeholder") || ""
  }
  get value() {
    if (this.tagName === "TEXTAREA") return this.rawText()
    return this.attrs.get("value") || ""
  }
  get src() {
    return this.attrs.get("src") || ""
  }
  get title() {
    return this.attrs.get("title") || ""
  }
  get className() {
    return this.attrs.get("class") || ""
  }
  get href() {
    return this.attrs.get("href") || ""
  }
  get checked() {
    return this.attrs.has("checked")
  }
  get disabled() {
    return this.attrs.has("disabled")
  }
  get required() {
    return this.attrs.has("required")
  }
  get multiple() {
    return this.attrs.has("multiple")
  }
  get isContentEditable() {
    return this.attrs.get("contenteditable") === "true"
  }
  get options() {
    return this.descendants().filter((e) => e.tagName === "OPTION")
  }
  get text() {
    // <option>.text
    return this.innerText
  }

  getAttribute(a) {
    return this.attrs.has(a) ? this.attrs.get(a) : null
  }
  setAttribute(a, v) {
    this.attrs.set(a, String(v))
  }
  hasAttribute(a) {
    return this.attrs.has(a)
  }

  rawText() {
    return this.childNodes
      .filter((n) => n instanceof Text)
      .map((n) => n.data)
      .join("")
  }

  // The scanner's `style` reads go through getComputedStyle, but its own
  // `el.style` is never touched; this is here for the shim below.
  get inlineStyle() {
    const out = {}
    for (const part of String(this.attrs.get("style") || "").split(";")) {
      const i = part.indexOf(":")
      if (i < 0) continue
      out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim()
    }
    return out
  }

  get isConnected() {
    let p = this
    while (p.parentElement) p = p.parentElement
    return p === this.ownerRoot || p.tagName === "HTML"
  }

  get hiddenByCss() {
    for (let p = this; p; p = p.parentElement) {
      if (p.attrs.has("hidden")) return true
      if (p.inlineStyle.display === "none") return true
    }
    return false
  }

  // Rendered text, in the sense innerText means it: script/style contribute
  // nothing and a display:none subtree contributes nothing.
  get innerText() {
    if (UNRENDERED.has(this.tagName)) return ""
    if (this.attrs.has("hidden")) return ""
    if (this.inlineStyle.display === "none") return ""
    const parts = []
    for (const n of this.childNodes) {
      if (n instanceof Text) parts.push(n.data)
      else parts.push(n.innerText)
    }
    return parts.join(" ").replace(/\s+/g, " ").trim()
  }

  getBoundingClientRect() {
    const box = this.hiddenByCss
      ? { width: 0, height: 0 }
      : { width: 200, height: 20 }
    return {
      width: box.width,
      height: box.height,
      top: 0,
      left: 0,
      right: box.width,
      bottom: box.height,
    }
  }

  descendants() {
    const out = []
    const walk = (n) => {
      for (const k of n.childNodes) {
        if (k instanceof Text) continue
        out.push(k)
        walk(k)
      }
    }
    walk(this)
    return out
  }

  contains(n) {
    if (n === this) return true
    return this.descendants().includes(n)
  }

  closest(sel) {
    let p = this
    while (p) {
      if (matches(p, sel)) return p
      p = p.parentElement
    }
    return null
  }

  querySelectorAll(sel) {
    return this.descendants().filter((e) => matches(e, sel))
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null
  }

  compareDocumentPosition(other) {
    return other.order > this.order ? 4 : 2
  }
}

// --- selector matching -----------------------------------------------------
// Covers exactly the shapes scan-page.js asks for: comma lists of simple
// compounds (tag, #id, .cls, [attr], [attr='v'], [attr*='v']) plus the
// two-part "ancestor descendant" form used by the dropdown probe.
function matchesSimple(el, sel) {
  const s = sel.trim()
  if (!s || s === "*") return true
  let rest = s
  let ok = true
  const tagM = /^([a-zA-Z][\w-]*)/.exec(rest)
  if (tagM) {
    ok = ok && el.tagName === tagM[1].toUpperCase()
    rest = rest.slice(tagM[1].length)
  }
  const parts = rest.match(/(\[[^\]]*\]|#[\w\\-]+|\.[\w-]+)/g) || []
  if (rest.trim() && parts.join("") !== rest.trim()) return false
  for (const p of parts) {
    if (p.startsWith("#")) {
      ok = ok && el.id === p.slice(1).replace(/\\(.)/g, "$1")
    } else if (p.startsWith(".")) {
      ok = ok && el.className.split(/\s+/).includes(p.slice(1))
    } else {
      const m = /^\[([\w-]+)(?:([*$^]?)=["']?([^"'\]]*)["']?)?\]$/.exec(p)
      if (!m) return false
      const v = el.getAttribute(m[1])
      if (v === null) return false
      if (m[3] === undefined) continue
      if (m[2] === "*") ok = ok && v.includes(m[3])
      else if (m[2] === "$") ok = ok && v.endsWith(m[3])
      else if (m[2] === "^") ok = ok && v.startsWith(m[3])
      else ok = ok && v === m[3]
    }
  }
  return ok
}

function matches(el, sel) {
  for (const alt of String(sel).split(",")) {
    const chain = alt.trim().split(/\s+/)
    if (chain.length === 1) {
      if (matchesSimple(el, chain[0])) return true
      continue
    }
    if (!matchesSimple(el, chain[chain.length - 1])) continue
    let p = el.parentElement
    while (p) {
      if (matchesSimple(p, chain[0])) return true
      p = p.parentElement
    }
  }
  return false
}

// --- the parser ------------------------------------------------------------
const ATTR_RE = /([^\s"'>/=]+)(\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g

function parseAttrs(src, el) {
  ATTR_RE.lastIndex = 0
  let m
  while ((m = ATTR_RE.exec(src))) {
    const name = m[1].toLowerCase()
    if (!name || name === "/") continue
    const raw = m[3] ?? m[4] ?? m[5]
    el.attrs.set(name, raw === undefined ? "" : decodeEntities(raw))
  }
}

/**
 * Parse a served HTML document. Returns the <html> root plus the <body> and
 * <title> the scanner's document shim needs.
 */
export function parseHtml(html) {
  ORDER = 0
  const root = new El("html")
  const stack = [root]
  const top = () => stack[stack.length - 1]
  let i = 0
  let title = ""

  while (i < html.length) {
    const lt = html.indexOf("<", i)
    if (lt < 0) {
      const t = html.slice(i)
      if (t.trim()) top().append(new Text(decodeEntities(t)))
      break
    }
    if (lt > i) {
      const t = html.slice(i, lt)
      if (t.trim()) top().append(new Text(decodeEntities(t)))
    }
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt)
      i = end < 0 ? html.length : end + 3
      continue
    }
    if (html.startsWith("<!", lt)) {
      const end = html.indexOf(">", lt)
      i = end < 0 ? html.length : end + 1
      continue
    }
    if (html.startsWith("</", lt)) {
      const end = html.indexOf(">", lt)
      const name = html.slice(lt + 2, end < 0 ? html.length : end).trim()
      const tag = name.toLowerCase()
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].tagName === tag.toUpperCase()) {
          stack.length = s
          break
        }
      }
      i = end < 0 ? html.length : end + 1
      continue
    }
    // Open tag. `>` inside a quoted attribute value must not end it.
    let j = lt + 1
    let quote = null
    while (j < html.length) {
      const c = html[j]
      if (quote) {
        if (c === quote) quote = null
      } else if (c === '"' || c === "'") quote = c
      else if (c === ">") break
      j++
    }
    const inner = html.slice(lt + 1, j)
    const nameM = /^([a-zA-Z][\w:-]*)/.exec(inner)
    if (!nameM) {
      i = j + 1
      continue
    }
    const tag = nameM[1].toLowerCase()
    const el = new El(tag)
    el.ownerRoot = root
    parseAttrs(inner.slice(nameM[1].length), el)
    top().append(el)
    const selfClosing = /\/\s*$/.test(inner)
    i = j + 1
    if (VOID.has(tag) || selfClosing) continue
    if (RAW.has(tag)) {
      const close = html.toLowerCase().indexOf(`</${tag}`, i)
      const body = html.slice(i, close < 0 ? html.length : close)
      if (body)
        el.append(new Text(tag === "script" ? body : decodeEntities(body)))
      if (tag === "title") title = body.replace(/\s+/g, " ").trim()
      const end = close < 0 ? html.length : html.indexOf(">", close)
      i = end < 0 ? html.length : end + 1
      continue
    }
    stack.push(el)
  }

  const body = root.querySelector("body") || root
  for (const el of [root, ...root.descendants()]) el.ownerRoot = root
  return { root, body, title }
}

// --- running the real scanner ---------------------------------------------
const styleOf = (el) => {
  const own = el.inlineStyle
  const out = {
    visibility: "visible",
    display: el.attrs.has("hidden") ? "none" : "block",
    opacity: "1",
    color: "rgb(0, 0, 0)",
    fontSize: "16px",
  }
  // Inheriting properties resolve up the chain, which is what makes
  // `color: transparent` on a wrapper hide the text inside it.
  for (const prop of INHERITED) {
    for (let p = el; p; p = p.parentElement) {
      const v = p.inlineStyle[prop]
      if (v) {
        if (prop === "color") out.color = v
        else if (prop === "font-size") out.fontSize = v
        else out.visibility = v
        break
      }
      if (p !== el && prop === "visibility") continue
    }
  }
  if (own.display) out.display = own.display
  if (own.opacity) out.opacity = own.opacity
  return out
}

/**
 * Run the real .claude/skills/apply-job/scan-page.js over `html`.
 * Returns its output object. PROBE is always false — see the header.
 */
export async function runScanner(
  html,
  { url = "https://board.test/apply" } = {},
) {
  const { root, body, title } = parseHtml(html)
  const src = fs.readFileSync(SCANNER_PATH, "utf8")

  const doc = {
    body,
    title,
    documentElement: root,
    getElementById: (id) => root.descendants().find((e) => e.id === id) || null,
    querySelector: (s) => (matches(root, s) ? root : root.querySelector(s)),
    querySelectorAll: (s) =>
      (matches(root, s) ? [root] : []).concat(root.querySelectorAll(s)),
  }
  const win = {
    // A 0x0 viewport is the scanner's documented below-the-fold path: it does
    // not scroll the user's page, so it skips the occlusion check rather than
    // guessing. Faking elementFromPoint over a layout-free DOM would be worse.
    scrollX: 0,
    scrollY: 0,
    innerWidth: 0,
    innerHeight: 0,
    CSS: { escape: (s) => String(s).replace(/[^\w-]/g, "\\$&") },
  }
  const globals = {
    window: win,
    document: doc,
    CSS: win.CSS,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    location: { href: url },
    KeyboardEvent: class {},
    setTimeout,
    getComputedStyle: (el, pseudo) => {
      if (pseudo) return { content: "none" }
      return styleOf(el)
    },
  }
  const fn = new Function(...Object.keys(globals), src)
  fn(...Object.values(globals))
  return await win.__ajScan(false)
}
