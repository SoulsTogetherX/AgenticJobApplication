// SCAN FIDELITY: every scan fixture is deep-compared to what the REAL
// .claude/skills/apply-job/scan-page.js produces for the page it names.
//
// WHY THIS EXISTS, and what it is a reaction to.
//
// Every consumer test in this directory hands product code a scan JSON. The
// value of those tests is entirely conditional on the JSON being a shape the
// scanner can actually produce — a fixture is an assertion about the scanner,
// written in data, and until now nothing checked it. board-fidelity.test.mjs
// checked `f.l` against the served HTML with a re-implementation of txt(), so
// EVERY OTHER KEY a fixture claimed was unchecked: `sel`, `t`, `lSeen`,
// `labelExact`, `labelWhy`, `v`, `req`, field ORDER, and the `k` stamps
// themselves.
//
// Four real drifts were found the first time this ran, and each had already
// cost something:
//
//   1. mislabelled-inputs f4 had no `lSeen` at all — the field predated the
//      key. w2-engine's fix was live and the FINDING test still read red.
//   2. mislabelled-inputs claimed `sel: input[name="ssn"]`. The scanner emits
//      `#m-phone`, because stableSel() tries the id FIRST and the id is
//      unique. fill-plan.mjs's fieldIdentityMismatch() reads the element's
//      identity out of `sel` and has nothing else to read — so the guard was
//      passing against a selector the scanner would never emit. See
//      hostile-forms.test.mjs's routing FINDING, which this reopened.
//   3. destructive-combobox carried no `v`, and probeRefusal()'s structural
//      half ("its name is its own text, so it is a button") reads `v`. Only
//      the word-list backstop was ever exercised.
//   4. consent-decoupled was missing the #consent-transparent field entirely,
//      so the color:transparent carrier reached no consumer on any leg without
//      a browser.
//
// HOW IT RUNS WITHOUT A BROWSER. tests/fixtures/boards/dom.mjs parses the
// SERVED HTML into a DOM small enough to host the scanner and runs the
// scanner's real text over it. Its stated limit is layout: every rendered
// element gets the same box, so a carrier that hides text by GEOMETRY (1x1
// clipping, off-screen parking, an overlay) cannot be reproduced here. The
// last test in this file fails loudly if a served page ever grows one, rather
// than letting a fixture be regenerated wrongly.
//
// Run: node --test tests/security/scan-fidelity.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { start } from "../fixtures/boards/server.mjs"
import { runScanner } from "../fixtures/boards/dom.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCANS = path.resolve(HERE, "..", "fixtures", "boards", "scans")

// scan fixture -> [route name, request method]
const PAIRS = [
  // The one HONEST page in the corpus. It is pinned here for the same reason
  // the hostile ones are, plus one of its own: honest-board.test.mjs asserts
  // this form reaches ready:true, and that claim is only worth anything if the
  // scan it is asserted over is a shape the real scanner produces.
  ["honest-greenhouse", "honest-greenhouse", "GET"],
  ["greenhouse-step1", "greenhouse", "GET"],
  ["greenhouse-step2", "greenhouse", "POST"],
  // The two boards bench-apply.mjs could not measure at all until Phase 0.10,
  // because fixtureScanPath() throws rather than report Greenhouse's numbers
  // under Ashby's label. ashby-step2 is the POST — the post-upload REMOUNT,
  // served at the same URL for the same reason greenhouse-step2 is.
  ["ashby-step1", "ashby", "GET"],
  ["ashby-step2", "ashby", "POST"],
  ["lever-step1", "lever", "GET"],
  ["label-injection", "hostile-labels", "GET"],
  ["consent-decoupled", "hostile-consent", "GET"],
  ["destructive-combobox", "hostile-combobox", "GET"],
  ["mislabelled-inputs", "hostile-mislabelled", "GET"],
  ["mislabelled-escalated", "hostile-escalated", "GET"],
  ["escalated-tickbox-yes", "hostile-escalated-tickbox", "GET"],
  ["escalated-radio-yesno", "hostile-escalated-radio", "GET"],
  // Pinned even though its finding is an ABSENCE: the deep-equal below is what
  // makes "the scanner emits no field for a div[role=checkbox]" falsifiable.
  // If w2-engine teaches the scanner to see ARIA widgets, THIS goes red first
  // and the consumer test in hostile-forms.test.mjs goes red with it.
  ["escalated-aria-checkbox", "hostile-escalated-ariabox", "GET"],
]

let board
const html = {}
test.before(async () => {
  board = await start()
  for (const [scanName, page, method] of PAIRS) {
    html[scanName] = await (await fetch(board.pageUrl(page), { method })).text()
  }
})
test.after(async () => {
  await board?.stop()
})

const fixture = (name) =>
  JSON.parse(fs.readFileSync(path.join(SCANS, `${name}.scan.json`), "utf8"))

// The fixture's own annotations are prefixed `_`. They are commentary for a
// human, never scanner output, so they are dropped before the comparison —
// and the presence of one is NOT an excuse for a mismatch anywhere else.
const withoutNotes = (o) => {
  if (Array.isArray(o)) return o.map(withoutNotes)
  if (!o || typeof o !== "object") return o
  const out = {}
  for (const [k, v] of Object.entries(o)) {
    if (k.startsWith("_")) continue
    if (v === undefined) continue
    out[k] = withoutNotes(v)
  }
  return out
}

// `url` is the one key deliberately NOT compared: the fixtures store a
// port-0 placeholder because the server binds an ephemeral port (listen(0)),
// and location.href inside the harness is a stand-in for the same reason.
// Nothing else is exempt.
const comparable = (scanLike) => {
  const { url, ...rest } = withoutNotes(scanLike)
  return rest
}

for (const [scanName, page] of PAIRS) {
  test(`${scanName}.scan.json IS what the real scanner produces for ${page}`, async () => {
    const real = comparable(await runScanner(html[scanName]))
    const claimed = comparable(fixture(scanName))
    // Field-by-field first: a whole-object diff on a nine-field form is
    // unreadable, and the point of a red line here is that someone can act
    // on it.
    const n = Math.max(real.fields.length, claimed.fields.length)
    for (let i = 0; i < n; i++) {
      assert.deepEqual(
        claimed.fields[i],
        real.fields[i],
        `${scanName} field #${i}: the fixture claims a shape scan-page.js does ` +
          `not produce for ${page}.\n  fixture: ${JSON.stringify(claimed.fields[i])}\n` +
          `  scanner: ${JSON.stringify(real.fields[i])}`,
      )
    }
    // Then everything else — heading, kind, btns, signals — so a drift
    // outside `fields` cannot hide.
    assert.deepEqual(claimed, real)
  })
}

test("every scan fixture in the directory is covered by a pair above", () => {
  // A fixture nobody compares is exactly the state this file exists to end,
  // and adding one is the easiest way to reintroduce it.
  const onDisk = fs
    .readdirSync(SCANS)
    .filter((f) => f.endsWith(".scan.json"))
    .map((f) => f.replace(/\.scan\.json$/, ""))
    .sort()
  assert.deepEqual(
    onDisk,
    PAIRS.map(([n]) => n).sort(),
    "a scan fixture exists that this file does not check against the scanner",
  )
})

test("the fixtures assert more than a label: sel, type and vouch state are all pinned", () => {
  // Guards the comparison itself. If a future edit narrowed the deep-equal
  // above to labels — which is what board-fidelity.test.mjs did, and how four
  // drifts survived — these keys would stop being covered silently. So their
  // presence in the corpus is asserted directly.
  const seen = new Set()
  for (const [name] of PAIRS) {
    for (const f of fixture(name).fields ?? []) {
      for (const k of Object.keys(f)) if (!k.startsWith("_")) seen.add(k)
      for (const o of f.o ?? [])
        for (const k of Object.keys(o))
          if (!k.startsWith("_")) seen.add(`o.${k}`)
    }
  }
  for (const key of [
    "k",
    "sel",
    // `n` and `ac` are scan-page.js's identityOf() output, added 2026-07-31
    // and read by fill-plan.mjs's fieldIdentityMismatch(). They are listed
    // here because a regeneration that silently DROPPED them would otherwise
    // go green — the deep-equal above compares the fixture to whatever the
    // scanner currently does, so it cannot tell "the scanner stopped emitting
    // n" from "the fixture was correct all along".
    //
    // `ac` is carried by exactly one field in the corpus
    // (mislabelled-escalated f1, autocomplete="tel") because it is a signal
    // only an attacker supplies: it appears on ZERO of the four honest board
    // pages. mislabelled-inputs f1 has autocomplete="off", which identityOf
    // suppresses as reserved — so the suppression path is covered too, by the
    // ABSENCE of `ac` on that field.
    "n",
    "ac",
    "t",
    "l",
    "lSeen",
    "labelExact",
    "labelWhy",
    "req",
    "v",
    // `section` and `widget` were added by w2-engine on 2026-07-31 and are
    // each carried by exactly two fields / one field in the whole corpus, so
    // both are one careless regeneration away from vanishing without a red
    // line. `section` is greenhouse-step1's two `Attach` file inputs (case E8);
    // `widget: "aria"` is escalated-aria-checkbox f2, the control that used to
    // be invisible entirely. The deep-equal above compares the fixture to
    // whatever the scanner currently does, so it cannot tell "the scanner
    // stopped emitting section" from "the fixture was right all along" — this
    // can.
    "section",
    "widget",
    "o.sel",
    "o.n",
    "o.l",
  ]) {
    assert.ok(seen.has(key), `no fixture in the corpus carries \`${key}\``)
  }
})

test("a section heading speaks only for its own container — the certify box does NOT inherit the EEO legend", () => {
  // THE NEAR-MISS THIS PINS, reported by w2-engine against itself while
  // landing `section`. Its first heuristic was "the last heading before this
  // control in document order", and greenhouse-step2.html is the page that
  // falsifies it: a <fieldset><legend>Voluntary Self-Identification of
  // Disability</legend> CLOSES, and the "I certify that the information
  // provided in this application is true and complete" checkbox is rendered
  // after it. By document order the legend precedes the checkbox; by
  // containment the checkbox is not in that section at all. Stamping it there
  // labels a legal attestation with a demographic heading.
  //
  // The deep-equal above already fails if a `section` key appears on that
  // field, but it fails as "the fixture claims a shape the scanner does not
  // produce" — which reads like fixture drift and invites a regeneration. This
  // says what the correct answer is and why, so the red line names the rule.
  //
  // The two suppression rules are asserted TOGETHER because they are different
  // rules and either alone would look sufficient here:
  //   - the certify box: suppressed by CONTAINMENT (the legend's parent
  //     <fieldset> does not contain it);
  //   - the radio group g1: suppressed because the section it would get IS its
  //     own label — the legend is both.
  const s = fixture("greenhouse-step2")
  assert.deepEqual(
    s.fields.map((f) => [f.k, f.t, f.section ?? null]),
    [
      ["f2", "url", null],
      ["f3", "url", null],
      ["f1", "combo", null],
      ["g1", "radio", null],
      ["g2", "checkbox", null],
    ],
    "no field on greenhouse-step2 may carry a section. If the certify " +
      "checkbox (g2) has acquired 'Voluntary Self-Identification of " +
      "Disability', the heading rule has stopped requiring containment and a " +
      "legal attestation is now labelled with a demographic heading",
  )

  // And the contrast, so this is not just an assertion of absence: the sibling
  // page DOES produce sections, on exactly the fields that sit under a heading
  // whose own parent contains them.
  assert.deepEqual(
    fixture("greenhouse-step1")
      .fields.filter((f) => f.section)
      .map((f) => [f.l, f.section]),
    [
      ["Attach", "Resume"],
      ["Attach", "Cover Letter"],
    ],
    "greenhouse-step1's two file inputs must still carry their headings, or " +
      "the rule above is being satisfied by a scanner that emits no sections " +
      "at all — which would make this whole test vacuous",
  )
})

test("no served page hides text by geometry, which is the harness's stated limit", () => {
  // tests/fixtures/boards/dom.mjs has no layout engine: every rendered element
  // gets the same 200x20 box. That is fine for the current corpus — the only
  // visual carrier in it is `color: transparent`, which is a computed-style
  // question, not a geometric one. It stops being fine the moment a page hides
  // a label by clipping, off-screen positioning or an overlay: the scanner
  // would withdraw a vouch that this harness still grants, and regenerating a
  // fixture from the harness would then bake in the WRONG answer.
  //
  // So this fails loudly and names the fix (assert that carrier in
  // browser-vouch.test.mjs, and exempt the page here) rather than letting a
  // regenerated fixture lie.
  const GEOMETRIC =
    /clip\s*:|clip-path\s*:|position\s*:\s*(absolute|fixed)|(left|top)\s*:\s*-\d|width\s*:\s*[01]px|height\s*:\s*[01]px|transform\s*:\s*scale\(\s*0|z-index\s*:/i
  const offenders = []
  for (const [scanName] of PAIRS) {
    const src = html[scanName]
    if (/<style[\s>]/i.test(src)) offenders.push(`${scanName}: a <style> block`)
    for (const m of src.matchAll(/style="([^"]*)"/g)) {
      if (GEOMETRIC.test(m[1])) offenders.push(`${scanName}: style="${m[1]}"`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a served page now hides content by geometry, which tests/fixtures/boards/dom.mjs " +
      "cannot reproduce — do NOT regenerate that fixture from the harness:\n  " +
      offenders.join("\n  "),
  )
})
