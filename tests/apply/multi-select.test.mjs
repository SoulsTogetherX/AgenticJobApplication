// Multi-select support, end to end: the scanner marks the field, the bank
// grounds a LIST answer per element, the planner emits `values`, and the
// engine selects each one — natively via selectOption on a <select multiple>,
// on a token picker by select → verify the token → repeat.
//
// The long-standing defect this closes: scan-page.js recorded `f.multi = true`
// for <select multiple> since it existed and NOTHING consumed it — the flag
// was recorded and dropped, so a banked list answer collapsed to whichever
// single element matched first and the rest were silently missed (measured on
// the Tebra Greenhouse apply, 2026-07-29).
//
// Rule 1 is pinned here too: this change only makes ANSWERABLE multi-selects
// fillable. A multi field whose list answer does not FULLY ground, or that has
// no banked answer at all, defers exactly as before — and checkbox GROUPS
// (the confirm-widget assent class) never enter this path.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import fillPage from "../../scripts/apply/fill-engine.mjs"
import { launchBrowser } from "../../scripts/apply/browser.mjs"
import {
  matchOption,
  resolveFieldsFromFiles,
} from "../../scripts/apply/answer-bank.mjs"
import { buildPlan, readiness } from "../../scripts/apply/fill-plan.mjs"
import {
  readScannerSource,
  scannerExpression,
} from "../../scripts/apply/scan-engine.mjs"
import greenhouse from "../../scripts/apply/ats/greenhouse.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const PAGE = fs.readFileSync(
  path.join(ROOT, "tests", "fixtures", "greenhouse", "multi-select.html"),
  "utf8",
)

const NO_BROWSER = await (async () => {
  try {
    const s = await launchBrowser({ headless: true })
    await s.close()
    return null
  } catch (e) {
    return "no usable Chromium: " + String(e.message).slice(0, 90)
  }
})()

const files = {
  resume: "C:\\jobs\\x\\resume.pdf",
  cover: "C:\\jobs\\x\\cover-letter.pdf",
}
const scanOf = (fields) => ({
  url: "https://job-boards.greenhouse.io/x/jobs/1",
  fields,
})
const ok = (k, value, over = {}) => ({
  k,
  status: "OK",
  value,
  sel: `#${k}`,
  ...over,
})

const plan = (items, over = {}) => ({
  v: 1,
  slug: "x",
  ats: "greenhouse",
  items,
  defer: [],
  ...over,
})

// One browser run against the fixture; returns the engine report plus the
// page's own account of what is committed (tokens, hidden stores, native
// selection) so every assertion below is about the DOM, not the report alone.
const run = async (items, over) => {
  const s = await launchBrowser({ headless: true })
  try {
    await s.page.setContent(PAGE)
    const out = await fillPage(s.page, plan(items, over))
    const state = await s.page.evaluate(() => ({
      skillsTokens: [
        ...document.querySelectorAll("#skills [class*='multi-value__label']"),
      ].map((n) => n.textContent.trim()),
      skillsStores: [...document.querySelectorAll("#skills-stores input")].map(
        (n) => n.value,
      ),
      stackTokens: [
        ...document.querySelectorAll("#stack [class*='multi-value__label']"),
      ].map((n) => n.textContent.trim()),
      colors: [...document.getElementById("colors").selectedOptions].map(
        (o) => o.text,
      ),
    }))
    return { out, state }
  } finally {
    await s.close()
  }
}

// --- answer bank: what a list answer means ---------------------------------

test("matchOption: a list on a multi field grounds EVERY element or defers", () => {
  const opts = ["JavaScript", "TypeScript", "Python", "Go"]
  const m = matchOption(["Python", "Go"], opts, {
    requireOptions: true,
    label: "Languages",
    multi: true,
  })
  assert.deepEqual(m.values, ["Python", "Go"])
  assert.equal(m.value, "Python, Go")
  assert.ok(!m.needsChoice)

  // One element the form does not offer defers the WHOLE field — a partial
  // selection would silently drop part of the user's recorded answer.
  const bad = matchOption(["Python", "Rust"], opts, {
    requireOptions: true,
    label: "Languages",
    multi: true,
  })
  assert.equal(bad.needsChoice, true)
  assert.equal(bad.values, undefined)
})

test("matchOption: multi changes nothing for single values or unprobed lists", () => {
  const opts = ["JavaScript", "TypeScript", "Python", "Go"]
  // A single value on a multi field is a complete answer via the single ladder.
  const single = matchOption("Python", opts, {
    requireOptions: true,
    label: "Languages",
    multi: true,
  })
  assert.equal(single.value, "Python")
  assert.equal(single.values, undefined)
  // An unprobed multi field still defers as unprobed — rule 1.
  const unprobed = matchOption(["Python", "Go"], null, {
    requireOptions: true,
    label: "Languages",
    multi: true,
  })
  assert.equal(unprobed.needsChoice, true)
  assert.equal(unprobed.unprobed, true)
})

test("matchOption: without the multi flag a list is still alternatives (first offered wins)", () => {
  const m = matchOption(["Rust", "Go"], ["JavaScript", "Go"], {
    requireOptions: true,
    label: "Languages",
  })
  assert.equal(m.value, "Go")
  assert.equal(m.values, undefined)
})

test("a banked YAML list resolves a multi field end to end — and stays alternatives off it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aj-multi-"))
  try {
    const answers = path.join(dir, "answers.yaml")
    fs.writeFileSync(
      answers,
      "answers:\n" +
        '  - id: a-001\n    question: "Programming languages"\n' +
        '    answer: ["JavaScript", "Python"]\n',
    )
    const field = (over = {}) => ({
      k: "f1",
      sel: "#skills",
      t: "combo",
      l: "Programming languages",
      req: true,
      opts: ["JavaScript", "TypeScript", "Python", "Go"],
      ...over,
    })
    const opts = {
      profileFile: path.join(dir, "no-profile.yaml"),
      answersFile: answers,
    }
    const multi = resolveFieldsFromFiles([field({ multi: true })], opts)
      .results[0]
    assert.equal(multi.status, "OK")
    assert.deepEqual(multi.values, ["JavaScript", "Python"])
    assert.equal(multi.value, "JavaScript, Python")

    // The SAME bank entry against the same field without the multi mark keeps
    // the old semantics: an ordered list of alternatives, first offered wins.
    const single = resolveFieldsFromFiles([field()], opts).results[0]
    assert.equal(single.status, "OK")
    assert.equal(single.value, "JavaScript")
    assert.equal(single.values, undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// --- planner: values ride onto the item, and only there --------------------

test("a grounded list answer on a multi combo plans values[] and is ready", () => {
  const scan = scanOf([
    {
      k: "f1",
      sel: "#skills",
      t: "combo",
      multi: true,
      l: "Programming languages",
      req: true,
      opts: ["JavaScript", "TypeScript", "Python", "Go"],
    },
  ])
  const resolved = [
    ok("f1", "JavaScript, Python", {
      sel: "#skills",
      values: ["JavaScript", "Python"],
    }),
  ]
  const p = buildPlan({ scan, resolved, adapter: greenhouse, files })
  const item = p.items.find((i) => i.k === "f1")
  assert.ok(item, "the multi combo must be planned, not deferred")
  assert.equal(item.how, "combo")
  assert.deepEqual(item.values, ["JavaScript", "Python"])
  assert.equal(item.value, "JavaScript, Python")
  assert.equal(readiness(p).ready, true)
})

test("a grounded list answer on a native multi select plans values[]", () => {
  const scan = scanOf([
    {
      k: "f1",
      sel: "#colors",
      t: "select",
      multi: true,
      l: "Favourite colours",
      req: true,
      opts: ["Red", "Green", "Blue", "Yellow"],
    },
  ])
  const resolved = [
    ok("f1", "Red, Blue", { sel: "#colors", values: ["Red", "Blue"] }),
  ]
  const p = buildPlan({ scan, resolved, adapter: greenhouse, files })
  const item = p.items.find((i) => i.k === "f1")
  assert.equal(item.how, "select")
  assert.deepEqual(item.values, ["Red", "Blue"])
})

test("rule 1: a multi field that does not fully ground, or has no answer, still defers", () => {
  const field = {
    k: "f1",
    sel: "#skills",
    t: "combo",
    multi: true,
    l: "Programming languages",
    req: true,
    opts: ["JavaScript", "TypeScript", "Python", "Go"],
  }
  // The bank had a list but one element is not offered: NEEDS-CHOICE, no values.
  const partial = buildPlan({
    scan: scanOf([field]),
    resolved: [
      {
        k: "f1",
        status: "NEEDS-CHOICE",
        value: "Python, Rust",
        sel: "#skills",
      },
    ],
    adapter: greenhouse,
    files,
  })
  assert.equal(partial.items.length, 0)
  assert.equal(partial.defer.length, 1)
  assert.equal(partial.defer[0].why, "needs-choice")

  // Nothing resolved at all: UNKNOWN defers exactly as before.
  const unknown = buildPlan({
    scan: scanOf([field]),
    resolved: [{ k: "f1", status: "UNKNOWN", value: "", sel: "#skills" }],
    adapter: greenhouse,
    files,
  })
  assert.equal(unknown.items.length, 0)
  assert.equal(unknown.defer[0].why, "unknown")
})

test("checkbox groups never enter the multi path — values do not ride on check items", () => {
  const group = {
    k: "g1",
    t: "checkbox",
    l: "Which shifts can you work?",
    req: true,
    o: [
      { k: "o1", sel: "#o1", l: "Days" },
      { k: "o2", sel: "#o2", l: "Nights" },
    ],
  }
  // Even a resolution that somehow carries values must not put them on a
  // check item (the exact-bank branch) or rescue the group from deferring
  // (every other source): a checkbox group is an ACT, not a multi-select.
  const exact = buildPlan({
    scan: scanOf([group]),
    resolved: [
      ok("g1", "Days", {
        source: "a-001@exact",
        pick: "o1",
        pickSel: "#o1",
        values: ["Days", "Nights"],
      }),
    ],
    adapter: greenhouse,
    files,
  })
  const item = exact.items.find((i) => i.k === "g1")
  assert.ok(item, "exact-banked group still actuates as before")
  assert.equal(item.how, "check")
  assert.ok(!("values" in item), "no values list on a check item")

  const fuzzy = buildPlan({
    scan: scanOf([group]),
    resolved: [
      ok("g1", "Days", { source: "a-001@0.90", pick: "o1", pickSel: "#o1" }),
    ],
    adapter: greenhouse,
    files,
  })
  assert.equal(fuzzy.items.filter((i) => i.how !== "skip").length, 0)
  assert.equal(fuzzy.defer[0].why, "confirm-widget")
})

// --- scanner: the flag exists for combos now -------------------------------

test("the scanner marks token pickers and native multiple selects, and only them", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const s = await launchBrowser({ headless: true })
  try {
    await s.page.setContent(PAGE)
    const expr = scannerExpression(readScannerSource())
    const scan = await s.page.evaluate(
      (a) => (0, eval)("(" + a + ")")(false),
      expr,
    )
    const bySel = new Map(scan.fields.map((f) => [f.sel, f]))
    const skills = bySel.get("#skills")
    assert.equal(skills?.t, "combo")
    assert.equal(skills?.multi, true, "--is-multi value container is the mark")
    const stack = bySel.get("#stack")
    assert.equal(stack?.multi, true, "a rendered token also marks it")
    const colors = bySel.get("#colors")
    assert.equal(colors?.t, "select")
    assert.equal(colors?.multi, true, "el.multiple as always")
    const dept = bySel.get("#dept")
    assert.equal(dept?.t, "combo")
    assert.equal(dept?.multi, undefined, "a single-select combo is unmarked")
  } finally {
    await s.close()
  }
})

// --- engine: native multiple -----------------------------------------------

test("a <select multiple> takes every planned value in one call", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const { out, state } = await run([
    {
      k: "f1",
      sel: "#colors",
      how: "select",
      value: "Red, Blue",
      values: ["Red", "Blue"],
    },
  ])
  assert.equal(out.failed, 0, JSON.stringify(out.failures))
  assert.equal(out.ok, 1)
  assert.deepEqual(state.colors, ["Red", "Blue"])
  assert.ok(out.verify.landed.includes("f1"), "verify must see both options")
  assert.equal(out.verify.mismatch.length, 0)
})

test("a native multi select refuses the whole set when one option is not on the list", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // The plan should never contain this (matchOption defers a list that does
  // not fully ground — see rule 1 above), so this is the engine's own floor
  // for a stale cached option list: selectOption is all-or-nothing, so
  // nothing is selected and the item fails rather than half-answering.
  const { out, state } = await run([
    {
      k: "f1",
      sel: "#colors",
      how: "select",
      value: "Red, Mauve",
      values: ["Red", "Mauve"],
    },
  ])
  assert.equal(out.ok, 0)
  assert.equal(out.failed, 1)
  assert.deepEqual(state.colors, [], "not even the valid half is selected")
  assert.ok(!out.verify.landed.includes("f1"))
})

// --- engine: token picker --------------------------------------------------

test("a react-select multi picker gets one token per value, verified per token", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const { out, state } = await run([
    {
      k: "f2",
      sel: "#skills",
      how: "combo",
      value: "JavaScript, Python",
      values: ["JavaScript", "Python"],
    },
  ])
  assert.equal(out.failed, 0, JSON.stringify(out.failures))
  assert.equal(out.ok, 1)
  assert.deepEqual(state.skillsTokens, ["JavaScript", "Python"])
  assert.deepEqual(
    state.skillsStores,
    ["JavaScript", "Python"],
    "the widget's own store holds both — commitment, not decoration",
  )
  assert.ok(out.verify.landed.includes("f2"))
  assert.equal(out.verify.mismatch.length, 0)
  assert.ok(out.comboVia.f2, "the strategy that worked is recorded")
})

test("a per-field hint seeds the token picker's ladder, and a stale one does not", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // The multi twin of the single-select case in fill-page.test.mjs, where the
  // saving is measured. Here the READOUT is what matters rather than the
  // clock: every strategy commits on this widget, so the strategy `comboVia`
  // names IS the one that was tried first. `item.via` seeds value 1; from
  // value 2 on, what this run itself proved takes over (a hint is a memory of
  // the last application, and this field just produced better evidence).
  const item = (extra = {}) => ({
    k: "f2",
    sel: "#skills",
    how: "combo",
    value: "JavaScript, Python",
    values: ["JavaScript", "Python"],
    ...extra,
  })

  const cold = await run([item()])
  assert.equal(cold.out.comboVia.f2, "type-enter", "the ladder's first rung")

  const hinted = await run([item({ via: "click-option" })])
  assert.equal(hinted.out.ok, 1, JSON.stringify(hinted.out.failures))
  assert.deepEqual(hinted.state.skillsTokens, ["JavaScript", "Python"])
  assert.equal(
    hinted.out.comboVia.f2,
    "click-option",
    "the hinted rung ran before type-enter ever did",
  )

  // A name no strategy implements cannot be run, and must not narrow the
  // ladder either: the field falls back to the board's order exactly as if it
  // carried no hint, and still lands every value.
  const stale = await run([item({ via: "retired" })])
  assert.equal(stale.out.ok, 1, JSON.stringify(stale.out.failures))
  assert.deepEqual(stale.state.skillsTokens, ["JavaScript", "Python"])
  assert.equal(stale.out.comboVia.f2, "type-enter")
})

test("a single value on a multi picker still fills through the single path", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const { out, state } = await run([
    { k: "f2", sel: "#skills", how: "combo", value: "Go" },
  ])
  assert.equal(out.failed, 0, JSON.stringify(out.failures))
  assert.deepEqual(state.skillsTokens, ["Go"])
  assert.ok(
    out.verify.landed.includes("f2"),
    "the token list is the committed store the readback must find",
  )
})

test("a value the menu does not offer FAILS the item — partial fills are never reported ok", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const { out, state } = await run([
    {
      k: "f2",
      sel: "#skills",
      how: "combo",
      value: "JavaScript, COBOL",
      values: ["JavaScript", "COBOL"],
    },
  ])
  assert.equal(out.ok, 0)
  assert.equal(out.failed, 1)
  assert.match(out.failures[0].why, /COBOL/)
  // The grounded value DID land — visible on the page for the user — but the
  // item as a whole is a failure and verify agrees.
  assert.deepEqual(state.skillsTokens, ["JavaScript"])
  assert.ok(!out.verify.landed.includes("f2"))
  assert.equal(out.verify.mismatch.length, 1)
  assert.equal(out.verify.mismatch[0].k, "f2")
})

test("replay is idempotent: a token already present is skipped, not doubled or toggled", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  // #stack loads with a React token already committed.
  const { out, state } = await run([
    {
      k: "f3",
      sel: "#stack",
      how: "combo",
      value: "React, Node",
      values: ["React", "Node"],
    },
  ])
  assert.equal(out.failed, 0, JSON.stringify(out.failures))
  assert.deepEqual(
    state.stackTokens,
    ["React", "Node"],
    "exactly one React token — the pre-existing one — plus the new Node",
  )
  assert.ok(out.verify.landed.includes("f3"))
})
