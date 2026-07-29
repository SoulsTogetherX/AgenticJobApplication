// The planner is where every decision is made, so this is where the safety
// properties have to hold: consent is never agreed to, unresolved fields are
// never guessed, and a question is never mistaken for a profile field.
import test from "node:test"
import assert from "node:assert/strict"
import { buildPlan, isConsent } from "../../scripts/apply/fill-plan.mjs"
import { detectAts, ADAPTERS } from "../../scripts/apply/ats/index.mjs"
import greenhouse from "../../scripts/apply/ats/greenhouse.mjs"

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

// --- detection ------------------------------------------------------------

test("detects the boards we adapt, by host", () => {
  assert.equal(
    detectAts("https://job-boards.greenhouse.io/coinbase/jobs/8070574").id,
    "greenhouse",
  )
  assert.equal(
    detectAts("https://boards.greenhouse.io/x/jobs/1").id,
    "greenhouse",
  )
  assert.equal(detectAts("https://jobs.lever.co/allegiantair/abc").id, "lever")
  assert.equal(detectAts("https://jobs.ashbyhq.com/vanta/abc").id, "ashby")
})

test("an unknown board falls back to generic rather than failing", () => {
  const a = detectAts("https://careers.somecompany.example/apply/123")
  assert.equal(a.id, "generic")
  assert.ok(a.comboStrategies.length > 0)
})

test("Workday is a hand-off, not an adapter", () => {
  const a = detectAts(
    "https://acme.wd1.myworkdayjobs.com/en-US/careers/job/123",
  )
  assert.equal(a.id, "workday")
  assert.equal(a.handoff, true)
  assert.match(a.reason, /account/i, "must say why a human has to take over")
  assert.ok(
    !ADAPTERS.some((x) => x.id === "workday"),
    "must not be registered as a fillable adapter",
  )
})

test("a lookalike hostname does not match", () => {
  // "notgreenhouse.io.evil.test" must not be treated as Greenhouse.
  assert.equal(
    detectAts("https://notgreenhouse.io.evil.test/apply").id,
    "generic",
  )
})

// --- consent --------------------------------------------------------------

test("consent phrasing is recognised", () => {
  for (const label of [
    "Please confirm receipt of the above linked Global Data Privacy Notice and US Arbitration Agreement.",
    "I understand that Coinbase may use AI tools to assist in the application process.",
    "I agree to the Terms and Conditions",
    "Electronic signature",
    "Do you consent to a background check?",
  ]) {
    assert.ok(isConsent(label), label)
  }
})

test("work authorization is a fact, not a consent", () => {
  // Deferring genuine profile questions as "consent" would be just as wrong as
  // agreeing to things — it would bury them in the wrong bucket.
  assert.ok(
    !isConsent("Are you legally authorized to work in the United States?"),
  )
  assert.ok(
    !isConsent("Will you require sponsorship for employment visa status?"),
  )
})

test("a consent field is deferred even when the bank resolved it confidently", () => {
  const scan = scanOf([
    {
      k: "f1",
      t: "combo",
      l: "Please confirm receipt of the Arbitration Agreement",
      opts: ["Confirmed"],
    },
  ])
  const plan = buildPlan({
    scan,
    resolved: [ok("f1", "Confirmed")],
    adapter: greenhouse,
    files,
  })
  assert.equal(
    plan.items.length,
    0,
    "an agreement must never become a plan item",
  )
  assert.equal(plan.defer[0].why, "consent")
})

test("a question about the name is not answered with the name", async () => {
  // Caught live on Affirm: "Name Pronunciation" was filled with "Xavier
  // Alvarez", which is not an answer to what was asked.
  const { resolveFields } = await import("../../scripts/apply/fill-plan.mjs")
  const rows = resolveFields(
    [
      { k: "f1", t: "text", l: "Name Pronunciation" },
      { k: "f2", t: "text", l: "Preferred Name" },
    ],
    {
      profile: "tests/fixtures/profile.yaml",
      answers: "tests/fixtures/answers-bank.yaml",
    },
  )
  const byKey = Object.fromEntries(rows.map((r) => [r.k, r]))
  assert.notEqual(byKey.f1.status, "OK", "pronunciation is not the name")
  assert.equal(byKey.f2.status, "OK", "but a preferred name still resolves")
})

// --- resolution -> verbs --------------------------------------------------

test("field types map to the right verb", () => {
  const scan = scanOf([
    { k: "f1", t: "text", l: "First Name" },
    { k: "f2", t: "select", l: "Country" },
    { k: "f3", t: "combo", l: "School" },
    { k: "f4", t: "textarea", l: "Why us" },
  ])
  const plan = buildPlan({
    scan,
    resolved: [
      ok("f1", "Xavier"),
      ok("f2", "USA"),
      ok("f3", "UNLV"),
      ok("f4", "text"),
    ],
    adapter: greenhouse,
    files,
  })
  assert.deepEqual(
    plan.items.map((i) => i.how),
    ["fill", "select", "combo", "fill"],
  )
})

test("checkbox groups target the option element, not the group", () => {
  const scan = scanOf([
    {
      k: "g1",
      t: "checkbox",
      l: "Current role",
      o: [{ k: "f9", l: "Current role", sel: "#cr" }],
    },
  ])
  const plan = buildPlan({
    scan,
    resolved: [
      {
        k: "g1",
        status: "OK",
        value: "Current role",
        pick: "f9",
        pickSel: "#cr",
      },
    ],
    adapter: greenhouse,
    files,
  })
  assert.equal(plan.items[0].k, "f9", "a group has no element of its own")
  assert.equal(plan.items[0].sel, "#cr")
  assert.equal(plan.items[0].how, "check")
})

test("unresolved REQUIRED fields are deferred, never guessed", () => {
  const scan = scanOf([
    { k: "f1", t: "text", l: "A", req: true },
    { k: "f2", t: "text", l: "B", req: true },
    { k: "f3", t: "combo", l: "C", req: true, opts: ["x", "y"] },
    { k: "f4", t: "text", l: "D", req: true },
  ])
  const plan = buildPlan({
    scan,
    resolved: [
      { k: "f1", status: "UNKNOWN", value: "" },
      { k: "f2", status: "MAYBE", value: "maybe-ish" },
      { k: "f3", status: "NEEDS-CHOICE", value: "z" },
      { k: "f4", status: "OK", value: "" },
    ],
    adapter: greenhouse,
    files,
  })
  assert.equal(plan.items.length, 0)
  assert.equal(plan.defer.length, 4)
  assert.deepEqual(plan.defer.find((d) => d.k === "f3").options, ["x", "y"])
})

test("unresolved OPTIONAL fields are left blank, not turned into questions", () => {
  // Asking for a Twitter handle the user does not have is noise, and noise is
  // what makes an approval message get skimmed. Still visible as a skip item.
  const scan = scanOf([
    { k: "f1", t: "text", l: "Twitter" },
    { k: "f2", t: "textarea", l: "Other Links" },
    { k: "f3", t: "text", l: "Preferred Name", req: true },
  ])
  const plan = buildPlan({
    scan,
    resolved: [
      { k: "f1", status: "UNKNOWN", value: "" },
      { k: "f2", status: "UNKNOWN", value: "" },
      { k: "f3", status: "UNKNOWN", value: "" },
    ],
    adapter: greenhouse,
    files,
  })
  assert.deepEqual(
    plan.defer.map((d) => d.k),
    ["f3"],
    "only the required field is worth the user's attention",
  )
  const skipped = plan.items.filter((i) => i.how === "skip")
  assert.deepEqual(
    skipped.map((i) => i.k),
    ["f1", "f2"],
  )
  assert.match(skipped[0].why, /optional/)
})

// --- attachments ----------------------------------------------------------

test("attachments fall back to document order when labels say only 'Attach'", () => {
  // Exactly what Greenhouse does: the real heading sits outside the element.
  const scan = scanOf([
    { k: "f1", t: "file", l: "Attach" },
    { k: "f2", t: "file", l: "Attach" },
  ])
  const plan = buildPlan({ scan, resolved: [], adapter: greenhouse, files })
  assert.deepEqual(
    plan.items.map((i) => i.paths[0]),
    [files.resume, files.cover],
    "resume slot comes first on every board we adapt",
  )
})

test("an informative label wins over position", () => {
  const scan = scanOf([
    { k: "f1", t: "file", l: "Cover Letter" },
    { k: "f2", t: "file", l: "Resume/CV" },
  ])
  const plan = buildPlan({ scan, resolved: [], adapter: greenhouse, files })
  assert.deepEqual(
    plan.items.map((i) => i.paths[0]),
    [files.cover, files.resume],
  )
})

test("a missing document defers instead of planning a broken upload", () => {
  const scan = scanOf([{ k: "f1", t: "file", l: "Resume/CV" }])
  const plan = buildPlan({ scan, resolved: [], adapter: greenhouse, files: {} })
  assert.equal(plan.items.length, 0)
  assert.match(plan.defer[0].why, /no rendered resume/)
})

// --- composite widgets and current-role handling --------------------------

test("the picker half of a phone widget is skipped, not filled", () => {
  const scan = scanOf([
    { k: "f1", t: "combo", l: "Phone" },
    { k: "f2", t: "tel", l: "Phone" },
  ])
  const plan = buildPlan({
    scan,
    resolved: [ok("f1", "(702) 810-4950"), ok("f2", "(702) 810-4950")],
    adapter: greenhouse,
    files,
  })
  const combo = plan.items.find((i) => i.k === "f1")
  assert.equal(
    combo.how,
    "skip",
    "the number must not go into the country picker",
  )
  assert.equal(plan.items.find((i) => i.k === "f2").how, "fill")
})

test("end dates are dropped once the current-role box is ticked", () => {
  const scan = scanOf([
    {
      k: "g1",
      t: "checkbox",
      l: "Current role",
      o: [{ k: "f9", l: "Current role", sel: "#cr" }],
    },
    { k: "f2", t: "combo", l: "End date month" },
    { k: "f3", t: "text", l: "End date year" },
  ])
  const plan = buildPlan({
    scan,
    resolved: [
      {
        k: "g1",
        status: "OK",
        value: "Current role",
        pick: "f9",
        pickSel: "#cr",
      },
      { k: "f2", status: "UNKNOWN", value: "" },
      { k: "f3", status: "UNKNOWN", value: "" },
    ],
    adapter: greenhouse,
    files,
  })
  assert.equal(plan.defer.length, 0, "end dates must not be asked about")
  assert.equal(plan.items.filter((i) => i.how === "skip").length, 2)
})

// --- plan shape -----------------------------------------------------------

test("the plan carries the url guard and the adapter's strategy order", () => {
  const scan = scanOf([{ k: "f1", t: "text", l: "First Name" }])
  const plan = buildPlan({
    scan,
    resolved: [ok("f1", "Xavier")],
    adapter: greenhouse,
    files,
    url: "https://job-boards.greenhouse.io/x/jobs/1",
  })
  assert.equal(plan.urlGuard, "https://job-boards.greenhouse.io/x/jobs/1")
  assert.deepEqual(plan.comboStrategies, greenhouse.comboStrategies)
  assert.equal(plan.ats, "greenhouse")
  assert.equal(plan.v, 1)
})
