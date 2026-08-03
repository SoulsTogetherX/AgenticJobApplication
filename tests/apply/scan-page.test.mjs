// scan-page.js is the one piece of this pipeline that genuinely runs INSIDE
// the job-application page, so it cannot be imported: it is a bare script that
// assigns window.__ajScan. These tests load its real text off disk and run it
// against a hand-built DOM, which is the only option here — the repo has no
// Playwright and no jsdom, deliberately (a browser download and a 3MB dev
// dependency for one file).
//
// What is being pinned is `labelExact`: the scanner's positive assertion that
// a field's `l` is the COMPLETE, VISIBLE text of its label. fill-plan.mjs
// refuses to auto-tick any consent box without it, so a false positive here is
// an arbitration clause ticked unattended and a false negative is the user
// ticking a box in the browser. Every ambiguous case must come back unset.
//
// The fake DOM below is deliberately small: it supports exactly the selector
// shapes scan-page.js uses, and unsupported ones return nothing rather than
// pretending. Fixtures are inline on purpose — tests/fixtures/boards/ is
// qa-adversary's full-page board set, and a second competing copy of it here
// would drift.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const SCANNER = path.join(
  ROOT,
  ".claude",
  "skills",
  "apply-job",
  "scan-page.js",
)
const SRC = fs.readFileSync(SCANNER, "utf8")

// --- the smallest DOM that can host the scanner ---------------------------

let ORDER = 0

class El {
  constructor(tag, attrs = {}, kids = []) {
    this.tagName = String(tag).toUpperCase()
    this.attrs = new Map()
    this.childNodes = []
    this.parentElement = null
    this.order = ORDER++
    // Test-only knobs, read by the stubs below, never by the scanner.
    this.rect = { width: 200, height: 20, top: 0, left: 0 }
    this.style = {}
    this.pseudo = {}
    this.text = null
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "rect" || k === "style" || k === "pseudo" || k === "text") {
        this[k] = v
        continue
      }
      if (k === "checked" || k === "disabled" || k === "multiple") {
        this[k] = v
        continue
      }
      if (v === undefined || v === null) continue
      this.attrs.set(k, String(v))
    }
    for (const kid of kids) this.append(kid)
  }

  append(kid) {
    const node = typeof kid === "string" ? new Text(kid) : kid
    node.parentElement = this
    this.childNodes.push(node)
    return node
  }

  get isConnected() {
    let p = this
    while (p.parentElement) p = p.parentElement
    return p === DOC.root || p === DOC.documentElement
  }

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
    return this.attrs.get("value") || ""
  }
  get className() {
    return this.attrs.get("class") || ""
  }
  get isContentEditable() {
    return this.attrs.get("contenteditable") === "true"
  }
  get options() {
    return this.descendants().filter((e) => e.tagName === "OPTION")
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

  // Rendered text: what a user reads. display:none subtrees contribute
  // nothing, exactly like the real innerText.
  get innerText() {
    if (this.text !== null) return this.text
    if (this.style.display === "none") return ""
    const parts = []
    for (const n of this.childNodes) {
      if (n instanceof Text) parts.push(n.data)
      else parts.push(n.innerText)
    }
    return parts.join(" ").replace(/\s+/g, " ").trim()
  }

  getBoundingClientRect() {
    const r = this.rect
    return {
      width: r.width,
      height: r.height,
      top: r.top ?? 0,
      left: r.left ?? 0,
      right: (r.left ?? 0) + r.width,
      bottom: (r.top ?? 0) + r.height,
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

class Text {
  constructor(data) {
    this.data = data
  }
}

// A selector matcher covering exactly what scan-page.js asks for: comma lists
// of simple compounds (tag, #id, [attr], [attr='v'], [attr*='v'], .cls) plus
// the two "ancestor descendant" forms used by the dropdown probe.
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
  const parts = rest.match(/(\[[^\]]*\]|#[\w-]+|\.[\w-]+)/g) || []
  if (rest.trim() && parts.join("") !== rest.trim()) return false
  for (const p of parts) {
    if (p.startsWith("#")) {
      ok = ok && el.id === p.slice(1)
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
    // "ancestor descendant" — only the two-part form is used.
    if (!matchesSimple(el, chain[chain.length - 1])) continue
    let p = el.parentElement
    while (p) {
      if (matchesSimple(p, chain[0])) return true
      p = p.parentElement
    }
  }
  return false
}

const DOC = { root: null }

function h(tag, attrs, kids) {
  return new El(tag, attrs, kids)
}

// Loads the real scanner text with the globals it expects. `new Function`
// rather than a vm realm so the DOM objects the scanner touches are ordinary
// same-realm objects.
// `viewport` opts in to the occlusion check: elementFromPoint only means
// anything for a point that is on screen, and the scanner will not scroll the
// user's page to find out — so with no viewport the scanner takes the
// documented below-the-fold path and skips it. Tests that want to exercise
// occlusion set one, and give their elements real rects.
function loadScanner(root, { viewport = null } = {}) {
  ORDER = 0
  DOC.root = root
  const hitsAt = (x, y) =>
    [root, ...root.descendants()].filter((e) => {
      const r = e.getBoundingClientRect()
      return (
        e.style.pointerEvents !== "none" &&
        x >= r.left &&
        x < r.right &&
        y >= r.top &&
        y < r.bottom
      )
    })
  const doc = {
    body: root,
    title: "Apply",
    documentElement: root,
    getElementById: (id) => root.descendants().find((e) => e.id === id) || null,
    querySelector: (s) => (matches(root, s) ? root : root.querySelector(s)),
    querySelectorAll: (s) =>
      (matches(root, s) ? [root] : []).concat(root.querySelectorAll(s)),
  }
  // Painted last wins, which is what a plain overlay does.
  if (viewport) {
    doc.elementFromPoint = (x, y) => {
      const hits = hitsAt(x, y)
      return hits.length ? hits[hits.length - 1] : null
    }
  }
  DOC.documentElement = root
  const win = {
    scrollX: 0,
    scrollY: 0,
    innerWidth: viewport ? viewport.width : 0,
    innerHeight: viewport ? viewport.height : 0,
    CSS: { escape: (s) => String(s).replace(/[^\w-]/g, "\\$&") },
  }
  const globals = {
    window: win,
    document: doc,
    CSS: win.CSS,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    location: { href: "https://board.test/apply" },
    KeyboardEvent: class {},
    setTimeout,
    getComputedStyle: (el, pseudo) => {
      if (pseudo) {
        const key = String(pseudo).replace(/^:+/, "")
        return { content: (el.pseudo && el.pseudo[key]) || "none" }
      }
      return {
        visibility: el.style.visibility || "visible",
        display: el.style.display || "block",
        opacity: el.style.opacity || "1",
        color: el.style.color || "rgb(0, 0, 0)",
        fontSize: el.style.fontSize || "16px",
      }
    },
  }
  const fn = new Function(...Object.keys(globals), SRC)
  fn(...Object.values(globals))
  DOC.win = win
  return win.__ajScan
}

const scan = (root, opts) => loadScanner(root, opts)(false)
const fieldFor = (out, pred) => out.fields.find(pred)
const onlyGroup = (out) => out.fields.find((f) => f.t === "checkbox")

// A 131-character certification: the exact shape the truncation hole was
// demonstrated with. Anything appended to it used to vanish at char 120.
const CERT =
  "I certify that the information provided in this application is true, " +
  "complete and correct to the best of my knowledge today."
const ARBITRATION = " I also agree to binding arbitration."

test("a plain visible <label for> is vouched for, at full length", async () => {
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("label", { for: "c1" }, [CERT]),
        h("input", { type: "checkbox", id: "c1" }),
      ]),
    ]),
  )
  const g = onlyGroup(out)
  assert.equal(g.labelExact, true)
  assert.equal(g.l, CERT)
  assert.ok(CERT.length > 120, "fixture must exceed the old truncation point")
  assert.equal(g.labelWhy, undefined)
})

test("the vouched label is the SAME string on the group and its option", async () => {
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("label", { for: "c1" }, [CERT]),
        h("input", { type: "checkbox", id: "c1" }),
      ]),
    ]),
  )
  const g = onlyGroup(out)
  assert.equal(g.o.length, 1)
  assert.equal(g.o[0].l, g.l)
})

test("appending an arbitration clause changes the string the user sees", async () => {
  const one = onlyGroup(
    await scan(
      h("body", {}, [
        h("div", {}, [
          h("label", { for: "c1" }, [CERT]),
          h("input", { type: "checkbox", id: "c1" }),
        ]),
      ]),
    ),
  )
  const two = onlyGroup(
    await scan(
      h("body", {}, [
        h("div", {}, [
          h("label", { for: "c1" }, [CERT + ARBITRATION]),
          h("input", { type: "checkbox", id: "c1" }),
        ]),
      ]),
    ),
  )
  // The whole point of the fix: these two used to be the identical 120 chars.
  assert.notEqual(one.l, two.l)
  assert.ok(two.l.endsWith("binding arbitration."))
  assert.equal(two.labelExact, true)
})

test("an aria-label that disagrees with the visible text is never vouched", async () => {
  // The decoupling attack verbatim: the page picks what is MATCHED
  // (aria-label) independently of what is DISPLAYED (the <label>).
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("label", { for: "c1" }, [
          "I agree to binding arbitration and waive a jury trial.",
        ]),
        h("input", {
          type: "checkbox",
          id: "c1",
          "aria-label": "I certify the information is true",
        }),
      ]),
    ]),
  )
  const g = onlyGroup(out)
  assert.equal(g.labelExact, undefined)
  assert.match(g.labelWhy, /second label|source is arialabel/)
})

test("an aria-label alone can never vouch, however innocuous", async () => {
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("input", {
          type: "checkbox",
          id: "c1",
          "aria-label": "I certify the information is true",
        }),
        h("span", {}, ["I agree to binding arbitration and waive a jury."]),
      ]),
    ]),
  )
  const g = onlyGroup(out)
  assert.equal(g.labelExact, undefined)
  assert.equal(g.labelWhy, "label source is arialabel")
  // ... and the label it reports is still the aria one, unchanged from before.
  assert.equal(g.l, "I certify the information is true")
})

test("a title attribute that disagrees withdraws the vouch", async () => {
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("label", { for: "c1" }, [CERT]),
        h("input", { type: "checkbox", id: "c1", title: "Consent to terms" }),
      ]),
    ]),
  )
  assert.equal(onlyGroup(out).labelExact, undefined)
})

test("aria-labelledby wins the name but a conflicting aria-label still defers", async () => {
  // aria-labelledby outranks aria-label, so the a11y name and the visible span
  // agree and the VOUCHABLE check alone would let this through. A page saying
  // two different things about one control is not a page to tick a box on.
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("span", { id: "t1" }, [CERT]),
        h("input", {
          type: "checkbox",
          id: "c1",
          "aria-labelledby": "t1",
          "aria-label": "I agree to binding arbitration.",
        }),
      ]),
    ]),
  )
  const g = onlyGroup(out)
  assert.equal(g.labelExact, undefined)
  assert.equal(g.labelWhy, "a second label says something else")
})

test("a <label for> on the far side of the page is not adjacent text", async () => {
  // label[for] is a formal association that reaches across a whole document.
  // What the user actually reads beside the box is the span; the certification
  // is somewhere else entirely.
  const out = await scan(
    h("body", {}, [
      h("header", {}, [h("div", {}, [h("label", { for: "c1" }, [CERT])])]),
      h("section", {}, [
        h("div", {}, [
          h("div", {}, [
            h("input", { type: "checkbox", id: "c1" }),
            h("span", {}, ["I agree to binding arbitration."]),
          ]),
        ]),
      ]),
    ]),
  )
  const g = onlyGroup(out)
  assert.equal(g.labelExact, undefined)
  assert.equal(g.labelWhy, "label is not adjacent to the control")
})

test("an aria-label that agrees exactly keeps the vouch", async () => {
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("label", { for: "c1" }, [CERT]),
        h("input", { type: "checkbox", id: "c1", "aria-label": CERT }),
      ]),
    ]),
  )
  assert.equal(onlyGroup(out).labelExact, true)
})

test("aria-labelledby pointing at visible text next to the box is vouched", async () => {
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("span", { id: "t1" }, [CERT]),
        h("input", {
          type: "checkbox",
          id: "c1",
          "aria-labelledby": "t1",
        }),
      ]),
    ]),
  )
  const g = onlyGroup(out)
  assert.equal(g.labelExact, true)
  assert.equal(g.l, CERT)
})

test("aria-labelledby pointing at a screen-reader-only box is not vouched", async () => {
  // The sr-only idiom: a 1x1 clipped element. Real to an accessibility tree,
  // invisible to the person reading the form.
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("span", { id: "t1", rect: { width: 1, height: 1 } }, [
          "I certify the information is true",
        ]),
        h("input", { type: "checkbox", id: "c1", "aria-labelledby": "t1" }),
        h("span", {}, ["I agree to binding arbitration."]),
      ]),
    ]),
  )
  const g = onlyGroup(out)
  assert.equal(g.labelExact, undefined)
  assert.equal(g.labelWhy, "label text is not visibly rendered")
})

// --- hiding text from the eye with pure CSS, no JavaScript at all ----------
// I originally framed this residual as "a board that patches DOM prototypes",
// which under-stated it badly: every case below is a stylesheet, and an
// earlier version of the vouch caught none of them.

test("opacity:0 on an ANCESTOR is not visible, though the element's own is 1", async () => {
  // The one that made the rest reachable: opacity does not inherit, so the
  // label's own computed opacity is still "1" and a check on the element alone
  // sails through while nothing is on screen.
  const out = await scan(
    h("body", {}, [
      h("div", { style: { opacity: "0" } }, [
        h("div", {}, [
          h("label", { for: "c1" }, [CERT]),
          h("input", { type: "checkbox", id: "c1" }),
        ]),
      ]),
    ]),
  )
  const g = onlyGroup(out)
  assert.equal(g.labelExact, undefined)
  assert.equal(g.labelWhy, "label text is not visibly rendered")
})

test("transparent text is not visible text", async () => {
  for (const color of ["transparent", "rgba(0, 0, 0, 0)"]) {
    const out = await scan(
      h("body", {}, [
        h("div", {}, [
          h("label", { for: "c1", style: { color } }, [CERT]),
          h("input", { type: "checkbox", id: "c1" }),
        ]),
      ]),
    )
    assert.equal(onlyGroup(out).labelExact, undefined, `color: ${color}`)
  }
  // and an ordinary colour still vouches
  const ok = await scan(
    h("body", {}, [
      h("div", {}, [
        h("label", { for: "c1", style: { color: "rgba(20, 20, 20, 1)" } }, [
          CERT,
        ]),
        h("input", { type: "checkbox", id: "c1" }),
      ]),
    ]),
  )
  assert.equal(onlyGroup(ok).labelExact, true)
})

test("font-size:0 text is not visible text", async () => {
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("label", { for: "c1", style: { fontSize: "0px" } }, [CERT]),
        h("input", { type: "checkbox", id: "c1" }),
      ]),
    ]),
  )
  assert.equal(onlyGroup(out).labelExact, undefined)
})

test("a label painted over by another element is not vouched", async () => {
  const label = h(
    "label",
    { for: "c1", rect: { width: 300, height: 20, top: 100, left: 0 } },
    [CERT],
  )
  const out = await scan(
    h("body", {}, [
      h("div", {}, [label, h("input", { type: "checkbox", id: "c1" })]),
      // Painted after, covering the label's centre.
      h("div", { rect: { width: 400, height: 60, top: 80, left: 0 } }, [
        "Something else entirely",
      ]),
    ]),
    { viewport: { width: 1000, height: 800 } },
  )
  const g = onlyGroup(out)
  assert.equal(g.labelExact, undefined)
  assert.equal(g.labelWhy, "label text is not visibly rendered")
})

test("an unoccluded label in view is still vouched (negative control)", async () => {
  // Same viewport, same geometry, no overlay: the occlusion check must not be
  // refusing everything, or the four tests above prove nothing.
  const out = await scan(
    h("body", {}, [
      h("div", { rect: { width: 400, height: 60, top: 80, left: 0 } }, [
        h(
          "label",
          { for: "c1", rect: { width: 300, height: 20, top: 100, left: 0 } },
          [CERT],
        ),
        h("input", { type: "checkbox", id: "c1" }),
      ]),
    ]),
    { viewport: { width: 1000, height: 800 } },
  )
  assert.equal(onlyGroup(out).labelExact, true)
})

test("a label parked off the left edge is not vouched", async () => {
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h(
          "label",
          { for: "c1", rect: { width: 200, height: 20, left: -9999 } },
          [CERT],
        ),
        h("input", { type: "checkbox", id: "c1" }),
      ]),
    ]),
  )
  assert.equal(onlyGroup(out).labelExact, undefined)
})

test("CSS ::after content carrying words withdraws the vouch", async () => {
  // Rendered on screen, absent from innerText — the last way to show a user
  // words the scanner cannot read.
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h(
          "label",
          {
            for: "c1",
            pseudo: { after: '" and I agree to binding arbitration."' },
          },
          [CERT],
        ),
        h("input", { type: "checkbox", id: "c1" }),
      ]),
    ]),
  )
  const g = onlyGroup(out)
  assert.equal(g.labelExact, undefined)
  assert.equal(g.labelWhy, "CSS content renders extra text")
})

test("a decorative ::after marker does not withdraw the vouch", async () => {
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("label", { for: "c1", pseudo: { after: '"*"' } }, [CERT]),
        h("input", { type: "checkbox", id: "c1" }),
      ]),
    ]),
  )
  assert.equal(onlyGroup(out).labelExact, true)
})

test("an icon url() in a pseudo element does not withdraw the vouch", async () => {
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h(
          "label",
          { for: "c1", pseudo: { before: 'url("data:image/svg,x")' } },
          [CERT],
        ),
        h("input", { type: "checkbox", id: "c1" }),
      ]),
    ]),
  )
  assert.equal(onlyGroup(out).labelExact, true)
})

test("two <label for> elements claiming one control is ambiguous", async () => {
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("label", { for: "c1" }, [CERT]),
        h("label", { for: "c1" }, ["and to binding arbitration"]),
        h("input", { type: "checkbox", id: "c1" }),
      ]),
    ]),
  )
  const g = onlyGroup(out)
  assert.equal(g.labelExact, undefined)
  assert.equal(g.labelWhy, "two <label for> elements claim this control")
})

test("a duplicated id makes label[for] ambiguous", async () => {
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("label", { for: "c1" }, [CERT]),
        h("input", { type: "checkbox", id: "c1" }),
      ]),
      h("div", {}, [h("input", { type: "text", id: "c1" })]),
    ]),
  )
  const g = onlyGroup(out)
  assert.equal(g.labelExact, undefined)
  assert.equal(g.labelWhy, "id is not unique, so label[for] is ambiguous")
})

test("a <label> wrapping two controls says which box for neither", async () => {
  const out = await scan(
    h("body", {}, [
      h("label", {}, [
        "I agree to both",
        h("input", { type: "checkbox", name: "a" }),
        h("input", { type: "checkbox", name: "b" }),
      ]),
    ]),
  )
  for (const g of out.fields.filter((f) => f.t === "checkbox")) {
    assert.equal(g.labelExact, undefined)
    assert.equal(g.labelWhy, "label covers more than this control")
  }
})

test("a wrapping <label> around one checkbox is vouched", async () => {
  const out = await scan(
    h("body", {}, [h("label", {}, [CERT, h("input", { type: "checkbox" })])]),
  )
  const g = onlyGroup(out)
  assert.equal(g.labelExact, true)
  assert.equal(g.l, CERT)
})

test("a fieldset legend is a group heading, never a vouched label", async () => {
  const out = await scan(
    h("body", {}, [
      h("fieldset", {}, [
        h("legend", {}, ["Voluntary disclosures"]),
        h("div", {}, [
          h("label", { for: "c1" }, [CERT]),
          h("input", { type: "checkbox", id: "c1" }),
        ]),
      ]),
    ]),
  )
  const g = onlyGroup(out)
  assert.equal(g.labelExact, undefined)
  assert.equal(g.labelWhy, "label source is fieldset legend")
  assert.equal(g.l, "Voluntary disclosures")
})

test("a label found by walking ancestors is a guess, never a vouch", async () => {
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("div", { class: "field-label" }, ["Consent"]),
        h("input", { type: "checkbox", name: "c" }),
      ]),
    ]),
  )
  const g = onlyGroup(out)
  assert.equal(g.labelExact, undefined)
  assert.equal(g.labelWhy, "label source is near")
})

test("a second box under the same label withdraws the vouch", async () => {
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("label", { for: "c1" }, [CERT]),
        h("input", { type: "checkbox", id: "c1", name: "consent" }),
      ]),
      h("div", {}, [
        h("label", { for: "c2" }, [CERT]),
        h("input", { type: "checkbox", id: "c2", name: "consent" }),
      ]),
    ]),
  )
  const g = onlyGroup(out)
  assert.equal(g.o.length, 2, "same name means one group")
  assert.equal(g.labelExact, undefined)
  assert.equal(g.labelWhy, "more than one control shares this label")
  // and both option labels went back to the short form
  for (const o of g.o) assert.ok(o.l.length <= 80)
})

test("a label longer than the vouch ceiling defers instead of truncating", async () => {
  const wall = "We agree that ".repeat(120)
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("label", { for: "c1" }, [wall]),
        h("input", { type: "checkbox", id: "c1" }),
      ]),
    ]),
  )
  const g = onlyGroup(out)
  assert.equal(g.labelExact, undefined)
  assert.match(g.labelWhy, /longer than 1000/)
  assert.equal(g.l.length, 120, "and it is cut exactly as it always was")
})

test("a wordless label vouches for nothing", async () => {
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("label", { for: "c1" }, ["*"]),
        h("input", { type: "checkbox", id: "c1" }),
      ]),
    ]),
  )
  assert.equal(onlyGroup(out).labelExact, undefined)
})

test("a display:none label is not visible text", async () => {
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("label", { for: "c1", style: { display: "none" } }, [CERT]),
        h("input", { type: "checkbox", id: "c1" }),
      ]),
    ]),
  )
  // innerText of a display:none element is empty, so the waterfall falls
  // through to something else entirely — but it must not be vouched.
  assert.equal(onlyGroup(out).labelExact, undefined)
})

test("labelExact is never emitted as false, so `=== true` is the only test", async () => {
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("input", {
          type: "checkbox",
          id: "c1",
          "aria-label": "Subscribe to updates",
        }),
      ]),
    ]),
  )
  const g = onlyGroup(out)
  assert.ok(!("labelExact" in g), "absent, not false")
})

test("no page-controlled attribute can force the vouch on", async () => {
  // Anything a hostile board might try to set directly. The only route to
  // labelExact is having a plain, visible, unambiguous label — at which point
  // the vouched string is the one on screen, which is the whole point.
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("input", {
          type: "checkbox",
          id: "c1",
          "aria-label": "I certify",
          "data-label-exact": "true",
          labelExact: "true",
          "data-aj-exact": "true",
        }),
      ]),
    ]),
  )
  assert.equal(onlyGroup(out).labelExact, undefined)
  assert.ok(!SRC.includes("labelExact: true ||"))
  // No read path from the DOM into the flag.
  assert.ok(
    !/getAttribute\(\s*["'][^"']*exact/i.test(SRC),
    "nothing reads an 'exact' attribute off the page",
  )
})

// --- blast radius: everything that is NOT a checkbox is unchanged ---------

test("non-checkbox labels are still cut at 120 characters", async () => {
  const long = CERT + ARBITRATION
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("label", { for: "t1" }, [long]),
        h("input", { type: "text", id: "t1" }),
      ]),
      h("div", {}, [
        h("label", { for: "s1" }, [long]),
        h("select", { id: "s1" }, [h("option", { text: "Yes" }, [])]),
      ]),
    ]),
  )
  for (const f of out.fields) {
    assert.equal(f.l.length, 120)
    assert.equal(f.labelExact, undefined)
  }
})

test("a text field still prefers aria-label exactly as it did before", async () => {
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("label", { for: "t1" }, ["Visible"]),
        h("input", { type: "text", id: "t1", "aria-label": "Aria" }),
      ]),
    ]),
  )
  assert.equal(out.fields[0].l, "Aria")
})

test("a field whose visible label contradicts its aria-label reports both", async () => {
  // <label for>Email</label> plus aria-label="Emergency contact phone": the
  // plan built from `l` alone describes a form the user is not looking at.
  // `l` is unchanged — it is what answer-bank matches and what the form
  // fingerprint hashes — and the contradiction is reported beside it.
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("label", { for: "t1" }, ["Email"]),
        h("input", {
          type: "text",
          id: "t1",
          "aria-label": "Emergency contact phone",
        }),
      ]),
    ]),
  )
  assert.equal(out.fields[0].l, "Emergency contact phone")
  assert.equal(out.fields[0].lSeen, "Email")
})

test("an honest field reports no contradiction at all", async () => {
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("label", { for: "t1" }, ["Email"]),
        h("input", { type: "text", id: "t1", "aria-label": "Email" }),
      ]),
      h("div", {}, [
        h("label", { for: "t2" }, ["Full name"]),
        h("input", { type: "text", id: "t2" }),
      ]),
    ]),
  )
  for (const f of out.fields) {
    assert.equal(f.lSeen, undefined, `${f.l} should carry no lSeen`)
  }
  // And it costs nothing on the wire: page.evaluate serialises the scan, and
  // an undefined value is not a key. This is the shape consumers actually see.
  for (const f of JSON.parse(JSON.stringify(out)).fields) {
    assert.ok(!("lSeen" in f), `${f.l} should carry no lSeen key`)
  }
})

test("a screen-reader-only visible label is not offered as what the user sees", async () => {
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("label", { for: "t1", rect: { width: 1, height: 1 } }, ["Email"]),
        h("input", { type: "text", id: "t1", "aria-label": "Phone" }),
      ]),
    ]),
  )
  assert.equal(out.fields[0].lSeen, undefined)
})

test("an aria-labelledby pointed at HIDDEN text is a divergence too", async () => {
  // The carrier the first version of lSeen missed. It only asked which SOURCE
  // `l` came from (aria-label or placeholder/name), and aria-labelledby was not
  // on that list because it points at page text. But it points at an element by
  // id from outside that element, so it can name a clipped, transparent or
  // zero-size one — and then `l` is exactly as unreadable as an aria-label,
  // while the visible <label for> says something else. Same attack, same
  // approval message describing a form the user is not looking at.
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("span", { id: "sr", rect: { width: 1, height: 1 } }, [
          "Emergency contact phone",
        ]),
        h("label", { for: "t1" }, ["Email"]),
        h("input", { type: "text", id: "t1", "aria-labelledby": "sr" }),
      ]),
    ]),
  )
  assert.equal(out.fields[0].l, "Emergency contact phone")
  assert.equal(out.fields[0].lSeen, "Email")
})

test("an aria-labelledby pointed at VISIBLE text is not reported as a divergence", async () => {
  // The other half, and the reason the test is visibility and not source: this
  // page shows BOTH strings, so `l` is text the user can actually read. There
  // is nothing to warn about — showing it is not a lie — and reporting every
  // such field would turn lSeen into noise on honest boards that pair a
  // question paragraph with a short field label.
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("span", { id: "q" }, ["What is your emergency contact number?"]),
        h("label", { for: "t1" }, ["Phone"]),
        h("input", { type: "text", id: "t1", "aria-labelledby": "q" }),
      ]),
    ]),
  )
  assert.equal(out.fields[0].l, "What is your emergency contact number?")
  assert.equal(out.fields[0].lSeen, undefined)
})

test("a consent box labelled by hidden aria-labelledby reports the visible text", async () => {
  // The same carrier on the branch that matters most: a tick ASSERTS
  // something. The vouch already refused this ("label text is not visibly
  // rendered"), so the box defers either way — but the label shown beside that
  // defer was the invisible string, which is what the user would be asked
  // about.
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("span", { id: "sr", rect: { width: 1, height: 1 } }, [
          "I certify the information is true",
        ]),
        h("label", { for: "c1" }, [
          "I agree to binding arbitration and waive a jury trial.",
        ]),
        h("input", { type: "checkbox", id: "c1", "aria-labelledby": "sr" }),
      ]),
    ]),
  )
  const g = onlyGroup(out)
  assert.equal(g.labelExact, undefined)
  assert.equal(g.labelWhy, "label text is not visibly rendered")
  assert.equal(g.l, "I certify the information is true")
  assert.match(g.lSeen, /binding arbitration/)
})

test("a checkbox reports the contradiction too, and never vouches", async () => {
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("label", { for: "c1" }, [
          "I agree to binding arbitration and waive a jury trial.",
        ]),
        h("input", {
          type: "checkbox",
          id: "c1",
          "aria-label": "I certify the information is true",
        }),
      ]),
    ]),
  )
  const g = onlyGroup(out)
  assert.equal(g.labelExact, undefined)
  assert.equal(g.l, "I certify the information is true")
  assert.match(g.lSeen, /binding arbitration/)
})

test("the scan still reports the shape it always did", async () => {
  const out = await scan(
    h("body", {}, [
      h("h1", {}, ["Apply for Backend Engineer"]),
      h("div", {}, [
        h("label", { for: "t1" }, ["Full name"]),
        h("input", { type: "text", id: "t1", value: "Ada" }),
      ]),
      h("button", { text: "Submit application" }, []),
    ]),
  )
  assert.equal(out.kind, "form")
  assert.equal(out.heading, "Apply for Backend Engineer")
  assert.equal(out.fields[0].l, "Full name")
  assert.equal(out.fields[0].v, "Ada")
  assert.equal(out.btns[0].r, "submit")
})

// --- the element's own identity: n / ac ------------------------------------
//
// These are REPORTED, not trusted. See the header block in scan-page.js: a
// page chooses `name`, `type` and `autocomplete` alike, so none of them is
// evidence about what a value will be used for. What these tests pin is only
// that the scanner puts the page's own statements on the wire as fields of
// their own, instead of leaving a consumer to parse them back out of `sel` —
// which it could not do, because `sel` carries whichever SINGLE attribute
// made the element unique, and stableSel() tries `#id` first.
//
// The last test in this section is the one that matters most: it pins that
// the keys do NOT rescue a lie once the page renames its attributes to agree
// with the label. A future reader must not be able to mistake this for a
// control.

test("the element's own name attribute is reported, not buried in the selector", async () => {
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("label", { for: "m-phone" }, ["Phone number"]),
        h("input", { type: "text", id: "m-phone", name: "ssn" }),
      ]),
    ]),
  )
  const f = out.fields[0]
  // The selector says "m-phone", which agrees with the lying label. The name
  // says "ssn". Without `n` a consumer reading `sel` has no second statement
  // to compare against, which is exactly how the routing guard was
  // unreachable.
  assert.equal(f.sel, "#m-phone")
  assert.equal(f.n, "ssn")
})

test("a name attribute is reported on the OPTION of a checkbox group, like sel", async () => {
  // A checkbox/radio group is a synthetic object with no element of its own,
  // so its identity has to ride on the stamped option — the same place `sel`
  // already lives.
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("p", { id: "q1" }, ["Are you legally authorized to work?"]),
        h("input", {
          type: "checkbox",
          id: "m-auth",
          name: "agree_arbitration",
          "aria-labelledby": "q1",
        }),
      ]),
    ]),
  )
  const g = onlyGroup(out)
  assert.equal(g.n, undefined, "the group is synthetic and has no element")
  assert.equal(g.o[0].n, "agree_arbitration")
  assert.equal(g.o[0].sel, "#m-auth")
})

test("autocomplete is reported when it names a field", async () => {
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("label", { for: "a1" }, ["Phone"]),
        h("input", { type: "text", id: "a1", autocomplete: "tel" }),
      ]),
    ]),
  )
  assert.equal(out.fields[0].ac, "tel")
})

test("autocomplete=off/on name no field and are not reported", async () => {
  // "on"/"off" answer "should the browser autofill this", not "what is this".
  // Emitting them would put a category-free string on the wire for every
  // field of any form that turns autofill off wholesale.
  for (const v of ["off", "on", "OFF"]) {
    const out = await scan(
      h("body", {}, [
        h("div", {}, [
          h("label", { for: "a1" }, ["Phone"]),
          h("input", { type: "text", id: "a1", autocomplete: v }),
        ]),
      ]),
    )
    assert.equal(out.fields[0].ac, undefined, `autocomplete="${v}" was emitted`)
  }
})

test("an honest field with no name or autocomplete carries neither key", async () => {
  // Absent on the wire rather than present-and-empty, so this costs nothing
  // on a form that does not use them.
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("label", { for: "t1" }, ["Full name"]),
        h("input", { type: "text", id: "t1" }),
      ]),
    ]),
  )
  const f = out.fields[0]
  assert.ok(!("n" in f), `n was emitted as ${JSON.stringify(f.n)}`)
  assert.ok(!("ac" in f), `ac was emitted as ${JSON.stringify(f.ac)}`)
})

test("renaming the attributes to agree with a lying label leaves NOTHING to detect", async () => {
  // THE HONEST LIMIT, pinned so it cannot be quietly forgotten. This is the
  // same attack as the first test in this section — a control that harvests a
  // government ID under a "Phone number" label — with one difference: the
  // page also renamed `name` and `autocomplete` to agree with the label.
  //
  // Every identity token the DOM can show now says "phone". The field's real
  // meaning is decided server-side and is not in the document at all. So a
  // consumer comparing `l` against n/t/ac/sel finds no contradiction, and it
  // is CORRECT that it finds none — there is nothing here to find.
  //
  // Which is why these keys are not the control. The control is value-side:
  // an SSN never enters the answer bank, so there is no SSN to misroute.
  const out = await scan(
    h("body", {}, [
      h("div", {}, [
        h("label", { for: "m-phone" }, ["Phone number"]),
        h("input", {
          type: "text",
          id: "m-phone",
          name: "phone_number",
          autocomplete: "tel",
        }),
      ]),
    ]),
  )
  const f = out.fields[0]
  assert.deepEqual(
    { sel: f.sel, n: f.n, ac: f.ac, t: f.t },
    { sel: "#m-phone", n: "phone_number", ac: "tel", t: "text" },
    "every DOM-visible identity token agrees with the label; the scanner has " +
      "no way to know the value is bound for an SSN column",
  )
})

// --- the installed global ---------------------------------------------------

test("the installed scanner cannot be swapped out afterwards", async () => {
  // Not load-bearing: scan-engine.mjs never reads window.__ajScan, and the MCP
  // driver strips every vouch precisely because it must. This removes a free
  // move — a script that runs after us cannot quietly replace the scanner, and
  // an attempt fails loudly instead of succeeding in silence.
  await scan(h("body", {}, [h("input", { type: "text", id: "t1" })]))
  const win = DOC.win
  const ours = win.__ajScan
  assert.equal(typeof ours, "function")

  const d = Object.getOwnPropertyDescriptor(win, "__ajScan")
  assert.equal(d.writable, false)
  assert.equal(d.configurable, false)

  // A later script cannot take it over. This file is a module, so the
  // assignment throws here; page scripts are usually sloppy, where the same
  // assignment fails SILENTLY instead. Either way it does not take effect,
  // which is the property being pinned.
  assert.throws(() => {
    win.__ajScan = () => ({ fields: [{ labelExact: true }] })
  }, /read only|read-only/i)
  assert.equal(win.__ajScan, ours)
  assert.throws(() =>
    Object.defineProperty(win, "__ajScan", { value: () => ({}) }),
  )
})

test("the scanner still loads as a plain script and the slice marker holds", () => {
  // The file is loaded three ways — addInitScript, addScriptTag and
  // (0,eval)(src) — all of which run it as a SCRIPT, so the lock statement
  // after the function must not break any of them. And scan-engine.mjs slices
  // between the assignment and the marker; if the marker moves, the slice
  // swallows the lock and the page-side eval gets two statements.
  const marker = "// --- scanner ends here"
  assert.ok(SRC.includes(marker), "the slice marker must exist")
  const after = SRC.slice(SRC.indexOf(marker))
  assert.ok(after.includes("Object.defineProperty"))
  assert.ok(
    !SRC.slice(0, SRC.indexOf(marker)).includes("Object.defineProperty"),
    "nothing may sit between the function and the marker",
  )
  // ASI hazard: the statement after the arrow body must not start with a
  // character that continues the expression.
  const next = after.split(/\r?\n/).find((l) => /^\s*[^/\s]/.test(l))
  assert.ok(!/^\s*[([`+\-/]/.test(next), `ASI hazard: ${next}`)
})

test("the harness itself can see a broken vouch (negative control)", async () => {
  // A test that cannot fail is worse than no test. This asserts the fixture
  // shape that MUST vouch really does, so the suite goes red if vouchFail
  // starts refusing everything — which is the cheap way to fake a pass here.
  const good = onlyGroup(
    await scan(
      h("body", {}, [
        h("div", {}, [
          h("label", { for: "c1" }, ["I agree to the terms of service"]),
          h("input", { type: "checkbox", id: "c1" }),
        ]),
      ]),
    ),
  )
  assert.equal(good.labelExact, true)
  assert.equal(good.l, "I agree to the terms of service")
})

// ---------------------------------------------------------------------------
// sectionOf() — the heading a field sits under
// ---------------------------------------------------------------------------
//
// ADDED 2026-07-31 (qa-breaker), replacing a source grep in
// tests/apply/edge-cases.test.mjs that matched `f.section = s` and called the
// runtime behaviour "a gap needing a Playwright leg". It is not: the fake DOM
// above already supports everything sectionOf() touches — querySelectorAll with
// attribute selectors, contains(), compareDocumentPosition() and
// parentElement — so the branch can be RUN, and a grep here was a last resort
// that was never actually last. Downstream, tests/apply/edge-cases.test.mjs's
// E8 block proves buildPlan USES `section`; these prove the scanner produces
// one, and the pair closes E8 end to end without a browser.

const attachForm = (headingTag = "h3") =>
  h("body", {}, [
    h("form", {}, [
      h("div", {}, [
        h(headingTag, {}, ["Resume"]),
        h("label", { for: "r" }, ["Attach"]),
        h("input", { type: "file", id: "r", name: "job_application[resume]" }),
      ]),
      h("div", {}, [
        h(headingTag, {}, ["Cover Letter"]),
        h("label", { for: "c" }, ["Attach"]),
        h("input", { type: "file", id: "c", name: "job_application[cover]" }),
      ]),
    ]),
  ])

const filesOf = (out) => out.fields.filter((f) => f.t === "file")

test("section: two identically-labelled file inputs come back with DIFFERENT headings", async () => {
  const files = filesOf(await scan(attachForm()))
  assert.equal(files.length, 2)
  assert.deepEqual(
    files.map((f) => f.l),
    ["Attach", "Attach"],
    "precondition: the labels really are identical, or `section` is not what " +
      "is being measured",
  )
  assert.deepEqual(
    files.map((f) => f.section),
    ["Resume", "Cover Letter"],
    "the heading above each input is the only thing that tells them apart",
  )
})

test("section: a <legend> counts as a heading, and a heading only speaks for its OWN container", async () => {
  // The greenhouse-step2 incident, verbatim: a fieldset's legend CLOSES before
  // the next control is rendered, so by document order it precedes a field it
  // has nothing to do with. `owns()` is what stops it being stamped on.
  const out = await scan(
    h("body", {}, [
      h("form", {}, [
        h("fieldset", {}, [
          h("legend", {}, ["Voluntary Self-Identification of Disability"]),
          h("label", { for: "d" }, ["Disability status"]),
          h("input", { type: "text", id: "d" }),
        ]),
        h("div", {}, [
          h("label", { for: "c1" }, ["I certify the above is accurate"]),
          h("input", { type: "checkbox", id: "c1" }),
        ]),
      ]),
    ]),
  )
  const inside = out.fields.find((f) => f.l === "Disability status")
  assert.equal(
    inside.section,
    "Voluntary Self-Identification of Disability",
    "a field INSIDE the fieldset does sit under its legend",
  )
  const outside = out.fields.find((f) => f.t === "checkbox")
  assert.equal(
    outside.section,
    undefined,
    "and the checkbox after it does NOT — 'the last heading before this " +
      "control' alone got exactly this wrong on the first real page",
  )
})

test("section: the page's own <h1> is never a section", async () => {
  const out = await scan(
    h("body", {}, [
      h("h1", {}, ["Apply for Senior Engineer"]),
      h("label", { for: "e" }, ["Email"]),
      h("input", { type: "email", id: "e" }),
    ]),
  )
  const f = out.fields.find((x) => x.l === "Email")
  assert.equal(
    f.section,
    undefined,
    "the page heading is on every field or none, so stamping it " +
      "distinguishes nothing — which is the whole property `section` supplies",
  )
})

test("section: a body-level heading that is NOT the page h1 is still refused", async () => {
  // WRITTEN BECAUSE THE CANARY CAUGHT THE TEST, not the code. Deleting the
  // `p.tagName === "BODY"` line from owns() left the h1 test above green: that
  // case is suppressed by the SEPARATE `t === pageHeading` rule, so the h1 test
  // never exercised the BODY branch it claimed to. This one does — an <h2>
  // directly under <body>, with a different h1 present, so pageHeading cannot
  // be what refuses it. Removing the BODY guard turns this red.
  const out = await scan(
    h("body", {}, [
      h("h1", {}, ["Careers at Example"]),
      h("h2", {}, ["Application"]),
      h("label", { for: "e" }, ["Email"]),
      h("input", { type: "email", id: "e" }),
    ]),
  )
  const f = out.fields.find((x) => x.l === "Email")
  assert.equal(
    f.section,
    undefined,
    "a heading whose parent is BODY contains every field on the page; " +
      "stamping 'Application' on all of them is the same as stamping nothing",
  )
})

test("section: a heading that merely repeats the label is suppressed", async () => {
  const out = await scan(
    h("body", {}, [
      h("form", {}, [
        h("div", {}, [
          h("h3", {}, ["Email"]),
          h("label", { for: "e" }, ["Email"]),
          h("input", { type: "email", id: "e" }),
        ]),
      ]),
    ]),
  )
  const f = out.fields.find((x) => x.l === "Email")
  assert.equal(
    f.section,
    undefined,
    "a section equal to the label tells a consumer nothing the label did not",
  )
})

test("section: a form with no headings at all leaves every field unstamped", async () => {
  // The negative control. Without it, a sectionOf() that returned the same
  // string for everything would satisfy the first test above.
  const out = await scan(
    h("body", {}, [
      h("form", {}, [
        h("div", {}, [
          h("label", { for: "r" }, ["Attach"]),
          h("input", { type: "file", id: "r" }),
        ]),
        h("div", {}, [
          h("label", { for: "c" }, ["Attach"]),
          h("input", { type: "file", id: "c" }),
        ]),
      ]),
    ]),
  )
  for (const f of out.fields) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(f, "section"),
      false,
      `no heading exists, so nothing may be invented: ${JSON.stringify(f)}`,
    )
  }
})

// ---------------------------------------------------------------------------
// A QUESTION ANSWERED BY A PAIR OF <button>s
//
// THE INCIDENT (Ashby, 2026-08-03). "Will you now or in the future require
// sponsorship for employment visa status?" was rendered as two <button>s with
// no aria state. The button loop filed both in `btns` with r:"other" — a list
// fill-plan.mjs never reads — so the plan reported four deferred fields and
// NEVER MENTIONED THE QUESTION. It was found by hand-reading the DOM.
//
// WHAT THESE TESTS ARE FOR, in the order the risk runs:
//   1. the pair is SEEN at all (the safety half — a silence is not a refusal)
//   2. a pair whose answer set is not recognised carries NO verb
//   3. real actions — submit, next, back, upload, auth — still reach `btns`
//      untouched, because the detector runs before that loop and a mistake
//      here eats navigation
// Nothing below asserts that anything gets CLICKED: `widget: "buttons"` is on
// both tiers precisely because no verb in this pipeline operates a <button>.
// ---------------------------------------------------------------------------

const SPONSOR =
  "Will you now or in the future require sponsorship for employment visa status?"
const LICENCE = "Do you hold a valid driving licence?"

// The Ashby rendering, reduced to the two traits that made it invisible: no
// aria state anywhere, and the "selected" button marked only by a build-hashed
// class that is a different string after the board's next deploy.
const buttonPair = (question, a, b) =>
  h("body", {}, [
    h("form", {}, [
      h("div", { class: "field-entry" }, [
        h("label", {}, [question]),
        h("div", { class: "_container_1svni_1" }, [
          h("button", { type: "button", class: "_option_x _active_1svni_57" }, [
            a,
          ]),
          h("button", { type: "button", class: "_option_x" }, [b]),
        ]),
      ]),
      h("button", { type: "submit", id: "go" }, ["Submit Application"]),
    ]),
  ])

test("a Yes/No pair with no aria state becomes a field, not two nameless buttons", async () => {
  const out = await scan(buttonPair(SPONSOR, "Yes", "No"))
  const g = out.fields.find((f) => f.l === SPONSOR)
  assert.ok(g, "the question must reach `fields`; in `btns` nothing reads it")
  assert.equal(g.t, "radio", "a recognised Yes/No set travels as what it is")
  assert.deepEqual(
    g.o.map((o) => o.l),
    ["Yes", "No"],
  )
  // The buttons are stamped by this pass, so the loop below skips them. Left
  // in `btns` they would be reported twice, and the second report is the one
  // no consumer reads.
  assert.deepEqual(
    out.btns.map((b) => b.l),
    ["Submit Application"],
  )
})

test("the group claims NOTHING about which button is selected", async () => {
  // The real board marks it with a hashed class — a different string after the
  // next deploy. There is no honest way to read that, so `on` stays unset
  // rather than guessed, and a consumer asking "is one already chosen" gets no
  // answer instead of a wrong one.
  const out = await scan(buttonPair(SPONSOR, "Yes", "No"))
  const g = out.fields.find((f) => f.l === SPONSOR)
  for (const o of g.o) {
    assert.equal(
      o.on,
      undefined,
      `the hashed active class is not a signal: ${JSON.stringify(o)}`,
    )
  }
})

test("`widget: buttons` is set on the RECOGNISED tier too", async () => {
  // Not decoration. fill-engine.mjs's kindOf() answers "forbidden:button", so
  // no verb here can operate this control whatever `t` says — and fill-plan.mjs
  // reads this key to keep such a field out of `items`. Dropping it from the
  // recognised tier does not make the click work; it makes the plan claim a
  // tick that never happened.
  const out = await scan(buttonPair(SPONSOR, "Yes", "No"))
  assert.equal(out.fields.find((f) => f.l === SPONSOR).widget, "buttons")
})

test("a HOSTILE pair does not become a fillable field", async () => {
  // The fill engine clicks what the plan targets, and this is the file where
  // that mistake gets made. Structurally this page is identical to the honest
  // one above — that is the point, because the detector is structural. What
  // refuses it is the answer set: "Delete my account" / "Keep" is not one this
  // file recognises, so the group carries a type fill-plan.mjs's VERB map has
  // no entry for and lands in its `unsupported field type` defer.
  const q = "Delete my account and all stored applications?"
  const out = await scan(buttonPair(q, "Delete my account", "Keep"))
  const g = out.fields.find((f) => f.l === q)
  assert.ok(g, "it must still be SEEN — a silence is not a refusal")
  assert.equal(g.t, "widget")
  assert.equal(g.widget, "buttons")
  assert.match(g.labelWhy, /answer set/)
})

test("a Yes/No pair under a DESTRUCTIVE question falls back to tier 1", async () => {
  // A backstop, and it is not the control: what actually stops a hostile pair
  // is that filling one needs an exact hit on a question the user themselves
  // recorded. This closes the one case that cannot be undone.
  const out = await scan(buttonPair("Withdraw my application?", "Yes", "No"))
  const g = out.fields.find((f) => f.l === "Withdraw my application?")
  assert.equal(g.t, "widget", "a recognised answer set does not license this")
})

test("real submit / next / back / upload / auth buttons still land in btns untouched", async () => {
  // The detector runs BEFORE the button loop and stamps what it takes, so a
  // mistake here silently eats navigation. Every one of these is short and
  // sits next to a question; only roleOf() keeps them out.
  const out = await scan(
    h("body", {}, [
      h("form", {}, [
        h("div", {}, [
          h("label", {}, [LICENCE]),
          h("div", {}, [
            h("button", { type: "button" }, ["Back"]),
            h("button", { type: "button" }, ["Next"]),
            h("button", { type: "button" }, ["Upload"]),
            h("button", { type: "button" }, ["Sign in"]),
            h("button", { type: "submit" }, ["Submit Application"]),
          ]),
        ]),
      ]),
    ]),
  )
  assert.deepEqual(
    out.btns.map((b) => [b.l, b.r]),
    [
      ["Back", "back"],
      ["Next", "next"],
      ["Upload", "upload"],
      ["Sign in", "auth"],
      ["Submit Application", "submit"],
    ],
  )
  assert.deepEqual(out.fields, [], "not one of these is an answer")
})

test("an action sharing the row with the pair stays an action, and the pair is still seen", async () => {
  // The compact rendering: question, Yes, No and Submit in one container.
  // Giving up here would be the silent miss again, so the action's words come
  // out of the question text and the button itself is left for `btns`.
  const out = await scan(
    h("body", {}, [
      h("form", {}, [
        h("div", {}, [
          h("span", {}, [LICENCE]),
          h("button", { type: "button" }, ["Yes"]),
          h("button", { type: "button" }, ["No"]),
          h("button", { type: "submit" }, ["Submit Application"]),
        ]),
      ]),
    ]),
  )
  assert.deepEqual(
    out.fields.map((f) => [f.l, f.t]),
    [[LICENCE, "radio"]],
  )
  assert.deepEqual(
    out.btns.map((b) => b.l),
    ["Submit Application"],
  )
})

test("a toolbar of short unnamed buttons is NOT a field — the container asks nothing", async () => {
  // The discriminator is the question, not the buttons. Without it "Bold /
  // Italic" in a rich-text editor becomes an unfillable defer on every board
  // that has one, which is how a checker starts crying wolf and gets ignored.
  const out = await scan(
    h("body", {}, [
      h("form", {}, [
        h("div", {}, [
          h("label", { for: "c" }, ["Cover letter"]),
          h("div", { class: "toolbar" }, [
            h("button", { type: "button" }, ["Bold"]),
            h("button", { type: "button" }, ["Italic"]),
          ]),
          h("textarea", { id: "c" }),
        ]),
      ]),
    ]),
  )
  assert.deepEqual(
    out.fields.map((f) => f.t),
    ["textarea"],
  )
  assert.deepEqual(
    out.btns.map((b) => b.l),
    ["Bold", "Italic"],
  )
})

test("buttons wrapped one per div are still one group — ancestors, not siblings", async () => {
  // Whether the two buttons share a parent is a fact about one board's CSS.
  // A detector that turned on it would miss the next board for a reason that
  // has nothing to do with the question.
  const out = await scan(
    h("body", {}, [
      h("form", {}, [
        h("div", { class: "q" }, [
          h("span", { class: "label" }, [SPONSOR]),
          h("div", { class: "opts" }, [
            h("div", {}, [h("button", { type: "button" }, ["Yes"])]),
            h("div", {}, [h("button", { type: "button" }, ["No"])]),
          ]),
        ]),
      ]),
    ]),
  )
  assert.deepEqual(
    out.fields.map((f) => [f.l, f.t, f.o.length]),
    [[SPONSOR, "radio", 2]],
  )
})

test("a STATEFUL button pair is seen too, and its declared state is reported", async () => {
  // MEASURED, not assumed. The button loop skips a control carrying
  // aria-checked / -pressed / -selected so the widget sweep can report it —
  // but the sweep skips NATIVE tags and BUTTON is one, so for a <button> that
  // hand-off goes NOWHERE: a lone <button aria-pressed> produces no field and
  // no button at all. That pre-existing hole is not closed here. What is
  // closed is the paired case, and because the page DID declare its state,
  // `on` is reported instead of guessed.
  const out = await scan(
    h("body", {}, [
      h("form", {}, [
        h("div", {}, [
          h("label", {}, ["Have you worked here before?"]),
          h("div", {}, [
            h("button", { type: "button", "aria-pressed": "true" }, ["Yes"]),
            h("button", { type: "button", "aria-pressed": "false" }, ["No"]),
          ]),
        ]),
      ]),
    ]),
  )
  assert.deepEqual(
    out.fields.map((f) => [f.l, f.t, f.o.map((o) => [o.l, o.on ?? null])]),
    [
      [
        "Have you worked here before?",
        "radio",
        [
          ["Yes", true],
          ["No", null],
        ],
      ],
    ],
  )
  assert.deepEqual(out.btns, [], "neither is an action")
})

test("STATED LIMIT: a pair sharing a container with another control is still missed", async () => {
  // The walk up stops at a container holding another control, because the
  // alternative is stamping "What is your name?" onto the Yes/No pair — the
  // E8 trap, and a wrong label is worse than an empty one because the user
  // acts on it. Asserted rather than left as a claim in a comment: if the
  // limit ever closes, this test says so and the comment is stale.
  const out = await scan(
    h("body", {}, [
      h("form", {}, [
        h("div", { class: "row" }, [
          h("label", { for: "x" }, ["What is your name?"]),
          h("input", { type: "text", id: "x" }),
          h("div", {}, [
            h("button", { type: "button" }, ["Yes"]),
            h("button", { type: "button" }, ["No"]),
          ]),
        ]),
      ]),
    ]),
  )
  assert.deepEqual(
    out.fields.map((f) => f.t),
    ["text"],
  )
  assert.deepEqual(
    out.btns.map((b) => b.l),
    ["Yes", "No"],
  )
})

test("more than four unnamed buttons under one question is not one question", async () => {
  // Two questions whose own wrappers carry no text collapse onto the
  // container above them. Stopping there keeps the wrong question off the
  // group; the buttons fall through to `btns`, which is exactly where they
  // were before this block existed.
  const out = await scan(
    h("body", {}, [
      h("form", {}, [
        h("div", { class: "fs" }, [
          h("div", {}, [
            h("button", { type: "button" }, ["Yes"]),
            h("button", { type: "button" }, ["No"]),
          ]),
          h("div", {}, [
            h("button", { type: "button" }, ["Yes"]),
            h("button", { type: "button" }, ["No"]),
          ]),
          h("div", {}, [
            h("button", { type: "button" }, ["Yes"]),
            h("button", { type: "button" }, ["No"]),
          ]),
          h("span", {}, ["Which of these applies?"]),
        ]),
      ]),
    ]),
  )
  assert.deepEqual(out.fields, [])
  assert.equal(out.btns.length, 6)
})

test("an INVISIBLE backing control in the same container does not block detection", async () => {
  // THE ONE THAT MADE THE FIRST FIX A NO-OP. The walk up stops at a container
  // holding another control, so the pair never adopts a neighbouring field's
  // label. Ashby puts the value it actually submits in a display:none
  // <input type="checkbox"> INSIDE each pair's own container — measured on a
  // live form, 2026-08-03 — and a guard that exempted only `type="hidden"`
  // treated it as a second question and refused the group. Every fixture in
  // the repo passed; the real board reported both questions in `btns`.
  //
  // The rule is "a control this scanner would itself collect", which is to say
  // a VISIBLE one. This test is the difference between the two rules.
  const out = await scan(
    h("body", {}, [
      h("form", {}, [
        h("div", { class: "field-entry" }, [
          h("label", {}, [SPONSOR]),
          h("div", { class: "_container_1svni_28" }, [
            h("input", {
              type: "checkbox",
              name: "question_7097054005",
              tabindex: "-1",
              style: { display: "none" },
            }),
            h("button", { type: "button" }, ["Yes"]),
            h("button", { type: "button" }, ["No"]),
          ]),
        ]),
      ]),
    ]),
  )
  assert.deepEqual(
    out.fields.map((f) => [f.l, f.t]),
    [[SPONSOR, "radio"]],
    "the board's own hidden backing checkbox is not a second question",
  )
})

test("a VISIBLE control in the same container still blocks it", async () => {
  // The other half of the rule above, so the fix to the Ashby case cannot be
  // read as "ignore other controls". A visible input beside the pair means the
  // container belongs to two questions, and adopting its label is the E8 trap.
  const out = await scan(
    h("body", {}, [
      h("form", {}, [
        h("div", { class: "field-entry" }, [
          h("label", { for: "x" }, ["What is your name?"]),
          h("div", {}, [
            h("input", { type: "text", id: "x" }),
            h("button", { type: "button" }, ["Yes"]),
            h("button", { type: "button" }, ["No"]),
          ]),
        ]),
      ]),
    ]),
  )
  assert.deepEqual(
    out.fields.map((f) => f.t),
    ["text"],
  )
  assert.deepEqual(
    out.btns.map((b) => b.l),
    ["Yes", "No"],
  )
})
