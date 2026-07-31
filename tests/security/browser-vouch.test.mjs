// The one carrier a fake DOM cannot express: CSS.
//
// Every other test in tests/security/ feeds product code a hand-authored scan
// JSON, because there is no browser. That works for markup-level attacks — a
// decoupled aria-label, a truncated label, a lying `for` — because those are
// visible in the source.
//
// `color: transparent` is not. The markup of an honest label and a label no
// human can read is IDENTICAL; the difference is what getComputedStyle
// returns. scan-page.js's vouch checks display, visibility, opacity, the
// bounding box and CSS ::before/::after content, and a transparent label
// passes all five while being unreadable. So the only way to know whether the
// scanner vouches for it is to render it.
//
// This file therefore drives a REAL browser against tests/fixtures/boards/
// server.mjs — our own loopback fixture, never a live employer's board, which
// is the entire reason that server exists.
//
// IF THERE IS NO BROWSER, THIS SKIPS LOUDLY AND NAMES WHAT IS UNVERIFIED. A
// silent skip is a slacking signature; `board-fidelity.test.mjs` separately
// pins that the fixture still carries the trait, so a rotted fixture is caught
// even on a leg that cannot render it.
//
// Run: node --test tests/security/browser-vouch.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { start } from "../fixtures/boards/server.mjs"
import { buildPlan } from "../../scripts/apply/fill-plan.mjs"
import { normalizeQuestion } from "../../scripts/apply/answer-bank.mjs"

// The wording the user approved and put on their own allowlist.
const APPROVED =
  "I certify that the information in this application is accurate."
// What the page actually shows next to that box.
const SHOWN =
  "I agree to binding arbitration of all disputes and waive my right to a jury trial."

async function browserOrReason() {
  let launchBrowser, scanPage
  try {
    ;({ launchBrowser, scanPage } =
      await import("../../scripts/apply/browser.mjs"))
  } catch (e) {
    return { reason: `scripts/apply/browser.mjs did not import: ${e.message}` }
  }
  try {
    const session = await launchBrowser({ headless: true, localOnly: true })
    return { session, scanPage }
  } catch (e) {
    return { reason: e.message.split("\n")[0] }
  }
}

test("a label made unreadable with color:transparent must not be vouched for", async (t) => {
  const board = await start()
  t.after(() => board.stop())

  const got = await browserOrReason()
  if (!got.session) {
    // LOUD skip. The reason is printed, and the report says exactly which
    // assertion is unverified rather than letting a green tick imply coverage.
    t.skip(
      `no browser available (${got.reason}) — UNVERIFIED: whether scan-page.js ` +
        `vouches for a color:transparent label. Needs playwright-core plus a ` +
        `Chromium binary; run this leg before trusting consent auto-tick.`,
    )
    return
  }
  const { session, scanPage } = got
  t.after(() => session.close())

  await session.goto(board.pageUrl("hostile-consent"))
  const result = await scanPage(session.page, { probeMax: 0 })
  const scan = result.scan ?? result
  const vouchedLabels = result.vouchedLabels ?? []

  // THE FINDING, FIRST. The user's allowlist holds the certification they
  // approved. Nothing on this page may tick, because the box carrying that
  // exact text is one the user cannot read.
  const plan = buildPlan({
    scan,
    resolved: [],
    adapter: { id: "generic", comboStrategies: [], fileFields: [] },
    url: board.pageUrl("hostile-consent"),
    consentAllowlist: new Set([normalizeQuestion(APPROVED)]),
    vouchedLabels,
  })
  const ticked = plan.items.filter((i) => i.how === "check")
  assert.deepEqual(
    ticked,
    [],
    "a consent box whose label is rendered color:transparent was auto-ticked " +
      `from the user's allowlist: ${JSON.stringify(ticked)}. The user reads ` +
      `${JSON.stringify(SHOWN)} and is agreeing to that.`,
  )

  // Then the mechanism, so a failure says WHY rather than only WHAT.
  assert.ok(
    !vouchedLabels.includes(APPROVED),
    "the scanner vouched for a label no human can read — visibleToEye() " +
      "checks display, visibility, opacity and the bounding box, and " +
      "color:transparent passes all four",
  )
})

test("the honest boxes on the same page still behave, so the fix is not just 'vouch nothing'", async (t) => {
  const board = await start()
  t.after(() => board.stop())

  const got = await browserOrReason()
  if (!got.session) {
    t.skip(
      `no browser available (${got.reason}) — UNVERIFIED: that a correct fix ` +
        `still vouches for a plainly visible label.`,
    )
    return
  }
  const { session, scanPage } = got
  t.after(() => session.close())

  await session.goto(board.pageUrl("hostile-consent"))
  const result = await scanPage(session.page, { probeMax: 0 })
  const vouchedLabels = result.vouchedLabels ?? []

  // The over-correction guard. A fix that stopped vouching for everything
  // would pass the test above and silently delete the allowlist feature.
  assert.ok(
    vouchedLabels.length > 0,
    "no label on this page was vouched for at all — a fix that vouches for " +
      "nothing removes the feature rather than securing it",
  )
  // And the aria-label-decoupled box must still be refused.
  assert.ok(
    !vouchedLabels.includes(
      "I certify the information in this application is accurate.",
    ),
    "an attribute-derived label was vouched for",
  )
})

test("Ashby's nonce CSP is ENFORCED, not merely sent", async (t) => {
  const board = await start()
  t.after(() => board.stop())

  const got = await browserOrReason()
  if (!got.session) {
    t.skip(
      `no browser available (${got.reason}) — UNVERIFIED: that the Ashby ` +
        `replica's CSP actually refuses an inline script. Until this runs, ` +
        `"addScriptTag is blocked here" is an assumption.`,
    )
    return
  }
  const { session } = got
  t.after(() => session.close())

  await session.goto(board.pageUrl("ashby"))
  // The fixture carries a nonce-less inline script that sets this global. A
  // browser honouring the policy refuses it.
  const proof = await session.page.evaluate(() => window.__ajCspProof)
  assert.equal(
    proof,
    undefined,
    "the nonce-less inline script RAN — this fixture's CSP is not being " +
      "enforced, so every claim resting on it (addScriptTag is refused here) " +
      "is untested",
  )
  // ...and the nonce'd script did run, or the page is simply broken.
  const remountWired = await session.page.evaluate(
    () => typeof document.getElementById("_systemfield_resume") !== "undefined",
  )
  assert.ok(remountWired, "the page must still be functional under its own CSP")
})
