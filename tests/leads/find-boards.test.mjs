// find-boards turns company NAMES into {type, slug} board candidates.
//
// It never adds anything to the sweep: output goes to a candidates file that
// discover-boards.mjs then yield-gates, and only the user adds a board via
// manage-sources. These tests cover the slug generation, which is the part that
// decides whether a company is findable at all.
import test from "node:test"
import assert from "node:assert/strict"
import { slugsFor, PROBES } from "../../src/leads/find-boards.mjs"

test("a one-word company yields its own name", () => {
  assert.ok(slugsFor("Vercel").includes("vercel"))
})

test("a multi-word company yields squashed, dashed and first-word forms", () => {
  const s = slugsFor("Acme Widgets")
  assert.ok(s.includes("acmewidgets"))
  assert.ok(s.includes("acme-widgets"))
  assert.ok(s.includes("acme"))
})

test("corporate suffixes are stripped — no ATS slug contains them", () => {
  const s = slugsFor("Everi Holdings, Inc.")
  assert.ok(s.includes("everi"), `expected "everi" in ${s.join(",")}`)
  assert.ok(!s.some((x) => x.includes("inc")))
  assert.ok(!s.some((x) => x.includes("holdings")))
})

test("ampersands do not leak into a slug", () => {
  const s = slugsFor("Fanatics Betting & Gaming")
  assert.ok(!s.some((x) => x.includes("&")))
  assert.ok(s.includes("fanaticsbettinggaming"))
})

test("an initialism is offered, which is how short slugs like AGS resolve", () => {
  assert.ok(slugsFor("Applied Gaming Solutions").includes("ags"))
})

test("slugs are unique and never single characters", () => {
  const s = slugsFor("A B")
  assert.equal(new Set(s).size, s.length)
  assert.ok(s.every((x) => x.length >= 2))
})

test("an empty or junk name yields nothing rather than probing garbage", () => {
  assert.deepEqual(slugsFor(""), [])
  assert.deepEqual(slugsFor("   "), [])
  assert.deepEqual(slugsFor("Inc."), [])
  assert.deepEqual(slugsFor(null), [])
})

test("every probe declares a URL builder and a job counter", () => {
  assert.ok(PROBES.length >= 6, "the six no-auth ATS APIs")
  for (const p of PROBES) {
    assert.ok(p.type, "probe needs a type")
    assert.match(
      p.url("acme"),
      /^https:\/\//,
      `${p.type} must build an https URL`,
    )
    assert.ok(p.url("acme").includes("acme"), `${p.type} must use the slug`)
    assert.equal(typeof p.count, "function")
  }
})

test("probe counters read zero from an empty or malformed response", () => {
  // A board that exists but has no open roles must not be reported as a hit.
  for (const p of PROBES) {
    assert.equal(p.count({}) || 0, 0, `${p.type} should count 0 for {}`)
    assert.equal(p.count(null) || 0, 0, `${p.type} should count 0 for null`)
  }
})

test("probe counters read a positive count from a populated response", () => {
  const shapes = {
    greenhouse: { jobs: [1, 2] },
    lever: [1, 2],
    ashby: { jobs: [1, 2] },
    smartrecruiters: { totalFound: 2 },
    workable: { jobs: [1, 2] },
    recruitee: { offers: [1, 2] },
  }
  for (const p of PROBES) {
    assert.equal(p.count(shapes[p.type]), 2, `${p.type} should count 2`)
  }
})
