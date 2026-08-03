// advanceOnce() — the navigate verb (§4.2c, Phase 5 W3).
//
// THE PROPERTY THIS FILE EXISTS FOR is one sentence: this function clicks a
// control whose scanned role is `next` and can never be made to click a submit.
// The click surface was zero for the life of this project, W1 made it one, and
// this makes it two — so every test below is either "it refuses" or "it refused
// AND did not click", and the assertion that matters throughout is
// `page.clicks` being empty, never the error message. A test that only checks a
// rejection passes just as happily against a function that clicks first and
// throws afterwards.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  advanceOnce,
  findNextControl,
  AdvanceRefused,
  AdvanceAmbiguous,
} from "../../scripts/auto/advance.mjs"
import { authorizeSubmit, planSha256 } from "../../scripts/auto/authorize.mjs"
import { openDb } from "../../scripts/lib/db.mjs"

const APPLY_URL = "https://boards.greenhouse.io/acme/jobs/1"
const SLUG = "acme-fullstack"

const PLAN = Object.freeze({
  items: [{ k: "f1", how: "fill", value: "Xavier" }],
  defer: [],
})
const PLAN_SHA = planSha256(PLAN)

const NEXT_SCAN = Object.freeze({
  buttons: [{ k: "b3", l: "Save and Continue", r: "next" }],
})
const SUBMIT_SCAN = Object.freeze({
  buttons: [{ k: "b9", l: "Submit application", r: "submit" }],
})

/** A page that RECORDS clicks instead of performing them. */
function fakePage({ url = APPLY_URL, urlAfter = null, onClick = null } = {}) {
  const clicks = []
  let current = url
  return {
    clicks,
    url: () => current,
    locator(sel) {
      return {
        async click(opts) {
          clicks.push({ sel, opts })
          if (onClick) await onClick(sel)
          if (urlAfter) current = urlAfter
        },
      }
    },
    async waitForLoadState() {},
  }
}

function rig(t, { mode = "live" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aj-advance-"))
  const dbFile = path.join(dir, "leads.db")
  const jobsDir = path.join(dir, "jobs")
  fs.mkdirSync(path.join(jobsDir, ".auto"), { recursive: true })
  const stopPath = path.join(jobsDir, ".auto", "STOP")
  openDb(dbFile).close()
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* a leaked handle must not fail an assertion that already passed */
    }
  })

  const token = authorizeSubmit({
    lead: { slug: SLUG, company: "Acme", apply_url: APPLY_URL },
    plan: PLAN,
    planSha: PLAN_SHA,
    config: {
      enabled: true,
      dry_run: mode !== "live",
      per_run_max: 10,
      per_day_max: 10,
      per_company_max_per_week: 5,
      board_allowlist: { "boards.greenhouse.io": "greenhouse" },
    },
    trustVerdict: { ok: true, reason: "allowlisted" },
    screening: { verdict: "pass", findings: [] },
    dbFile,
    stopPath,
  })
  assert.equal(token.deferred, false, "the rig must mint a real token")

  return {
    dbFile,
    token,
    args: (over = {}) => ({
      token,
      slug: SLUG,
      planSha: PLAN_SHA,
      mode,
      pageUrl: APPLY_URL,
      scan: NEXT_SCAN,
      ...over,
    }),
  }
}

// --- THE property ---------------------------------------------------------

test("a submit-role control is refused, and NOT clicked", async (t) => {
  const r = rig(t)
  const page = fakePage()
  await assert.rejects(
    () => advanceOnce(page, r.args({ scan: SUBMIT_SCAN })),
    (e) => e instanceof AdvanceRefused && e.role === "submit",
  )
  assert.deepEqual(page.clicks, [], "and nothing was actuated")
})

test("the refusal says THIS IS THE LAST PAGE, not 'no control found'", () => {
  // The two situations call for different responses from the caller — one is a
  // defer, the other is a submit — so collapsing them would hide a winnable
  // application inside a generic failure.
  const got = findNextControl(SUBMIT_SCAN)
  assert.equal(got.ok, false)
  assert.equal(got.terminal, true)
  assert.match(got.reason, /this is the\s+last page/)
})

test("a scan carrying BOTH still refuses to click the submit", async (t) => {
  // The realistic shape: a review page with Back, Next and Submit on it.
  const r = rig(t)
  const page = fakePage()
  const scan = {
    buttons: [
      { k: "b1", l: "Back", r: "back" },
      { k: "b2", l: "Submit application", r: "submit" },
      { k: "b3", l: "Save and Continue", r: "next" },
    ],
  }
  const got = await advanceOnce(page, r.args({ scan }))
  assert.equal(got.advanced, true)
  assert.deepEqual(
    page.clicks.map((c) => c.sel),
    ['[data-aj="b3"]'],
    "exactly the next control, and only it",
  )
})

test("a role outside the permitted set is refused even if the scan offers it", async (t) => {
  const r = rig(t)
  for (const role of ["submit", "start", "auth", "upload", "back", "other"]) {
    const page = fakePage()
    await assert.rejects(
      () =>
        advanceOnce(
          page,
          r.args({ scan: { buttons: [{ k: "bX", l: "Go", r: role }] } }),
        ),
      AdvanceRefused,
      `role ${role}`,
    )
    assert.deepEqual(page.clicks, [], `role ${role} must not be clicked`)
  }
})

// --- ambiguity is refused in both directions -------------------------------

test("two next controls is a refusal — that choice is a judgement", async (t) => {
  const r = rig(t)
  const page = fakePage()
  await assert.rejects(
    () =>
      advanceOnce(
        page,
        r.args({
          scan: {
            buttons: [
              { k: "b1", l: "Continue", r: "next" },
              { k: "b2", l: "Next step", r: "next" },
            ],
          },
        }),
      ),
    (e) => e instanceof AdvanceRefused && /judgement/.test(e.message),
  )
  assert.deepEqual(page.clicks, [])
})

test("a next control with no data-aj stamp is refused, never text-matched", async (t) => {
  // Greenhouse remounts its form after an upload and drops every stamp. The
  // correct response is a re-scan by the caller or a defer — never "find a
  // button that says Continue", which is a fuzzy match to a control that moves
  // an application forward.
  const r = rig(t)
  const page = fakePage()
  await assert.rejects(
    () =>
      advanceOnce(
        page,
        r.args({ scan: { buttons: [{ l: "Continue", r: "next" }] } }),
      ),
    (e) => e instanceof AdvanceRefused && /data-aj/.test(e.message),
  )
  assert.deepEqual(page.clicks, [])
})

test("an empty or absent scan is refused", async (t) => {
  const r = rig(t)
  for (const scan of [null, undefined, {}, { buttons: [] }]) {
    const page = fakePage()
    await assert.rejects(
      () => advanceOnce(page, r.args({ scan })),
      AdvanceRefused,
    )
    assert.deepEqual(page.clicks, [])
  }
})

// --- the token and the origin ------------------------------------------------

test("no token, no click — a Next button is not exempt", async (t) => {
  const r = rig(t)
  for (const token of [null, undefined, {}, { kind: "not-a-token" }]) {
    const page = fakePage()
    await assert.rejects(
      () => advanceOnce(page, r.args({ token })),
      (e) =>
        e instanceof AdvanceRefused && /authorization token/.test(e.message),
    )
    assert.deepEqual(page.clicks, [])
  }
})

test("a token bound to another slug or another plan is refused", async (t) => {
  const r = rig(t)
  for (const over of [{ slug: "other-job" }, { planSha: "f".repeat(64) }]) {
    const page = fakePage()
    await assert.rejects(
      () => advanceOnce(page, r.args(over)),
      AdvanceRefused,
      JSON.stringify(over),
    )
    assert.deepEqual(page.clicks, [])
  }
})

test("a page on another origin is refused BEFORE the click", async (t) => {
  // Phase 0.1, and it matters more here than at the submit: the next thing the
  // runner does after advancing is type the user's answers into whatever page
  // it landed on.
  const r = rig(t)
  const page = fakePage({ url: "https://evil.test/apply" })
  await assert.rejects(
    () => advanceOnce(page, r.args({ pageUrl: "https://evil.test/apply" })),
    (e) => e instanceof AdvanceRefused && /another origin/.test(e.message),
  )
  assert.deepEqual(page.clicks, [])
})

test("advancing INTO another origin is ambiguous, not a success", async (t) => {
  // The click already went out, so this cannot be a clean refusal. If the
  // scanner's regex was wrong about the role, that dispatched event was a
  // submit — and an application cannot be unsent.
  const r = rig(t)
  const page = fakePage({ urlAfter: "https://evil.test/next" })
  await assert.rejects(
    () => advanceOnce(page, r.args()),
    (e) => e instanceof AdvanceAmbiguous && /moved the browser/.test(e.message),
  )
  assert.equal(page.clicks.length, 1, "the click did happen; that is the point")
})

test("THE TOKEN IS NOT SPENT — a form needs many advances and one submit", async (t) => {
  // Spending it here would leave nothing to authorise the submit at the end of
  // the form; minting a fresh one per page would make the nonce meaningless.
  const r = rig(t)
  const page = fakePage()
  await advanceOnce(page, r.args())
  await advanceOnce(page, r.args())
  const third = await advanceOnce(page, r.args())
  assert.equal(third.advanced, true, "a third page still advances")
  assert.equal(page.clicks.length, 3)
})

// --- a click that threw ------------------------------------------------------

test("a click that threw is AMBIGUOUS — a next click is not automatically safe", async (t) => {
  // Playwright's timeout can fire after the event reached the page. If the
  // scanner's regex was wrong about the role, that event was a submit.
  const r = rig(t)
  const page = fakePage({
    onClick: () => {
      throw new Error("Timeout 15000ms exceeded")
    },
  })
  await assert.rejects(
    () => advanceOnce(page, r.args()),
    (e) => e instanceof AdvanceAmbiguous,
  )
})

// --- dry run ------------------------------------------------------------------

test("dry run runs every check and clicks nothing", async (t) => {
  const r = rig(t, { mode: "dry_run" })
  const page = fakePage()
  const got = await advanceOnce(page, r.args({ mode: "dry_run" }))
  assert.equal(got.dryRun, true)
  assert.equal(got.advanced, false)
  assert.equal(got.control.key, "b3", "but it did resolve the control")
  assert.deepEqual(page.clicks, [])
})

test("dry run still refuses a submit control", async (t) => {
  // The gate is exercised in full by the safe mode — that is the point of it.
  const r = rig(t, { mode: "dry_run" })
  const page = fakePage()
  await assert.rejects(
    () => advanceOnce(page, r.args({ mode: "dry_run", scan: SUBMIT_SCAN })),
    AdvanceRefused,
  )
  assert.deepEqual(page.clicks, [])
})

// --- the happy path -----------------------------------------------------------

test("a clean advance clicks the stamped next control and reports the new url", async (t) => {
  const r = rig(t)
  const page = fakePage({ urlAfter: `${APPLY_URL}?step=2` })
  const got = await advanceOnce(page, r.args())
  assert.equal(got.advanced, true)
  assert.equal(got.url, `${APPLY_URL}?step=2`)
  assert.deepEqual(
    page.clicks.map((c) => c.sel),
    ['[data-aj="b3"]'],
  )
})
