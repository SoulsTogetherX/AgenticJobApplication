// The planner is where every decision is made, so this is where the safety
// properties have to hold: consent is never agreed to, unresolved fields are
// never guessed, and a question is never mistaken for a profile field.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import vm from "node:vm"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  buildPlan,
  isConsent,
  readiness,
  buildDriverSource,
  buildBootstrap,
} from "../../scripts/apply/fill-plan.mjs"
import { detectAts, ADAPTERS } from "../../scripts/apply/ats/index.mjs"
import greenhouse from "../../scripts/apply/ats/greenhouse.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

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

// --- readiness --------------------------------------------------------------
//
// The planner already counted the defers, so "does this still need a human?"
// is its answer to give. Emitting it as a boolean is what lets the caller go
// scan -> fill -> hand over without reading the plan and forming an opinion.

test("readiness is true only when nothing is deferred and something is fillable", () => {
  const state = readiness({
    items: [{ k: "f1", how: "fill", value: "Jane" }],
    defer: [],
  })
  assert.equal(state.ready, true)
  assert.equal(state.reason, null)
})

test("any deferred field makes the plan not ready, and says how many", () => {
  const state = readiness({
    items: [{ k: "f1", how: "fill", value: "Jane" }],
    defer: [{ k: "f2", label: "I agree to the Terms", why: "consent" }],
  })
  assert.equal(state.ready, false)
  assert.match(state.reason, /1 deferred/)
})

test("a plan of nothing but skips is not ready", () => {
  // Every field optional-and-unresolved is a plan that would fill nothing;
  // reporting that as ready would send the engine at an empty form.
  const state = readiness({
    items: [
      { k: "f1", how: "skip", why: "optional and not in the fact base" },
      { k: "f2", how: "skip", why: "picker half of a composite widget" },
    ],
    defer: [],
  })
  assert.equal(state.ready, false)
  assert.equal(state.reason, "nothing to fill")
})

test("readiness survives a plan with no items or defer arrays at all", () => {
  assert.equal(readiness({}).ready, false)
})

test("a real built plan carries its readiness", () => {
  const notReady = buildPlan({
    scan: scanOf([
      { k: "f1", t: "text", l: "First Name", req: true },
      { k: "f2", t: "checkbox", l: "I agree to the Terms and Conditions" },
    ]),
    resolved: [ok("f1", "Jane")],
    adapter: greenhouse,
    files,
  })
  assert.equal(readiness(notReady).ready, false)

  const ready = buildPlan({
    scan: scanOf([{ k: "f1", t: "text", l: "First Name", req: true }]),
    resolved: [ok("f1", "Jane")],
    adapter: greenhouse,
    files,
  })
  assert.equal(readiness(ready).ready, true)
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

// --- the CSP-safe bootstrap ------------------------------------------------
//
// addScriptTag inserts a real inline <script> element, which any board with a
// nonce-based CSP (Ashby) refuses to run outright — that broke the fill step
// live. The fix embeds the engine source and the plan as strings in the file
// fill-plan.mjs writes, loaded whole via `filename` and injected with
// page.evaluate + eval, which is not gated by the page's CSP the way an
// injected <script> tag is. These tests cover what does not need a browser:
// the generated text's shape, and that it is valid, self-installing JS.

test("buildBootstrap points at the plan file by filename, never inline code", () => {
  const bootstrap = buildBootstrap("jobs/acme-swe/fill-plan.js")
  assert.match(bootstrap, /browser_run_code_unsafe/)
  assert.match(bootstrap, /filename/)
  assert.match(bootstrap, /jobs\/acme-swe\/fill-plan\.js/)
  assert.ok(
    !bootstrap.includes("code:"),
    "must not fall back to the inline-code form",
  )
})

test("buildDriverSource never regresses to the CSP-broken loader", () => {
  const driverSrc = buildDriverSource(
    { v: 1, slug: "x", items: [], defer: [] },
    "window.__ajFillSrc = String(async (page, plan) => plan)",
  )
  // "addScriptTag" legitimately appears in this file's own warning comments
  // ("do not fix this back to addScriptTag") — that is the point, so check
  // for the FUNCTIONAL CALL, not the word, ignoring comment lines the same
  // way fill-page.test.mjs's own sandbox-timeout test does.
  const code = driverSrc
    .split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n")
  assert.ok(
    !/\.addScriptTag\(/.test(code),
    "addScriptTag inserts an inline <script> — nonce-based CSP boards block it",
  )
  assert.ok(!/\.addInitScript\(/.test(code))
  assert.match(driverSrc, /page\.evaluate/)
  assert.match(driverSrc, /\(0,\s*eval\)/)
})

test("buildDriverSource embeds the exact engine source and plan as strings", () => {
  const plan = { v: 1, slug: "acme", items: [], defer: [] }
  const engineSrc = 'window.__ajFillSrc = String(async () => "hi")'
  const driverSrc = buildDriverSource(plan, engineSrc)
  assert.ok(
    driverSrc.includes(JSON.stringify(engineSrc)),
    "the engine text must appear verbatim, not paraphrased or truncated",
  )
  assert.ok(
    driverSrc.includes(
      JSON.stringify("window.__ajPlan = " + JSON.stringify(plan)),
    ),
    "the plan must appear verbatim as a window.__ajPlan assignment string",
  )
})

test("buildDriverSource output is valid JS wrapped exactly as browser_run_code_unsafe wraps it", () => {
  // packages/playwright-core/src/tools/backend/runCode.ts (bundled into
  // playwright-core/lib/coreBundle.js) does
  // `vm.runInContext("(" + code + ")", context2)` — verified by reading that
  // bundle directly, not assumed. Reproduce the exact expression shape.
  const driverSrc = buildDriverSource(
    { v: 1, slug: "x", items: [], defer: [] },
    "window.__ajFillSrc = String(async (page, plan) => plan)",
  )
  assert.doesNotThrow(() => new Function("(" + driverSrc + ")"))
})

test("buildDriverSource: the generated driver actually installs and runs the engine end to end", async () => {
  // A full semantic round-trip using Node's own vm module — no real browser
  // needed for THIS part, because it exercises plain JS scoping/eval
  // semantics, not Playwright/CDP/CSP behavior (which this repo has no
  // browser to verify — see fill-page.test.mjs's own header note).
  const engineSrc =
    "window.__ajFillSrc = String(async (page, plan) => ({ ok: 1, sawSlug: plan.slug }))"
  const plan = { v: 1, slug: "acme-swe", items: [], defer: [] }
  const driverSrc = buildDriverSource(plan, engineSrc)

  // Mirrors runCode.ts's own vm.createContext({ page, ... }) +
  // vm.runInContext("(" + code + ")", ctx). `window` is added here only so
  // the injected window.__ajFillSrc/__ajPlan assignments have somewhere to
  // land for inspection — in production that object is the real browser
  // page, reached over CDP, not this process.
  const ctx = {
    window: {},
    page: { evaluate: async (fn, arg) => fn(arg) },
  }
  vm.createContext(ctx)
  const driverFn = vm.runInContext("(" + driverSrc + ")", ctx)
  const result = await driverFn(ctx.page)

  assert.equal(result.ok, 1)
  assert.equal(result.sawSlug, "acme-swe")
})

test("end to end: the CLI embeds the real engine and points the bootstrap at the written file", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fill-plan-bootstrap-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const slug = "ashby-co"
  const jobDir = path.join(dir, slug)
  fs.mkdirSync(jobDir, { recursive: true })

  const scan = {
    url: "https://jobs.ashbyhq.com/acme/11111111-2222-3333-4444-555555555555",
    fields: [
      {
        k: "f1",
        t: "text",
        l: "First Name",
        req: true,
        sel: "#_systemfield_name",
      },
    ],
  }
  fs.writeFileSync(path.join(jobDir, "scan-p1.json"), JSON.stringify(scan))

  const res = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "apply", "fill-plan.mjs"),
      slug,
      "--jobs-dir",
      dir,
      "--profile",
      path.join(ROOT, "tests", "fixtures", "profile.yaml"),
      "--answers",
      path.join(ROOT, "tests", "fixtures", "answers-bank.yaml"),
      "--json",
    ],
    { cwd: ROOT, encoding: "utf8" },
  )
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout)
  assert.equal(out.plan.ats, "ashby")

  const jsPath = path.join(jobDir, "fill-plan.js")
  assert.ok(fs.existsSync(jsPath))
  const written = fs.readFileSync(jsPath, "utf8")

  // The REAL fill-page.js, not a stand-in, must be what got embedded.
  const engineOnDisk = fs.readFileSync(
    path.join(ROOT, ".claude", "skills", "apply-job", "fill-page.js"),
    "utf8",
  )
  assert.ok(
    written.includes(JSON.stringify(engineOnDisk)),
    "the generated bootstrap must embed the real engine source verbatim",
  )
  // The embedded engine source legitimately mentions "addScriptTag" in its
  // own warning comments (escaped onto one long line by JSON.stringify) — so
  // check the DRIVER'S OWN orchestration code for a live call by dropping
  // that one giant embedded-content line rather than string-matching the
  // whole file.
  const templateOnly = written
    .split(/\r?\n/)
    .filter((l) => l.length < 500)
    .join("\n")
  assert.ok(
    !/\.addScriptTag\(/.test(templateOnly),
    "the driver's own orchestration code must never call addScriptTag",
  )

  // The printed bootstrap must point at exactly this file.
  const relJs = path.relative(ROOT, jsPath).replace(/\\/g, "/")
  assert.equal(out.bootstrap, buildBootstrap(relJs))
  assert.match(out.bootstrap, /filename/)

  // And the whole written file must parse as the single expression
  // browser_run_code_unsafe requires.
  assert.doesNotThrow(() => new Function("(" + written + ")"))
})
