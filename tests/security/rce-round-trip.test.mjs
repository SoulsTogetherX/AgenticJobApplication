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

  return driver(page).then(
    (out) => {
      assert.equal(
        win.__ajGetterReads,
        0,
        "the shipped artifact read a page-owned global",
      )
      assert.deepEqual(log.clicks, [], "the shipped artifact clicked something")
      assert.deepEqual(
        log.uploads,
        [],
        "the shipped artifact uploaded something",
      )
      assert.ok(!ctx.__AJ_PWNED && !globalThis.__AJ_PWNED, "attacker code ran")
      assert.ok(out, "the driver must still return a report")
    },
    (err) => {
      // The real engine needs a real page; a locator failure is fine. What is
      // NOT fine is the getters having been read on the way to that failure.
      assert.equal(
        win.__ajGetterReads,
        0,
        `getter read before failing: ${err.message}`,
      )
      assert.deepEqual(log.clicks, [])
      assert.deepEqual(log.uploads, [])
    },
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

  assert.match(
    fs.readFileSync(dead, "utf8"),
    /window\.__ajFillSrc\s*=/,
    "if this stops matching the file was cleaned up and this test can go",
  )

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
})

test("FINDING (w2-engine): a board that pre-defines window.__ajScan supplies the whole scan", () => {
  // The ENGINE no longer comes out of the page. The SCAN still does, and the
  // scan decides everything downstream.
  //
  //   scan-engine.mjs:66  const ready = await page.evaluate(
  //                         () => typeof window.__ajScan === "function")
  //                       if (!ready) { ...install the real scanner... }
  //   scan-engine.mjs:92  let scan = await page.evaluate(() => window.__ajScan(false))
  //
  // A board that defines __ajScan before the runner arrives is "ready", so the
  // real scanner is NEVER INSTALLED and line 92 calls the board's function.
  // Every field key, label, selector and flag in the scan is then chosen by
  // the board.
  //
  // The consumer assertion is the point. buildPlan() trusts one flag in that
  // scan — f.labelExact — as the precondition for auto-ticking a consent box,
  // and the whole reason auto-tick is disabled today is that the scanner does
  // not set it. A page-supplied scanner sets whatever it likes.
  const src = fs.readFileSync(
    path.join(ROOT, "scripts/apply/scan-engine.mjs"),
    "utf8",
  )
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
  assert.match(
    code,
    /typeof window\.__ajScan === "function"/,
    "if this is gone the presence check was replaced — re-read this test",
  )

  const CONSENT =
    "I certify that the information provided is true and complete."
  const hostileScan = {
    url: "http://127.0.0.1:1/x",
    fields: [
      {
        k: "g1",
        t: "checkbox",
        l: CONSENT,
        labelExact: true, // <- asserted by the PAGE, not by our scanner
        o: [{ k: "f1", sel: "#consent", l: CONSENT }],
      },
    ],
  }
  const plan = buildPlan({
    scan: hostileScan,
    resolved: [],
    adapter: { id: "generic", comboStrategies: [], fileFields: [] },
    url: hostileScan.url,
    // The user's own allowlist, containing wording they really did approve.
    consentAllowlist: new Set([
      CONSENT.replace(/\s+/g, " ").trim().toLowerCase(),
    ]),
  })

  const ticked = plan.items.filter((i) => i.how === "check")
  assert.deepEqual(
    ticked,
    [],
    "a consent box auto-ticked on the strength of a flag the PAGE set: " +
      JSON.stringify(ticked) +
      " — labelExact must be asserted by our scanner, never accepted from the page",
  )
})
