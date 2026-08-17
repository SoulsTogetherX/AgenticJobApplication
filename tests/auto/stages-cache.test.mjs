// THE UNATTENDED PATH LEARNS, AND WHAT IT LEARNS NEVER CHANGES AN ANSWER.
//
// Phase 4 (2026-08-14). Until this landed the runner did not participate in
// the field cache at all: stages.mjs's plan() never loaded, applied or
// recorded, and recordVia's only caller was a CLI flag nobody ran. Every
// dropdown was re-probed and every combo strategy re-discovered on every
// application — 1.5-2.5s per combo, measured — and jobs/.field-cache.json's
// `via`/`comboStrategy` columns stayed empty across 21 remembered forms.
//
// This is the standing END-TO-END smoke for the browser leg: a real Chromium,
// a real loopback page, the real scan → plan → fill stages the runner uses,
// twice. The first application is COLD and must write what it learned; the
// second is WARM and must be served it. And the one assertion that matters
// more than the rest: the warm plan resolves the SAME items to the SAME
// values as the cold one. The cache supplies the SHAPE of a form — options,
// a selector, a strategy hint. It never supplies an answer. If a cache hit
// ever changed a value, that would be rule 1 broken by an optimisation.
//
// WHY THIS PAGE AND NOT A BOARD FIXTURE. Every combo in tests/fixtures/boards/
// pages/ is a static menu toggled with `hidden` and no script — right for what
// those pages pin (the scanner invents nothing; probing costs a click), useless
// for learning: the menu never opens, so the probe reads no options and the
// fill has nothing to set. The widget below is the CLICK_ONLY_COMBO shape from
// tests/apply/fill-page.test.mjs — opens on click, commits on an option click,
// typing and Enter do nothing — the board on which type-enter loses and
// type-click wins, so "remember what won" is observable as a reorder. Served
// from a loopback server rather than page.setContent so the stages see a real
// URL: detectAts() picks the Greenhouse adapter off the path and fingerprint()
// hashes a real host, exactly as on a live application.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { fileURLToPath } from "node:url"

import { launchBrowser } from "../../scripts/apply/browser.mjs"
import { makeStages } from "../../scripts/auto/stages.mjs"
import { loadCache, CACHE_VERSION } from "../../scripts/apply/field-cache.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const PROFILE = path.join(ROOT, "tests/fixtures/profile.yaml")
const ANSWERS = path.join(ROOT, "tests/fixtures/answers-bank.yaml")

// The fixture bank answers "How did you hear about this job?" with "Job
// Board" (a-005) — an option this widget offers, so the combo resolves to a
// plan item on both runs. Everything else is what the fixture profile answers.
const COMBO_LABEL = "How did you hear about this job?"
const COMBO_OPTS = ["Job Board", "Referral", "Recruiter"]

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title></head>
<body><h1>Fixture Engineer</h1>
<form id="application_form">
  <div class="field"><label for="first_name">First Name <span>*</span></label>
    <input id="first_name" name="first_name" required></div>
  <div class="field"><label for="last_name">Last Name <span>*</span></label>
    <input id="last_name" name="last_name" required></div>
  <div class="field"><label for="email">Email <span>*</span></label>
    <input id="email" type="email" name="email" required></div>
  <div class="field">
    <div id="hear-label" class="label">${COMBO_LABEL} <span>*</span></div>
    <div id="hear" class="select__control" role="combobox" aria-haspopup="listbox"
         aria-labelledby="hear-label" aria-required="true" tabindex="0">
      <div class="select__placeholder">Select...</div>
    </div>
    <div id="hear-menu" class="select__menu" hidden>
      ${COMBO_OPTS.map((o) => `<div class="select__option">${o}</div>`).join("")}
    </div>
  </div>
  <button type="submit" id="submit_app">Submit Application</button>
</form>
<script>
  var ctl = document.getElementById('hear'), menu = document.getElementById('hear-menu');
  // Opens, never toggles, closes on Escape — react-select's actual behaviour.
  ctl.addEventListener('click', function () { menu.hidden = false; });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') menu.hidden = true; });
  menu.addEventListener('click', function (e) {
    if (!e.target.classList.contains('select__option')) return;
    ctl.innerHTML = '<div class="select__single-value">' + e.target.textContent + '</div>';
    menu.hidden = true;
  });
</script></body></html>`

const NO_BROWSER = await (async () => {
  try {
    const s = await launchBrowser({ headless: true })
    await s.close()
    return null
  } catch (e) {
    return "no usable Chromium: " + String(e.message).slice(0, 90)
  }
})()

function serve() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(PAGE)
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      resolve({
        // The board host IN THE PATH is the fixture-server convention
        // (tests/fixtures/boards/server.mjs): detectAts() matches the
        // Greenhouse adapter on `greenhouse.io` anywhere in the URL, so a
        // loopback page can wear the adapter without pretending to be the
        // host — fingerprint() still hashes 127.0.0.1.
        url: (slug) =>
          `http://127.0.0.1:${port}/boards.greenhouse.io/fixture/jobs/${slug}`,
        stop: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

function sandbox(t, slugs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aj-stages-cache-"))
  const jobsDir = path.join(dir, "jobs")
  for (const slug of slugs) {
    fs.mkdirSync(path.join(jobsDir, slug), { recursive: true })
    for (const name of ["resume.pdf", "cover-letter.pdf"])
      fs.writeFileSync(path.join(jobsDir, slug, name), "%PDF-1.4 fixture\n")
  }
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* a leaked handle must not fail an assertion that already passed */
    }
  })
  return { dir, jobsDir }
}

// The plan's ANSWERS, stripped of the two things the cache is allowed to
// touch: `via` (the strategy hint) and nothing else. Everything left — key,
// verb, label, value(s) — must be identical cold and warm.
const answersOf = (plan) => plan.items.map(({ via, ...rest }) => rest)

test("cold application writes fp/opts/via; warm application is served them; answers identical", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const SLUGS = ["fixture-job-cold", "fixture-job-warm"]
  const s = sandbox(t, SLUGS)
  const site = await serve()
  t.after(() => site.stop())
  const session = await launchBrowser({ headless: true, localOnly: true })
  t.after(() => session.close())

  const stages = makeStages({
    jobsDir: s.jobsDir,
    profilePath: PROFILE,
    answersPath: ANSWERS,
  })

  const apply = async (slug) => {
    const url = site.url(slug)
    await session.goto(url)
    const scan = await stages.scan(session.page, { url })
    const plan = await stages.plan({
      scan,
      url,
      job: { slug },
      documents: { slug },
    })
    const t0 = Date.now()
    const report = await stages.fill(session.page, plan)
    return { scan, plan, report, fillMs: Date.now() - t0 }
  }

  // ---- COLD -----------------------------------------------------------------
  const cold = await apply(SLUGS[0])
  assert.match(
    cold.plan.fp,
    /^[0-9a-f]{16}$/,
    "the plan carries its fingerprint",
  )
  assert.equal(
    cold.plan.ats,
    "greenhouse",
    "the Greenhouse adapter, off the path",
  )
  assert.equal(
    cold.scan.probe.probed,
    1,
    "cold: the one combo was probed live " + JSON.stringify(cold.scan.probe),
  )
  const comboField = cold.scan.fields.find((f) => f.t === "combo")
  assert.deepEqual(comboField.opts, COMBO_OPTS, "the probe read the menu")

  const coldItem = cold.plan.items.find((i) => i.how === "combo")
  assert.ok(
    coldItem,
    "the combo resolved to a plan item: " + JSON.stringify(cold.plan.defer),
  )
  assert.equal(coldItem.value, "Job Board")
  assert.equal(coldItem.via, undefined, "cold: no strategy hint yet")
  assert.deepEqual(
    cold.plan.comboStrategies,
    ["type-enter", "type-click", "click-option"],
    "cold: the adapter's default order",
  )
  assert.equal(cold.report.failed, 0, JSON.stringify(cold.report.failures))
  assert.equal(
    cold.report.comboVia[coldItem.k],
    "type-click",
    "type-enter loses on this widget; type-click wins and is reported",
  )
  assert.equal(cold.report.comboStrategy, "type-click")

  // What the cold run wrote. Both plan() (shape) and fill() (via) went through
  // updateCache, and the file is at the current version with no discard.
  const cacheFile = path.join(s.jobsDir, ".field-cache.json")
  const cache = loadCache(cacheFile)
  assert.equal(cache.v, CACHE_VERSION)
  assert.equal(cache.discarded, undefined)
  const entry = cache.forms[cold.plan.fp]
  assert.ok(entry, "an entry under the plan's fingerprint")
  assert.equal(entry.ats, "greenhouse")
  const key = `${COMBO_LABEL.toLowerCase()} *|combo`
  const remembered =
    entry.fields[key] ??
    entry.fields[Object.keys(entry.fields).find((k) => k.endsWith("|combo"))]
  assert.ok(
    remembered,
    "the combo's shape was recorded: " + Object.keys(entry.fields),
  )
  assert.deepEqual(remembered.opts, COMBO_OPTS, "its options were remembered")
  assert.equal(remembered.via, "type-click", "and the strategy that won it")
  assert.equal(entry.comboStrategy, "type-click", "and the board-level winner")
  assert.equal(
    fs.existsSync(cacheFile + ".lock"),
    false,
    "the cache lock was released",
  )

  // ---- WARM (a different job, same form) ------------------------------------
  const warm = await apply(SLUGS[1])
  assert.equal(warm.plan.fp, cold.plan.fp, "same form, same fingerprint")
  const warmItem = warm.plan.items.find((i) => i.how === "combo")
  assert.equal(warmItem.via, "type-click", "warm: the per-field hint is served")
  assert.deepEqual(
    warm.plan.comboStrategies,
    ["type-click", "type-enter", "click-option"],
    "warm: the remembered winner is promoted to the head",
  )

  // THE TRIPWIRE. Same items, same values, same deferrals. Only `via` differs.
  assert.deepEqual(
    answersOf(warm.plan),
    answersOf(cold.plan),
    "learning must never change an answer",
  )
  assert.deepEqual(
    warm.plan.defer.map((d) => d.label),
    cold.plan.defer.map((d) => d.label),
    "the deferred set is identical",
  )
  assert.equal(warm.report.failed, 0, JSON.stringify(warm.report.failures))
  assert.equal(warm.report.comboVia[warmItem.k], "type-click")

  // The 0.12 sidecar got one line per application, and nothing else moved.
  const history = fs
    .readFileSync(path.join(s.jobsDir, ".shape-history.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
  assert.equal(history.length, 2, "one shape-history line per application")

  // Reported, not asserted: the warm fill skips the losing type-enter attempt.
  // Timings on a shared box are not evidence (the contention gotcha), so this
  // is a number for the log rather than a gate.
  console.log(
    `  stages-cache: fill cold=${cold.fillMs}ms warm=${warm.fillMs}ms ` +
      `(cold order tries type-enter first and loses; warm starts on type-click)`,
  )
})

test("a cache that cannot be written never fails the plan — reported, then cold", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const s = sandbox(t, ["fixture-job-nocache"])
  // A DIRECTORY where the cache file should be: loadCache reads it as
  // unreadable (audible discard, starts clean) and updateCache's save cannot
  // replace it. The plan must still come back whole.
  fs.mkdirSync(path.join(s.jobsDir, ".field-cache.json"))
  const site = await serve()
  t.after(() => site.stop())
  const session = await launchBrowser({ headless: true, localOnly: true })
  t.after(() => session.close())
  const stages = makeStages({
    jobsDir: s.jobsDir,
    profilePath: PROFILE,
    answersPath: ANSWERS,
  })
  const url = site.url("fixture-job-nocache")
  await session.goto(url)
  const scan = await stages.scan(session.page, { url })
  const warned = []
  const orig = console.error
  console.error = (...a) => warned.push(a.join(" "))
  let plan
  try {
    plan = await stages.plan({
      scan,
      url,
      job: { slug: "fixture-job-nocache" },
      documents: { slug: "fixture-job-nocache" },
    })
  } finally {
    console.error = orig
  }
  assert.ok(
    plan.items.some((i) => i.how === "combo"),
    "the plan is whole",
  )
  assert.match(plan.fp, /^[0-9a-f]{16}$/, "and still carries its fingerprint")
  assert.ok(
    warned.some((w) => /field cache not updated/.test(w)),
    "the failure was reported, not swallowed: " + JSON.stringify(warned),
  )
})
