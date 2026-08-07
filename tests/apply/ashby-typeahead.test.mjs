// A SERVER-QUERIED AUTOCOMPLETE IS NOT AN UNPROBED DROPDOWN.
//
// THE DEFECT (Ashby, jobs.ashbyhq.com, three live Render applications,
// 2026-08-06). Location renders as an <input role="combobox"> whose option list
// is built from a server query as you type. Opened with no query it shows "No
// results" and declares no [role=option] at all, so the scanner correctly
// records ZERO options — there is no list to enumerate, now or ever. The field
// then resolved NEEDS-CHOICE "field was not probed", deferred, and a human
// typed the same approved value in by hand on every single application.
//
// THE RULE THIS PINS. Hard rule 6 permits exactly three ways to make fewer
// things defer: an adapter that knows a board's shape, a probed option list, or
// a banked answer the user approved. This uses the first and the third
// together. It is not a loosening of the defer list and each assertion below
// exists to keep it from becoming one — most of this file is the boundaries.
//
// Run: node --test tests/apply/ashby-typeahead.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { buildPlan, resolveFields } from "../../scripts/apply/fill-plan.mjs"
import { detectAts } from "../../scripts/apply/ats/index.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..", "..")
const PROFILE = path.join(ROOT, "tests/fixtures/profile.yaml")
const ANSWERS = path.join(ROOT, "tests/fixtures/answers-bank.yaml")
const ASHBY = "https://jobs.ashbyhq.com/acme/abc/application"

const planFor = (fields, url = ASHBY) =>
  buildPlan({
    scan: { url, fields },
    resolved: resolveFields(fields, { profile: PROFILE, answers: ANSWERS }),
    adapter: detectAts(url),
    url,
    files: {},
  })

const LOCATION = { k: "f1", t: "combo", l: "Location", req: true, sel: "#loc" }

test("the Ashby Location typeahead is filled from the fact base, not deferred", () => {
  const plan = planFor([LOCATION])
  assert.equal(
    plan.defer.filter((d) => d.k === "f1").length,
    0,
    "Location still defers",
  )
  const item = plan.items.find((i) => i.k === "f1")
  assert.ok(item, "Location produced no fill item")
  assert.equal(item.typeahead, true)
  assert.ok(item.value, "the item carries no value to type")
  // The value traces to the fact base, and the item says so.
  assert.match(item.bank, /^(a-\d+@|contact\.)/)
})

test("BOUNDARY: a board with no such declaration still defers", () => {
  // The adapter declaration is the whole gate. An identically-shaped control on
  // a board nobody has looked at must behave exactly as it did before.
  const url = "https://boards.greenhouse.io/acme/jobs/1"
  const plan = planFor([LOCATION], url)
  assert.equal(detectAts(url).id, "greenhouse")
  assert.equal(
    plan.items.filter((i) => i.k === "f1" && i.how !== "skip").length,
    0,
    "a control promoted itself on a board with no typeahead declaration",
  )
})

test("BOUNDARY: an enumerated list that lacks the value still defers", () => {
  // The opposite situation, and the one that must never be swept in: options
  // WERE read, and the value is not among them. That is "this value is not
  // offered" — a fact about the form, not a missing enumeration.
  const plan = planFor([
    { ...LOCATION, opts: ["New York, NY", "San Francisco, CA"] },
  ])
  assert.ok(
    plan.defer.some((d) => d.k === "f1"),
    "a value absent from a real option list was typed in anyway",
  )
})

test("BOUNDARY: an unlabelled control the declaration does not name still defers", () => {
  const plan = planFor([{ ...LOCATION, l: "Preferred office" }])
  assert.ok(
    plan.defer.some((d) => d.k === "f1"),
    "the promotion reached a field the adapter never named",
  )
})

test("BOUNDARY: no approved value means it still defers", () => {
  // The fact base cannot answer this one, so there is nothing lawful to type.
  // Rule 1 does not move: a field the fact base cannot answer is deferred.
  const plan = planFor([
    { k: "f1", t: "combo", l: "Location", req: true, sel: "#loc" },
  ])
  // Sanity: the fixture profile CAN answer Location, so invert it by asking
  // for a field the same declaration matches but the fact base has nothing for.
  const none = buildPlan({
    scan: { url: ASHBY, fields: [LOCATION] },
    resolved: [{ k: "f1", status: "NEEDS-CHOICE", source: "-", value: "" }],
    adapter: detectAts(ASHBY),
    url: ASHBY,
    files: {},
  })
  assert.ok(plan.items.find((i) => i.k === "f1"))
  assert.ok(
    none.defer.some((d) => d.k === "f1"),
    "a field with no resolved value was promoted",
  )
})

test("BOUNDARY: UNKNOWN is never promoted, whatever the adapter says", () => {
  // Rule 6: "UNKNOWN still blocks on BOTH paths ... it means nothing
  // deterministic understood the field". No adapter declaration may override
  // that, so the status is part of the gate rather than the label alone.
  const plan = buildPlan({
    scan: { url: ASHBY, fields: [LOCATION] },
    resolved: [
      {
        k: "f1",
        status: "UNKNOWN",
        source: "contact.location",
        value: "North Las Vegas, Nevada",
        label: "Location",
      },
    ],
    adapter: detectAts(ASHBY),
    url: ASHBY,
    files: {},
  })
  assert.ok(
    plan.defer.some((d) => d.k === "f1"),
    "an UNKNOWN field was promoted to a fill",
  )
})

test("BOUNDARY: a pipeline default is not an approved provenance", () => {
  // "eeo:decline" and its siblings are this pipeline's own default answer, not
  // something the user said. A value with that provenance must not be typed
  // onto a control that could not be grounded.
  const plan = buildPlan({
    scan: { url: ASHBY, fields: [LOCATION] },
    resolved: [
      {
        k: "f1",
        status: "NEEDS-CHOICE",
        source: "eeo:decline",
        value: "Decline to self identify",
        label: "Location",
      },
    ],
    adapter: detectAts(ASHBY),
    url: ASHBY,
    files: {},
  })
  assert.ok(
    plan.defer.some((d) => d.k === "f1"),
    "a pipeline default was typed onto an ungrounded control",
  )
})
