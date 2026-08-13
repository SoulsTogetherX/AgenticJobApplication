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
    "and the report's uploads — NOT a gate input (submitReadiness reads no " +
      "uploads key; an upload that did not attach arrives as a `failures` " +
      "entry) but the list a human reads to see which file reached which field",
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

// --- THE FILL'S OWN VERDICT SURVIVES THE MERGE (2026-08-05) -----------------
//
// mergePages rebuilt the report as `{uploads, revealed}` and dropped `failed`,
// `failures` and `verify` on the floor. The engine had just learned to demote
// an upload whose input the DOM shows still present and holding zero files to a
// fill failure — and the merge deleted that failure one call before any gate
// could read it, so the fix was inert on the unattended path. These assert the
// evidence arrives, and the pair below them assert the gate then refuses.

const okPage = (n, over = {}) => ({
  page: n,
  plan: { items: [{ k: `f${n}`, how: "fill", value: "x" }], defer: [] },
  report: {
    ok: 1,
    failed: 0,
    failures: [],
    uploads: [],
    revealed: [],
    verify: { mismatch: [], errors: [], requiredEmpty: [], landed: [] },
    ...over,
  },
})

test("mergePages carries failed, failures and verify through the walk", () => {
  const got = mergePages([
    okPage(1, {
      failed: 1,
      failures: [{ k: "f1", how: "upload", why: "did not attach" }],
    }),
    okPage(2, {
      verify: {
        mismatch: [{ k: "f2", want: "a", got: "b" }],
        errors: [],
        requiredEmpty: ["f3"],
      },
    }),
  ])
  assert.equal(got.report.failed, 1)
  assert.equal(got.report.failures.length, 1)
  assert.equal(got.report.verify.mismatch.length, 1)
  assert.deepEqual(got.report.verify.requiredEmpty, ["f3"])
})

test("a merged failure names the PAGE it happened on", () => {
  // Same reason the plan's items and defers are page-tagged: "a field failed to
  // fill" is not actionable on a four-page form without knowing which page.
  const got = mergePages([
    okPage(1),
    okPage(2, { failed: 1, failures: [{ k: "f2", how: "fill", why: "boom" }] }),
  ])
  assert.equal(got.report.failures[0].page, 2)
})

test("failed and failures aggregate ACROSS pages, like uploads already did", () => {
  const got = mergePages([
    okPage(1, { failed: 1, failures: [{ k: "f1", how: "fill", why: "a" }] }),
    okPage(2, { failed: 2, failures: [{ k: "f2", how: "fill", why: "b" }] }),
    okPage(3, {
      verify: { mismatch: [{ k: "f3" }], errors: [], requiredEmpty: ["f4"] },
    }),
  ])
  assert.equal(got.report.failed, 3, "the counts sum")
  assert.equal(got.report.failures.length, 2)
  assert.equal(got.report.verify.mismatch.length, 1)
  assert.equal(got.report.verify.requiredEmpty.length, 1)
})

test("verify is ABSENT, not empty, when no page ran a verify pass", () => {
  // "Nothing measured this" and "this measured zero" are different facts.
  // Synthesising an empty verify here would hand the gate a clean bill of
  // health nobody ever wrote, and the gate reads absence as "not measured", so
  // the forgery would be silent.
  const got = mergePages([
    { page: 1, plan: { items: [{ k: "a" }], defer: [] }, report: { ok: 1 } },
  ])
  assert.equal("verify" in got.report, false)
  assert.equal(got.report.failed, 0, "but the failure count is still stated")
  assert.deepEqual(got.report.failures, [])
})

test("a walk with NO fill stage still merges to a readable report", () => {
  const got = mergePages([{ page: 1, plan: { items: [], defer: [] } }])
  assert.equal("verify" in got.report, false)
  assert.equal(got.report.failed, 0)
})

test("MEASURED IN PART is not measured: a page with no verify beside one with a verify fails", async () => {
  // The per-page half of the same forgery. `verify` is emitted once, for the
  // whole merged report, so a walk where page 1 verified and page 2 did not
  // produced a PRESENT verify holding page 1's counts alone — page 2's silence
  // arriving at the gate as page 2's zero. The gate cannot see per-page
  // coverage; only this function can, so it says so here.
  const { submitReadiness } = await import("../../scripts/apply/fill-plan.mjs")
  const got = mergePages([
    okPage(1),
    { page: 2, plan: { items: [{ k: "f2" }], defer: [] }, report: { ok: 1 } },
  ])
  assert.ok(got.report.failed > 0, "a partly-measured form is not a clean one")
  const merge = got.report.failures.find((f) => f.how === "merge")
  assert.ok(merge, "recorded in the vocabulary every gate already reads")
  assert.match(merge.why, /no verify pass while other pages did/)
  assert.match(merge.why, /page 2/, "and it names the page nobody measured")
  const gate = submitReadiness(got.plan, got.report)
  assert.equal(gate.ready, false)
  assert.match(gate.reason, /failed to fill/)
  // The whole sentence survives submitReadiness's 140-char slice of `why`, so
  // the reason the user reads is not cut off mid-clause.
  assert.ok(merge.why.length <= 140, `why is ${merge.why.length} chars`)
  assert.match(gate.reason, /page 2 ran a fill but reported no verify pass/)
  assert.match(gate.reason, /partly-measured form is not a measured one/)
})

test("UNIFORM absence is still the legitimate case — it does not fail", async () => {
  // The other direction, and the one that would take the whole gate down if it
  // broke: no page verifying is the ordinary shape of a walk whose fill stage
  // never runs a verify pass, and of every walk with no fill stage at all.
  // Nothing was measured, nothing is claimed, and nothing is refused.
  const { submitReadiness } = await import("../../scripts/apply/fill-plan.mjs")
  const got = mergePages([
    { page: 1, plan: { items: [{ k: "a" }], defer: [] }, report: { ok: 1 } },
    { page: 2, plan: { items: [{ k: "b" }], defer: [] }, report: { ok: 1 } },
    { page: 3, plan: { items: [{ k: "c" }], defer: [] }, report: null },
  ])
  assert.equal("verify" in got.report, false)
  assert.equal(got.report.failed, 0)
  assert.deepEqual(got.report.failures, [])
  assert.equal(submitReadiness(got.plan, got.report).ready, true)
})

test("every page verifying is clean — the check counts coverage, not pages", () => {
  const got = mergePages([okPage(1), okPage(2), okPage(3)])
  assert.equal(got.report.failed, 0)
  assert.deepEqual(got.report.failures, [])
  assert.deepEqual(got.report.verify.mismatch, [])
})

test("a report list that is present but NOT a list becomes a failure", () => {
  // Fail closed. Something produced that value — `report.verify` is literally
  // what the page handed back from the verify evaluate — and a shape nothing
  // can read is not an empty one. It is recorded in the vocabulary the gates
  // already read rather than as a key each of them would have to learn.
  for (const bad of [
    { failures: "nope" },
    { verify: null },
    { verify: [] },
    { verify: { mismatch: "nope", errors: [], requiredEmpty: [] } },
    { failed: "two" },
  ]) {
    const got = mergePages([okPage(1, bad)])
    assert.ok(
      got.report.failed > 0,
      `an unreadable ${Object.keys(bad)[0]} must not read as clean`,
    )
    assert.ok(got.report.failures.length > 0)
    assert.equal(got.report.failures[0].page, 1)
  }
})

// --- and the gate then refuses ----------------------------------------------

test("THE WHOLE PATH: a failed fill on page 1 refuses the merged submit", async () => {
  // The defect end to end. `walkPages` -> `mergePages` -> `submitReadiness` is
  // exactly what job.mjs does: it hands `walk.report` to authorizeSubmit and to
  // submitOnce, and both put it through submitReadiness. Before this fix the
  // walk below returned ok and the gate said ready.
  const { submitReadiness } = await import("../../scripts/apply/fill-plan.mjs")
  const f = form({ pages: 2 })
  const got = await walk(f, {
    fillStage: async (_p, _plan, { page: n }) => ({
      ok: 0,
      failed: n === 1 ? 1 : 0,
      failures:
        n === 1
          ? [
              {
                k: "f1",
                how: "upload",
                why: "upload-readback-empty: the file input is still on the page holding no file — resume.pdf did not attach; attach it by hand",
              },
            ]
          : [],
      uploads: [],
      revealed: [],
      verify: { mismatch: [], errors: [], requiredEmpty: [], landed: [] },
    }),
  })
  assert.equal(got.ok, true, "the WALK is fine — no page deferred")
  const gate = submitReadiness(got.plan, got.report)
  assert.equal(gate.ready, false, "but the SUBMIT gate is not")
  assert.match(gate.reason, /failed to fill/)
  assert.match(gate.reason, /upload-readback-empty/)
  assert.match(gate.reason, /resume\.pdf/)

  // KNOWN BEHAVIOUR, PINNED HERE SO IT CANNOT DRIFT SILENTLY (2026-08-06): a
  // failed fill on page 1 does NOT stop the walk. `walkPages` ends on
  // `plan.defer` and on nothing else, so the failed page still minted a token,
  // clicked Next, and page 2 was scanned, planned and filled. The submit is
  // correctly blocked — that is the assertion above — but the run put the
  // user's data into a second page of a form that will never be sent.
  // scripts/auto/multipage.mjs carries the reasoning for why this round records
  // that rather than changing the walk. If a later round DOES change it, this
  // is the assertion that will fail, and it should be updated rather than
  // deleted.
  assert.deepEqual(f.clicked, [1], "it advanced off the page that failed")
  assert.equal(got.pages.length, 2, "and resolved page 2 as well")
})

test("plan.actuated survives the merge — a ticked widget still blocks the unattended click", async () => {
  // The SAME dropped-evidence bug as `failures`/`verify`, found while
  // correcting this module's docstring: `mergePages` rebuilt the plan as
  // `{items, defer, pages}`, so a widget buildPlan ticked from an exact-text
  // banked answer on page 2 reached no gate — while the identical form on ONE
  // page refused. submitReadiness blocks on `plan.actuated` because rule 6
  // delegates assent when the USER hands over a URL, and the unattended runner
  // holds no such instruction.
  const { submitReadiness } = await import("../../scripts/apply/fill-plan.mjs")
  const got = mergePages([
    okPage(1),
    {
      page: 2,
      plan: {
        items: [{ k: "f2", how: "fill", value: "x" }],
        defer: [],
        actuated: [
          { k: "w1", label: "Send me updates", bank: "a-051", pick: "Yes" },
        ],
      },
      report: null,
    },
  ])
  assert.equal(got.plan.actuated.length, 1)
  assert.equal(
    got.plan.actuated[0].page,
    2,
    "page-tagged like items and defers",
  )
  const gate = submitReadiness(got.plan, got.report)
  assert.equal(gate.ready, false)
  assert.match(gate.reason, /ticked from banked answers/)
  assert.match(gate.reason, /Send me updates/)

  // The other direction: a form that ticked nothing still merges to an empty
  // list and still passes, so the key is evidence rather than a blanket brake.
  const clean = mergePages([okPage(1), okPage(2)])
  assert.deepEqual(clean.plan.actuated, [])
  assert.equal(submitReadiness(clean.plan, clean.report).ready, true)
})

test("THE BOARD'S OWN validation text survives the merge, and the gate refuses on it", async () => {
  // `verify.errors` was merged and then read by nothing: submitReadiness looped
  // over `mismatch` and `requiredEmpty` only, so a walk whose only evidence was
  // the form itself saying "This field is required." passed the gate. Both
  // halves are asserted — the merge carries the message, and the gate quotes it
  // back rather than reporting a count.
  const { submitReadiness } = await import("../../scripts/apply/fill-plan.mjs")
  const got = mergePages([
    okPage(1),
    okPage(2, {
      verify: {
        mismatch: [],
        requiredEmpty: [],
        errors: [{ text: "This field is required." }],
      },
    }),
  ])
  assert.equal(got.report.verify.errors.length, 1)
  const gate = submitReadiness(got.plan, got.report)
  assert.equal(gate.ready, false)
  assert.match(gate.reason, /validation message\(s\)/)
  assert.match(gate.reason, /"This field is required\."/)
})

test("a clean multi-page walk still reaches ready — the fix is not a blanket refusal", async () => {
  // The other direction, and the one that would be invisible if it broke: a
  // form where everything landed must still pass. `form()`'s own fillStage
  // returns `{uploads}` with no failure keys and no verify at all, which is the
  // legitimate "nobody measured this" shape.
  const { submitReadiness } = await import("../../scripts/apply/fill-plan.mjs")
  const f = form({ pages: 3 })
  const got = await walk(f)
  assert.equal(got.ok, true)
  const gate = submitReadiness(got.plan, got.report)
  assert.equal(gate.ready, true, gate.reason ?? "")
})
