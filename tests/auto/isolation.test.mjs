// C9: two concurrent jobs on the same origin cannot observe each other's
// cookies or localStorage. §4.11 test 7, Phase 5 W3.
//
// THE PLAN CALLS THIS "the test revision 1 had no reason to write and most
// needed", and the reason is the failure it catches is SILENT, IRREVERSIBLE,
// and invisible to a design that never reads anything back out of the page:
//
//   Revision 1 keyed in-flight exclusion on `board_key`, which is TENANT-scoped
//   (hostname + first path segment + `for=` employer param), while cookies and
//   localStorage are ORIGIN-scoped. "One job per board_key" therefore permitted
//   eight concurrent Greenhouse tenants sharing ONE cookie jar and ONE storage
//   area. Greenhouse's embed flow holds upload and draft state per origin, so
//   one tab's resume upload token is overwritable by another's — and the
//   Coinbase application goes out carrying the Tebra-tailored resume, with
//   nothing in any log saying so.
//
// TWO INDEPENDENT DEFENCES, AND THIS FILE TESTS BOTH:
//
//   1. SCHEDULING — at most one job in flight per registrable origin, so the
//      overlap cannot arise. Tested in concurrency.test.mjs.
//   2. STRUCTURE — cookie-free boards get their own `browser.newContext()` per
//      job, so even if the scheduler were wrong, the storage is not shared.
//      Tested here, against a real browser.
//
// Defence 2 is the one that matters if someone later "optimises" the exclusion
// key back to board_key, which is exactly what happened once already.
//
// Skipped with a STATED reason when Chromium is absent, because a leg that
// skips silently is indistinguishable from one that passes.
import test from "node:test"
import assert from "node:assert/strict"
import { launchBrowser } from "../../src/apply/browser.mjs"
import { start } from "../fixtures/boards/server.mjs"

const NO_BROWSER = await (async () => {
  try {
    const s = await launchBrowser({ headless: true })
    await s.close()
    return null
  } catch (e) {
    return "no usable Chromium: " + String(e.message).slice(0, 90)
  }
})()

/**
 * Two non-persistent contexts on ONE browser — the per-job lane §4.2 describes.
 *
 * Deliberately one browser rather than two: two browsers would be isolated by
 * process and the test would prove nothing about the branch the runner actually
 * takes. `launchBrowser` without `userDataDir` does `chromium.launch()` +
 * `browser.newContext()`, and this reaches past its wrapper to make a SECOND
 * context on the SAME browser, which is the shape a concurrent run has.
 */
async function twoContexts() {
  const a = await launchBrowser({ headless: true })
  const ctx2 = await a.browser.newContext()
  const page2 = await ctx2.newPage()
  return {
    pageA: a.page,
    pageB: page2,
    async close() {
      try {
        await ctx2.close()
      } catch {
        /* the browser close below is the one that matters */
      }
      await a.close()
    },
  }
}

test("two per-job contexts on ONE origin cannot see each other's localStorage", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const board = await start()
  const both = await twoContexts()
  try {
    // THE SAME ORIGIN, not merely a similar one. If these differed the test
    // would pass for the wrong reason and prove nothing.
    const url = `${board.url}/fixture-submit/confirmation`
    await both.pageA.goto(url)
    await both.pageB.goto(url)
    assert.equal(
      new URL(both.pageA.url()).origin,
      new URL(both.pageB.url()).origin,
      "the premise of the test",
    )

    // Job A stores the thing that actually leaks in the real failure: an
    // upload token tying a resume to a draft.
    await both.pageA.evaluate(() =>
      localStorage.setItem("aj_upload_token", "resume-for-tebra"),
    )
    const seenByB = await both.pageB.evaluate(() =>
      localStorage.getItem("aj_upload_token"),
    )
    assert.equal(
      seenByB,
      null,
      "job B could read job A's upload token — this is the Coinbase-application-" +
        "carrying-the-Tebra-resume failure, exactly",
    )

    // And the reverse, so the test is not accidentally passing on ordering.
    await both.pageB.evaluate(() =>
      localStorage.setItem("aj_upload_token", "resume-for-coinbase"),
    )
    assert.equal(
      await both.pageA.evaluate(() => localStorage.getItem("aj_upload_token")),
      "resume-for-tebra",
      "and A still sees its own, unchanged",
    )
  } finally {
    await both.close()
    await board.stop()
  }
})

test("two per-job contexts on ONE origin cannot see each other's cookies", async (t) => {
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const board = await start()
  const both = await twoContexts()
  try {
    const url = `${board.url}/fixture-submit/confirmation`
    await both.pageA.goto(url)
    await both.pageB.goto(url)

    await both.pageA.evaluate(() => {
      document.cookie = "aj_session=tenant-a; path=/"
    })
    const aCookies = await both.pageA.evaluate(() => document.cookie)
    const bCookies = await both.pageB.evaluate(() => document.cookie)
    assert.match(aCookies, /aj_session=tenant-a/, "A set its own cookie")
    assert.doesNotMatch(
      bCookies,
      /aj_session/,
      "B must not carry A's session — a shared cookie jar across tenants is " +
        "the same origin-scoping mistake as the storage one",
    )
  } finally {
    await both.close()
    await board.stop()
  }
})

test("sessionStorage and IndexedDB names are per-context too", async (t) => {
  // The two other origin-scoped stores a board can hold draft state in.
  // Included because the mitigation is "a context per job", and a context that
  // isolated only localStorage would be a partial fix that reads as a complete
  // one.
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const board = await start()
  const both = await twoContexts()
  try {
    const url = `${board.url}/fixture-submit/confirmation`
    await both.pageA.goto(url)
    await both.pageB.goto(url)

    await both.pageA.evaluate(() => sessionStorage.setItem("draft", "a"))
    assert.equal(
      await both.pageB.evaluate(() => sessionStorage.getItem("draft")),
      null,
    )

    await both.pageA.evaluate(
      () =>
        new Promise((res) => {
          const r = indexedDB.open("aj_draft", 1)
          r.onsuccess = () => res(true)
          r.onerror = () => res(false)
          r.onupgradeneeded = () => res(true)
        }),
    )
    const namesB = await both.pageB.evaluate(async () =>
      typeof indexedDB.databases === "function"
        ? (await indexedDB.databases()).map((d) => d.name)
        : [],
    )
    assert.ok(
      !namesB.includes("aj_draft"),
      "B must not see a database A created",
    )
  } finally {
    await both.close()
    await board.stop()
  }
})

test("THE CANARY: two pages in the SAME context DO see each other's storage", async (t) => {
  // Without this, every assertion above could be passing because Playwright
  // happens to isolate something, or because the writes silently failed, and
  // the suite would stay green through the exact regression it exists to catch.
  //
  // This is the shape the runner would have if someone "optimised" the
  // exclusion key back to board_key and reused one context across tenants. It
  // MUST leak — and the fact that it does is what makes the four tests above
  // mean something.
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const board = await start()
  const s = await launchBrowser({ headless: true })
  try {
    const url = `${board.url}/fixture-submit/confirmation`
    const pageA = s.page
    const pageB = await s.context.newPage() // SAME context, on purpose
    await pageA.goto(url)
    await pageB.goto(url)

    await pageA.evaluate(() =>
      localStorage.setItem("aj_upload_token", "resume-for-tebra"),
    )
    assert.equal(
      await pageB.evaluate(() => localStorage.getItem("aj_upload_token")),
      "resume-for-tebra",
      "if this does NOT leak, the isolation tests above prove nothing",
    )
  } finally {
    await s.close()
    await board.stop()
  }
})

test("the fixture really does serve ONE origin here, so the test is not vacuous", async (t) => {
  // The premise, asserted separately. If `start()` handed back two different
  // origins every isolation assertion above would pass trivially and the C9
  // regression would be undetected — which is the exact shape of a test that
  // looks green forever while the property it names is broken.
  if (NO_BROWSER) return t.skip(NO_BROWSER)
  const board = await start()
  try {
    assert.equal(board.origins?.length ?? 1, 1)
    assert.match(board.url, /^http:\/\/127\.0\.0\.1:\d+$/)
  } finally {
    await board.stop()
  }
})
