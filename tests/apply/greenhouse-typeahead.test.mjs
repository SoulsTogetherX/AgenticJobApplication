// GREENHOUSE'S "Location (City)*" IS A SERVER-QUERIED AUTOCOMPLETE — the same
// shape, and the same rule, as Ashby's Location (tests/apply/ashby-typeahead
// .test.mjs carries the full argument; ats/greenhouse.mjs the measurement).
//
// MEASURED on job-boards.greenhouse.io/embed/job_app forms 2026-08-18: opened
// with no query the control renders no options, so the probe records none on
// every one of those forms, the field resolves NEEDS-CHOICE "field was not
// probed", and every Greenhouse application defers on it — with the exact
// suggestion the search offers already banked. Rule 6's first lawful route (an
// adapter that knows the board's shape) plus its third (a banked answer).
//
// Run: node --test tests/apply/greenhouse-typeahead.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { buildPlan, resolveFields } from "../../src/apply/fill-plan.mjs"
import { detectAts } from "../../src/apply/ats/index.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..", "..")
const PROFILE = path.join(ROOT, "tests/fixtures/profile.yaml")
const ANSWERS = path.join(ROOT, "tests/fixtures/answers-bank.yaml")
const EMBED =
  "https://job-boards.greenhouse.io/embed/job_app?for=acme&token=123"

const planFor = (fields, url = EMBED) =>
  buildPlan({
    scan: { url, fields },
    resolved: resolveFields(fields, { profile: PROFILE, answers: ANSWERS }),
    adapter: detectAts(url),
    url,
    files: {},
  })

const CITY = { k: "f2", t: "combo", l: "Location (City)*", req: true }

test("Greenhouse's Location (City)* is typed from the fact base, not deferred", () => {
  const plan = planFor([CITY])
  assert.equal(detectAts(EMBED).id, "greenhouse")
  assert.equal(plan.defer.filter((d) => d.k === "f2").length, 0)
  const item = plan.items.find((i) => i.k === "f2")
  assert.ok(item, "Location (City)* produced no fill item")
  assert.equal(item.typeahead, true)
  assert.ok(item.value, "the item carries no value to type")
  assert.match(item.bank, /^(a-\d+@|contact\.)/, "an approved provenance")
})

test("BOUNDARY: the declaration names 'Location (City)' only — a bare 'Location' on Greenhouse still defers", () => {
  // Ashby's label, on Greenhouse: no declaration for it, so it behaves exactly
  // as before this landed. The two adapters name their own shapes.
  const plan = planFor([{ k: "f1", t: "combo", l: "Location", req: true }])
  assert.equal(
    plan.items.filter((i) => i.k === "f1" && i.how !== "skip").length,
    0,
    "a control promoted itself on a label the adapter never named",
  )
  assert.ok(plan.defer.some((d) => d.k === "f1"))
})

test("BOUNDARY: a probed list that lacks the value still defers", () => {
  const plan = planFor([
    { ...CITY, opts: ["New York, New York, United States", "Austin, Texas"] },
  ])
  assert.ok(
    plan.defer.some((d) => d.k === "f2"),
    "a value absent from a real option list was typed in anyway",
  )
})

test("BOUNDARY: UNKNOWN is never promoted, whatever the adapter says", () => {
  const plan = buildPlan({
    scan: { url: EMBED, fields: [CITY] },
    resolved: [
      {
        k: "f2",
        status: "UNKNOWN",
        source: "contact.location",
        value: "North Las Vegas, Nevada, United States",
        label: CITY.l,
      },
    ],
    adapter: detectAts(EMBED),
    url: EMBED,
    files: {},
  })
  assert.ok(plan.defer.some((d) => d.k === "f2"))
})
