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
function loadScanner(root) {
  ORDER = 0
  DOC.root = root
  const doc = {
    body: root,
    title: "Apply",
    documentElement: root,
    getElementById: (id) => root.descendants().find((e) => e.id === id) || null,
    querySelector: (s) => (matches(root, s) ? root : root.querySelector(s)),
    querySelectorAll: (s) =>
      (matches(root, s) ? [root] : []).concat(root.querySelectorAll(s)),
  }
  DOC.documentElement = root
  const win = {
    scrollX: 0,
    scrollY: 0,
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
      }
    },
  }
  const fn = new Function(...Object.keys(globals), SRC)
  fn(...Object.values(globals))
  return win.__ajScan
}

const scan = (root) => loadScanner(root)(false)
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
