// Walking a multi-page application form (§4.2c, Phase 5 W3).
//
// The check W3 names: "a form whose page-3 fields are unresolvable ABANDONS THE
// DRAFT EXPLICITLY rather than leaving a partial record". Most of this file is
// that one sentence taken apart — when a draft exists at all, what happens when
// nothing can discard it, and the invariant that no page past a deferring one
// is ever filled.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  walkPages,
  mergePages,
  abandonDraft,
  DRAFT_ABANDONERS,
  MAX_PAGES,
} from "../../scripts/auto/multipage.mjs"
import { authorizeSubmit, planSha256 } from "../../scripts/auto/authorize.mjs"
import { openDb } from "../../scripts/lib/db.mjs"

const APPLY_URL = "https://boards.greenhouse.io/acme/jobs/1"

// REAL tokens, minted the only way one can be. A stub shaped like a token is
// exactly what advanceOnce refuses, so a test that used one would prove the
// walk works against an authorization the runner could never actually hold.
function minter() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aj-multipage-"))
  const dbFile = path.join(dir, "leads.db")
  const stopPath = path.join(dir, "STOP")
  openDb(dbFile).close()
  return (plan, planSha, mode = "live") =>
    authorizeSubmit({
      lead: { slug: "acme-dev", company: "Acme", apply_url: APPLY_URL },
      plan,
      planSha,
      config: {
        enabled: true,
        dry_run: mode !== "live",
        per_run_max: 99,
        per_day_max: 99,
        per_company_max_per_week: 99,
        board_allowlist: { "boards.greenhouse.io": "greenhouse" },
      },
      trustVerdict: { ok: true, reason: "allowlisted" },
      screening: { verdict: "pass", findings: [] },
      dbFile,
      stopPath,
    })
}

// The real hasher. authorizeSubmit refuses anything that is not a 64-char
// sha256 hex digest — "an unbound token authorises any plan" — so a made-up
// stand-in would never reach the code under test.
const sha = planSha256

/** A form of N pages. Page `deferAt` (1-based) defers instead of resolving. */
function form({ pages = 1, deferAt = null, lastHasSubmit = true } = {}) {
  let current = 1
  const filled = []
  const clicked = []
  const page = {
    url: () => APPLY_URL,
    locator: () => ({
      async click() {
        clicked.push(current)
        current += 1
      },
    }),
    async waitForLoadState() {},
  }
  return {
    page,
    filled,
    clicked,
    get current() {
      return current
    },
    scanStage: async () => ({
      buttons:
        current < pages
          ? [{ k: `next${current}`, l: "Save and Continue", r: "next" }]
          : lastHasSubmit
            ? [{ k: "sub", l: "Submit application", r: "submit" }]
            : [],
    }),
    planStage: async ({ page: n }) => ({
      v: 1,
      items: [{ k: `f${n}`, how: "fill", value: `page ${n}` }],
      defer: n === deferAt ? [{ k: `d${n}`, why: "needs a human" }] : [],
    }),
    fillStage: async (_p, plan, { page: n }) => {
      filled.push(n)
      return { uploads: n === 1 ? [{ k: "resume", ok: true }] : [] }
    },
  }
}

const mint = minter()
const mintOk = async (planSha, { plan }) => mint(plan, planSha)
const mintDry = async (planSha, { plan }) => mint(plan, planSha, "dry_run")

const walk = (f, over = {}) =>
  walkPages(f.page, {
    slug: "acme-dev",
    mode: "live",
    board: "greenhouse",
    url: APPLY_URL,
    scanStage: f.scanStage,
    planStage: f.planStage,
    fillStage: f.fillStage,
    mintToken: mintOk,
    planSha256: sha,
    ...over,
  })

// --- the ordinary shapes ------------------------------------------------------

test("a single-page form is one page and never advances", async () => {
  const f = form({ pages: 1 })
  const got = await walk(f)
  assert.equal(got.ok, true)
  assert.equal(got.pages.length, 1)
  assert.deepEqual(f.clicked, [], "nothing was clicked")
})

test("a four-page form resolves every page, in order, before submitting", async () => {
  const f = form({ pages: 4 })
  const got = await walk(f)
  assert.equal(got.ok, true)
  assert.equal(got.pages.length, 4)
  assert.deepEqual(f.filled, [1, 2, 3, 4])
  assert.deepEqual(f.clicked, [1, 2, 3], "three advances, never a fourth")
})

test("the merged plan carries EVERY page's items, tagged with their page", async () => {
  // A token bound to only the last page would authorise a submit whose earlier
  // pages nothing checked.
  const f = form({ pages: 3 })
  const got = await walk(f)
  assert.deepEqual(
    got.plan.items.map((i) => i.page),
    [1, 2, 3],
  )
  assert.equal(got.plan.pages, 3)
  assert.deepEqual(got.plan.defer, [])
  assert.equal(
    got.report.uploads.length,
    1,
    "and the report's uploads, which is what submitReadiness reads",
  )
})

// --- W3's named check ----------------------------------------------------------

test("page 3 unresolvable ABANDONS THE DRAFT rather than walking away", async () => {
  const f = form({ pages: 4, deferAt: 3 })
  const got = await walk(f)
  assert.equal(got.ok, false)
  assert.match(got.reason, /page 3 deferred/)
  assert.ok(got.abandonment, "a draft exists, so its fate must be reported")
  assert.equal(
    got.abandonment.abandoned,
    false,
    "no production board offers a discard path",
  )
  assert.match(got.abandonment.how, /partial application may be sitting/)
  assert.match(got.abandonment.how, /acme-dev/)
})

test("page 4 is NEVER filled once page 3 defers", async () => {
  // The invariant that replaces "resolve everything first": advancing past a
  // page that needed a human puts more of the user's data into a form that is
  // never going to be submitted.
  const f = form({ pages: 4, deferAt: 3 })
  await walk(f)
  assert.deepEqual(f.filled, [1, 2, 3])
  assert.deepEqual(f.clicked, [1, 2], "and it did not advance off page 3")
})

test("a page-1 defer reports NO abandonment — there is no draft to discard", async () => {
  // Reporting one would be telling the user about something that is not there.
  const f = form({ pages: 4, deferAt: 1 })
  const got = await walk(f)
  assert.equal(got.ok, false)
  assert.equal(got.abandonment, null)
  assert.deepEqual(f.clicked, [])
})

test("a board WITH a discard path uses it, and says so", async () => {
  const calls = []
  DRAFT_ABANDONERS.set("fixture", async (_p, { slug }) => calls.push(slug))
  try {
    const f = form({ pages: 3, deferAt: 2 })
    const got = await walk(f, { board: "fixture" })
    assert.equal(got.abandonment.abandoned, true)
    assert.match(got.abandonment.how, /discarded via the fixture adapter/)
    assert.deepEqual(calls, ["acme-dev"])
  } finally {
    DRAFT_ABANDONERS.delete("fixture")
  }
})

test("a discard that THROWS is reported, not swallowed", async () => {
  DRAFT_ABANDONERS.set("fixture", async () => {
    throw new Error("the discard button moved")
  })
  try {
    const f = form({ pages: 3, deferAt: 2 })
    const got = await walk(f, { board: "fixture" })
    assert.equal(got.abandonment.abandoned, false)
    assert.match(
      got.abandonment.how,
      /discard failed: the discard button moved/,
    )
  } finally {
    DRAFT_ABANDONERS.delete("fixture")
  }
})

test("abandonDraft never throws, whatever the adapter does", async () => {
  DRAFT_ABANDONERS.set("boom", async () => {
    throw new Error("x")
  })
  try {
    const got = await abandonDraft({}, { board: "boom", slug: "s", why: "w" })
    assert.equal(got.abandoned, false)
    assert.ok(got.how)
  } finally {
    DRAFT_ABANDONERS.delete("boom")
  }
})

// --- the loop bound ------------------------------------------------------------

test("a board that always offers Next is a loop, and is bounded", async () => {
  const f = form({ pages: 999 })
  const got = await walk(f, { maxPages: 4 })
  assert.equal(got.ok, false)
  assert.equal(got.kind, "multipage-unresolvable")
  assert.match(got.reason, /a loop rather than a form/)
  assert.equal(f.filled.length, 4, "and it stopped filling at the bound")
  assert.ok(got.abandonment, "the draft it left is reported")
})

test("MAX_PAGES is a real bound, not documentation", async () => {
  const f = form({ pages: 999 })
  const got = await walk(f)
  assert.equal(got.ok, false)
  assert.equal(f.filled.length, MAX_PAGES)
})

// --- a page that is neither advanceable nor terminal ---------------------------

test("a mid-form page with no next AND no submit is unresolvable", async () => {
  // The form went somewhere nothing understands. Guessing what to click is
  // exactly the judgement this path does not make.
  const f = form({ pages: 3, lastHasSubmit: false })
  // Force the middle page to offer nothing.
  const scanStage = async () =>
    f.current === 2 ? { buttons: [] } : f.scanStage()
  const got = await walk(f, { scanStage })
  assert.equal(got.ok, false)
  assert.equal(got.kind, "multipage-unresolvable")
  assert.match(got.reason, /neither a 'next' control nor a 'submit' one/)
})

test("a SINGLE page with no controls at all is a complete form, not a failure", async () => {
  // The boundary the test above must not swallow: page 1 with no next control
  // is every single-page form in existence, whether or not the scan found the
  // submit.
  const f = form({ pages: 1, lastHasSubmit: false })
  const got = await walk(f)
  assert.equal(got.ok, true)
  assert.equal(got.pages.length, 1)
})

// --- authorisation, per page ---------------------------------------------------

test("a token is minted PER PAGE, so a brake mid-form stops it there", async () => {
  const minted = []
  const f = form({ pages: 4 })
  await walk(f, {
    mintToken: async (planSha, ctx) => {
      minted.push(ctx.page)
      return mintOk(planSha, ctx)
    },
  })
  assert.deepEqual(minted, [1, 2, 3], "one per transition, never for the last")
})

test("a refused mid-form authorisation stops the walk and abandons the draft", async () => {
  const f = form({ pages: 4 })
  const got = await walk(f, {
    mintToken: async (planSha, ctx) =>
      ctx.page >= 3
        ? { deferred: true, reason: "stop_switch: the user pulled the brake" }
        : mintOk(planSha, ctx),
  })
  assert.equal(got.ok, false)
  assert.match(got.reason, /page 3 could not be authorised/)
  assert.match(got.reason, /the user pulled the brake/)
  assert.ok(got.abandonment)
  assert.deepEqual(f.filled, [1, 2, 3], "and page 4 was never touched")
})

test("a mintToken that returns nothing is a refusal, not a pass", async () => {
  const f = form({ pages: 2 })
  const got = await walk(f, { mintToken: async () => null })
  assert.equal(got.ok, false)
  assert.match(got.reason, /no token was minted/)
  assert.deepEqual(f.clicked, [])
})

// --- dry run --------------------------------------------------------------------

test("dry run resolves page 1 and reports that it did not advance", async () => {
  // Nothing is clicked, so there is no page 2 to read. Reporting `ok` with one
  // page is honest; pretending the form was walked would not be.
  const f = form({ pages: 3 })
  const got = await walkPages(f.page, {
    slug: "acme-dev",
    mode: "dry_run",
    url: APPLY_URL,
    scanStage: f.scanStage,
    planStage: f.planStage,
    fillStage: f.fillStage,
    mintToken: mintDry,
    planSha256: sha,
  })
  assert.equal(got.ok, true)
  assert.equal(got.dryRun, true)
  assert.equal(got.pages.length, 1)
  assert.match(got.reason, /did not advance/)
  assert.deepEqual(f.clicked, [])
})

// --- mergePages -------------------------------------------------------------------

test("mergePages represents a defer, so the submit gate cannot be vacuous", () => {
  const got = mergePages([
    { page: 1, plan: { items: [{ k: "a" }], defer: [] }, report: null },
    {
      page: 2,
      plan: { items: [], defer: [{ k: "b", why: "x" }] },
      report: null,
    },
  ])
  assert.equal(got.plan.defer.length, 1)
  assert.equal(got.plan.defer[0].page, 2)
})

test("mergePages tolerates empty, absent and malformed parts", () => {
  for (const input of [[], null, undefined, [{}], [{ plan: null }]]) {
    const got = mergePages(input)
    assert.ok(Array.isArray(got.plan.items))
    assert.ok(Array.isArray(got.plan.defer))
    assert.ok(Array.isArray(got.report.uploads))
  }
})
