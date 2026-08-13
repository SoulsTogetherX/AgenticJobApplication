// THE GATE ON THE ENTIRE AUTONOMY PHASE.
//
// Commit fc645f5 closed the code round-trip: the bootstrap used to eval the
// engine INTO the page, read window.__ajFillSrc back OUT, and eval THAT
// Playwright-side, where `page` and `process` live. A board only had to define
// a getter to own the browser.
//
// tests/apply/fill-plan.test.mjs already covers buildDriverSource() in
// isolation. This file covers what that one does not:
//
//   1. THE FILE ON DISK. The CLI writes jobs/<slug>/fill-plan.js and an MCP
//      tool loads THAT. Grepping the string it generated is not the same as
//      running the artifact. Here the real generated file is executed against
//      the hostile window built by tests/fixtures/hostile/forms/fillsrc-getter.html.
//   2. THE SCANNER BRANCH. buildDriverSource(plan, engine, scannerSrc) has a
//      second code path nothing else exercises.
//   3. THE PAGE-SUPPLIED SCANNER. The engine is no longer read out of the
//      page — but the SCAN still is, and the scan decides everything.
//
// The hostile window is built by evaluating the fixture board's own script, so
// the HTML fixture is load-bearing rather than decorative: delete the getters
// from it and these tests stop testing anything, loudly.
//
// Run: node --test tests/security/rce-round-trip.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import vm from "node:vm"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { buildPlan, buildDriverSource } from "../../scripts/apply/fill-plan.mjs"
import { untrustScan } from "../../scripts/apply/scan-engine.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..", "..")
const FIXTURE = path.join(
  ROOT,
  "tests/fixtures/hostile/forms/fillsrc-getter.html",
)

// Build the hostile page's globals by running the fixture board's OWN script.
// Nothing is retyped here; if the fixture stops defining the getters this
// throws and the test fails rather than silently passing.
function hostileWindow() {
  const html = fs.readFileSync(FIXTURE, "utf8")
  const m = html.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(m, "the getter fixture must carry its attack script")
  const win = {}
  const ctx = { window: win, Object }
  vm.createContext(ctx)
  vm.runInContext(m[1], ctx)
  assert.equal(win.__ajGetterReads, 0, "reads start at zero")
  assert.ok(
    Object.getOwnPropertyDescriptor(win, "__ajFillSrc")?.get,
    "__ajFillSrc must be a getter, or this fixture proves nothing",
  )
  assert.ok(
    Object.getOwnPropertyDescriptor(win, "__ajPlan")?.get,
    "__ajPlan must be a getter",
  )
  return win
}

// A `page` that records every dangerous thing a driver could ask it to do.
function recordingPage(win) {
  const log = { clicks: [], uploads: [], evaluated: 0 }
  return {
    log,
    page: {
      evaluate: async (fn, arg) => {
        log.evaluated++
        return fn.call(win, arg)
      },
      click: async (sel) => log.clicks.push(sel),
      setInputFiles: async (sel, files) => log.uploads.push([sel, files]),
      locator: () => {
        throw new Error("the engine stub does not locate")
      },
      keyboard: { press: async () => {} },
    },
  }
}

// A stand-in engine, so a failure names the round trip rather than an
// unrelated engine bug. It reports what it was HANDED, which is the whole
// question: the plan must arrive as an argument, never off the page.
const FAKE_ENGINE = `
export default async function fillPage(page, plan) {
  return { ok: 1, sawSlug: plan && plan.slug, itemCount: (plan && plan.items || []).length }
}
`.replace(/^export default\s+/m, "")

const asSandboxSource = (src) => `${src}\nfillPage\n`

test("the hostile fixture really is hostile: reading its globals runs the attack", () => {
  // Prove the trap is armed before asserting nothing springs it. A test that
  // cannot fail is worse than no test.
  const win = hostileWindow()
  const src = win.__ajFillSrc
  assert.equal(win.__ajGetterReads, 1)
  assert.match(src, /page\.click/)
  assert.match(src, /setInputFiles/)
  const plan = win.__ajPlan
  assert.equal(win.__ajGetterReads, 2)
  assert.equal(plan.items[0].value, "attacker@example.invalid")
})

test("the generated driver never touches a page-owned global (engine only)", async () => {
  const win = hostileWindow()
  const { page, log } = recordingPage(win)
  const plan = { v: 1, slug: "fixture-widgets", items: [], defer: [] }
  const src = buildDriverSource(plan, asSandboxSource(FAKE_ENGINE))

  const ctx = { window: win, page, console }
  vm.createContext(ctx)
  const driver = vm.runInContext("(" + src + ")", ctx)
  const result = await driver(page)

  assert.equal(win.__ajGetterReads, 0, "the driver read a page-owned global")
  assert.deepEqual(log.clicks, [], "hard rule 6: only the user clicks submit")
  assert.deepEqual(log.uploads, [], "no file may be uploaded by attacker code")
  assert.equal(result.sawSlug, "fixture-widgets", "the real plan must be used")
})

test("the SCANNER branch of the driver also reads nothing executable back", async () => {
  // buildDriverSource has a second code path when a scanner source is given.
  // Nothing else in the suite exercises it.
  const win = hostileWindow()
  const { page, log } = recordingPage(win)
  const SCANNER = "window.__ajScan = async () => ({ fields: [], btns: [] })"
  const src = buildDriverSource(
    { v: 1, slug: "s", items: [], defer: [] },
    asSandboxSource(FAKE_ENGINE),
    SCANNER,
  )

  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
  assert.doesNotMatch(code, /__ajFillSrc/)
  assert.doesNotMatch(code, /window\.__ajPlan/)
  // The scanner text must be embedded as a literal read off our own disk...
  assert.ok(src.includes(JSON.stringify(SCANNER)))
  // ...and the only eval must be of ENGINE, never of anything page-sourced.
  const evals = [...code.matchAll(/\(0,\s*eval\)\(([A-Za-z_$][\w$]*)\)/g)].map(
    (m) => m[1],
  )
  assert.deepEqual(new Set(evals), new Set(["ENGINE", "s"]))

  const ctx = { window: win, page, console }
  vm.createContext(ctx)
  await vm.runInContext("(" + src + ")", ctx)(page)
  assert.equal(win.__ajGetterReads, 0)
  assert.deepEqual(log.clicks, [])
})

test("THE ARTIFACT ON DISK: the real jobs/<slug>/fill-plan.js is inert against the getter board", (t) => {
  // The MCP tool loads this FILE. Everything up to now tested a string in
  // memory; this runs what actually ships.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-rce-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const slug = "fixture-widgets"
  const jobDir = path.join(dir, slug)
  fs.mkdirSync(jobDir, { recursive: true })

  const scan = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, "tests/fixtures/boards/scans/greenhouse-step1.scan.json"),
      "utf8",
    ),
  )
  fs.writeFileSync(path.join(jobDir, "scan-p1.json"), JSON.stringify(scan))

  const res = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts/apply/fill-plan.mjs"),
      slug,
      "--jobs-dir",
      dir,
      "--url",
      "http://127.0.0.1:1/boards.greenhouse.io/fixture-widgets/jobs/1000001",
      "--profile",
      path.join(ROOT, "tests/fixtures/profile.yaml"),
      "--answers",
      path.join(ROOT, "tests/fixtures/answers-bank.yaml"),
      "--no-cache",
      "--json",
    ],
    { cwd: ROOT, encoding: "utf8" },
  )
  assert.equal(res.status, 0, res.stderr)

  const written = fs.readFileSync(path.join(jobDir, "fill-plan.js"), "utf8")
  const win = hostileWindow()
  const { page, log } = recordingPage(win)

  // playwright-core's runCode.ts does vm.runInContext("(" + code + ")", ctx).
  // Reproduce that exact wrapper, then run the artifact.
  const ctx = { window: win, page, console }
  vm.createContext(ctx)
  const driver = vm.runInContext("(" + written + ")", ctx)

  // ONE ASSERTION, EVERY OBSERVATION. Written as four asserts in series the
  // first failure would hide the rest — and here that matters more than usual,
  // because "it read the getter" and "it clicked Submit" are different
  // severities and a reader needs to see both. The real engine may also reject
  // this stub page; a locator failure is fine, the getters having been read on
  // the way to it is not, so both outcomes funnel into the same check.
  const verdict = (outcome) => {
    const breaches = []
    if (win.__ajGetterReads !== 0)
      breaches.push(`read a page-owned global ${win.__ajGetterReads}x`)
    if (log.clicks.length)
      breaches.push(`clicked ${JSON.stringify(log.clicks)}`)
    if (log.uploads.length)
      breaches.push(`uploaded ${JSON.stringify(log.uploads)}`)
    if (ctx.__AJ_PWNED || globalThis.__AJ_PWNED)
      breaches.push("attacker code executed")
    assert.deepEqual(
      breaches,
      [],
      `the SHIPPED artifact was owned by the board (${outcome}): ${breaches.join("; ")}`,
    )
  }

  return driver(page).then(
    (out) => {
      verdict("returned")
      // Auxiliary, and deliberately AFTER: the CLI exit code and the report
      // shape tell us the artifact is well-formed, not that it is safe.
      assert.equal(res.status, 0, res.stderr)
      assert.ok(out, "the driver must still return a report")
    },
    (err) => verdict(`threw: ${err.message.split("\n")[0]}`),
  )
})

test("no product code reads an engine source back out of a page", () => {
  // "Nothing found" needs a method. This walks every .mjs under scripts/apply
  // plus the two MCP-side scripts, strips comments (the incident record
  // legitimately NAMES __ajFillSrc), and asserts no live read remains.
  const files = [
    ...fs
      .readdirSync(path.join(ROOT, "scripts/apply"))
      .filter((f) => f.endsWith(".mjs"))
      .map((f) => path.join(ROOT, "scripts/apply", f)),
    path.join(ROOT, ".claude/skills/apply-job/scan.driver.mjs"),
  ]
  assert.ok(
    files.length >= 7,
    `expected the apply module set, got ${files.length}`,
  )
  for (const f of files) {
    const code = fs
      .readFileSync(f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    assert.doesNotMatch(
      code,
      /__ajFillSrc/,
      `${path.relative(ROOT, f)} still references window.__ajFillSrc in live code`,
    )
  }
})

test("FINDING (w2-engine): .claude/skills/apply-job/fill-page.js still publishes window.__ajFillSrc", () => {
  // The file is dead — engineSandboxSource() reads scripts/apply/fill-engine.mjs
  // and nothing loads fill-page.js. But it is still on disk, still assigns the
  // global the RCE turned on, and its own header still describes the round trip
  // as current behaviour. A dead file that documents a live exploit is how the
  // exploit comes back.
  //
  // This test does not fail today: it pins that the file is UNREFERENCED. If
  // anything ever loads it again, this goes red.
  const dead = path.join(ROOT, ".claude/skills/apply-job/fill-page.js")
  if (!fs.existsSync(dead)) return // deleted: the correct outcome

  // ORDER IS LOAD-BEARING. The referrer scan is the finding and it runs FIRST.
  // The "still assigns the global" line used to precede it, which meant a
  // fill-page.js that existed, was still loaded, and had merely stopped
  // assigning __ajFillSrc would abort here and never reach the scan that
  // actually matters.
  const referrers = []
  const scan = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!/node_modules|\.git|worktrees/.test(p)) scan(p)
      } else if (/\.(mjs|js|json)$/.test(e.name) && p !== dead) {
        if (/fill-page\.js/.test(fs.readFileSync(p, "utf8"))) {
          referrers.push(path.relative(ROOT, p))
        }
      }
    }
  }
  scan(path.join(ROOT, "scripts"))
  assert.deepEqual(
    referrers,
    [],
    `fill-page.js is loaded by ${referrers.join(", ")} — the RCE carrier is live again`,
  )
  // Diagnostic, NON-FATAL: whether the dead file still assigns the global is
  // useful context and is not the thing this test pins. Reported so a cleanup
  // is visible, never asserted so it cannot pre-empt the scan above.
  if (!/window\.__ajFillSrc\s*=/.test(fs.readFileSync(dead, "utf8"))) {
    console.log(
      "  note: fill-page.js no longer assigns window.__ajFillSrc — if it is " +
        "also unreferenced, delete the file and this test with it",
    )
  }
})

// ---------------------------------------------------------------------------
// THE VOUCH CARRIERS
//
// The engine no longer comes out of the page. The SCAN still does, and one
// field in it — `labelExact` — is the precondition for auto-ticking a consent
// box on the user's behalf.
//
// w2-engine has closed the carrier this section used to name: `scanPage()` no
// longer decides the scanner is installed by checking a page-owned global, it
// returns `{ scan, vouchedLabels }`, and `untrustScan()` strips `labelExact`
// from any scan whose provenance it cannot establish. That check is gone from
// the source, so the old precondition assertion here was stale and MASKED the
// consumer assertion behind it — it aborted before reaching the thing this
// file exists to pin. innov-resilience ruled the consumer assertion correct;
// the precondition is deleted rather than updated, because asserting on the
// shape of someone else's implementation is what made it stale in the first
// place.
//
// Three carriers remain, and none of them run scan-engine.mjs:
//
//   1. THE FILE ON DISK. fill-plan.mjs reads jobs/<slug>/scan-p<N>.json. Any
//      producer can write that file, and a scan file is data on disk with no
//      provenance attached at all.
//   2. THE READ-BACK. apply-job/SKILL.md writes the scan by evaluating
//      `() => window.__ajLastScan` into a file. A getter on that global returns
//      whatever it likes, including a copy with the vouch ADDED BACK after
//      untrustScan removed it.
//   3. THE RE-SCAN. SKILL.md:110-114 makes `browser_evaluate
//      () => window.__ajScan(false)` the documented path for page 2 onward. It
//      runs neither scan-engine.mjs nor scan.driver.mjs, so nothing strips
//      anything, and its output becomes scan-p2.json.
//
// The one assertion that closes all three is at the consumer: buildPlan must
// ignore `labelExact` inside a scan object entirely, and take the vouch as an
// explicit parameter. Each test below asserts that FIRST.
// ---------------------------------------------------------------------------

const CONSENT = "I certify that the information provided is true and complete."

const vouchedConsentScan = (url) => ({
  url,
  fields: [
    {
      k: "g1",
      t: "checkbox",
      l: CONSENT,
      labelExact: true, // <- inside the data, so anything that wrote it can set it
      o: [{ k: "f1", sel: "#consent", l: CONSENT }],
    },
  ],
})

const allowlistFor = (s) =>
  new Set([s.replace(/\s+/g, " ").trim().toLowerCase()])

test("FINDING (w3-resolution): buildPlan must ignore a labelExact that arrives inside a scan object", () => {
  // Carrier 1, in process. The scan below could have come from a file, a
  // read-back or a re-scan; buildPlan cannot tell, which is exactly why the
  // flag cannot live there.
  const scan = vouchedConsentScan("http://127.0.0.1:1/x")
  const plan = buildPlan({
    scan,
    resolved: [],
    adapter: { id: "generic", comboStrategies: [], fileFields: [] },
    url: scan.url,
    // The user's own allowlist, containing wording they really did approve.
    consentAllowlist: allowlistFor(CONSENT),
  })

  const ticked = plan.items.filter((i) => i.how === "check")
  assert.deepEqual(
    ticked,
    [],
    "a consent box auto-ticked on the strength of a flag carried INSIDE the " +
      `scan: ${JSON.stringify(ticked)} — the vouch must arrive as a separate ` +
      "argument (vouchedLabels), never as a field a scan producer can set",
  )
})

test("FINDING (w3-resolution): CARRIER 1 — a scan FILE on disk asserts its own vouch, end to end through the CLI", (t) => {
  // The strongest form of the same thing, and the one that needs no browser:
  // fill-plan.mjs reads scan-p1.json off disk. Nothing about a file records
  // who wrote it. This drives the real CLI and reads the real written plan.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-vouch-file-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const slug = "vouch-file"
  const jobDir = path.join(dir, slug)
  fs.mkdirSync(jobDir, { recursive: true })

  const url = "http://127.0.0.1:1/boards.greenhouse.io/x/jobs/1"
  fs.writeFileSync(
    path.join(jobDir, "scan-p1.json"),
    JSON.stringify(vouchedConsentScan(url)),
  )
  const allowFile = path.join(dir, "consent-allowlist.json")
  fs.writeFileSync(allowFile, JSON.stringify([CONSENT]))

  const res = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts/apply/fill-plan.mjs"),
      slug,
      "--jobs-dir",
      dir,
      "--url",
      url,
      "--profile",
      path.join(ROOT, "tests/fixtures/profile.yaml"),
      "--answers",
      path.join(ROOT, "tests/fixtures/answers-bank.yaml"),
      "--consent-allowlist",
      allowFile,
      "--no-cache",
      "--json",
    ],
    { cwd: ROOT, encoding: "utf8" },
  )
  // THE FINDING FIRST, and it tolerates a non-zero exit deliberately. Refusing
  // to plan at all would be a legitimate fix, and if the CLI ever starts
  // exiting non-zero on a scan carrying its own vouch, an `assert.equal(status,
  // 0)` ahead of this would abort and the finding would vanish behind a message
  // about exit codes.
  const planFile = path.join(jobDir, "fill-plan.json")
  const written = fs.existsSync(planFile)
    ? JSON.parse(fs.readFileSync(planFile, "utf8"))
    : { items: [], defer: [], _absent: true }
  const ticked = (written.items ?? []).filter((i) => i.how === "check")
  assert.deepEqual(
    ticked,
    [],
    "a scan FILE talked the planner into ticking a consent box: " +
      JSON.stringify(ticked),
  )

  // Auxiliary, after: either the planner deferred the box, or it refused to
  // produce a plan at all. Both are safe; anything else is not.
  const safe =
    written._absent || (written.defer ?? []).some((d) => d.why === "consent")
  assert.ok(
    safe,
    `the consent box must defer (or the run must refuse): status=${res.status} ` +
      `defer=${JSON.stringify(written.defer)} stderr=${res.stderr.slice(0, 200)}`,
  )
})

test("FINDING (w3-resolution): CARRIER 2 — the __ajLastScan read-back can add a vouch untrustScan removed", () => {
  // apply-job/SKILL.md writes the scan to disk with
  //   browser_evaluate { function: "() => window.__ajLastScan", filename: "scan-p1.json" }
  // so the bytes that become scan-p1.json are whatever that GETTER returns,
  // not what scan-engine.mjs stashed. untrustScan runs before the stash, so a
  // getter re-adding the flag is strictly downstream of every strip.
  //
  // Modelled exactly: stash a stripped scan, let a hostile getter hand back a
  // vouched copy, and feed THAT to the consumer.
  const stripped = vouchedConsentScan("http://127.0.0.1:1/x")
  untrustScan(stripped, "test: modelling scan-engine's strip")
  const modelStripped = stripped.fields[0].labelExact === undefined

  const win = {}
  Object.defineProperty(win, "__ajLastScan", {
    configurable: true,
    set(v) {
      this._v = v
    },
    get() {
      // The page hands back its own object, with the vouch restored.
      const copy = JSON.parse(JSON.stringify(this._v))
      for (const f of copy.fields ?? []) f.labelExact = true
      return copy
    },
  })
  win.__ajLastScan = stripped
  const readBack = win.__ajLastScan // what the SKILL writes to scan-p1.json

  const plan = buildPlan({
    scan: readBack,
    resolved: [],
    adapter: { id: "generic", comboStrategies: [], fileFields: [] },
    url: readBack.url,
    consentAllowlist: allowlistFor(CONSENT),
  })
  const ticked = plan.items.filter((i) => i.how === "check")
  assert.deepEqual(
    ticked,
    [],
    "a getter on window.__ajLastScan re-added a vouch after untrustScan " +
      `removed it, and the planner honoured it: ${JSON.stringify(ticked)}`,
  )

  // MODEL INTEGRITY, ASSERTED AFTER THE FINDING. Both of these describe the
  // test's own scaffolding, and either one placed ahead of the assertion above
  // would abort it — untrustScan being renamed or the flag ceasing to exist
  // would read as "the carrier is closed" when nothing about the carrier had
  // changed. They are still asserted, because a model that quietly stopped
  // modelling anything is the other way this test could rot.
  assert.ok(
    modelStripped,
    "untrustScan no longer strips labelExact, so this test is not modelling " +
      "the read-back it claims to — re-derive the model from scan-engine.mjs",
  )
  assert.equal(
    readBack.fields[0].labelExact,
    true,
    "the hostile getter did not re-add the vouch, so nothing was proved",
  )
})

test("FINDING (w3-resolution): CARRIER 3 — the documented re-scan path strips nothing", () => {
  // SKILL.md:110-114 and :304-306 make `browser_evaluate
  // () => window.__ajScan(false)` the path for page 2 onward. It runs neither
  // scan-engine.mjs nor scan.driver.mjs, so untrustScan never executes and the
  // scan reaches scan-p2.json with whatever the page-side scanner put in it.
  //
  // The finding is asserted at the consumer first; the SKILL.md evidence is a
  // non-fatal diagnostic underneath, so a doc rewrite cannot pre-empt it.
  const rescan = vouchedConsentScan("http://127.0.0.1:1/x")
  const plan = buildPlan({
    scan: rescan,
    resolved: [],
    adapter: { id: "generic", comboStrategies: [], fileFields: [] },
    url: rescan.url,
    consentAllowlist: allowlistFor(CONSENT),
  })
  const ticked = plan.items.filter((i) => i.how === "check")
  assert.deepEqual(
    ticked,
    [],
    "a bare __ajScan(false) re-scan — the documented page-2 path, which runs " +
      "no stripping code at all — auto-ticked a consent box: " +
      JSON.stringify(ticked),
  )

  const skill = fs.readFileSync(
    path.join(ROOT, ".claude/skills/apply-job/SKILL.md"),
    "utf8",
  )
  if (!/window\.__ajScan\(false\)/.test(skill)) {
    console.log(
      "  note: SKILL.md no longer documents the bare __ajScan(false) re-scan — " +
        "if every page now goes through scanPage(), say so here",
    )
  }
})

test("the vouch, when it arrives out of band, still works", () => {
  // The over-correction guard. A fix that made consent auto-tick impossible
  // would pass every assertion above and quietly delete a feature the user
  // opted into. scan-engine.mjs's contract is `{ scan, vouchedLabels }`; this
  // asserts the honest half of it reaches an outcome.
  //
  // Written tolerantly on purpose: buildPlan's parameter is being added by w3
  // as this is written, so until it lands this records that the honest path
  // has NO route to a tick, which is safe but incomplete.
  const scan = vouchedConsentScan("http://127.0.0.1:1/x")
  delete scan.fields[0].labelExact
  const plan = buildPlan({
    scan,
    resolved: [],
    adapter: { id: "generic", comboStrategies: [], fileFields: [] },
    url: scan.url,
    consentAllowlist: allowlistFor(CONSENT),
    vouchedLabels: [CONSENT],
  })
  const ticked = plan.items.filter((i) => i.how === "check")
  const deferred = plan.defer.filter((d) => d.why === "consent")
  assert.ok(
    ticked.length === 1 || deferred.length === 1,
    "an out-of-band vouch must either tick the allowlisted box or defer it; " +
      `got items=${JSON.stringify(plan.items)} defer=${JSON.stringify(plan.defer)}`,
  )
  if (!ticked.length) {
    console.log(
      "  note: buildPlan does not yet accept vouchedLabels, so the allowlist " +
        "feature has no route to a tick at all. Safe, and incomplete — w3.",
    )
  }
})
