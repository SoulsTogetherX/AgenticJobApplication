// Fidelity: the replicas carry the traits they claim, and the scan fixtures
// describe the HTML that is actually served.
//
// WHY THIS FILE EXISTS AT ALL. There is no browser here, so every consumer test
// in this directory feeds product code a hand-authored scan JSON. That is one
// step away from "a test that asserts the mock". This file is the bridge: it
// re-derives each label from the served HTML with the same normalisation
// scan-page.js's txt() applies, and fails if the two ever drift. Change the
// HTML without changing the scan and this goes red.
//
// WHAT IT DOES NOT PROVE. It does not prove scan-page.js's labelOf() picks the
// label the fixture claims — that needs a DOM. It proves the STRING EXISTS in
// the page and that the structural attribute driving the pick is present. The
// live check belongs to whoever runs scan-engine.mjs against this server.
//
// Run: node --test tests/security/board-fidelity.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { start } from "../fixtures/boards/server.mjs"
import { decodeEntities } from "#lib/lib.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCANS = path.resolve(HERE, "..", "fixtures", "boards", "scans")

// scan-page.js's txt(), reproduced. Copied deliberately rather than imported:
// scan-page.js is a bare function expression that installs itself on `window`
// and cannot be imported into Node. If it ever changes, this comment is the
// pointer to the one place that must change with it.
const txt = (s, n = 120) =>
  String(s == null ? "" : s)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n)

// Prettier reflows this repo's HTML fixtures — a PostToolUse hook runs it on
// every edited file — so `<label for="x">text</label>` can arrive as
// `<label for="x"\n  >text</label\n>`. Every structural assertion below is
// therefore written against attribute values and whitespace-collapsed text,
// never against source layout.
const labelFor = (html, id) => {
  const m = html.match(new RegExp(`for="${id}"[^>]*>([\\s\\S]*?)</label`))
  return m ? txt(decodeEntities(m[1].replace(/<[^>]+>/g, "")), 1e9) : null
}

// Enough of an HTML-to-text pass to check a label is on the page.
const visibleText = (html) =>
  txt(
    decodeEntities(
      html
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
        .replace(/<[^>]+>/g, ""),
    ),
    1e9,
  )

let board
let pages = {}
test.before(async () => {
  board = await start()
  for (const r of board.routes) {
    pages[r.name] = await (await fetch(board.url + r.path)).text()
  }
  pages["greenhouse-step2"] = await (
    await fetch(board.pageUrl("greenhouse"), { method: "POST" })
  ).text()
})
test.after(async () => {
  await board?.stop()
})

const scan = (name) =>
  JSON.parse(fs.readFileSync(path.join(SCANS, `${name}.scan.json`), "utf8"))

// Which scan fixture describes which served page.
const PAIRS = [
  ["honest-greenhouse", "honest-greenhouse"],
  ["greenhouse-step1", "greenhouse"],
  ["greenhouse-step2", "greenhouse-step2"],
  ["label-injection", "hostile-labels"],
  ["consent-decoupled", "hostile-consent"],
  ["destructive-combobox", "hostile-combobox"],
  ["mislabelled-inputs", "hostile-mislabelled"],
  ["mislabelled-escalated", "hostile-escalated"],
  ["escalated-tickbox-yes", "hostile-escalated-tickbox"],
  ["escalated-radio-yesno", "hostile-escalated-radio"],
  ["escalated-aria-checkbox", "hostile-escalated-ariabox"],
]

for (const [scanName, pageName] of PAIRS) {
  test(`${scanName}.scan.json: every label it claims is present in the served HTML`, () => {
    const s = scan(scanName)
    const text = visibleText(pages[pageName])
    // aria-label / aria-labelledby text may live in an attribute rather than in
    // the body text, so attribute values count as present too.
    const attrs = [
      ...pages[pageName].matchAll(/(?:aria-label|title|alt)="([^"]*)"/g),
    ]
      .map((m) => txt(decodeEntities(m[1]), 1e9))
      .join("\n")
    const haystack = text + "\n" + attrs

    const labels = []
    for (const f of s.fields ?? []) {
      if (f.l) labels.push(f.l)
      for (const o of f.o ?? []) if (o.l) labels.push(o.l)
    }
    assert.ok(labels.length > 0, `${scanName} declares no labels`)

    for (const l of labels) {
      // A label at exactly the 120-char cap was truncated by txt(); only the
      // prefix can be expected to appear.
      const needle = l.length >= 120 ? l : l
      assert.ok(
        haystack.includes(needle),
        `${scanName}: label ${JSON.stringify(needle.slice(0, 60))}… is not in ${pageName}`,
      )
    }
  })
}

test("Greenhouse replica: both file inputs are labelled 'Attach', which is the real trait", () => {
  // The real heading sits outside the element the scanner reads, so buildPlan
  // must fall back to document order (adapter.fileOrder) to tell resume from
  // cover letter. A replica that labels them helpfully would hide that.
  const html = pages.greenhouse
  const fileLabels = [
    ...html.matchAll(/<label for="(resume|cover_letter)">([^<]*)<\/label>/g),
  ]
  assert.equal(fileLabels.length, 2)
  for (const m of fileLabels) assert.equal(m[2].trim(), "Attach")
})

test("Greenhouse replica: a react-select combobox whose options are not in the DOM until clicked", () => {
  const html = pages.greenhouse
  assert.match(html, /class="select__control"/)
  assert.match(html, /role="combobox"/)
  assert.match(html, /aria-haspopup="listbox"/)
  // The menu is hidden, so a scan without a probe finds no options — which is
  // what makes probing cost a real click per dropdown.
  assert.match(html, /<div class="select__menu" hidden>/)
  assert.equal(
    scan("greenhouse-step1").fields.find((f) => f.t === "combo").opts,
    undefined,
  )
})

test("Greenhouse replica: a label longer than 120 characters", () => {
  const html = pages.greenhouse
  const full = labelFor(html, "gh_long_q")
  assert.ok(full, "the long-label field must exist")
  assert.ok(full.length > 120, `expected >120 chars, got ${full.length}`)
  // And the scan fixture stores the truncation, not the full text.
  // f8, not f7: scan-page.js stamps COMBOS first, so the react-select takes
  // f1 and every input shifts up one. Found by scan-fidelity.test.mjs.
  const field = scan("greenhouse-step1").fields.find((f) => f.k === "f8")
  assert.equal(field.l.length, 120)
  assert.equal(field.l, txt(full))
})

test("Greenhouse replica: all four real-world label shapes are represented", () => {
  const both = pages.greenhouse + pages["greenhouse-step2"] + pages.ashby
  assert.match(both, /<label for="/, "visible <label for>")
  assert.match(both, /aria-labelledby="/, "aria-labelledby")
  assert.match(both, /aria-label="/, "aria-label")
  assert.match(both, /<legend>/, "fieldset/legend")
})

test("Ashby replica: the resume autofill remount is asynchronous and drops data-aj stamps", () => {
  const html = pages.ashby
  // The trait, not the timing: a setTimeout after a change event that rewrites
  // innerHTML and strips data-aj. A live run logged a fill as failed while its
  // value had in fact landed, because the remount landed between locate() and
  // the interaction after it.
  assert.match(html, /addEventListener\("change"/)
  assert.match(html, /setTimeout\(/)
  assert.match(
    html,
    /data-aj="\[\^"\]\*"/,
    "the remount must strip data-aj stamps",
  )
  assert.match(
    html,
    /}, 700\)/,
    "the remount must land AFTER the upload settle delay",
  )
  assert.match(
    html,
    /data-aj-remounted/,
    "the remount must be observable to a test",
  )
})

test("Lever replica: labels are .application-label siblings, not <label for>, on the custom questions", () => {
  const html = pages.lever
  // This exercises scan-page.js's fourth labelOf tier — the [class*='label']
  // walk up four ancestors — which is the tier most likely to pick up the
  // wrong text.
  assert.match(
    txt(html, 1e9),
    /<div class="application-label"> ?Will you now or in the future require sponsorship/,
  )
  assert.match(html, /name="cards\[/, "Lever's cards[uuid][fieldN] naming")
  assert.match(
    txt(html, 1e9),
    /<select id="cards-edu"/,
    "a NATIVE select, unlike Greenhouse/Ashby",
  )
  assert.equal(
    (html.match(/<option/g) ?? []).length,
    6,
    "its options are in the DOM at scan time, so probing this board is waste",
  )
  assert.equal(
    (html.match(/type="file"/g) ?? []).length,
    1,
    "Lever has one file slot, not two",
  )
})

test("the 120-character consent truncation collision is real, not asserted", () => {
  // Computed from the served HTML rather than taken from the scan fixture, so
  // this cannot pass because two fixture strings were copy-pasted.
  const html = pages["hostile-consent"]
  const approved = labelFor(html, "consent-long-approved")
  const arbitration = labelFor(html, "consent-long-arbitration")
  assert.ok(approved && arbitration, "both consent labels must be present")

  assert.notEqual(approved, arbitration, "the untruncated texts must differ")
  assert.match(arbitration, /binding arbitration/)
  assert.doesNotMatch(approved, /arbitration/)
  assert.equal(
    txt(approved),
    txt(arbitration),
    "after scan-page.js's 120-char slice these two must be INDISTINGUISHABLE — " +
      "that is the hole, and it is why consent auto-tick is disabled",
  )
})

test("the consent decoupling is real: the matched string and the shown string differ", () => {
  const html = pages["hostile-consent"]
  const flat = txt(html, 1e9)
  const aria = flat.match(/id="consent-decoupled" [^>]*aria-label="([^"]*)"/)
  assert.ok(aria, "the decoupled checkbox must carry an aria-label")
  const shown = flat.match(/id="consent-decoupled-visible" ?>([^<]*)</)
  assert.ok(shown, "and a visible sentence next to it")

  assert.match(aria[1], /I certify the information/)
  assert.match(shown[1], /binding arbitration/)
  assert.notEqual(aria[1], shown[1])
  // labelOf() reads aria-label BEFORE any visible <label>, so the innocuous
  // string is the one that gets matched, allowlisted and shown in the approval
  // message, while the jury-trial waiver is what the human is agreeing to.
  assert.doesNotMatch(aria[1], /arbitration|jury/)
})

test("the color:transparent consent trait is present, even on a leg with no browser", () => {
  // tests/security/browser-vouch.test.mjs asserts the BEHAVIOUR and skips when
  // there is no browser. This asserts the FIXTURE, unconditionally, so a
  // deleted or reformatted trait is caught on every leg rather than hiding
  // behind three loud skips.
  const html = pages["hostile-consent"]
  const flat = txt(html, 1e9)
  assert.match(
    flat,
    /for="consent-transparent" style="color: transparent"/,
    "the transparent-label carrier must be on the page",
  )
  assert.equal(
    labelFor(html, "consent-transparent"),
    "I certify that the information in this application is accurate.",
    "the vouched string must be exactly the wording a user would allowlist",
  )
  const shown = flat.match(/id="consent-transparent-visible" ?>([^<]*)</)
  assert.ok(shown, "and the sentence the human actually reads must be present")
  assert.match(shown[1], /binding arbitration/)
  // The two must differ, or there is no decoupling to detect.
  assert.notEqual(labelFor(html, "consent-transparent"), shown[1].trim())
})

test("the destructive combobox fixture keeps one GENUINE dropdown", () => {
  // A fix that stops probing every combobox is visibly wrong: the country
  // picker still has to be probed or every form defers its dropdowns.
  const s = scan("destructive-combobox")
  const combos = s.fields.filter((f) => f.t === "combo")
  assert.equal(combos.length, 4)
  assert.ok(
    combos.some((f) => f.l === "Country"),
    "one honest dropdown",
  )
  assert.equal(
    combos.filter((f) => /withdraw|delete|submit/i.test(f.l)).length,
    3,
  )
  // And each destructive one is combobox-SHAPED in the HTML, by a different
  // selector, so a fix that only handles role=combobox is incomplete.
  const html = pages["hostile-combobox"]
  assert.match(html, /id="withdraw"[\s\S]*?role="combobox"/)
  assert.match(html, /id="delete"[\s\S]*?data-ui="select"/)
  assert.match(html, /id="submit-now"[\s\S]*?class="Select__control"/)
})

test("the getter board really defines the two getters, and counts reads", () => {
  const html = pages["hostile-fillsrc"]
  assert.match(html, /Object\.defineProperty\(window, "__ajFillSrc"/)
  assert.match(html, /Object\.defineProperty\(window, "__ajPlan"/)
  assert.match(html, /__ajGetterReads\+\+/)
  // The payload has to be the real thing or the fixture proves nothing: click
  // submit, upload .env, return a clean-looking report.
  assert.match(html, /page\.click\("#submit-application"\)/)
  assert.match(html, /setInputFiles\("#exfil", "\.env"\)/)
  assert.match(html, /ok: 1/)
})

test("every hostile fixture says, in the file, that it exists to be blocked", () => {
  // Rule 3: attacks written here are fixtures, not tools. A future reader
  // opening one of these files must not have to guess.
  const dir = path.resolve(HERE, "..", "fixtures", "hostile", "forms")
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".html"))
  assert.ok(
    files.length >= 6,
    `expected the hostile form set, got ${files.length}`,
  )
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), "utf8")
    assert.match(
      src,
      /exists? to be (blocked|survived)|FIXTURES?, NOT( A)? TOOLS?/i,
      `${f} must declare itself a fixture`,
    )
  }
})

// ---------------------------------------------------------------------------
// FORMER FINDING (w2-engine), found while generating lever-step1.scan.json for
// Phase 0.10 and FIXED 2026-08-18. Kept AT THE CONSUMER, because "the scanner
// picked a poor label" is a scanner-isolation observation and this is not one:
// it decides what the USER is asked.
// ---------------------------------------------------------------------------
test("Lever's sponsorship question reaches the user as the question, not as the word 'Yes' (former FINDING)", async () => {
  // WHAT LEVER RENDERS. The question text lives in a <div class=
  // "application-label"> that is a SIBLING of the <ul> of options; each radio
  // is wrapped in its own <label> whose text is the ANSWER. That is the
  // commonest yes/no rendering on the board, and pages/lever.html reproduces it
  // exactly.
  //
  // WHAT THE SCANNER DID until 2026-08-18. The wrapping-<label> tier won before
  // the four-ancestor [class*='label'] walk could reach the sibling div, so the
  // group took its first option's text and reached the user as
  //   `label: "Yes", options: [Yes, No]`
  // — an unactionable deferral (CLAUDE.md rule 6: "in terms the user can act
  // on"), on EVERY Lever application, forever, because a stored answer to
  // "Will you now or in the future require sponsorship…" can never match a
  // field labelled "Yes"; and the escape hatch was worse than the problem,
  // since answering it through pending-questions would have banked an answer
  // keyed on "Yes" — a key matching ANY field labelled "Yes" on ANY board.
  //
  // WHAT THE SCANNER DOES NOW. Its group-question pass recognises a
  // multi-option group whose `l` is one of its own options and takes the
  // question from the options' container — the same walk the button-pair
  // detector uses — so the same banked answer resolves this radio group and
  // an Ashby Yes/No button pair alike. The three consumer-visible facts are
  // asserted here: the resolver answers from the bank, the plan carries the
  // question, and the fixture's own annotation says so.
  const { resolveFields, buildPlan } =
    await import("../../src/apply/fill-plan.mjs")
  const { detectAts } = await import("../../src/apply/ats/index.mjs")

  const s = scan("lever-step1")
  const url =
    "http://127.0.0.1:1/jobs.lever.co/fixture-robotics/00000000-0000-4000-8000-000000000001/apply"
  const question =
    "Will you now or in the future require sponsorship for employment visa status?"
  // The user HAS answered this question, so a fact base that holds the answer
  // must now supply it.
  const answers = {
    answers: [{ id: "a-1", question, answer: "No", added: "2026-08-01" }],
  }
  const resolved = resolveFields(s.fields, { profile: {}, answers })
  const g1 = resolved.find((r) => r.k === "g1")
  assert.equal(g1.label, question, "the group is labelled with the question")
  assert.equal(g1.status, "OK", `resolved from the bank: ${JSON.stringify(g1)}`)
  assert.equal(g1.value, "No")

  const plan = buildPlan({ scan: s, resolved, adapter: detectAts(url), url })
  // A sponsorship answer is assertion-class, so it is a CONFIRM defer with the
  // question on it — the user reads the question, not an answer to it.
  const entry =
    plan.defer.find((d) => d.k === "g1") ?? plan.items.find((i) => i.k === "g1")
  assert.ok(entry, "g1 is in the plan")
  assert.equal(entry.label, question)
  assert.notEqual(entry.label, "Yes")

  // The fixture must keep saying so in its own file, or the next reader
  // assumes the old label was a scanner shape worth preserving.
  const raw = fs.readFileSync(path.join(SCANS, "lever-step1.scan.json"), "utf8")
  assert.match(JSON.parse(raw)._finding_g1, /group-question pass/)
  assert.equal(JSON.parse(raw).fields.find((f) => f.k === "g1").l, question)
})
