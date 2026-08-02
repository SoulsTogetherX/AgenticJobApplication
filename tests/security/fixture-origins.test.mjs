// THE CONCURRENCY GATE'S DENOMINATOR, and the latency column's population.
//
// WHY THIS FILE EXISTS
//
// Phase 0.10 of docs/autonomy-plan-v2.md asks for a parameterised employer
// segment "so a 50-app run spans ≥8 distinct origins/tenants instead of one".
// Those are two different things and the plan's own §4.2 (correction C9) says
// which one matters: the in-flight exclusion key is the REGISTRABLE ORIGIN of
// apply_url, not board_key, because cookies and localStorage are origin-scoped
// while board_key is tenant-scoped.
//
// So `fixture-emp-1 … fixture-emp-8` on one loopback port is eight TENANTS and
// exactly ONE origin. Under an origin-scoped exclusion rule the runner would
// serialise all 50 jobs, and
//
//     node scripts/dev/bench-runner.mjs --apps 50 --concurrency 8 ...
//
// would report N=1 throughput under the label N=8 — which is the same defect
// Phase 0.10 was written to remove, one layer down, and the same class of error
// as C9 itself. The tenant parameterisation is still wanted (distinct board_keys
// exercise the per-board cap and the paused-board list) but it is the ORIGIN
// count that makes the concurrency number honest.
//
// The fixture therefore binds N listeners on N ephemeral loopback ports.
// Distinct origins by port. The alternative — `emp1.localhost` — was tested and
// rejected: it does not resolve on win32 (dns.lookup -> ENOTFOUND, verified
// 2026-08-01) while Chromium resolves it internally, so the fixture would work
// under a browser leg and fail under every fetch leg. It would also have needed
// assertLoopback's LOOPBACK set widened, and a security assertion is a bad
// place to pay for a hostname.
//
// WHAT IS ASSERTED HERE, in the order that matters:
//   1. the fixture really yields ≥8 distinct origins, and each one serves
//   2. the loopback-only rule survived: every origin is still 127.0.0.1
//   3. the plan's spec as literally written yields ONE origin — pinned, so the
//      defect cannot come back quietly
//   4. tenants are distinct too, and select the adapter they claim
//   5. the latency model is DECLARED, labelled per response, and the two
//      populations are never merged
//   6. bench-apply.mjs's board resolver no longer throws for ashby/lever
//
// Run: node --test tests/security/fixture-origins.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  start,
  assertLoopback,
  employerPath,
  parseLatency,
  DEFAULT_LATENCY,
  ASHBY_REMOUNT_MS,
} from "../fixtures/boards/server.mjs"
import { fixtureScanPath } from "../../scripts/dev/bench-apply.mjs"
import { detectAts } from "../../scripts/apply/ats/index.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PAGES = path.resolve(HERE, "..", "fixtures", "boards", "pages")

const originsOf = (urls) => new Set(urls.map((u) => new URL(u).origin))

// --- 1. ≥8 distinct origins -------------------------------------------------

test("a 50-application run spans ≥8 DISTINCT ORIGINS, not eight tenants on one", async () => {
  const board = await start({ origins: 8 })
  try {
    const urls = board.applyUrls(50)
    assert.equal(urls.length, 50)

    // The assertion the whole phase turns on.
    const origins = originsOf(urls)
    assert.ok(
      origins.size >= 8,
      `a 50-app run must span ≥8 origins or --concurrency 8 measures the ` +
        `exclusion key instead of the runner; got ${origins.size}: ` +
        `${[...origins].join(", ")}`,
    )

    // Origin advances fastest, so a run that stops early still spans them: the
    // FIRST 8 urls are already on 8 origins. A round-robin that cycled tenants
    // first would put the first 8 jobs on one origin and serialise the head of
    // every short run.
    assert.equal(
      originsOf(urls.slice(0, 8)).size,
      8,
      "the first 8 URLs must already be on 8 origins",
    )
  } finally {
    await board.stop()
  }
})

test("every one of those origins actually serves the fixture — a bound port is not a served page", async () => {
  // An origin count taken from a URL list proves nothing about the server. This
  // fetches each one, because "8 distinct strings" and "8 working origins" are
  // the difference between a real denominator and a decorative one.
  const board = await start({ origins: 8 })
  try {
    const urls = board.applyUrls(8)
    const seen = []
    for (const u of urls) {
      const res = await fetch(u)
      assert.equal(res.status, 200, `${u} did not serve`)
      assert.equal(res.headers.get("x-aj-fixture"), "local-fake-ats")
      const html = await res.text()
      assert.match(html, /<form/i, `${u} served no form`)
      seen.push(new URL(u).origin)
    }
    assert.equal(new Set(seen).size, 8)
  } finally {
    await board.stop()
  }
})

// --- 2. the loopback rule survived -----------------------------------------

test("N origins are still N LOOPBACK origins — the safety rule was not widened to buy them", async () => {
  // The only thing that makes an attack corpus safe to keep in a repository is
  // that it can never be served to anyone. Multiplying origins is exactly the
  // kind of change that erodes that, so the rule is re-asserted against the
  // multi-origin server rather than assumed to have survived.
  const board = await start({ origins: 8 })
  try {
    for (const u of board.origins) {
      const h = new URL(u).hostname
      assert.equal(h, "127.0.0.1", `origin ${u} is not loopback`)
      assert.doesNotThrow(() => assertLoopback(h))
    }
    // And the refusal still refuses. If a future route to more origins goes
    // through hostnames, THIS is the line that has to change, visibly.
    for (const host of ["0.0.0.0", "192.168.1.10", "example.com", "::"]) {
      assert.throws(() => assertLoopback(host), /loopback-only/)
    }
    // Specifically: `emp1.localhost` is NOT in the loopback set. It was the
    // rejected route (ENOTFOUND on win32), and it must not sneak in as a
    // "harmless" widening — `anything.localhost` is a DNS answer some resolver
    // somewhere gets to choose.
    assert.throws(() => assertLoopback("emp1.localhost"), /loopback-only/)
  } finally {
    await board.stop()
  }
})

test("distinct ports really are distinct origins by the URL parser's own rule", async () => {
  // Not a tautology worth skipping: `new URL(u).origin` is what the runner will
  // key its in-flight exclusion on (§4.2/C9, auto_queue.origin), so the thing
  // asserted is that the KEY differs — not that the strings do.
  const board = await start({ origins: 2 })
  try {
    const [a, b] = board.origins
    assert.notEqual(new URL(a).origin, new URL(b).origin)
    assert.equal(new URL(a).hostname, new URL(b).hostname)
    assert.notEqual(new URL(a).port, new URL(b).port)
  } finally {
    await board.stop()
  }
})

// --- 3. the plan's spec, as literally written, yields ONE origin ------------

test("PINNED DEFECT: eight employer segments on one port are EIGHT TENANTS AND ONE ORIGIN", async () => {
  // Phase 0.10 as written ("/boards.greenhouse.io/fixture-emp-<n>/jobs/<id>" so
  // a run spans "≥8 distinct origins/tenants") is satisfiable by a fixture that
  // gives the gate a denominator of 1. This test is the proof of that reading,
  // kept green deliberately: it asserts the DEFECT exists in the single-origin
  // configuration, so nobody can later "simplify" the multi-listener server
  // back to one port on the grounds that the employer segments already vary.
  const board = await start() // the default: ONE origin
  try {
    const urls = board.applyUrls(50)
    const tenants = new Set(urls.map((u) => new URL(u).pathname.split("/")[2]))
    assert.ok(tenants.size >= 8, `expected ≥8 tenants, got ${tenants.size}`)
    assert.equal(
      originsOf(urls).size,
      1,
      "one listener is one origin, however many employer segments the paths " +
        "carry — if this ever reads >1 the exclusion key has stopped being " +
        "the origin and this test needs rewriting, not deleting",
    )
  } finally {
    await board.stop()
  }
})

// --- 4. tenants ------------------------------------------------------------

test("the 50 URLs also span ≥8 tenants, and each tenant URL selects the adapter it imitates", async () => {
  const board = await start({ origins: 8 })
  try {
    const urls = board.applyUrls(50)
    const keys = new Set()
    for (const u of urls) {
      const p = new URL(u).pathname.split("/")
      keys.add(`${p[1]}|${p[2]}`) // board host token + fixture-emp-<n>
    }
    assert.ok(keys.size >= 8, `expected ≥8 tenants, got ${keys.size}`)

    // A tenant URL that fell through to the `generic` adapter would silently
    // change which combo strategies, file ordering and value aliases the whole
    // 50-app run exercised — i.e. the gate would measure a different code path
    // from the one the named fixtures measure.
    for (const ats of ["greenhouse", "lever", "ashby"]) {
      const u = board.jobUrl({ origin: 0, employer: 3, job: 42, ats })
      assert.equal(
        detectAts(u).id,
        ats,
        `${u} must be detected as ${ats}, not ${detectAts(u).id}`,
      )
      const res = await fetch(u)
      assert.equal(res.status, 200, `${u} did not serve`)
      assert.equal(res.headers.get("x-aj-employer"), "fixture-emp-3")
      assert.equal(res.headers.get("x-aj-board-key"), `${ats}:fixture-emp-3`)
    }
  } finally {
    await board.stop()
  }
})

test("a named fixture route is never shadowed by the employer pattern", async () => {
  // Both tables answer paths that start with the same host token. If the
  // pattern won, every hostile fixture would quietly become an honest
  // Greenhouse form and this whole directory would go green for the wrong
  // reason.
  const board = await start()
  try {
    const named = await (await fetch(board.pageUrl("honest-greenhouse"))).text()
    assert.match(named, /honest/i)
    assert.equal(
      new URL(board.pageUrl("honest-greenhouse")).pathname.split("/")[2],
      "fixture-analytics",
      "the named routes must keep their own employer segments",
    )
  } finally {
    await board.stop()
  }
})

test("employerPath refuses input that would produce a URL the server cannot match", () => {
  assert.equal(
    employerPath({ ats: "greenhouse", employer: 2, job: 7 }),
    "/boards.greenhouse.io/fixture-emp-2/jobs/7",
  )
  assert.match(
    employerPath({ ats: "lever", employer: 2, job: 7 }),
    /^\/jobs\.lever\.co\/fixture-emp-2\/[0-9a-f-]{36}\/apply$/,
  )
  assert.throws(() => employerPath({ ats: "workday" }), /no employer route/)
  assert.throws(() => employerPath({ employer: 0 }), /positive integer/)
})

// --- 5. the latency model ---------------------------------------------------

test("latency is OFF by default, and every response says which population it belongs to", async () => {
  const board = await start()
  try {
    assert.equal(board.latency.mode, "loopback")
    const res = await fetch(board.pageUrl("greenhouse"))
    assert.equal(res.headers.get("x-aj-latency-mode"), "loopback")
    assert.equal(res.headers.get("x-aj-latency-ms"), "0")
    assert.equal(res.headers.get("x-aj-latency-class"), "nav")
  } finally {
    await board.stop()
  }
})

test("--latency injects the DECLARED delay, and a nav costs more than an XHR", async () => {
  // A LOWER BOUND only. An upper bound on a sleep under CI contention is a
  // flaky test pretending to be a precise one — and the number that matters
  // here is that the delay is really paid, not that it is paid tightly.
  const board = await start({ latency: true })
  try {
    assert.deepEqual(board.latency, {
      mode: "modelled",
      nav_ms: DEFAULT_LATENCY.nav_ms,
      xhr_ms: DEFAULT_LATENCY.xhr_ms,
    })

    const t0 = performance.now()
    const nav = await fetch(board.pageUrl("greenhouse"))
    const navMs = performance.now() - t0
    assert.equal(nav.headers.get("x-aj-latency-mode"), "modelled")
    assert.equal(nav.headers.get("x-aj-latency-class"), "nav")
    assert.equal(
      nav.headers.get("x-aj-latency-ms"),
      String(DEFAULT_LATENCY.nav_ms),
    )
    assert.ok(
      navMs >= DEFAULT_LATENCY.nav_ms,
      `a modelled navigation must actually cost ≥${DEFAULT_LATENCY.nav_ms}ms, took ${navMs.toFixed(1)}ms`,
    )

    const t1 = performance.now()
    const xhr = await fetch(board.url + "/routes.json")
    const xhrMs = performance.now() - t1
    assert.equal(xhr.headers.get("x-aj-latency-class"), "xhr")
    assert.equal(
      xhr.headers.get("x-aj-latency-ms"),
      String(DEFAULT_LATENCY.xhr_ms),
    )
    assert.ok(
      xhrMs >= DEFAULT_LATENCY.xhr_ms,
      `a modelled data request must actually cost ≥${DEFAULT_LATENCY.xhr_ms}ms, took ${xhrMs.toFixed(1)}ms`,
    )
  } finally {
    await board.stop()
  }
})

test("THE CONTRACT: a modelled run and a loopback run are distinguishable from the bytes alone", async () => {
  // This is the assertion that makes "never merge the two populations" checkable
  // by a harness instead of remembered by a person. A consumer that groups its
  // samples by x-aj-latency-mode cannot average them together by accident; one
  // that groups by a flag it was passed at startup can, and eventually will.
  const loop = await start()
  const model = await start({ latency: "300/150" })
  try {
    const a = await fetch(loop.pageUrl("ashby"))
    const b = await fetch(model.pageUrl("ashby"))
    assert.notEqual(
      a.headers.get("x-aj-latency-mode"),
      b.headers.get("x-aj-latency-mode"),
      "two runs under different latency models must not be indistinguishable",
    )
    // Both still serve the same page under the same CSP: the model changes the
    // clock, never the bytes.
    assert.equal(
      a.headers.get("content-security-policy"),
      b.headers.get("content-security-policy"),
    )
    assert.equal(await a.text(), await b.text())

    const declared = await (await fetch(model.url + "/latency.json")).json()
    assert.equal(declared.mode, "modelled")
    assert.equal(declared.nav_ms, 300)
    assert.equal(declared.xhr_ms, 150)
    assert.match(declared.never_merge, /never average, sum or baseline/)
  } finally {
    await loop.stop()
    await model.stop()
  }
})

test("parseLatency accepts exactly the documented spellings and refuses the rest", () => {
  const off = { mode: "loopback", nav_ms: 0, xhr_ms: 0 }
  assert.deepEqual(parseLatency(undefined), off)
  assert.deepEqual(parseLatency(null), off)
  assert.deepEqual(parseLatency(false), off)
  assert.deepEqual(parseLatency("off"), off)
  const on = { mode: "modelled", nav_ms: 300, xhr_ms: 150 }
  assert.deepEqual(parseLatency(true), on)
  assert.deepEqual(parseLatency(""), on)
  assert.deepEqual(parseLatency("on"), on)
  assert.deepEqual(parseLatency("300/150"), on)
  assert.deepEqual(parseLatency("nav=300,xhr=150"), on)
  assert.deepEqual(parseLatency({ nav_ms: 900 }), {
    mode: "modelled",
    nav_ms: 900,
    xhr_ms: 150,
  })
  // A typo must not silently become "no latency at all", which would move a
  // whole run into the other population without saying so.
  assert.throws(() => parseLatency("fast"), /cannot parse/)
  assert.throws(() => parseLatency("nav=abc"), /cannot parse/)
})

test("the remount is declared as a number, and the page and the model agree on it", async () => {
  // The 700ms is PAGE-SIDE: only a real browser pays it. Declaring it is how a
  // no-browser harness can account it instead of charging zero — and pinning
  // the served HTML against the constant is how the declaration stays true.
  const board = await start()
  try {
    const declared = await (await fetch(board.url + "/latency.json")).json()
    assert.equal(declared.page_remount_ms, ASHBY_REMOUNT_MS)
    const src = fs.readFileSync(path.join(PAGES, "ashby.html"), "utf8")
    const m = src.match(/\}\s*,\s*(\d+)\s*\)/)
    assert.ok(m, "pages/ashby.html no longer contains a setTimeout delay")
    assert.equal(
      Number(m[1]),
      ASHBY_REMOUNT_MS,
      "the remount delay in pages/ashby.html and ASHBY_REMOUNT_MS have drifted",
    )
  } finally {
    await board.stop()
  }
})

test("the Ashby remount has a served page AND a scan fixture, and the CSP survives it", async () => {
  const board = await start()
  try {
    const url = board.pageUrl("ashby")
    const before = await fetch(url)
    const after = await fetch(url, { method: "POST" })
    const b = await before.text()
    const a = await after.text()
    assert.notEqual(a, b, "the POST must return the post-remount DOM")
    assert.match(a, /data-aj-remounted="1"/)
    assert.match(a, /Resume parsed/)
    // The trait that costs the retry: no data-aj stamp survives a remount.
    // Script bodies are excluded — the page's own remount code contains the
    // string `data-aj="` in the regex that STRIPS the stamps, and counting that
    // would make this assertion fail for the reason it exists to prevent.
    const markup = a.replace(/<script[\s\S]*?<\/script>/gi, "")
    assert.equal(
      (markup.match(/ data-aj="/g) ?? []).length,
      0,
      "the remounted DOM must carry no data-aj stamps",
    )
    // A remount that relaxed the policy would let the banned addScriptTag path
    // start working again, intermittently — the worst possible way for it to
    // work.
    assert.equal(
      after.headers.get("content-security-policy"),
      before.headers.get("content-security-policy"),
    )
    assert.match(
      after.headers.get("content-security-policy") ?? "",
      /nonce-/,
      "the remounted page must still be served under the nonce policy",
    )
  } finally {
    await board.stop()
  }
})

// --- 6. the resolver bench-apply.mjs uses ----------------------------------

test("bench-apply's board resolver no longer throws for ashby or lever", () => {
  // The whole reason Phase 0.10 lists these two files. fixtureScanPath REFUSES
  // to fall back (correctly — it would report Greenhouse's numbers under
  // Ashby's label), so a missing fixture is not a degraded measurement, it is
  // no measurement at all.
  for (const [board, page] of [
    ["ashby", 1],
    ["ashby", 2],
    ["lever", 1],
    ["greenhouse", 1],
    ["greenhouse", 2],
  ]) {
    const p = fixtureScanPath(board, page)
    assert.ok(fs.existsSync(p), `${board} page ${page}: ${p} missing`)
    const scan = JSON.parse(fs.readFileSync(p, "utf8"))
    assert.ok(scan.fields?.length > 0, `${board} page ${page} has no fields`)
  }
  // And it still refuses what it should refuse.
  assert.throws(() => fixtureScanPath("ashby", 3), /no scan fixture/)
  assert.throws(() => fixtureScanPath("workday", 1), /no scan fixture/)
})
