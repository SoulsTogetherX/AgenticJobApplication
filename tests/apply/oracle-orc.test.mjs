// ORACLE RECRUITING CLOUD — the four defects from the 2026-08-04 run.
//
// Every one of these was found by driving a real ORC application by hand and
// reading what came back. The fixtures in tests/fixtures/oracle/ reproduce the
// markup; this file pins the behaviour. See that directory's README for the
// table and for why the pages are not in tests/fixtures/boards/pages/.
//
// PRIORITY ORDER, and it is the order the risk runs in rather than the order
// they were found:
//
//   2. THE MANGLED LABEL. A question's label came back starting mid-sentence,
//      and the fragment asks the OPPOSITE of what the question asks. A fuzzy
//      match on it returns the right concept with the wrong truth value, and
//      the answer that produces is a false statement on a submitted
//      application. This is the one that can do damage that cannot be undone.
//   3. THE WRONG OPTION. A substring match on a dropdown put "Protected
//      Veteran" into a real Veteran Status field, and a readback that could be
//      satisfied by the act of typing reported the whole thing a success.
//   1. THE MISSED CONSENT BOX. A required checkbox reported nowhere at all, so
//      the plan named two decorative widgets as the blockers and never
//      mentioned the control that actually blocked the form.
//   4. THE PHANTOM FIELDS. Seven answers reported as seven unfillable fields
//      with the question attached to none of them.
//
// The DOM-harness arm (tests/fixtures/boards/dom.mjs, no browser) reads the
// SHAPES. The browser arm reads the BEHAVIOURS — a menu that only exists once
// clicked, and a widget whose visible text is a filter rather than an answer —
// and skips with a reason where no Chromium is available, never silently.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { runScanner } from "../fixtures/boards/dom.mjs"
import scanPage from "../../scripts/apply/scan-engine.mjs"
import fillPage from "../../scripts/apply/fill-engine.mjs"
import { buildPlan } from "../../scripts/apply/fill-plan.mjs"
import { launchBrowser } from "../../scripts/apply/browser.mjs"
import genericAdapter from "../../scripts/apply/ats/generic.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const ORC = path.join(ROOT, "tests", "fixtures", "oracle")
const page = (name) => fs.readFileSync(path.join(ORC, name + ".html"), "utf8")

const QUESTIONNAIRE = page("orc-questionnaire")
const EMAIL_GATE = page("orc-email-gate")

// The question exactly as the form asks it. The polarity lives in the first
// five words, and the parenthetical that broke the extractor is in the middle.
const SPONSORSHIP =
  "WILL YOU NOW OR IN THE FUTURE REQUIRE SPONSORSHIP for employment visa " +
  "status (e.g. H-1B status, etc) to work legally for our Company in the " +
  "United States?"
// What the scanner reported instead, byte for byte, on the live form.
const FRAGMENT =
  "H-1B status, etc) to work legally for our Company in the United States?"

const scanOf = (html) => runScanner(html)
const field = (scan, pred) => scan.fields.find(pred)

// ---------------------------------------------------------------------------
// DEFECT 2 — the label that inverted the question
// ---------------------------------------------------------------------------

test("ORC-2: the sponsorship question comes back WHOLE, not from the parenthetical", async () => {
  const scan = await scanOf(QUESTIONNAIRE)
  const g = field(scan, (f) => /SPONSORSHIP/i.test(f.l ?? ""))
  assert.ok(g, "the question must be in `fields` at all")
  assert.equal(g.l, SPONSORSHIP)
})

test("ORC-2: the fragment that inverted it is gone, and the inversion is why", async () => {
  // Not a formatting nicety. The fragment reads as "do you have authorisation
  // to work legally in the United States?", whose true answer is Yes; the real
  // question asks whether sponsorship is REQUIRED, whose true answer is No. The
  // fact base would answer the fragment confidently and wrongly.
  const scan = await scanOf(QUESTIONNAIRE)
  for (const f of scan.fields) {
    assert.notEqual(f.l, FRAGMENT)
  }
  const g = field(scan, (f) => /SPONSORSHIP/i.test(f.l ?? ""))
  assert.match(
    g.l,
    /^WILL YOU NOW OR IN THE FUTURE REQUIRE SPONSORSHIP/,
    "the words that carry the polarity are the first ones in the label",
  )
  assert.ok(
    !/^[^(]*\)/.test(g.l),
    "an unmatched ')' means the cut landed inside a parenthetical",
  )
})

test("ORC-2: a sentence boundary is still a sentence boundary", async () => {
  // The fix must not simply stop splitting. Prose that genuinely precedes the
  // question is still trimmed away, or every such group carries a paragraph of
  // boilerplate that no answer bank will ever match.
  const html = `<body><form>
    <div class="q">
      <span>We are an equal opportunity employer. Do you require sponsorship?</span>
      <div><button type="button">Yes</button><button type="button">No</button></div>
    </div>
  </form></body>`
  const scan = await scanOf(html)
  const g = field(scan, (f) => Array.isArray(f.o))
  assert.equal(g.l, "Do you require sponsorship?")
})

test("ORC-2: the three things that are NOT sentence ends", async () => {
  // Each rejection keeps MORE text, which is the direction the bias points:
  // an over-long label defers, a short one answers the wrong question.
  const ask = async (question) => {
    const html = `<body><form>
      <div class="q"><span>${question}</span>
      <div><button type="button">Yes</button><button type="button">No</button></div>
      </div></form></body>`
    const scan = await scanOf(html)
    return field(scan, (f) => Array.isArray(f.o)).l
  }
  // 1. inside a parenthetical
  assert.equal(
    await ask("Do you hold a licence (e.g. a CDL) for this role?"),
    "Do you hold a licence (e.g. a CDL) for this role?",
  )
  // 2. after a dotted initialism, with no parentheses anywhere
  assert.equal(
    await ask("Are you authorised to work in the U.S. without sponsorship?"),
    "Are you authorised to work in the U.S. without sponsorship?",
  )
  // 3. before a lowercase continuation
  assert.equal(
    await ask("Have you worked at Acme Corp. as an employee?"),
    "Have you worked at Acme Corp. as an employee?",
  )
})

// ---------------------------------------------------------------------------
// DEFECT 1 — the required consent checkbox nobody could see
// ---------------------------------------------------------------------------

test("ORC-1: the required consent checkbox is REPORTED, with its wrapper's required", async () => {
  const scan = await scanOf(EMAIL_GATE)
  const g = field(scan, (f) => f.t === "checkbox")
  assert.ok(g, "the control that blocks the form must be in the scan")
  assert.equal(g.l, "I have read and agree to the Candidate Privacy Notice.")
  assert.equal(
    g.req,
    true,
    "aria-required lives on the oj-checkboxset, never on the input",
  )
})

test("ORC-1: the decorative widgets are still reported — the fix adds, it does not swap", async () => {
  // What the plan named INSTEAD of the checkbox. They are real focusable
  // controls and a silence is not a refusal, so they must keep coming back;
  // the defect was never that they were reported, it was that they were the
  // only thing reported.
  const scan = await scanOf(EMAIL_GATE)
  assert.deepEqual(
    scan.fields.filter((f) => f.widget === "aria").map((f) => f.l),
    ["Email verification", "Application"],
  )
})

test("ORC-1: Ashby's invisible BACKING checkbox is still dropped", async () => {
  // The counter-case, and the reason the new allowance is evidence-based
  // rather than "checkboxes are exempt from vis()". Ashby parks a real
  // <input type=checkbox> at display:none inside each answer's container as
  // the value it submits. It has no label by any route and carries
  // tabindex="-1" — the page saying this control is for its own code. Either
  // one alone keeps it out.
  const scan = await scanOf(
    fs.readFileSync(
      path.join(
        ROOT,
        "tests",
        "fixtures",
        "boards",
        "pages",
        "ashby-buttons.html",
      ),
      "utf8",
    ),
  )
  assert.deepEqual(
    scan.fields.filter((f) => f.t === "checkbox"),
    [],
    "a backing store is not a control the user is looking at",
  )
})

test("ORC-1: the vouch is about the LABEL, and it still does not tick anything", async () => {
  // The box comes back with labelExact, and that is correct: the vouch's one
  // meaning is "`l` is the COMPLETE, VISIBLE text of this control's label", and
  // this label is both. It says nothing about the CONTROL, which is at
  // opacity: 0 and which Playwright's actionability checks would refuse — so a
  // plan that ever tried to tick it would fail visibly rather than silently.
  // Written down because "vouched" is easy to read as "tickable".
  const scan = await scanOf(EMAIL_GATE)
  const g = field(scan, (f) => f.t === "checkbox")
  assert.equal(g.labelExact, true)
  // And with no allowlist and no out-of-band vouch, it defers like every other
  // consent box: reported, blocking, never acted on.
  const plan = buildPlan({
    scan,
    resolved: [{ k: g.k, status: "OK", value: "Yes", pick: g.o[0].k }],
    adapter: genericAdapter,
    files: {},
  })
  assert.ok(!plan.items.some((i) => i.k === g.k))
  const d = plan.defer.find((x) => x.k === g.k)
  assert.ok(d, "the control that blocks the form must reach the user")
  assert.equal(d.why, "consent")
})

test("ORC-1: an invisible checkbox with no VISIBLE label stays invisible", async () => {
  // The allowance turns on the words being on screen. A label that is present
  // but not rendered is the decoupling shape, and it earns nothing here.
  const hidden = `<body><form>
    <input type="checkbox" id="c1" style="opacity: 0">
    <label for="c1" style="display: none">I agree to binding arbitration</label>
    <input type="text" id="t1"><label for="t1">Full name</label>
  </form></body>`
  const scan = await scanOf(hidden)
  assert.deepEqual(
    scan.fields.filter((f) => f.t === "checkbox"),
    [],
  )
  assert.ok(field(scan, (f) => f.l === "Full name"))
})

test("ORC-1: a required marker on a wrapper holding SEVERAL controls is ignored", async () => {
  // The bound on groupRequired(). A marker on a container of many controls
  // says which SECTION is required and cannot say which box; honouring it
  // would mark every field in the section required and every optional one
  // would start blocking.
  const many = `<body><form>
    <div aria-required="true">
      <label for="a">First</label><input type="text" id="a">
      <label for="b">Second</label><input type="text" id="b">
    </div>
  </form></body>`
  const scan = await scanOf(many)
  assert.deepEqual(
    scan.fields.map((f) => f.req),
    [undefined, undefined],
  )
})

// ---------------------------------------------------------------------------
// DEFECT 3 — one element, two fields, and a fill verb pointed at a combobox
// ---------------------------------------------------------------------------

test("ORC-3: an <input role=combobox> is ONE field, not a combo and a text twin", async () => {
  const scan = await scanOf(QUESTIONNAIRE)
  const source = scan.fields.filter((f) => f.l === "How did you hear about us?")
  assert.equal(source.length, 1, "one element must produce one field")
  assert.equal(source[0].t, "combo")
  assert.equal(source[0].req, true)
  // All three of the form's pickers, and nothing typed.
  assert.deepEqual(
    scan.fields.filter((f) => f.t === "combo").map((f) => f.l),
    ["How did you hear about us?", "Gender", "Veteran Status"],
  )
  assert.deepEqual(
    scan.fields.filter((f) => f.t === "text").map((f) => f.l),
    ["First Name"],
  )
})

test("ORC-3: the planner issues `combo` against it, never `fill`", async () => {
  // The consequence of the duplicate, and the reason it was a correctness bug
  // rather than a noisy report. fill-plan.mjs's duplicateCombo() exists for
  // intl-tel-input — a country PICKER beside a separate phone TEXT INPUT under
  // one label — and resolves it by keeping the typable half. Handed two reports
  // of ONE element it did exactly that: the plan typed into a combobox, the
  // widget never committed the value, and it reverted on blur.
  const scan = await scanOf(QUESTIONNAIRE)
  const combo = field(scan, (f) => f.l === "Veteran Status")
  const plan = buildPlan({
    scan,
    resolved: [
      {
        k: combo.k,
        status: "OK",
        value: "I am not a protected veteran",
        source: "eeo",
      },
    ],
    adapter: genericAdapter,
    files: {},
  })
  const items = plan.items.filter((i) => i.k === combo.k)
  assert.equal(items.length, 1)
  assert.equal(items[0].how, "combo")
  assert.ok(
    !plan.items.some((i) => i.how === "fill" && i.label === "Veteran Status"),
    "nothing may type into a combobox",
  )
})

// ---------------------------------------------------------------------------
// DEFECT 4 — the answers without a question
// ---------------------------------------------------------------------------

test("ORC-4: an answer list of focusable <li>s is ONE group, not seven phantoms", async () => {
  const scan = await scanOf(QUESTIONNAIRE)
  const g = field(scan, (f) => /age brackets/.test(f.l ?? ""))
  assert.ok(g, "the question must be reported — it was reported NOWHERE")
  assert.equal(g.l, "Which of the following age brackets do you fall into?")
  assert.deepEqual(
    g.o.map((o) => o.l),
    [
      "18-24",
      "25-34",
      "35-44",
      "45-54",
      "55-64",
      "65 or over",
      "I decline to answer",
    ],
  )
  assert.deepEqual(
    scan.fields.filter((f) => f.widget === "aria").map((f) => f.l),
    [],
    "not one answer may also arrive as a field of its own",
  )
})

test("ORC-4: the group claims NOTHING about which answer is selected", async () => {
  // The page marks its selection with a class and declares no aria state, so
  // there is no honest way to read back whether a click registered. The
  // scanner says nothing rather than guessing, and every one of these carries
  // `widget`, which is this file's word for "no verb in this pipeline operates
  // this control".
  const scan = await scanOf(QUESTIONNAIRE)
  for (const g of scan.fields.filter((f) => Array.isArray(f.o))) {
    assert.equal(g.widget, "buttons")
    for (const o of g.o) assert.equal(o.on, undefined)
  }
})

test("ORC-4: an unrecognised answer set defers and gains no item", async () => {
  // The end of the chain. Seven answers the engine cannot operate and a
  // question it cannot verify must reach the user as ONE blocking defer that
  // names the question — not as an item some unattended path could act on.
  const scan = await scanOf(QUESTIONNAIRE)
  const g = field(scan, (f) => /age brackets/.test(f.l ?? ""))
  const plan = buildPlan({
    scan,
    resolved: [{ k: g.k, status: "OK", value: "I decline to answer" }],
    adapter: genericAdapter,
    files: {},
  })
  assert.ok(!plan.items.some((i) => i.k === g.k), "no verb may reach it")
  const d = plan.defer.find((x) => x.k === g.k)
  assert.ok(d, "it must be deferred, with the question attached")
  assert.match(d.why, /unsupported field type widget/)
  assert.equal(d.label, "Which of the following age brackets do you fall into?")
})

test("ORC-4: a <button> trio is unaffected — the widening never narrowed", async () => {
  const scan = await scanOf(QUESTIONNAIRE)
  const g = field(scan, (f) => f.l === "Have you worked here before?")
  assert.ok(g)
  assert.deepEqual(
    g.o.map((o) => o.l),
    ["Yes", "No", "Prefer not to say"],
  )
  // And the page's real actions are still actions.
  assert.deepEqual(
    scan.btns.map((b) => b.r),
    ["back", "submit"],
  )
})

// ---------------------------------------------------------------------------
// DEFECT 3, THE BEHAVIOURAL HALF — a menu that only exists once clicked
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

const SOURCE_OPTIONS = [
  "Billboard",
  "Built In",
  "Facebook",
  "Indeed",
  "LinkedIn",
  "Radio Ad",
  "Referral",
]

test("ORC-3: the probe reads the option LIST, not one 60-character blob", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // What the live form returned:
  //   ["Billboard Built In Facebook Indeed LinkedIn Radio Ad Referra"]
  // — every option run together and cut at 60, because the only <li> inside
  // the listbox is the scroller that holds them all. One non-answer in `opts`
  // is worse than none: it is what answer-bank matches against and what the
  // field cache stores as this form's option list, so every real answer
  // resolves "not on offer" from then on.
  const { scan } = await withPage(async (p) => {
    await p.setContent(QUESTIONNAIRE)
    return scanPage(p, {})
  })
  const source = scan.fields.find((f) => f.l === "How did you hear about us?")
  assert.deepEqual(source.opts, SOURCE_OPTIONS)
  assert.equal(source.probe_error, undefined, "the probe must not have died")
  assert.equal(source.optsTruncated, undefined)
  // The other two read too — one probe working is not the same as the fix.
  const veteran = scan.fields.find((f) => f.l === "Veteran Status")
  assert.deepEqual(veteran.opts, [
    "I am not a protected veteran",
    "Protected Veteran",
    "I do not wish to identify my protected veteran status",
  ])
})

test("ORC-3: a scrollIntoView that times out no longer kills the probe", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // The live symptom was `probe_error: "locator.scrollIntoViewIfNeeded:
  // Timeout 2000ms exceeded"` on every picker, with no options at all. The
  // control is inside a scroll container that never settles here; the probe
  // must still open it.
  const html = QUESTIONNAIRE.replace(
    "<h1>",
    '<div style="height: 300vh"></div><h1>',
  )
  const { scan } = await withPage(async (p) => {
    await p.setContent(html)
    return scanPage(p, {})
  })
  for (const f of scan.fields.filter((x) => x.t === "combo")) {
    assert.equal(f.probe_error, undefined, `${f.l} died in the probe`)
    assert.ok(f.opts && f.opts.length > 1, `${f.l} came back with no list`)
  }
})

test("ORC-3: the fill picks the EXACT row — 'Protected Veteran' is not a Veteran Status", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // The positive half: the right row is chosen, and it is the FORM MODEL that
  // ends up holding it. Stated honestly — this one also passed before the fix,
  // because when the typed text happens to narrow the list to exactly one row
  // the old path landed on it by luck. It is here as the floor the two tests
  // below are measured against; those two are the regression catchers, and
  // both go red against the old matcher.
  const got = await withPage(async (p) => {
    await p.setContent(QUESTIONNAIRE)
    const { scan } = await scanPage(p, { probeMax: 0 })
    const f = scan.fields.find((x) => x.l === "Veteran Status")
    const out = await fillPage(p, {
      items: [
        {
          k: f.k,
          sel: f.sel,
          how: "combo",
          value: "I am not a protected veteran",
          label: "Veteran Status",
        },
      ],
      defer: [],
      comboStrategies: genericAdapter.comboStrategies,
    })
    return {
      out,
      model: await p.locator("#veteran-model").inputValue(),
      shown: await p.locator("#veteran-input").inputValue(),
    }
  })
  assert.equal(got.out.failed, 0, JSON.stringify(got.out.failures))
  assert.equal(got.out.ok, 1)
  assert.equal(
    got.model,
    "I am not a protected veteran",
    "the FORM MODEL is what gets submitted, not the visible text",
  )
  assert.equal(got.shown, "I am not a protected veteran")
})

test("ORC-3: a value that is only a SUBSTRING of an option fails, it does not guess", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // "Veteran" is contained by all three rows. The old matcher picked one; the
  // right answer is that the form does not offer this, which is a defer the
  // user resolves rather than a sentence they did not write.
  const got = await withPage(async (p) => {
    await p.setContent(QUESTIONNAIRE)
    const { scan } = await scanPage(p, { probeMax: 0 })
    const f = scan.fields.find((x) => x.l === "Veteran Status")
    const out = await fillPage(p, {
      items: [
        {
          k: f.k,
          sel: f.sel,
          how: "combo",
          value: "Veteran",
          label: "Veteran Status",
        },
      ],
      defer: [],
      comboStrategies: genericAdapter.comboStrategies,
    })
    return { out, model: await p.locator("#veteran-model").inputValue() }
  })
  assert.equal(got.out.ok, 0)
  assert.equal(got.out.failed, 1)
  assert.equal(got.model, "", "nothing may be committed on a guess")
})

test("ORC-3: typing is not committing — an uncommitted value is reported FAILED", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // The readback defect, in isolation, and it is the one that hid the other
  // two. An answer this list does not offer filters every row away, so no
  // strategy can commit: type-click and click-option find no row, and
  // type-enter presses Enter against an empty list. Every one of them still
  // leaves the typed text in the visible input — which is what the old check
  // read back, and why the run reported three required pickers filled that
  // were submitted empty.
  const got = await withPage(async (p) => {
    await p.setContent(QUESTIONNAIRE)
    const { scan } = await scanPage(p, { probeMax: 0 })
    const f = scan.fields.find((x) => x.l === "Gender")
    const out = await fillPage(p, {
      items: [
        {
          k: f.k,
          sel: f.sel,
          how: "combo",
          value: "Genderqueer",
          label: "Gender",
        },
      ],
      defer: [],
      // ONE STRATEGY, to isolate the readback. type-enter is the one that
      // types and then commits whatever is highlighted; with the list filtered
      // to nothing there is nothing to highlight, so the value cannot land and
      // the visible input is the only place the string exists.
      comboStrategies: ["type-enter"],
    })
    return {
      out,
      model: await p.locator("#gender-model").inputValue(),
      shown: await p.locator("#gender-input").inputValue(),
    }
  })
  assert.equal(got.model, "", "the widget never took the value")
  assert.equal(got.shown, "", "and the typed text did not survive the blur")
  assert.equal(got.out.ok, 0, "so the run must not say otherwise")
  assert.equal(got.out.failed, 1)
  assert.match(
    got.out.failures[0].why,
    /reads ""/,
    "the failure names what the field actually holds",
  )
})

test("ORC-3: both page-side probes read the same list off the same menu", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // scan-engine.mjs and .claude/skills/apply-job/scan.driver.mjs carry the same
  // algorithm in two places — the driver runs inside the Playwright MCP vm and
  // cannot import anything. Pinned BEHAVIOURALLY rather than by source text, so
  // a change to one that does not reach the other goes red here.
  const driverSrc = fs.readFileSync(
    path.join(ROOT, ".claude", "skills", "apply-job", "scan.driver.mjs"),
    "utf8",
  )
  const driver = new Function(`return (${driverSrc})`)()
  const both = await withPage(async (p) => {
    await p.setContent(QUESTIONNAIRE)
    const engine = (await scanPage(p, {})).scan
    await p.setContent(QUESTIONNAIRE)
    const drv = await driver(p)
    return [engine, drv.scan ?? drv]
  })
  const opts = both.map(
    (s) => s.fields.find((f) => f.l === "How did you hear about us?").opts,
  )
  assert.deepEqual(opts[0], SOURCE_OPTIONS)
  assert.deepEqual(opts[1], opts[0])
})
